"""``POST /internal/evict-from-voice`` — service-to-service eviction
called by chat-gateway on kick / ban. Gated by a shared secret header
(``X-Pulse-Internal-Secret``); empty secret in config DISABLES the
endpoint entirely so a misconfigured deploy can't accidentally expose
a no-auth eviction path."""

from __future__ import annotations

import asyncio
import hmac
import json
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field

from dcc_voice_signaling import routes as voice_routes

router = APIRouter()


class InternalEvictIn(BaseModel):
    """Service-to-service eviction request from chat-gateway. Fired on
    kick + ban so voice-signaling can clean up the LiveKit session and
    any persisted voice-overrides for every voice channel in the guild."""

    model_config = ConfigDict(extra="forbid")
    channel_ids: Annotated[
        list[Annotated[str, Field(min_length=1, max_length=64, pattern=r"^\d+$")]],
        Field(max_length=100),
    ]
    # Nutzer-ID oder Gast-Kennung (``gast-<id>``) — chat-gateway wirft über
    # denselben Weg Mitglieder (Kick/Bann) und Gäste (Link-Entwertung) raus.
    user_id: Annotated[
        str, Field(min_length=1, max_length=64, pattern=r"^(gast-)?\d+$")
    ]


@router.post("/internal/evict-from-voice", status_code=204)
async def internal_evict_from_voice(
    payload: InternalEvictIn,
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    x_pulse_internal_secret: Annotated[str | None, Header()] = None,
) -> None:
    """Service-to-service: bulk LiveKit-remove + override-clear for
    every channel in ``channel_ids`` for ``user_id``. No user-bearer
    permission check — gated by a shared secret. Empty secret in
    config DISABLES the endpoint entirely (production deployments must
    set ``internal_service_secret``)."""
    settings = voice_routes.get_settings()
    expected = settings.internal_service_secret
    if not expected:
        # Fail-closed when not configured: a misconfigured deploy can't
        # accidentally expose a no-auth eviction path.
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="internal endpoint disabled — set INTERNAL_SERVICE_SECRET",
        )
    if not hmac.compare_digest(x_pulse_internal_secret or "", expected):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="bad service token")

    redis = voice_routes._get_redis(request)
    uid = payload.user_id
    livekit_api = getattr(request.app.state, "livekit_api", None)

    # Fire all LiveKit removes concurrently — one RPC per channel in O(1) RTT
    # instead of O(n) sequential round-trips. Best-effort: silent on offline
    # targets, same swallow path as the admin disconnect endpoint. Reusing the
    # singleton livekit_api amortizes the connection setup cost across all
    # channels for this bulk eviction.
    await asyncio.gather(
        *[voice_routes._livekit_remove_participant(cid, uid, api_client=livekit_api) for cid in payload.channel_ids]
    )

    if redis is not None:
        from dcc_shared.events import VoiceDisconnectEvent

        # Build all override-clear + event-publish coroutines upfront, then
        # run them concurrently with a single gather call.
        coros = []
        for cid in payload.channel_ids:
            coros.append(voice_routes._clear_override(redis, cid, uid))
            envelope = VoiceDisconnectEvent(channel_id=cid, user_id=uid)
            coros.append(
                redis.publish(
                    voice_routes._VOICE_EVENTS_CHANNEL,
                    json.dumps(envelope.model_dump(mode="json")),
                )
            )
        await asyncio.gather(*coros)
