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

import asyncio
import logging

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, Channel

log = logging.getLogger(__name__)

# Singleton httpx client for the internal voice-signaling call. Opening a fresh
# ``AsyncClient`` per kick/ban allocates a new connection pool and pays a TCP+TLS
# handshake every time — wasteful on bulk-moderation flows. The pool is reused
# across calls and torn down by the FastAPI lifespan via ``shutdown_client``.
# Lazy-init under a lock so concurrent first-callers share one instance.
_client: httpx.AsyncClient | None = None
_client_lock = asyncio.Lock()


async def _ensure_client() -> httpx.AsyncClient:
    global _client
    if _client is not None:
        return _client
    async with _client_lock:
        if _client is None:
            _client = httpx.AsyncClient(
                timeout=get_settings().voice_signaling_timeout_s
            )
    return _client


async def shutdown_client() -> None:
    """Close the cached httpx client. Called from the lifespan ``finally``
    branch. Safe to call when nothing was ever initialised."""
    global _client
    if _client is None:
        return
    try:
        await _client.aclose()
    except Exception:  # noqa: BLE001 — best-effort shutdown
        pass
    _client = None


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
        http = await _ensure_client()
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
