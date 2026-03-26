# AnyCompany Agent

A conversational AI shopping assistant for building custom PCs, powered by Amazon Bedrock AgentCore and the Strands SDK. Customers chat with an AI agent that helps them choose compatible parts within their budget, manages a shopping cart, and completes checkout with [World ID](https://world.org/world-id) proof-of-human verification.

## Architecture

```
                         ┌──────────────────┐
                         │     Browser      │
                         │  React + Vite    │
                         └────────┬─────────┘
                                  │ HTTPS
                                  ▼
                         ┌──────────────────┐
                         │   CloudFront     │
                         │  (CDN + Headers) │
                         └───┬──────────┬───┘
                  static     │          │  POST /invocations
                  assets     │          │
                    ┌────────┘          ▼
                    ▼           ┌──────────────────┐
              ┌──────────┐     │  API Gateway v2   │
              │ S3 Bucket│     │  (HTTP, throttled) │
              │ (frontend│     └────────┬───────────┘
              │  build)  │              │
              └──────────┘              ▼
                              ┌──────────────────┐
                              │  Lambda Proxy    │
                              │  (Python inline) │
                              └────────┬─────────┘
                                       │ invoke_agent_runtime
                                       ▼
                              ┌──────────────────┐
                              │  Bedrock         │       ┌─────────────────┐
                              │  AgentCore       │──────▶│ Amazon Bedrock  │
                              │  Runtime         │       │ (Claude Sonnet) │
                              │  ┌────────────┐  │       └─────────────────┘
                              │  │ handler.py │  │
                              │  │ pc_agent.py│  │       ┌─────────────────┐
                              │  │ world_id.py│──┼──────▶│ World ID API    │
                              │  └────────────┘  │       │ (Verify Proofs) │
                              └────────┬─────────┘       └─────────────────┘
                                       │                        │
                                       │                 ┌──────┴──────────┐
                                       │                 │ SSM Parameter   │
                                       │                 │ Store           │
                                       └────────────────▶│ (RP signing key)│
                                       │                 └─────────────────┘
                                       │
                    ┌──────────────────┬┴───────────────┐
                    ▼                  ▼                 ▼
             ┌────────────┐   ┌──────────────┐   ┌────────────┐
             │ Products   │   │  Sessions    │   │  Orders    │
             │ Table      │   │  Table       │   │  Table     │
             │ (DynamoDB) │   │  (DynamoDB)  │   │  (DynamoDB)│
             └────────────┘   └──────────────┘   └────────────┘
```

### Components

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Frontend | React 18 + Vite | Chat UI, product catalog, World ID v4 widget (`@worldcoin/idkit` v4) |
| CDN | CloudFront | Static hosting, security headers (CSP, HSTS) |
| API | API Gateway HTTP v2 | Single POST endpoint, rate-limited (10 req/s) |
| Proxy | Lambda (Python) | Translates browser requests to AgentCore invocations |
| Agent | Bedrock AgentCore + Strands SDK | Conversational PC building assistant with tools |
| Model | Claude Sonnet 4 (cross-region) | LLM for natural language understanding and tool use |
| Verification | World ID v4 | Orb-level proof-of-human verification at checkout (one purchase per person) |
| Storage | DynamoDB (3 tables) | Products, sessions, orders |
| IaC | AWS CDK (TypeScript) | Full infrastructure definition |

## Sequence Diagrams

### Chat Message Flow

```
Browser                API GW    Lambda     AgentCore      DynamoDB      Bedrock
  │                      │         │           │              │            │
  │ POST /invocations    │         │           │              │            │
  │ {type:"message",     │         │           │              │            │
  │  content, session_id,│         │           │              │            │
  │  session_token}      │         │           │              │            │
  │─────────────────────▶│────────▶│           │              │            │
  │                      │         │ invoke    │              │            │
  │                      │         │──────────▶│              │            │
  │                      │         │           │ validate     │            │
  │                      │         │           │ session token│            │
  │                      │         │           │─────────────▶│            │
  │                      │         │           │◀─────────────│            │
  │                      │         │           │              │            │
  │                      │         │           │ restore conversation      │
  │                      │         │           │─────────────▶│            │
  │                      │         │           │◀─────────────│            │
  │                      │         │           │              │            │
  │                      │         │           │ Converse (tools + prompt) │
  │                      │         │           │────────────────────────  ▶│
  │                      │         │           │◀────────────────────────  │
  │                      │         │           │              │            │
  │                      │         │           │ [tool calls: browse,      │
  │                      │         │           │  recommend, cart, etc.]   │
  │                      │         │           │─────────────▶│            │
  │                      │         │           │◀─────────────│            │
  │                      │         │           │              │            │
  │                      │         │           │ save messages│            │
  │                      │         │           │─────────────▶│            │
  │                      │         │◀──────────│              │            │
  │◀─────────────────────│◀────────│           │              │            │
  │ {type:"agent_message",         │           │              │            │
  │  content, cart}      │         │           │              │            │
```

### Checkout with World ID v4 Verification

```
Browser                   AgentCore        World ID v4 API   DynamoDB
  │                          │                  │               │
  │ "I'd like to checkout"   │                  │               │
  │─────────────────────────▶│                  │               │
  │                          │ checkout() tool  │               │
  │                          │ → not verified   │               │
  │                          │ → raise Interrupt│               │
  │◀─────────────────────────│                  │               │
  │ {type:"interrupt",       │                  │               │
  │  name:"proof_of_human"}  │                  │               │
  │                          │                  │               │
  │ POST {type:"rp_signature"}                  │               │
  │─────────────────────────▶│                  │               │
  │◀─────────────────────────│                  │               │
  │ {rp_id, nonce, signature,│                  │               │
  │  created_at, expires_at} │                  │               │
  │                          │                  │               │
  │ [User completes World ID │                  │               │
  │  orb verification via    │                  │               │
  │  IDKitRequestWidget]     │                  │               │
  │                          │                  │               │
  │ POST world_id_proof      │                  │               │
  │─────────────────────────▶│                  │               │
  │                          │ POST /v4/verify/ │               │
  │                          │ {rp_id}          │               │
  │                          │─────────────────▶│               │
  │                          │◀─────────────────│               │
  │                          │ (session_id,     │               │
  │                          │  nullifier)      │               │
  │                          │                  │               │
  │                          │ check existing   │               │
  │                          │ orders by        │               │
  │                          │ nullifier_hash   │               │
  │                          │─────────────────────────────────▶│
  │                          │◀─────────────────────────────────│
  │                          │                  │               │
  │                          │ transact_write:  │               │
  │                          │ create order +   │               │
  │                          │ deduct balance   │               │
  │                          │─────────────────────────────────▶│
  │                          │◀─────────────────────────────────│
  │◀─────────────────────────│                  │               │
  │ {type:"order_confirmed", │                  │               │
  │  order_id, total,        │                  │               │
  │  world_id_session}       │                  │               │
  │                          │                  │               │
```

## Prerequisites

- **AWS CLI** configured with credentials for the target account
- **Node.js** >= 18
- **Python** >= 3.12
- **Docker** running (for building the AgentCore container image)
- **AWS CDK CLI** (`npm install -g aws-cdk`)
- **Amazon Bedrock** model access enabled for Claude Sonnet 4 in the target region
- A **World ID** app (see [World ID Setup](#world-id-setup) below)

## World ID Setup

[World ID v4](https://docs.world.org/world-id/4-0-migration) provides proof-of-human verification using zero-knowledge proofs. This app uses it to enforce orb-level verification at checkout and limit each verified person to one purchase.

### 1. Create a World ID App

1. Go to the [World Developer Portal](https://developer.world.org/)
2. Sign in and create a new app
3. Enable World ID 4.0 for the app
4. Note the **App ID** (`app_...`) and **RP ID** (`rp_...`)
5. Generate a **signing key** and store it in SSM Parameter Store:
   ```bash
   aws ssm put-parameter --name /AnyCompanyAgent/WorldIDRPSigningKey --type SecureString --value '0x...'
   ```

### 2. Configure an Action

1. In the developer portal, create an action named `checkout` (or your preferred name)

### 3. Update Configuration

All World ID settings are centralized in the CDK stack (`cdk/lib/anycompany-stack.ts`). The frontend config is auto-generated from these values during deployment:

```typescript
const WORLD_ID_APP_ID = 'app_your_app_id_here';
const WORLD_ID_ACTION = 'checkout';
const WORLD_ID_RP_ID = 'rp_your_rp_id_here';
const RP_SIGNING_KEY_SSM_PARAM = '/AnyCompanyAgent/WorldIDRPSigningKey';
```

### How It Works

1. User asks the agent to check out
2. Agent's `checkout()` tool raises an `InterruptException` requesting proof of human
3. Frontend requests an **RP context signature** from the backend (secp256k1 ECDSA + keccak256, matching the `@worldcoin/idkit-server` signing algorithm)
4. Frontend displays the World ID verification modal (via `@worldcoin/idkit` v4 `IDKitRequestWidget` with `orbLegacy()` preset)
5. User completes **orb-level** verification through the World ID bridge
6. IDKit returns a zero-knowledge proof to the frontend
7. Frontend sends the proof to the backend
8. Backend verifies the proof against the [World ID v4 API](https://developer.world.org/api/v4/verify/{rp_id})
9. Backend validates the credential is orb-level (`issuer_schema_id: 1`)
10. Backend checks no existing order exists for this `nullifier_hash` via the `nullifier-hash-index` GSI (one purchase per person)
11. On success, the order is created via a DynamoDB transaction

**One purchase per person**: Enforced at three layers: (1) a fast-path GSI query on `nullifier-hash-index` provides early rejection before reaching the transaction, (2) an atomic `purchase_lock_{world_id_session}` item in the DynamoDB order transaction prevents concurrent races by the same World ID session, and (3) an atomic `nullifier_lock_{nullifier_hash}` item prevents the same verified person from ordering even across different sessions. Both lock items use `attribute_not_exists` conditions — if two concurrent requests race, only one succeeds.

## Quick Start

```bash
# 1. Install CDK dependencies
cd cdk && npm install

# 2. Store your World ID RP signing key in SSM (one-time setup)
aws ssm put-parameter --name /AnyCompanyAgent/WorldIDRPSigningKey --type SecureString --value '0x...'

# 3. Deploy (builds frontend, generates config, deploys everything)
npx cdk deploy

# 4. Seed the product catalog
cd ../scripts && npm install && node seed-products.js
```

A single `cdk deploy` handles everything:
- Builds the frontend with Vite (via local bundling, Docker fallback)
- Auto-generates `config.js` with the API Gateway URL and World ID settings
- Deploys the agent container, infrastructure, and frontend to S3/CloudFront

After deployment, CDK prints:

```
Outputs:
AnyCompanyAgentStack.CloudFrontUrl = https://dXXXXXXXXXXXX.cloudfront.net
AnyCompanyAgentStack.ApiUrl = https://XXXXXXXXXX.execute-api.us-west-2.amazonaws.com/
AnyCompanyAgentStack.AgentRuntimeId = AnyCompanyAgent-XXXXXXXXXXXX
```

Open the CloudFront URL to use the app.

## Project Structure

```
anycompany-agent/
├── agent/                      # AgentCore container
│   ├── handler.py              # HTTP entrypoint (/invocations)
│   ├── pc_agent.py             # Strands agent with tools
│   ├── world_id.py             # World ID v4 RP signing + proof verification
│   ├── tools/                  # Agent tools package
│   ├── Dockerfile              # Container image (Python 3.12-slim)
│   └── requirements.txt        # Python dependencies
├── frontend/                   # React SPA
│   ├── src/
│   │   ├── App.jsx             # Main layout
│   │   ├── App.css             # Application styles
│   │   ├── main.jsx            # React entry point
│   │   ├── data/
│   │   │   └── products.js     # Client-side product catalog (display only)
│   │   └── components/
│   │       ├── ChatPanel.jsx   # Chat UI + session management
│   │       ├── WorldIdVerify.jsx # IDKit v4 widget with RP context
│   │       ├── Header.jsx      # Category filter + search
│   │       ├── ProductCard.jsx # Product display card
│   │       └── ProductGrid.jsx # Product catalog grid
│   ├── config.js.template       # Template for runtime config (envsubst placeholders)
│   ├── public/
│   │   └── config.js           # Runtime config (gitignored, auto-generated by CDK)
│   ├── Dockerfile              # Nginx container for Docker-based hosting
│   ├── .dockerignore           # Docker build context exclusions
│   ├── index.html              # HTML entry point
│   └── vite.config.js          # Vite configuration
├── cdk/                        # AWS CDK infrastructure
│   ├── lib/
│   │   └── anycompany-stack.ts   # Full stack definition
│   └── bin/
│       └── app.ts              # CDK app entry point
└── scripts/
    └── seed-products.js        # Seed DynamoDB with 30 PC parts
```

## Configuration

### Frontend Config (`frontend/public/config.js`)

This file is **auto-generated by CDK** during deployment using `s3deploy.Source.data`. It is gitignored and should not be edited manually. CDK injects the API Gateway URL and World ID settings from stack constants:

```javascript
window.APP_CONFIG = {
  API_URL: "https://XXXXXXXXXX.execute-api.us-west-2.amazonaws.com/",
  WORLD_ID_APP_ID: "app_your_app_id_here",
  WORLD_ID_ACTION: "checkout",
  WORLD_ID_RP_ID: "rp_your_rp_id_here"
};
```

For local development, create this file manually or copy from `config.js.template` and fill in values.

A `config.js.template` with `${PLACEHOLDER}` variables is also provided for the Docker/nginx hosting path (used by the Dockerfile with `envsubst`).

### Environment Variables

The AgentCore container receives these via CDK:

| Variable | Description | Default |
|----------|-------------|---------|
| `PRODUCTS_TABLE` | DynamoDB products table name | `AnyCompanyAgentProducts` |
| `SESSIONS_TABLE` | DynamoDB sessions table name | `AnyCompanyAgentSessionsV2` |
| `ORDERS_TABLE` | DynamoDB orders table name | `AnyCompanyAgentOrders` |
| `WORLD_ID_ACTION` | World ID action identifier | `checkout` |
| `WORLD_ID_RP_ID` | World ID Relying Party ID | — |
| `RP_SIGNING_KEY_SSM_PARAM` | SSM parameter name for RP signing key (fetched at runtime) | `/AnyCompanyAgent/WorldIDRPSigningKey` |

The Lambda proxy receives:

| Variable | Description |
|----------|-------------|
| `AGENT_RUNTIME_ARN` | ARN of the AgentCore runtime |
| `AWS_REGION_NAME` | AWS region for Bedrock calls |
| `ALLOWED_ORIGIN` | CloudFront domain for CORS |

### DynamoDB Schema

**ProductsTable** — Product catalog

| Attribute | Type | Key |
|-----------|------|-----|
| `id` | String | Partition Key |
| `category` | String | GSI Partition Key (`category-index`) |
| `price` | Number | GSI Sort Key (`category-index`) |
| `name`, `brand`, `description`, `specs` | String/Map | — |

**SessionsTableV2** — User sessions (TTL: 24 hours)

| Attribute | Type | Key |
|-----------|------|-----|
| `session_id` | String | Partition Key |
| `session_token_hash` | String | SHA-256 of session token |
| `cart` | List | Current shopping cart |
| `messages` | List | Conversation history (max 20) |
| `account_balance` | Number | Simulated balance ($10,000) |
| `human_verified` | Boolean | World ID verification status |
| `world_id_session` | String | World ID v4 session identifier |
| `world_id_verified_at` | String | Timestamp of World ID verification |
| `ttl` | Number | DynamoDB TTL epoch timestamp |

**OrdersTable** — Completed orders (PITR enabled)

| Attribute | Type | Key |
|-----------|------|-----|
| `order_id` | String | Partition Key |
| `items` | List | Ordered products |
| `total` | Number | Order total |
| `nullifier_hash` | String | GSI Partition Key (`nullifier-hash-index`) — World ID nullifier, used for fast-path one-purchase-per-person check |
| `world_id_session` | String | GSI Partition Key (`world-id-session-index`) — World ID v4 session identifier |
| `session_id` | String | Originating browser session |

## Agent Tools

The Strands SDK agent has four tools:

| Tool | Parameters | Description |
|------|-----------|-------------|
| `browse_products` | `category?`, `search?`, `max_price?` | Query the product catalog. Uses DynamoDB GSI for category filtering. |
| `recommend_build` | `budget`, `use_case` | Generate a complete PC build recommendation. Allocates budget by component category based on use case (gaming, productivity, content creation, general). |
| `manage_cart` | `action`, `product_id?` | Add, remove, view, or clear cart items. Updates DynamoDB immediately. |
| `checkout` | — | Initiate purchase. Checks balance, raises interrupt for World ID verification if not yet verified. |

## Testing

### Local Development

Run the frontend locally with Vite:

```bash
cd frontend
npm run dev   # Starts on http://localhost:5173
```

For local development, create `frontend/public/config.js` with your deployed API URL (see [Frontend Config](#frontend-config-frontendpublicconfigjs)), or set the `VITE_API_URL` environment variable.

### End-to-End Test via CLI

```bash
# Create a session
SESSION=$(curl -s -X POST "$API_URL/invocations" \
  -H "Content-Type: application/json" \
  -d '{"type":"create_session"}')

SESSION_ID=$(echo "$SESSION" | jq -r '.session_id')
SESSION_TOKEN=$(echo "$SESSION" | jq -r '.session_token')

# Send a chat message
curl -s -X POST "$API_URL/invocations" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": \"message\",
    \"content\": \"recommend a gaming PC for \$1500\",
    \"session_id\": \"$SESSION_ID\",
    \"session_token\": \"$SESSION_TOKEN\"
  }" | jq .
```

## Security

### Session Management

- Sessions are created server-side; the client never generates session IDs
- Session tokens are generated with `secrets.token_hex(32)` (64 hex characters)
- Tokens are stored as SHA-256 hashes in DynamoDB (cannot be reversed)
- Token validation uses `secrets.compare_digest()` for constant-time comparison (prevents timing attacks)
- Sessions expire after 24 hours via DynamoDB TTL

### Input Validation

- Chat messages are limited to 4,000 characters
- All error responses use generic messages (no internal details leaked to clients)
- Agent system prompt includes instructions to resist prompt injection

### Infrastructure

- **CloudFront**: CSP, HSTS (2 years, preload), X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin
- **S3**: Block all public access, OAC-only access from CloudFront
- **API Gateway**: CORS restricted to CloudFront domain, rate-limited (10 req/s, 20 burst)
- **DynamoDB**: Orders table uses `RETAIN` removal policy with point-in-time recovery
- **IAM**: Least-privilege roles scoped per service (DynamoDB table-level, SSM parameter-scoped, CloudWatch Logs account-scoped, ECR repository-scoped)
- **Secrets**: RP signing key stored in SSM Parameter Store (SecureString), fetched at runtime — never in environment variables, CloudFormation, or source code
- **Container**: Runs as non-root user with healthcheck

### World ID v4 Verification

- **Orb-level enforcement**: Frontend uses `orbLegacy()` preset; backend validates `issuer_schema_id` in the v4 response (defense-in-depth)
- **One purchase per person**: Enforced at three layers — a fast-path `nullifier-hash-index` GSI query for early rejection, an atomic `purchase_lock_{world_id_session}` item in the order transaction, and an atomic `nullifier_lock_{nullifier_hash}` item in the order transaction (both use `attribute_not_exists` conditions to prevent concurrent races)
- **RP context signing**: The signing key is stored in SSM Parameter Store (SecureString) and fetched at runtime via IAM — it is never passed as an environment variable or exposed in CloudFormation templates; the backend generates time-limited RP context signatures (secp256k1 ECDSA, 5-minute TTL)
- **RP signature endpoint**: Requires valid session credentials (prevents unauthenticated abuse)
- **Proof sanitization**: Only whitelisted fields from the IDKit result are forwarded to the World ID API
- Proofs are verified server-side against the [World ID v4 API](https://developer.world.org/api/v4/verify) (never trusted client-side)
- World ID session IDs and nullifiers are stored on orders for auditability
- Orders use DynamoDB transactions (`transact_write_items`) for atomic balance deduction and order creation, preventing race conditions
- The `has_existing_order` check fails closed — blocks purchases if the orders table is unreachable

### Error Handling

- All exceptions are caught and logged with type information only
- Client-facing error messages are generic and never include stack traces or internal state
- World ID error codes are mapped to user-friendly messages
