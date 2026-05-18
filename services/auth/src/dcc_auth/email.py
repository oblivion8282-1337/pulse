"""SMTP sender + canned message templates for the recovery flows.

Stdlib ``smtplib`` wrapped in ``asyncio.to_thread`` instead of pulling in
``aiosmtplib`` — the volume here is tiny (forgot-password, verify-email),
so the extra dependency would not pay for itself.

Dev / self-hoster ergonomics: when ``settings.smtp_host`` is unset, the
sender logs the full message body at INFO so the operator can grab the
reset link out of the service log instead of needing a working SMTP server
to test recovery. Tokens are ONLY ever logged via this one path and ONLY
at INFO with a clear ``email_skipped`` marker — never via the actual
SMTP success/error paths.
"""

from __future__ import annotations

import asyncio
import smtplib
from email.message import EmailMessage

import structlog

from dcc_auth.config import get_settings

logger = structlog.get_logger(__name__)


async def send_email(to: str, subject: str, body_plain: str) -> None:
    """Send a plaintext email, or log it when SMTP isn't configured.

    Raises ``smtplib.SMTPException`` (or socket / OS errors) on SMTP-side
    failure so the caller can decide whether to surface a 500 to the user
    (we DON'T re-issue tokens on failure — the user can simply re-request).
    """
    settings = get_settings()

    if not settings.smtp_host:
        # Dev / self-host without SMTP — surface the link + body in the log.
        logger.info(
            "email_skipped",
            to=to,
            subject=subject,
            body=body_plain,
        )
        return

    await asyncio.to_thread(_send_smtp_sync, to, subject, body_plain)


def _send_smtp_sync(to: str, subject: str, body_plain: str) -> None:
    settings = get_settings()
    msg = EmailMessage()
    msg["From"] = settings.smtp_from
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body_plain)

    if settings.smtp_use_ssl:
        # Port 465 — implicit TLS from connect.
        with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=15) as s:
            if settings.smtp_user:
                s.login(settings.smtp_user, settings.smtp_password or "")
            s.send_message(msg)
    else:
        # Port 587 — STARTTLS upgrade once we've EHLO'd.
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as s:
            s.ehlo()
            s.starttls()
            s.ehlo()
            if settings.smtp_user:
                s.login(settings.smtp_user, settings.smtp_password or "")
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
