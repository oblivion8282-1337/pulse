"""Etappe-3 presence-status helpers.

Status values
-------------
  online     — actively connected (default on first connect)
  idle       — auto-set by the sweeper after IDLE_AFTER_MS of inactivity
  dnd        — "do not disturb", set manually, sweeper ignores
  invisible  — manually set; broadcast as ``offline`` to others
  offline    — wire-only value used in broadcasts (never stored in Redis)

Broadcast helper
----------------
``broadcast_presence_status_changed`` publishes two envelopes:
  1. Direct to the *sender's own sockets* via USER_EVENTS_CHANNEL with
     the *real* status (so they see ``invisible`` in their own UI).
  2. To friends + shared-guild members via GUILD_EVENTS_CHANNEL with
     the *masked* status (``invisible`` → ``"offline"``).

Idle sweeper
------------
``idle_sweeper_loop`` is an asyncio background task (started in
``app.py``'s lifespan) that scans the ``presence:activity`` ZSET
every ``IDLE_SWEEP_INTERVAL_S`` seconds and demotes ``online`` users
with stale activity to ``idle``.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING

from redis.asyncio import Redis

from dcc_chat_gateway.presence_keys import (
    PRESENCE_ACTIVITY_ZSET,
    PRESENCE_STATUS_KEY,
    PRESENCE_STATUS_TTL_SECONDS,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)

# --- Status string constants --------------------------------------------------

STATUS_ONLINE = "online"
STATUS_IDLE = "idle"
STATUS_DND = "dnd"
STATUS_INVISIBLE = "invisible"
STATUS_OFFLINE = "offline"  # wire-only, never stored

VALID_SET_STATUSES: frozenset[str] = frozenset(
    {STATUS_ONLINE, STATUS_IDLE, STATUS_DND, STATUS_INVISIBLE}
)

# --- Timing constants ---------------------------------------------------------

IDLE_AFTER_MS = 10 * 60 * 1000  # 10 min in milliseconds
IDLE_SWEEP_INTERVAL_S = 60  # run sweep once per minute

# --- Helpers ------------------------------------------------------------------


def _mask(status: str) -> str:
    """Map invisible → offline for external broadcasts."""
    return STATUS_OFFLINE if status == STATUS_INVISIBLE else status


async def get_presence_status(redis: Redis, user_id: int | str) -> str:
    """Read the stored status for ``user_id``.  Returns ``STATUS_ONLINE``
    when the key is absent (default on first connect / after TTL expiry)."""
    key = PRESENCE_STATUS_KEY.format(user_id=user_id)
    raw = await redis.get(key)
    if raw is None:
        return STATUS_ONLINE
    value = raw.decode() if isinstance(raw, bytes) else raw
    return value if value in VALID_SET_STATUSES else STATUS_ONLINE


async def set_presence_status(redis: Redis, user_id: int | str, status: str) -> None:
    """Write status to Redis (TTL 24 h)."""
    key = PRESENCE_STATUS_KEY.format(user_id=user_id)
    await redis.set(key, status, ex=PRESENCE_STATUS_TTL_SECONDS)


async def get_presence_status_raw(redis: Redis, user_id: int | str) -> str | None:
    """Like :func:`get_presence_status` but returns ``None`` when the key is
    absent instead of defaulting to ``online``.  Lets callers tell "explicitly
    online" apart from "no live status" — used by the ``ready`` frame to decide
    whether to fall back to the durable DB value."""
    key = PRESENCE_STATUS_KEY.format(user_id=user_id)
    raw = await redis.get(key)
    if raw is None:
        return None
    value = raw.decode() if isinstance(raw, bytes) else raw
    return value if value in VALID_SET_STATUSES else None


# ---------------------------------------------------------------------------
# Durable mirror.  Redis holds the *live* status (24 h TTL); the user's
# *manually chosen* status is additionally mirrored into ``user_preferences``
# so it survives the TTL / a Redis restart and is restored at next login.
# Only explicit user choices are written here — the automatic idle/online
# sweeper transitions stay Redis-only so a transient idle never becomes the
# durable status restored later.
# ---------------------------------------------------------------------------

PRESENCE_PREFERENCE_SECTION = "presence"


async def persist_durable_status(
    session: AsyncSession, user_id: int | str, status: str
) -> None:
    """Mirror the user's manually chosen status into ``user_preferences``."""
    from dcc_chat_gateway.models import UserPreference

    uid = int(user_id)
    row = await session.get(UserPreference, (uid, PRESENCE_PREFERENCE_SECTION))
    if row is None:
        session.add(
            UserPreference(
                user_id=uid,
                section_name=PRESENCE_PREFERENCE_SECTION,
                value={"status": status},
                version=1,
            )
        )
    else:
        row.value = {"status": status}
        row.version = row.version + 1
    await session.commit()


async def load_durable_status(
    session: AsyncSession, user_id: int | str
) -> str | None:
    """Read the durable status mirror; ``None`` when unset / invalid."""
    from dcc_chat_gateway.models import UserPreference

    row = await session.get(
        UserPreference, (int(user_id), PRESENCE_PREFERENCE_SECTION)
    )
    if row is None:
        return None
    value = row.value.get("status") if isinstance(row.value, dict) else None
    return value if value in VALID_SET_STATUSES else None


async def get_presence_statuses_bulk(
    redis: Redis, user_ids: list[int | str]
) -> dict[str, str]:
    """Batch-read presence statuses.  Returns a mapping ``str(user_id) → status``.
    Missing keys default to ``STATUS_ONLINE``."""
    if not user_ids:
        return {}
    keys = [PRESENCE_STATUS_KEY.format(user_id=uid) for uid in user_ids]
    raws = await redis.mget(*keys)
    out: dict[str, str] = {}
    for uid, raw in zip(user_ids, raws):
        if raw is None:
            out[str(uid)] = STATUS_ONLINE
        else:
            value = raw.decode() if isinstance(raw, bytes) else raw
            out[str(uid)] = value if value in VALID_SET_STATUSES else STATUS_ONLINE
    return out


async def _get_present_statuses_bulk(
    redis: Redis, user_ids: list[str]
) -> dict[str, str]:
    """Like :func:`get_presence_statuses_bulk` but *omits* absent keys instead
    of defaulting them to ``online``.  Used by the sweeper so a churned user
    whose 24 h status key has expired is treated as "gone" (skipped) rather
    than being re-demoted to ``idle`` — with a fresh broadcast + key write —
    on every pass."""
    if not user_ids:
        return {}
    keys = [PRESENCE_STATUS_KEY.format(user_id=uid) for uid in user_ids]
    raws = await redis.mget(*keys)
    out: dict[str, str] = {}
    for uid, raw in zip(user_ids, raws):
        if raw is None:
            continue
        value = raw.decode() if isinstance(raw, bytes) else raw
        if value in VALID_SET_STATUSES:
            out[str(uid)] = value
    return out


async def update_activity(redis: Redis, user_id: int | str) -> None:
    """Record current time as the user's last-activity timestamp in the ZSET."""
    now_ms = int(time.time() * 1000)
    await redis.zadd(PRESENCE_ACTIVITY_ZSET, {str(user_id): now_ms})


async def broadcast_presence_status_changed(
    manager,  # ConnectionManager — avoid circular import with type annotation
    redis: Redis,
    user_id: int | str,
    status: str,
) -> None:
    """Publish ``presence_status_changed`` to the right audiences.

    * Own sockets → real status via USER_EVENTS_CHANNEL.
    * Everyone else → masked status via GUILD_EVENTS_CHANNEL (invisible→offline).
    """
    import json

    from dcc_chat_gateway.pubsub import GUILD_EVENTS_CHANNEL
    from dcc_shared.events import (
        PresenceStatusChangedEvent,
        PresenceStatusData,
    )

    uid_str = str(user_id)
    masked = _mask(status)

    # 1. Own sockets — real status (no sender_user_id field).
    own_envelope = PresenceStatusChangedEvent(
        data=PresenceStatusData(user_id=uid_str, status=status),
    )
    await manager.publish_user_event(user_id, own_envelope)

    # 2. Everyone else — masked status, through the guild:events fan-out
    #    (existing presence_update path already does self-socket filtering
    #    in _listen, so this only reaches other users; the visibility filter
    #    there (block-aware) already runs on presence_update — we reuse it
    #    for the new op by publishing on the same channel).
    guild_envelope = PresenceStatusChangedEvent(
        data=PresenceStatusData(user_id=uid_str, status=masked),
        sender_user_id=uid_str,
    )
    await redis.publish(
        GUILD_EVENTS_CHANNEL,
        json.dumps(guild_envelope.model_dump(mode="json"), separators=(",", ":")),
    )


# --- Idle sweeper -------------------------------------------------------------


async def idle_sweeper_loop(redis: Redis) -> None:
    """Background task: demote ``online`` users with stale activity to ``idle``.

    Runs every ``IDLE_SWEEP_INTERVAL_S`` seconds.  Errors per individual
    user are swallowed so one bad Redis entry can't stall the whole sweep.
    ``CancelledError`` propagates cleanly for lifespan shutdown.
    """
    log.info("idle_sweeper_loop started sweep_interval_s=%d", IDLE_SWEEP_INTERVAL_S)
    while True:
        try:
            await asyncio.sleep(IDLE_SWEEP_INTERVAL_S)
            await _run_sweep(redis)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("idle_sweeper_loop error (continuing)")


_SWEEP_BATCH_SIZE = 500  # max stale users processed per sweep iteration


async def _run_sweep(redis: Redis) -> None:
    """One sweep iteration — exported for tests.

    Processes at most ``_SWEEP_BATCH_SIZE`` stale users per call to bound
    memory usage and sweep latency.  The next scheduled invocation picks
    up any remaining stale entries.
    """
    import json

    from dcc_chat_gateway.pubsub import GUILD_EVENTS_CHANNEL
    from dcc_shared.events import PresenceStatusChangedEvent, PresenceStatusData

    now_ms = int(time.time() * 1000)
    cutoff = now_ms - IDLE_AFTER_MS
    # Limit the result set so a large dormant user-base doesn't cause a
    # single massive allocation.  Remaining entries are swept in subsequent
    # iterations (one per IDLE_SWEEP_INTERVAL_S).
    stale = await redis.zrangebyscore(
        PRESENCE_ACTIVITY_ZSET, 0, cutoff, start=0, num=_SWEEP_BATCH_SIZE
    )
    if not stale:
        return

    stale_uids = [
        (raw.decode() if isinstance(raw, bytes) else raw) for raw in stale
    ]

    # Drop the swept batch from the activity ZSET. Without this the set grows
    # unbounded (every user who ever connected stays forever) and — worse —
    # once >_SWEEP_BATCH_SIZE dormant users accumulate, the score-ordered
    # ZRANGEBYSCORE keeps returning the *same* oldest batch every minute while
    # entries past the batch are never reached. ``update_activity`` re-adds a
    # user on their next WS frame, so removing stale entries is safe. Remove
    # exactly what we fetched (not a cutoff range) so users that became stale
    # after the read but were not processed this pass aren't silently dropped.
    await redis.zrem(PRESENCE_ACTIVITY_ZSET, *stale_uids)

    # Read only *present* status keys (no online-default): a user whose 24 h
    # status key expired has been gone for ≥24 h and must not be re-demoted to
    # idle every pass — they're simply removed from tracking above.
    statuses = await _get_present_statuses_bulk(redis, stale_uids)

    to_demote = [uid for uid in stale_uids if statuses.get(uid) == STATUS_ONLINE]
    if not to_demote:
        log.info("idle_sweep_done stale=%d demoted=0", len(stale_uids))
        return

    # Write all demotions in a single pipeline.
    masked = _mask(STATUS_IDLE)  # idle stays idle (not invisible)

    # Serialise all envelopes before entering the pipeline so any serialisation
    # error surfaces before we touch Redis.
    payloads: list[tuple[str, str]] = []
    for uid in to_demote:
        guild_envelope = PresenceStatusChangedEvent(
            data=PresenceStatusData(user_id=str(uid), status=masked),
            sender_user_id=str(uid),
        )
        payloads.append(
            (uid, json.dumps(guild_envelope.model_dump(mode="json"), separators=(",", ":")))
        )

    async with redis.pipeline(transaction=False) as pipe:
        for uid in to_demote:
            key = PRESENCE_STATUS_KEY.format(user_id=uid)
            pipe.set(key, STATUS_IDLE, ex=PRESENCE_STATUS_TTL_SECONDS)
        await pipe.execute()

    # Best-effort broadcasts — pipeline all publishes in a single round-trip
    # instead of N sequential awaits.
    try:
        async with redis.pipeline(transaction=False) as pipe:
            for _uid, payload in payloads:
                pipe.publish(GUILD_EVENTS_CHANNEL, payload)
            await pipe.execute()
        demoted = len(payloads)
    except Exception:  # noqa: BLE001
        log.exception("idle_sweeper broadcast pipeline failed")
        demoted = 0
    log.info("idle_sweep_done stale=%d demoted=%d", len(stale_uids), demoted)


__all__ = [
    "STATUS_ONLINE",
    "STATUS_IDLE",
    "STATUS_DND",
    "STATUS_INVISIBLE",
    "STATUS_OFFLINE",
    "VALID_SET_STATUSES",
    "IDLE_AFTER_MS",
    "IDLE_SWEEP_INTERVAL_S",
    "get_presence_status",
    "get_presence_status_raw",
    "set_presence_status",
    "persist_durable_status",
    "load_durable_status",
    "PRESENCE_PREFERENCE_SECTION",
    "get_presence_statuses_bulk",
    "update_activity",
    "broadcast_presence_status_changed",
    "idle_sweeper_loop",
    "_run_sweep",
]
