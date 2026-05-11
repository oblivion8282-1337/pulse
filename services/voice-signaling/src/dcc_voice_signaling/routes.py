"""HTTP routes for the voice-signaling service.

This is a Phase E (Voice-Backend-Skelett) — only `POST /token`. No
Redis state, no webhook receiver. The Frontend client will use the
returned `token` + `ws_url` to dial LiveKit directly via the
livekit-client SDK.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, status
from livekit import api as lk
from pydantic import BaseModel, ConfigDict, Field

from dcc_voice_signaling.config import get_settings
from dcc_voice_signaling.security import CurrentUser

router = APIRouter()


class TokenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel_id: Annotated[str, Field(min_length=1, max_length=64)]
    # 1 = voice. The frontend may send `kind: 'voice' | 'screen'` later;
    # for the skeleton we only emit voice grants.
    kind: Annotated[str, Field(default="voice", pattern=r"^(voice|screen)$")] = "voice"


class TokenOut(BaseModel):
    token: str
    ws_url: str
    room: str


def _room_for_channel(channel_id: str) -> str:
    # Plain "channel-<snowflake>" so it's recognisable in LiveKit logs.
    return f"channel-{channel_id}"


@router.post("/token", response_model=TokenOut)
async def issue_token(payload: TokenIn, user: CurrentUser) -> TokenOut:
    settings = get_settings()
    if not settings.livekit_api_key or not settings.livekit_api_secret:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LiveKit not configured",
        )

    room = _room_for_channel(payload.channel_id)
    grants = lk.VideoGrants(
        room_join=True,
        room=room,
        can_publish=True,
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
    return TokenOut(token=token, ws_url=settings.livekit_url, room=room)
