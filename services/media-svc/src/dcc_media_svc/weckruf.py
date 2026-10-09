"""Weckruf für den Stream-Poller, ausgelöst vom Sende-Token.

Der Leerlauf-Backoff des Pollers (``poller._poll_interval``) hat einen blinden
Fleck: ein neuer Publisher setzt den Leerlauf-Zähler erst zurück, wenn ein
Durchlauf ihn SIEHT — und im gedehnten Takt kommt der nächste Durchlauf erst
nach bis zu 30 s. Weil allein der Poller einen Stream als live meldet
(``stream:events``, auch an den Streamer selbst), stand ein frisch gestarteter
Stream so bis zu 30 s unsichtbar da.

``issue_stream_token`` ruft deshalb ``wecken()``: der laufende Schlaf des
Pollers endet sofort, und der Takt bleibt ``WACH_NACH_TOKEN_S`` lang schnell.
Die Spanne deckt die Zeit zwischen Token und erstem Paket ab — unter Wayland
öffnet der Linux-Sidecar erst NACH dem Token den Portal-Dialog zur
Bildschirmwahl. Wer länger darin verweilt, fällt auf den 30-s-Takt zurück,
also nicht schlechter als ohne Weckruf.

Prozess-lokaler Zustand genügt: media-svc läuft mit genau einem Worker
(``assert_single_worker`` in ``app.py``), Token-Route und Poller teilen ihn.
"""

from __future__ import annotations

import asyncio
import time

WACH_NACH_TOKEN_S = 120.0
_wach_bis = 0.0
# Gehört dem laufenden Poller (``anmelden``/``abmelden``). Kein Modul-Event von
# vornherein: ein ``asyncio.Event`` bindet sich beim ersten Warten an seine
# Ereignisschleife, und Tests fahren je Test eine eigene.
_ereignis: asyncio.Event | None = None


def wecken() -> None:
    """Ein Publisher ist angekündigt: sofort nachsehen und eine Weile schnell bleiben."""
    global _wach_bis
    _wach_bis = time.monotonic() + WACH_NACH_TOKEN_S
    if _ereignis is not None:
        _ereignis.set()


def ist_wach() -> bool:
    return time.monotonic() < _wach_bis


def anmelden() -> asyncio.Event:
    global _ereignis
    _ereignis = asyncio.Event()
    return _ereignis


def abmelden() -> None:
    global _ereignis
    _ereignis = None


async def schlafen(stop: asyncio.Event, geweckt: asyncio.Event, frist_s: float) -> None:
    """Bis zum nächsten Takt warten — früher, wenn gestoppt oder geweckt wird."""
    warter = [asyncio.create_task(stop.wait()), asyncio.create_task(geweckt.wait())]
    try:
        await asyncio.wait(warter, timeout=frist_s, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for w in warter:
            w.cancel()
