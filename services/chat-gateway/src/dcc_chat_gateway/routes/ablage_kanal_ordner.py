"""Ordner-Kanal: anlegen + lesen (Entwurf 2026-09-02, §2-3, Task 5).

Die drei Routen, die zum Ableger (``ablage_kanal_ordner.py``, das
gleichnamige Nicht-Route-Modul) und zum Nachtrag gehoeren:

* ``PUT .../ablage/ordner`` — der Ersteller macht seinen Kanal zu einem
  Ordner-Kanal (legt ``AblageKanalOrdner`` an). Danach schreibt der Server
  dorthin (``ablegen``), Mitglieder lesen ueber die beiden GET-Routen.
* ``GET .../ablage/ordner`` — die Dateiliste, gefiltert auf ``<id>.puls``
  und numerisch sortiert, mit Cursor (``nach``) und Obergrenze (``limit``).
* ``GET .../ablage/ordner/{name}`` — eine einzelne Datei, roh durchgereicht.

Mitgliedschaft + ``VIEW_CHANNEL`` wie bei jeder anderen Ablage-Kanal-Route
(``_kanal_fuer_mitglied``, importiert aus ``ablage_kanal.py`` statt
kopiert). ``GET`` gilt fuer jedes Mitglied — Namen verraten nichts ueber den
Inhalt (Chiffrat); nur das ``PUT`` ist dem Ersteller vorbehalten.
"""

from __future__ import annotations

import re
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query, Response, status

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.ablage_kanal_ordner import ordner_pfad
from dcc_chat_gateway.ablage_schreiben import liste as liste_vom_laufwerk
from dcc_chat_gateway.ablage_ssrf import AblageAbrufFehler
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import AblageKanalOrdner, AblageKontoLaufwerk
from dcc_chat_gateway.routes._ablage_abruf import ablage_abruf_antwort
from dcc_chat_gateway.routes.ablage_kanal import _kanal_fuer_mitglied
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()

# Dieselbe Form wie ``ablage_kanal_ordner.datei_name`` — hier zusaetzlich als
# Filter/Validierung, weil der Aufrufer (Cursor und Dateiname) einen Namen
# mitbringt statt eine ID entgegenzunehmen.
_DATEI_MUSTER = re.compile(r"^\d+\.puls$")


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
) -> Response:
    """Macht den Aufrufer zum Ersteller des Ordner-Kanals — analog zu
    ``ablage_kanal.setze_freigabe_adresse``: das erste erfolgreiche PUT legt
    die Zeile an, jedes weitere von demselben Konto ist ein No-Op, ein
    fremdes 409.

    **412 statt 400/422** fuer „kein Konto-Laufwerk": der Zustand liegt
    nicht am mitgeschickten Koerper (es gibt keinen), sondern an einer
    Vorbedingung auf dem Konto des Aufrufers, die dieser erst an anderer
    Stelle herstellen muss (``PUT /ablage/archiv/laufwerk``).
    """
    channel = await _kanal_fuer_mitglied(session, channel_id, current)
    # Eimer ``ablage_laufwerk_setzen``, nicht ``ablage_abruf`` — dieselbe
    # Kategorie wie ``ablage_kanal.setze_freigabe_adresse``: das PUT setzt
    # eine Adresse/Zeile fest, es liest nichts, gehoert also zum
    # Schwester-Eimer der Laufwerk-Setz-Routen, nicht zum Lese-Eimer.
    if not ratelimit.check("ablage_laufwerk_setzen", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")

    laufwerk = await session.get(AblageKontoLaufwerk, current.id)
    if laufwerk is None:
        raise HTTPException(status.HTTP_412_PRECONDITION_FAILED, detail="no account drive")

    bestehend = await session.get(AblageKanalOrdner, channel.id)
    if bestehend is None:
        session.add(AblageKanalOrdner(channel_id=channel.id, ersteller_id=current.id))
        await session.commit()
    elif bestehend.ersteller_id != current.id:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="this channel is already a folder channel of another member",
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

    laufwerk = await session.get(AblageKontoLaufwerk, ordner_zeile.ersteller_id)
    if laufwerk is None:
        raise HTTPException(status.HTTP_412_PRECONDITION_FAILED, detail="no account drive")

    try:
        roh = await liste_vom_laufwerk(
            basis=laufwerk.freigabe_adresse, ordner=ordner_pfad(channel.id)
        )
    except AblageAbrufFehler as fehler:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=str(fehler)) from fehler

    passend = [name for name in roh if _DATEI_MUSTER.match(name)]
    passend.sort(key=_puls_id)
    if nach is not None:
        schranke = _puls_id_wenn_gueltig(nach)
        if schranke is not None:
            passend = [name for name in passend if _puls_id(name) > schranke]
    return passend[:limit]


def _puls_id_wenn_gueltig(nach: str) -> int | None:
    """``nach`` kommt vom Aufrufer und muss keine gueltige ID sein — ein
    ungueltiger Cursor blendet dann schlicht nichts aus, statt die Route mit
    422 scheitern zu lassen (der Cursor ist eine Fortsetzungs-Markierung,
    kein validierter Dateiname wie bei der Einzel-Datei-Route)."""
    try:
        return int(nach)
    except ValueError:
        return None


@router.get("/channels/{channel_id}/ablage/ordner/{name}")
async def ordner_kanal_datei(
    channel_id: int,
    session: SessionDep,
    current: CurrentUser,
    name: Annotated[str, Path(max_length=64)],
) -> Response:
    """Eine einzelne Datei aus dem Kanal-Ordner, roh durchgereicht."""
    if not _DATEI_MUSTER.match(name):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid file name")

    channel = await _kanal_fuer_mitglied(session, channel_id, current)
    ordner_zeile = await session.get(AblageKanalOrdner, channel.id)
    if ordner_zeile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not a folder channel")
    if not ratelimit.check("ablage_abruf", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")

    laufwerk = await session.get(AblageKontoLaufwerk, ordner_zeile.ersteller_id)
    if laufwerk is None:
        raise HTTPException(status.HTTP_412_PRECONDITION_FAILED, detail="no account drive")

    return await ablage_abruf_antwort(
        laufwerk.freigabe_adresse, f"{ordner_pfad(channel.id)}/{name}"
    )


__all__ = ["router"]
