"""Verschluesselte Anhaenge und die Cloud-Laufwerke der Beteiligten (§11).

Zwei Routen, beide um dieselbe Entscheidung herum: ein Anhang lebt kuenftig
im Archiv-Ordner JEDES Beteiligten, nicht bei Pulse (Design §11.1).

``POST /postfach/anhaenge/{id}/verteilen`` schiebt das Chiffrat in jedes
dieser Laufwerke und gibt danach die eigene Kopie frei. Die eigentliche
Arbeit steht in ``ablage_anhang_verteilung.py``; hier stehen nur Zugang,
Grenze und die Uebersetzung in HTTP.

``GET /postfach/anhaenge/bereitschaft`` beantwortet die Frage, die §11.2
ausdruecklich als neue Auskunft ueber andere Konten in Kauf nimmt: kann
dieses Gespraech ueberhaupt Anhaenge tragen — und wenn nicht, an WEM liegt
es. Ohne die zweite Haelfte koennte die Oberflaeche den Fall nur ausgrauen,
nicht benennen, und in einer Gruppe waere voellig unklar, wer blockiert.

**Warum die Verteilung an der Anfrage haengt und nicht im Hintergrund
laeuft.** Ein Fehlschlag im Hintergrund waere unsichtbar — genau die
Fehlerklasse, die dieses Vorhaben vermeiden soll. Hier faellt er auf die
Anhang-Kachel im Verfasser zurueck, die ohnehin einen Fehlerzustand
zeichnet. Der Preis ist eine laengere Anfrage waehrend des Hochladens; das
ist der Moment, in dem ein Nutzer ohnehin wartet.

**Wann verteilt wird: beim Hochladen, nicht beim Absenden.** Damit steckt
die Wartezeit im Upload statt im Absenden, und die bestehende
Fortschritts-/Fehleranzeige traegt sie. Der Preis, offen benannt: wer eine
Datei hochlaedt und die Nachricht dann verwirft, hat Bytes in fremden
Ordnern liegen, die niemand mehr oeffnen kann (kein Umschlag traegt ihren
Schluessel). Aufraeumen ist laut §11.5 ausdruecklich ein spaeterer Schritt.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response, status
from pydantic import BaseModel

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.ablage_anhang_verteilung import (
    AnhangVerteilFehler,
    laufwerke_der_beteiligten,
    verteile_anhang,
)
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import MessageAttachment
from dcc_chat_gateway.routes._postfach_deps import _channel_zugriff_pruefen
from dcc_chat_gateway.schemas import SnowflakeId
from dcc_chat_gateway.security import CurrentUser

router = APIRouter(tags=["postfach"])


class AnhangBereitschaftOut(BaseModel):
    """Kann dieses Gespraech Anhaenge tragen?

    ``ohne_laufwerk`` traegt die Konten, an denen es scheitert — als
    Zeichenketten, wie jede Snowflake ueber diese API (JS ``Number`` kann
    64 Bit nicht exakt). Es ist ausdruecklich eine Auskunft ueber andere
    Konten (§11.2): sie sagt, dass jemand kein Archiv-Laufwerk verbunden
    hat, und nichts sonst — keine Adresse, kein Anbieter, kein Inhalt. Sie
    geht nur an Teilnehmer desselben Kanals, weil die Route dieselbe
    Kanalpruefung fuehrt wie das Einliefern selbst.
    """

    moeglich: bool
    ohne_laufwerk: list[str]
    #: Damit der Klient VOR dem Hochladen warnen kann statt danach (§11.3).
    #: Steht zusaetzlich in ``GET /capabilities``; hier noch einmal, damit die
    #: Antwort, die den Knopf freischaltet, auch seine Grenze mitbringt.
    max_bytes: int


@router.get("/postfach/anhaenge/bereitschaft", response_model=AnhangBereitschaftOut)
async def anhang_bereitschaft(
    session: SessionDep,
    user: CurrentUser,
    channel_id: Annotated[SnowflakeId, Query()],
) -> AnhangBereitschaftOut:
    """Haben ALLE Beteiligten dieses Kanals ein Archiv-Laufwerk?

    Dieselbe Kanalpruefung wie beim Einliefern (``_channel_zugriff_pruefen``)
    — wer hier fragen darf, darf in diesen Kanal auch zustellen. Eine
    lockerere Regel waere eine Konto-Auskunft an Unbeteiligte.
    """
    zugriff = await _channel_zugriff_pruefen(session, int(channel_id), user)
    laufwerke = await laufwerke_der_beteiligten(session, zugriff.teilnehmer)
    fehlend = sorted(zugriff.teilnehmer - laufwerke.keys())
    return AnhangBereitschaftOut(
        moeglich=not fehlend,
        ohne_laufwerk=[str(uid) for uid in fehlend],
        max_bytes=chat_config.get_settings().ablage_anhang_max_bytes,
    )


@router.post(
    "/postfach/anhaenge/{anhang_id}/verteilen",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def anhang_verteilen(
    anhang_id: int,
    session: SessionDep,
    user: CurrentUser,
) -> Response:
    """Legt das Chiffrat in jedes Beteiligten-Laufwerk, gibt die eigene Kopie
    frei und quittiert mit 204.

    **Nur der Hochladende ruft das**, und nur fuer eine noch nicht an eine
    Nachricht gebundene Zeile: es ist die Fortsetzung seines eigenen
    Uploads. Eine fremde Kennung bekommt dieselbe 404 wie eine, die es nicht
    gibt — wer nicht hochgeladen hat, soll nicht erfahren, ob sie existiert.

    Ein zweiter Aufruf fuer denselben Anhang ist erfolgreich und tut nichts
    (``verteile_anhang`` sieht die Marke). Ein Wiederholungsversuch des
    Klienten nach einem Netzabbruch soll nicht dieselben Bytes ein zweites
    Mal in fremde Ordner schieben.
    """
    if not ratelimit.check("attach", user.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded")

    zeile = await session.get(MessageAttachment, anhang_id)
    if (
        zeile is None
        or zeile.deleted_at is not None
        or zeile.uploader_id != user.id
        or zeile.message_id is not None
    ):
        raise HTTPException(status_code=404, detail="anhang_nicht_gefunden")

    # Der Kanal der Zeile, nicht ein vom Aufrufer genannter: die Menge der
    # Beteiligten muss dieselbe sein, an die spaeter zugestellt wird.
    zugriff = await _channel_zugriff_pruefen(session, zeile.channel_id, user)
    try:
        await verteile_anhang(
            session,
            anhang=zeile,
            beteiligte=zugriff.teilnehmer,
            max_bytes=chat_config.get_settings().ablage_anhang_max_bytes,
        )
    except AnhangVerteilFehler as fehler:
        # 502, nicht 500: die Gegenstelle ist ein fremdes Laufwerk. Die
        # Kennung ist grob (``kein_laufwerk``, ``laufwerk_*``) und traegt nie
        # eine Adresse — der Klient macht daraus einen Satz an der Kachel.
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=fehler.code) from fehler
    return Response(status_code=status.HTTP_204_NO_CONTENT)
