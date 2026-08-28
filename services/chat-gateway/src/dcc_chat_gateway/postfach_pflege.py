"""Das Postfach — Verfall und verwaiste Nutzlasten (Etappe D, Task 4).

Zwei getrennte Faelle, obwohl beide am Ende eine Zeile loeschen:

- ``sweep_verfallene_zustellungen`` — eine Zustellung, deren Frist
  (``verfaellt_am``, s. ``models/postfach.py``) abgelaufen ist. Ein Geraet,
  das nie wiederkommt (verloren, verkauft, App deinstalliert), darf den
  Server nicht dauerhaft belegen — die Frist ist die einzige Garantie
  dafuer, ``routes/postfach.py`` setzt sie bei jeder Einlieferung.
- ``sweep_verwaiste_nutzlasten`` — eine Nutzlast, deren letzte Zustellung
  weg ist (verfallen ODER quittiert, s. ``routes/postfach_abholen.py``).
  Der Verfall haengt an der ZUSTELLUNG, nicht an der Nutzlast — eine
  Nutzlast raeumt sich deshalb nie von selbst, dieser zweite Lauf holt sie
  nach.

Aufgerufen aus dem bestehenden ``cleanup.py::_run_once`` — **keine zweite
Schleife**, derselbe Takt (``cleanup_interval_seconds``) wie die
Web-Push-Aufraeumung.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import delete, exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import DmNutzlast, DmZustellung

log = logging.getLogger(__name__)


async def sweep_verfallene_zustellungen(session: AsyncSession) -> int:
    """Loescht jede Zustellung mit abgelaufener Frist. Gibt die Anzahl zurueck."""
    jetzt = datetime.now(UTC)
    ergebnis = await session.execute(
        delete(DmZustellung).where(DmZustellung.verfaellt_am < jetzt)
    )
    await session.commit()
    return ergebnis.rowcount or 0


async def sweep_verwaiste_nutzlasten(session: AsyncSession) -> int:
    """Loescht jede Nutzlast ohne verbleibende Zustellung. Gibt die Anzahl zurueck."""
    ergebnis = await session.execute(
        delete(DmNutzlast).where(
            ~exists(
                select(DmZustellung.id).where(DmZustellung.nutzlast_id == DmNutzlast.id)
            )
        )
    )
    await session.commit()
    return ergebnis.rowcount or 0


__all__ = ["sweep_verfallene_zustellungen", "sweep_verwaiste_nutzlasten"]
