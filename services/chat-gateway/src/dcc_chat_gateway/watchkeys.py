"""Watch-Party state in Redis (chat-gateway-owned).

Unlike HQ streams (where media-svc owns ``stream:channel:*``), chat-gateway is
both writer and reader for watch parties — no other service touches this
state. So all the I/O helpers live here.

State key:    ``watch:channel-<channel_id>``  (JSON, EX 6h self-heal)
Pub/Sub:      ``watch:events`` — payload is the full envelope, or
              ``{"channel_id": "<id>", "state": null}`` on stop.

State shape (all snowflake-ish ids as strings):
  {
    "source":       {"type": "youtube"|"twitch"|"native", ...},
    "host_user_id": "<uid>",
    "position":     float seconds,
    "is_playing":   bool,
    "updated_at":   int unix ms,
    "started_at":   int unix ms,
  }
"""

from __future__ import annotations

import json
import time

from redis.asyncio import Redis

from dcc_shared.events import WatchStateSnapshot

WATCH_STATE_KEY = "watch:channel-{channel_id}"
WATCH_EVENTS_CHANNEL = "watch:events"
WATCH_TTL_SECONDS = 6 * 3600

WATCH_CHAT_KEY = "watch:chat:channel-{channel_id}"
WATCH_CHAT_TTL_S = 6 * 3600
WATCH_CHAT_MAX = 200


def now_ms() -> int:
    return int(time.time() * 1000)


def expected_position(state: dict, now_ms_val: int | None = None) -> float:
    """Server-side mirror of the frontend ``expectedPosition``: where the host
    clock says playback is right now."""
    pos = float(state.get("position") or 0.0)
    if not state.get("is_playing"):
        return pos
    now = now_ms_val if now_ms_val is not None else now_ms()
    elapsed = max(0.0, (now - int(state.get("updated_at") or 0)) / 1000.0)
    return pos + elapsed


def promoted_state(state: dict, new_host_id: str, now_ms_val: int | None = None) -> dict:
    """Return a copy of ``state`` with the host swapped, position refreshed to
    the extrapolated value, and updated_at bumped. ``is_playing`` is preserved
    so the new host's player resumes seamlessly."""
    now = now_ms_val if now_ms_val is not None else now_ms()
    out = dict(state)
    out["host_user_id"] = str(new_host_id)
    out["position"] = expected_position(state, now)
    out["updated_at"] = now
    return out


async def read_state(redis: Redis, channel_id: str) -> dict | None:
    raw = await redis.get(WATCH_STATE_KEY.format(channel_id=channel_id))
    if raw is None:
        return None
    try:
        data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


async def read_states_for(redis: Redis, channel_ids: list[str]) -> list[dict]:
    """``[{"channel_id": ..., "state": {...}}, ...]`` for every channel that
    currently has an active watch party. Missing channels are omitted.

    Uses a single MGET instead of one GET per channel to reduce Redis
    round-trips from O(N) to O(1)."""
    if not channel_ids:
        return []
    keys = [WATCH_STATE_KEY.format(channel_id=cid) for cid in channel_ids]
    raws = await redis.mget(*keys)
    result = []
    for cid, raw in zip(channel_ids, raws):
        if raw is None:
            continue
        try:
            data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
        except (ValueError, TypeError):
            continue
        if not isinstance(data, dict):
            continue
        result.append({"channel_id": cid, "state": data})
    return result


async def write_state(redis: Redis, channel_id: str, state: dict) -> None:
    """Write state + publish to ``watch:events``. Always paired so listeners
    never lag the canonical key."""
    await redis.set(
        WATCH_STATE_KEY.format(channel_id=channel_id),
        json.dumps(state, separators=(",", ":")),
        ex=WATCH_TTL_SECONDS,
    )
    snapshot = WatchStateSnapshot(channel_id=channel_id, state=state)
    await redis.publish(
        WATCH_EVENTS_CHANNEL,
        json.dumps(snapshot.model_dump(mode="json"), separators=(",", ":")),
    )


async def delete_state(redis: Redis, channel_id: str) -> None:
    """Delete state + publish a null-state stop event."""
    await redis.delete(WATCH_STATE_KEY.format(channel_id=channel_id))
    snapshot = WatchStateSnapshot(channel_id=channel_id, state=None)
    await redis.publish(
        WATCH_EVENTS_CHANNEL,
        json.dumps(snapshot.model_dump(mode="json"), separators=(",", ":")),
    )
