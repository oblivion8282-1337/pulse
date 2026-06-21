"""WebAuthn / passkey routes — enrolment & management (authenticated).

The login ceremony lives in ``routes_webauthn_login.py``; it is split out
because those endpoints are reached *before* a bearer token exists, whereas
everything here requires ``_get_current_user``.

Recovery codes: the first passkey enrolled on an account with no other MFA
factor mints the same 10 single-use backup codes the TOTP flow issues — see
``webauthn_register_verify``. ``routes_totp``/``webauthn_delete_credential``
keep them in sync as factors come and go.
"""

from __future__ import annotations

from typing import Annotated

import jwt
import structlog
import webauthn
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import delete, func, select
from webauthn.helpers import bytes_to_base64url

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models import BackupCode, User, WebAuthnCredential
from dcc_auth.passkeys import (
    PURPOSE_REGISTER,
    build_registration_options,
    decode_challenge_ticket,
    issue_challenge_ticket,
    load_user_credentials,
)
from dcc_auth.recovery import generate_backup_codes, hash_token
from dcc_auth.routes import _check_rate, _get_current_user, _signer_dep
from dcc_auth.schemas import (
    MessageOut,
    WebAuthnCredentialOut,
    WebAuthnCredentialRenameIn,
    WebAuthnOptionsOut,
    WebAuthnRegisterVerifyIn,
    WebAuthnRegisterVerifyOut,
)
from dcc_auth.security import JwtSigner

router = APIRouter()
log = structlog.get_logger(__name__)


def _extract_transports(credential: dict) -> list[str] | None:
    """Pull the browser's transport hints out of a registration credential."""
    resp = credential.get("response") or {}
    transports = resp.get("transports")
    if isinstance(transports, list) and transports:
        return [str(t) for t in transports]
    return None


# ---- registration -------------------------------------------------------


@router.post("/webauthn/register/options", response_model=WebAuthnOptionsOut)
async def webauthn_register_options(
    request: Request,
    session: SessionDep,
    current: Annotated[User, Depends(_get_current_user)],
    signer: Annotated[JwtSigner, Depends(_signer_dep)],
):
    """Issue ``create()`` options for enrolling a new passkey.

    Existing credentials are passed as ``excludeCredentials`` so the same
    authenticator can't be registered twice.
    """
    settings = get_settings()
    await _check_rate(request, "webauthn_register", settings.rate_limit_webauthn_register)
    existing = await load_user_credentials(session, current.id)
    options, challenge = build_registration_options(
        settings,
        user_id=current.id,
        username=current.username,
        display_name=current.display_name,
        existing=existing,
    )
    ticket = issue_challenge_ticket(
        signer,
        purpose=PURPOSE_REGISTER,
        challenge=challenge,
        user_id=current.id,
        ttl_seconds=settings.webauthn_challenge_ttl_seconds,
    )
    return WebAuthnOptionsOut(options=options, challenge_ticket=ticket)


@router.post(
    "/webauthn/register/verify",
    response_model=WebAuthnRegisterVerifyOut,
    status_code=status.HTTP_201_CREATED,
)
async def webauthn_register_verify(
    payload: WebAuthnRegisterVerifyIn,
    request: Request,
    session: SessionDep,
    current: Annotated[User, Depends(_get_current_user)],
    signer: Annotated[JwtSigner, Depends(_signer_dep)],
):
    """Verify the attestation and persist the passkey.

    Returns one-time backup codes iff this is the account's first MFA factor.
    """
    settings = get_settings()
    await _check_rate(request, "webauthn_register", settings.rate_limit_webauthn_register)
    try:
        challenge, ticket_user_id, _ = decode_challenge_ticket(
            signer, payload.challenge_ticket, expected_purpose=PURPOSE_REGISTER
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid or expired challenge"
        ) from exc
    if ticket_user_id != current.id:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="challenge does not belong to this user"
        )

    try:
        verified = webauthn.verify_registration_response(
            credential=payload.credential,
            expected_challenge=challenge,
            expected_rp_id=settings.webauthn_rp_id,
            expected_origin=settings.webauthn_origins_list,
        )
    except Exception as exc:  # noqa: BLE001 — webauthn raises a wide hierarchy
        log.warning("webauthn_register_verify_failed", user_id=current.id, error=str(exc))
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="passkey verification failed"
        ) from exc

    cred_id = bytes_to_base64url(verified.credential_id)
    dup = await session.scalar(
        select(WebAuthnCredential).where(WebAuthnCredential.credential_id == cred_id)
    )
    if dup is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="passkey already registered")

    row = WebAuthnCredential(
        user_id=current.id,
        credential_id=cred_id,
        public_key=bytes_to_base64url(verified.credential_public_key),
        sign_count=verified.sign_count,
        name=payload.name.strip(),
        aaguid=verified.aaguid,
        transports=_extract_transports(payload.credential),
    )
    session.add(row)
    await session.flush()

    # First MFA factor reached via a passkey → mint recovery codes, but only
    # if the account has none yet (a TOTP user already got theirs).
    backup_codes: list[str] | None = None
    has_codes = await session.scalar(
        select(func.count())
        .select_from(BackupCode)
        .where(BackupCode.user_id == current.id)
    )
    if not has_codes:
        # Idempotent mint (mirrors totp_verify_setup): delete-before-insert in the
        # same flushed transaction so a concurrent first-factor setup (TOTP +
        # passkey at once) can't leave two backup-code sets behind. The has_codes
        # guard above keeps the "only the account's first factor mints codes"
        # semantics — a second passkey never reaches this branch, so existing
        # codes are never rotated out from under the user.
        await session.execute(delete(BackupCode).where(BackupCode.user_id == current.id))
        backup_codes = generate_backup_codes(10)
        for code in backup_codes:
            session.add(BackupCode(user_id=current.id, code_hash=hash_token(code)))

    await session.commit()
    return WebAuthnRegisterVerifyOut(
        credential=WebAuthnCredentialOut.model_validate(row),
        backup_codes=backup_codes,
    )


# ---- credential management ----------------------------------------------


@router.get("/webauthn/credentials", response_model=list[WebAuthnCredentialOut])
async def webauthn_list_credentials(
    session: SessionDep,
    current: Annotated[User, Depends(_get_current_user)],
):
    """List the current user's registered passkeys, oldest first."""
    return await load_user_credentials(session, current.id)


@router.patch(
    "/webauthn/credentials/{credential_id}", response_model=WebAuthnCredentialOut
)
async def webauthn_rename_credential(
    credential_id: int,
    payload: WebAuthnCredentialRenameIn,
    session: SessionDep,
    current: Annotated[User, Depends(_get_current_user)],
):
    """Rename a passkey. 404 (not 403) when it isn't the caller's — same
    not-found shape for "missing" and "someone else's", no existence oracle."""
    row = await session.get(WebAuthnCredential, credential_id)
    if row is None or row.user_id != current.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="passkey not found")
    row.name = payload.name.strip()
    await session.commit()
    return WebAuthnCredentialOut.model_validate(row)


@router.delete("/webauthn/credentials/{credential_id}", response_model=MessageOut)
async def webauthn_delete_credential(
    credential_id: int,
    session: SessionDep,
    current: Annotated[User, Depends(_get_current_user)],
):
    """Remove a passkey. If it was the account's last MFA factor, the now-
    orphaned recovery codes are dropped so a future re-enrol issues fresh ones.
    """
    row = await session.get(WebAuthnCredential, credential_id)
    if row is None or row.user_id != current.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="passkey not found")
    await session.delete(row)
    await session.flush()

    remaining = await session.scalar(
        select(func.count())
        .select_from(WebAuthnCredential)
        .where(WebAuthnCredential.user_id == current.id)
    )
    if not remaining and not current.totp_enabled:
        await session.execute(
            delete(BackupCode).where(BackupCode.user_id == current.id)
        )
    await session.commit()
    return MessageOut(detail="ok")
