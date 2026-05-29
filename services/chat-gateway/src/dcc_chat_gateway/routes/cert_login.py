"""POST /cert-login/{challenge,verify} — Self-Host Cert-Auth (Phase 5.1).

Stateless two-step flow that turns a Cloud-signed Identitäts-Cert into a
local Self-Host session token (DE 9 / DE 11).

Flow:
    1. Client POSTs the cert to ``/cert-login/challenge``.
       Server validates the cert (RS256 + JWKS-pin + CRL via
       ``credential_validator.validate_cert``) and returns a 60s
       HMAC-SHA256 challenge-JWT containing a fresh 32-byte nonce + the
       cert_id it was bound to.
    2. Client signs the **raw nonce bytes** with the device's Ed25519
       private key (the public half lives in the cert's ``device_pubkey``)
       and POSTs ``cert``, ``challenge_token`` and the base64url-encoded
       ``signature`` to ``/cert-login/verify``.
       Server re-validates the cert, verifies the challenge-JWT's HMAC
       and freshness, checks ``challenge_token.cert_id`` matches the new
       cert (replay-guard across certs), verifies the Ed25519 signature
       over the nonce, and on success issues an Ed25519-signed 5-minute
       session-token (``session_tokens.issue_session_token``) — keyed by
       the pairwise-sub in self-host mode or the raw user_id in cloud
       mode (``resolve_user_identifier``).

The challenge-JWT is HMAC-signed (not Cloud-signed) because the
chat-gateway has no Cloud private key.  The HMAC secret is a per-instance
secret (``CHAT_GATEWAY_CHALLENGE_SECRET`` env var; ephemeral fallback on
first use with a WARN — single-pod self-host).  The server keeps **no
state** between the two steps: the nonce travels inside the signed
challenge-JWT, which is what makes the replay-window equal to the
60-second ``exp`` (and only that — a challenge cannot be redeemed twice
beyond what a network attacker could already do by replaying the verify
call, which is rate-limited by cert expiry + Ed25519 single-use semantics
in the calling client).

Never logs tokens, signatures or secrets.
"""

from __future__ import annotations

import base64
import hmac
import logging
import os
import secrets
import time

import jwt
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.credential_validator import (
    resolve_user_identifier,
    validate_cert,
    verify_challenge_signature,
)
from dcc_chat_gateway.session_tokens import (
    SESSION_TTL_SECONDS,
    issue_session_token,
    store_session_token,
)

log = logging.getLogger(__name__)
router = APIRouter()

CHALLENGE_TTL_SECONDS = 60
_CHALLENGE_PURPOSE = "cert-login-challenge"
_CHALLENGE_ALG = "HS256"


# ---------------------------------------------------------------------------
# Per-instance HMAC secret
# ---------------------------------------------------------------------------


_ephemeral_secret: bytes | None = None


def _get_challenge_secret() -> bytes:
    """Return the HMAC secret used to sign challenge-JWTs.

    Resolution order:
      1. ``settings.chat_gateway_challenge_secret`` (base64url, ≥32 bytes
         decoded) — set this in ``.env`` to keep challenges valid across
         restarts.
      2. Ephemeral 32-byte secret generated on first use; WARN-logged so
         operators know to set the env var for persistence.
    """
    global _ephemeral_secret
    raw = get_settings().chat_gateway_challenge_secret
    if raw:
        try:
            return base64.urlsafe_b64decode(raw + "==")
        except Exception:  # noqa: BLE001
            # Fall through to ephemeral — bad env values would otherwise
            # 500 every challenge call until operators fix the var.
            log.warning(
                "CHAT_GATEWAY_CHALLENGE_SECRET present but not valid "
                "base64url; falling back to ephemeral secret"
            )
    if _ephemeral_secret is None:
        _ephemeral_secret = os.urandom(32)
        log.warning(
            "cert-login: generated ephemeral challenge secret; set "
            "CHAT_GATEWAY_CHALLENGE_SECRET (base64url) in .env to persist "
            "challenge-tokens across restarts"
        )
    return _ephemeral_secret


def _reset_challenge_secret_for_tests() -> None:
    """Drop the cached ephemeral secret — test helper, do not call in prod."""
    global _ephemeral_secret
    _ephemeral_secret = None


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ChallengeRequest(BaseModel):
    cert: str


class ChallengeResponse(BaseModel):
    challenge_token: str
    nonce: str  # base64url(raw nonce bytes) — the client signs the raw bytes
    expires_in: int = CHALLENGE_TTL_SECONDS


class VerifyRequest(BaseModel):
    cert: str
    challenge_token: str
    signature: str  # base64url(Ed25519 signature over the raw nonce bytes)


class VerifyResponse(BaseModel):
    session_token: str
    expires_in: int
    pairwise_sub: str
    instance_id: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post(
    "/cert-login/challenge",
    response_model=ChallengeResponse,
    status_code=status.HTTP_200_OK,
)
async def cert_login_challenge(
    body: ChallengeRequest, request: Request
) -> ChallengeResponse:
    """Validate the cert and return a 60s HMAC-signed challenge."""
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        # Tests using the REST-only fixture wire Redis on app.state — defensive.
        raise HTTPException(status_code=503, detail="cert_login_unavailable")

    claims = await validate_cert(body.cert, redis)
    if claims is None:
        # Validator collapses all failure modes (bad sig / revoked / expired
        # / cold JWKS) into None. We return 401 — 400 only if the JWT
        # didn't even parse, but PyJWT's PyJWTError pathway in validate_cert
        # also returns None, so the cleanest external contract is "auth
        # failed" for any cert-side problem.
        raise HTTPException(status_code=401, detail="cert_invalid")

    nonce_raw = secrets.token_bytes(32)
    nonce_b64 = base64.urlsafe_b64encode(nonce_raw).rstrip(b"=").decode()
    now = int(time.time())
    payload = {
        "purpose": _CHALLENGE_PURPOSE,
        "cert_id": claims.cert_id,
        "nonce": nonce_b64,
        "iat": now,
        "exp": now + CHALLENGE_TTL_SECONDS,
    }
    token = jwt.encode(payload, _get_challenge_secret(), algorithm=_CHALLENGE_ALG)
    return ChallengeResponse(
        challenge_token=token,
        nonce=nonce_b64,
        expires_in=CHALLENGE_TTL_SECONDS,
    )


def _decode_challenge_token(token: str) -> dict:
    """Decode + verify the HMAC challenge-JWT. Raises HTTPException on failure."""
    try:
        claims = jwt.decode(
            token,
            _get_challenge_secret(),
            algorithms=[_CHALLENGE_ALG],
            options={"require": ["exp", "iat", "purpose", "cert_id", "nonce"]},
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=410, detail="challenge_expired")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="challenge_invalid")
    if claims.get("purpose") != _CHALLENGE_PURPOSE:
        raise HTTPException(status_code=401, detail="challenge_invalid")
    return claims


@router.post(
    "/cert-login/verify",
    response_model=VerifyResponse,
    status_code=status.HTTP_200_OK,
)
async def cert_login_verify(
    body: VerifyRequest, request: Request
) -> VerifyResponse:
    """Verify the Ed25519 signature over the challenge nonce and mint a session token."""
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(status_code=503, detail="cert_login_unavailable")

    # 1. Re-validate the cert (signature/CRL/exp/iat — same path as /challenge).
    cert_claims = await validate_cert(body.cert, redis)
    if cert_claims is None:
        raise HTTPException(status_code=401, detail="cert_invalid")

    # 2. Verify the HMAC challenge-token + ttl.
    challenge_claims = _decode_challenge_token(body.challenge_token)

    # 3. Replay-guard: challenge was bound to this cert_id.
    if not hmac.compare_digest(
        str(challenge_claims.get("cert_id", "")), cert_claims.cert_id
    ):
        raise HTTPException(status_code=401, detail="cert_mismatch")

    # 4. Verify Ed25519 signature over the RAW nonce bytes using the
    #    device pubkey stored in the cert.
    try:
        nonce_raw = base64.urlsafe_b64decode(challenge_claims["nonce"] + "==")
        signature = base64.urlsafe_b64decode(body.signature + "==")
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=401, detail="signature_invalid")
    if not verify_challenge_signature(nonce_raw, signature, cert_claims.device_pubkey):
        raise HTTPException(status_code=401, detail="signature_invalid")

    # 5. Resolve identifier (pairwise-sub in self-host, raw user_id in cloud).
    settings = get_settings()
    identifier = resolve_user_identifier(
        cert_claims,
        instance_mode=settings.pulse_instance_mode,
        instance_id=settings.pulse_instance_id,
    )

    # 5b. Self-host admin bootstrap: the cert-holder whose Cloud user_id matches
    #     this instance's configured owner becomes admin. The cert carries the
    #     raw Cloud user_id (validated above); compare to PULSE_INSTANCE_OWNER_ID.
    #     Cloud mode (owner_id 0) never matches here.
    is_owner_admin = False
    if settings.pulse_instance_mode == "self-host" and settings.pulse_instance_owner_id:
        try:
            is_owner_admin = int(cert_claims.user_id) == settings.pulse_instance_owner_id
        except (TypeError, ValueError):
            is_owner_admin = False

    # 6. Mint + persist session token.
    token = issue_session_token(
        identifier,
        cert_claims.cert_id,
        key_path=settings.session_signing_key_file,
        admin=is_owner_admin,
    )
    await store_session_token(token, identifier, cert_claims.cert_id, redis)

    return VerifyResponse(
        session_token=token,
        expires_in=SESSION_TTL_SECONDS,
        pairwise_sub=identifier,
        instance_id=str(settings.pulse_instance_id),
    )
