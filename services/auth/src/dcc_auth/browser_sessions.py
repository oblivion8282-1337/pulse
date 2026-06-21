"""Browser-Session-Cookie helpers (DE 11 Phase 1).

Cloud-internal: HttpOnly + SameSite=strict + Secure, 30 min TTL,
last_seen_at refreshed on every validated request.

API summary
-----------
* ``create_session``         -- write new row, return session_id UUID
* ``validate_session``       -- lookup + expiry check + bump last_seen_at
* ``revoke_session``         -- soft-delete one session (sets expires_at = now)
* ``revoke_all_for_user``    -- bulk-revoke for Logout-Everywhere (DE 11 A.11)
* ``set_session_cookie``     -- attach HttpOnly Set-Cookie to a Response
* ``clear_session_cookie``   -- overwrite with Max-Age=0 to delete
* ``get_current_user_from_cookie`` -- FastAPI dependency: cookie -> User
* ``purge_expired_sessions`` -- one-shot async helper for the cleanup loop
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, Request, Response, status
from sqlalchemy import delete as sa_delete
from sqlalchemy import select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_auth.models import User, UserSession

# ---- constants -------------------------------------------------------

_COOKIE_NAME = "pulse_session"
_DEFAULT_TTL = 1800  # 30 minutes


# ---- DB helpers -------------------------------------------------------


async def create_session(
    db: AsyncSession,
    *,
    user_id: int,
    amr: list[str],
    acr: str,
    user_agent: str | None,
    ip: str | None,
    ttl: int = _DEFAULT_TTL,
) -> uuid.UUID:
    """Insert a new browser-session row and return its session_id UUID."""
    now = datetime.now(tz=UTC)
    sid = uuid.uuid4()
    # session_id uses .with_variant(TEXT, "sqlite") -- pass str so both
    # Postgres and aiosqlite backends bind without a type-processor mismatch.
    row = UserSession(
        session_id=str(sid),  # type: ignore[arg-type]
        user_id=user_id,
        created_at=now,
        last_seen_at=now,
        expires_at=now + timedelta(seconds=ttl),
        amr=amr,
        acr=acr,
        user_agent=(user_agent[:2000] if user_agent else None),
        ip=ip,
    )
    db.add(row)
    await db.flush()
    return sid


async def validate_session(
    db: AsyncSession,
    session_id: uuid.UUID,
    *,
    ttl: int = _DEFAULT_TTL,
) -> UserSession | None:
    """Return the UserSession row if valid, else None.

    Also slides ``last_seen_at`` and extends ``expires_at`` by the full
    TTL window (activity-based auto-refresh as specified in DE 11).

    The window bump is committed here so the sliding window is persisted even
    on read-only endpoints, which otherwise never call ``db.commit()`` and so
    silently discarded the extension on session-context exit. Write routes
    commit again later (harmless). This is the first DB op on the request, so
    committing here cannot prematurely persist unrelated mutations.
    """
    # SQLite stores as TEXT; Postgres stores as UUID. Pass str for compat.
    row = await db.get(UserSession, str(session_id))
    if row is None:
        return None
    now = datetime.now(tz=UTC)
    # Explicitly revoked (Logout-Everywhere / password-change / suspend) → dead,
    # regardless of the expiry clock.
    if row.revoked_at is not None:
        return None
    # Coerce naive datetimes from SQLite tests
    exp = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=UTC)
    if exp <= now:
        return None
    # Slide the window and persist it (read-only callers don't commit).
    # SessionLocal uses expire_on_commit=False, so ``row`` keeps the bumped
    # values in memory and remains usable for sync attribute reads afterwards.
    row.last_seen_at = now
    row.expires_at = now + timedelta(seconds=ttl)
    await db.commit()
    return row


async def revoke_session(db: AsyncSession, session_id: uuid.UUID) -> bool:
    """Soft-delete one session.  Returns True if row existed.

    Sets both ``expires_at`` (kills the sliding window) and ``revoked_at`` (marks
    it as an explicit security revocation, so ``/session/renew`` won't inherit
    its acr/amr — see ``routes._strongest_session_context``).
    """
    row = await db.get(UserSession, str(session_id))
    if row is None:
        return False
    now = datetime.now(tz=UTC)
    row.expires_at = now
    row.revoked_at = now
    return True


async def revoke_all_for_user(db: AsyncSession, user_id: int) -> int:
    """Revoke all of a user's sessions (Logout-Everywhere).

    Stamps both ``expires_at`` and ``revoked_at`` on every not-yet-revoked row,
    and raises the user-level ``revoke_until`` watermark so the
    ``/credentials/issue`` MFA-race gate (routes_credentials) actually fires.
    Returns the number of session rows touched.
    """
    now = datetime.now(tz=UTC)
    result = await db.execute(
        sa_update(UserSession)
        .where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
        .values(expires_at=now, revoked_at=now)
    )
    await db.execute(
        sa_update(User).where(User.id == user_id).values(revoke_until=now)
    )
    return result.rowcount or 0


async def purge_expired_sessions(db: AsyncSession) -> int:
    """Delete rows whose expires_at is in the past.  One-shot, no loop.

    Called from ``cleanup.py``'s ``_run_once`` sweep.
    """
    now = datetime.now(tz=UTC)
    result = await db.execute(
        sa_delete(UserSession).where(UserSession.expires_at <= now)
    )
    return result.rowcount or 0


# ---- Cookie helpers ---------------------------------------------------


def set_session_cookie(response: Response, session_id: uuid.UUID) -> None:
    """Attach an HttpOnly, SameSite=strict, Secure session cookie."""
    response.set_cookie(
        key=_COOKIE_NAME,
        value=str(session_id),
        max_age=_DEFAULT_TTL,
        path="/",
        httponly=True,
        samesite="strict",
        secure=True,
    )


def clear_session_cookie(response: Response) -> None:
    """Invalidate the session cookie by zeroing Max-Age."""
    response.delete_cookie(
        key=_COOKIE_NAME,
        path="/",
        httponly=True,
        samesite="strict",
        secure=True,
    )


# ---- FastAPI dependency -----------------------------------------------


async def get_current_user_from_cookie(
    request: Request,
    db: AsyncSession,
) -> User:
    """FastAPI dependency: validate session cookie and return the User.

    Raises HTTP 401 when the cookie is absent, malformed, expired, or the
    user account no longer exists / is disabled.

    NOTE: callers must inject ``db`` manually or use ``CookieUserDep``.
    """
    raw = request.cookies.get(_COOKIE_NAME)
    if not raw:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing session cookie")
    try:
        sid = uuid.UUID(raw)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid session cookie"
        ) from exc

    row = await validate_session(db, sid)
    if row is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="session expired or not found"
        )

    user = await db.get(User, row.user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="user not found")
    if user.disabled or user.is_suspended:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="account disabled")
    return user
