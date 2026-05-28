"""Self-Host-local session tokens (DE 9).

After successful Cert-Auth + Challenge-Response, the Self-Host issues a
short-lived (5 min) local JWT — NOT cloud-signed. The signing key is an
Ed25519 or RS256 key generated on first startup and stored in
``/data/jwt_keys/session_signing.pem``.

Session metadata is also stored in Redis (``auth:session_tokens:<token_hash>``)
with a matching 5-minute TTL so voice-signaling can validate tokens without
possessing the signing key itself (it reads from Redis, not verifies signatures).

Design notes:
- Ed25519 preferred (fast, small tokens); falls back to RS256 if the key file
  already contains an RSA key (upgrade path).
- The signing key file path is configurable via ``session_signing_key_file``
  in Settings (default ``./data/jwt_keys/session_signing.pem``).
- Redis metadata key is a SHA-256 hash of the raw token string (not the token
  itself) — avoids leaking tokens into Redis key space.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from pydantic import BaseModel

log = logging.getLogger(__name__)

# Redis key template for session metadata
REDIS_SESSION_PREFIX = "auth:session_tokens:"
SESSION_TTL_SECONDS = 300  # 5 minutes (DE 9)

# JWT claims
_JWT_ISSUER = "pulse-self-host"
_JWT_AUDIENCE = "pulse-session"


class SessionClaims(BaseModel):
    """Parsed claims from a local session token."""

    user_identifier: str  # pairwise_sub (self-host) or user_id (cloud)
    cert_id: str
    iat: int
    exp: int


# ---------------------------------------------------------------------------
# Key management
# ---------------------------------------------------------------------------


def _generate_ed25519_pem() -> bytes:
    """Generate a new Ed25519 private key in PEM format."""
    key = Ed25519PrivateKey.generate()
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


def _load_or_generate_key(key_path: str) -> Ed25519PrivateKey:
    """Load an Ed25519 private key from ``key_path``, generating it if absent."""
    p = Path(key_path)
    if p.exists():
        pem = p.read_bytes()
        try:
            key = serialization.load_pem_private_key(pem, password=None)
            if isinstance(key, Ed25519PrivateKey):
                return key
            log.warning(
                "session signing key at %s is not Ed25519 — regenerating", key_path
            )
        except Exception:  # noqa: BLE001
            log.warning("Failed to load session signing key at %s — regenerating", key_path)

    # Generate fresh key
    p.parent.mkdir(parents=True, exist_ok=True)
    pem = _generate_ed25519_pem()
    p.write_bytes(pem)
    # Harden permissions (Linux only, silent on other platforms)
    try:
        os.chmod(p.parent, 0o700)
        os.chmod(p, 0o600)
    except OSError:
        pass
    log.info("Generated new Ed25519 session signing key at %s", key_path)
    return serialization.load_pem_private_key(pem, password=None)  # type: ignore[return-value]


# Module-level singletons; reset via ``reset_session_signer()`` in tests.
_private_key: Ed25519PrivateKey | None = None
_public_key: Ed25519PublicKey | None = None
_key_path_used: str | None = None


def _get_keys(key_path: str) -> tuple[Ed25519PrivateKey, Ed25519PublicKey]:
    global _private_key, _public_key, _key_path_used
    if _private_key is None or _key_path_used != key_path:
        _private_key = _load_or_generate_key(key_path)
        _public_key = _private_key.public_key()
        _key_path_used = key_path
    return _private_key, _public_key  # type: ignore[return-value]


def reset_session_signer() -> None:
    """Reset cached keys — used in tests."""
    global _private_key, _public_key, _key_path_used
    _private_key = None
    _public_key = None
    _key_path_used = None


# ---------------------------------------------------------------------------
# Redis helpers
# ---------------------------------------------------------------------------


def _token_redis_key(token: str) -> str:
    """Derive a Redis key from a token without storing the token value directly."""
    digest = hashlib.sha256(token.encode()).hexdigest()
    return f"{REDIS_SESSION_PREFIX}{digest}"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def issue_session_token(
    user_identifier: str,
    cert_id: str,
    *,
    key_path: str = "./data/jwt_keys/session_signing.pem",
) -> str:
    """Issue a 5-minute self-host session token.

    Signed with the local Ed25519 key. ``user_identifier`` is the pairwise_sub
    (self-host) or direct user_id (cloud mode).
    """
    priv, _ = _get_keys(key_path)
    now = int(time.time())
    payload: dict[str, Any] = {
        "iss": _JWT_ISSUER,
        "aud": _JWT_AUDIENCE,
        "sub": user_identifier,
        "cert_id": cert_id,
        "iat": now,
        "exp": now + SESSION_TTL_SECONDS,
        "typ": "session",
    }
    # PyJWT encodes Ed25519 via algorithm "EdDSA"
    return jwt.encode(payload, priv, algorithm="EdDSA")


async def store_session_token(
    token: str,
    user_identifier: str,
    cert_id: str,
    redis: Any,
) -> None:
    """Write session metadata to Redis with 5-minute TTL.

    voice-signaling reads from here to validate tokens without needing the
    signing key (Plan DE 11 A.10).
    """
    redis_key = _token_redis_key(token)
    metadata = json.dumps(
        {"user_identifier": user_identifier, "cert_id": cert_id}
    )
    await redis.set(redis_key, metadata, ex=SESSION_TTL_SECONDS)


def validate_session_token(
    token: str,
    *,
    key_path: str = "./data/jwt_keys/session_signing.pem",
) -> SessionClaims | None:
    """Validate a self-host session token.

    Returns ``SessionClaims`` on success, ``None`` on any error (expired,
    tampered, wrong algorithm, wrong iss/aud).
    """
    _, pub = _get_keys(key_path)
    try:
        claims = jwt.decode(
            token,
            pub,
            algorithms=["EdDSA"],
            audience=_JWT_AUDIENCE,
            issuer=_JWT_ISSUER,
        )
    except jwt.PyJWTError:
        return None

    if claims.get("typ") != "session":
        return None

    try:
        return SessionClaims(
            user_identifier=claims["sub"],
            cert_id=claims["cert_id"],
            iat=claims["iat"],
            exp=claims["exp"],
        )
    except (KeyError, ValueError):
        return None
