"""Tests for credential_validator.py (DE 11 Block 1.G).

Coverage:
1. Valid cert → CertClaims returned
2. Invalid signature → None
3. alg=none attack → None (rejected before even reaching sig-check)
4. Expired cert (exp < now) → None
5. Revoked cert (cert_id in Redis set) → None
6. Missing kid → None
7. Cold JWKS cache (no key in Redis) → None
"""

from __future__ import annotations

import base64
import json
import time
from unittest.mock import AsyncMock, MagicMock

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

from dcc_chat_gateway.credential_validator import (
    CertClaims,
    validate_cert,
)

# ---------------------------------------------------------------------------
# Test-keypair (RSA-2048, generated once per session)
# ---------------------------------------------------------------------------

_RSA_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_RSA_PUBLIC_KEY = _RSA_KEY.public_key()
_KID = "test-key-1"


def _jwks_json() -> str:
    """Build a JWKS JSON string for the test RSA key."""
    nums = _RSA_PUBLIC_KEY.public_numbers()

    def _b64(n: int) -> str:
        bl = (n.bit_length() + 7) // 8
        return base64.urlsafe_b64encode(n.to_bytes(bl, "big")).rstrip(b"=").decode()

    key_dict = {
        "kty": "RSA",
        "use": "sig",
        "alg": "RS256",
        "kid": _KID,
        "n": _b64(nums.n),
        "e": _b64(nums.e),
    }
    return json.dumps({"keys": [key_dict]})


def _make_cert_jwt(
    *,
    extra_claims: dict | None = None,
    iat_offset: int = 0,
    exp_offset: int = 3600,
    kid: str = _KID,
    algorithm: str = "RS256",
    sign_key=None,
) -> str:
    now = int(time.time())
    payload = {
        "iss": "https://howispulse.com",  # required ab Phase 5.1 iss-Validation
        "aud": "dcc",  # Cloud JWT_AUDIENCE — stamped into every real cert
        "typ": "credential",  # discriminator, enforced since the typ-check fix
        "cert_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "user_id": "123456789",
        "device_pubkey": base64.urlsafe_b64encode(b"\x00" * 32).rstrip(b"=").decode(),
        "device_label": "Test Device",
        "pairwise_seed": base64.urlsafe_b64encode(b"\xab" * 32).rstrip(b"=").decode(),
        "amr": ["pwd", "otp"],
        "acr": "1",
        "iat": now + iat_offset,
        "exp": now + exp_offset,
    }
    if extra_claims:
        payload.update(extra_claims)
    key = sign_key if sign_key is not None else _RSA_KEY
    return jwt.encode(payload, key, algorithm=algorithm, headers={"kid": kid})


def _make_redis(*, jwks: str | None = None, revoked: set[str] | None = None) -> AsyncMock:
    """Build a minimal Redis mock with JWKS + revoked-set behaviour."""
    revoked = revoked or set()
    redis = AsyncMock()

    async def _get(key):
        # Serve the JWKS for both the local (cloud-mode) and the cloud
        # (self-host-mode) cache keys so the test is instance-mode agnostic.
        if key in ("auth:jwks:cached", "auth:cloud_jwks:cached"):
            return jwks.encode() if jwks else None
        return None

    async def _sismember(key, member):
        return member in revoked

    redis.get = _get
    redis.sismember = _sismember
    return redis


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_valid_cert_returns_claims():
    """Valid RS256 cert with correct JWKS → CertClaims returned."""
    token = _make_cert_jwt()
    redis = _make_redis(jwks=_jwks_json())
    result = await validate_cert(token, redis)
    assert isinstance(result, CertClaims)
    assert result.cert_id == "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    assert result.user_id == "123456789"
    assert result.acr == "1"


@pytest.mark.asyncio
async def test_wrong_typ_returns_none():
    """A correctly signed JWT with typ != "credential" (e.g. an access
    token slipped into the cert slot) must be rejected."""
    token = _make_cert_jwt(extra_claims={"typ": "access"})
    redis = _make_redis(jwks=_jwks_json())
    assert await validate_cert(token, redis) is None


@pytest.mark.asyncio
async def test_missing_typ_returns_none():
    token = _make_cert_jwt(extra_claims={"typ": None})
    redis = _make_redis(jwks=_jwks_json())
    assert await validate_cert(token, redis) is None


@pytest.mark.asyncio
async def test_wrong_audience_returns_none_when_enforced(monkeypatch):
    """With ``pulse_jwt_audience`` set, a cert carrying a different aud
    fails signature-stage validation."""
    from dcc_chat_gateway.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "pulse_jwt_audience", "dcc")
    token = _make_cert_jwt(extra_claims={"aud": "not-dcc"})
    redis = _make_redis(jwks=_jwks_json())
    assert await validate_cert(token, redis) is None


@pytest.mark.asyncio
async def test_matching_audience_passes_when_enforced(monkeypatch):
    from dcc_chat_gateway.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "pulse_jwt_audience", "dcc")
    token = _make_cert_jwt()  # factory stamps aud="dcc"
    redis = _make_redis(jwks=_jwks_json())
    assert isinstance(await validate_cert(token, redis), CertClaims)


@pytest.mark.asyncio
async def test_invalid_signature_returns_none():
    """Cert signed with a different key → None."""
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    token = _make_cert_jwt(sign_key=other_key)
    redis = _make_redis(jwks=_jwks_json())  # JWKS has the *correct* public key
    result = await validate_cert(token, redis)
    assert result is None


@pytest.mark.asyncio
async def test_alg_none_attack_returns_none():
    """alg=none token must be rejected (no algorithm negotiation)."""
    # PyJWT refuses to encode alg=none, so craft a minimal unsigned JWT manually
    import base64 as _b64

    header = _b64.urlsafe_b64encode(b'{"alg":"none","kid":"test-key-1"}').rstrip(b"=").decode()
    payload_bytes = json.dumps(
        {
            "cert_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "user_id": "123456789",
            "device_pubkey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "device_label": "x",
            "pairwise_seed": "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s",
            "iat": int(time.time()),
            "exp": int(time.time()) + 3600,
        }
    ).encode()
    payload_b64 = _b64.urlsafe_b64encode(payload_bytes).rstrip(b"=").decode()
    token = f"{header}.{payload_b64}."  # empty signature
    redis = _make_redis(jwks=_jwks_json())
    result = await validate_cert(token, redis)
    assert result is None


@pytest.mark.asyncio
async def test_expired_cert_returns_none():
    """Cert with exp in the past → None."""
    token = _make_cert_jwt(exp_offset=-1)  # already expired
    redis = _make_redis(jwks=_jwks_json())
    result = await validate_cert(token, redis)
    assert result is None


@pytest.mark.asyncio
async def test_revoked_cert_returns_none():
    """Valid cert whose cert_id is in the revoked set → None."""
    cert_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    token = _make_cert_jwt()
    redis = _make_redis(jwks=_jwks_json(), revoked={cert_id})
    result = await validate_cert(token, redis)
    assert result is None


@pytest.mark.asyncio
async def test_missing_kid_returns_none():
    """Token without a kid header → None (prevents JWKS-flooding)."""
    now = int(time.time())
    payload = {
        "cert_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "user_id": "123456789",
        "device_pubkey": "AAAA",
        "device_label": "x",
        "pairwise_seed": "AAAA",
        "iat": now,
        "exp": now + 3600,
    }
    # encode without kid header
    token = jwt.encode(payload, _RSA_KEY, algorithm="RS256")
    redis = _make_redis(jwks=_jwks_json())
    result = await validate_cert(token, redis)
    assert result is None


@pytest.mark.asyncio
async def test_cold_jwks_cache_returns_none():
    """No JWKS in Redis (cold cache) → fail-closed, None."""
    token = _make_cert_jwt()
    redis = _make_redis(jwks=None)  # cold cache
    result = await validate_cert(token, redis)
    assert result is None

@pytest.mark.asyncio
async def test_timing_attack_guard_runs_both_checks():
    """Invalid signature → sismember still called exactly once (Plan §381).

    The CRL Redis call must happen even when signature verification fails, so
    that an attacker cannot distinguish 'bad sig' from 'revoked cert' by timing.
    """
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    # Token signed with a different key — signature will fail.
    token = _make_cert_jwt(sign_key=other_key)

    sismember_calls: list[str] = []

    redis = AsyncMock()

    async def _get(key):
        if key == "auth:jwks:cached":
            return _jwks_json().encode()
        return None

    async def _sismember(key, member):
        sismember_calls.append(str(member))
        return False

    redis.get = _get
    redis.sismember = _sismember

    result = await validate_cert(token, redis)

    assert result is None, "invalid signature must return None"
    assert len(sismember_calls) == 1, (
        f"sismember must be called exactly once even on sig failure, got {sismember_calls}"
    )
    # The cert_id from the unverified payload must have been used (not empty string "")
    assert sismember_calls[0] == "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", (
        f"sismember must be called with the actual cert_id, got {sismember_calls[0]!r}"
    )
