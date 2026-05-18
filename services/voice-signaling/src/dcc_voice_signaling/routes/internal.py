"""``POST /internal/evict-from-voice`` — service-to-service eviction
called by chat-gateway on kick / ban. Gated by a shared secret header
(``X-Pulse-Internal-Secret``); empty secret in config DISABLES the
endpoint entirely so a misconfigured deploy can't accidentally expose
a no-auth eviction path."""

from __future__ import annotations

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
    channel_ids: list[Annotated[str, Field(min_length=1, max_length=64)]]
    user_id: Annotated[str, Field(min_length=1, max_length=64, pattern=r"^\d+$")]


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
    if x_pulse_internal_secret != expected:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="bad service token")

    redis = voice_routes._get_redis(request)
    for cid in payload.channel_ids:
        # Best-effort LiveKit remove (silent on offline target) — same
        # swallow path as the admin disconnect endpoint.
        await voice_routes._livekit_remove_participant(cid, payload.user_id)
        if redis is not None:
            await voice_routes._clear_override(redis, cid, payload.user_id)
