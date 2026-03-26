"""
AgentCore handler for AnyCompany Agent.
Handles HTTP POST to /invocations endpoint.
"""

import json
import os
import sys
import re
import time
import traceback
import secrets
import hashlib
import uuid
from decimal import Decimal
import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp

# Lazy import for PCBuildingAgent to catch import errors
_PCBuildingAgent = None
_import_error = None

def get_agent_class():
    """Lazy import PCBuildingAgent."""
    global _PCBuildingAgent, _import_error
    if _import_error:
        raise _import_error
    if _PCBuildingAgent is None:
        try:
            from pc_agent import PCBuildingAgent
            _PCBuildingAgent = PCBuildingAgent
        except Exception as e:
            _import_error = e
            print(f"Failed to import PCBuildingAgent: {e}")
            print(traceback.format_exc())
            raise
    return _PCBuildingAgent

def verify_world_id_proof(proof):
    """Lazy import and call verify_world_id_proof."""
    try:
        from world_id import verify_world_id_proof as verify
        return verify(proof)
    except Exception as e:
        print(f"Failed to verify proof: {type(e).__name__}")
        return {'success': False, 'error': 'Verification failed. Please try again.'}


def get_rp_context():
    """Lazy import and call generate_rp_context."""
    try:
        from world_id import generate_rp_context
        return generate_rp_context()
    except Exception as e:
        print(f"Failed to generate rp_context: {type(e).__name__}")
        import traceback
        traceback.print_exc()
        return None

# Lazy-initialized DynamoDB
_dynamodb = None
_sessions_table = None
_orders_table = None


def _get_dynamodb():
    """Get or initialize DynamoDB resource."""
    global _dynamodb
    if _dynamodb is None:
        # Get region from environment or default to us-west-2
        region = os.environ.get('AWS_REGION', os.environ.get('AWS_DEFAULT_REGION', 'us-west-2'))
        _dynamodb = boto3.resource('dynamodb', region_name=region)
    return _dynamodb


def _get_sessions_table():
    """Get or initialize sessions table."""
    global _sessions_table
    if _sessions_table is None:
        _sessions_table = _get_dynamodb().Table(os.environ.get('SESSIONS_TABLE', 'AnyCompanyAgentSessionsV2'))
    return _sessions_table


def _get_orders_table():
    """Get or initialize orders table."""
    global _orders_table
    if _orders_table is None:
        _orders_table = _get_dynamodb().Table(os.environ.get('ORDERS_TABLE', 'AnyCompanyAgentOrders'))
    return _orders_table


def has_existing_order_by_nullifier(nullifier):
    """Check if a nullifier already has a completed order.

    Uses the nullifier-hash-index GSI for a consistent, efficient lookup.
    Fails closed: returns True (blocks purchase) on any error.
    """
    if not nullifier:
        return False
    try:
        from boto3.dynamodb.conditions import Key as DynamoKey
        response = _get_orders_table().query(
            IndexName='nullifier-hash-index',
            KeyConditionExpression=DynamoKey('nullifier_hash').eq(nullifier),
            Limit=1,
        )
        return len(response.get('Items', [])) > 0
    except Exception as e:
        print(f"Error checking existing orders: {type(e).__name__}")
        # Fail closed — block purchase if we can't verify
        return True


def generate_session_token():
    """Generate a cryptographically secure session token."""
    return secrets.token_hex(32)


def hash_token(token):
    """Hash a session token for secure storage."""
    return hashlib.sha256(token.encode()).hexdigest()


def validate_session_token(session, token):
    """Validate a session token against the stored hash."""
    if not token or not session:
        return False
    stored_hash = session.get('session_token_hash', '')
    return secrets.compare_digest(stored_hash, hash_token(token))


app = BedrockAgentCoreApp()


MAX_MESSAGE_LENGTH = 4000  # Maximum allowed chat message length


def create_session(session_id):
    """Create a new session with a secure token and TTL."""
    token = generate_session_token()
    ttl = int(time.time()) + 86400  # Expire after 24 hours

    _get_sessions_table().put_item(Item={
        'session_id': session_id,
        'session_token_hash': hash_token(token),
        'cart': [],
        'human_verified': False,
        'messages': [],
        'account_balance': Decimal('10000.00'),  # Demo: $10,000 credit
        'ttl': ttl,
    })
    print(f"Created session {session_id}")
    return token


def get_session(session_id):
    """Get session data for a client."""
    response = _get_sessions_table().get_item(Key={'session_id': session_id})
    return response.get('Item', {})


def update_session(session_id, updates):
    """Update session data."""
    update_expr = 'SET ' + ', '.join(f'#{k} = :{k}' for k in updates.keys())
    expr_names = {f'#{k}': k for k in updates.keys()}
    expr_values = {f':{k}': v for k, v in updates.items()}

    _get_sessions_table().update_item(
        Key={'session_id': session_id},
        UpdateExpression=update_expr,
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=expr_values
    )


def get_cart_for_response(session_id):
    """Get current cart state for response."""
    session = get_session(session_id)
    cart = session.get('cart', [])
    return [
        {**item, 'price': float(item.get('price', 0))}
        for item in cart
    ]


def handle_verification(session_id, payload):
    """Handle World ID proof verification."""
    proof = payload.get('proof')

    if not proof:
        return {
            'type': 'error',
            'message': 'Missing proof',
            'cart': get_cart_for_response(session_id)
        }

    # Verify the proof with World ID v4 API
    verification_result = verify_world_id_proof(proof)

    if verification_result.get('success'):
        # Update session with verification and persist World ID v4 session
        session_updates = {
            'human_verified': True,
            'nullifier_hash': verification_result.get('nullifier', ''),
        }
        # Persist World ID v4 session_id for user continuity across verifications
        world_id_session = verification_result.get('session_id')
        if world_id_session:
            session_updates['world_id_session'] = world_id_session
        if verification_result.get('created_at'):
            session_updates['world_id_verified_at'] = verification_result['created_at']
        update_session(session_id, session_updates)

        # Enforce one purchase per person using nullifier (unique per person per action in legacy proofs)
        nullifier = verification_result.get('nullifier', '')
        if nullifier and has_existing_order_by_nullifier(nullifier):
            return {
                'type': 'error',
                'message': 'You have already completed a purchase. Each verified person is limited to one order.',
                'cart': get_cart_for_response(session_id)
            }
        # Store nullifier on session for order tracking
        if nullifier:
            session_updates['nullifier_hash'] = nullifier

        # Resume the agent to complete checkout
        session = get_session(session_id)
        agent = get_agent_class()(session_id, session)

        # Process the pending checkout
        result = agent.complete_checkout_after_verification()

        if result.get('success'):
            # Clear cart after successful order
            update_session(session_id, {
                'cart': [],
                'human_verified': False  # Reset for next purchase
            })

            return {
                'type': 'order_confirmed',
                'order_id': result['order_id'],
                'total': result['total'],
                'cart': [],  # Cart is now empty
                'world_id_session': world_id_session or '',
            }
        else:
            return {
                'type': 'agent_message',
                'content': result.get('error', 'Failed to complete order'),
                'cart': get_cart_for_response(session_id)
            }
    else:
        return {
            'type': 'error',
            'message': verification_result.get('error', 'Verification failed'),
            'cart': get_cart_for_response(session_id)
        }


def handle_chat_message(session_id, content):
    """Handle chat messages by invoking the agent."""
    if not content:
        return {
            'type': 'agent_message',
            'content': '',
            'cart': get_cart_for_response(session_id)
        }

    # Enforce input length limit
    if len(content) > MAX_MESSAGE_LENGTH:
        return {
            'type': 'error',
            'message': f'Message too long. Please keep messages under {MAX_MESSAGE_LENGTH} characters.',
            'cart': get_cart_for_response(session_id)
        }

    session = get_session(session_id)
    agent = get_agent_class()(session_id, session)

    try:
        result = agent.process_message(content)
        print(f"Agent result type: {result.get('type')}")

        # Get updated cart state
        cart = get_cart_for_response(session_id)

        if result.get('type') == 'interrupt':
            return {
                'type': 'interrupt',
                'id': result['id'],
                'name': result['name'],
                'reason': result['reason'],
                'cart': cart
            }
        else:
            return {
                'type': 'agent_message',
                'content': result.get('content', ''),
                'cart': cart
            }

    except Exception as e:
        print(f"Error processing message: {type(e).__name__}")
        return {
            'type': 'error',
            'message': 'Failed to process message. Please try again.',
            'cart': get_cart_for_response(session_id)
        }


@app.entrypoint
def invoke(payload: dict) -> dict:
    """Main entrypoint for AgentCore invocations."""
    try:
        message_type = payload.get('type', 'message')
        print(f"Received request type: {message_type}")

        # Handle session creation (no auth required)
        if message_type == 'create_session':
            new_session_id = str(uuid.uuid4())
            token = create_session(new_session_id)
            return {
                'type': 'session_created',
                'session_id': new_session_id,
                'session_token': token
            }

        # All other requests require valid session credentials
        session_id = payload.get('session_id')
        session_token = payload.get('session_token')

        if not session_id or not session_token:
            return {
                'type': 'error',
                'message': 'Missing session credentials',
                'cart': []
            }

        session = get_session(session_id)
        if not session or not validate_session_token(session, session_token):
            return {
                'type': 'error',
                'message': 'Invalid session credentials',
                'cart': []
            }

        # RP signature requires valid session (prevents unauthenticated abuse)
        if message_type == 'rp_signature':
            rp_context = get_rp_context()
            if rp_context:
                return {'type': 'rp_context', **rp_context}
            else:
                return {'type': 'error', 'message': 'Failed to generate RP signature'}

        if message_type == 'world_id_proof':
            return handle_verification(session_id, payload)
        else:
            return handle_chat_message(session_id, payload.get('content', ''))
    except Exception as e:
        print(f"Error in invoke: {type(e).__name__}")
        traceback.print_exc()
        return {
            'type': 'error',
            'message': 'An internal error occurred. Please try again.',
            'cart': []
        }


if __name__ == '__main__':
    app.run()
