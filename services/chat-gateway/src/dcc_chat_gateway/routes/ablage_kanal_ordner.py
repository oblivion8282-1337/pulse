"""Verschluesselter Kanal: anlegen + lesen (Entwurf 2026-09-02 §2-3,
Entscheidung 2026-09-03).

Die drei Routen des Ordner-Kanals:

* ``PUT .../ablage/ordner`` — macht den Kanal zu einem Ordner-Kanal (legt
  ``AblageKanalOrdner`` an). Der Rumpf sagt, WO der Bestand liegt:
  ``pulse`` (Vorgabe) oder ``nextcloud``.
* ``GET .../ablage/ordner`` — die Dateiliste, gefiltert auf ``<id>.puls``
  und numerisch sortiert, mit Cursor (``nach``) und Obergrenze (``limit``).
* ``GET .../ablage/ordner/{name}`` — eine einzelne Datei.

**Zwei Speicher, EINE Aussenansicht.** Bei ``nextcloud`` liest der Server
die Dateien aus dem Konto-Laufwerk des Erstellers; bei ``pulse`` beantwortet
er dieselben zwei Routen aus Postgres (``dm_nutzlasten`` mit ``archiv``),
in derselben Form — Namen ``<nutzlastId>.puls``, Inhalt derselbe Umschlag
wie beim Abholen. Der Klient unterscheidet die beiden nicht und muss es
nicht: fuer ihn ist ein verschluesselter Kanal ein Ordner mit Umschlaegen.

Mitgliedschaft + ``VIEW_CHANNEL`` wie bei jeder anderen Ablage-Kanal-Route
(``_kanal_fuer_mitglied``, importiert aus ``ablage_kanal.py`` statt
kopiert). ``GET`` gilt fuer jedes Mitglied — Namen verraten nichts ueber den
Inhalt (Chiffrat).

Das ``PUT`` verlangt zusaetzlich ``MANAGE_CHANNELS``. Es entscheidet, WO
und in wessen Laufwerk der dauerhafte Bestand dieses Kanals kuenftig liegt —
eine Kanal-Verwaltungsentscheidung, wie sie ``routes/channels.py`` und
``routes/dropbox.py`` fuer Anlegen/Umbenennen/Loeschen ebenfalls an dieses
Recht binden. Ohne die Pruefung koennte jedes einfache Mitglied den Kanal an
sein eigenes Laufwerk binden, solange noch niemand anders es getan hat (das
409 greift erst danach).
"""

from __future__ import annotations

import re
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Path, Query, Response, status
from pydantic import BaseModel
from sqlalchemy import select

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.ablage_kanal_ordner import datei_inhalt, datei_name, ordner_pfad
from dcc_chat_gateway.ablage_schreiben import liste as liste_vom_laufwerk
from dcc_chat_gateway.ablage_ssrf import AblageAbrufFehler
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    AblageKanalLaufwerk,
    AblageKanalOrdner,
    AblageKontoLaufwerk,
    DmNutzlast,
)
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.routes._ablage_abruf import ablage_abruf_antwort
from dcc_chat_gateway.routes._postfach_festigung import SPEICHER_PULSE
from dcc_chat_gateway.routes.ablage_kanal import _kanal_fuer_mitglied
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()


class OrdnerAnlegenIn(BaseModel):
    """Wo der Bestand dieses Kanals liegen soll.

    **Vorgabe ``pulse``**, waehrend die Spalte in der Datenbank
    ``nextcloud`` vorgibt: eine Zeile ohne Angabe stammt aus der Zeit vor
    dieser Entscheidung, eine Anfrage ohne Angabe meint den heutigen Weg.
    """

    speicher: Literal["pulse", "nextcloud"] = SPEICHER_PULSE


# Dieselbe Form wie ``ablage_kanal_ordner.datei_name`` — hier zusaetzlich als
# Filter/Validierung, weil der Aufrufer (Cursor und Dateiname) einen Namen
# mitbringt statt eine ID entgegenzunehmen.
#: ``fullmatch``, nicht ``match``: ``$`` traefe auch VOR einem abschliessenden
#: Zeilenumbruch, ``"12.puls\n"`` haette den Filter also bestanden und waere
#: als Pfadsegment an die fremde Cloud gegangen.
_DATEI_MUSTER = re.compile(r"\d+\.puls")


def _puls_id(name: str) -> int:
    """Die numerische ID aus einem ``<id>.puls``-Namen — nur fuer Namen
    aufrufen, die ``_DATEI_MUSTER`` schon bestanden haben."""
    return int(name[: -len(".puls")])


@router.put(
    "/channels/{channel_id}/ablage/ordner",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def ordner_kanal_anlegen(
    channel_id: int,
    session: SessionDep,
    current: CurrentUser,
    payload: OrdnerAnlegenIn | None = None,
) -> Response:
    """Macht den Aufrufer zum Ersteller des Ordner-Kanals — analog zu
    ``ablage_kanal.setze_freigabe_adresse``: das erste erfolgreiche PUT legt
    die Zeile an, jedes weitere von demselben Konto ist ein No-Op, ein
    fremdes 409.

    **412 nur im Nextcloud-Weg** („kein Konto-Laufwerk"): der Zustand liegt
    nicht am mitgeschickten Koerper, sondern an einer Vorbedingung auf dem
    Konto des Aufrufers, die dieser erst an anderer Stelle herstellen muss
    (``PUT /ablage/archiv/laufwerk``). Ein Pulse-Kanal braucht kein
    Laufwerk — sein Bestand liegt hier.

    ``MANAGE_CHANNELS`` VOR dem Ratenbegrenzer: wer das Recht nicht hat,
    soll nicht erst einen Eimer belasten, um dann abgewiesen zu werden.
    """
    channel = await _kanal_fuer_mitglied(session, channel_id, current)
    await check_permission(
        session,
        current,
        channel.guild_id,
        Permissions.MANAGE_CHANNELS,
        channel_id=channel.id,
    )
    # Eimer ``ablage_laufwerk_setzen``, nicht ``ablage_abruf`` — dieselbe
    # Kategorie wie ``ablage_kanal.setze_freigabe_adresse``: das PUT setzt
    # eine Adresse/Zeile fest, es liest nichts, gehoert also zum
    # Schwester-Eimer der Laufwerk-Setz-Routen, nicht zum Lese-Eimer.
    if not ratelimit.check("ablage_laufwerk_setzen", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")

    speicher = payload.speicher if payload is not None else SPEICHER_PULSE
    if speicher != SPEICHER_PULSE:
        laufwerk = await session.get(AblageKontoLaufwerk, current.id)
        if laufwerk is None:
            raise HTTPException(
                status.HTTP_412_PRECONDITION_FAILED, detail="no account drive"
            )

    # **Die beiden Wege schliessen einander aus.** Ein Kanal liegt entweder
    # an einer eigenen Freigabe-Adresse (``AblageKanalLaufwerk``, der
    # Google-/Dropbox-Weg) ODER als Ordner im Konto-Laufwerk seines
    # Erstellers — nie beides. Ohne diesen Riegel entstuenden zwei Bestaende
    # desselben Kanals an zwei Orten, und keiner der beiden waere der
    # vollstaendige; welcher gelesen wird, entschiede der Zufall der
    # Klient-Reihenfolge. Das Gegenstueck steht in
    # ``ablage_kanal.py::setze_freigabe_adresse``.
    if await session.get(AblageKanalLaufwerk, channel.id) is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="this channel already has its own share drive",
        )

    bestehend = await session.get(AblageKanalOrdner, channel.id)
    if bestehend is None:
        session.add(
            AblageKanalOrdner(
                channel_id=channel.id, ersteller_id=current.id, speicher=speicher
            )
        )
        await session.commit()
    elif bestehend.ersteller_id != current.id:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="this channel is already a folder channel of another member",
        )
    elif bestehend.speicher != speicher:
        # Derselbe Ersteller, aber ein anderer Speicher: ein 204 waere hier
        # eine Luege — der Bestand liegt danach weiter, wo er lag, und der
        # Aufrufer glaubte, er habe ihn umgezogen. Umziehen kann diese Route
        # nicht (die bestehenden Nachrichten muessten mit), also sagt sie es.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="this channel already stores its history elsewhere",
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/channels/{channel_id}/ablage/ordner")
async def ordner_kanal_liste(
    channel_id: int,
    session: SessionDep,
    current: CurrentUser,
    nach: Annotated[str | None, Query(max_length=64)] = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
) -> list[str]:
    """Die Dateinamen im Kanal-Ordner — nur ``<id>.puls``, numerisch
    aufsteigend, optional strikt hinter ``nach`` abgeschnitten.

    **404 statt leere Liste**, wenn der Kanal ueberhaupt kein Ordner-Kanal
    ist — der Klient faellt dann auf den alten Zustellweg zurueck (den es
    fuer jeden Kanal gibt); eine leere Liste saehe stattdessen wie ein leerer,
    aber vorhandener Ordner-Kanal aus.
    """
    channel = await _kanal_fuer_mitglied(session, channel_id, current)
    ordner_zeile = await session.get(AblageKanalOrdner, channel.id)
    if ordner_zeile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not a folder channel")
    if not ratelimit.check("ablage_abruf", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")

    if ordner_zeile.speicher == SPEICHER_PULSE:
        # Der Bestand steht hier: die Archiv-Nutzlasten dieses Kanals,
        # aufsteigend hinter dem Cursor. Sortiert und geschnitten wird in
        # der Datenbank (Teil-Index ``ix_dm_nutzlasten_archiv``), nicht in
        # Python — anders als beim Nextcloud-Weg, wo die Liste als Ganzes
        # von der fremden Cloud kommt.
        bedingungen = [DmNutzlast.channel_id == channel.id, DmNutzlast.archiv.is_(True)]
        if nach is not None:
            bedingungen.append(DmNutzlast.id > _cursor_id(nach))
        ids = (
            await session.execute(
                select(DmNutzlast.id).where(*bedingungen).order_by(DmNutzlast.id).limit(limit)
            )
        ).scalars()
        return [datei_name(i) for i in ids]

    laufwerk = await session.get(AblageKontoLaufwerk, ordner_zeile.ersteller_id)
    if laufwerk is None:
        raise HTTPException(status.HTTP_412_PRECONDITION_FAILED, detail="no account drive")

    # **Einmal, und VOR dem Abruf.** Vorher stand der Aufruf in der
    # Filter-Schleife: er lief je Dateinamen einmal, und bei einem LEEREN
    # Ordner gar nicht — ein unlesbarer Cursor kam dann als 200 mit leerer
    # Liste zurueck, also genau als die Sackgasse, gegen die ``_cursor_id``
    # gebaut ist.
    cursor = _cursor_id(nach) if nach is not None else None

    try:
        roh = await liste_vom_laufwerk(
            basis=laufwerk.freigabe_adresse, ordner=ordner_pfad(channel.id)
        )
    except AblageAbrufFehler as fehler:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=str(fehler)) from fehler

    passend = [name for name in roh if _DATEI_MUSTER.fullmatch(name)]
    passend.sort(key=_puls_id)
    if cursor is not None:
        passend = [name for name in passend if _puls_id(name) > cursor]
    return passend[:limit]


def _cursor_id(nach: str) -> int:
    """Der Cursor als Zahl — 422 bei allem anderen.

    Frueher blendete ein unlesbarer Cursor schlicht nichts aus. Das ist der
    schlechtere Fehlermodus: der Klient blaettert, bekommt jedes Mal
    dieselbe erste Seite und laeuft entweder ewig im Kreis oder legt jede
    Nachricht doppelt ab — beides ohne eine einzige Fehlermeldung. Ein
    ungueltiger Cursor ist ein Klientenfehler und soll als solcher
    sichtbar sein, genau wie ein ungueltiger Dateiname an der
    Einzel-Datei-Route.

    Der Cursor ist die NUTZLAST-ID des zuletzt gesehenen Namens, nicht der
    Name selbst (``ablage/ordnerSeiten.ts::naechsterCursor`` auf der
    Klientenseite) — ``17`` also, nicht ``17.puls``.
    """
    try:
        return int(nach)
    except ValueError as fehler:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid cursor"
        ) from fehler


@router.get("/channels/{channel_id}/ablage/ordner/{name}")
async def ordner_kanal_datei(
    channel_id: int,
    session: SessionDep,
    current: CurrentUser,
    name: Annotated[str, Path(max_length=64)],
) -> Response:
    """Eine einzelne Datei aus dem Kanal-Ordner, roh durchgereicht."""
    if not _DATEI_MUSTER.fullmatch(name):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid file name")

    channel = await _kanal_fuer_mitglied(session, channel_id, current)
    ordner_zeile = await session.get(AblageKanalOrdner, channel.id)
    if ordner_zeile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not a folder channel")
    if not ratelimit.check("ablage_abruf", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")

    if ordner_zeile.speicher == SPEICHER_PULSE:
        nutzlast = await session.get(DmNutzlast, _puls_id(name))
        # Kanal UND ``archiv`` gehoeren beide zur Pruefung: die Nutzlast-ID
        # ist ein Snowflake und ratbar, und eine gewoehnliche Postfach-Zeile
        # ist kein Bestand dieses Kanals, sondern Post an ein einzelnes
        # Geraet.
        if nutzlast is None or nutzlast.channel_id != channel.id or not nutzlast.archiv:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")
        return Response(content=datei_inhalt(nutzlast), media_type="application/json")

    laufwerk = await session.get(AblageKontoLaufwerk, ordner_zeile.ersteller_id)
    if laufwerk is None:
        raise HTTPException(status.HTTP_412_PRECONDITION_FAILED, detail="no account drive")

    return await ablage_abruf_antwort(
        laufwerk.freigabe_adresse, f"{ordner_pfad(channel.id)}/{name}"
    )


__all__ = ["router"]
