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
import logging
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, Request, Response, status
from sqlalchemy import or_, select, update

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.email import (
    compose_password_reset_email,
    issue_verification_email,
    resolve_smtp_config,
    send_email_with,
)
from dcc_auth.models import (
    EmailVerificationToken,
    PasswordResetToken,
    RefreshToken,
    User,
)
from dcc_auth.recovery import generate_token, verify_token
from dcc_auth.routes import _check_account_rate, _check_rate, _get_current_user
from dcc_auth.schemas import (
    EmailVerifyConfirmIn,
    MessageOut,
    PasswordForgotIn,
    PasswordResetIn,
)
from dcc_auth.security import hash_password

log = logging.getLogger(__name__)

router = APIRouter()


async def _send_reset_email_bg(cfg, to: str, subject: str, body: str) -> None:
    """Background mail send — failures are logged, never re-raised.

    Runs AFTER the 204 has gone out, so neither the status code nor the
    response latency can betray whether the account exists. A flaky SMTP
    relay therefore can't turn a forgot-password request for a real user
    into a 500 (and a missing user into a 204) — the enumeration oracle.

    ``cfg`` is the SMTP config resolved while the request session was still
    open (DB-first); ``None`` means no SMTP configured → the send is skipped
    just like the inline ``send_email`` no-SMTP path did.
    """
    try:
        if cfg is None:
            return  # no SMTP configured — nothing to send (matches send_email)
        await send_email_with(cfg, to, subject, body)
    except Exception:  # noqa: BLE001
        log.warning("password_reset_email_failed for %s", to, exc_info=True)


# ---- Password-reset -----------------------------------------------------


@router.post("/password/forgot", status_code=status.HTTP_204_NO_CONTENT)
async def password_forgot(
    payload: PasswordForgotIn,
    request: Request,
    session: SessionDep,
    background_tasks: BackgroundTasks,
) -> Response:
    """Always 204 — existence of the account is NOT leaked.

    If a user matches, we invalidate every still-active reset token for that
    user (so an attacker re-requesting can't keep the previous URL live) and
    email a fresh one. The mail send runs in a ``BackgroundTasks`` task AFTER
    the response is sent — so neither the 204 nor the response latency reveals
    whether the account exists, even if SMTP fails (failures are logged, never
    surfaced as a 500). Disabled/suspended accounts are treated as non-existent.
    """
    settings = get_settings()
    await _check_rate(
        request,
        "password_forgot",
        settings.rate_limit_password_forgot,
        account=payload.email_or_username.strip().lower(),
    )

    needle = payload.email_or_username.strip()
    user = (
        await session.execute(
            select(User).where(or_(User.email == needle.lower(), User.username == needle))
        )
    ).scalar_one_or_none()

    if user is None or user.disabled or user.is_suspended:
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
    # Resolve SMTP config while the session is still open (DB-first), then hand
    # the send off to a background task so a slow/failing relay never delays or
    # changes the response. ``None`` → no SMTP configured → background no-op.
    cfg = await resolve_smtp_config(session)
    background_tasks.add_task(_send_reset_email_bg, cfg, user.email, subject, body)
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

    # Per-account cap on top of the per-IP check above — bounds reset attempts
    # against one account across rotating IPs.
    await _check_account_rate(request, "password_reset", str(row.user_id))

    user = await session.get(User, row.user_id)
    if user is None or user.disabled or user.is_suspended:
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
    # with_for_update: macht das Single-Use-Consume atomar. Ohne den Row-Lock
    # könnten zwei gleichzeitige /password/reset-Requests mit demselben Token
    # beide used_at=NULL lesen (READ COMMITTED), beide passieren den Guard und
    # konsumieren das Token doppelt. Spiegelt das FOR-UPDATE-Muster aus
    # routes_totp.py / routes_account_key.py.
    row = (
        await session.execute(
            select(PasswordResetToken)
            .where(PasswordResetToken.token_hash == digest)
            .with_for_update()
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

    await issue_verification_email(session, current)
    await session.commit()
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
    # with_for_update: atomares Single-Use-Consume (gleiche Race wie beim
    # Passwort-Reset-Token, hier harmloser, aber konsistent gehärtet).
    row = (
        await session.execute(
            select(EmailVerificationToken)
            .where(EmailVerificationToken.token_hash == digest)
            .with_for_update()
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
    if user is None or user.disabled or user.is_suspended:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token"
        )

    row.used_at = now
    user.email_verified_at = now
    await session.commit()
    return MessageOut(detail="ok")
