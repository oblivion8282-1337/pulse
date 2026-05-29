"""Admin-only routes for the SMTP config singleton.

Split out from ``routes_admin.py`` to keep both files under the 350-line
file-size cap. Mounts under the same ``/admin`` prefix — semantically
adjacent to the existing ``/admin/settings`` (auth-settings) endpoints.

Three endpoints:

* ``GET    /admin/smtp``      — read singleton (password never returned)
* ``PATCH  /admin/smtp``      — write singleton (audit-logged)
* ``POST   /admin/smtp/test`` — fire-once test mail (never persists)

Test-mail accepts an inline override of every field so the admin can
validate fresh credentials *before* committing them to the DB. Errors
from the SMTP transport are caught + surfaced verbatim to the UI so the
admin can read the real auth-failure / DNS-error / TLS message instead
of digging through container logs.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import update

from dcc_auth.crypto import decrypt_secret, encrypt_secret
from dcc_auth.db import SessionDep
from dcc_auth.email import SmtpConfig, compose_test_email, send_email_with
from dcc_auth.models import SmtpSettings, User
from dcc_auth.routes import _invalidate_smtp_cache, _require_admin
from dcc_auth.routes_admin import _audit
from dcc_auth.schemas import (
    SmtpSettingsOut,
    SmtpSettingsPatch,
    SmtpTestIn,
    SmtpTestOut,
)

router = APIRouter(prefix="/admin")


def _smtp_out(row: SmtpSettings) -> SmtpSettingsOut:
    """Shape a DB row into the admin-facing payload — no password leakage."""
    return SmtpSettingsOut(
        provider=row.provider,  # type: ignore[arg-type]
        host=row.host,
        port=row.port,
        username=row.username,
        from_email=row.from_email,
        use_ssl=row.use_ssl,
        configured=row.configured,
        has_password=bool(row.password_encrypted),
    )


@router.get("/smtp", response_model=SmtpSettingsOut)
async def get_smtp_settings(
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
):
    """Read the SMTP config singleton.

    The password is never returned in plaintext or ciphertext — the UI
    reads ``has_password`` to decide whether to render the password field
    as "set (leave blank to keep)" vs. "empty".
    """
    row = await session.get(SmtpSettings, 1)
    if row is None:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="smtp_settings singleton missing — re-run migration 0008",
        )
    return _smtp_out(row)


@router.patch("/smtp", response_model=SmtpSettingsOut)
async def patch_smtp_settings(
    payload: SmtpSettingsPatch,
    session: SessionDep,
    actor: Annotated[User, Depends(_require_admin)],
):
    """Update the SMTP config singleton.

    Password handling:

    * ``password is None`` ⇒ preserve the existing ciphertext — so an
      admin editing only the From-Email doesn't have to re-type the
      password.
    * ``password == ""``    ⇒ explicitly clear the stored password.
    * Otherwise              ⇒ encrypt + store.

    ``configured`` flips to ``true`` whenever ``host`` and ``from_email``
    are both non-empty after the patch — that's the gate ``email.py``
    inspects to decide between DB-config and env-fallback.

    The audit-log payload deliberately omits the new password — only "did
    the password change?" is recorded.
    """
    row = await session.get(SmtpSettings, 1)
    if row is None:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="smtp_settings singleton missing — re-run migration 0008",
        )

    fields = ("provider", "host", "port", "username", "from_email", "use_ssl")
    before = {k: getattr(row, k) for k in fields} | {"configured": row.configured}

    row.provider = payload.provider
    row.host = payload.host
    row.port = payload.port
    row.username = payload.username
    row.from_email = payload.from_email
    row.use_ssl = payload.use_ssl

    password_changed = False
    if payload.password is not None:
        row.password_encrypted = encrypt_secret(payload.password)
        password_changed = True

    row.configured = bool(row.host and row.from_email)

    # SMTP just went unconfigured → configured: this is the moment the
    # email-verification gate switches on. Grandfather every still-unverified
    # account as verified so nobody who registered *before* SMTP existed gets
    # retroactively locked out — only registrations after this point face the
    # gate. (Mirrors the deploy-time grandfather migration; this covers users
    # who signed up between deploy and the admin enabling SMTP.)
    smtp_just_enabled = not before["configured"] and row.configured
    grandfathered = 0
    if smtp_just_enabled:
        result = await session.execute(
            update(User)
            .where(User.email_verified_at.is_(None))
            .values(email_verified_at=datetime.now(UTC))
        )
        grandfathered = result.rowcount or 0

    after = {k: getattr(row, k) for k in fields} | {"configured": row.configured}
    diff: dict[str, dict] = {
        k: {"from": before[k], "to": after[k]} for k in after if before[k] != after[k]
    }
    if password_changed:
        diff["password"] = {"changed": True}
    if grandfathered:
        diff["grandfathered_users"] = {"count": grandfathered}

    if diff:
        _audit(session, actor_id=actor.id, action="smtp.patch", payload=diff)
        await session.commit()
        await session.refresh(row)
        # Flush the 60-second SmtpConfig cache so the email gate picks up the
        # new settings immediately instead of waiting up to one minute.
        _invalidate_smtp_cache()
    return _smtp_out(row)


@router.post("/smtp/test", response_model=SmtpTestOut)
async def test_smtp(
    payload: SmtpTestIn,
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
):
    """Send a one-shot test mail. Never persists anything.

    Three call shapes the UI uses:

    1. **Empty body** (only ``to``) — uses the saved row as-is. Lets the
       admin retest after editing something else without re-typing the
       password.
    2. **Full body** — overrides every field, lets the admin test fresh
       credentials *before* the first Save.
    3. **Mixed** — omitted fields fall back to the saved row. A ``null``
       password specifically falls back to the stored ciphertext
       (decrypted in-memory for the test only).

    Errors are caught + sanitised → ``ok=false, error="..."``. The UI
    shows that string verbatim so the admin sees the real SMTP server
    response (auth failure, DNS error, TLS handshake fail, etc.)
    without having to read container logs.
    """
    saved = await session.get(SmtpSettings, 1)

    host = payload.host if payload.host is not None else (saved.host if saved else None)
    port = payload.port if payload.port is not None else (saved.port if saved else 587)
    username = (
        payload.username
        if payload.username is not None
        else (saved.username if saved else None)
    )
    from_email = (
        payload.from_email
        if payload.from_email is not None
        else (saved.from_email if saved else None)
    )
    use_ssl = (
        payload.use_ssl
        if payload.use_ssl is not None
        else (saved.use_ssl if saved else False)
    )

    if payload.password is not None:
        password: str | None = payload.password or None
    elif saved is not None and saved.password_encrypted:
        try:
            password = decrypt_secret(saved.password_encrypted) or None
        except Exception:  # noqa: BLE001 — any decrypt failure ⇒ surface to admin
            return SmtpTestOut(
                ok=False,
                error=(
                    "Gespeicherter Passwort-Eintrag konnte nicht entschlüsselt "
                    "werden (JWT-Key rotiert?). Passwort neu eingeben und "
                    "erneut testen."
                ),
            )
    else:
        password = None

    if not host or not from_email:
        return SmtpTestOut(
            ok=False, error="Host und Absender-Adresse müssen gesetzt sein."
        )

    cfg = SmtpConfig(
        host=host,
        port=port,
        username=username,
        password=password,
        from_email=from_email,
        use_ssl=use_ssl,
    )
    subject, body = compose_test_email(payload.to)
    try:
        await send_email_with(cfg, payload.to, subject, body)
    except Exception as exc:  # noqa: BLE001 — broad: SMTP errors are diverse
        return SmtpTestOut(ok=False, error=f"{type(exc).__name__}: {exc}")
    return SmtpTestOut(ok=True)
