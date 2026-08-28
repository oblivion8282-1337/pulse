"""Periodic cleanup of stale token rows.

Three cohorts get swept once per day:

  * ``password_reset_tokens`` -- expired ``expires_at`` plus a grace window
    (defaults to 7 d) so a support engineer can still introspect a recent
    reset attempt. Used tokens fall out the same way: their ``expires_at``
    is set at issue time, so they age out alongside the unused ones.
  * ``email_verification_tokens`` -- same shape, same grace.
  * ``refresh_tokens`` -- only the *revoked* rows (``revoked_at IS NOT NULL``)
    older than ``token_cleanup_grace_days_revoked`` (default 30 d). Active /
    unexpired refresh tokens are kept regardless of age; the JWT itself
    carries the expiry the verifier checks.
  * ``username_reservations`` -- rows whose ``released_at`` has passed (Block 1.D).
  * ``revoked_credentials`` -- Grabsteine widerrufener Geraete-Zertifikate,
    deren ``expires_at`` durch ist. Keine Sekunde frueher: bis dahin haette
    das Zertifikat ohne den Widerruf gegolten, und ein frueh geraeumter
    Grabstein liesse es auf jedem Self-Host wieder aufleben (Migration 0048).

What we deliberately do **not** touch:

  * ``user_backup_codes`` -- even ``used_at`` rows stay until the user
    disables 2FA (which cascades them). They are audit-trail.
  * Non-revoked ``refresh_tokens`` rows past their ``expires_at`` -- same
    story, cheap to keep, useful for forensics. We can extend the sweep
    later once a concrete need shows up.

No APScheduler / no extra dep -- ``asyncio.sleep`` in a supervised loop
is enough at one tick per day.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from dcc_auth.browser_sessions import purge_expired_sessions
from dcc_auth.config import Settings
from dcc_auth.models import (
    EmailVerificationToken,
    PasswordResetToken,
    RefreshToken,
    UsernameReservation,
)

log = logging.getLogger(__name__)


async def _run_once(engine: AsyncEngine, settings: Settings) -> dict[str, int]:
    """Execute one sweep. Returns a per-table count for logging / tests."""
    now = datetime.now(UTC)
    expired_cutoff = now - timedelta(days=settings.token_cleanup_grace_days_expired)
    revoked_cutoff = now - timedelta(days=settings.token_cleanup_grace_days_revoked)

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        pw_res = await session.execute(
            sa_delete(PasswordResetToken).where(
                PasswordResetToken.expires_at < expired_cutoff
            )
        )
        ev_res = await session.execute(
            sa_delete(EmailVerificationToken).where(
                EmailVerificationToken.expires_at < expired_cutoff
            )
        )
        rt_res = await session.execute(
            sa_delete(RefreshToken).where(
                RefreshToken.revoked_at.is_not(None),
                RefreshToken.revoked_at < revoked_cutoff,
            )
        )
        ur_res = await session.execute(
            sa_delete(UsernameReservation).where(UsernameReservation.released_at <= now)
        )
        us_deleted = await purge_expired_sessions(session)
        await session.commit()

    counts = {
        "password_reset_tokens": pw_res.rowcount or 0,
        "email_verification_tokens": ev_res.rowcount or 0,
        "refresh_tokens_revoked": rt_res.rowcount or 0,
        "user_sessions_expired": us_deleted,
        "username_reservations_expired": ur_res.rowcount or 0,
    }
    log.info(
        "token_cleanup_done password_reset=%d email_verification=%d "
        "refresh_revoked=%d user_sessions=%d username_reservations=%d",
        counts["password_reset_tokens"],
        counts["email_verification_tokens"],
        counts["refresh_tokens_revoked"],
        counts["user_sessions_expired"],
        counts["username_reservations_expired"],
    )
    return counts


async def cleanup_loop(settings: Settings, engine: AsyncEngine) -> None:
    """Runs forever; deletes stale token rows once per ``interval_s``.

    Never re-raises -- a transient DB blip should not kill the loop forever.
    ``asyncio.CancelledError`` *is* re-raised so the lifespan-driven cancel
    actually shuts the task down.
    """
    interval_s = settings.token_cleanup_interval_seconds
    log.info("token_cleanup_loop start interval_s=%d", interval_s)
    while True:
        try:
            await _run_once(engine, settings)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("token_cleanup_failed")
        await asyncio.sleep(interval_s)


__all__ = ["cleanup_loop", "_run_once"]
