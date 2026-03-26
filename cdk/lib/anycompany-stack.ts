import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2_integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { Construct } from 'constructs';

// Centralized World ID configuration
const WORLD_ID_ACTION = 'checkout';
const WORLD_ID_RP_ID = 'rp_50d6d29919b1f2d7';
// Signing key stored in SSM Parameter Store — create before deploying:
//   aws ssm put-parameter --name /AnyCompanyAgent/WorldIDRPSigningKey --type SecureString --value '0x...'
// The agent fetches this at runtime via IAM (never exposed as an environment variable).
const RP_SIGNING_KEY_SSM_PARAM = '/AnyCompanyAgent/WorldIDRPSigningKey';

export class AnyCompanyAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Read World ID App ID from CDK context (set in cdk.json or via -c worldIdAppId=...)
    const WORLD_ID_APP_ID = this.node.tryGetContext('worldIdAppId');
    if (!WORLD_ID_APP_ID) {
      throw new Error('Missing required CDK context value: worldIdAppId. Set it in cdk.json or pass -c worldIdAppId=app_...');
    }

    // ============================================
    // DynamoDB Tables
    // ============================================

    const productsTable = new dynamodb.Table(this, 'ProductsTable', {
      tableName: 'AnyCompanyAgentProducts',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    productsTable.addGlobalSecondaryIndex({
      indexName: 'category-index',
      partitionKey: { name: 'category', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'price', type: dynamodb.AttributeType.NUMBER },
    });

    // Sessions table - uses session_id as partition key
    const sessionsTable = new dynamodb.Table(this, 'SessionsTableV2', {
      tableName: 'AnyCompanyAgentSessionsV2',
      partitionKey: { name: 'session_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    const ordersTable = new dynamodb.Table(this, 'OrdersTable', {
      tableName: 'AnyCompanyAgentOrders',
      partitionKey: { name: 'order_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    ordersTable.addGlobalSecondaryIndex({
      indexName: 'world-id-session-index',
      partitionKey: { name: 'world_id_session', type: dynamodb.AttributeType.STRING },
    });

    ordersTable.addGlobalSecondaryIndex({
      indexName: 'nullifier-hash-index',
      partitionKey: { name: 'nullifier_hash', type: dynamodb.AttributeType.STRING },
    });

    // ============================================
    // Agent Container Image (ECR)
    // ============================================

    const agentImage = new ecr_assets.DockerImageAsset(this, 'AgentImage', {
      directory: path.join(__dirname, '../../agent'),
      platform: ecr_assets.Platform.LINUX_ARM64,
    });

    // ============================================
    // IAM Role for AgentCore Runtime
    // ============================================

    const agentRole = new iam.Role(this, 'AgentCoreRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'IAM role for AnyCompany Agent AgentCore runtime',
    });

    // DynamoDB permissions
    productsTable.grantReadData(agentRole);
    sessionsTable.grantReadWriteData(agentRole);
    ordersTable.grantReadWriteData(agentRole);

    // Bedrock model invocation permissions
    // Actions scoped to invoke/converse; resource ARN scoping for cross-region
    // inference profiles (e.g. us.anthropic.*) requires wildcard due to
    // ':0' version suffix in profile IDs creating extra ARN fields
    agentRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:Converse',
        'bedrock:ConverseStream',
      ],
      resources: ['*'],
    }));

    // ECR permissions to pull the container image
    agentRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:BatchCheckLayerAvailability',
      ],
      resources: [agentImage.repository.repositoryArn],
    }));

    agentRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    // SSM Parameter Store — runtime access to RP signing key (SecureString)
    agentRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${RP_SIGNING_KEY_SSM_PARAM}`,
      ],
    }));

    // CloudWatch Logs permissions scoped to account and region
    agentRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
        `arn:aws:logs:${this.region}:${this.account}:log-group:*:*`,
      ],
    }));

    // ============================================
    // AgentCore Runtime
    // ============================================

    const agentRuntime = new bedrockagentcore.CfnRuntime(this, 'AgentRuntime', {
      agentRuntimeName: 'AnyCompanyAgent',
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: agentImage.imageUri,
        },
      },
      roleArn: agentRole.roleArn,
      networkConfiguration: {
        networkMode: 'PUBLIC',
      },
      environmentVariables: {
        PRODUCTS_TABLE: productsTable.tableName,
        SESSIONS_TABLE: sessionsTable.tableName,
        ORDERS_TABLE: ordersTable.tableName,
        WORLD_ID_ACTION: WORLD_ID_ACTION,
        WORLD_ID_RP_ID: WORLD_ID_RP_ID,
        RP_SIGNING_KEY_SSM_PARAM: RP_SIGNING_KEY_SSM_PARAM,
      },
      description: 'AnyCompany Agent with World ID verification',
      protocolConfiguration: 'HTTP',
    });

    // Ensure role is created before runtime
    agentRuntime.node.addDependency(agentRole);

    // ============================================
    // AgentCore Runtime Endpoint
    // ============================================

    const agentEndpoint = new bedrockagentcore.CfnRuntimeEndpoint(this, 'AgentEndpoint', {
      agentRuntimeId: agentRuntime.attrAgentRuntimeId,
      name: 'AnyCompanyAgentEndpoint',
      description: 'Public endpoint for AnyCompany Agent',
    });

    // ============================================
    // S3 Bucket for Frontend Static Hosting
    // (Defined before API Gateway so CloudFront domain
    //  can be referenced in CORS configuration)
    // ============================================

    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      bucketName: `anycompany-agent-frontend-${this.account}-${this.region}`,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ============================================
    // CloudFront Distribution
    // ============================================

    // Security response headers for CloudFront
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: 'AnyCompanyAgentSecurityHeaders',
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://bridge.worldcoin.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://world-id-assets.com; frame-src https://bridge.worldcoin.org; connect-src 'self' https://*.execute-api.${this.region}.amazonaws.com https://bridge.worldcoin.org https://world.org;`,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.seconds(63072000),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
      },
    });

    // CloudFront access logs bucket
    const cloudfrontLogBucket = new s3.Bucket(this, 'CloudFrontLogBucket', {
      bucketName: `anycompany-agent-cf-logs-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy,
      },
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      logBucket: cloudfrontLogBucket,
      logFilePrefix: 'cloudfront/',
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
      ],
    });

    const allowedOrigin = `https://${distribution.distributionDomainName}`;

    // ============================================
    // Lambda Proxy for AgentCore (for browser access)
    // (Defined before API Gateway so the API URL can
    //  be referenced in the CSP response headers)
    // ============================================

    const proxyFunction = new lambda.Function(this, 'AgentProxyFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(120),
      memorySize: 256,
      environment: {
        AGENT_RUNTIME_ARN: `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/${agentRuntime.attrAgentRuntimeId}`,
        AWS_REGION_NAME: this.region,
        ALLOWED_ORIGIN: allowedOrigin,
      },
      code: lambda.Code.fromInline(`
import json
import boto3
import os

ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', '')

def handler(event, context):
    """Lambda proxy to invoke AgentCore from browser."""
    try:
        # Parse request body
        body = json.loads(event.get('body', '{}'))

        # Get AgentCore client
        client = boto3.client('bedrock-agentcore', region_name=os.environ['AWS_REGION_NAME'])

        # Invoke AgentCore
        response = client.invoke_agent_runtime(
            agentRuntimeArn=os.environ['AGENT_RUNTIME_ARN'],
            payload=json.dumps(body).encode('utf-8'),
            contentType='application/json',
            accept='application/json'
        )

        # Read response - handle streaming body
        if 'response' in response and hasattr(response['response'], 'read'):
            result = response['response'].read().decode('utf-8')
        elif 'body' in response and hasattr(response['body'], 'read'):
            result = response['body'].read().decode('utf-8')
        elif 'payload' in response and hasattr(response['payload'], 'read'):
            result = response['payload'].read().decode('utf-8')
        else:
            # Fallback - try to serialize what we got
            result = json.dumps({k: str(v) for k, v in response.items() if k != 'ResponseMetadata'})

        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            'body': result
        }
    except Exception as e:
        print(f"Error: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': ALLOWED_ORIGIN
            },
            'body': json.dumps({'type': 'error', 'message': 'An internal error occurred. Please try again.', 'cart': []})
        }
`),
    });

    // Grant Lambda permission to invoke AgentCore
    proxyFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/${agentRuntime.attrAgentRuntimeId}`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/${agentRuntime.attrAgentRuntimeId}/*`,
      ],
    }));

    // ============================================
    // HTTP API Gateway
    // ============================================

    const httpApi = new apigatewayv2.HttpApi(this, 'AgentApi', {
      apiName: 'AnyCompanyAgentApi',
      corsPreflight: {
        allowHeaders: ['Content-Type', 'Authorization'],
        allowMethods: [apigatewayv2.CorsHttpMethod.POST, apigatewayv2.CorsHttpMethod.OPTIONS],
        allowOrigins: [allowedOrigin],
      },
    });

    // API Gateway access logging
    const apiLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: `/aws/apigateway/${httpApi.httpApiId}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Rate limiting and access logging via API Gateway default stage
    const defaultStage = httpApi.defaultStage?.node.defaultChild as apigatewayv2.CfnStage;
    if (defaultStage) {
      defaultStage.defaultRouteSettings = {
        throttlingBurstLimit: 20,
        throttlingRateLimit: 10,
      };
      defaultStage.accessLogSettings = {
        destinationArn: apiLogGroup.logGroupArn,
        format: JSON.stringify({
          requestId: '$context.requestId',
          ip: '$context.identity.sourceIp',
          requestTime: '$context.requestTime',
          httpMethod: '$context.httpMethod',
          path: '$context.path',
          status: '$context.status',
          responseLength: '$context.responseLength',
          integrationLatency: '$context.integrationLatency',
        }),
      };
    }

    httpApi.addRoutes({
      path: '/invocations',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2_integrations.HttpLambdaIntegration('AgentProxyIntegration', proxyFunction),
    });

    // ============================================
    // S3 Deployment (build frontend + generate config)
    // ============================================

    // Build frontend with Vite during cdk deploy (local bundling preferred, Docker fallback)
    const frontendDir = path.join(__dirname, '../../frontend');
    const frontendBuild = s3deploy.Source.asset(frontendDir, {
      bundling: {
        image: cdk.DockerImage.fromRegistry('node:20-alpine'),
        command: ['sh', '-c', 'npm ci && npm run build && cp -r dist/* /asset-output/'],
        local: {
          tryBundle(outputDir: string) {
            try {
              const { execSync } = require('child_process');
              const fs = require('fs');
              execSync('npm ci && npm run build', { cwd: frontendDir, stdio: 'inherit' });
              fs.cpSync(path.join(frontendDir, 'dist'), outputDir, { recursive: true });
              return true;
            } catch {
              return false;
            }
          },
        },
      },
    });

    // Generate config.js with resolved CDK values (API URL, World ID config)
    const frontendConfig = s3deploy.Source.data('config.js',
      `window.APP_CONFIG = {\n` +
      `  API_URL: "${httpApi.url}",\n` +
      `  WORLD_ID_APP_ID: "${WORLD_ID_APP_ID}",\n` +
      `  WORLD_ID_ACTION: "${WORLD_ID_ACTION}",\n` +
      `  WORLD_ID_RP_ID: "${WORLD_ID_RP_ID}"\n` +
      `};\n`
    );

    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [frontendBuild, frontendConfig],
      destinationBucket: websiteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // ============================================
    // Outputs
    // ============================================

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront URL for the frontend',
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: httpApi.url!,
      description: 'API Gateway URL for browser access',
    });

    new cdk.CfnOutput(this, 'AgentRuntimeId', {
      value: agentRuntime.attrAgentRuntimeId,
      description: 'AgentCore Runtime ID',
    });

    new cdk.CfnOutput(this, 'WebsiteBucketName', {
      value: websiteBucket.bucketName,
      description: 'S3 bucket for frontend static hosting',
    });

    new cdk.CfnOutput(this, 'ProductsTableName', {
      value: productsTable.tableName,
      description: 'DynamoDB Products Table Name',
    });

    new cdk.CfnOutput(this, 'SessionsTableName', {
      value: sessionsTable.tableName,
      description: 'DynamoDB Sessions Table Name',
    });

    new cdk.CfnOutput(this, 'OrdersTableName', {
      value: ordersTable.tableName,
      description: 'DynamoDB Orders Table Name',
    });
  }
}
