"""WebAuthn / passkey helpers — challenge tickets + ceremony option building.

Keeps ``routes_webauthn.py`` thin and confines every call into the third-party
``webauthn`` library to this one module.

The two ceremonies (registration, authentication) each run as an
options→verify pair. Between the two HTTP calls the server must remember the
random challenge it issued. Rather than a DB/Redis round-trip we mint a
short-lived RS256 JWT — the *challenge ticket* — carrying the challenge, and
hand it to the client to post back. Same trick as the MFA ticket in
``recovery.py``; the signature makes the ticket unforgeable, the ``exp``
makes a captured one near-useless.
"""

from __future__ import annotations

import json
import secrets
import time
from typing import Any

import jwt
import webauthn
from sqlalchemy import select
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    AuthenticatorTransport,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from dcc_auth.config import Settings
from dcc_auth.models import WebAuthnCredential
from dcc_auth.security import JwtSigner

# Challenge-ticket ``purpose`` values — checked on decode so a registration
# ticket can never be replayed into the authentication verify step.
PURPOSE_REGISTER = "webauthn-register"
PURPOSE_AUTHENTICATE = "webauthn-authenticate"

_VALID_TRANSPORTS = {t.value for t in AuthenticatorTransport}


async def load_user_credentials(session, user_id: int) -> list[WebAuthnCredential]:
    """All of a user's registered passkeys, oldest first.

    Shared by both route modules — registration (``excludeCredentials``) and
    login (``allowCredentials`` + the post-assertion ownership check).
    """
    rows = await session.execute(
        select(WebAuthnCredential)
        .where(WebAuthnCredential.user_id == user_id)
        .order_by(WebAuthnCredential.created_at)
    )
    return list(rows.scalars().all())


# ---- challenge ticket (JWT) --------------------------------------------


def issue_challenge_ticket(
    signer: JwtSigner,
    *,
    purpose: str,
    challenge: bytes,
    user_id: int | None,
    ttl_seconds: int,
) -> str:
    """Mint the JWT that bridges an options call and its verify call.

    ``user_id`` is stamped for registration (always a known user) and for the
    2FA second step (the user is pinned by the password step); it is ``None``
    for passwordless login, where the user is only discovered from the
    assertion's ``userHandle`` at verify time.
    """
    now = int(time.time())
    payload: dict[str, Any] = {
        # Stamp ``iss`` / ``aud`` (validated in ``decode_challenge_ticket``) so a
        # ticket minted by a different environment sharing this keypair cannot be
        # replayed into our verify step. The ``purpose`` claim alone is too weak.
        "iss": signer._settings.jwt_issuer,  # noqa: SLF001 — mirrors issue_access
        "aud": signer._settings.jwt_audience,  # noqa: SLF001
        "iat": now,
        "exp": now + ttl_seconds,
        "purpose": purpose,
        "challenge": bytes_to_base64url(challenge),
        # Random single-use id: the verify handler claims it in Redis so a captured
        # challenge ticket can't be replayed within its TTL to mint a second token
        # pair (acute for passwordless login + sign_count=0 authenticators).
        "jti": secrets.token_hex(16),
    }
    if user_id is not None:
        payload["sub"] = str(user_id)
    # Sign with the private key directly — same as ``recovery.issue_mfa_ticket``,
    # we deliberately skip the iss/aud claims that ``issue_access`` adds.
    return jwt.encode(
        payload,
        signer._private_key,  # noqa: SLF001 — no public accessor, mirrors recovery.py
        algorithm="RS256",
        headers={"kid": signer._settings.jwt_key_id},  # noqa: SLF001
    )


def decode_challenge_ticket(
    signer: JwtSigner, ticket: str, *, expected_purpose: str
) -> tuple[bytes, int | None, str | None]:
    """Return ``(challenge_bytes, user_id|None, jti|None)`` from a valid ticket.

    The ``jti`` lets the verify handler claim the ticket as single-use (replay
    guard); it is ``None`` only for legacy tickets minted before single-use
    enforcement existed (in-flight during a deploy).

    Raises ``jwt.PyJWTError`` on expiry, bad signature, or a purpose mismatch.
    """
    payload = jwt.decode(
        ticket,
        signer.public_key,
        algorithms=["RS256"],
        audience=signer._settings.jwt_audience,  # noqa: SLF001 — mirrors JwtSigner.decode
        issuer=signer._settings.jwt_issuer,  # noqa: SLF001
        options={"require": ["exp"]},
    )
    if payload.get("purpose") != expected_purpose:
        raise jwt.InvalidTokenError("wrong challenge-ticket purpose")
    challenge = base64url_to_bytes(payload["challenge"])
    sub = payload.get("sub")
    jti = payload.get("jti")
    return (
        challenge,
        (int(sub) if sub is not None else None),
        (str(jti) if jti else None),
    )


# ---- ceremony option building ------------------------------------------


def _descriptors(creds: list[WebAuthnCredential]) -> list[PublicKeyCredentialDescriptor]:
    """Map stored credential rows to the spec's credential descriptors.

    Used both for ``excludeCredentials`` (registration — don't enrol the same
    authenticator twice) and ``allowCredentials`` (2FA login — scope the
    prompt to keys this account actually owns).
    """
    out: list[PublicKeyCredentialDescriptor] = []
    for c in creds:
        transports = None
        if c.transports:
            transports = [
                AuthenticatorTransport(t) for t in c.transports if t in _VALID_TRANSPORTS
            ]
        out.append(
            PublicKeyCredentialDescriptor(
                id=base64url_to_bytes(c.credential_id),
                transports=transports or None,
            )
        )
    return out


def build_registration_options(
    settings: Settings,
    *,
    user_id: int,
    username: str,
    display_name: str | None,
    existing: list[WebAuthnCredential],
) -> tuple[dict, bytes]:
    """Return ``(options_json, challenge)`` for ``navigator.credentials.create``.

    The user handle is the account's snowflake id as ASCII bytes — that's what
    a discoverable (passwordless) assertion later echoes back in ``userHandle``
    to identify who is logging in.
    """
    opts = webauthn.generate_registration_options(
        rp_id=settings.webauthn_rp_id,
        rp_name=settings.webauthn_rp_name,
        user_name=username,
        user_id=str(user_id).encode("ascii"),
        user_display_name=display_name or username,
        exclude_credentials=_descriptors(existing),
        authenticator_selection=AuthenticatorSelectionCriteria(
            # PREFERRED resident key → the credential is discoverable, which is
            # what makes the "Sign in with a passkey" button (no username
            # typed) work. PREFERRED rather than REQUIRED so older roaming
            # security keys without storage still enrol.
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.PREFERRED,
        ),
    )
    return json.loads(webauthn.options_to_json(opts)), opts.challenge


def build_authentication_options(
    settings: Settings, *, allow: list[WebAuthnCredential] | None
) -> tuple[dict, bytes]:
    """Return ``(options_json, challenge)`` for ``navigator.credentials.get``.

    ``allow=None`` is the passwordless path: an empty ``allowCredentials`` lets
    the browser surface every discoverable passkey for this RP, and user
    verification is forced REQUIRED so the assertion alone is genuine MFA
    (possession + biometrics/PIN) and no password step is needed.
    """
    opts = webauthn.generate_authentication_options(
        rp_id=settings.webauthn_rp_id,
        allow_credentials=_descriptors(allow) if allow else None,
        user_verification=(
            UserVerificationRequirement.PREFERRED
            if allow
            else UserVerificationRequirement.REQUIRED
        ),
    )
    return json.loads(webauthn.options_to_json(opts)), opts.challenge
