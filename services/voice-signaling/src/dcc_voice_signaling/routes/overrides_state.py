"""Redis-backed voice-override state.

Holds the per-(channel, user) admin force-mute / force-deafen flag plus
the cache of resolved publish-sources at token-issue time so a later
unmute can restore exactly what the user was permitted to publish."""

from __future__ import annotations

import json
import logging

from redis.asyncio import Redis

log = logging.getLogger(__name__)

# Override TTL — 24h covers a normal moderator action window. The
# override is cleared by an explicit unmute; the TTL is only the
# safety net so a forgotten mute doesn't outlive a server restart.
_OVERRIDE_TTL_SECONDS = 24 * 3600

# Source-cache TTL — long enough to outlive a typical voice session
# (incl. typical disconnects + reconnects), short enough that a stale
# entry from a removed permission auto-expires before causing harm.
_SOURCE_CACHE_TTL_SECONDS = 6 * 3600


def _override_key(channel_id: str, user_id: str) -> str:
    return f"voice:override:channel-{channel_id}:user-{user_id}"


def _sources_key(channel_id: str, user_id: str) -> str:
    return f"voice:user_sources:channel-{channel_id}:user-{user_id}"


async def _save_user_sources(
    redis: Redis | None, channel_id: str, user_id: str, sources: list[str]
) -> None:
    """Cache the resolved publish-sources at token-issue time so a
    later unmute can restore them without granting more than the
    user's actual token permitted. Best-effort — Redis offline just
    means the unmute falls back to a conservative grant."""
    if redis is None:
        return
    try:
        await redis.set(
            _sources_key(channel_id, user_id),
            json.dumps(sources),
            ex=_SOURCE_CACHE_TTL_SECONDS,
        )
    except Exception:  # noqa: BLE001
        log.warning("voice source-cache write failed", exc_info=True)


async def _load_user_sources(
    redis: Redis | None, channel_id: str, user_id: str
) -> list[str] | None:
    """Return the cached publish-sources for the user, or None if
    missing. Caller decides the conservative fallback (mic-only vs
    none) when None."""
    if redis is None:
        return None
    try:
        raw = await redis.get(_sources_key(channel_id, user_id))
    except Exception:  # noqa: BLE001
        return None
    if raw is None:
        return None
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    try:
        parsed = json.loads(raw)
        return [str(s) for s in parsed] if isinstance(parsed, list) else None
    except json.JSONDecodeError:
        return None


async def _load_override(redis: Redis | None, channel_id: str, user_id: str) -> dict:
    """Return the current override state for (channel, user) or ``{}``.

    Shape: ``{"muted": True}`` when force-muted by an admin. Missing /
    Redis-unavailable returns ``{}``, treated as "no override"."""
    if redis is None:
        return {}
    try:
        raw = await redis.get(_override_key(channel_id, user_id))
    except Exception:  # noqa: BLE001 — Redis offline; degrade to no-override
        log.warning("voice override read failed", exc_info=True)
        return {}
    if raw is None:
        return {}
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


async def _save_override(
    redis: Redis, channel_id: str, user_id: str, state: dict
) -> None:
    await redis.set(
        _override_key(channel_id, user_id),
        json.dumps(state),
        ex=_OVERRIDE_TTL_SECONDS,
    )


async def _clear_override(redis: Redis, channel_id: str, user_id: str) -> None:
    await redis.delete(_override_key(channel_id, user_id))


def _apply_override(sources: list[str], can_publish: bool, override: dict) -> tuple[bool, list[str]]:
    """Strip override-blocked sources from the publish-list.

    Force-mute removes ``microphone`` (the only source ``MUTE_MEMBERS``
    governs). Camera + screen are independently gated by USE_VIDEO /
    STREAM and out of scope for a "mute". If removing microphone leaves
    no sources, can_publish is set False so LiveKit doesn't grant a
    bare publish-no-sources token."""
    if not override.get("muted"):
        return can_publish, sources
    filtered = [s for s in sources if s != "microphone"]
    return bool(filtered), filtered
