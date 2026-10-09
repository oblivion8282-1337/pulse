"""Weckruf für den Stream-Poller, ausgelöst vom Sende-Token.

Der Leerlauf-Backoff des Pollers (``poller._poll_interval``) hat einen blinden
Fleck: ein neuer Publisher setzt den Leerlauf-Zähler erst zurück, wenn ein
Durchlauf ihn SIEHT — und im gedehnten Takt kommt der nächste Durchlauf erst
nach bis zu 30 s. Weil allein der Poller einen Stream als live meldet
(``stream:events``, auch an den Streamer selbst), stand ein frisch gestarteter
Stream so bis zu 30 s unsichtbar da.

Das Sende-Token holt der Klient unmittelbar nach dem Klick auf „Stream
starten", noch vor der Aufnahme. ``issue_stream_token`` ruft deshalb
``wecken()`` und kündigt damit genau diesen Stream an (Kanal, Nutzer, Platz):
der laufende Schlaf des Pollers endet sofort, und bis ein Durchlauf den
angekündigten Stream sieht (``gesehen``), fragt er alle ``WACH_TAKT_S``. Der
Stream gilt damit etwa eine halbe Sekunde, nachdem MediaMTX ihn als bereit
führt, als live statt erst beim nächsten 3-s-Durchlauf.

Der Schnelltakt endet am Stream, nicht an einer Uhr: hinge er an einer Frist
ab dem Klick, hielte in einer belebten Instanz jeder Klick irgendwo den Poller
dauerhaft im Halbsekundentakt. Die Frist ``WACH_NACH_TOKEN_S`` ist nur der
Deckel für Streams, die nie kommen (Abbruch, Sidecar-Fehler). Sie deckt die
Zeit zwischen Token und erstem Paket ab — unter Wayland öffnet der
Linux-Sidecar erst NACH dem Token den Portal-Dialog zur Bildschirmwahl. Wer
länger darin verweilt, fällt auf den gewohnten Takt zurück.

Prozess-lokaler Zustand genügt: media-svc läuft mit genau einem Worker
(``assert_single_worker`` in ``app.py``), Token-Route und Poller teilen ihn.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Iterable

WACH_TAKT_S = 0.5
WACH_NACH_TOKEN_S = 120.0
# (Kanal, Nutzer, Platz) → Frist (monotonic). Platz als Text, so wie der Poller
# ihn aus dem MediaMTX-Pfad liest.
_erwartet: dict[tuple[str, str, str], float] = {}
# Gehört dem laufenden Poller (``anmelden``/``abmelden``). Kein Modul-Event von
# vornherein: ein ``asyncio.Event`` bindet sich beim ersten Warten an seine
# Ereignisschleife, und Tests fahren je Test eine eigene.
_ereignis: asyncio.Event | None = None


def wecken(kanal: str, nutzer: str, platz: int) -> None:
    """Dieser Stream ist angekündigt: sofort nachsehen und schnell bleiben, bis er da ist."""
    _erwartet[(kanal, nutzer, str(platz))] = time.monotonic() + WACH_NACH_TOKEN_S
    if _ereignis is not None:
        _ereignis.set()


def gesehen(streams: Iterable[tuple[str, str, str]]) -> None:
    """Vom Poller gemeldete (Kanal, Nutzer, Platz) — deren Ankündigung ist erledigt."""
    for stream in streams:
        _erwartet.pop(stream, None)


def ist_wach() -> bool:
    """Ob noch eine Ankündigung offen ist; abgelaufene fallen dabei heraus."""
    jetzt = time.monotonic()
    for stream, frist in list(_erwartet.items()):
        if frist <= jetzt:
            del _erwartet[stream]
    return bool(_erwartet)


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
