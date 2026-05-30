"""Authenticated account-credential changes: password (Phase 1) + email (Phase 2).

Separate from ``routes_recovery.py`` (the *unauthenticated* forgot/reset/verify
flows) and from ``routes.py`` (already large). Every endpoint here requires a
logged-in user via ``_get_current_user`` (Bearer token OR ``pulse_session``
cookie) — except the email-change *confirm* step, where the token in the
verification link IS the auth (the recipient owns the new address).
"""

from __future__ import annotations

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy import delete

from dcc_auth.browser_sessions import (
    create_session,
    revoke_all_for_user,
    set_session_cookie,
)
from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models import RefreshToken, User
from dcc_auth.routes import (
    _check_rate,
    _client_ip,
    _get_current_user,
    _hash_ip,
    _issue_tokens,
    _signer_dep,
)
from dcc_auth.schemas import PasswordChangeIn, TokensOut
from dcc_auth.security import JwtSigner, hash_password, verify_password

router = APIRouter()


@router.post("/me/password", response_model=TokensOut)
async def change_password(
    payload: PasswordChangeIn,
    request: Request,
    response: Response,
    session: SessionDep,
    current: Annotated[User, Depends(_get_current_user)],
    signer: JwtSigner = Depends(_signer_dep),
    user_agent: str | None = Header(default=None, alias="User-Agent"),
) -> TokensOut:
    """Change the logged-in user's password.

    The *current* password is required as a re-auth gate — a hijacked, still-open
    session must not be able to silently rotate the credential. On success every
    refresh token + browser session is revoked (all OTHER devices are logged
    out), then a fresh token pair + session cookie is minted for THIS caller so
    the current device stays signed in.
    """
    settings = get_settings()
    await _check_rate(request, "password_change", settings.rate_limit_password_reset)

    if not verify_password(payload.current_password, current.password_hash):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="current password incorrect"
        )
    if payload.new_password == payload.current_password:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="new password must differ from current"
        )

    current.password_hash = await asyncio.to_thread(hash_password, payload.new_password)

    # Log out every device. DELETE the refresh tokens rather than soft-revoking
    # them: a soft-revoked token, when an old device replays it, trips the
    # reuse-detection in /refresh which revokes the WHOLE family — and that would
    # also kill the fresh token we mint below for THIS device. A deleted row just
    # 404s on replay (no cascade), so the current device stays signed in.
    await session.execute(
        delete(RefreshToken).where(RefreshToken.user_id == current.id)
    )
    await revoke_all_for_user(session, current.id)

    # ...then re-arm THIS client with a fresh token pair + session cookie, so the
    # password change doesn't immediately log the active device out.
    tokens = await _issue_tokens(
        session, current, signer=signer, user_agent=user_agent, ip_hash=_hash_ip(request)
    )
    sid = await create_session(
        session,
        user_id=current.id,
        amr=["pwd"],
        acr="0",
        user_agent=user_agent,
        ip=_client_ip(request),
    )
    await session.commit()
    set_session_cookie(response, sid)
    return tokens
