"""``POST /channels/{cid}/members/{uid}/voice-move`` — admin relocate a
participant from one voice channel to another in the same guild
(requires ``MOVE_MEMBERS`` in *both* the source and the destination
channel, mirroring Discord)."""

from __future__ import annotations

import asyncio
import json
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Path, Request, status
from pydantic import BaseModel, ConfigDict, Field

from dcc_voice_signaling import routes as voice_routes
from dcc_voice_signaling.security import CurrentUser

router = APIRouter()

# Snowflake-format path parameter constraint (mirrors InternalEvictIn.user_id).
_SnowflakePath = Annotated[str, Path(min_length=1, max_length=20, pattern=r"^\d+$")]


class VoiceMoveIn(BaseModel):
    """Destination voice channel to relocate the participant into."""

    model_config = ConfigDict(extra="forbid")
    target_channel_id: str = Field(
        ..., min_length=1, max_length=20, pattern=r"^\d+$"
    )


@router.post("/channels/{channel_id}/members/{user_id}/voice-move")
async def move_to_voice_channel(
    channel_id: _SnowflakePath,
    user_id: _SnowflakePath,
    payload: VoiceMoveIn,
    caller: CurrentUser,
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, bool]:
    """Relocate a participant to another voice channel. Requires
    ``MOVE_MEMBERS`` in **both** the source and the destination channel
    (Discord uses the same bit for kick + move; a mod must be able to
    manage both ends).

    Model note: each Pulse voice channel is its own LiveKit room, so
    there is no server-side "move between rooms" primitive. This endpoint
    is the *signal*: it validates the caller's authority and publishes a
    ``voice_move`` event; the target's own client picks it up and
    reconnects to the destination room with a freshly-minted token (its
    CONNECT permission for the destination is enforced at that
    token-issue, exactly like a normal join). A tampered/offline client
    that ignores the signal simply stays put — like the soft-deafen path,
    enforcement here is cooperative.

    Voice-overrides (mute/deafen) are per-channel and are *not* migrated
    to the destination — matching the existing per-channel override model
    (the disconnect endpoint doesn't migrate them either).
    """
    target_channel_id = payload.target_channel_id
    if user_id == str(caller.id):
        raise HTTPException(400, detail="cannot move yourself via the admin endpoint")
    if target_channel_id == channel_id:
        raise HTTPException(
            400, detail="target channel is the same as the source channel"
        )
    bearer = voice_routes._bearer_from_header(authorization)

    # Caller must be a member of both channels' guild, both must be voice
    # channels, and the caller must hold MOVE_MEMBERS in each. The four
    # GETs are independent — fire them concurrently. ``gather`` propagates
    # the first HTTPException (404 channel-not-found, 403 non-member, 400
    # not-a-voice-channel) raised by either membership check.
    _, _, source_perms, target_perms = await asyncio.gather(
        voice_routes._require_voice_channel_member(channel_id, bearer),
        voice_routes._require_voice_channel_member(target_channel_id, bearer),
        voice_routes._resolve_channel_permissions(channel_id, bearer),
        voice_routes._resolve_channel_permissions(target_channel_id, bearer),
    )
    if not (source_perms & voice_routes._PERM_MOVE_MEMBERS):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="missing permission: MOVE_MEMBERS (source channel)",
        )
    if not (target_perms & voice_routes._PERM_MOVE_MEMBERS):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="missing permission: MOVE_MEMBERS (target channel)",
        )

    # Verify both channels live in the same guild and that the target user
    # is a member of it. Stops an admin moving an arbitrary user id, or
    # bridging a user across guilds.
    settings = voice_routes.get_settings()
    if settings.chat_gateway_url is not None:
        try:
            source_resp, target_resp = await asyncio.gather(
                voice_routes._chat_gateway_request(
                    "GET", f"/channels/{channel_id}", bearer=bearer
                ),
                voice_routes._chat_gateway_request(
                    "GET", f"/channels/{target_channel_id}", bearer=bearer
                ),
            )
            # Fail closed: a non-200 on either channel must not silently skip
            # the cross-guild + membership checks (None guilds short-circuit the
            # guards below, opening a cross-guild move during a rolling restart).
            if source_resp.status_code != 200 or target_resp.status_code != 200:
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY, detail="membership check unavailable"
                )
            source_guild = source_resp.json().get("guild_id")
            target_guild = target_resp.json().get("guild_id")
            if source_guild and target_guild and source_guild != target_guild:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    detail="target channel is in a different guild",
                )
            guild_id = source_guild
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

    from dcc_shared.events import VoiceMoveEvent

    envelope = VoiceMoveEvent(
        channel_id=channel_id,
        user_id=user_id,
        target_channel_id=target_channel_id,
    )
    await redis.publish(
        voice_routes._VOICE_EVENTS_CHANNEL,
        json.dumps(envelope.model_dump(mode="json")),
    )
    return {"moved": True}
