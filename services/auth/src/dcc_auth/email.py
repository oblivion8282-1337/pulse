"""SMTP sender + canned message templates for the recovery flows.

Stdlib ``smtplib`` wrapped in ``asyncio.to_thread`` instead of pulling in
``aiosmtplib`` — the volume here is tiny (forgot-password, verify-email),
so the extra dependency would not pay for itself.

**Two config sources, DB-first:** if the admin has saved an SMTP config via
the admin panel (``smtp_settings.configured = true``), that wins. Otherwise
``email.py`` falls back to the env-based ``Settings.smtp_*`` for back-compat
with deployments that pre-date the admin UI. If neither is set, ``send_email``
logs the message at INFO (``email_skipped`` marker) so a self-hoster can grab
the link out of the service log — same dev-ergonomic as before.

Tokens are ONLY ever logged via the ``email_skipped`` path. Never via SMTP
success/error log lines.
"""

from __future__ import annotations

import asyncio
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from typing import TYPE_CHECKING

import structlog
from cryptography.fernet import InvalidToken

from dcc_auth.config import get_settings
from dcc_auth.crypto import decrypt_secret
from dcc_auth.models import SmtpSettings

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = structlog.get_logger(__name__)


@dataclass(frozen=True)
class SmtpConfig:
    """Effective SMTP settings, resolved from DB-or-env at send-time."""

    host: str
    port: int
    username: str | None
    password: str | None
    from_email: str
    use_ssl: bool


async def _load_db_config(session: AsyncSession | None) -> SmtpConfig | None:
    """Return the admin-saved SMTP config, or ``None`` if not configured.

    A row whose ``configured`` flag is false is treated as absent: the admin
    UI flips that flag only on save, so the seeded id=1 row reads as "no
    config" until then. ``InvalidToken`` (JWT rotated since the password was
    encrypted) is logged + treated as not-configured rather than crashing
    the send path — the admin can re-enter the password through the UI.
    """
    if session is None:
        return None
    row = await session.get(SmtpSettings, 1)
    if row is None or not row.configured or not row.host or not row.from_email:
        return None
    try:
        password = decrypt_secret(row.password_encrypted or "")
    except InvalidToken:
        logger.warning(
            "smtp_password_undecryptable",
            hint="JWT key rotated since the SMTP password was saved — "
            "admin must re-enter via /admin (Email).",
        )
        return None
    return SmtpConfig(
        host=row.host,
        port=row.port,
        username=row.username,
        password=password or None,
        from_email=row.from_email,
        use_ssl=row.use_ssl,
    )


def _load_env_config() -> SmtpConfig | None:
    """Env-based SMTP config (back-compat). ``None`` when ``smtp_host`` is unset."""
    settings = get_settings()
    if not settings.smtp_host:
        return None
    return SmtpConfig(
        host=settings.smtp_host,
        port=settings.smtp_port,
        username=settings.smtp_user,
        password=settings.smtp_password,
        from_email=settings.smtp_from,
        use_ssl=settings.smtp_use_ssl,
    )


async def resolve_smtp_config(session: AsyncSession | None = None) -> SmtpConfig | None:
    """Public resolver — DB first, env second, ``None`` if neither is set."""
    cfg = await _load_db_config(session)
    if cfg is not None:
        return cfg
    return _load_env_config()


async def send_email(
    to: str,
    subject: str,
    body_plain: str,
    session: AsyncSession | None = None,
) -> None:
    """Send a plaintext email, or log it when SMTP isn't configured.

    Passing ``session`` lets the resolver consult the admin-managed
    ``smtp_settings`` row; callers without a session in scope (e.g. CLI /
    background-tasks that haven't been wired in yet) fall straight through
    to the env-based config.

    Raises ``smtplib.SMTPException`` (or socket / OS errors) on SMTP-side
    failure so the caller can decide whether to surface a 500 to the user
    (we DON'T re-issue tokens on failure — the user can simply re-request).
    """
    cfg = await resolve_smtp_config(session)
    if cfg is None:
        logger.info("email_skipped", to=to, subject=subject, body=body_plain)
        return

    await asyncio.to_thread(_send_smtp_sync, cfg, to, subject, body_plain)


async def send_email_with(
    cfg: SmtpConfig, to: str, subject: str, body_plain: str
) -> None:
    """Send via an explicitly-passed config — used by the admin Test-Mail
    button so the test can validate creds *before* they hit the DB."""
    await asyncio.to_thread(_send_smtp_sync, cfg, to, subject, body_plain)


def _send_smtp_sync(
    cfg: SmtpConfig, to: str, subject: str, body_plain: str
) -> None:
    msg = EmailMessage()
    msg["From"] = cfg.from_email
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body_plain)

    if cfg.use_ssl:
        # Port 465 — implicit TLS from connect.
        with smtplib.SMTP_SSL(cfg.host, cfg.port, timeout=15) as s:
            if cfg.username:
                s.login(cfg.username, cfg.password or "")
            s.send_message(msg)
    else:
        # Port 587 — STARTTLS upgrade once we've EHLO'd.
        with smtplib.SMTP(cfg.host, cfg.port, timeout=15) as s:
            s.ehlo()
            s.starttls()
            s.ehlo()
            if cfg.username:
                s.login(cfg.username, cfg.password or "")
            s.send_message(msg)


# ---- Templates ----------------------------------------------------------


def compose_password_reset_email(to: str, reset_url: str) -> tuple[str, str]:
    subject = "Pulse: Passwort zurücksetzen"
    body = (
        f"Hallo,\n\n"
        f"jemand (hoffentlich du) hat einen Passwort-Reset für das Pulse-Konto\n"
        f"mit dieser Adresse angefordert: {to}\n\n"
        f"Klick auf den folgenden Link, um ein neues Passwort zu vergeben:\n"
        f"{reset_url}\n\n"
        f"Der Link ist 1 Stunde gültig. Falls du das nicht warst, kannst du\n"
        f"diese Mail ignorieren — dein Passwort bleibt unverändert.\n"
    )
    return subject, body


def compose_email_verification(to: str, verify_url: str) -> tuple[str, str]:
    subject = "Pulse: E-Mail bestätigen"
    body = (
        f"Hallo,\n\n"
        f"bitte bestätige deine E-Mail-Adresse ({to}) für Pulse über den\n"
        f"folgenden Link:\n"
        f"{verify_url}\n\n"
        f"Der Link ist 24 Stunden gültig. Falls du Pulse nicht kennst, kannst\n"
        f"du diese Mail einfach ignorieren.\n"
    )
    return subject, body


def compose_test_email(to: str) -> tuple[str, str]:
    """Body for the admin Test-Mail button. Plain + visible "this worked"."""
    subject = "Pulse: SMTP-Test"
    body = (
        f"Hallo Admin,\n\n"
        f"wenn du diese Mail liest, ist der SMTP-Versand auf deinem Pulse-Server\n"
        f"korrekt konfiguriert. Empfänger-Adresse: {to}\n\n"
        f"Damit funktionieren ab jetzt Passwort-Reset und E-Mail-Bestätigung.\n"
    )
    return subject, body
