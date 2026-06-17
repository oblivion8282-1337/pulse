"""``POST /channels/{cid}/members/{uid}/voice-disconnect`` — admin
kick from a voice channel (requires ``MOVE_MEMBERS``)."""

from __future__ import annotations

import asyncio
import json
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Path, Request, status

from dcc_voice_signaling import routes as voice_routes
from dcc_voice_signaling.security import CurrentUser

router = APIRouter()

# Snowflake-format path parameter constraint (mirrors InternalEvictIn.user_id).
_SnowflakePath = Annotated[str, Path(min_length=1, max_length=20, pattern=r"^\d+$")]


@router.post("/channels/{channel_id}/members/{user_id}/voice-disconnect")
async def disconnect_from_voice(
    channel_id: _SnowflakePath,
    user_id: _SnowflakePath,
    caller: CurrentUser,
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, bool]:
    """Force a participant out of a voice channel. Requires
    ``MOVE_MEMBERS`` (Discord uses the same bit for moving + kicking
    from voice — Pulse-v1 only supports the kick variant; "move to
    another channel" can land later).

    Implementation:
      * LiveKit ``remove_participant`` (best-effort — silent if the
        target isn't currently connected);
      * publish ``voice_disconnect`` on ``voice:events`` so the
        target's own client can drop its local voice state without
        waiting for the LiveKit ParticipantLeft webhook.

    Voice-overrides (mute/deafen) are *not* cleared. Matches Discord's
    server-mute semantics — the mod state persists across disconnect/
    rejoin in the same guild. It also closes the race where a
    concurrent ``PUT /voice-override mute=true`` committed between the
    admin's disconnect-decision and the clear: an unconditional clear
    would silently swallow that mute.
    """
    if user_id == str(caller.id):
        raise HTTPException(400, detail="cannot disconnect yourself via the admin endpoint")
    bearer = voice_routes._bearer_from_header(authorization)
    # Both calls are independent GETs — fire them concurrently.
    _, perms = await asyncio.gather(
        voice_routes._require_voice_channel_member(channel_id, bearer),
        voice_routes._resolve_channel_permissions(channel_id, bearer),
    )
    if not (perms & voice_routes._PERM_MOVE_MEMBERS):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="missing permission: MOVE_MEMBERS"
        )

    # Verify that the target user is a member of the channel's guild. This
    # prevents an admin from removing arbitrary user IDs outside their guild.
    settings = voice_routes.get_settings()
    if settings.chat_gateway_url is not None:
        try:
            channel_resp = await voice_routes._chat_gateway_request(
                "GET", f"/channels/{channel_id}", bearer=bearer
            )
            # Fail closed: a non-200 must not silently skip the membership check.
            if channel_resp.status_code != 200:
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY, detail="membership check unavailable"
                )
            channel_data = channel_resp.json()
            guild_id = channel_data.get("guild_id")
            if guild_id:
                member_resp = await voice_routes._chat_gateway_request(
                    "GET", f"/guilds/{guild_id}/members/{user_id}", bearer=bearer
                )
                if member_resp.status_code == 404:
                    raise HTTPException(
                        status.HTTP_404_NOT_FOUND,
                        detail="user is not a member of this guild",
                    )
                if member_resp.status_code >= 400:
                    raise HTTPException(
                        status.HTTP_502_BAD_GATEWAY,
                        detail="membership check unavailable",
                    )
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, detail="membership check unavailable"
            ) from exc

    redis = voice_routes._get_redis(request)
    if redis is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="redis unavailable"
        )

    livekit_api = getattr(request.app.state, "livekit_api", None)
    await voice_routes._livekit_remove_participant(channel_id, user_id, api_client=livekit_api)

    from dcc_shared.events import VoiceDisconnectEvent

    envelope = VoiceDisconnectEvent(
        channel_id=channel_id, user_id=user_id
    )
    await redis.publish(
        voice_routes._VOICE_EVENTS_CHANNEL,
        json.dumps(envelope.model_dump(mode="json")),
    )
    return {"disconnected": True}
