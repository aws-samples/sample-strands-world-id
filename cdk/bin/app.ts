#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AnyCompanyAgentStack } from '../lib/anycompany-stack';

const app = new cdk.App();

new AnyCompanyAgentStack(app, 'AnyCompanyAgentStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-west-2',
  },
});
