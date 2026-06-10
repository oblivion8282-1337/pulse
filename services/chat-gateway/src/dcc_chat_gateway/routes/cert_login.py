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
import logging
import os
import secrets
import time

import jwt
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select

from dcc_chat_gateway.client_ip import client_ip as resolve_client_ip
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.credential_validator import (
    resolve_user_identifier,
    validate_cert,
    verify_challenge_signature,
)
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.membership import (
    add_member,
    community_invite_grants_access,
    is_instance_locked,
    is_member,
    public_community_grants_access,
)
from dcc_chat_gateway.models import CachedUserProfile
from dcc_chat_gateway.session_tokens import (
    SESSION_TTL_SECONDS,
    issue_session_token,
    store_session_token,
)

log = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# base64url helpers
# ---------------------------------------------------------------------------


def _b64url_encode(b: bytes) -> str:
    """Encode *b* as base64url without padding."""
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _b64url_decode(s: str) -> bytes:
    """Decode a base64url string that may lack padding."""
    return base64.urlsafe_b64decode(s + "==")


def _safe_int_eq(value, expected: int) -> bool:
    """Return ``int(value) == expected``; False on conversion error."""
    try:
        return int(value) == expected
    except (TypeError, ValueError):
        return False


def _require_redis(request: Request):
    """Return the Redis client from app state or raise 503."""
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(status_code=503, detail="cert_login_unavailable")
    return redis


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
            return _b64url_decode(raw)
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

# 30/60s ≈ 15 vollständige Re-Auths (challenge+verify) pro Minute pro IP.
# Der frühere Wert (10) war für die legitime Re-Auth-Last zu knapp: ein
# 5-Min-Session-Token + proaktiver Refresh + reaktives Re-Auth + mehrere
# Tabs/Popups hinter derselben IP (NAT, Watch-Party/Stream-Detach-Fenster)
# rissen das Budget — cert-login lieferte 429 und Re-Auth (z.B. das
# Community-Erstellen) schlug fehl. DoS-Schutz bleibt (pro-IP, in-process).
_CERT_LOGIN_RATE_LIMIT = 30      # requests allowed per window per IP
_CERT_LOGIN_RATE_WINDOW = 60.0   # seconds
_CERT_LOGIN_BUCKETS_MAX = 10_000  # hard cap: evict oldest entry when full

# ip -> (window_start_monotonic, count)
_cert_login_buckets: dict[str, tuple[float, int]] = {}


def _reset_cert_login_rate_for_tests() -> None:
    """Clear the per-IP rate buckets — test helper, do not call in prod."""
    _cert_login_buckets.clear()


def _client_ip(request: Request) -> str:
    """Best-effort client IP for rate-limit keying.

    Delegiert an ``client_ip.py``: X-Forwarded-For wird NUR ausgewertet, wenn
    der Socket-Peer in ``Settings.trusted_proxies`` steht. Die frühere Variante
    (immer Socket-Peer) war hinter Caddy/nginx wirkungslos — alle Clients
    landeten im Bucket der Proxy-IP: gegenseitiges Aussperren (DoS) möglich,
    ein einzelner Angreifer faktisch ungedrosselt. Von untrusted Peers bleibt
    XFF ignoriert (Spoofing-Schutz wie zuvor).
    """
    return resolve_client_ip(request)


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
        # Retry-After = verbleibende Sekunden im Fenster, damit der Client
        # gezielt backofft (cert-login.ts respektiert den Header), statt blind
        # in dasselbe Limit zu retrien. Mindestens 1s.
        retry_after = max(1, int(_CERT_LOGIN_RATE_WINDOW - (now - start)) + 1)
        raise HTTPException(
            status_code=429,
            detail="rate_limited",
            headers={"Retry-After": str(retry_after)},
        )
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
    # Optional Community-Invite code (Stufe 2 / B-lite). A *live* community
    # (``GuildInvite``) invite is itself the permission to join this instance —
    # the user joining a community via a friend-invite carries this code. One of
    # the two per-community access paths; consulted on first contact when the
    # instance is not ``locked``. The single "Server gesperrt" (``locked``)
    # not-aus toggle (Stufe 5) is checked first and is never bypassed by it.
    community_grant_code: str | None = None
    # Optional public-community handle (Stufe 4 / Entscheidung 5). If set AND the
    # named community is currently ``is_public``, it grants instance membership —
    # a public community is its own permission to join the instance. The other
    # per-community access path. The single "Server gesperrt" (``locked``)
    # not-aus toggle (Stufe 5) is checked first and overrides even this; a
    # non-public or unknown handle grants nothing.
    public_join_handle: str | None = None


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
    # Tests using the REST-only fixture wire Redis on app.state — defensive.
    redis = _require_redis(request)

    claims = await validate_cert(body.cert, redis)
    if claims is None:
        # Validator collapses all failure modes (bad sig / revoked / expired
        # / cold JWKS) into None. We return 401 — 400 only if the JWT
        # didn't even parse, but PyJWT's PyJWTError pathway in validate_cert
        # also returns None, so the cleanest external contract is "auth
        # failed" for any cert-side problem.
        raise HTTPException(status_code=401, detail="cert_invalid")

    nonce_raw = secrets.token_bytes(32)
    nonce_b64 = _b64url_encode(nonce_raw)
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


async def _enforce_join_gate(
    session,
    identifier: str,
    is_owner_admin: bool,
    community_grant_code: str | None = None,
    public_join_handle: str | None = None,
) -> None:
    """Self-Host join gate. Lets the request through or raises 403.

    On success (the owner, an existing member, or a permitted first-contact)
    this commits the membership write so the new ``instance_members`` row
    survives even though the verify route mints its token via Redis (no later
    SQL commit). Raises ``HTTPException`` 403 to deny.

    Gate order (Stufe 5 — security-critical):
      1. **owner** — always in; record membership on first sight.
      2. **existing member** — always in, never asked again (the re-auth path;
         this runs BEFORE the lock so a sealed instance never evicts members).
      3. **``locked``** — the single "Server gesperrt" not-aus toggle. If on,
         403 ``join_locked`` — non-differentiating, BEFORE any grant path, so it
         overrides BOTH community-invite grants AND public-community handles
         (Entscheidung 7). There is no per-community escape hatch above the lock.
      4. **grant paths** (only reached when not locked):
         - ``public_join_handle`` — a currently-public community (Stufe 4 /
           Entscheidung 5). The community's own permission. Non-consuming.
         - ``community_grant_code`` — a live ``GuildInvite`` (Stufe 2 / B-lite).
           Non-consuming (the use is spent later in ``accept_invite``).
         No grant → 403 ``join_not_permitted``.
    """
    # 1. Owner: always in; record membership on first sight.
    if is_owner_admin:
        await add_member(session, identifier, joined_via="owner")
        await session.commit()
        return

    # 2. Existing member: always in, never asked again (re-auth path). Checked
    #    before the lock so a sealed instance never locks out current members.
    if await is_member(session, identifier):
        return

    # 3. "Server gesperrt" not-aus toggle. Checked BEFORE every grant path so it
    #    overrides BOTH the public-community handle AND the community-invite
    #    grant — a sealed instance admits no new member regardless of how they
    #    arrived (Entscheidung 7 / Stufe 5). Non-differentiating 403.
    if await is_instance_locked(session):
        raise HTTPException(status_code=403, detail="join_locked")

    # 4. Per-community grant paths (only reached when the instance is not locked).
    #    Public-community grant (Stufe 4 / Entscheidung 5): a public community is
    #    its OWN permission to join the instance. Non-consuming, no code.
    if await public_community_grants_access(session, public_join_handle or ""):
        await add_member(session, identifier, joined_via="public_community")
        await session.commit()
        return

    #    Community-invite grant (Stufe 2 / B-lite): a live community invite is
    #    itself the permission to join the instance (community-scoped,
    #    non-consuming — the use is spent later in ``accept_invite``).
    if await community_invite_grants_access(session, community_grant_code or ""):
        await add_member(session, identifier, joined_via="community_invite")
        await session.commit()
        return

    # No grant → deny.
    raise HTTPException(status_code=403, detail="join_not_permitted")


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
    redis = _require_redis(request)

    # 1. Re-validate the cert (signature/CRL/exp/iat — same path as /challenge).
    cert_claims = await validate_cert(body.cert, redis)
    if cert_claims is None:
        raise HTTPException(status_code=401, detail="cert_invalid")

    # 2. Verify the HMAC challenge-token + ttl.
    challenge_claims = _decode_challenge_token(body.challenge_token)

    # 3. Replay-guard: challenge was bound to this cert_id.
    if str(challenge_claims.get("cert_id", "")) != cert_claims.cert_id:
        raise HTTPException(status_code=401, detail="cert_mismatch")

    # 4. Verify Ed25519 signature over the RAW nonce bytes using the
    #    device pubkey stored in the cert.
    try:
        nonce_raw = _b64url_decode(challenge_claims["nonce"])
        signature = _b64url_decode(body.signature)
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
    is_owner_admin = (
        settings.pulse_instance_mode == "self-host"
        and bool(settings.pulse_instance_owner_id)
        and _safe_int_eq(cert_claims.user_id, settings.pulse_instance_owner_id)
    )

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

    # 5d. Join gate (Self-Host only). Cloud mode has no gated cert-join — the
    #     Cloud is the identity provider, every cert-holder is implicitly a
    #     "member", so we skip the gate entirely (and never touch instance_members
    #     in cloud mode). The order matters: owner first, then existing members
    #     (the critical re-auth path — a member must NEVER be asked for an invite
    #     again), then the "Server gesperrt" lock, then the per-community grants.
    if settings.pulse_instance_mode == "self-host":
        await _enforce_join_gate(
            session,
            identifier,
            is_owner_admin,
            body.community_grant_code,
            body.public_join_handle,
        )

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
