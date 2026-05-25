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
from sqlalchemy import select
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
    The caller is responsible for committing the enclosing transaction.
    """
    # SQLite stores as TEXT; Postgres stores as UUID. Pass str for compat.
    row = await db.get(UserSession, str(session_id))
    if row is None:
        return None
    now = datetime.now(tz=UTC)
    # Coerce naive datetimes from SQLite tests
    exp = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=UTC)
    if exp <= now:
        return None
    # Slide the window
    row.last_seen_at = now
    row.expires_at = now + timedelta(seconds=ttl)
    return row


async def revoke_session(db: AsyncSession, session_id: uuid.UUID) -> bool:
    """Soft-delete by setting expires_at = now.  Returns True if row existed."""
    row = await db.get(UserSession, str(session_id))
    if row is None:
        return False
    row.expires_at = datetime.now(tz=UTC)
    return True


async def revoke_all_for_user(db: AsyncSession, user_id: int) -> int:
    """Expire all active sessions for a user (Logout-Everywhere).

    Returns the number of rows touched.
    """
    now = datetime.now(tz=UTC)
    stmt = (
        select(UserSession)
        .where(UserSession.user_id == user_id, UserSession.expires_at > now)
    )
    rows = (await db.execute(stmt)).scalars().all()
    for row in rows:
        row.expires_at = now
    return len(rows)


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
