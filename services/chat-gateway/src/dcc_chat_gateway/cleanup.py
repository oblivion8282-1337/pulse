"""Periodic cleanup: long-idle Web-Push subscriptions + abgelaufene
Community-Einladungen.

**Web-Push:** ``push.py`` entfernt eine Subscription bereits bei einer
404/410-Antwort vom Push-Provider (``pywebpush`` wirft mit dem toten
Endpoint). Was das **nicht** erfasst, sind Subs, deren Endpoint weiter 2xx
antwortet, aber zu einem Browser/Gerät gehört, das der Nutzer nicht mehr
öffnet — sie bleiben abonniert und wir pushen ins Leere.

Der Sweep löscht eine Zeile, wenn:

  * ``created_at`` älter als ``push_subscription_idle_days`` ist
    (Vorgabe 60 Tage) — frische Subs bleiben unabhängig von Nutzung
    stehen, damit ein Nutzer, der abonniert aber erst Wochen später eine
    Benachrichtigung sieht, seinen Kanal nicht verliert,
  * **und** ``last_used_at`` entweder NULL ist oder ebenfalls älter als
    dieselbe Grenze — eine kürzlich zustellende Sub bleibt also stehen.

**Community-Einladungen:** ``community_invite_notifications`` trägt
``expires_at`` (nullable), das beim Erstellen befüllt wird, aber bis
2026-08-28 nie ausgewertet wurde — eine abgelaufene Einladung blieb in
der Inbox stehen und der Annehmen-Versuch lief ins Leere. Der Sweep
räumt sie weg (Details bei ``sweep_abgelaufene_einladungen``).

Gleiches Muster wie ``routes.attachments.reaper_loop`` (sleep-getriebene
asyncio-Schleife, Fehler geloggt + geschluckt, ``CancelledError`` erneut
geworfen).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete as sa_delete
from sqlalchemy import or_
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from dcc_chat_gateway.config import Settings
from dcc_chat_gateway.models import CommunityInviteNotification, WebPushSubscription

log = logging.getLogger(__name__)


async def sweep_abgelaufene_einladungen(session: AsyncSession) -> int:
    """Löscht Community-Einladungen, deren ``expires_at`` in der Vergangenheit liegt.

    ``expires_at IS NULL`` heisst „verfällt nie" (Cloud-Ziel) und wird deshalb
    **ausdrücklich** ausgeschlossen — SQLs Drei-Werte-Logik würde einen
    ``< now()``-Vergleich mit NULL ohnehin als unbekannt (nicht wahr) werten,
    aber das soll hier keine implizite Nebenwirkung sein, sondern lesbar im
    Code stehen. Committet nicht selbst (Aufrufer entscheidet).
    """
    now = datetime.now(UTC)
    res = await session.execute(
        sa_delete(CommunityInviteNotification).where(
            CommunityInviteNotification.expires_at.is_not(None),
            CommunityInviteNotification.expires_at < now,
        )
    )
    deleted = res.rowcount or 0
    log.info("community_invite_cleanup_done deleted=%d", deleted)
    return deleted


async def _run_once(engine: AsyncEngine, settings: Settings) -> int:
    """Führt einen Sweep-Durchlauf beider Aufräumarten aus.

    Returns die Zahl der gelöschten Web-Push-Subscriptions (der bisherige,
    von Aufrufern ausgewertete Rückgabewert bleibt unverändert; die
    Einladungs-Aufräumung läuft in derselben Transaktion mit).
    """
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
        await sweep_abgelaufene_einladungen(session)
        await session.commit()
    deleted = res.rowcount or 0
    log.info("push_subscription_cleanup_done deleted=%d", deleted)
    return deleted


async def cleanup_loop(settings: Settings, engine: AsyncEngine) -> None:
    """Läuft dauerhaft; sweept stale Subscriptions UND abgelaufene
    Community-Einladungen einmal pro ``cleanup_interval_seconds`` (eine
    einzige Schleife, kein zweiter Timer für die Einladungen).

    Fehler werden geloggt, die Schleife läuft weiter. ``CancelledError``
    wird erneut geworfen, damit der Lifespan-Shutdown den Task tatsächlich
    stoppt.
    """
    interval_s = settings.cleanup_interval_seconds
    log.info(
        "push_subscription_cleanup_loop start interval_s=%d idle_days=%d",
        interval_s,
        settings.push_subscription_idle_days,
    )
    while True:
        # Erst schlafen, dann sweepen — gleiche Test-Isolation wie der attachments
        # reaper: so läuft in kurzlebigen Lifespan-Tests keine DB-Iteration, die
        # beim Engine-Disposal einen Greenlet-/Connection-Fehler werfen könnte.
        await asyncio.sleep(interval_s)
        try:
            await _run_once(engine, settings)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("push_subscription_cleanup_failed")


__all__ = ["cleanup_loop", "_run_once", "sweep_abgelaufene_einladungen"]
