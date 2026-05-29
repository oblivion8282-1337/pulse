"""``POST /token`` — issue a LiveKit access token for joining a voice
channel. Membership + per-channel permissions are resolved via
chat-gateway (voice-signaling does not own the auth DB)."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request, status
from livekit import api as lk
from pydantic import BaseModel, ConfigDict, Field

from dcc_voice_signaling import routes as voice_routes
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


@router.post("/token", response_model=TokenOut)
async def issue_token(
    payload: TokenIn,
    user: CurrentUser,
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> TokenOut:
    settings = voice_routes.get_settings()
    if not settings.livekit_api_key or not settings.livekit_api_secret:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LiveKit not configured",
        )

    bearer = voice_routes._bearer_from_header(authorization)
    # Fire both chat-gateway calls concurrently — they are independent GETs.
    # _require_voice_channel_member raises on membership/type failure;
    # _resolve_channel_permissions returns 0 on any error (never raises).
    _, perms = await asyncio.gather(
        voice_routes._require_voice_channel_member(payload.channel_id, bearer),
        voice_routes._resolve_channel_permissions(payload.channel_id, bearer),
    )
    # CONNECT is the join gate. A member who has been deny-CONNECT'd on the
    # channel must not get *any* token — issuing a subscribe-only token here
    # would still let them sit in the room and consume bandwidth. Refuse
    # entirely instead.
    if not (perms & voice_routes._PERM_CONNECT):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="cannot connect to this voice channel",
        )
    can_publish, sources = voice_routes._publish_sources_for(perms)

    # Force-mute overrides are persistent in Redis so a kicked-and-re-joined
    # user stays muted on reconnect. Cleared by an explicit unmute call from
    # an admin.
    redis = voice_routes._get_redis(request)
    # Cache the resolved sources BEFORE the override is applied, so a
    # later unmute knows what to restore (without granting strictly
    # more than the user's token actually permitted). Skipping the
    # write when Redis is offline degrades cleanly: the unmute path
    # falls back to a microphone-only restore.
    await voice_routes._save_user_sources(redis, payload.channel_id, str(user.id), sources)
    override = await voice_routes._load_override(redis, payload.channel_id, str(user.id))
    can_publish, sources = voice_routes._apply_override(sources, can_publish, override)

    room = voice_routes._room_for_channel(payload.channel_id)
    grants = lk.VideoGrants(
        room_join=True,
        room=room,
        can_publish=can_publish,
        can_publish_sources=sources if sources else None,
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
