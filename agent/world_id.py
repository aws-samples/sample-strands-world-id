"""
World ID v4 verification and RP signature module.
Generates RP context signatures and verifies proofs with the v4 API.
"""

import os
import time
import struct
import httpx
import boto3

from Crypto.Hash import keccak as _keccak_mod
from coincurve import PrivateKey

WORLD_ID_APP_ID = os.environ.get('WORLD_ID_APP_ID', '')
WORLD_ID_RP_ID = os.environ.get('WORLD_ID_RP_ID', '')
WORLD_ID_ACTION = os.environ.get('WORLD_ID_ACTION', 'checkout')
RP_SIGNING_KEY_SSM_PARAM = os.environ.get('RP_SIGNING_KEY_SSM_PARAM', '/AnyCompanyAgent/WorldIDRPSigningKey')

# Cached signing key (fetched from SSM at runtime)
_rp_signing_key = None


def _get_rp_signing_key() -> str:
    """Fetch RP signing key from SSM Parameter Store (cached after first call)."""
    global _rp_signing_key
    if _rp_signing_key is None:
        region = os.environ.get('AWS_REGION', os.environ.get('AWS_DEFAULT_REGION', 'us-west-2'))
        ssm = boto3.client('ssm', region_name=region)
        response = ssm.get_parameter(
            Name=RP_SIGNING_KEY_SSM_PARAM,
            WithDecryption=True,
        )
        _rp_signing_key = response['Parameter']['Value']
    return _rp_signing_key

VERIFY_URL = 'https://developer.world.org/api/v4/verify'

DEFAULT_TTL_SEC = 300


def _keccak256(data: bytes) -> bytes:
    """Compute keccak-256 hash."""
    k = _keccak_mod.new(digest_bits=256)
    k.update(data)
    return k.digest()


def _hash_to_field(data: bytes) -> bytes:
    """Hash random bytes to a field element (shift right 8 bits, 32 bytes)."""
    h = int.from_bytes(_keccak256(data), 'big') >> 8
    return h.to_bytes(32, 'big')


def sign_request(action: str, signing_key_hex: str, ttl: int = DEFAULT_TTL_SEC) -> dict:
    """
    Generate an RP context signature for World ID v4.

    Mirrors the JS signRequest from @worldcoin/idkit-server:
    - nonce: keccak256(random 32 bytes) >> 8, as 32 bytes
    - message: nonce(32) || created_at(8, big-endian) || expires_at(8, big-endian) = 48 bytes
    - sig: secp256k1 ECDSA sign(keccak256(message), privkey), 65 bytes (compact + recovery+27)
    """
    key_hex = signing_key_hex[2:] if signing_key_hex.startswith('0x') else signing_key_hex
    if len(key_hex) != 64:
        raise ValueError('Invalid signing key length')
    priv_key = PrivateKey(bytes.fromhex(key_hex))

    # Generate nonce
    random_bytes = os.urandom(32)
    nonce_bytes = _hash_to_field(random_bytes)

    created_at = int(time.time())
    expires_at = created_at + ttl

    # Build 48-byte message: nonce(32) + created_at(8) + expires_at(8)
    message = nonce_bytes + struct.pack('>Q', created_at) + struct.pack('>Q', expires_at)

    # Hash and sign
    msg_hash = _keccak256(message)
    sig_recoverable = priv_key.sign_recoverable(msg_hash, hasher=None)
    # sig_recoverable is 65 bytes: compact(64) + recovery(1, 0-based)
    # World ID expects recovery byte as recovery + 27
    sig65 = sig_recoverable[:64] + bytes([sig_recoverable[64] + 27])

    return {
        'sig': '0x' + sig65.hex(),
        'nonce': '0x' + nonce_bytes.hex(),
        'created_at': created_at,
        'expires_at': expires_at,
    }


def generate_rp_context() -> dict:
    """Generate a complete rp_context for the frontend IDKit widget."""
    signing_key = _get_rp_signing_key()
    if not WORLD_ID_RP_ID or not signing_key:
        raise ValueError('WORLD_ID_RP_ID and RP_SIGNING_KEY must be configured')

    result = sign_request(WORLD_ID_ACTION, signing_key)
    return {
        'rp_id': WORLD_ID_RP_ID,
        'nonce': result['nonce'],
        'created_at': result['created_at'],
        'expires_at': result['expires_at'],
        'signature': result['sig'],
    }


# Allowed fields in the proof payload forwarded to the World ID verify API
_ALLOWED_PROOF_FIELDS = {
    # v4 fields
    'protocol_version', 'nonce', 'action', 'action_description',
    'environment', 'responses',
    # Legacy v3 fields (when allow_legacy_proofs is true)
    'merkle_root', 'nullifier_hash', 'proof', 'verification_level',
    'signal_hash', 'signal',
}


def _sanitize_proof(proof: dict) -> dict:
    """Whitelist only expected fields from the IDKit result before forwarding."""
    return {k: v for k, v in proof.items() if k in _ALLOWED_PROOF_FIELDS}


def verify_world_id_proof(proof: dict) -> dict:
    """
    Verify a World ID proof with the v4 cloud API.

    In v4, the IDKit result is forwarded directly to the verify endpoint.
    Only whitelisted fields are forwarded.
    """
    rp_id = WORLD_ID_RP_ID
    sanitized_proof = _sanitize_proof(proof)

    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.post(
                f'{VERIFY_URL}/{rp_id}',
                json=sanitized_proof,
                headers={
                    'Content-Type': 'application/json',
                    'User-Agent': 'AnyCompanyAgent/2.0',
                }
            )

        if response.status_code == 200:
            result = response.json()
            # Validate orb-level credential in v4 responses
            # issuer_schema_id 1 = orb (see IDKit CredentialType)
            results = result.get('results', [])
            if not results:
                return {
                    'success': False,
                    'error': 'Verification returned no results. Please try again.',
                    'code': 'invalid_response',
                }
            # In v4, orb-level is enforced by the orbLegacy() preset on the frontend.
            # The v4 verify response results contain {identifier, success, nullifier}.
            # Verify that the result indicates success.
            if not results[0].get('success'):
                return {
                    'success': False,
                    'error': 'Verification did not succeed. Please try again.',
                    'code': 'verification_failed',
                }

            # v4: nullifier is in results[0], session_id is top-level
            return {
                'success': True,
                'nullifier': results[0].get('nullifier') or result.get('nullifier'),
                'session_id': result.get('session_id'),
                'created_at': result.get('created_at'),
                'uses': result.get('uses', 0),
            }
        else:
            error_data = response.json() if response.content else {}
            error_code = error_data.get('code', 'unknown_error')
            error_detail = error_data.get('detail', 'Verification failed')

            error_messages = {
                'invalid_proof': 'The verification proof is invalid. Please try again.',
                'already_verified': 'You have already completed a checkout. World ID limits each person to one checkout.',
                'max_verifications_reached': 'You have already completed a checkout. World ID limits each person to one checkout.',
                'all_verifications_failed': 'Verification failed. Please try again.',
                'verification_error': 'Verification error. Please try again.',
                'app_not_migrated': 'App configuration error. Please contact support.',
            }

            return {
                'success': False,
                'error': error_messages.get(error_code, error_detail),
                'code': error_code,
            }

    except httpx.TimeoutException:
        return {
            'success': False,
            'error': 'Verification service timed out. Please try again.',
            'code': 'timeout',
        }
    except httpx.RequestError as e:
        print(f"World ID connection error: {type(e).__name__}")
        return {
            'success': False,
            'error': 'Failed to connect to verification service. Please try again.',
            'code': 'connection_error',
        }
    except Exception as e:
        print(f"World ID verification error: {type(e).__name__}")
        return {
            'success': False,
            'error': 'Verification failed. Please try again.',
            'code': 'internal_error',
        }
