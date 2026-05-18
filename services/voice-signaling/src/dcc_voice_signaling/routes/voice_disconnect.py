"""``POST /channels/{cid}/members/{uid}/voice-disconnect`` — admin
kick from a voice channel (requires ``MOVE_MEMBERS``)."""

from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request, status

from dcc_voice_signaling import routes as voice_routes
from dcc_voice_signaling.security import CurrentUser

router = APIRouter()


@router.post("/channels/{channel_id}/members/{user_id}/voice-disconnect")
async def disconnect_from_voice(
    channel_id: str,
    user_id: str,
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
    await voice_routes._require_voice_channel_member(channel_id, bearer)
    perms = await voice_routes._resolve_channel_permissions(channel_id, bearer)
    if not (perms & voice_routes._PERM_MOVE_MEMBERS):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="missing permission: MOVE_MEMBERS"
        )

    redis = voice_routes._get_redis(request)
    if redis is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="redis unavailable"
        )

    await voice_routes._livekit_remove_participant(channel_id, user_id)

    await redis.publish(
        voice_routes._VOICE_EVENTS_CHANNEL,
        json.dumps(
            {
                "op": "voice_disconnect",
                "channel_id": channel_id,
                "user_id": user_id,
            }
        ),
    )
    return {"disconnected": True}
