"""``POST /gast/token`` — LiveKit-Token für einen Gast (Besprechungslink).

Ein Gast hat kein Konto, keine Mitgliedschaft und keine Rolle. Deshalb ruft
diese Route **nicht** beim chat-gateway nach Mitgliedschaft und Rechten:
sein Ticket nennt den Kanal, und das IST seine Berechtigung. Die Rechte sind
fest verdrahtet statt aufgelöst — ein Gast, der durch den Rechte-Resolver
liefe, wäre ein Nutzer.

Eine eigene Route statt eines Zweigs in ``token.py``: es soll nirgends ein
„Nutzer oder Gast" an einer Abhängigkeit hängen, an dem eine spätere Änderung
still ein Loch aufreisst.
"""

from __future__ import annotations

import time
from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Request, status
from livekit import api as lk
from pydantic import BaseModel, ConfigDict, Field

from dcc_shared import gaeste
from dcc_voice_signaling import ratelimit, routes as voice_routes
from dcc_voice_signaling.routes.token import TokenOut
from dcc_voice_signaling.security import CurrentGast

router = APIRouter()


class GastTokenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel_id: Annotated[str, Field(min_length=1, max_length=64)]


@router.post("/gast/token", response_model=TokenOut)
async def issue_gast_token(
    payload: GastTokenIn,
    gast: CurrentGast,
    request: Request,
) -> TokenOut:
    settings = voice_routes.get_settings()
    if not settings.livekit_api_key or not settings.livekit_api_secret:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="LiveKit not configured"
        )
    if not ratelimit.check("token", gast.gast_id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded"
        )
    # Die Kanalbindung ist die ganze Berechtigung. Ohne diesen Vergleich wäre
    # aus dem Ticket für den Besprechungsraum eines für jeden Sprachkanal der
    # Community geworden.
    if gast.channel_id != payload.channel_id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="ticket is for another channel"
        )
    redis = voice_routes._get_redis(request)
    if await gaeste.ist_gesperrt(redis, gast.gast_id):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="removed from the meeting"
        )
    if gast.exp - int(time.time()) < 60:
        # Letzte Ticket-Minute: kein Token mehr. Der alte max(60, …)-Floor
        # hätte den LiveKit-Grant bis zu 59 s ÜBER das Ticket hinaus
        # verlängert (Audit 2026-09); für den Gast ist das dasselbe wie
        # abgelaufen.
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="ticket expired")

    room = voice_routes._room_for_channel(payload.channel_id)
    # Das Benutzerlimit des Kanals wird hier NICHT geprüft, sondern beim
    # Beitritt im chat-gateway: dort liegt die Kanal-Zeile mit dem Limit. Diese
    # Route hat keinen Nutzer-Bearer, mit dem sie danach fragen könnte (die
    # Mitglieder-Route holt es über ``_require_voice_channel_member``), und ein
    # zweiter Weg an die Zahl wäre eine zweite Wahrheit. Der Gast bekommt sein
    # Ticket also gar nicht erst, wenn der Kanal voll ist.

    # Feste Rechte, kein Resolver: sprechen, Kamera, zuhören. Kein
    # Bildschirm teilen (Zuschnitt der Funktion) und kein ``can_publish_data``
    # — der Datenkanal trägt in Pulse Fernsteuer- und Zeigerdaten, und die
    # gehen einen Gast nichts an.
    grants = lk.VideoGrants(
        room_join=True,
        room=room,
        can_publish=True,
        can_publish_sources=["microphone", "camera"],
        can_subscribe=True,
        can_publish_data=False,
    )
    # Das Token lebt nie länger als das Ticket: der Gast soll nach dessen
    # Ablauf nicht weitersitzen, nur weil LiveKit grosszügiger rechnet.
    ttl = min(
        settings.livekit_token_ttl_seconds,
        max(60, gast.exp - int(time.time())),
    )
    builder = (
        lk.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(gast.gast_id)
        .with_name(gast.name)
        .with_grants(grants)
        .with_ttl(timedelta(seconds=ttl))
    )
    return TokenOut(token=builder.to_jwt(), ws_url=settings.livekit_url, room=room)
