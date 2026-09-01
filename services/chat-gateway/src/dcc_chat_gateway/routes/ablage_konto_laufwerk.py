"""Das Cloud-Laufwerk des persoenlichen Archivs — vier Routen, ein Besitzer.

Design ``docs/superpowers/specs/2026-08-31-ablage-kanaele-design.md`` §5.
Baugleich zu ``ablage_kanal.py``, aber auf das KONTO bezogen statt auf einen
Kanal — und deshalb ohne jede Mitglieder- oder Rechtepruefung: es gibt genau
einen Berechtigten, und das ist der Aufrufer selbst.

**Warum der Server das Laufwerk ueberhaupt kennt** (es ist der private
Ordner des Nutzers): weil ein Browser in eine fremde Cloud nicht schreiben
kann — deren Server setzt keine CORS-Kopfzeilen. Volle Messung im Kopf von
``ablage_schreiben.py``. Ohne diese Routen gaebe es das persoenliche Archiv
nur auf einem lokalen Ordner, also genau dort, wo es seinen Zweck nicht
erfuellt: den Verlauf auf einem NEUEN Geraet zurueckzuholen.

**Die Adresse verlaesst diesen Server nie wieder.** Sie wird nicht geloggt,
nicht gespiegelt — auch nicht an den Eigentuemer selbst; die Setz-Route
quittiert nur mit 204. Sie dient ausschliesslich dazu, selbst eine Anfrage
an genau die Gegenstelle zu stellen, die in ihr steht.

**Kein Loeschen des Ordnerinhalts.** Es gibt hier bewusst keine
Loesch-Route: ein Archiv, das der Server leeren kann, ist kein Archiv. Wer
aufraeumen will, tut es in seiner Cloud.
"""

from __future__ import annotations

import urllib.parse
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.ablage_schreiben import MAX_SCHREIB_BYTES
from dcc_chat_gateway.ablage_schreiben import liste as liste_vom_laufwerk
from dcc_chat_gateway.ablage_schreiben import schreibe as schreibe_aufs_laufwerk
from dcc_chat_gateway.ablage_ssrf import AblageAbrufFehler
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import AblageKontoLaufwerk
from dcc_chat_gateway.routes._ablage_abruf import ablage_abruf_antwort
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()


class KontoFreigabeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    freigabe_adresse: Annotated[str, Field(min_length=1, max_length=8192)]


async def _laufwerk_oder_404(session: SessionDep, current: CurrentUser) -> AblageKontoLaufwerk:
    laufwerk = await session.get(AblageKontoLaufwerk, current.id)
    if laufwerk is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no archive drive connected")
    return laufwerk


@router.put("/ablage/archiv/laufwerk", status_code=status.HTTP_204_NO_CONTENT)
async def setze_konto_laufwerk(
    payload: KontoFreigabeIn,
    session: SessionDep,
    current: CurrentUser,
) -> Response:
    """Hinterlegt die Freigabe-Adresse des persoenlichen Archivs.

    Ein zweiter Aufruf ERSETZT die bestehende Adresse — anders als beim
    Kanal-Laufwerk, wo das erste erfolgreiche Setzen den Ersteller festlegt
    und jeder weitere Aufruf von genau ihm kommen muss. Hier gibt es diesen
    Konflikt nicht: es gibt nur einen Berechtigten, und wer sein Archiv
    umzieht, soll das ohne Umweg koennen.
    """
    if not ratelimit.check("ablage_laufwerk_setzen", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")

    geteilt = urllib.parse.urlsplit(payload.freigabe_adresse)
    if geteilt.scheme not in ("http", "https") or not geteilt.hostname:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="invalid drive address")

    laufwerk = await session.get(AblageKontoLaufwerk, current.id)
    if laufwerk is None:
        session.add(
            AblageKontoLaufwerk(
                user_id=current.id, freigabe_adresse=payload.freigabe_adresse
            )
        )
    else:
        laufwerk.freigabe_adresse = payload.freigabe_adresse
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/ablage/archiv/schreiben", status_code=status.HTTP_204_NO_CONTENT)
async def schreibe_ins_archiv(
    request: Request,
    session: SessionDep,
    current: CurrentUser,
    pfad: Annotated[str, Query(min_length=1, max_length=2048)],
) -> Response:
    """Legt Chiffrat im Archiv-Ordner ab. Der Koerper ist roh."""
    laufwerk = await _laufwerk_oder_404(session, current)
    if not ratelimit.check("ablage_schreiben", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")

    inhalt = await request.body()
    if len(inhalt) > MAX_SCHREIB_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="content too large"
        )
    try:
        await schreibe_aufs_laufwerk(
            basis=laufwerk.freigabe_adresse, pfad=pfad, inhalt=inhalt
        )
    except AblageAbrufFehler as fehler:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=str(fehler)) from fehler
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/ablage/archiv/abruf")
async def hole_aus_archiv(
    session: SessionDep,
    current: CurrentUser,
    pfad: Annotated[str, Query(min_length=1, max_length=2048)],
) -> Response:
    """Reicht eine Datei aus dem Archiv-Ordner durch.

    **Das ist der Weg, der ein leeres Geraet wieder fuellt.** Er ist die
    Umkehrung des Schreibens und braucht denselben Umweg, aus demselben
    Grund — nur dass hier zusaetzlich gilt: ein 404 ist kein Fehler, sondern
    „diese Datei gibt es (noch) nicht", und der Klient behandelt sie als
    leeren Bestand.
    """
    laufwerk = await _laufwerk_oder_404(session, current)
    if not ratelimit.check("ablage_abruf", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")
    return await ablage_abruf_antwort(laufwerk.freigabe_adresse, pfad)


@router.get("/ablage/archiv/liste")
async def liste_archiv(session: SessionDep, current: CurrentUser) -> list[str]:
    """Die Dateinamen im Archiv-Ordner — nur Namen, keine Metadaten."""
    laufwerk = await _laufwerk_oder_404(session, current)
    if not ratelimit.check("ablage_abruf", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")
    try:
        return await liste_vom_laufwerk(basis=laufwerk.freigabe_adresse)
    except AblageAbrufFehler as fehler:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=str(fehler)) from fehler
