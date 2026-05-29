"""``PUT /channels/{cid}/members/{uid}/voice-override`` — admin
force-mute / unmute (caller must hold ``MUTE_MEMBERS``). Persists the
override in Redis so re-issued tokens stay muted on reconnect and
pushes a ``voice_override`` event on ``voice:events`` so listening
clients update immediately."""

from __future__ import annotations

import asyncio
import json
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Path, Request, status
from pydantic import BaseModel, ConfigDict

from dcc_voice_signaling import routes as voice_routes
from dcc_voice_signaling.security import CurrentUser

# Snowflake-format path parameter constraint (mirrors InternalEvictIn.user_id).
_SnowflakePath = Annotated[str, Path(min_length=1, max_length=20, pattern=r"^\d+$")]

router = APIRouter()


class VoiceOverrideIn(BaseModel):
    """Partial override patch — at least one of ``mute`` / ``deafen``
    must be set. Each field is checked against its own permission bit
    (``MUTE_MEMBERS`` / ``DEAFEN_MEMBERS``) so callers with only one of
    the two can still operate. ``None`` means "don't touch that flag"."""

    model_config = ConfigDict(extra="forbid")
    mute: bool | None = None
    deafen: bool | None = None


@router.put("/channels/{channel_id}/members/{user_id}/voice-override")
async def set_voice_override(
    channel_id: _SnowflakePath,
    user_id: _SnowflakePath,
    payload: VoiceOverrideIn,
    caller: CurrentUser,
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, bool]:
    """Force-mute / -deafen / clear-overrides for a participant.

    Each field is independently permission-gated:
      * ``mute``   → requires ``MUTE_MEMBERS``    — drives LiveKit publish
                     grant (microphone is removed/restored from publish
                     sources at next reconnect; live LiveKit call is
                     best-effort for current connection).
      * ``deafen`` → requires ``DEAFEN_MEMBERS`` — purely client-side courtesy
                     signal only, with no server-side audio enforcement. The
                     receiving client mutes its own playback and refuses to
                     undeafen until the override is cleared. A user running a
                     modified client can ignore this signal.

    Writes the merged override to Redis so it survives reconnect, and
    publishes the full state on ``voice:events`` for chat-gateway to
    broadcast as ``voice_override``.
    """
    if payload.mute is None and payload.deafen is None:
        raise HTTPException(400, detail="at least one of 'mute' / 'deafen' must be set")
    if user_id == str(caller.id):
        raise HTTPException(400, detail="cannot apply voice overrides to yourself")
    bearer = voice_routes._bearer_from_header(authorization)
    # Same membership + voice-channel check as token-issue. Acts as an
    # implicit existence check for the channel. Both calls are independent
    # GETs, so fire them concurrently.
    _, perms = await asyncio.gather(
        voice_routes._require_voice_channel_member(channel_id, bearer),
        voice_routes._resolve_channel_permissions(channel_id, bearer),
    )
    if payload.mute is not None and not (perms & voice_routes._PERM_MUTE_MEMBERS):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="missing permission: MUTE_MEMBERS"
        )
    if payload.deafen is not None and not (perms & voice_routes._PERM_DEAFEN_MEMBERS):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="missing permission: DEAFEN_MEMBERS"
        )

    # Verify that the target user is a member of the channel's guild. This
    # prevents an admin from writing arbitrary overrides for users outside
    # their guild.
    settings = voice_routes.get_settings()
    if settings.chat_gateway_url is not None:
        # Fetch the channel to get its guild_id.
        try:
            channel_resp = await voice_routes._chat_gateway_request(
                "GET", f"/channels/{channel_id}", bearer=bearer
            )
            if channel_resp.status_code == 200:
                channel_data = channel_resp.json()
                guild_id = channel_data.get("guild_id")
                if guild_id:
                    # Verify the target user is a member of this guild.
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

    # Merge: read current → apply patch → write back. Lets a caller
    # toggle mute without disturbing an existing deafen, and vice-versa.
    current = await voice_routes._load_override(redis, channel_id, user_id)
    next_state: dict[str, bool] = {
        "muted": bool(current.get("muted")),
        "deafened": bool(current.get("deafened")),
    }
    if payload.mute is not None:
        next_state["muted"] = bool(payload.mute)
    if payload.deafen is not None:
        next_state["deafened"] = bool(payload.deafen)

    if not next_state["muted"] and not next_state["deafened"]:
        await voice_routes._clear_override(redis, channel_id, user_id)
    else:
        await voice_routes._save_override(redis, channel_id, user_id, next_state)

    # Live LiveKit update is only meaningful for the mute side — the
    # deafen enforcement is client-only (LiveKit doesn't gate inbound
    # subscriptions by participant permission). Skip the LiveKit call
    # if mute wasn't part of this patch.
    if payload.mute is not None:
        cached_sources = await voice_routes._load_user_sources(redis, channel_id, user_id)
        if next_state["muted"]:
            # Strip "microphone" from the user's cached sources; keep
            # the rest (camera, screen_share) intact so a non-mic
            # publish isn't collateral damage.
            base = cached_sources if cached_sources is not None else [
                "camera",
                "screen_share",
                "screen_share_audio",
            ]
            new_sources = [s for s in base if s != "microphone"]
        else:
            # Restore exactly what the user was permitted to publish at
            # their last token-issue. Missing cache (e.g. Redis flush
            # during the mute) → conservative microphone-only fallback;
            # the user's real grants take effect at their next reconnect.
            new_sources = (
                list(cached_sources)
                if cached_sources is not None
                else ["microphone"]
            )
        livekit_api = getattr(request.app.state, "livekit_api", None)
        await voice_routes._livekit_update_participant(
            channel_id,
            user_id,
            can_publish=bool(new_sources),
            sources=new_sources,
            api_client=livekit_api,
        )

    from dcc_shared.events import VoiceOverrideEvent

    envelope = VoiceOverrideEvent(
        channel_id=channel_id,
        user_id=user_id,
        muted=next_state["muted"],
        deafened=next_state["deafened"],
    )
    await redis.publish(
        voice_routes._VOICE_EVENTS_CHANNEL,
        json.dumps(envelope.model_dump(mode="json")),
    )
    return {"muted": next_state["muted"], "deafened": next_state["deafened"]}
