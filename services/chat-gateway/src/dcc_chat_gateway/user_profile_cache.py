"""Profile-Statement-Push cache for Self-Host mode (Phase 3.2 / DE 11 A.2).

Client-pushed, Cloud-signed profile statements are validated here and
upserted into :class:`~dcc_chat_gateway.models.moderation.CachedUserProfile`.

Two custom exceptions signal validation failures upstream:

* :exc:`ProfileStatementInvalid` — bad signature, expired token, missing
  claims, or wrong ``purpose`` value.  WS callers should close with 4047.
* :exc:`ProfileStatementReplay` — the statement's ``iat`` is not strictly
  newer than the last accepted statement for this user identifier.  WS
  callers should silently ignore (the cached profile is already fresh or
  fresher).
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Literal

import jwt
from dcc_shared.session_tokens import synthesize_self_host_user_id
from jwt.algorithms import RSAAlgorithm
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.credential_validator import compute_pairwise_sub
from dcc_chat_gateway.models.moderation import CachedUserProfile

log = logging.getLogger(__name__)

# ─── Custom exceptions ────────────────────────────────────────────────────────


class ProfileStatementInvalid(Exception):
    """Raised when the profile statement JWT cannot be verified or is malformed."""


class ProfileStatementReplay(Exception):
    """Raised when the incoming ``iat`` is not strictly newer than the stored one."""


# ─── JWKS helpers ─────────────────────────────────────────────────────────────


def _keys_from_jwks(jwks: dict[str, Any]) -> dict[str, Any]:
    """Build a ``kid → RSAPublicKey`` mapping from a JWKS dict."""
    keys: dict[str, Any] = {}
    for key_dict in jwks.get("keys", []):
        kid = key_dict.get("kid")
        if not kid:
            continue
        try:
            keys[kid] = RSAAlgorithm.from_jwk(json.dumps(key_dict))
        except Exception:  # noqa: BLE001
            continue
    return keys


# ─── Core upsert function ─────────────────────────────────────────────────────


async def upsert_profile_statement(
    session: AsyncSession,
    statement_jwt: str,
    *,
    cloud_jwks: dict[str, Any],
    instance_mode: Literal["cloud", "self-host"],
    instance_id: str | None = None,
    pairwise_seed: bytes | None = None,
) -> CachedUserProfile:
    """Validate a Cloud-signed profile statement and upsert the cached profile.

    Parameters
    ----------
    session:
        SQLAlchemy async session (caller owns the transaction boundary).
    statement_jwt:
        The raw JWT string sent by the client.
    cloud_jwks:
        JWKS dict (parsed, not a JSON string) containing the Cloud's RS256
        public keys.  Typically fetched from Redis by the caller.
    instance_mode:
        ``"cloud"`` → user_identifier = raw ``sub`` claim.
        ``"self-host"`` → user_identifier = pairwise sub.
    instance_id:
        Required when ``instance_mode == "self-host"``.
    pairwise_seed:
        Raw seed bytes used to compute the pairwise sub.
        Required when ``instance_mode == "self-host"``.

    Raises
    ------
    ProfileStatementInvalid
        Signature invalid, JWT expired, missing required claims, wrong purpose.
    ProfileStatementReplay
        The statement's ``iat`` is ≤ the last accepted ``iat`` for this
        user identifier (replay / out-of-order delivery).
    """
    # ── Step 1: decode header for kid lookup ──────────────────────────────────
    try:
        header = jwt.get_unverified_header(statement_jwt)
    except jwt.PyJWTError as exc:
        raise ProfileStatementInvalid("malformed JWT header") from exc

    kid = header.get("kid")
    if not kid:
        raise ProfileStatementInvalid("missing kid in JWT header")

    # ── Step 2: build key map and look up kid ─────────────────────────────────
    key_map = _keys_from_jwks(cloud_jwks)
    pub_key = key_map.get(kid)
    if pub_key is None:
        raise ProfileStatementInvalid(f"unknown kid: {kid!r}")

    # ── Step 3: verify signature + standard claims (RS256 only) ──────────────
    # ``verify_iat=False`` suppresses ImmatureSignatureError for tokens whose
    # iat is a few seconds in the future (clock skew between Cloud auth-svc and
    # this instance).  We still enforce exp ourselves (step 6).
    try:
        claims: dict[str, Any] = jwt.decode(
            statement_jwt,
            pub_key,
            algorithms=["RS256"],
            options={"verify_aud": False, "verify_iat": False},
        )
    except jwt.ExpiredSignatureError as exc:
        raise ProfileStatementInvalid("statement JWT has expired") from exc
    except jwt.PyJWTError as exc:
        raise ProfileStatementInvalid(f"JWT verification failed: {exc}") from exc

    # ── Step 4: purpose check ─────────────────────────────────────────────────
    if claims.get("purpose") != "profile-statement":
        raise ProfileStatementInvalid(
            f"wrong purpose claim: {claims.get('purpose')!r}"
        )

    # ── Step 5: extract required claims ──────────────────────────────────────
    sub = claims.get("sub") or claims.get("user_id")
    if not sub:
        raise ProfileStatementInvalid("missing sub claim")
    sub = str(sub)

    username = claims.get("username")
    display_name = claims.get("display_name")
    if not username or not display_name:
        raise ProfileStatementInvalid("missing username or display_name claim")

    raw_iat = claims.get("iat")
    if raw_iat is None:
        raise ProfileStatementInvalid("missing iat claim")

    # ── Step 6: manual exp check (belt-and-suspenders) ───────────────────────
    raw_exp = claims.get("exp")
    now = int(time.time())
    if raw_exp is not None and int(raw_exp) <= now:
        raise ProfileStatementInvalid("statement JWT has expired (manual check)")

    # ── Step 7: compute user_identifier ──────────────────────────────────────
    if instance_mode == "cloud":
        user_identifier = sub
    else:
        if instance_id is None:
            raise ProfileStatementInvalid("instance_id is required in self-host mode")
        import base64

        # pairwise_seed: prefer the caller-supplied raw bytes; otherwise fall
        # back to the Cloud-embedded ``pairwise_seed`` claim (base64url) so the
        # WS handler doesn't have to carry it — the sign-in that would have
        # exposed it is already consumed by the time a statement arrives.
        if pairwise_seed is not None:
            seed_b64 = base64.urlsafe_b64encode(pairwise_seed).rstrip(b"=").decode()
        else:
            seed_b64 = str(claims.get("pairwise_seed") or "")
        if not seed_b64:
            raise ProfileStatementInvalid(
                "pairwise_seed required in self-host mode (param or statement claim)"
            )
        user_identifier = compute_pairwise_sub(sub, int(instance_id), seed_b64)

    # Numeric id used by the rest of the chat schema (GuildMember.user_id,
    # messages.author_id) + the LiveKit voice identity. Cloud: raw numeric user
    # id; Self-Host: deterministic synth from the pairwise-sub. Lets the /users
    # name-resolution endpoint map a numeric id back to this profile (F19).
    # Cloud subs are numeric in practice — guard against non-numeric (the chat
    # /users endpoint is unused in cloud mode anyway, so NULL there is harmless).
    synthetic_user_id: int | None
    if instance_mode == "cloud":
        synthetic_user_id = int(user_identifier) if user_identifier.isdigit() else None
    else:
        synthetic_user_id = synthesize_self_host_user_id(user_identifier)

    # ── Step 8: load existing profile for replay check ────────────────────────
    new_iat_dt = datetime.fromtimestamp(int(raw_iat), tz=timezone.utc)

    existing: CachedUserProfile | None = await session.get(
        CachedUserProfile, user_identifier
    )
    if existing is not None:
        # SQLite returns naive datetimes; Postgres returns aware.  Normalise
        # both to UTC timestamps (seconds) for a safe comparison.
        stored_ts = existing.last_statement_iat
        if stored_ts.tzinfo is None:
            stored_ts = stored_ts.replace(tzinfo=timezone.utc)
        if new_iat_dt <= stored_ts:
            raise ProfileStatementReplay(
                f"replay: new iat={new_iat_dt} <= stored iat={stored_ts}"
            )

    # ── Step 9: upsert ────────────────────────────────────────────────────────
    avatar_hash: str | None = claims.get("avatar_hash")
    profile_color: str | None = claims.get("profile_color")
    profile_color_secondary: str | None = claims.get("profile_color_secondary")
    profile_gradient_angle: int | None = claims.get("profile_gradient_angle")

    if existing is not None:
        existing.username = username
        existing.display_name = display_name
        existing.avatar_hash = avatar_hash
        existing.profile_color = profile_color
        existing.profile_color_secondary = profile_color_secondary
        existing.profile_gradient_angle = profile_gradient_angle
        existing.last_statement_iat = new_iat_dt
        existing.updated_at = datetime.now(tz=timezone.utc)
        existing.stale = False
        existing.synthetic_user_id = synthetic_user_id
        session.add(existing)
        return existing

    profile = CachedUserProfile(
        user_identifier=user_identifier,
        username=username,
        display_name=display_name,
        avatar_hash=avatar_hash,
        profile_color=profile_color,
        profile_color_secondary=profile_color_secondary,
        profile_gradient_angle=profile_gradient_angle,
        last_statement_iat=new_iat_dt,
        updated_at=datetime.now(tz=timezone.utc),
        stale=False,
        synthetic_user_id=synthetic_user_id,
    )
    session.add(profile)
    return profile


# ─── Stale-marking helper ─────────────────────────────────────────────────────


async def mark_stale_if_expired(
    session: AsyncSession,
    profile: CachedUserProfile,
    *,
    ttl_seconds: int = 86_400,
) -> bool:
    """Mark ``profile`` as stale when its last statement is older than ``ttl_seconds``.

    Returns ``True`` when the profile was marked stale (and the ORM object was
    updated in-place), ``False`` when the profile is still fresh.

    The caller must flush/commit after this function when ``True`` is returned.
    """
    # SQLite returns naive datetimes; Postgres returns aware. Normalise before
    # subtracting from an aware now() (gleiche Falle wie im Replay-Pfad oben) —
    # sonst wirft `aware - naive` auf einem SQLite-gelesenen Profil TypeError.
    stored_iat = profile.last_statement_iat
    if stored_iat.tzinfo is None:
        stored_iat = stored_iat.replace(tzinfo=timezone.utc)
    age = datetime.now(tz=timezone.utc) - stored_iat
    if age.total_seconds() > ttl_seconds:
        if not profile.stale:
            profile.stale = True
            session.add(profile)
        return True
    return False


__all__ = [
    "ProfileStatementInvalid",
    "ProfileStatementReplay",
    "mark_stale_if_expired",
    "upsert_profile_statement",
]
