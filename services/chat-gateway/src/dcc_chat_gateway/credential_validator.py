"""Cert-JWT validation + pairwise-sub resolution for Self-Host (DE 11).

Validates Identitäts-Certs issued by the Cloud auth-svc:
- Strict RS256 (no algorithm negotiation)
- JWKS lookup from Redis cache (``auth:jwks:cached``)
- CRL membership check against Redis set ``auth:revoked:certs``
- Signature-first order, CRL check always runs (timing-attack guard, Plan §381)

Also provides:
- ``compute_pairwise_sub`` — HMAC-SHA256(user_id+instance_id, pairwise_seed)
- ``resolve_user_identifier`` — cloud → user_id, self-host → pairwise-sub
- ``make_challenge`` / ``verify_challenge_signature`` — Ed25519 challenge-response
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from jwt.algorithms import RSAAlgorithm
from pydantic import BaseModel

# Redis key constants (mirrors auth-svc + crl_poller)
REDIS_JWKS_KEY = "auth:jwks:cached"
REDIS_REVOKED_SET = "auth:revoked:certs"

# Challenge size in bytes (DE 11 A.7)
CHALLENGE_BYTES = 32


class CertClaims(BaseModel):
    """Parsed, validated claims from an Identitäts-Cert JWT."""

    cert_id: str
    user_id: str
    device_pubkey: str  # Base64url-encoded Ed25519 public key
    device_label: str
    pairwise_seed: str  # Base64url-encoded per-user seed
    amr: list[str] = []
    acr: str = "0"
    iat: int
    exp: int


def _build_pubkey_from_jwks(jwks_json: str) -> dict[str, Any]:
    """Parse a JWKS JSON string into a kid→RSAPublicKey mapping."""
    keys: dict[str, Any] = {}
    jwks = json.loads(jwks_json)
    for key_dict in jwks.get("keys", []):
        kid = key_dict.get("kid")
        if not kid:
            continue
        keys[kid] = RSAAlgorithm.from_jwk(json.dumps(key_dict))
    return keys


async def _get_jwks_keys(redis: Any) -> dict[str, Any]:
    """Fetch JWKS from Redis cache (``auth:jwks:cached`` is a JSON string).

    Returns an empty dict when the cache is cold — validator will return None
    (fail-closed) rather than fetch from the network itself. The crl_poller and
    security.py take care of keeping the Redis key warm.
    """
    raw = await redis.get(REDIS_JWKS_KEY)
    if not raw:
        return {}
    if isinstance(raw, bytes):
        raw = raw.decode()
    try:
        return _build_pubkey_from_jwks(raw)
    except Exception:  # noqa: BLE001
        return {}


async def validate_cert(cert_jwt: str, redis: Any) -> CertClaims | None:
    """Validate an Identitäts-Cert JWT.

    Returns ``CertClaims`` on success, ``None`` on any validation failure.

    Security invariants:
    - ``alg`` is ALWAYS RS256 — never derived from the token header.
    - Signature is verified BEFORE CRL lookup (timing-attack guard: both
      operations always run even when the first fails — see Plan §381).
    - ``exp > now`` and ``iat <= now`` are enforced.
    """
    # --- Step 1: Decode header (no-sig, just for kid lookup) ---
    try:
        header = jwt.get_unverified_header(cert_jwt)
    except jwt.PyJWTError:
        # Malformed token — still do a dummy CRL call so timing is constant.
        try:
            await redis.sismember(REDIS_REVOKED_SET, "")
        except Exception:  # noqa: BLE001
            pass
        return None

    kid = header.get("kid")
    # Reject tokens without a kid — prevents JWKS-flooding attack.
    # Still do a dummy CRL call for timing uniformity.
    if not kid:
        try:
            await redis.sismember(REDIS_REVOKED_SET, "")
        except Exception:  # noqa: BLE001
            pass
        return None

    # --- Step 1b: Extract cert_id without signature verification ---
    # This ensures the CRL Redis call always uses an actual cert_id value
    # from the token (Plan §381 timing-attack guard): even when signature
    # verification fails below, we still perform a real sismember call.
    unverified_cert_id = ""
    try:
        unverified_payload = jwt.decode(
            cert_jwt, options={"verify_signature": False, "verify_aud": False}
        )
        unverified_cert_id = unverified_payload.get("cert_id", "")
    except Exception:  # noqa: BLE001
        unverified_cert_id = ""

    # --- Step 2: Fetch public key ---
    keys = await _get_jwks_keys(redis)
    pub_key = keys.get(kid)

    # --- Step 3: Signature verification (always RS256) ---
    sig_ok = False
    claims: dict[str, Any] = {}
    if pub_key is not None:
        try:
            claims = jwt.decode(
                cert_jwt,
                pub_key,
                algorithms=["RS256"],  # STRICT — no header negotiation
                options={"verify_aud": False},  # Certs carry no audience claim
            )
            sig_ok = True
        except jwt.PyJWTError:
            sig_ok = False
    else:
        sig_ok = False

    # --- Step 4: CRL lookup (runs ALWAYS — timing-attack guard, Plan §381) ---
    # Use the unverified cert_id so the Redis call always happens with a real
    # value, regardless of whether the signature was valid or not.
    cert_id = unverified_cert_id
    try:
        is_revoked = bool(await redis.sismember(REDIS_REVOKED_SET, cert_id)) if cert_id else False
    except Exception:  # noqa: BLE001
        is_revoked = False  # fail-open on Redis error (same as previous good state)

    # --- Step 5: Reject on sig failure or revocation ---
    if not sig_ok:
        return None
    if is_revoked:
        return None

    # --- Step 6: Manual time checks (PyJWT's exp/iat are already verified by
    # jwt.decode above, but we double-check for belt-and-suspenders) ---
    now = int(time.time())
    iat = claims.get("iat", 0)
    exp = claims.get("exp", 0)
    if iat > now or exp <= now:
        return None

    # --- Step 7: Parse claims into model ---
    try:
        return CertClaims(
            cert_id=claims["cert_id"],
            user_id=str(claims["user_id"]),
            device_pubkey=claims["device_pubkey"],
            device_label=claims.get("device_label", ""),
            pairwise_seed=claims.get("pairwise_seed", ""),
            amr=claims.get("amr", []),
            acr=str(claims.get("acr", "0")),
            iat=iat,
            exp=exp,
        )
    except (KeyError, ValueError):
        return None


def compute_pairwise_sub(user_id: str, instance_id: int, pairwise_seed: str) -> str:
    """Compute the pairwise subject for a self-host instance (DE 11 A.4).

    pairwise_sub = base64url(HMAC-SHA256(user_id || ":" || instance_id,
                                          pairwise_seed_bytes))[:16]

    ``pairwise_seed`` is the Base64url-encoded per-user seed from the Cert.
    Result is 16 hex chars of the HMAC, stable across devices (same user_id,
    same instance_id, same pairwise_seed → same sub).
    """
    try:
        key = base64.urlsafe_b64decode(pairwise_seed + "==")
    except Exception:  # noqa: BLE001
        # Non-base64 seed — treat as raw UTF-8 bytes
        key = pairwise_seed.encode()
    msg = f"{user_id}:{instance_id}".encode()
    digest = hmac.new(key, msg, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()[:16]


def resolve_user_identifier(
    claims: CertClaims,
    *,
    instance_mode: str,
    instance_id: int,
) -> str:
    """Return the user identifier to use for this instance (DE 11 A.4 + A.13).

    Cloud mode  → direct user_id (no pairwise obfuscation needed)
    Self-host   → pairwise sub (privacy by design; different per instance)
    """
    if instance_mode == "cloud":
        return claims.user_id
    return compute_pairwise_sub(claims.user_id, instance_id, claims.pairwise_seed)


def make_challenge() -> bytes:
    """Generate a fresh 32-byte challenge for the Ed25519 challenge-response flow."""
    return os.urandom(CHALLENGE_BYTES)


def verify_challenge_signature(
    challenge: bytes,
    signature: bytes,
    device_pubkey_b64: str,
) -> bool:
    """Verify an Ed25519 signature over ``challenge`` with the device's public key.

    ``device_pubkey_b64`` is the Base64url-encoded raw Ed25519 public key (32 bytes)
    as stored in the Cert's ``device_pubkey`` claim.

    Returns ``False`` on any error (missing padding, wrong key format, bad sig).
    """
    try:
        key_bytes = base64.urlsafe_b64decode(device_pubkey_b64 + "==")
        pub = Ed25519PublicKey.from_public_bytes(key_bytes)
        pub.verify(signature, challenge)
        return True
    except Exception:  # noqa: BLE001
        return False
