"""Password-reset + email-verification routes.

Kept separate from the main ``routes.py`` (already 415 lines) and from the
TOTP routes (``routes_totp.py``) so each file stays under the size cap.

All endpoints here use the in-process ``_check_rate`` helper from ``routes.py``
to share the same rate-bucket store the existing register/login endpoints
hit — that keeps tests isolated by the autouse fixture without a separate
reset call.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy import or_, select, update

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.email import (
    compose_email_verification,
    compose_password_reset_email,
    send_email,
)
from dcc_auth.models import (
    EmailVerificationToken,
    PasswordResetToken,
    RefreshToken,
    User,
)
from dcc_auth.recovery import generate_token, verify_token
from dcc_auth.routes import _check_rate, _get_current_user
from dcc_auth.schemas import (
    EmailVerifyConfirmIn,
    MessageOut,
    PasswordForgotIn,
    PasswordResetIn,
)
from dcc_auth.security import hash_password

router = APIRouter()


# ---- Password-reset -----------------------------------------------------


@router.post("/password/forgot", status_code=status.HTTP_204_NO_CONTENT)
async def password_forgot(
    payload: PasswordForgotIn,
    request: Request,
    session: SessionDep,
) -> Response:
    """Always 204 — existence of the account is NOT leaked.

    If a user matches, we invalidate every still-active reset token for that
    user (so an attacker re-requesting can't keep the previous URL live) and
    email a fresh one. The mail send is awaited inline; failures bubble as
    500 only when SMTP is configured — without SMTP the body lands in the
    service log instead.
    """
    settings = get_settings()
    await _check_rate(request, "password_forgot", settings.rate_limit_password_forgot)

    needle = payload.email_or_username.strip()
    user = (
        await session.execute(
            select(User).where(or_(User.email == needle.lower(), User.username == needle))
        )
    ).scalar_one_or_none()

    if user is None or user.disabled:
        # Enumeration guard: same 204 either way + don't issue a token.
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    now = datetime.now(UTC)
    # Burn any open prior tokens — the user can only ever have one valid link.
    await session.execute(
        update(PasswordResetToken)
        .where(
            PasswordResetToken.user_id == user.id,
            PasswordResetToken.used_at.is_(None),
        )
        .values(used_at=now)
    )

    plaintext, digest = generate_token()
    session.add(
        PasswordResetToken(
            user_id=user.id,
            token_hash=digest,
            expires_at=now + timedelta(seconds=settings.password_reset_ttl_seconds),
        )
    )
    await session.commit()

    reset_url = f"{settings.app_base_url.rstrip('/')}/reset-password/{plaintext}"
    subject, body = compose_password_reset_email(user.email, reset_url)
    await send_email(user.email, subject, body, session=session)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/password/reset", response_model=MessageOut)
async def password_reset(
    payload: PasswordResetIn,
    request: Request,
    session: SessionDep,
):
    """Consume a reset token; set a new password; revoke ALL refresh tokens.

    Revoking refresh tokens is the standard post-password-change move —
    a reset implies the previous credential is compromised, so any session
    still holding an old refresh token needs to re-auth with the new pw.
    """
    settings = get_settings()
    await _check_rate(request, "password_reset", settings.rate_limit_password_reset)

    row = await _consume_reset_token(session, payload.token)
    if row is None:
        # Single 401 for {unknown,expired,used} — don't leak which.
        from fastapi import HTTPException

        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token"
        )

    user = await session.get(User, row.user_id)
    if user is None or user.disabled:
        from fastapi import HTTPException

        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token"
        )

    user.password_hash = await asyncio.to_thread(hash_password, payload.new_password)

    # Kill every active refresh token — the user must re-auth on each device.
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
    await session.commit()
    return MessageOut(detail="ok")


async def _consume_reset_token(session, plaintext: str) -> PasswordResetToken | None:
    """Look up an unused, unexpired reset token and mark it used.

    Returns the row pre-mutation so the caller can still see ``user_id``; the
    ``used_at`` column has already been stamped at this point.
    """
    from dcc_auth.recovery import hash_token

    digest = hash_token(plaintext)
    row = (
        await session.execute(
            select(PasswordResetToken).where(PasswordResetToken.token_hash == digest)
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    now = datetime.now(UTC)
    expires_at = (
        row.expires_at if row.expires_at.tzinfo is not None else row.expires_at.replace(tzinfo=UTC)
    )
    if row.used_at is not None or expires_at <= now:
        return None
    # Constant-time double-check (paranoia — DB lookup is already keyed on the
    # digest so collision/timing leak isn't a real threat, but cheap to add).
    if not verify_token(plaintext, row.token_hash):
        return None
    row.used_at = now
    return row


# ---- Email-verification -------------------------------------------------


@router.post("/email/verification/send", status_code=status.HTTP_204_NO_CONTENT)
async def email_verification_send(
    request: Request,
    session: SessionDep,
    current: Annotated[User, Depends(_get_current_user)],
) -> Response:
    """Issue a fresh verify-token for the logged-in user's current email.

    No-ops on already-verified accounts (still 204 — don't reveal state to
    the caller, even though they're authenticated, just to keep the wire
    contract uniform).
    """
    settings = get_settings()
    await _check_rate(
        request, "email_verification_send", settings.rate_limit_email_verify_send
    )

    if current.email_verified_at is not None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    now = datetime.now(UTC)
    await session.execute(
        update(EmailVerificationToken)
        .where(
            EmailVerificationToken.user_id == current.id,
            EmailVerificationToken.used_at.is_(None),
        )
        .values(used_at=now)
    )

    plaintext, digest = generate_token()
    session.add(
        EmailVerificationToken(
            user_id=current.id,
            token_hash=digest,
            expires_at=now + timedelta(seconds=settings.email_verification_ttl_seconds),
        )
    )
    await session.commit()

    verify_url = f"{settings.app_base_url.rstrip('/')}/verify-email/{plaintext}"
    subject, body = compose_email_verification(current.email, verify_url)
    await send_email(current.email, subject, body, session=session)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/email/verification/confirm", response_model=MessageOut)
async def email_verification_confirm(
    payload: EmailVerifyConfirmIn,
    session: SessionDep,
):
    """Anonymous endpoint — the token in the URL IS the auth.

    The verify link goes out in an email, so the recipient is by definition
    the address-owner. Requiring a bearer in addition would be cumbersome
    (the user may not be logged in on the device they click the link from).
    """
    from fastapi import HTTPException

    from dcc_auth.recovery import hash_token

    digest = hash_token(payload.token)
    row = (
        await session.execute(
            select(EmailVerificationToken).where(
                EmailVerificationToken.token_hash == digest
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token"
        )
    now = datetime.now(UTC)
    expires_at = (
        row.expires_at if row.expires_at.tzinfo is not None else row.expires_at.replace(tzinfo=UTC)
    )
    if row.used_at is not None or expires_at <= now:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token"
        )
    if not verify_token(payload.token, row.token_hash):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token"
        )

    user = await session.get(User, row.user_id)
    if user is None or user.disabled:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token"
        )

    row.used_at = now
    user.email_verified_at = now
    await session.commit()
    return MessageOut(detail="ok")
