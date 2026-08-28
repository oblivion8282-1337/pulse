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
- ``sweep_verwaiste_anhaenge`` (Etappe E) — ein verschluesselter Anhang,
  dessen letzte Nutzlast weg ist. Er haengt an Umschlaegen statt an einer
  Nachricht (``postfach_anhaenge.py``); ohne einen Umschlag, der ihn
  oeffnen koennte, ist er Muell. Dieser Lauf loescht die Zeile UND den
  Klumpen im Objektspeicher.

Aufgerufen aus dem bestehenden ``cleanup.py::_run_once`` — **keine zweite
Schleife**, derselbe Takt (``cleanup_interval_seconds``) wie die
Web-Push-Aufraeumung.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import delete, exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import (
    DmAnhangBezug,
    DmNutzlast,
    DmZustellung,
    MessageAttachment,
)

log = logging.getLogger(__name__)

#: Wie ``REAPER_BATCH_SIZE`` im Anhang-Reaper: ein Lauf raeumt hoechstens so
#: viele Zeilen, damit ein Rueckstau nicht eine einzelne Transaktion und den
#: Objektspeicher gleichzeitig ueberfaehrt. Der naechste Takt holt den Rest.
_ANHANG_BATCH = 500


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


async def loesche_anhaenge_ohne_umschlag(session: AsyncSession) -> tuple[int, list[str]]:
    """Loescht die Zeilen verwaister verschluesselter Anhaenge.

    Gibt ``(Anzahl, Objektspeicher-Schluessel)`` zurueck und committet
    **nicht** — der Aufrufer entscheidet, wann der Klumpen faellt. Genau
    dieselbe Reihenfolge wie ``hard_delete_attachments(defer_s3=…)``: erst
    die Zeile dauerhaft weg, dann die Bytes. Andersherum verloere ein
    fehlgeschlagener Commit die Bytes, waehrend die Zeile weiter auf sie
    zeigt.

    ``postfach_gebunden_am IS NOT NULL`` ist die halbe Bedingung und nicht
    Zierde: ohne sie traefe die Auswahl auch jeden gerade hochgeladenen
    Anhang, dessen Umschlag noch gar nicht eingeliefert wurde — der hat
    ebenfalls keine Bezugszeile. Die andere Haelfte dieser Trennung steht
    im Anhang-Reaper (``routes/attachments.py::_reap_once``), der
    umgekehrt nur ungebundene Zeilen nimmt.
    """
    zeilen = (
        await session.execute(
            select(
                MessageAttachment.id,
                MessageAttachment.storage_key,
                MessageAttachment.thumb_storage_key,
            )
            .where(
                MessageAttachment.postfach_gebunden_am.is_not(None),
                ~exists(
                    select(DmAnhangBezug.anhang_id).where(
                        DmAnhangBezug.anhang_id == MessageAttachment.id
                    )
                ),
            )
            .limit(_ANHANG_BATCH)
        )
    ).all()
    if not zeilen:
        return 0, []
    schluessel: list[str] = []
    for zeile in zeilen:
        schluessel.append(zeile.storage_key)
        if zeile.thumb_storage_key:
            schluessel.append(zeile.thumb_storage_key)
    await session.execute(
        delete(MessageAttachment).where(
            MessageAttachment.id.in_([zeile.id for zeile in zeilen])
        )
    )
    return len(zeilen), schluessel


async def sweep_verwaiste_anhaenge(session: AsyncSession) -> int:
    """Wie ``loesche_anhaenge_ohne_umschlag``, aber mit Commit und
    anschliessendem Loeschen im Objektspeicher. Gibt die Anzahl zurueck."""
    anzahl, schluessel = await loesche_anhaenge_ohne_umschlag(session)
    await session.commit()
    # Erst hier importiert, nicht oben: ``user_purge_postfach.py`` holt sich
    # ``loesche_anhaenge_ohne_umschlag`` aus diesem Modul, und der Weg zurueck
    # (``routes/attachments.py`` -> Paket ``routes`` -> ``routes/internal.py``
    # -> ``user_purge.py`` -> ``user_purge_postfach.py``) landete waehrend des
    # Modul-Imports wieder hier — in einer Datei, die dann erst zur Haelfte
    # ausgefuehrt ist. Ein Import in der Funktion laeuft, wenn beide Seiten
    # fertig sind.
    from dcc_chat_gateway.routes.attachments import purge_s3_keys

    await purge_s3_keys(schluessel)
    return anzahl


__all__ = [
    "loesche_anhaenge_ohne_umschlag",
    "sweep_verfallene_zustellungen",
    "sweep_verwaiste_anhaenge",
    "sweep_verwaiste_nutzlasten",
]
