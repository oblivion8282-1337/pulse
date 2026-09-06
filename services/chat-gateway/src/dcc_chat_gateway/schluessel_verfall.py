"""Der 14-Tage-Verfall gekoppelter Browser (Spec §3a, Punkt 2).

**Die eine Regel steht hier und nur hier.** Sie wird an vier Stellen
gebraucht — beim Abholen (``routes/schluessel.py``), bei der Auskunft
(``routes/schluessel_auskunft.py``), beim Geraete-Nachweis
(``schluessel_nachweis.py``) und im Aufraeumlauf (``cleanup.py``) —, und vier
Kopien derselben Zeitrechnung waeren vier Gelegenheiten, sie
auseinanderlaufen zu lassen.

**Wer verfaellt.** Ein Buendel mit ``dauerhaft = False``, dessen
``zuletzt_benutzt`` laenger als ``geraete_verfall_tage`` zurueckliegt. Das
ist genau "ein Browser, den seit zwei Wochen niemand geoeffnet hat" — Apps
melden sich als ``dauerhaft`` und verfallen nie, ein Telefon in der Schublade
behaelt seine Gespraeche.

**Warum ein Grabstein und kein blosses Loeschen.** Der verfallene Browser muss
beim naechsten Oeffnen seinen lokalen Verlauf loeschen; der ist die einzige
Kopie, das Loeschen also unumkehrbar. Er darf den Verfall deshalb NUR aus
einem eindeutigen Signal schliessen, nie aus einem Fehlschlag und nie aus
einer Abwesenheit — eine geloeschte Zeile saehe genauso aus wie "hat noch nie
veroeffentlicht" (frischer Browser, nichts zu loeschen) oder wie eine
Verdraengung durch die Geraete-Obergrenze. ``verfallen_am`` sagt es dagegen
ausdruecklich.

**Der Grabstein klebt.** Ein spaeterer Nachweis frischt ``zuletzt_benutzt``
auf (das tut ``pruefe_geraet`` fuer jedes Geraet), hebt den Verfall aber
nicht auf. Ohne dieses Kleben gaebe es ein Wettrennen mit sich selbst: der
zurueckkehrende Browser veroeffentlicht beim Start sein Buendel, das frischt
``zuletzt_benutzt`` auf, und die reine Zeitrechnung saehe danach ein gesundes
Geraet — der Verfall waere weg, bevor der Klient ihn erfragen konnte. Zurueck
kommt ein verfallenes Geraet nur ueber eine neue Kopplung
(``routes/kopplung.py::kopplung_einloesen``).

**Aufgeraeumt wird die teure Haelfte.** Der Lauf loescht die
Einmalschluessel des verfallenen Buendels (die Menge, die waechst) und laesst
die Buendelzeile als Grabstein stehen. Sie kostet eine Zeile je Geraet, ist
durch ``schluessel_max_buendel_je_konto`` gedeckelt, und die Verdraengung
raeumt sie von selbst zuerst weg (sie sortiert nach ``zuletzt_benutzt``, und
ein verfallenes Geraet ist per Definition das aelteste).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import ColumnElement, and_, case, delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway.models import DeviceKeyBundle, DeviceOneTimeKey, Kopplung

log = logging.getLogger(__name__)


def verfall_grenze(jetzt: datetime | None = None) -> datetime:
    """Der Zeitpunkt, vor dem eine letzte Benutzung als verfallen gilt."""
    settings = chat_config.get_settings()
    return (jetzt or datetime.now(UTC)) - timedelta(days=settings.geraete_verfall_tage)


def ist_verfallen(grenze: datetime) -> ColumnElement[bool]:
    """SQL-Bedingung "dieses Buendel ist verfallen" — Grabstein ODER
    ueberfaellig.

    Beide Haelften sind noetig: der Grabstein allein haengt am Takt des
    Aufraeumlaufs (bis zu ``cleanup_interval_seconds``, Vorgabe 24 h), in dem
    ein laengst ueberfaelliges Geraet sonst weiter Nachrichten empfinge; die
    Zeitrechnung allein verloere den Verfall wieder, sobald das Geraet sich
    einmal meldet (s. Modulkopf).
    """
    return or_(
        DeviceKeyBundle.verfallen_am.is_not(None),
        and_(
            DeviceKeyBundle.dauerhaft.is_(False),
            DeviceKeyBundle.zuletzt_benutzt < grenze,
        ),
    )


def ist_lebendig(grenze: datetime) -> ColumnElement[bool]:
    """Das Gegenteil von ``ist_verfallen`` — als eigene Funktion, damit die
    aufrufende Route nicht selbst negieren muss (ein vergessenes ``~`` waere
    die Umkehrung des Sicherheitsversprechens und faellt in einem Diff kaum
    auf)."""
    return and_(
        DeviceKeyBundle.verfallen_am.is_(None),
        or_(
            DeviceKeyBundle.dauerhaft.is_(True),
            DeviceKeyBundle.zuletzt_benutzt >= grenze,
        ),
    )


async def kopplungszeitpunkt(session: AsyncSession, user_id: int, device_pubkey: str):
    """Wann dieses Geraet einen Kopplungscode eingeloest hat — oder ``None``.

    Gebraucht beim Veroeffentlichen (``routes/schluessel.py``), weil der
    Klient in dieser Reihenfolge arbeitet: erst ``POST /kopplung/einloesen``,
    DANN ``PUT /keys/bundle`` (``web/src/lib/kopplung/empfangen.ts``). Die
    Einloesung findet die Buendelzeile eines frischen Browsers also noch gar
    nicht vor und kann die Marke nicht setzen; sie wird hier nachgezogen.

    Die Kopplungszeile selbst wird nach ``umzug_frist_stunden`` weggeraeumt
    (``kopplung_pflege.py``) — deshalb wird die Marke am Buendel FESTGEHALTEN
    und nie aus dieser Abfrage neu berechnet. Ein spaeteres
    Veroeffentlichen findet nichts mehr und darf eine gesetzte Marke deshalb
    niemals loeschen.
    """
    return (
        await session.execute(
            select(Kopplung.eingeloest_am)
            .where(
                Kopplung.user_id == user_id,
                Kopplung.neu_device_pubkey == device_pubkey,
                Kopplung.eingeloest_am.is_not(None),
            )
            .order_by(Kopplung.eingeloest_am.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


def stempel_ausdruck(jetzt: datetime) -> ColumnElement:
    """Der neue Wert fuer ``verfallen_am`` beim Geraete-Nachweis: ``jetzt``,
    wenn das Geraet ueberfaellig ist — sonst der bisherige Wert.

    **Warum ein Ausdruck und keine eigene Anweisung.** Der Nachweis
    (``schluessel_nachweis.py``) frischt in derselben Anweisung
    ``zuletzt_benutzt`` auf, und die Reihenfolge ist zwingend: erst stempeln,
    dann auffrischen — sonst wischt der Nachweis den Grund fuer den Stempel
    selbst weg. Als zweite Anweisung waere das eine zusaetzliche Runde zur
    Datenbank auf einem Pfad, den der Klient staendig laeuft (Postfach-Abruf);
    als ``CASE`` in derselben ``UPDATE``-Anweisung ist die Reihenfolge
    ausserdem nicht bloss eingehalten, sondern unmoeglich zu verletzen.

    Der bisherige Wert bleibt in jedem anderen Fall stehen — daher ``else_``
    auf die Spalte selbst und nicht auf ``None``: der Grabstein klebt
    (s. Modulkopf).
    """
    return case(
        (
            and_(
                DeviceKeyBundle.verfallen_am.is_(None),
                DeviceKeyBundle.dauerhaft.is_(False),
                DeviceKeyBundle.zuletzt_benutzt < verfall_grenze(jetzt),
            ),
            jetzt,
        ),
        else_=DeviceKeyBundle.verfallen_am,
    )


async def sweep_verfallene_geraete(session: AsyncSession) -> int:
    """Stempelt alle ueberfaelligen Buendel und loescht ihre
    Einmalschluessel. Gibt die Zahl der neu gestempelten Buendel zurueck.

    Reihenfolge: erst stempeln, dann die Einmalschluessel loeschen — der
    zweite Schritt richtet sich nach dem Stempel und holt damit auch
    Buendel mit, die ein frueherer Lauf gestempelt hat, bevor er beim
    Loeschen abbrach.
    """
    jetzt = datetime.now(UTC)
    gestempelt = await session.execute(
        update(DeviceKeyBundle)
        .where(
            DeviceKeyBundle.verfallen_am.is_(None),
            DeviceKeyBundle.dauerhaft.is_(False),
            DeviceKeyBundle.zuletzt_benutzt < verfall_grenze(jetzt),
        )
        .values(verfallen_am=jetzt)
    )
    await session.execute(
        delete(DeviceOneTimeKey).where(
            DeviceOneTimeKey.bundle_id.in_(
                select(DeviceKeyBundle.id).where(DeviceKeyBundle.verfallen_am.is_not(None))
            )
        )
    )
    await session.commit()
    return gestempelt.rowcount or 0


__all__ = [
    "kopplungszeitpunkt",
    "ist_lebendig",
    "ist_verfallen",
    "stempel_ausdruck",
    "sweep_verfallene_geraete",
    "verfall_grenze",
]
