"""Ablage-Kanal: Freigabe-Adresse setzen + Weiterreich-Route (Etappe E7).

Design ``docs/superpowers/specs/2026-08-31-ablage-kanaele-design.md``
§4.0-4.2. Ein Ablage-Kanal (``Channel.ablage``) liegt auf dem Cloud-Laufwerk
seines Erstellers; Mitglieder muessen den verschluesselten Verlauf lesen
koennen, obwohl ihr Browser die fremde Cloud oft nicht direkt erreicht
(CORS, an einer echten Nextcloud gemessen). Zwei Routen:

* ``PUT .../ablage/laufwerk`` — der Ersteller hinterlegt den Schreib-Link
  (die „Freigabe-Adresse") einmalig; danach darf nur ER ihn ersetzen.
* ``GET .../ablage/abruf`` — jedes Mitglied holt darueber Chiffrat, wenn der
  direkte Weg (Design §4.2, ``leser.ts`` probiert zuerst selbst) scheitert.

**Die Adresse verlaesst diesen Server nie wieder.** Sie wird nicht geloggt,
nicht in einer Antwort gespiegelt — auch nicht an den Ersteller selbst ueber
die PUT-Route (die quittiert nur mit 204) — und nur fuer eine Anfrage an
genau die Gegenstelle benutzt, die in ihr steht (``ablage_ssrf.py``).
"""

from __future__ import annotations

import urllib.parse
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import AblageKanalLaufwerk, Channel
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.routes._ablage_abruf import ablage_abruf_antwort
from dcc_chat_gateway.routes._deps import channel_membership
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()


class FreigabeAdresseIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    freigabe_adresse: Annotated[str, Field(min_length=1, max_length=8192)]


async def _ablage_kanal_oder_404(session: SessionDep, channel_id: int) -> Channel:
    channel = await session.get(Channel, channel_id)
    if channel is None or not channel.ablage:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="channel not found")
    return channel


@router.put(
    "/channels/{channel_id}/ablage/laufwerk",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def setze_freigabe_adresse(
    channel_id: int,
    payload: FreigabeAdresseIn,
    session: SessionDep,
    current: CurrentUser,
) -> Response:
    """Hinterlegt die Freigabe-Adresse. Erstes erfolgreiches PUT legt die
    Zeile an und macht den Aufrufer zum ``ersteller_id`` (Design §4.0 —
    ``Channel`` kennt sonst keinen Ersteller, s. ``models/ablage_laufwerk.py``);
    jedes weitere PUT darf nur noch von genau diesem Konto kommen."""
    channel = await _ablage_kanal_oder_404(session, channel_id)
    if not await channel_membership(session, channel.id, current.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not a member of this guild")
    await check_permission(
        session, current, channel.guild_id, Permissions.VIEW_CHANNEL, channel_id=channel.id
    )
    if not ratelimit.check("ablage_laufwerk_setzen", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")

    geteilt = urllib.parse.urlsplit(payload.freigabe_adresse)
    if geteilt.scheme not in ("http", "https") or not geteilt.hostname:
        raise HTTPException(422, detail="freigabe_adresse must be an http(s) URL")

    bestehend = await session.get(AblageKanalLaufwerk, channel.id)
    if bestehend is None:
        session.add(
            AblageKanalLaufwerk(
                channel_id=channel.id,
                ersteller_id=current.id,
                freigabe_adresse=payload.freigabe_adresse,
            )
        )
    elif bestehend.ersteller_id != current.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="only the member who first set this drive may replace it",
        )
    else:
        bestehend.freigabe_adresse = payload.freigabe_adresse
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/channels/{channel_id}/ablage/abruf")
async def ablage_abruf(
    channel_id: int,
    session: SessionDep,
    current: CurrentUser,
    pfad: Annotated[str, Query(min_length=1, max_length=2048)],
) -> Response:
    """Reicht Chiffrat vom Laufwerk des Kanal-Erstellers durch. Jede Regel
    aus Design §4.2 einzeln:

    * Mitgliedschaft + ``VIEW_CHANNEL`` wie bei jeder anderen Kanal-Route.
    * Die Basis-Adresse kommt AUSSCHLIESSLICH aus der DB-Zeile — ``pfad`` ist
      der einzige vom Aufrufer gelieferte Teil.
    * Normalisierung, SSRF-Schutz, Groessen-/Zeitlimit: ``ablage_ssrf.py``.
    * Ratenbegrenzung je Nutzer: ``ratelimit.py`` (In-Prozess, dasselbe
      Muster wie jede andere mutations-nahe Route hier — der chat-gateway
      hat keinen ``slowapi``, dieses Modul ist sein Ersatz dafuer).
    * Nichts wird gespeichert; ausser dem Zaehler im Ratenbegrenzer wird
      nichts protokolliert — insbesondere nie die Freigabe-Adresse oder der
      aufgeloeste Pfad.
    """
    channel = await _ablage_kanal_oder_404(session, channel_id)
    if not await channel_membership(session, channel.id, current.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not a member of this guild")
    await check_permission(
        session, current, channel.guild_id, Permissions.VIEW_CHANNEL, channel_id=channel.id
    )
    if not ratelimit.check("ablage_abruf", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")

    laufwerk = await session.get(AblageKanalLaufwerk, channel.id)
    if laufwerk is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no drive connected")

    return await ablage_abruf_antwort(laufwerk.freigabe_adresse, pfad)
