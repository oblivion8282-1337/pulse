"""HTTP routes for the auth service."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models import AuthSettings, RefreshToken, User
from dcc_auth.schemas import (
    LoginIn,
    MessageOut,
    RefreshIn,
    RegisterIn,
    TokensOut,
    UserPublic,
    UserSummary,
)
from dcc_auth.security import (
    JwtSigner,
    get_signer,
    hash_password,
    verify_password,
)
from dcc_auth.snowflake import next_id

router = APIRouter()

limiter = Limiter(key_func=get_remote_address, default_limits=[])


def _signer_dep() -> JwtSigner:
    return get_signer()


async def _issue_tokens(
    session,
    user: User,
    *,
    signer: JwtSigner,
    user_agent: str | None,
) -> TokensOut:
    settings = get_settings()
    access = signer.issue_access(user.id, user.username, is_admin=user.is_admin)
    refresh, jti, exp_ts = signer.issue_refresh(user.id)
    rt = RefreshToken(
        jti=jti,
        user_id=user.id,
        expires_at=datetime.fromtimestamp(exp_ts, tz=UTC),
        user_agent=(user_agent or None),
    )
    session.add(rt)
    await session.flush()
    _ = settings  # silence unused
    return TokensOut(access_token=access, refresh_token=refresh)


async def _get_current_user(
    session: SessionDep,
    authorization: str | None = Header(default=None),
    signer: JwtSigner = Depends(_signer_dep),
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = signer.decode(token, expected_type="access")
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid token") from exc
    try:
        user_id = int(payload["sub"])
    except (KeyError, ValueError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid token payload") from exc
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="user not found")
    return user


@router.post("/register", response_model=TokensOut, status_code=status.HTTP_201_CREATED)
async def register(
    payload: RegisterIn,
    request: Request,
    session: SessionDep,
    signer: JwtSigner = Depends(_signer_dep),
    user_agent: str | None = Header(default=None, alias="User-Agent"),
):
    settings = get_settings()
    # Rate limit (per-IP) — applied via decorator-less manual call to avoid
    # forcing slowapi state into every test.
    await _check_rate(request, "register", settings.rate_limit_register)

    # Registration gate set by the server admin. ``invite_only`` rejects too
    # for now — there's no invite-issuing flow yet, the column exists so the
    # UI can advertise the state and a future iteration can wire codes in.
    row = await session.get(AuthSettings, 1)
    mode = row.registration_mode if row else "open"
    if mode != "open":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail=f"registration is {mode}")

    # Argon2 is CPU-bound (~50-150ms at t=3/m=64MiB/p=4); run it off the event
    # loop so it doesn't block other requests on this worker.
    password_hash = await asyncio.to_thread(hash_password, payload.password)
    user = User(
        id=next_id(),
        username=payload.username,
        email=payload.email.lower(),
        password_hash=password_hash,
        display_name=payload.display_name,
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="username or email already taken"
        ) from exc

    tokens = await _issue_tokens(session, user, signer=signer, user_agent=user_agent)
    await session.commit()
    return tokens


@router.post("/login", response_model=TokensOut)
async def login(
    payload: LoginIn,
    request: Request,
    session: SessionDep,
    signer: JwtSigner = Depends(_signer_dep),
    user_agent: str | None = Header(default=None, alias="User-Agent"),
):
    settings = get_settings()
    await _check_rate(request, "login", settings.rate_limit_login)

    needle = payload.email_or_username.strip()
    stmt = select(User).where(or_(User.email == needle.lower(), User.username == needle))
    user = (await session.execute(stmt)).scalar_one_or_none()
    # Run argon2 verification off the event loop (same reasoning as register).
    pw_ok = (
        await asyncio.to_thread(verify_password, payload.password, user.password_hash)
        if user is not None
        else False
    )
    if user is None or not pw_ok:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
    if user.disabled:
        # Same status code as bad-creds: don't leak whether the account exists.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="account disabled")

    tokens = await _issue_tokens(session, user, signer=signer, user_agent=user_agent)
    await session.commit()
    return tokens


@router.post("/refresh", response_model=TokensOut)
async def refresh(
    payload: RefreshIn,
    session: SessionDep,
    signer: JwtSigner = Depends(_signer_dep),
    user_agent: str | None = Header(default=None, alias="User-Agent"),
):
    try:
        decoded = signer.decode(payload.refresh_token, expected_type="refresh")
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid token") from exc

    try:
        jti = uuid.UUID(decoded["jti"])
        user_id = int(decoded["sub"])
    except (KeyError, ValueError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid token payload") from exc

    # Lock the row so two concurrent refreshes with the same token can't both
    # pass the checks and fork the token tree. On Postgres this is a real row
    # lock; on the SQLite test backend it's a no-op (single-writer anyway).
    rt = await session.get(RefreshToken, jti, with_for_update=True)
    if rt is None or rt.user_id != user_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="refresh token not active")
    now = datetime.now(tz=UTC)
    if rt.revoked_at is not None:
        # Reuse of an already-rotated token. Either the legitimate user's token
        # was stolen and replayed, or vice versa — we can't tell, so revoke the
        # whole family (all of the user's still-active refresh tokens). This is
        # the standard OAuth refresh-token-reuse mitigation.
        await session.execute(
            update(RefreshToken)
            .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        await session.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="refresh token not active")
    # SQLite returns naive datetimes; coerce to UTC for the comparison.
    expires_at = rt.expires_at if rt.expires_at.tzinfo is not None else rt.expires_at.replace(tzinfo=UTC)
    if expires_at <= now:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="refresh token expired")

    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="user not found")
    if user.disabled:
        # Disabled accounts can't extend their session — also revoke this rt so
        # repeated attempts don't repeatedly hit the password verification path.
        rt.revoked_at = now
        await session.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="account disabled")

    # Rotate: revoke old, issue new — only now that the row is locked.
    rt.revoked_at = now
    tokens = await _issue_tokens(session, user, signer=signer, user_agent=user_agent)
    await session.commit()
    return tokens


@router.post("/logout", response_model=MessageOut)
async def logout(
    payload: RefreshIn,
    session: SessionDep,
    signer: JwtSigner = Depends(_signer_dep),
):
    try:
        decoded = signer.decode(payload.refresh_token, expected_type="refresh")
    except jwt.PyJWTError:
        return MessageOut(detail="ok")  # idempotent

    try:
        jti = uuid.UUID(decoded["jti"])
    except (KeyError, ValueError):
        return MessageOut(detail="ok")

    rt = await session.get(RefreshToken, jti)
    if rt is not None and rt.revoked_at is None:
        rt.revoked_at = datetime.now(tz=UTC)
        await session.commit()
    return MessageOut(detail="ok")


@router.get("/me", response_model=UserPublic)
async def me(current: User = Depends(_get_current_user)):
    return current


async def _require_admin(current: User = Depends(_get_current_user)) -> User:
    """Same as ``_get_current_user`` but 403s non-admins.

    Used to gate admin-only routes both inside auth-svc and (mirrored)
    in chat-gateway. Re-checks the DB column rather than trusting the JWT
    claim alone — the token might be from before the admin flag was set
    or revoked, and we'd rather pay one row-lookup than honour stale state.
    """
    if not current.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="admin only")
    return current


@router.get("/.well-known/jwks.json")
async def jwks(signer: JwtSigner = Depends(_signer_dep)) -> dict:
    return signer.jwks()


@router.get("/users", response_model=list[UserSummary])
async def batch_users(
    ids: str,
    session: SessionDep,
    current: User = Depends(_get_current_user),
):
    """Batch-lookup users by Snowflake IDs (comma-separated, max 100).

    Returns only id/username/display_name/avatar_url — no email exposed.
    Unknown IDs are silently omitted.
    """
    raw_ids = [s.strip() for s in ids.split(",") if s.strip()]
    if len(raw_ids) > 100:
        raise HTTPException(400, detail="too many ids (max 100)")
    int_ids: list[int] = []
    for s in raw_ids:
        try:
            int_ids.append(int(s))
        except ValueError:
            pass  # skip non-numeric ids silently
    if not int_ids:
        return []
    stmt = select(User).where(User.id.in_(int_ids))
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


# ---- internal helpers ---------------------------------------------------


def _client_ip(request: Request) -> str:
    """Best-effort client IP.

    Behind a reverse proxy (Caddy in our deployment) ``request.client.host`` is
    the proxy's address, so we prefer the first hop in ``X-Forwarded-For``.
    But the header is client-controlled — if the request comes from an
    *untrusted* peer we ignore XFF entirely; otherwise anyone could spoof their
    bucket by sending ``X-Forwarded-For: 1.2.3.4``.

    The trust list comes from ``Settings.trusted_proxies`` (CSV of IPs / CIDRs).
    """
    peer = get_remote_address(request)
    if _peer_is_trusted(peer):
        xff = request.headers.get("x-forwarded-for")
        if xff:
            first = xff.split(",")[0].strip()
            if first:
                return first
    return peer


_trusted_networks_cache: tuple[str, list] | None = None


def _peer_is_trusted(peer: str) -> bool:
    """Whether ``peer`` matches any entry in ``Settings.trusted_proxies``."""
    import ipaddress

    global _trusted_networks_cache
    settings = get_settings()
    raw = settings.trusted_proxies or ""
    if _trusted_networks_cache is None or _trusted_networks_cache[0] != raw:
        nets: list[ipaddress._BaseNetwork] = []
        for entry in (e.strip() for e in raw.split(",") if e.strip()):
            try:
                # Accept both single IPs ("127.0.0.1") and CIDRs ("10.0.0.0/8").
                nets.append(ipaddress.ip_network(entry, strict=False))
            except ValueError:
                continue
        _trusted_networks_cache = (raw, nets)
    try:
        addr = ipaddress.ip_address(peer)
    except ValueError:
        return False
    return any(addr in n for n in _trusted_networks_cache[1])


async def _check_rate(request: Request, key: str, rule: str) -> None:
    """Lightweight slowapi-style rate-limit using a process-local counter.

    `slowapi` is a fine library, but its Starlette middleware ties tightly
    to the global limiter state and makes test isolation awkward. We keep
    an in-process token bucket here keyed on (client, key). Production
    deployments should swap to a Redis-backed limiter.

    Buckets are evicted lazily once their window has elapsed, so memory stays
    bounded by the number of currently-active client IPs.
    """
    from time import monotonic

    # Parse "N/period" — period in {second, minute, hour}.
    n_str, period = rule.split("/")
    n = int(n_str)
    seconds = {"second": 1, "minute": 60, "hour": 3600}[period.rstrip("s")]

    bucket = request.app.state.rate_buckets.setdefault(key, {})
    ip = _client_ip(request)
    now = monotonic()

    # Lazy sweep: drop entries whose window has fully elapsed.
    expired = [k for k, w in bucket.items() if now - w["start"] >= seconds]
    for k in expired:
        del bucket[k]

    window = bucket.get(ip)
    if window is None or now - window["start"] >= seconds:
        bucket[ip] = {"start": now, "count": 1}
        return
    if window["count"] >= n:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"rate limit exceeded ({rule})",
        )
    window["count"] += 1


# Re-export rate limiter accessor used by tests to flush state.
def _reset_rate(app) -> None:
    app.state.rate_buckets = {}


# Dependency export for chat-gateway tests that import this module.
get_current_user = _get_current_user
