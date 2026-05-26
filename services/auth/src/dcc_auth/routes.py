"""HTTP routes for the auth service."""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from datetime import UTC, datetime

import jwt
import structlog
from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError

from dcc_auth.browser_sessions import (
    clear_session_cookie,
    create_session,
    set_session_cookie,
)
from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.email import issue_verification_email, resolve_smtp_config
from dcc_auth.models import AuthSettings, RefreshToken, User, UserSession, WebAuthnCredential
from dcc_auth.schemas import (
    LoginIn,
    LoginMfaPending,
    LogoutIn,
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
    needs_rehash,
    verify_password,
)
from dcc_auth.snowflake import next_id
from dcc_auth.username_suggestions import suggest_usernames as _suggest_usernames

router = APIRouter()
log = structlog.get_logger(__name__)

limiter = Limiter(key_func=get_remote_address, default_limits=[])


def _signer_dep() -> JwtSigner:
    return get_signer()


async def _email_gate_blocked(session, user: User) -> bool:
    """True when the email-verification gate currently blocks this account.

    The gate is active only when SMTP can actually deliver mail — on a fresh
    self-host without SMTP configured it stays off, so the bootstrap admin can
    never lock themselves out. Once an admin saves an SMTP config, every
    still-unverified account flips to blocked. Verified accounts are never
    blocked regardless of SMTP state.
    """
    if user.email_verified_at is not None:
        return False
    return (await resolve_smtp_config(session)) is not None


async def _issue_tokens(
    session,
    user: User,
    *,
    signer: JwtSigner,
    user_agent: str | None,
    ip_hash: str | None = None,
) -> TokensOut:
    settings = get_settings()
    blocked = await _email_gate_blocked(session, user)
    access = signer.issue_access(
        user.id, user.username, is_admin=user.is_admin, email_blocked=blocked
    )
    refresh, jti, exp_ts = signer.issue_refresh(user.id)
    # ``last_used_at`` starts at issue time so the sessions list can sort
    # consistently by liveness; ``/refresh`` keeps it fresh on every rotation.
    now = datetime.now(tz=UTC)
    rt = RefreshToken(
        jti=jti,
        user_id=user.id,
        expires_at=datetime.fromtimestamp(exp_ts, tz=UTC),
        user_agent=(user_agent[:1000] if user_agent else None),
        ip_hash=ip_hash,
        last_used_at=now,
    )
    session.add(rt)
    await session.flush()
    _ = settings  # silence unused
    return TokensOut(access_token=access, refresh_token=refresh)


def _hash_ip(request: Request) -> str:
    """SHA-256 hex of the effective client IP (XFF-aware, see ``_client_ip``).

    The raw IP is never persisted — only this hash. Comparing the hash with
    the current request's hash on subsequent calls lets the ``/sessions``
    list flag a session as "the one you're using right now" without ever
    exposing the address itself.
    """
    return hashlib.sha256(_client_ip(request).encode("utf-8")).hexdigest()


async def _get_current_user(
    request: Request,
    session: SessionDep,
    authorization: str | None = Header(default=None),
    signer: JwtSigner = Depends(_signer_dep),
) -> User:
    """Authenticate via Bearer token OR browser-session cookie.

    JWT Bearer takes precedence; if absent, the ``pulse_session`` cookie is
    tried.  Both paths are cloud-internal.
    """
    # --- JWT path ---
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
        try:
            payload = signer.decode(token, expected_type="access")
        except jwt.PyJWTError as exc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid token") from exc
        try:
            user_id = int(payload["sub"])
        except (KeyError, ValueError) as exc:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, detail="invalid token payload"
            ) from exc
        user = await session.get(User, user_id)
        if user is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="user not found")
        if user.disabled:
            # Existing access tokens of disabled users remain technically valid
            # (no global revocation), but every protected route must reject them
            # — otherwise a disabled admin keeps full access until the ≤15 min TTL.
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="account disabled")
        return user

    # --- Cookie path ---
    from dcc_auth.browser_sessions import validate_session as _validate_session

    raw = request.cookies.get("pulse_session")
    if raw:
        try:
            sid = uuid.UUID(raw)
        except ValueError:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, detail="invalid session cookie"
            )
        row = await _validate_session(session, sid)
        if row is None:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, detail="session expired or not found"
            )
        user = await session.get(User, row.user_id)
        if user is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="user not found")
        if user.disabled or user.is_suspended:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="account disabled")
        return user

    raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")


@router.post("/register", response_model=TokensOut, status_code=status.HTTP_201_CREATED)
async def register(
    payload: RegisterIn,
    request: Request,
    response: Response,
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
        # Disambiguate: was the conflict the username, the email, or both?
        # We re-query so the 409 body can carry concrete suggestions when
        # the username is taken (the common case for popular handles).
        u_taken = await session.scalar(
            select(func.count()).select_from(User).where(User.username == payload.username)
        )
        e_taken = await session.scalar(
            select(func.count()).select_from(User).where(User.email == payload.email.lower())
        )
        if u_taken:
            suggestions = await _suggest_usernames(session, payload.username)
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={"error": "username_taken", "suggestions": suggestions},
            ) from exc
        if e_taken:
            raise HTTPException(
                status.HTTP_409_CONFLICT, detail={"error": "email_taken"}
            ) from exc
        # Shouldn't happen — another unique constraint we don't know about.
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="conflict"
        ) from exc

    # Bootstrap: the first user on a fresh deploy becomes a global admin
    # so the server operator has a path into ``/app/admin`` without
    # needing to SQL-promote themselves. Counts include the row we just
    # flushed; ==1 means we are the only user in the database.
    # Race-mode (two concurrent registrations both seeing count==1) is
    # accepted — same trade-off Mastodon / Gitea / Forgejo make. On a
    # public-facing first-deploy the operator registers in the same
    # second as the docker stack comes up, so this is fine in practice.
    user_count = await session.scalar(select(func.count()).select_from(User))
    if user_count == 1:
        user.is_admin = True

    tokens = await _issue_tokens(
        session, user, signer=signer, user_agent=user_agent, ip_hash=_hash_ip(request)
    )

    # Browser-Session-Cookie analog zum Login. Register schließt den Sign-In
    # in einem Schritt ab — Client erwartet ab hier den Session-Cookie, weil
    # die Cert-Issue + Profile-Endpoints (browser_sessions.get_current_user_
    # from_cookie) ausschließlich Cookie-authentifiziert sind.
    sid = await create_session(
        session,
        user_id=user.id,
        amr=["pwd"],
        acr="0",
        user_agent=user_agent,
        ip=_client_ip(request),
    )

    # Auto-fire the verify-email so the new user finds a fresh link in their
    # inbox right after the redirect to /app. Wrapped in try/except: a flaky
    # mail relay must NOT abort registration — the token row is committed
    # alongside the user either way, and the in-app banner has a manual resend.
    try:
        await issue_verification_email(session, user)
    except Exception as exc:  # noqa: BLE001
        log.warning("register_verify_email_failed", user_id=user.id, error=str(exc))

    await session.commit()
    set_session_cookie(response, sid)
    return tokens


@router.post("/login", response_model=TokensOut | LoginMfaPending)
async def login(
    payload: LoginIn,
    request: Request,
    response: Response,
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
    if user is None or not pw_ok or user.disabled:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")

    # Transparent rehash when Argon2 parameters have been bumped since this
    # hash was written. We still have the plaintext password right here, so
    # this is the one moment we can upgrade without forcing a reset.
    if needs_rehash(user.password_hash):
        user.password_hash = await asyncio.to_thread(hash_password, payload.password)

    # 2FA branch: short-circuit BEFORE issuing tokens. An account is MFA-gated
    # if it has TOTP enabled and/or at least one registered passkey. The
    # frontend completes step 2 via ``/login/totp`` or ``/login/webauthn/*``
    # depending on which methods are advertised. ``issue_mfa_ticket`` is
    # imported lazily to avoid a routes.py ↔ recovery.py circular import.
    methods: list[str] = []
    if user.totp_enabled:
        methods.append("totp")
    passkey_count = await session.scalar(
        select(func.count())
        .select_from(WebAuthnCredential)
        .where(WebAuthnCredential.user_id == user.id)
    )
    if passkey_count:
        methods.append("webauthn")
    if methods:
        from dcc_auth.recovery import issue_mfa_ticket

        # Commit the rehash above (if any) so it isn't lost when the user
        # bails between steps; tokens are issued only on step 2.
        await session.commit()
        ticket = issue_mfa_ticket(signer, user.id, settings.mfa_ticket_ttl_seconds)
        return LoginMfaPending(mfa_ticket=ticket, methods=methods)

    tokens = await _issue_tokens(
        session, user, signer=signer, user_agent=user_agent, ip_hash=_hash_ip(request)
    )
    # Session cookie: amr=["pwd"] + acr="0" (password-only, no MFA at this step).
    sid = await create_session(
        session,
        user_id=user.id,
        amr=["pwd"],
        acr="0",
        user_agent=user_agent,
        ip=_client_ip(request),
    )
    await session.commit()
    set_session_cookie(response, sid)
    return tokens


@router.post("/refresh", response_model=TokensOut)
async def refresh(
    payload: RefreshIn,
    request: Request,
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

    # Rotate: revoke old, issue new — only now that the row is locked. The
    # rotated-out row keeps its original ``last_used_at`` (audit trail); the
    # newly-issued row gets a fresh stamp inside ``_issue_tokens``.
    rt.revoked_at = now
    tokens = await _issue_tokens(
        session, user, signer=signer, user_agent=user_agent, ip_hash=_hash_ip(request)
    )
    await session.commit()
    return tokens


@router.post("/logout", response_model=MessageOut)
async def logout(
    request: Request,
    response: Response,
    payload: LogoutIn,
    session: SessionDep,
    signer: JwtSigner = Depends(_signer_dep),
):
    # --- Revoke refresh token (JWT path, optional) ---
    decoded = None
    if payload.refresh_token:
        try:
            decoded = signer.decode(payload.refresh_token, expected_type="refresh")
        except jwt.PyJWTError:
            decoded = None

    committed = False
    if decoded is not None:
        try:
            jti = uuid.UUID(decoded["jti"])
            user_id = int(decoded["sub"])
        except (KeyError, ValueError):
            jti = None
            user_id = None
        if jti is not None:
            rt = await session.get(RefreshToken, jti)
            if rt is not None and rt.user_id == user_id and rt.revoked_at is None:
                rt.revoked_at = datetime.now(tz=UTC)
                committed = True

    # --- Revoke browser session cookie (if present) ---
    raw_cookie = request.cookies.get("pulse_session")
    if raw_cookie:
        try:
            sid = uuid.UUID(raw_cookie)
            row = await session.get(UserSession, str(sid))
            if row is not None:
                row.expires_at = datetime.now(tz=UTC)
                committed = True
        except (ValueError, Exception):  # noqa: BLE001
            pass

    if committed:
        await session.commit()

    clear_session_cookie(response)
    return MessageOut(detail="ok")


@router.get("/me", response_model=UserPublic)
async def me(session: SessionDep, current: User = Depends(_get_current_user)):
    out = UserPublic.model_validate(current)
    # Computed (not a column): drives the frontend's hard verification gate.
    out.email_verification_pending = await _email_gate_blocked(session, current)
    return out


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
