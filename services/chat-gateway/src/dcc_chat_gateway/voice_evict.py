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
from collections.abc import Iterable
from typing import Any

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


async def _post_evict(
    secret: str, channel_ids: list[int], user_id: str
) -> None:
    """Fire one POST /internal/evict-from-voice (one user, N channels).
    Best-effort: logs + swallows transport errors, never raises."""
    url = get_settings().voice_signaling_url.rstrip("/") + "/internal/evict-from-voice"
    body = {
        "channel_ids": [str(cid) for cid in channel_ids],
        "user_id": user_id,
    }
    try:
        http = await _ensure_client()
        resp = await http.post(
            url, json=body, headers={"X-Pulse-Internal-Secret": secret}
        )
        if resp.status_code >= 400:
            log.warning(
                "voice-evict %s/%s returned %s", channel_ids, user_id, resp.status_code
            )
    except httpx.HTTPError as exc:
        log.warning("voice-evict %s/%s failed: %s", channel_ids, user_id, exc)


async def evict_user_from_guild_voice(
    session: AsyncSession, guild_id: int, user_id: int
) -> None:
    """Fire-and-forget POST /internal/evict-from-voice on the voice-
    signaling service. No-op when ``internal_service_secret`` is unset
    (dev / no-voice-mod-config) or when no voice channels exist."""
    secret = get_settings().internal_service_secret
    if not secret:
        log.info("voice-evict skipped: internal_service_secret unset")
        return
    channel_ids = await voice_channels_for_guild(session, guild_id)
    if not channel_ids:
        return
    await _post_evict(secret, channel_ids, str(user_id))


async def evict_all_from_voice_channels(
    redis: Any, channel_ids: Iterable[int]
) -> None:
    """Evict EVERY currently-present user from the given voice channels.

    Fired when a voice channel — or its whole guild — is deleted: otherwise the
    occupants linger in a LiveKit room whose channel no longer exists (the UI
    shows them in a ghost channel and nothing self-heals it within a session).
    Reads the ``voice:room:channel-<cid>`` presence sets (same key schema the
    user-purge + reconcile paths use) and fires one per-user eviction each.

    Best-effort: no-op when the secret is unset or redis is unavailable; never
    raises (a failed eviction must not block the delete that triggered it)."""
    secret = get_settings().internal_service_secret
    if not secret or redis is None:
        return
    for cid in channel_ids:
        try:
            members = await redis.smembers(f"voice:room:channel-{cid}")
        except Exception:  # noqa: BLE001 — best-effort, skip this channel
            log.warning("voice-evict: smembers failed for channel %s", cid, exc_info=True)
            continue
        for raw in members:
            uid = raw.decode() if isinstance(raw, (bytes, bytearray)) else str(raw)
            # The evict endpoint validates ^\d+$; skip any non-numeric stray.
            if uid.isdigit():
                await _post_evict(secret, [cid], uid)
