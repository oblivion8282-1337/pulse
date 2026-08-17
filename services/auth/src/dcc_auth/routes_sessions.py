"""Active-session management for the signed-in user.

Surfaces the user's own active refresh-token rows under ``/sessions`` so the
UI can show a "where am I signed in?" list, single-session revoke, and a
bulk "sign out everywhere else" action.

The endpoints here only ever expose the caller's *own* sessions — there is
no admin-cross-user variant (that would belong under ``routes_admin.py``
behind an admin gate).

Eine Sitzung besteht aus **zwei** Berechtigungen: dem Refresh-Token, den diese
Liste zeigt, und dem ``pulse_session``-Cookie, das sie nicht zeigt. Beide Wege
hier beenden beide Hälften — der Einzel-Widerruf über die Verknüpfung
``refresh_tokens.session_id``, der Sammel-Widerruf über den Nutzerbezug. Die
Mechanik dahinter liegt in ``session_link.py``.

Kept in its own file so ``routes.py`` stays under the size cap.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy import select, update as sa_update

from dcc_auth.db import SessionDep
from dcc_auth.models import RefreshToken, User, UserSession
from dcc_auth.routes import _get_current_user, _hash_ip
from dcc_auth.schemas import SessionOut, SessionsRevokeAllOut
from dcc_auth.session_link import (
    parse_sid,
    revoke_session_of_token_fallback,
    revoke_sessions_of_tokens,
)

router = APIRouter()


def _is_current(rt: RefreshToken, current_ip_hash: str, current_ua: str | None) -> bool:
    """Heuristic: same IP-hash AND same user-agent string.

    Not strictly accurate (two browsers on the same machine collide); good
    enough to drive a "this device" badge in the UI and to gate the
    "revoke all except current" sweep without surprising the caller.
    """
    if rt.ip_hash is None or rt.ip_hash != current_ip_hash:
        return False
    stored_ua = rt.user_agent or None
    incoming_ua = (current_ua[:1000] if current_ua else None) or None
    return stored_ua == incoming_ua


def _to_out(rt: RefreshToken, *, is_current: bool) -> SessionOut:
    return SessionOut(
        id=str(rt.jti),
        user_agent=rt.user_agent,
        # The model exposes ``issued_at`` (when the row was created); the UI
        # contract calls it ``created_at`` for parity with other auth tables.
        created_at=rt.issued_at,
        last_used_at=rt.last_used_at,
        is_current=is_current,
        ip_hash_prefix=(rt.ip_hash[:8] if rt.ip_hash else None),
    )


@router.get("/sessions", response_model=list[SessionOut])
async def list_sessions(
    request: Request,
    session: SessionDep,
    current: User = Depends(_get_current_user),
    user_agent: Annotated[str | None, Header(alias="User-Agent")] = None,
) -> list[SessionOut]:
    """Return the caller's still-valid refresh tokens, freshest first.

    "Active" = not revoked and not yet expired. Sort by ``last_used_at``
    descending with NULLs last so the device the user just refreshed on
    floats to the top of the list.
    """
    now = datetime.now(tz=UTC)
    stmt = (
        select(RefreshToken)
        .where(
            RefreshToken.user_id == current.id,
            RefreshToken.revoked_at.is_(None),
            RefreshToken.expires_at > now,
        )
        .order_by(
            RefreshToken.last_used_at.is_(None),  # False (0) sorts before True (1) -> non-null first
            RefreshToken.last_used_at.desc(),
        )
    )
    rows = (await session.execute(stmt)).scalars().all()
    current_ip_hash = _hash_ip(request)
    return [_to_out(rt, is_current=_is_current(rt, current_ip_hash, user_agent)) for rt in rows]


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_session(
    request: Request,
    session_id: str,
    session: SessionDep,
    current: User = Depends(_get_current_user),
):
    """Revoke one specific refresh token belonging to the caller — **und das
    Browser-Cookie derselben Anmeldung**.

    Eine Sitzung besteht aus zwei Berechtigungen: dem Refresh-Token, den diese
    Liste zeigt, und dem ``pulse_session``-Cookie, das sie nicht zeigt. Wurde
    hier nur der Token entwertet, blieb das entfernte Gerät über sein Cookie
    voll angemeldet und konnte sich sogar noch ein Geräte-Zertifikat ausstellen
    (``/credentials/issue`` authentifiziert ausschließlich über das Cookie) —
    die Schaltfläche sagte etwas zu, was nicht eintrat. Die Verknüpfung dafür
    liegt in ``refresh_tokens.session_id`` (Migration 0049); der Notbehelf für
    Zeilen von vorher steht in ``session_link.py``.

    Ausdrücklich **nicht** widerrufen werden die Geräte-Zertifikate des
    beendeten Geräts: sie hängen am Gerät, nicht an der Sitzung, gelten bis zu
    365 Tage über jede Ab- und Neuanmeldung hinweg und haben unter „Geräte“
    einen eigenen, sichtbaren Widerrufsweg. Was hier zählt, ist, dass die
    beendete Sitzung keine NEUEN mehr ausstellen kann — und das leistet der
    Cookie-Widerruf.

    Returns 404 if the token doesn't exist, belongs to another user, or is
    already revoked — collapsing the three into one response avoids
    leaking the existence of other users' tokens.
    """
    try:
        jti = uuid.UUID(session_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="session not found") from exc

    rt = await session.get(RefreshToken, jti)
    if rt is None or rt.user_id != current.id or rt.revoked_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="session not found")
    now = datetime.now(tz=UTC)
    rt.revoked_at = now
    if rt.session_id is not None:
        await revoke_sessions_of_tokens(session, [rt], now=now)
    else:
        await revoke_session_of_token_fallback(
            session,
            rt,
            keep_sid=parse_sid(request.cookies.get("pulse_session")),
            now=now,
        )
    await session.commit()
    return None


@router.delete("/sessions", response_model=SessionsRevokeAllOut)
async def revoke_all_sessions(
    request: Request,
    session: SessionDep,
    current: User = Depends(_get_current_user),
    user_agent: Annotated[str | None, Header(alias="User-Agent")] = None,
) -> SessionsRevokeAllOut:
    """Revoke every active session of the caller *except* the current one.

    "Current" is the same heuristic the list endpoint uses (IP-hash +
    UA). If nothing matches — e.g. the caller is on a brand-new device
    whose refresh-token row hasn't been written yet for some reason — we
    sweep them all; the caller's *access* token stays valid until it
    expires (≤15 min), so they don't get locked out mid-request.
    """
    now = datetime.now(tz=UTC)
    current_ip_hash = _hash_ip(request)
    incoming_ua = (user_agent[:1000] if user_agent else None) or None

    stmt = select(RefreshToken).where(
        RefreshToken.user_id == current.id,
        RefreshToken.revoked_at.is_(None),
        RefreshToken.expires_at > now,
    )
    rows = (await session.execute(stmt)).scalars().all()

    revoked = 0
    for rt in rows:
        stored_ua = rt.user_agent or None
        is_current = rt.ip_hash == current_ip_hash and stored_ua == incoming_ua
        if is_current:
            continue
        rt.revoked_at = now
        revoked += 1

    # Also revoke the *browser-session* cookies (user_sessions), not just the
    # refresh tokens — otherwise a stolen pulse_session cookie survives
    # "sign out everywhere else". Preserve the caller's own current cookie so
    # this request's device stays signed in. validate_session rejects any row
    # with revoked_at set, so the other cookies die immediately.
    current_sid = request.cookies.get("pulse_session")
    keep_sid: str | None = None
    if current_sid:
        try:
            keep_sid = str(uuid.UUID(current_sid))
        except ValueError:
            keep_sid = None
    cond = [
        UserSession.user_id == current.id,
        UserSession.revoked_at.is_(None),
    ]
    if keep_sid is not None:
        cond.append(UserSession.session_id != keep_sid)
    await session.execute(
        sa_update(UserSession).where(*cond).values(expires_at=now, revoked_at=now)
    )

    await session.commit()
    return SessionsRevokeAllOut(revoked_count=revoked)
