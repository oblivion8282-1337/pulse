"""Periodic cleanup of long-idle Web-Push subscriptions.

``push.py`` already removes a sub on a 404/410 response from the push
provider (``pywebpush`` raises with the dead endpoint). What it does
**not** catch are subs whose endpoints still answer 2xx but belong to
browsers / devices the user no longer opens — they just stay subscribed
and we keep pushing into the void.

The sweep below deletes a row when:

  * ``created_at`` is older than ``push_subscription_idle_days``
    (default 60 d) — fresh subs are kept regardless of usage, so users
    who subscribe but only see a notification weeks later don't lose
    their channel,
  * **and** either ``last_used_at`` is NULL or it's older than the same
    cutoff — so a sub that recently delivered something stays.

Same pattern as ``routes.attachments.reaper_loop`` (sleep-driven asyncio
loop, errors logged + swallowed, ``CancelledError`` re-raised).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete as sa_delete
from sqlalchemy import or_
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from dcc_chat_gateway.config import Settings
from dcc_chat_gateway.models import WebPushSubscription

log = logging.getLogger(__name__)


async def _run_once(engine: AsyncEngine, settings: Settings) -> int:
    """Execute one sweep. Returns the number of rows deleted."""
    cutoff = datetime.now(UTC) - timedelta(days=settings.push_subscription_idle_days)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        res = await session.execute(
            sa_delete(WebPushSubscription).where(
                WebPushSubscription.created_at < cutoff,
                or_(
                    WebPushSubscription.last_used_at.is_(None),
                    WebPushSubscription.last_used_at < cutoff,
                ),
            )
        )
        await session.commit()
    deleted = res.rowcount or 0
    log.info("push_subscription_cleanup_done deleted=%d", deleted)
    return deleted


async def cleanup_loop(settings: Settings, engine: AsyncEngine) -> None:
    """Runs forever; sweeps stale subscriptions once per ``cleanup_interval_seconds``.

    Errors are logged and the loop continues. ``CancelledError`` re-raises
    so the lifespan shutdown actually stops the task.
    """
    interval_s = settings.cleanup_interval_seconds
    log.info(
        "push_subscription_cleanup_loop start interval_s=%d idle_days=%d",
        interval_s,
        settings.push_subscription_idle_days,
    )
    while True:
        try:
            await _run_once(engine, settings)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("push_subscription_cleanup_failed")
        await asyncio.sleep(interval_s)


__all__ = ["cleanup_loop", "_run_once"]
