"""WebAuthn / passkey routes — the login ceremony.

Split from ``routes_webauthn.py`` because these endpoints run *before* a
bearer token exists. The same options→verify pair serves two flows:

* **2FA second step** — the request carries an ``mfa_ticket`` from the
  password ``/login`` step; options are scoped to that user's passkeys.
* **Passwordless login** — no ``mfa_ticket``; a discoverable assertion
  identifies the user via its ``userHandle``. User verification is forced,
  so the assertion alone is genuine MFA and no password is needed.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

import jwt
import structlog
import webauthn
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from webauthn.helpers import base64url_to_bytes

from dcc_auth.browser_sessions import create_session, set_session_cookie
from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models import User, WebAuthnCredential
from dcc_auth.passkeys import (
    PURPOSE_AUTHENTICATE,
    build_authentication_options,
    decode_challenge_ticket,
    issue_challenge_ticket,
    load_user_credentials,
)
from dcc_auth.recovery import decode_mfa_ticket
from dcc_auth.routes import _check_rate, _client_ip, _hash_ip, _issue_tokens, _signer_dep
from dcc_auth.schemas import (
    TokensOut,
    WebAuthnLoginOptionsIn,
    WebAuthnLoginVerifyIn,
    WebAuthnOptionsOut,
)
from dcc_auth.security import JwtSigner

router = APIRouter()
log = structlog.get_logger(__name__)


def _user_handle_id(credential: dict) -> int | None:
    """Decode the snowflake user-id a discoverable assertion echoes back."""
    resp = credential.get("response") or {}
    handle = resp.get("userHandle")
    if not handle:
        return None
    try:
        return int(base64url_to_bytes(handle).decode("ascii"))
    except (ValueError, UnicodeDecodeError):
        return None


@router.post("/login/webauthn/options", response_model=WebAuthnOptionsOut)
async def webauthn_login_options(
    payload: WebAuthnLoginOptionsIn,
    request: Request,
    session: SessionDep,
    signer: Annotated[JwtSigner, Depends(_signer_dep)],
):
    """Issue ``get()`` options. With an ``mfa_ticket`` the prompt is scoped to
    the pinned user's passkeys; without one it is a discoverable login."""
    settings = get_settings()
    await _check_rate(request, "webauthn_login", settings.rate_limit_webauthn_login)
    user_id: int | None = None
    allow: list[WebAuthnCredential] | None = None
    if payload.mfa_ticket:
        try:
            user_id = decode_mfa_ticket(signer, payload.mfa_ticket)
        except jwt.PyJWTError as exc:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, detail="invalid or expired ticket"
            ) from exc
        allow = await load_user_credentials(session, user_id)
        if not allow:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, detail="no passkey on this account"
            )
    options, challenge = build_authentication_options(settings, allow=allow)
    ticket = issue_challenge_ticket(
        signer,
        purpose=PURPOSE_AUTHENTICATE,
        challenge=challenge,
        user_id=user_id,
        ttl_seconds=settings.webauthn_challenge_ttl_seconds,
    )
    return WebAuthnOptionsOut(options=options, challenge_ticket=ticket)


@router.post("/login/webauthn/verify", response_model=TokensOut)
async def webauthn_login_verify(
    payload: WebAuthnLoginVerifyIn,
    request: Request,
    response: Response,
    session: SessionDep,
    signer: Annotated[JwtSigner, Depends(_signer_dep)],
):
    """Verify the assertion and issue the token pair.

    On the 2FA path the ``mfa_ticket`` (password step) and the challenge ticket
    must name the same user — neither alone is sufficient. On the passwordless
    path the user is taken from the assertion's ``userHandle`` and the passkey
    must have done user verification.
    """
    settings = get_settings()
    await _check_rate(request, "webauthn_login", settings.rate_limit_webauthn_login)
    try:
        challenge, challenge_user_id = decode_challenge_ticket(
            signer, payload.challenge_ticket, expected_purpose=PURPOSE_AUTHENTICATE
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid or expired challenge"
        ) from exc

    passwordless = challenge_user_id is None
    if not passwordless:
        if not payload.mfa_ticket:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, detail="missing mfa ticket"
            )
        try:
            mfa_user_id = decode_mfa_ticket(signer, payload.mfa_ticket)
        except jwt.PyJWTError as exc:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, detail="invalid or expired ticket"
            ) from exc
        if mfa_user_id != challenge_user_id:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="ticket mismatch")

    raw_id = payload.credential.get("id") or payload.credential.get("rawId")
    if not raw_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="malformed assertion")
    row = await session.scalar(
        select(WebAuthnCredential).where(
            WebAuthnCredential.credential_id == str(raw_id)
        )
    )
    if row is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="unknown passkey")

    # Resolve which account this assertion proves, then require the matched
    # credential to actually belong to it.
    if passwordless:
        target_user_id = _user_handle_id(payload.credential) or row.user_id
    else:
        target_user_id = challenge_user_id
    if row.user_id != target_user_id:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="passkey does not match account"
        )
    user = await session.get(User, target_user_id)
    if user is None or user.disabled or user.is_suspended:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")

    try:
        verified = webauthn.verify_authentication_response(
            credential=payload.credential,
            expected_challenge=challenge,
            expected_rp_id=settings.webauthn_rp_id,
            expected_origin=settings.webauthn_origins_list,
            credential_public_key=base64url_to_bytes(row.public_key),
            credential_current_sign_count=row.sign_count,
            require_user_verification=passwordless,
        )
    except Exception as exc:  # noqa: BLE001 — webauthn raises a wide hierarchy
        log.warning(
            "webauthn_login_verify_failed", user_id=target_user_id, error=str(exc)
        )
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="passkey verification failed"
        ) from exc

    row.sign_count = verified.new_sign_count
    row.last_used_at = datetime.now(UTC)
    user_agent = request.headers.get("user-agent")
    tokens = await _issue_tokens(
        session,
        user,
        signer=signer,
        user_agent=user_agent,
        ip_hash=_hash_ip(request),
    )
    # Browser-Session-Cookie wie beim Passwort-Login — sonst sind die cookie-only
    # Cert-/Backup-/Profile-Endpoints für Passkey-User unerreichbar (401). Ein
    # Passkey mit user-verification (passwordless) bzw. Passwort+Passkey (2FA) ist
    # vollwertige MFA → acr="1" (erfüllt den mfa_step_up_required-Gate).
    amr = ["webauthn"] if passwordless else ["pwd", "webauthn"]
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
