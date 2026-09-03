"""Der Nachtrag-Sweep — was beim Einliefern nicht in den Kanal-Ordner
geschrieben werden konnte, wird hier nachgeholt (Entwurf 2026-09-02, §3).

**Eigene Datei, nicht in ``ablage_kanal_ordner.py``**: die beiden gehoeren
zusammen, waeren zusammen aber ueber der Groessen-Policy (``PLAN.md`` §12.1).
Der Schnitt liegt an der natuerlichen Naht — dort das Ablegen EINER Nutzlast
(im Anfragepfad und gleich danach), hier die Wiederholung ueber die Zeit.

``ordner_mod.ablegen`` wird ueber das Modulobjekt gerufen, nicht als
importierter Name: Tests ersetzen es per ``monkeypatch.setattr`` an
``ablage_kanal_ordner`` (Muster ``test_postfach_ablage_ordner.py``), und ein
zur Importzeit gebundener Name saehe die Ersetzung nicht.

**Wiederholung mit Abstand, nicht in jedem Takt.** Jede Zeile traegt
``versuche`` und ``naechster_versuch_at``; ein Fehlschlag verdoppelt den
Abstand (gedeckelt bei einem Tag), nach ``_MAX_VERSUCHE`` wird aufgegeben.
Ohne das liefe eine dauerhaft unerreichbare Cloud in JEDEM Pflegetakt
erneut in dieselbe Zeitueberschreitung — und ihre Zeilen verbrauchten dabei
den Stapelplatz aller anderen.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway import ablage_kanal_ordner as ordner_mod
from dcc_chat_gateway.ablage_ssrf import AblageAbrufFehler
from dcc_chat_gateway.models import (
    AblageKanalNachtrag,
    AblageKanalOrdner,
    AblageKontoLaufwerk,
    DmNutzlast,
)

log = logging.getLogger(__name__)

#: Hoechstens so viele Nachtraege je Pflegelauf — dieselbe Begruendung wie
#: ``_ANHANG_BATCH`` in ``postfach_pflege.py``: ein Rueckstau (Nextcloud war
#: eine Nacht lang weg) darf nicht eine einzige Transaktion und eine fremde
#: Cloud gleichzeitig ueberfahren. Der naechste Takt holt den Rest.
_NACHTRAG_BATCH = 100

#: Nach so vielen Fehlversuchen wird ein Nachtrag aufgegeben. Mit dem
#: verdoppelnden Abstand unten liegt der letzte Versuch mehrere Tage hinter
#: dem ersten — wer bis dahin nicht wiederkommt, kommt nicht wieder.
_MAX_VERSUCHE = 20

#: Deckel des Wiederholungs-Abstands (ein Tag). Ohne ihn wuechse er auf
#: Wochen, und eine Cloud, die nach zwei Tagen zurueckkommt, bliebe
#: unbemerkt liegen.
_BACKOFF_DECKEL_MINUTEN = 1440


def backoff_minuten(versuche: int) -> int:
    """Abstand bis zum naechsten Versuch, in Minuten — verdoppelnd, gedeckelt
    bei einem Tag. Rein, damit die Rechnung ohne Datenbank pruefbar ist."""
    return min(2**versuche, _BACKOFF_DECKEL_MINUTEN)


async def _zeile_abarbeiten(
    session: AsyncSession,
    zeile: AblageKanalNachtrag,
    stumme_laufwerke: set[int],
    jetzt: datetime,
) -> str:
    """Ein Nachtrag: ``erledigt`` | ``aufgegeben`` | ``offen`` | ``uebersprungen``.

    Zwei dauerhafte Aufgabe-Gruende (der Kanal ist kein Ordner-Kanal mehr,
    sein Ersteller hat kein Konto-Laufwerk mehr) werden hier gleich erkannt —
    ein Netzfehler gehoert ausdruecklich NICHT dazu, der wird wiederholt.
    """
    nutzlast = await session.get(DmNutzlast, zeile.nutzlast_id)
    if nutzlast is None:
        # Die Nutzlast ist inzwischen verfallen (Postfach-Pflege) — der
        # Nachtrag ist damit gegenstandslos, nicht mehr nachholbar.
        await session.delete(zeile)
        await session.commit()
        return "erledigt"

    ordner_zeile = await session.get(AblageKanalOrdner, zeile.channel_id)
    laufwerk = (
        None
        if ordner_zeile is None
        else await session.get(AblageKontoLaufwerk, ordner_zeile.ersteller_id)
    )
    if ordner_zeile is None or laufwerk is None:
        await session.delete(zeile)
        await session.commit()
        return "aufgegeben"

    # Ein Laufwerk, das in DIESEM Lauf schon einmal nicht antwortete,
    # antwortet auch bei der naechsten Zeile nicht — es sind dieselbe
    # Gegenstelle und dieselben Sekunden. Ohne diese Menge kostete ein
    # einziger ausgefallener Ersteller den ganzen Stapel mal die
    # Zeitueberschreitung, und die Nachtraege aller anderen kaemen im
    # selben Takt nicht mehr dran.
    if ordner_zeile.ersteller_id in stumme_laufwerke:
        return "uebersprungen"

    try:
        await ordner_mod.ablegen(session, nutzlast)
    except Exception as fehler:  # noqa: BLE001
        # **Stumm gilt nur fuer einen Abruffehler.** Nur der sagt etwas ueber
        # die GEGENSTELLE; ein Programmfehler im Ableger sagt etwas ueber
        # diese eine Zeile und darf die anderen desselben Laufwerks nicht
        # mitnehmen. Gezaehlt wird er trotzdem — sonst kaeme eine
        # Giftzeile in jedem Takt unbegrenzt wieder.
        if isinstance(fehler, AblageAbrufFehler):
            stumme_laufwerke.add(ordner_zeile.ersteller_id)
        log.warning(
            "ablage_kanal_nachtrag_fehlversuch nutzlast=%s kanal=%s versuche=%s klasse=%s code=%s",
            zeile.nutzlast_id,
            zeile.channel_id,
            zeile.versuche + 1,
            type(fehler).__name__,
            getattr(fehler, "code", None),
        )
        return await _fehlversuch_vermerken(session, zeile, jetzt)

    await session.delete(zeile)
    await session.commit()
    return "erledigt"


async def _fehlversuch_vermerken(
    session: AsyncSession, zeile: AblageKanalNachtrag, jetzt: datetime
) -> str:
    """Zaehlt den Fehlversuch und schiebt den naechsten Termin — oder gibt
    nach ``_MAX_VERSUCHE`` auf.

    Aufgeben ist kein Datenverlust im Postfach-Sinn (die Zustellungen sind
    laengst raus), sondern das Ende der Festigung fuer GENAU diese Nachricht.
    Ohne Obergrenze bliebe eine Zeile, deren Cloud nie zurueckkommt, fuer
    immer stehen und hielte ueber ``sweep_verwaiste_nutzlasten`` auch die
    quittierte Nutzlast am Leben.
    """
    zeile.versuche += 1
    if zeile.versuche >= _MAX_VERSUCHE:
        await session.delete(zeile)
        await session.commit()
        return "aufgegeben"
    zeile.naechster_versuch_at = jetzt + timedelta(minutes=backoff_minuten(zeile.versuche))
    await session.commit()
    return "offen"


async def nachtrag_sweep(session: AsyncSession) -> tuple[int, int]:
    """Holt faellige Nachtraege nach — hoechstens ``_NACHTRAG_BATCH`` je Lauf,
    mit einem Commit JE ZEILE.

    Gibt ``(erledigt, aufgegeben)`` zurueck:

    * **erledigt** — geschrieben (oder die Nutzlast war inzwischen verfallen,
      dann ist der Nachtrag gegenstandslos) und die Zeile geloescht.
    * **aufgegeben** — geloescht, ohne je geschrieben worden zu sein: der
      Kanal ist kein Ordner-Kanal mehr, sein Ersteller hat sein
      Konto-Laufwerk abgehaengt, oder ``_MAX_VERSUCHE`` sind erschoepft.
      Ohne diese Unterscheidung bliebe so eine Zeile fuer immer stehen und
      verbraeuchte in JEDEM Lauf einen Platz im Stapel — ein einziger
      abgehaengter Ersteller wuerde die Nachtraege aller anderen aushungern.

    Der Commit je Zeile ist kein Stil, sondern Absicht: ein Fehler in Zeile
    50 darf die 49 bereits geschriebenen Dateien nicht wieder als „noch
    offen" markieren. Aus demselben Grund liegt um JEDE Zeile ein eigenes
    ``try`` — ein unerwarteter Fehler (nicht bloss ein Netzfehler) hat den
    ganzen Lauf abgebrochen und damit auch jede Zeile hinter ihm.
    """
    jetzt = datetime.now(UTC)
    zeilen = (
        await session.execute(
            select(AblageKanalNachtrag)
            .where(AblageKanalNachtrag.naechster_versuch_at <= jetzt)
            .order_by(AblageKanalNachtrag.naechster_versuch_at)
            .limit(_NACHTRAG_BATCH)
        )
    ).scalars().all()
    erledigt = 0
    aufgegeben = 0
    stumme_laufwerke: set[int] = set()
    for zeile in zeilen:
        nutzlast_id = zeile.nutzlast_id
        try:
            ergebnis = await _zeile_abarbeiten(session, zeile, stumme_laufwerke, jetzt)
        except Exception as fehler:  # noqa: BLE001
            # Ohne Adresse: die Freigabe-Adresse des Laufwerks darf in kein
            # Log (``ablage_kanal.py``-Modulkopf).
            log.warning(
                "ablage_kanal_nachtrag_zeile_fehlgeschlagen nutzlast=%s klasse=%s",
                nutzlast_id,
                type(fehler).__name__,
            )
            await ordner_mod._still_zuruecksetzen(session, nutzlast_id)
            continue
        if ergebnis == "erledigt":
            erledigt += 1
        elif ergebnis == "aufgegeben":
            aufgegeben += 1
    return erledigt, aufgegeben


__all__ = ["nachtrag_sweep", "backoff_minuten"]
