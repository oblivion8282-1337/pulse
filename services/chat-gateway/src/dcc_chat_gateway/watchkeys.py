"""Watch-Party state in Redis (chat-gateway-owned).

Unlike HQ streams (where media-svc owns ``stream:channel:*``), chat-gateway is
both writer and reader for watch parties — no other service touches this
state. So all the I/O helpers live here.

Multiple parties can run in one voice channel at once (like several HQ streams),
each identified by its own ``party_id`` (snowflake string). The per-channel
Redis key is a **Hash**: field = ``party_id``, value = the party's JSON state.

State key:    ``watch:channel-<channel_id>``  (Redis Hash, EX 6h self-heal;
              one field per active party. Refreshed on every write, fields
              removed explicitly on stop/host-departure.)
Pub/Sub:      ``watch:events`` — one snapshot per party state change:
              ``{"channel_id": "<id>", "party_id": "<pid>", "state": {...}}``,
              or ``state: null`` when that party ended.

State shape (all snowflake-ish ids as strings):
  {
    "party_id":     "<pid>",
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
import os
import time

from redis.asyncio import Redis

from dcc_shared.events import WatchStateSnapshot

WATCH_STATE_KEY = "watch:channel-{channel_id}"
WATCH_EVENTS_CHANNEL = "watch:events"
WATCH_TTL_SECONDS = 6 * 3600

# Hard cap on concurrent watch parties in a single voice channel. Keeps one
# channel's grid from being flooded; same order of magnitude as HQ-stream tiles.
MAX_PARTIES_PER_CHANNEL = 8

# Grace window after a host's WS drops before the party ends. Covers brief
# blips / sleep so the host keeps the party across a reconnect. Env-overridable
# so the E2E suite can run it short. Read at call time (see schedule_host_end)
# so tests can monkeypatch this module attribute.
WATCH_HOST_GRACE_S = float(os.environ.get("WATCH_HOST_GRACE_S", "30"))

WATCH_CHAT_KEY = "watch:chat:channel-{channel_id}-{party_id}"
WATCH_CHAT_TTL_S = 6 * 3600
WATCH_CHAT_MAX = 200

# Ephemeral reaction store for the watch-party chat. One Redis Hash per
# party; field = <message_id>, value = JSON ``{"<emoji>": ["<uid>", ...]}``.
# Same 6h TTL as the chat list, refreshed on every toggle.
WATCH_CHAT_REACT_KEY = "watch:chat:react:channel-{channel_id}-{party_id}"

# Atomically toggle one user's reaction for (message, emoji) inside the
# per-channel reactions hash, race-safe against concurrent toggles.
#   KEYS[1] = reactions hash key
#   ARGV[1] = message_id (hash field)
#   ARGV[2] = emoji
#   ARGV[3] = user_id
#   ARGV[4] = TTL seconds
# Returns a 2-element array {added, count}:
#   added = 1 if the user_id was inserted, 0 if it was removed.
#   count = the emoji's new reactor count (after the toggle).
# Empty emoji lists and empty message fields are pruned so the hash never
# accumulates dead entries.
_LUA_TOGGLE_REACTION = """
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local data = {}
if raw then data = cjson.decode(raw) end
local emoji = ARGV[2]
local uid = ARGV[3]
local users = data[emoji] or {}
local found = -1
for i, u in ipairs(users) do
    if u == uid then found = i break end
end
local added
if found >= 0 then
    table.remove(users, found)
    added = 0
else
    table.insert(users, uid)
    added = 1
end
local count = #users
if count > 0 then
    data[emoji] = users
else
    data[emoji] = nil
end
-- Re-encode; if the message has no reactions left, drop the field entirely.
local remaining = 0
for _ in pairs(data) do remaining = remaining + 1 end
if remaining > 0 then
    redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(data))
else
    redis.call('HDEL', KEYS[1], ARGV[1])
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return {added, count}
"""


async def toggle_chat_reaction(
    redis: Redis, channel_id: str, party_id: str, message_id: str, emoji: str, user_id: str
) -> tuple[bool, int]:
    """Toggle ``user_id``'s reaction for ``(message_id, emoji)`` atomically.

    Returns ``(added, count)`` — ``added`` True if the reaction was inserted
    (False if it was removed), ``count`` the emoji's new reactor count."""
    res = await redis.eval(  # type: ignore[arg-type]
        _LUA_TOGGLE_REACTION,
        1,
        WATCH_CHAT_REACT_KEY.format(channel_id=channel_id, party_id=party_id),
        message_id,
        emoji,
        user_id,
        str(WATCH_CHAT_TTL_S),
    )
    # redis-py returns a list of ints for the Lua array reply.
    added, count = int(res[0]), int(res[1])
    return bool(added), count


async def read_chat_reactions(
    redis: Redis, channel_id: str, party_id: str
) -> dict[str, dict[str, list[str]]]:
    """All reactions for the party as ``{message_id: {emoji: [uid, ...]}}``.

    Missing / unparseable hash fields are skipped."""
    raw = await redis.hgetall(
        WATCH_CHAT_REACT_KEY.format(channel_id=channel_id, party_id=party_id)
    )
    out: dict[str, dict[str, list[str]]] = {}
    for field, value in (raw or {}).items():
        mid = field.decode() if isinstance(field, bytes) else field
        try:
            data = json.loads(value.decode() if isinstance(value, bytes) else value)
        except (ValueError, TypeError):
            continue
        if not isinstance(data, dict):
            continue
        out[mid] = {
            str(emoji): [str(u) for u in users]
            for emoji, users in data.items()
            if isinstance(users, list)
        }
    return out


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


def _parse_state(raw: object) -> dict | None:
    if raw is None:
        return None
    try:
        data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


async def read_party(redis: Redis, channel_id: str, party_id: str) -> dict | None:
    """The state of one party in a channel, or ``None`` if it isn't active."""
    raw = await redis.hget(WATCH_STATE_KEY.format(channel_id=channel_id), str(party_id))
    return _parse_state(raw)


async def read_parties(redis: Redis, channel_id: str) -> list[dict]:
    """All active party states in a channel (unordered). Each dict carries its
    own ``party_id`` field."""
    raw = await redis.hgetall(WATCH_STATE_KEY.format(channel_id=channel_id))
    out: list[dict] = []
    for value in (raw or {}).values():
        data = _parse_state(value)
        if data is not None:
            out.append(data)
    return out


async def count_parties(redis: Redis, channel_id: str) -> int:
    """Number of active parties in a channel (for the per-channel cap)."""
    return int(await redis.hlen(WATCH_STATE_KEY.format(channel_id=channel_id)))


async def read_states_for(redis: Redis, channel_ids: list[str]) -> list[dict]:
    """``[{"channel_id": ..., "party_id": ..., "state": {...}}, ...]`` for every
    active party across the given channels. Channels with no party are omitted.

    One pipelined HGETALL per channel — a channel rarely holds more than a
    handful of parties, and the pipeline keeps it to a single round-trip."""
    if not channel_ids:
        return []
    pipe = redis.pipeline()
    for cid in channel_ids:
        pipe.hgetall(WATCH_STATE_KEY.format(channel_id=cid))
    hashes = await pipe.execute()
    result = []
    for cid, hashmap in zip(channel_ids, hashes):
        for field, raw in (hashmap or {}).items():
            data = _parse_state(raw)
            if data is None:
                continue
            pid = field.decode() if isinstance(field, bytes) else str(field)
            result.append({"channel_id": cid, "party_id": pid, "state": data})
    return result


async def write_party(redis: Redis, channel_id: str, state: dict) -> None:
    """Write one party's state (keyed by ``state['party_id']``) + publish to
    ``watch:events``. Always paired so listeners never lag the canonical key.
    Refreshes the channel hash's TTL on every write (self-heal)."""
    pid = str(state["party_id"])
    key = WATCH_STATE_KEY.format(channel_id=channel_id)
    await redis.hset(key, pid, json.dumps(state, separators=(",", ":")))
    await redis.expire(key, WATCH_TTL_SECONDS)
    snapshot = WatchStateSnapshot(channel_id=str(channel_id), party_id=pid, state=state)
    await redis.publish(
        WATCH_EVENTS_CHANNEL,
        json.dumps(snapshot.model_dump(mode="json"), separators=(",", ":")),
    )


async def delete_party(redis: Redis, channel_id: str, party_id: str) -> None:
    """Remove one party from the channel hash + publish a null-state stop event.
    The channel key auto-disappears once its last party field is gone."""
    pid = str(party_id)
    await redis.hdel(WATCH_STATE_KEY.format(channel_id=channel_id), pid)
    snapshot = WatchStateSnapshot(channel_id=str(channel_id), party_id=pid, state=None)
    await redis.publish(
        WATCH_EVENTS_CHANNEL,
        json.dumps(snapshot.model_dump(mode="json"), separators=(",", ":")),
    )
