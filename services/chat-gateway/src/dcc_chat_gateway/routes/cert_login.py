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
state** between the two steps for the challenge phase: the nonce travels
inside the signed challenge-JWT.

A successful ``/verify`` is one-time-use: the challenge token is atomically
claimed in Redis (``cert-login:used:<hash>``, ``SET NX EX``) so the exact
same ``(cert, challenge_token, signature)`` body cannot be replayed within
the 60-second window to mint a second session token.  Both endpoints are
additionally per-IP rate-limited (in-process) to blunt brute-force/DoS.

Never logs tokens, signatures or secrets.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import secrets
import time

import jwt
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import CachedUserProfile
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

# Redis key prefix for the one-time-use marker on consumed challenge tokens.
# Keyed by a hash of the challenge token (never the raw token) so a successful
# /verify cannot be replayed within the 60s challenge window.
_CONSUMED_PREFIX = "cert-login:used:"


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
# Per-IP rate limit (in-process, unauthenticated endpoints)
# ---------------------------------------------------------------------------
#
# /cert-login/{challenge,verify} are reachable without auth and each call does
# Redis lookups + RS256/Ed25519 verification. A per-IP fixed window throttles
# brute-force/DoS while leaving room for normal retry behaviour. In-process
# only (single-pod self-host — same caveat as ``ratelimit.py``); a multi-pod
# deployment should front this with Caddy's rate-limit directive.

_CERT_LOGIN_RATE_LIMIT = 10      # requests allowed per window per IP
_CERT_LOGIN_RATE_WINDOW = 60.0   # seconds
_CERT_LOGIN_BUCKETS_MAX = 10_000  # hard cap: evict oldest entry when full

# ip -> (window_start_monotonic, count)
_cert_login_buckets: dict[str, tuple[float, int]] = {}


def _reset_cert_login_rate_for_tests() -> None:
    """Clear the per-IP rate buckets — test helper, do not call in prod."""
    _cert_login_buckets.clear()


def _client_ip(request: Request) -> str:
    """Best-effort client IP for rate-limit keying.

    Uses the direct socket peer address (``request.client.host``) set by the
    ASGI server, which always reflects the actual connecting party (the trusted
    reverse proxy when deployed behind Caddy/nginx).  X-Forwarded-For is
    intentionally ignored here: it is trivially spoofable by any caller who
    injects an arbitrary header before the proxy appends its own entry, and
    using it would allow an attacker to bypass the per-IP rate limit entirely.
    """
    client = request.client
    return client.host if client else "unknown"


def _enforce_cert_login_rate(request: Request) -> None:
    """Raise 429 when the caller's IP exceeds the cert-login window budget.

    Eviction strategy: instead of scanning the entire dict on every call
    (O(n_unique_IPs)), only scan when the dict has grown beyond half its cap.
    This amortises cleanup cost while bounding memory.  If the dict is at the
    hard cap *and* no expired entries exist (sustained high-variety attack),
    the oldest entry is evicted to admit the new IP, keeping the dict bounded.
    """
    ip = _client_ip(request)
    now = time.monotonic()

    # Periodic sweep: only run when the dict is large enough to matter.
    if len(_cert_login_buckets) >= _CERT_LOGIN_BUCKETS_MAX // 2:
        expired = [
            k
            for k, (start, _) in _cert_login_buckets.items()
            if now - start >= _CERT_LOGIN_RATE_WINDOW
        ]
        for k in expired:
            del _cert_login_buckets[k]

    entry = _cert_login_buckets.get(ip)
    if entry is None or now - entry[0] >= _CERT_LOGIN_RATE_WINDOW:
        # Hard-cap guard: evict the oldest bucket if we are at the limit and
        # the new IP is not already tracked (avoids unbounded growth under a
        # sustained flood of unique-IP spoofed source addresses).
        if entry is None and len(_cert_login_buckets) >= _CERT_LOGIN_BUCKETS_MAX:
            oldest_key = min(_cert_login_buckets, key=lambda k: _cert_login_buckets[k][0])
            del _cert_login_buckets[oldest_key]
        _cert_login_buckets[ip] = (now, 1)
        return
    start, count = entry
    if count >= _CERT_LOGIN_RATE_LIMIT:
        raise HTTPException(status_code=429, detail="rate_limited")
    _cert_login_buckets[ip] = (start, count + 1)


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
    _enforce_cert_login_rate(request)
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


def _consumed_key(challenge_token: str) -> str:
    """Redis key marking a challenge token as already consumed (hash, not raw)."""
    digest = hashlib.sha256(challenge_token.encode()).hexdigest()
    return f"{_CONSUMED_PREFIX}{digest}"


async def _claim_challenge_once(challenge_token: str, redis) -> None:
    """Mark the challenge as consumed exactly once; reject replays.

    ``SET NX EX`` is atomic: the first /verify wins and writes the marker, any
    concurrent or later replay within the 60s window sees the existing key and
    is rejected with 410. The marker TTL matches the challenge window — once the
    challenge JWT itself expires (``exp``) it would be rejected by
    ``_decode_challenge_token`` anyway, so the marker need not outlive it.
    """
    claimed = await redis.set(
        _consumed_key(challenge_token),
        "1",
        nx=True,
        ex=CHALLENGE_TTL_SECONDS,
    )
    if not claimed:
        raise HTTPException(status_code=410, detail="challenge_consumed")


@router.post(
    "/cert-login/verify",
    response_model=VerifyResponse,
    status_code=status.HTTP_200_OK,
)
async def cert_login_verify(
    body: VerifyRequest, request: Request, session: SessionDep
) -> VerifyResponse:
    """Verify the Ed25519 signature over the challenge nonce and mint a session token."""
    _enforce_cert_login_rate(request)
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

    # 4b. One-time use: atomically claim this challenge token. A replay of the
    #     exact same (cert, challenge_token, signature) body within the 60s
    #     window — e.g. from an intercepted /verify request — is rejected here
    #     before any session token is minted. Done after signature verification
    #     so an invalid attempt cannot burn a legitimate user's challenge.
    await _claim_challenge_once(body.challenge_token, redis)

    # 5. Resolve identifier (pairwise-sub in self-host, raw user_id in cloud).
    settings = get_settings()
    # Guard: a self-host with the default PULSE_INSTANCE_ID=0 must not mint
    # pairwise-subs. Every unconfigured instance would compute identical subs
    # (user_id + ':' + 0) — collapsing per-instance privacy isolation (DE 11 A.13).
    if settings.pulse_instance_mode == "self-host" and settings.pulse_instance_id == 0:
        raise HTTPException(status_code=503, detail="instance_id_unconfigured")
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

    # 5c. Instance-wide ban gate (F11c). A Cloud-admin can ban a user on this
    #     Self-Host instance (banned_at on the cached profile) → deny the
    #     session token. The instance owner is exempt so an admin can never
    #     lock themselves out permanently (e.g. accidental self-ban).
    if not is_owner_admin:
        banned_at = (
            await session.execute(
                select(CachedUserProfile.banned_at).where(
                    CachedUserProfile.user_identifier == identifier
                )
            )
        ).scalar_one_or_none()
        if banned_at is not None:
            raise HTTPException(status_code=403, detail="instance banned")

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
