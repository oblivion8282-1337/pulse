"""Verfallene Kopplungen wegraeumen (Etappe F, E2E-DM).

Ein Lauf, nicht zwei — anders als beim Postfach, wo Nutzlast und Zustellung
getrennt verfallen. Ein Stueck hat keine eigene Frist: es lebt und stirbt mit
seiner Kopplung.

**Die Stuecke werden dabei ausdruecklich geloescht, nicht ueber den
Fremdschluessel.** Der ``ondelete="CASCADE"`` am Modell greift auf Postgres,
aber SQLite erzwingt Fremdschluessel nur mit ``PRAGMA foreign_keys=ON``, und
der Testaufbau setzt es nicht — ein Aufraeumen allein per CASCADE waere im
Test nicht beobachtbar (so aufgefallen, roter erster Lauf). Der CASCADE
bleibt als Netz fuer jeden anderen Weg, auf dem eine Kopplungszeile
verschwindet.

**Warum das hier ueberhaupt noetig ist, obwohl beide Wege ordentlich
abschliessen:** ein abgebrochener Umzug schliesst NICHT ab. Genau der Fall,
fuer den die Fortsetzbarkeit gebaut ist — Rechner zugeklappt, App weg — ist
zugleich der, der die Zeile stehen laesst. Ohne Frist waeren angefangene
Umzuege der Dauerzustand der Tabelle.

Aufgerufen aus ``cleanup.py::_run_once`` — **keine zweite Schleife**,
derselbe Takt wie Web-Push- und Postfach-Aufraeumung.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import Kopplung, UmzugStueck


async def sweep_verfallene_kopplungen(session: AsyncSession) -> int:
    """Loescht jede Kopplung mit abgelaufener Frist samt ihren Stuecken.

    Gibt die Anzahl geloeschter KOPPLUNGEN zurueck, nicht die der Stuecke —
    die Zahl steht im Log neben der des Postfachs, und dort zaehlen ebenfalls
    die Zeilen der Haupttabelle.

    Beide Fristen laufen ueber dieselbe Spalte: der kurze Code-Ablauf und
    die laengere Umzugsfrist sind nicht zwei Felder, sondern zwei Werte
    nacheinander in ``verfaellt_am`` (``routes/kopplung.py::kopplung_einloesen``
    schreibt beim Einloesen den zweiten). Ein Lauf deckt damit beide ab.
    """
    ids = (
        await session.execute(
            delete(Kopplung)
            .where(Kopplung.verfaellt_am < datetime.now(UTC))
            .returning(Kopplung.id)
        )
    ).scalars().all()

    if ids:
        await session.execute(delete(UmzugStueck).where(UmzugStueck.kopplung_id.in_(ids)))

    await session.commit()
    return len(ids)
