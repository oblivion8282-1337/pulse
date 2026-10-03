"""Pflege-Lauf für hängende Anruf-Zeilen (Befund 03.10.).

Ein Client, der beim Klingeln abstirbt (App-Kill, Netz weg), hinterlässt
seinen Anruf ewig in ``klingelnd`` — der 45-s-Wecker lebt nur im Klienten.
Der Lauf hier setzt solche Zeilen auf ``beendet/verpasst``, damit die
Tabelle nicht zufüllt. Er publiziert KEINE ``call_ende``-Events: die
übrigen Geräte räumen über ihren eigenen Klingel-Wecker ab, und der
Pflege-Lauf (Muster ``kopplung_pflege``) hat keinen ConnectionManager.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import (
    GRUND_VERPASST,
    ZUSTAND_BEENDET,
    ZUSTAND_KLINGELND,
    ZUSTAND_LAEUFEND,
    Anruf,
)

# Klingelt seit >2 min ohne Annahme → der Klient-Wecker (45 s) wäre längst
# gefeuert; die Luft nach oben deckt langsame Uhren und Browser-Tabus ab.
KLINGEL_MAX_ALTER_SEK = 120
# ponytail: Ohne Teilnehmer-Ring weiß die DB nicht, ob ein ``laufender``
# Gruppenanruf noch jemanden im Raum hat. 24 h ohne Ende ist kein Anruf
# mehr, sondern eine Leiche — der Lauf nimmt sie (ohne Event, clients
# sind über LiveKit-Disconnect längst draußen). Upgrade-Pfad: Raum-Präsenz
# aus voice-signaling befragen, bevor beendet wird.
LAEUFT_MAX_STUNDEN = 24


async def sweep_haengende_anrufe(session: AsyncSession) -> int:
    """Beendet verwaiste klingelnde (und uralt laufende) Anruf-Zeilen.

    Committet selbst (eigener Pflege-Lauf, Muster wie der Geräte-Verfall).
    Rückgabe: Anzahl beendeter Zeilen.
    """
    jetzt = datetime.now(tz=timezone.utc)
    res = await session.execute(
        update(Anruf)
        .where(
            Anruf.zustand.in_([ZUSTAND_KLINGELND, ZUSTAND_LAEUFEND]),
            (
                (Anruf.zustand == ZUSTAND_KLINGELND)
                & (Anruf.erstellt_at < jetzt - timedelta(seconds=KLINGEL_MAX_ALTER_SEK))
            )
            | (
                (Anruf.zustand == ZUSTAND_LAEUFEND)
                & (Anruf.erstellt_at < jetzt - timedelta(hours=LAEUFT_MAX_STUNDEN))
            ),
            Anruf.beendet_at.is_(None),
        )
        .values(zustand=ZUSTAND_BEENDET, grund=GRUND_VERPASST, beendet_at=jetzt)
    )
    await session.commit()
    return res.rowcount or 0
