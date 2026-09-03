"""Der dauerhafte Bestand eines verschluesselten Kanals bei Pulse —
aufgeraeumt wird er an genau EINER Stelle (Entscheidung 2026-09-03).

Eine Nutzlast mit ``archiv`` ist der Kanalverlauf selbst: sie ueberdauert
die Quittung des letzten Geraets, den verwaist-Sweep und das Loeschen des
Absender-Kontos (alle drei filtern sie ausdruecklich aus). Damit gehoert sie
auch keinem von ihnen — sie faellt mit ihrem Kanal, und diese Funktion ist
der Weg dorthin.

**Warum es keine Kaskade tut.** ``dm_nutzlasten.channel_id`` traegt keinen
Fremdschluessel: die Spalte zeigt wahlweise auf einen Guild-Kanal, einen
DM-Kanal oder eine private Gruppe — drei Tabellen, auf die ein einzelner
Fremdschluessel nicht zeigen kann.
"""

from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import DmNutzlast, DmZustellung


async def bestand_loeschen(session: AsyncSession, channel_id: int) -> int:
    """Loescht die Archiv-Nutzlasten dieses Kanals samt ihrer offenen
    Zustellungen. Committet **nicht** — der Aufrufer entscheidet, wann.

    Die Zustellungen gehen ausdruecklich mit, obwohl der Fremdschluessel
    ``dm_zustellungen.nutzlast_id`` kaskadiert: SQLite erzwingt in den Tests
    keine Fremdschluessel, und eine fehlende Kaskade liesse sonst still
    Waisen zurueck (dieselbe Begruendung wie bei ``DropboxFile`` in
    ``routes/channels.py``).
    """
    ids = list(
        (
            await session.execute(
                select(DmNutzlast.id).where(
                    DmNutzlast.channel_id == channel_id, DmNutzlast.archiv.is_(True)
                )
            )
        ).scalars()
    )
    if not ids:
        return 0
    await session.execute(delete(DmZustellung).where(DmZustellung.nutzlast_id.in_(ids)))
    await session.execute(delete(DmNutzlast).where(DmNutzlast.id.in_(ids)))
    return len(ids)


__all__ = ["bestand_loeschen"]
