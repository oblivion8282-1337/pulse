"""Ein Geraet aus dem eigenen Konto werfen — der Widerruf (Spec §3b, Punkt 4).

**Warum es diese Datei ueberhaupt gibt.** Bis zum 2026-08-30 trug den Widerruf
die Sperrliste des Geraetezertifikats. Mit den Zertifikaten ist sie gefallen
(Migration 0079), und seither gab es fuer ein einzelnes Geraet gar keinen
Widerruf mehr: wer sein Telefon verlor, konnte es nicht aus seinem Konto
werfen. Der Ersatz ist absichtlich nicht kryptographisch, sondern sichtbar —
eine Geraeteliste, aus der man etwas herausnimmt (denselben Weg gehen Signal
und WhatsApp).

**Was der Widerruf leistet, und was nicht.** Er nimmt einem Geraet den Zugang
zu allem, was ein Geraet tun kann: als Empfaenger auftauchen
(``POST /keys/claim``, ``GET /keys/verschluesselbar``), Zustellungen abholen
und quittieren, Einmalschluessel nachlegen, koppeln. Was er NICHT leisten
kann: das Geraet vergessen zu machen, was es schon hat. Die Umschlaege, die es
bereits geoeffnet hat, liegen in seinem lokalen Verlauf; der Server kommt
dort nicht hin. Der Klient loescht ihn von sich aus, sobald er den Widerruf
erfaehrt (``GET /keys/geraetestand`` -> ``entfernt``, dann
``web/src/lib/krypto/geraeteVerfall.ts``) — das ist Mitarbeit des Geraets,
kein Zwang, und ein veraenderter Klient tut es nicht.

**Und er ist kein Schutz gegen eine laufende Kontouebernahme.** Wer die
Sitzung hat, traegt einfach ein neues Geraet ein (``PUT /keys/bundle`` laesst
unbekannte Kennungen zu, es muss sie zulassen). Das steht so schon in Spec
§3b; der Gewinn ist, dass der Eintrag danach in der Liste steht und der
Nutzer ihn wieder herauswerfen kann. Sichtbarkeit, nicht Undurchdringlichkeit.

**Der Grabstein klebt.** Begruendung an der Spalte (``models/
geraete_schluessel.py::DeviceKeyBundle.entfernt_am``) und in Migration 0080:
ein blosses Loeschen der Zeile waere gar kein Widerruf, weil das entfernte
Geraet sie beim naechsten Start wieder anlegte. Aufgehoben wird er nur durch
eine neue Kopplung (``routes/kopplung.py::kopplung_einloesen``) — genau wie
beim Verfall, und aus demselben Grund: der Kopplungscode beweist, dass
dieselbe Person beide Geraete in der Hand haelt.

**Eine bekannte Luecke, benannt statt verschwiegen:**
``schluessel_grenzen.py::platz_fuer_neues_geraet_schaffen`` verdraengt bei
``schluessel_max_buendel_je_konto`` Geraeten das am laengsten unbenutzte
Buendel — auch einen Grabstein. Wer genug neue Geraete eintraegt, raeumt
seinen eigenen Widerruf damit weg und kann die alte Kennung neu anlegen. Das
setzt eine Kontositzung voraus, und wer die hat, braucht den Umweg nicht
(s. oben). Deshalb hier nur festgehalten, nicht behoben.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import ColumnElement, and_, delete, exists, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import DeviceKeyBundle, DeviceOneTimeKey
from dcc_chat_gateway.schluessel_verfall import ist_lebendig


def nicht_entfernt() -> ColumnElement[bool]:
    """SQL-Bedingung „dieses Buendel wurde nicht entfernt".

    Als Funktion und nicht als Modul-Konstante, damit sie sich in der
    aufrufenden Abfrage genauso liest wie ``ist_lebendig(...)`` daneben — und
    damit niemand denselben Ausdruck versehentlich in zwei Abfragen teilt.
    """
    return DeviceKeyBundle.entfernt_am.is_(None)


def darf_empfangen(grenze: datetime) -> ColumnElement[bool]:
    """Die vollstaendige Bedingung „dieses Geraet ist noch Empfaenger":
    nicht entfernt UND nicht verfallen.

    **Sie steht als EINE Funktion da, obwohl sie zwei Regeln verbindet**, weil
    die beiden Stellen, die sie brauchen (``routes/schluessel_abholen.py`` und
    ``routes/schluessel_auskunft.py``), deckungsgleich bleiben muessen: die
    Auskunft darf nie mehr zusagen, als der Abholweg einloest. Zwei einzeln
    hinzugefuegte Bedingungen waeren zwei Gelegenheiten, eine davon zu
    vergessen — und die vergessene faellt nicht auf, weil beide Antworten fuer
    sich plausibel aussehen.

    Die Verfallshaelfte bleibt in ``schluessel_verfall.py``; hier steht nur
    das Und.
    """
    return and_(nicht_entfernt(), ist_lebendig(grenze))


async def geraet_entfernen(
    session: AsyncSession, user_id: int, device_pubkey: str
) -> bool:
    """Setzt den Grabstein fuer ein Geraet DIESES Kontos und raeumt seinen
    Einmalschluessel-Vorrat weg. Gibt zurueck, ob das Konto ein solches Geraet
    ueberhaupt fuehrt.

    ``user_id`` steht in JEDER Anweisung — das ist die einzige
    Eigentumspruefung, die es hier gibt und braucht: ein fremdes Konto kann
    die Kennung eines anderen kennen (sie ist ueber ``POST /keys/claim`` im
    Freundeskreis abholbar), findet damit aber keine Zeile.

    **Kein ``pruefe_geraet`` fuer das Ziel.** Das Ziel ist ja gerade das
    Geraet, das man NICHT mehr in der Hand hat; ein Nachweis fuer es zu
    verlangen waere die Umkehrung des Zwecks, und er wuerde nebenbei sein
    ``zuletzt_benutzt`` auffrischen — also den Verfall aufhalten, den man
    gerade abkuerzen will.

    Zweimal entfernen ist kein Fehler (``True`` auch beim zweiten Mal): die
    Zeile ist danach in genau dem Zustand, den der Aufrufer wollte. Deshalb
    das zusaetzliche ``exists`` unten statt eines blossen ``rowcount``.
    """
    jetzt = datetime.now(UTC)
    ergebnis = await session.execute(
        update(DeviceKeyBundle)
        .where(
            DeviceKeyBundle.user_id == user_id,
            DeviceKeyBundle.device_pubkey == device_pubkey,
            DeviceKeyBundle.entfernt_am.is_(None),
        )
        .values(entfernt_am=jetzt)
    )
    if not ergebnis.rowcount:
        gefunden = (
            await session.execute(
                select(
                    exists().where(
                        DeviceKeyBundle.user_id == user_id,
                        DeviceKeyBundle.device_pubkey == device_pubkey,
                    )
                )
            )
        ).scalar_one()
        return bool(gefunden)

    # Die teure Haelfte wegraeumen, genau wie beim Verfall
    # (``schluessel_verfall.py::sweep_verfallene_geraete``): der Vorrat waechst,
    # die Grabsteinzeile nicht. Ein entferntes Geraet kommt ohnehin aus keiner
    # ``claim``-Abfrage mehr heraus, seine Einmalschluessel sind ab jetzt tot.
    await session.execute(
        delete(DeviceOneTimeKey).where(
            DeviceOneTimeKey.bundle_id.in_(
                select(DeviceKeyBundle.id).where(
                    DeviceKeyBundle.user_id == user_id,
                    DeviceKeyBundle.device_pubkey == device_pubkey,
                )
            )
        )
    )
    await session.commit()
    return True


__all__ = ["darf_empfangen", "geraet_entfernen", "nicht_entfernt"]
