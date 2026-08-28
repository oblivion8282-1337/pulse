"""Token & backup-code helpers for the account-recovery / 2FA flows.

Three concerns live here so ``security.py`` (RSA / Argon2) stays focused:

* opaque single-use tokens (password-reset, email-verify) — random 32-byte
  URL-safe strings; only the SHA-256 hex lives in DB.
* MFA tickets — short-lived JWTs that bridge the two steps of password-
  + TOTP login (signed by the existing ``JwtSigner`` with ``purpose=mfa``).
* TOTP backup codes — 8 uppercase hex chars, also stored as SHA-256.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import time
from typing import Any

import jwt

from dcc_auth.security import JwtSigner

log = logging.getLogger(__name__)

# Plaintext byte length passed to ``secrets.token_urlsafe`` — at 32 bytes the
# encoded string is 43 chars, well above any practical brute-force budget for
# the 1h/24h TTL windows the issuing endpoints use.
_TOKEN_BYTES = 32


def generate_token() -> tuple[str, str]:
    """Return ``(plaintext, sha256hex)``.

    Only the hex digest is meant to be persisted; the plaintext is what gets
    embedded in the email link / setup response.
    """
    plaintext = secrets.token_urlsafe(_TOKEN_BYTES)
    return plaintext, hash_token(plaintext)


def hash_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def verify_token(plaintext: str, db_hash: str) -> bool:
    """Constant-time compare ``sha256(plaintext) == db_hash``.

    Plain string ``==`` is exploitable with a high-resolution timing oracle
    when the candidate hash is attacker-controlled; ``hmac.compare_digest`` is
    the standard library's constant-time equality.
    """
    return hmac.compare_digest(hash_token(plaintext), db_hash)


def generate_backup_codes(n: int = 10) -> list[str]:
    """``n`` × 8-char uppercase-hex backup codes.

    Caller is responsible for hashing (via ``hash_token``) before persisting —
    we hand back plaintext so the route can return it to the user exactly
    once.
    """
    return [secrets.token_hex(4).upper() for _ in range(n)]


# ---- MFA ticket (JWT) ---------------------------------------------------


def issue_mfa_ticket(signer: JwtSigner, user_id: int, ttl_seconds: int) -> str:
    """Mint the short-lived JWT returned by ``POST /login`` when 2FA is on.

    Reuses the existing RS256 signer so the verification path needs no new
    keys. ``purpose='mfa'`` is checked on the second step — a regular access
    token MUST NOT be accepted there. ``jti`` is a random single-use id: the
    second-step handler claims it in Redis (``claim_mfa_ticket``) so a ticket
    that has already minted one token pair cannot be replayed within its TTL.
    """
    now = int(time.time())
    payload: dict[str, Any] = {
        # Stamp ``iss`` / ``aud`` so ``decode_mfa_ticket`` can validate them.
        # A ticket signed by this private key but minted for a different
        # environment (e.g. a staging instance sharing the keypair) must not
        # verify here — the ``purpose`` claim alone is too weak a guard.
        "iss": signer._settings.jwt_issuer,  # noqa: SLF001 — mirrors issue_access
        "aud": signer._settings.jwt_audience,  # noqa: SLF001
        "sub": str(user_id),
        "iat": now,
        "exp": now + ttl_seconds,
        "purpose": "mfa",
        "jti": secrets.token_hex(16),
    }
    # Hit the private key directly to skip the iss/aud claims (decode below
    # mirrors that — we deliberately don't go through ``issue_access``).
    return jwt.encode(
        payload,
        signer._private_key,  # noqa: SLF001 — keys live there, no public accessor
        algorithm="RS256",
        headers={"kid": signer._settings.jwt_key_id},  # noqa: SLF001
    )


def decode_mfa_ticket(signer: JwtSigner, ticket: str) -> tuple[int, str | None]:
    """Return ``(user_id, jti)`` carried by a valid MFA ticket.

    ``jti`` is ``None`` only for legacy tickets minted before single-use
    enforcement existed (in-flight during a deploy) — callers treat a missing
    ``jti`` as "cannot enforce single use" rather than failing the login.

    Raises ``jwt.PyJWTError`` on any failure (expired, bad signature, wrong
    purpose, missing ``sub``).
    """
    payload = jwt.decode(
        ticket,
        signer.public_key,
        algorithms=["RS256"],
        audience=signer._settings.jwt_audience,  # noqa: SLF001 — mirrors JwtSigner.decode
        issuer=signer._settings.jwt_issuer,  # noqa: SLF001
        options={"require": ["exp", "sub"]},
    )
    if payload.get("purpose") != "mfa":
        raise jwt.InvalidTokenError("not an mfa ticket")
    jti = payload.get("jti")
    return int(payload["sub"]), (str(jti) if jti else None)


async def claim_ticket_jti(
    redis_url: str | None, key_prefix: str, jti: str | None, ttl_seconds: int
) -> bool:
    """Atomically mark a single-use ticket ``jti`` as used; ``True`` if newly claimed.

    Returns ``False`` only when the ``jti`` was *already* claimed under
    ``{key_prefix}{jti}`` — i.e. this is a replay of a ticket that already did its
    job. The caller must reject the request in that case.

    Called only after the ceremony has otherwise verified, so a failed attempt
    never burns the ticket. Uses ``SET NX EX`` (atomic) so two parallel replays of
    the same ticket can never both win.

    Fail-open by design: this service treats Redis as optional (unit tests run
    SQLite-only), and a missing ``jti`` (legacy ticket) or an
    unreachable Redis must not lock users out. Production always has Redis, so the
    single-use guard is live where it matters.
    """
    if not jti or not redis_url:
        return True
    try:
        from redis.asyncio import Redis

        async with Redis.from_url(redis_url, decode_responses=True) as r:
            # NX → only the first claimant gets True; EX bounds the marker to the
            # ticket's own lifetime (no point keeping it past expiry).
            claimed = await r.set(f"{key_prefix}{jti}", "1", nx=True, ex=ttl_seconds)
            return bool(claimed)
    except Exception:  # noqa: BLE001 — Redis down must not break login (fail-open)
        log.warning("ticket single-use claim failed (Redis); allowing", exc_info=True)
        return True


async def claim_mfa_ticket(redis_url: str | None, jti: str | None, ttl_seconds: int) -> bool:
    """Atomically mark an MFA ticket's ``jti`` as used; ``True`` if newly claimed.

    Thin wrapper over ``claim_ticket_jti`` pinned to the ``mfa:used:`` key space —
    kept as a named entry point for the 2FA login paths.
    """
    return await claim_ticket_jti(redis_url, "mfa:used:", jti, ttl_seconds)
