"""Periodic cleanup of long-idle Web-Push subscriptions, and (since Etappe D,
Task 4) the Postfach.

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

The Postfach sweep (``postfach_pflege.py::sweep_verfallene_zustellungen`` +
``sweep_verwaiste_nutzlasten`` + ``sweep_verwaiste_anhaenge``), der
Kopplungs-Lauf (``kopplung_pflege.py``) und der Geraete-Verfall
(``schluessel_verfall.py::sweep_verfallene_geraete``) reiten auf DERSELBEN
Schleife und demselben Takt — keine zweite Hintergrundaufgabe, s. ``_run_once``
unten.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete as sa_delete
from sqlalchemy import or_
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from dcc_chat_gateway.ablage_kanal_nachtrag import nachtrag_sweep as sweep_ablage_kanal_nachtraege
from dcc_chat_gateway.ablage_zwischenlager_pflege import sweep_alte_zwischenlager_dateien
from dcc_chat_gateway.config import Settings
from dcc_chat_gateway.kopplung_pflege import sweep_verfallene_kopplungen
from dcc_chat_gateway.models import WebPushSubscription
from dcc_chat_gateway.postfach_pflege import (
    sweep_abgelaufene_anhaenge,
    sweep_verfallene_zustellungen,
    sweep_verwaiste_anhaenge,
    sweep_verwaiste_nutzlasten,
)
from dcc_chat_gateway.schluessel_verfall import sweep_verfallene_geraete

log = logging.getLogger(__name__)


async def _lauf(name: str, aufgabe: Awaitable[None]) -> None:
    """Ein Teil-Sweep, dessen Fehlschlag die anderen NICHT mitnimmt.

    Vorher lagen alle Sweeps in einer einzigen Funktion ohne eigenes
    ``try``: der erste Fehler (eine fremde Cloud, ein DB-Deadlock) brach den
    ganzen Lauf ab, und alles dahinter — Postfach-Verfall, Kopplungen,
    Geraete, Anhaenge — blieb bis zum naechsten Takt liegen, ohne dass
    irgendwo stand, WELCHER Teil gefehlt hat.
    """
    try:
        await aufgabe
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001
        log.exception("cleanup_teil_fehlgeschlagen teil=%s", name)


async def _push_sweep(session_factory: async_sessionmaker, cutoff: datetime) -> int:
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


async def _nachtrag_sweep(session_factory: async_sessionmaker) -> None:
    """Nachtraege des Kanal-Ordner-Ablegers (Task 3/4, Entwurf 2026-09-02) —
    Umschlaege, deren Festigung noch aussteht. Kein Log mit einer Adresse,
    nur die Anzahlen.

    **VOR ``sweep_verwaiste_nutzlasten``**, nicht am Ende: der Nachtrag
    braucht die Nutzlast, die jener Lauf loescht (sie ist quittiert und damit
    zustellungslos). Andersherum verloere jeder Takt genau die Umschlaege,
    die gerade noch nachzuholen waren. Der zweite Riegel dafuer steht in
    ``sweep_verwaiste_nutzlasten`` selbst.
    """
    async with session_factory() as session:
        nachtraege, aufgegeben = await sweep_ablage_kanal_nachtraege(session)
    log.info("ablage_kanal_nachtrag_done erledigt=%d aufgegeben=%d", nachtraege, aufgegeben)


async def _postfach_sweeps(session_factory: async_sessionmaker) -> None:
    async with session_factory() as session:
        verfallen = await sweep_verfallene_zustellungen(session)
        verwaist = await sweep_verwaiste_nutzlasten(session)
        # Reihenfolge: erst die Nutzlasten, dann die Anhaenge. Ein Anhang
        # gilt genau dann als verwaist, wenn seine letzte Nutzlast weg ist —
        # umgekehrt liefe der Anhang-Lauf jedes Mal eine Runde hinterher.
        anhaenge = await sweep_verwaiste_anhaenge(session)
    log.info(
        "postfach_pflege_done verfallen=%d verwaist=%d anhaenge=%d",
        verfallen,
        verwaist,
        anhaenge,
    )


async def _kopplung_sweep(session_factory: async_sessionmaker) -> None:
    async with session_factory() as session:
        kopplungen = await sweep_verfallene_kopplungen(session)
    log.info("kopplung_pflege_done verfallen=%d", kopplungen)


async def _geraete_sweep(session_factory: async_sessionmaker) -> None:
    """Gekoppelte Browser, die seit ``geraete_verfall_tage`` niemand mehr
    geoeffnet hat (Spec §3a) — dieselbe Schleife, derselbe Takt."""
    async with session_factory() as session:
        geraete = await sweep_verfallene_geraete(session)
    log.info("geraete_verfall_done verfallen=%d", geraete)


async def _zwischenlager_sweep(session_factory: async_sessionmaker, max_alter_tage: int) -> None:
    """Zwischenlager-Klumpen, die zu lange auf Festigung warten (Etappe E8,
    Design §7) — dieselbe Schleife, derselbe Takt."""
    async with session_factory() as session:
        zwischenlager = await sweep_alte_zwischenlager_dateien(session, max_alter_tage)
    log.info("ablage_zwischenlager_pflege_done verfallen=%d", zwischenlager)


async def _anhang_vorhalte_sweep(session_factory: async_sessionmaker, vorhalte_tage: int) -> None:
    """Abgelaufene DM-Anhänge (Vorhaltezeit, Standard 15 Tage) — dieselbe
    Schleife, derselbe Takt."""
    async with session_factory() as session:
        abgelaufen = await sweep_abgelaufene_anhaenge(session, vorhalte_tage)
    log.info("postfach_anhang_vorhalte_done abgelaufen=%d", abgelaufen)


async def _run_once(engine: AsyncEngine, settings: Settings) -> int:
    """Execute one sweep. Returns the number of Web-Push rows deleted.

    Der Rueckgabewert bleibt bewusst nur die Web-Push-Zahl (bestehende
    Tests pruefen exakt darauf) — die Postfach-Zaehler gehen in ein
    eigenes Log statt in den Rueckgabewert.

    **Jeder Teil-Sweep laeuft in seinem eigenen ``try``** (``_lauf``), damit
    ein Fehlschlag nicht die uebrigen mitnimmt. Der Web-Push-Lauf ist die
    einzige Ausnahme: sein Ergebnis IST der Rueckgabewert, ein geschluckter
    Fehler waere dort eine erfundene Null.
    """
    cutoff = datetime.now(UTC) - timedelta(days=settings.push_subscription_idle_days)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    deleted = await _push_sweep(session_factory, cutoff)

    await _lauf("ablage_kanal_nachtrag", _nachtrag_sweep(session_factory))
    await _lauf("postfach", _postfach_sweeps(session_factory))
    await _lauf("kopplung", _kopplung_sweep(session_factory))
    await _lauf("geraete_verfall", _geraete_sweep(session_factory))
    await _lauf(
        "ablage_zwischenlager",
        _zwischenlager_sweep(session_factory, settings.ablage_zwischenlager_max_alter_tage),
    )
    await _lauf(
        "postfach_anhang_vorhalte",
        _anhang_vorhalte_sweep(session_factory, settings.postfach_anhang_vorhalte_tage),
    )
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


__all__ = ["cleanup_loop", "_run_once"]
