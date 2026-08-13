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
import time
from datetime import UTC, datetime
from typing import Annotated

import jwt
import pyotp
import qrcode
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import delete, func, select

from dcc_auth.browser_sessions import create_session, set_session_cookie
from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models import BackupCode, User, WebAuthnCredential
from dcc_auth.recovery import (
    claim_mfa_ticket,
    decode_mfa_ticket,
    generate_backup_codes,
    hash_token,
    verify_token,
)
from dcc_auth.routes import (
    _check_account_rate,
    _check_rate,
    _client_ip,
    _get_current_user,
    _hash_ip,
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
    # Passwort wie beim Abschalten (s. `totp_disable`): ein gestohlenes
    # Zugangs-Token allein darf die Anmeldung dieses Kontos nicht umbauen. Ein
    # untergeschobenes TOTP-Geraet sperrt den echten Inhaber beim naechsten
    # Login aus, und einen Admin-Weg zurueck gibt es nicht.
    if not await asyncio.to_thread(verify_password, payload.password, current.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")

    if current.totp_enabled:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="totp already enabled")
    if not current.totp_secret:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="no totp setup in progress")

    totp = pyotp.TOTP(current.totp_secret)
    if not totp.verify(payload.code, valid_window=1):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid code")

    current.totp_enabled = True
    # NB: we deliberately do NOT seed the replay counter here. Replay-prevention
    # is a login concern (an intercepted login code must not be reusable to
    # authenticate) and lives in ``_consume_second_factor``. The setup ceremony
    # runs while the user is already authenticated, so stamping the counter here
    # has no security benefit and would wrongly reject a legitimate login with a
    # fresh code generated in the same 30s window right after enabling.

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
    # Backup codes are the recovery factor for the account's MFA as a whole —
    # keep them if a passkey is still registered, drop them only when TOTP was
    # the last factor standing.
    has_passkey = await session.scalar(
        select(func.count())
        .select_from(WebAuthnCredential)
        .where(WebAuthnCredential.user_id == current.id)
    )
    if not has_passkey:
        await session.execute(
            delete(BackupCode).where(BackupCode.user_id == current.id)
        )
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
    # Use the same replay-protected path as login (totp_last_counter check +
    # bump) — a bare ``TOTP.verify`` would let an intercepted code be replayed
    # here within its 30s window. ``backup_code=None`` forces the TOTP branch.
    if not await _consume_second_factor(
        session, current, code=payload.code, backup_code=None
    ):
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
    response: Response,
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
        user_id, ticket_jti = decode_mfa_ticket(signer, payload.mfa_ticket)
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid or expired ticket"
        ) from exc

    # Per-account cap on top of the per-IP check above — stops a distributed
    # attacker grinding one account's 6-digit TOTP across rotating IPs.
    await _check_account_rate(request, "login_totp", str(user_id))

    # Lock the user row for the read-check-write on ``totp_last_counter`` inside
    # _consume_second_factor — without it, two concurrent /login/totp requests
    # (victim + real-time-phishing proxy, each with its own mfa_ticket) both read
    # the same last-counter and both accept the same TOTP code (last-writer-wins,
    # no DB conflict), defeating the only TOTP-replay guard. Mirrors the backup
    # code branch's existing with_for_update.
    user = await session.get(User, user_id, with_for_update=True)
    if user is None or user.disabled or user.is_suspended:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid or expired ticket"
        )

    # Accept the second step for any account that actually carries an MFA
    # factor — TOTP *or* a registered passkey. A passkey-only account
    # (totp_enabled=False) is still issued an mfa_ticket by ``/login`` and
    # must be able to fall back to a backup code here; ``_consume_second_factor``
    # already handles the TOTP-vs-backup-code branching (and returns False for a
    # TOTP code when no secret is set), so the previous ``not totp_enabled`` /
    # ``not totp_secret`` gate was both redundant and too narrow.
    has_passkey = await session.scalar(
        select(func.count())
        .select_from(WebAuthnCredential)
        .where(WebAuthnCredential.user_id == user.id)
    )
    if not user.totp_enabled and not has_passkey:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid or expired ticket"
        )

    factor = await _consume_second_factor(
        session, user, code=payload.code, backup_code=payload.backup_code
    )
    if factor is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid code")

    # Single-use: the ticket has now done its job. Claim its jti so an intercepted
    # ticket can't be replayed (with the next valid TOTP code) to mint a second
    # token pair within the 5-min TTL. Claimed only after the factor verified, so
    # a mistyped code never burns the legitimate user's ticket.
    if not await claim_mfa_ticket(
        settings.redis_url, ticket_jti, settings.mfa_ticket_ttl_seconds
    ):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid or expired ticket"
        )

    user_agent = request.headers.get("user-agent")
    tokens = await _issue_tokens(
        session, user, signer=signer, user_agent=user_agent, ip_hash=_hash_ip(request)
    )
    # Browser-Session-Cookie wie beim Passwort-Login (routes.py::login) — sonst
    # bekommen 2FA-User keinen pulse_session-Cookie und die cookie-only Cert-/
    # Backup-/Profile-Endpoints (runIssueFlow → /credentials/issue) liefern 401.
    # acr="1": ein zweiter Faktor wurde geprüft → erfüllt den
    # mfa_step_up_required-Gate (routes_credentials.py::issue_credential).
    # amr reflects the factor that *actually* verified, not what the payload
    # carried: a client may send both a TOTP code and a backup code, in which
    # case the TOTP branch wins above and no backup code is consumed.
    amr = ["pwd", "backup" if factor == "backup" else "otp"]
    sid = await create_session(
        session,
        user_id=user.id,
        amr=amr,
        acr="1",
        user_agent=user_agent,
        ip=_client_ip(request),
    )
    await session.commit()
    set_session_cookie(response, sid)
    return tokens


# ---- helpers -----------------------------------------------------------


async def _consume_second_factor(
    session,
    user: User,
    *,
    code: str | None,
    backup_code: str | None,
) -> str | None:
    """Validate exactly one of (TOTP code | backup code); mark backup used.

    Returns the branch that actually succeeded — ``"totp"`` or ``"backup"`` —
    or ``None`` on failure. (The truthy string / falsy ``None`` keeps the
    existing ``if not await _consume_second_factor(...)`` callers working.)
    Returning *which* branch matters when a client sends both a valid TOTP code
    and a backup code: the TOTP branch wins (checked first, no backup consumed),
    so the caller must stamp ``amr`` from this return value, not the payload.

    Side effect: a successful backup-code path stamps ``used_at`` so the same
    code can't be replayed. The caller must commit.
    """
    if code:
        if not user.totp_secret:
            return None
        totp = pyotp.TOTP(user.totp_secret)
        if not totp.verify(code, valid_window=1):
            return None
        # Replay-prevention: reject if the timecode of *this* code (or an
        # earlier one) was already accepted. ``valid_window=1`` means the
        # accepted code could map to slot t-1, t or t+1, so we must store the
        # timecode of the code that actually matched — not just ``now`` — or a
        # code from the previous slot accepted now would leave the counter at
        # ``now`` and the same code could be replayed in the next window.
        accepted = _accepted_timecode(totp, code)
        if accepted is None:
            # verify() said yes but we couldn't pin the slot — be conservative.
            accepted = int(time.time()) // 30
        if user.totp_last_counter is not None and accepted <= user.totp_last_counter:
            return None
        user.totp_last_counter = accepted
        return "totp"
    if backup_code:
        normalized = backup_code.upper()
        digest = hash_token(normalized)
        row = (
            await session.execute(
                select(BackupCode)
                .where(
                    BackupCode.user_id == user.id,
                    BackupCode.code_hash == digest,
                    BackupCode.used_at.is_(None),
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        # The WHERE clause above already filters on code_hash == digest, but keep
        # the explicit constant-time verify as defence-in-depth on this auth path
        # (cheap, and avoids relying on DB-comparison timing properties).
        if not verify_token(normalized, row.code_hash):
            return None
        row.used_at = datetime.now(UTC)
        return "backup"
    return None


def _accepted_timecode(totp: pyotp.TOTP, code: str) -> int | None:
    """Return the TOTP timecode (``unix // period``) the given code matches.

    ``pyotp.TOTP.verify(code, valid_window=1)`` accepts a code from the
    previous, current or next 30-second slot but does not tell us *which*.
    For replay-prevention we need the timecode of the slot that actually
    matched, so we re-derive it by checking offsets -1, 0, +1 around now.
    Returns ``None`` if no slot matches (caller falls back to ``now``).
    """
    now = int(time.time())
    period = totp.interval  # 30 by default
    for offset in (-1, 0, 1):
        at = now + offset * period
        if totp.verify(code, for_time=at, valid_window=0):
            return at // period
    return None


