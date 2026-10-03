"""``POST /call/token`` — LiveKit-Token für einen Anruf-Raum (Übergabe
P0, Anrufe-Epic A). Anrufe hängen an DMs/private Gruppen, nicht an
Guild-Voice-Kanäle: die Mitgliedschaft löst chat-gateway
(``GET /anrufe/{id}/mitgliedschaft``, User-Bearer durchgereicht) —
fail-closed 404/403 wie der Guild-Pfad. Der Raumname (``call-{id}``)
kommt aus der Antwort; der Client baut ihn nie selbst.

Grants wie ein Voll-Voice-Kanal (Mic + Kamera), ohne Guild-Maschinerie
(User-Limit/Force-Mute sind Kanal-Konzepte und haben im Anruf keine
Stelle — Moderation am Anruf ist ein späteres Stück)."""

from __future__ import annotations

from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, status
from livekit import api as lk
from pydantic import BaseModel, ConfigDict, Field

from dcc_voice_signaling import ratelimit, routes as voice_routes
from dcc_voice_signaling.routes.chat_gateway import (
    _bearer_from_header,
    _chat_gateway_enforced,
    _chat_gateway_request,
)
from dcc_voice_signaling.security import CurrentUser

router = APIRouter()


class CallTokenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    call_id: Annotated[str, Field(min_length=1, max_length=64)]


class CallTokenOut(BaseModel):
    token: str
    ws_url: str
    room: str


@router.post("/call/token", response_model=CallTokenOut)
async def issue_call_token(
    payload: CallTokenIn,
    user: CurrentUser,
    authorization: Annotated[str | None, Header()] = None,
) -> CallTokenOut:
    settings = voice_routes.get_settings()
    if not settings.livekit_api_key or not settings.livekit_api_secret:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LiveKit not configured",
        )

    if not ratelimit.check("call_token", user.id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded"
        )

    bearer = _bearer_from_header(authorization)
    # Fail-closed: ohne konfiguriertes chat-gateway kein Membership-Nachweis,
    # also kein Token (dieselbe Regel wie der Guild-Pfad).
    _chat_gateway_enforced()
    try:
        resp = await _chat_gateway_request(
            "GET", f"/anrufe/{payload.call_id}/mitgliedschaft", bearer=bearer
        )
    except Exception:  # noqa: BLE001 — Transportfehler → fail-closed
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="membership check unavailable",
        ) from None
    if resp.status_code == 404:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="anruf_not_found")
    if resp.status_code == 403:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not a participant")
    if resp.status_code != 200:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, detail="membership check failed"
        )
    tatbestand = resp.json()
    room = tatbestand["room"]

    grants = lk.VideoGrants(
        room_join=True,
        room=room,
        can_publish=True,
        can_publish_sources=["camera", "microphone"],
        can_subscribe=True,
        can_publish_data=True,
    )
    identity = f"user-{user.id}"
    builder = (
        lk.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(identity)
        .with_name(user.username or identity)
        .with_grants(grants)
        .with_ttl(timedelta(seconds=settings.livekit_token_ttl_seconds))
    )
    token = builder.to_jwt()
    return CallTokenOut(token=token, ws_url=settings.livekit_url, room=room)
