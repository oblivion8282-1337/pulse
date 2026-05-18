"""Service-to-service helper: tell voice-signaling to evict a user
from every voice channel in a guild.

Fired from the kick + ban routes so a kicked/banned member doesn't
linger in their LiveKit voice session. Fire-and-forget: failures are
logged but don't fail the parent request — the membership change has
already been committed and the WS clients have been notified.

Test-monkeypatchable at the function level (same pattern as
``_chat_gateway_request`` and ``_livekit_update_participant`` in
voice-signaling)."""

from __future__ import annotations

import logging

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, Channel

log = logging.getLogger(__name__)


async def voice_channels_for_guild(
    session: AsyncSession, guild_id: int
) -> list[int]:
    stmt = select(Channel.id).where(
        Channel.guild_id == guild_id, Channel.type == CHANNEL_TYPE_VOICE
    )
    return list((await session.execute(stmt)).scalars())


async def evict_user_from_guild_voice(
    session: AsyncSession, guild_id: int, user_id: int
) -> None:
    """Fire-and-forget POST /internal/evict-from-voice on the voice-
    signaling service. No-op when ``internal_service_secret`` is unset
    (dev / no-voice-mod-config) or when no voice channels exist."""
    settings = get_settings()
    secret = settings.internal_service_secret
    if not secret:
        log.info("voice-evict skipped: internal_service_secret unset")
        return
    channel_ids = await voice_channels_for_guild(session, guild_id)
    if not channel_ids:
        return
    url = settings.voice_signaling_url.rstrip("/") + "/internal/evict-from-voice"
    body = {
        "channel_ids": [str(cid) for cid in channel_ids],
        "user_id": str(user_id),
    }
    try:
        async with httpx.AsyncClient(
            timeout=settings.voice_signaling_timeout_s
        ) as http:
            resp = await http.post(
                url,
                json=body,
                headers={"X-Pulse-Internal-Secret": secret},
            )
        if resp.status_code >= 400:
            log.warning(
                "voice-evict %s/%s returned %s",
                guild_id,
                user_id,
                resp.status_code,
            )
    except httpx.HTTPError as exc:
        log.warning("voice-evict %s/%s failed: %s", guild_id, user_id, exc)
