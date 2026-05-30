"""Authenticated account-credential changes: password (Phase 1) + email (Phase 2).

Separate from ``routes_recovery.py`` (the *unauthenticated* forgot/reset/verify
flows) and from ``routes.py`` (already large). Every endpoint here requires a
logged-in user via ``_get_current_user`` (Bearer token OR ``pulse_session``
cookie) — except the email-change *confirm* step, where the token in the
verification link IS the auth (the recipient owns the new address).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy import delete, select, update

from dcc_auth.browser_sessions import (
    create_session,
    revoke_all_for_user,
    set_session_cookie,
)
from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.email import (
    compose_email_change_notice,
    compose_email_change_verification,
    send_email,
)
from dcc_auth.models import EmailChangeToken, RefreshToken, User
from dcc_auth.recovery import generate_token, hash_token, verify_token
from dcc_auth.routes import (
    _check_rate,
    _client_ip,
    _get_current_user,
    _hash_ip,
    _issue_tokens,
    _signer_dep,
)
from dcc_auth.schemas import (
    EmailChangeConfirmIn,
    EmailChangeRequestIn,
    MessageOut,
    PasswordChangeIn,
    TokensOut,
)
from dcc_auth.security import JwtSigner, hash_password, verify_password

log = logging.getLogger(__name__)

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


@router.post("/me/email/change", status_code=status.HTTP_204_NO_CONTENT)
async def request_email_change(
    payload: EmailChangeRequestIn,
    request: Request,
    session: SessionDep,
    current: Annotated[User, Depends(_get_current_user)],
) -> Response:
    """Start an email change. Requires the current password; sends a confirm
    link to the NEW address (and a heads-up to the OLD one). The account's
    ``email`` is NOT touched until that link is clicked — so a session-only
    attacker can't silently move the account to an address they control, and
    the real owner gets warned at their old inbox.
    """
    settings = get_settings()
    await _check_rate(request, "email_change", settings.rate_limit_email_verify_send)

    if not verify_password(payload.current_password, current.password_hash):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="current password incorrect"
        )

    new_email = payload.new_email.strip().lower()
    if new_email == (current.email or "").lower():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="email unchanged")

    existing = (
        await session.execute(select(User).where(User.email == new_email))
    ).scalar_one_or_none()
    if existing is not None and existing.id != current.id:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="email already in use")

    now = datetime.now(UTC)
    # One live change-link at a time: burn any prior open tokens.
    await session.execute(
        update(EmailChangeToken)
        .where(
            EmailChangeToken.user_id == current.id,
            EmailChangeToken.used_at.is_(None),
        )
        .values(used_at=now)
    )
    plaintext, digest = generate_token()
    session.add(
        EmailChangeToken(
            user_id=current.id,
            new_email=new_email,
            token_hash=digest,
            expires_at=now + timedelta(seconds=settings.email_verification_ttl_seconds),
        )
    )
    old_email = current.email
    await session.commit()

    verify_url = f"{settings.app_base_url.rstrip('/')}/verify-email-change/{plaintext}"
    subject, body = compose_email_change_verification(new_email, verify_url)
    await send_email(new_email, subject, body, session=session)
    # Heads-up to the OLD address — best-effort, must not fail the request.
    try:
        notice_subject, notice_body = compose_email_change_notice(old_email, new_email)
        await send_email(old_email, notice_subject, notice_body, session=session)
    except Exception as exc:  # noqa: BLE001
        log.warning("email_change_notice_failed: %s", exc)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/me/email/change/confirm", response_model=MessageOut)
async def confirm_email_change(
    payload: EmailChangeConfirmIn,
    session: SessionDep,
) -> MessageOut:
    """Anonymous — the token in the link IS the auth (the recipient owns the
    new address). Consumes the token and rewrites ``users.email`` (marking the
    new address verified). 401 for any bad/expired/used token; 409 if the
    address was taken by someone else between request and confirm.
    """
    digest = hash_token(payload.token)
    row = (
        await session.execute(
            select(EmailChangeToken).where(EmailChangeToken.token_hash == digest)
        )
    ).scalar_one_or_none()
    now = datetime.now(UTC)
    bad = HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token")
    if row is None:
        raise bad
    expires_at = (
        row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=UTC)
    )
    if row.used_at is not None or expires_at <= now:
        raise bad
    if not verify_token(payload.token, row.token_hash):
        raise bad

    user = await session.get(User, row.user_id)
    if user is None or user.disabled:
        raise bad

    clash = (
        await session.execute(
            select(User).where(User.email == row.new_email, User.id != user.id)
        )
    ).scalar_one_or_none()
    if clash is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="email already in use")

    row.used_at = now
    user.email = row.new_email
    user.email_verified_at = now
    await session.commit()
    return MessageOut(detail="ok")
