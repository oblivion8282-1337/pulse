"""Alters-Sweep des Ablage-Zwischenlagers (Etappe E8, Design §7).

Was zu lange liegt, ohne gefestigt zu werden, muss weg — der Besitzer war
lange nicht online, oder sein Geraet ist dauerhaft weg. Die Grenze
(``config.py::ablage_zwischenlager_max_alter_tage``, Vorgabe 7 Tage) ist
dieselbe Zahl, die die Ansicht (Aufgabe 4) dem Mitglied nennt, damit ,,weg"
nicht wie ein stiller Fehlschlag aussieht, sondern wie das, was es ist.

Aufgerufen aus ``cleanup.py::_run_once`` — kein eigener Takt, derselbe wie
die Postfach- und Web-Push-Aufraeumung.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway import s3
from dcc_chat_gateway.models import AblageZwischenlagerDatei

log = logging.getLogger(__name__)

#: Wie beim Anhang-Reaper: ein Lauf raeumt hoechstens so viele Zeilen, damit
#: ein Rueckstau nicht eine einzelne Transaktion und den Objektspeicher
#: gleichzeitig ueberfaehrt. Der naechste Takt holt den Rest.
_BATCH = 500


async def sweep_alte_zwischenlager_dateien(session: AsyncSession, max_alter_tage: int) -> int:
    """Loescht Zwischenlager-Zeilen, deren Alter ``max_alter_tage`` ueberschreitet
    — Zeile UND Klumpen im Objektspeicher. Gibt die Anzahl zurueck.

    Erst die Zeilen dauerhaft weg, dann die Bytes (dieselbe Reihenfolge wie
    ``postfach_pflege.py::sweep_verwaiste_anhaenge``): ein abgebrochener
    Commit darf die Bytes nicht loeschen, waehrend eine Zeile noch auf sie
    zeigt.
    """
    grenze = datetime.now(UTC) - timedelta(days=max_alter_tage)
    zeilen = (
        await session.execute(
            select(
                AblageZwischenlagerDatei.id,
                AblageZwischenlagerDatei.storage_key,
            )
            .where(AblageZwischenlagerDatei.created_at < grenze)
            .limit(_BATCH)
        )
    ).all()
    if not zeilen:
        return 0
    ids = [z.id for z in zeilen]
    await session.execute(delete(AblageZwischenlagerDatei).where(AblageZwischenlagerDatei.id.in_(ids)))
    await session.commit()
    for z in zeilen:
        try:
            await s3.delete_object(z.storage_key)
        except Exception:  # noqa: BLE001 — best effort, s. Reaper-Vorbild
            log.warning("ablage_zwischenlager_purge_fehlgeschlagen")
    return len(zeilen)


__all__ = ["sweep_alte_zwischenlager_dateien"]
