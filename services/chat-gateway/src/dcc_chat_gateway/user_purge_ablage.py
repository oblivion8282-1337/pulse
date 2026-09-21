"""Konto-Purge: eigene Zwischenlager-Uploads der Community-Dateiablage
(Etappe E8).

``AblageZwischenlagerDatei.hochgeladen_von`` gehoert dem Konto, das den
Klumpen eingeliefert hat — kein Fremdschluessel (s. Modell-Docstring), also
raeumt keine DB-Kaskade automatisch mit. Ohne diesen Purge bliebe der Klumpen
eines geloeschten Kontos liegen, bis ihn der Alters-Sweep
(``ablage_zwischenlager_pflege.py``) irgendwann von selbst holt — das waere
kein Datenverlust, aber ein unnoetig langes Nachleben fuer etwas, das
niemand mehr festigen wird koennen (der Uploader kann nicht erneut hochladen,
und der Community-Besitzer wartet auf einen Klumpen, dessen Herkunft
verschwunden ist).

Kein Commit hier — laeuft in derselben Transaktion wie der Rest von
``user_purge.py::_purge_db`` (dasselbe Prinzip wie ``user_purge_postfach.py``).
"""

from __future__ import annotations

from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import AblageKontoLaufwerk, AblagePulseObjekt, AblageZwischenlagerDatei


async def purge_ablage_zwischenlager(session: AsyncSession, user_id: int) -> list[str]:
    """Loescht die Zwischenlager-Zeilen des geloeschten Kontos; liefert ihre
    Objektspeicher-Schluessel zurueck. Die Bytes fallen NACH dem Commit —
    Rueckgabe statt Eigenloeschung (Bughunt Runde 37: vorher lief das
    ``s3.delete_object`` IN der uncommitteten Transaktion; ein transienter
    Objektspeicher-Fehler riss den GESAMTEN Konto-Purge mit Rollback ab,
    waehrend Blobs schon weg waren — genau die Verletzung der Invariante aus
    dem ``user_purge.py``-Modulkopf). Der Aufrufer haengt die Keys an
    ``deferred_s3`` an, wo ``purge_s3_keys`` sie nach dem Commit nimmt."""
    schluessel = list(
        (
            await session.execute(
                select(AblageZwischenlagerDatei.storage_key).where(
                    AblageZwischenlagerDatei.hochgeladen_von == user_id
                )
            )
        ).scalars()
    )
    if not schluessel:
        return []
    await session.execute(
        sa_delete(AblageZwischenlagerDatei).where(
            AblageZwischenlagerDatei.hochgeladen_von == user_id
        )
    )
    return schluessel


async def purge_ablage_konto_laufwerk(session: AsyncSession, user_id: int) -> None:
    """Loescht die Archiv-Laufwerks-Adresse des geloeschten Kontos.

    **Der Ordner in der Cloud bleibt, und das ist Absicht.** Die Zeile hier
    ist nur ein Schluessel, den Pulse verwahrt hat; die Dateien gehoeren dem
    Nutzer und liegen in SEINER Cloud. Sie beim Kontoloeschen mitzuentfernen
    hiesse, fremdes Eigentum zu vernichten — Pulse zieht sich zurueck, es
    raeumt nicht auf. Wer den Ordner leer haben will, loescht ihn dort, wo er
    liegt, und zieht den Freigabe-Link zurueck.

    Kein ``ForeignKey`` auf die Nutzertabelle (anderes Schema), also raeumt
    keine Kaskade das mit — deshalb dieser ausdrueckliche Schritt.
    """
    await session.execute(
        sa_delete(AblageKontoLaufwerk).where(AblageKontoLaufwerk.user_id == user_id)
    )


async def purge_ablage_pulse_objekte(session: AsyncSession, user_id: int) -> list[str]:
    """Loescht die Pulse-Laufwerk-Zeilen des geloeschten Kontos; liefert ihre
    Objektspeicher-Schluessel zurueck (Bytes nach dem Commit via
    ``deferred_s3``, dieselbe Begruendung wie bei
    ``purge_ablage_zwischenlager``).

    **Anders als die Cloud-Adresse oben ist das hier Pulse-EIGENTUM, das der
    Nutzer gemietet hat:** der Klumpen liegt im Objektspeicher der Instanz,
    nicht in seiner Cloud. Beim Kontoloeschen bleibt er sonst als Chiffrat
    liegen, das niemand mehr oeffnen kann und das nur Platz frisst — deshalb
    Zeilen weg und Bytes danach.

    In Communitys, in denen er Mitglied war, bleibt das Laufwerk selbst
    bestehen — nur seine eigenen Uploads fallen heraus; deren
    Verzeichnis-Eintraege verschwinden mit dem naechsten Verzeichnis-Schreib
    eines verbleibenden Geraets.
    """
    schluessel = list(
        (
            await session.execute(
                select(AblagePulseObjekt.storage_key).where(
                    AblagePulseObjekt.hochgeladen_von == user_id
                )
            )
        ).scalars()
    )
    if not schluessel:
        return []
    await session.execute(
        sa_delete(AblagePulseObjekt).where(AblagePulseObjekt.hochgeladen_von == user_id)
    )
    return schluessel


__all__ = [
    "purge_ablage_pulse_objekte",
    "purge_ablage_zwischenlager",
    "purge_ablage_konto_laufwerk",
]
