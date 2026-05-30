"""SMTP sender + canned message templates for the recovery flows.

Stdlib ``smtplib`` wrapped in ``asyncio.to_thread`` instead of pulling in
``aiosmtplib`` — the volume here is tiny (forgot-password, verify-email),
so the extra dependency would not pay for itself.

**Two config sources, DB-first:** if the admin has saved an SMTP config via
the admin panel (``smtp_settings.configured = true``), that wins. Otherwise
``email.py`` falls back to the env-based ``Settings.smtp_*`` for back-compat
with deployments that pre-date the admin UI. If neither is set, ``send_email``
logs only the recipient and subject at INFO (``email_skipped`` marker) — the
body (which may contain reset tokens) is intentionally omitted to keep tokens
out of log aggregators.

Tokens are NEVER logged — not on ``email_skipped``, not on SMTP success/error.
"""

from __future__ import annotations

import asyncio
import smtplib
import ssl
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from typing import TYPE_CHECKING

import structlog
from cryptography.fernet import InvalidToken
from sqlalchemy import update

from dcc_auth.config import get_settings
from dcc_auth.crypto import decrypt_secret
from dcc_auth.models import EmailVerificationToken, SmtpSettings
from dcc_auth.recovery import generate_token

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from dcc_auth.models import User

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
        logger.info("email_skipped", to=to, subject=subject)
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

    ctx = ssl.create_default_context()
    if cfg.use_ssl:
        # Port 465 — implicit TLS from connect.
        with smtplib.SMTP_SSL(cfg.host, cfg.port, timeout=15, context=ctx) as s:
            if cfg.username:
                s.login(cfg.username, cfg.password or "")
            s.send_message(msg)
    else:
        # Port 587 — STARTTLS upgrade once we've EHLO'd.
        with smtplib.SMTP(cfg.host, cfg.port, timeout=15) as s:
            s.ehlo()
            s.starttls(context=ctx)
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


def compose_email_change_verification(new_email: str, verify_url: str) -> tuple[str, str]:
    """Sent to the NEW address — clicking the link finalises the change."""
    subject = "Pulse: Neue E-Mail-Adresse bestätigen"
    body = (
        f"Hallo,\n\n"
        f"für dein Pulse-Konto wurde ein Wechsel der E-Mail-Adresse zu dieser\n"
        f"Adresse ({new_email}) angefordert. Bestätige den Wechsel über den\n"
        f"folgenden Link:\n"
        f"{verify_url}\n\n"
        f"Der Link ist 24 Stunden gültig. Erst nach dem Klick wird die Adresse\n"
        f"geändert. Falls du das nicht warst, kannst du diese Mail ignorieren.\n"
    )
    return subject, body


def compose_email_change_notice(old_email: str, new_email: str) -> tuple[str, str]:
    """Heads-up sent to the OLD address when a change is requested."""
    subject = "Pulse: E-Mail-Änderung angefordert"
    body = (
        f"Hallo,\n\n"
        f"für dein Pulse-Konto wurde angefordert, die E-Mail-Adresse von\n"
        f"{old_email} auf {new_email} zu ändern. Die Änderung wird erst aktiv,\n"
        f"wenn der Bestätigungslink an die neue Adresse angeklickt wird.\n\n"
        f"Warst du das nicht? Dann ändere umgehend dein Passwort — jemand mit\n"
        f"Zugang zu deinem Konto könnte versuchen, die Adresse zu übernehmen.\n"
    )
    return subject, body


async def issue_verification_email(session: AsyncSession, user: User) -> None:
    """Invalidate prior open verify-tokens, issue a fresh one, send the mail.

    Shared by ``POST /register`` (best-effort — caller swallows SMTP errors
    so a flaky mail relay can't abort a registration) and
    ``POST /email/verification/send`` (caller bubbles errors so the UI can
    surface them). The DB-side work (token row) happens BEFORE the wire-side
    send, so even if SMTP fails the row exists and the user can resend via
    the banner.

    Does NOT commit — the caller controls the transaction boundary.
    """
    settings = get_settings()
    now = datetime.now(UTC)
    await session.execute(
        update(EmailVerificationToken)
        .where(
            EmailVerificationToken.user_id == user.id,
            EmailVerificationToken.used_at.is_(None),
        )
        .values(used_at=now)
    )
    plaintext, digest = generate_token()
    session.add(
        EmailVerificationToken(
            user_id=user.id,
            token_hash=digest,
            expires_at=now + timedelta(seconds=settings.email_verification_ttl_seconds),
        )
    )
    verify_url = f"{settings.app_base_url.rstrip('/')}/verify-email/{plaintext}"
    subject, body = compose_email_verification(user.email, verify_url)
    await send_email(user.email, subject, body, session=session)


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
