"""TOTP / 2FA routes — setup, verify-setup, disable, backup-code regenerate.

The two-step login (password → MFA challenge → tokens) lives partly here as
``POST /login/totp``; the first step (``POST /login`` returning an
``mfa_ticket`` when 2FA is on) is in ``routes.py`` so the existing happy-path
without 2FA stays a single small handler.

Setup flow:
  1. POST /totp/setup           — generates secret, writes it to users.totp_secret,
                                   leaves totp_enabled=false, returns secret + QR.
  2. POST /totp/verify-setup    — user enters first code from app; on success we
                                   flip totp_enabled=true and issue backup codes.

The first call writes the secret because Redis is optional in this service
(unit-test environment is SQLite-only) and storing it short-term in the JWT
makes the second-step payload >2 KB. ``totp_enabled=false`` is the gate —
login still works without TOTP until the user verifies.
"""

from __future__ import annotations

import asyncio
import base64
import io
from datetime import UTC, datetime
from typing import Annotated

import jwt
import pyotp
import qrcode
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import delete, select

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models import BackupCode, User
from dcc_auth.recovery import (
    decode_mfa_ticket,
    generate_backup_codes,
    hash_token,
    verify_token,
)
from dcc_auth.routes import (
    _check_rate,
    _get_current_user,
    _issue_tokens,
    _signer_dep,
)
from dcc_auth.schemas import (
    LoginTotpIn,
    MessageOut,
    TokensOut,
    TotpBackupRegenIn,
    TotpDisableIn,
    TotpSetupOut,
    TotpVerifySetupIn,
    TotpVerifySetupOut,
)
from dcc_auth.security import JwtSigner, verify_password

router = APIRouter()


# ---- Setup --------------------------------------------------------------


@router.post("/totp/setup", response_model=TotpSetupOut)
async def totp_setup(
    request: Request,
    session: SessionDep,
    current: Annotated[User, Depends(_get_current_user)],
):
    """Generate a fresh TOTP secret + render the QR for an Authenticator app.

    Repeat calls before verify rotate the secret — useful if the user lost
    their first scan. Once ``totp_enabled`` is true, this endpoint 409s and
    the caller must go through ``/totp/disable`` first.
    """
    settings = get_settings()
    await _check_rate(request, "totp_setup", settings.rate_limit_totp_setup)
    if current.totp_enabled:
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="totp already enabled"
        )

    secret = pyotp.random_base32()
    current.totp_secret = secret
    await session.commit()

    provisioning_uri = pyotp.totp.TOTP(secret).provisioning_uri(
        name=current.username, issuer_name=settings.totp_issuer
    )
    # QR rendering is CPU work — kick to a thread so we don't stall the loop.
    qr_png_base64 = await asyncio.to_thread(_render_qr_png_base64, provisioning_uri)

    return TotpSetupOut(
        secret=secret,
        qr_png_base64=qr_png_base64,
        provisioning_uri=provisioning_uri,
    )


def _render_qr_png_base64(data: str) -> str:
    img = qrcode.make(data)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


@router.post("/totp/verify-setup", response_model=TotpVerifySetupOut)
async def totp_verify_setup(
    payload: TotpVerifySetupIn,
    request: Request,
    session: SessionDep,
    current: Annotated[User, Depends(_get_current_user)],
):
    """Validate first code → enable 2FA → issue 10 single-use backup codes.

    Returned plaintext is the ONE chance the user has to copy them — only the
    SHA-256 hash is stored. UI must show them prominently and require an
    "I've saved these" confirmation before moving on.
    """
    settings = get_settings()
    await _check_rate(
        request, "totp_verify_setup", settings.rate_limit_totp_verify_setup
    )

    if current.totp_enabled:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="totp already enabled")
    if not current.totp_secret:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="no totp setup in progress")

    if not pyotp.TOTP(current.totp_secret).verify(payload.code, valid_window=1):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid code")

    current.totp_enabled = True

    # Replace any stale backup codes from a previous (now-disabled) 2FA setup.
    await session.execute(delete(BackupCode).where(BackupCode.user_id == current.id))
    plaintext_codes = generate_backup_codes(10)
    for code in plaintext_codes:
        session.add(BackupCode(user_id=current.id, code_hash=hash_token(code)))
    await session.commit()

    return TotpVerifySetupOut(backup_codes=plaintext_codes)


# ---- Disable + regenerate ----------------------------------------------


@router.post("/totp/disable", response_model=MessageOut)
async def totp_disable(
    request: Request,
    payload: TotpDisableIn,
    session: SessionDep,
    current: Annotated[User, Depends(_get_current_user)],
):
    """Turn off 2FA — requires password + (TOTP code OR a backup code).

    Either second factor proves the user still has access; password proves
    a stolen access token alone can't strip 2FA off the account.
    """
    settings = get_settings()
    await _check_rate(request, "totp_disable", settings.rate_limit_totp_disable)
    if not current.totp_enabled or not current.totp_secret:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="totp not enabled")

    pw_ok = await asyncio.to_thread(verify_password, payload.password, current.password_hash)
    if not pw_ok:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")

    if not await _consume_second_factor(
        session, current, code=payload.code, backup_code=payload.backup_code
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid code")

    current.totp_enabled = False
    current.totp_secret = None
    await session.execute(delete(BackupCode).where(BackupCode.user_id == current.id))
    await session.commit()
    return MessageOut(detail="ok")


@router.post("/totp/backup-codes/regenerate", response_model=TotpVerifySetupOut)
async def totp_backup_regen(
    request: Request,
    payload: TotpBackupRegenIn,
    session: SessionDep,
    current: Annotated[User, Depends(_get_current_user)],
):
    """Replace the 10 backup codes; requires password + a live TOTP code.

    Backup-code-as-second-factor would also work in principle, but a stack of
    burned backup codes is exactly the state where you most want a hard
    re-prove-yourself-via-app step.
    """
    settings = get_settings()
    await _check_rate(
        request, "totp_backup_regenerate", settings.rate_limit_totp_backup_regenerate
    )
    if not current.totp_enabled or not current.totp_secret:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="totp not enabled")

    pw_ok = await asyncio.to_thread(verify_password, payload.password, current.password_hash)
    if not pw_ok:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
    if not pyotp.TOTP(current.totp_secret).verify(payload.code, valid_window=1):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid code")

    await session.execute(delete(BackupCode).where(BackupCode.user_id == current.id))
    plaintext_codes = generate_backup_codes(10)
    for code in plaintext_codes:
        session.add(BackupCode(user_id=current.id, code_hash=hash_token(code)))
    await session.commit()
    return TotpVerifySetupOut(backup_codes=plaintext_codes)


# ---- 2FA login second step ---------------------------------------------


@router.post("/login/totp", response_model=TokensOut)
async def login_totp(
    payload: LoginTotpIn,
    request: Request,
    session: SessionDep,
    signer: Annotated[JwtSigner, Depends(_signer_dep)],
):
    """Complete a 2FA login: consume the MFA ticket + a second factor.

    Returns the same ``TokensOut`` as the password-only ``/login`` so the
    frontend can use a single token-handling code path once it knows which
    step yielded the tokens.
    """
    settings = get_settings()
    await _check_rate(request, "login_totp", settings.rate_limit_login_totp)

    try:
        user_id = decode_mfa_ticket(signer, payload.mfa_ticket)
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid or expired ticket"
        ) from exc

    user = await session.get(User, user_id)
    if user is None or user.disabled or not user.totp_enabled or not user.totp_secret:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid or expired ticket"
        )

    if not await _consume_second_factor(
        session, user, code=payload.code, backup_code=payload.backup_code
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid code")

    user_agent = request.headers.get("user-agent")
    tokens = await _issue_tokens(session, user, signer=signer, user_agent=user_agent)
    await session.commit()
    return tokens


# ---- helpers -----------------------------------------------------------


async def _consume_second_factor(
    session,
    user: User,
    *,
    code: str | None,
    backup_code: str | None,
) -> bool:
    """Validate exactly one of (TOTP code | backup code); mark backup used.

    Returns True if the second factor checks out, False otherwise. Side
    effect: a successful backup-code path stamps ``used_at`` so the same
    code can't be replayed. The caller must commit.
    """
    if code:
        if not user.totp_secret:
            return False
        return pyotp.TOTP(user.totp_secret).verify(code, valid_window=1)
    if backup_code:
        normalized = backup_code.upper()
        digest = hash_token(normalized)
        row = (
            await session.execute(
                select(BackupCode).where(
                    BackupCode.user_id == user.id,
                    BackupCode.code_hash == digest,
                    BackupCode.used_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        if not verify_token(normalized, row.code_hash):
            return False
        row.used_at = datetime.now(UTC)
        return True
    return False


