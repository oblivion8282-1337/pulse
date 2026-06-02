"""Periodic LiveKit → Redis voice-presence reconciliation.

The webhook handler (``webhook.py``) is *event-driven*: it mutates the
``voice:room:*`` sets on each ``participant_joined`` / ``_left`` /
``track_*`` event. That path has two blind spots that leave the presence
state silently diverged from reality:

1. **Webhook gaps.** If voice-signaling is down when an event fires (e.g.
   during a deploy/restart), LiveKit does *not* re-deliver it — and it does
   not re-fire ``participant_joined`` for participants who are *already*
   connected when the receiver comes back. Their presence is lost until they
   rejoin.
2. **The NX-TTL trap.** ``_apply_join`` sets the 6 h self-heal TTL with
   ``NX`` (only on first creation, never refreshed). In a channel that stays
   occupied for >6 h straight, the set *expires while everyone is still in
   it*, and — per (1) — never gets repopulated until the room fully empties.

This module closes both gaps by polling LiveKit (the source of truth) on a
fixed interval and rewriting the three per-room sets to match the actual
participant list, then publishing the fresh snapshot on ``voice:events`` so
chat-gateway fans it out. Running the loop body once at startup also covers
the deploy case immediately.

It reuses the webhook module's key helpers + track classifiers so the two
paths can never disagree on naming or screen-share/camera detection.
"""

from __future__ import annotations

import asyncio

import structlog
from redis.asyncio import Redis

from dcc_voice_signaling.webhook import (
    _is_camera,
    _is_screen_share,
    _publish_state,
    camera_key,
    channel_id_from_room,
    room_key,
    streaming_key,
    user_id_from_identity,
)

log = structlog.get_logger(__name__)

_KEY_PREFIX = "voice:room:"
_SCAN_PATTERN = f"{_KEY_PREFIX}channel-*"


async def _set_exact(redis: Redis, key: str, members: set[str], ttl_seconds: int) -> None:
    """Make ``key`` hold exactly ``members`` (atomically), with a fresh TTL.

    Empty target → delete the key, mirroring the webhook's leave-empty +
    room_finished behaviour (an absent key reads as "nobody"). The DEL+SADD
    runs in a MULTI transaction so a concurrent ``_publish_state`` never sees
    a half-written set.
    """
    if not members:
        await redis.delete(key)
        return
    pipe = redis.pipeline(transaction=True)
    pipe.delete(key)
    pipe.sadd(key, *members)
    # Plain (non-NX) expire: reconcile is now the authority, so refreshing the
    # TTL every pass is correct — the set only expires if reconcile itself
    # stops running (backstop), not while a channel stays occupied.
    pipe.expire(key, ttl_seconds)
    await pipe.execute()


async def reconcile_once(redis: Redis, lk_api, *, ttl_seconds: int) -> dict[str, int]:
    """Run one full reconciliation pass. Returns a small summary for logging."""
    from livekit import api as lk

    rooms_resp = await lk_api.room.list_rooms(lk.ListRoomsRequest())
    # room_name -> channel_id, only for our ``channel-<id>`` rooms.
    active: dict[str, str] = {}
    for r in rooms_resp.rooms:
        cid = channel_id_from_room(r.name)
        if cid is not None:
            active[r.name] = cid

    for room_name, cid in active.items():
        parts = await lk_api.room.list_participants(
            lk.ListParticipantsRequest(room=room_name)
        )
        members: set[str] = set()
        streaming: set[str] = set()
        camera: set[str] = set()
        for p in parts.participants:
            uid = user_id_from_identity(p.identity)
            if uid is None:
                continue
            members.add(uid)
            for track in p.tracks:
                # Screen-share check first — it owns the UNKNOWN-source video
                # fallback (same precedence as the webhook handler).
                if _is_screen_share(track):
                    streaming.add(uid)
                elif _is_camera(track):
                    camera.add(uid)
        await _set_exact(redis, room_key(room_name), members, ttl_seconds)
        await _set_exact(redis, streaming_key(room_name), streaming, ttl_seconds)
        await _set_exact(redis, camera_key(room_name), camera, ttl_seconds)
        await _publish_state(redis, room_name, cid)

    # Clear ghost channels: a ``voice:room:channel-<id>`` set still in Redis
    # for a room LiveKit no longer has (missed ``room_finished``/``_left``).
    stale = 0
    async for raw in redis.scan_iter(match=_SCAN_PATTERN):
        key = raw.decode() if isinstance(raw, (bytes, bytearray)) else raw
        suffix = key[len(_KEY_PREFIX) :]  # channel-<id>[:streaming|:camera]
        if suffix.endswith(":streaming") or suffix.endswith(":camera"):
            continue  # base presence key drives the cleanup; siblings go with it
        room_name = suffix
        if room_name in active:
            continue
        cid = channel_id_from_room(room_name)
        if cid is None:
            continue
        await redis.delete(
            room_key(room_name), streaming_key(room_name), camera_key(room_name)
        )
        await _publish_state(redis, room_name, cid)  # publishes empty → clients clear
        stale += 1

    return {"rooms": len(active), "stale_cleared": stale}


async def reconcile_loop(
    redis: Redis, lk_api, *, interval_seconds: int, ttl_seconds: int
) -> None:
    """Reconcile on startup, then every ``interval_seconds``. Never raises out
    of the loop — a transient LiveKit/Redis error is logged and retried."""
    log.info("voice_reconcile_loop_start", interval=interval_seconds)
    while True:
        try:
            summary = await reconcile_once(redis, lk_api, ttl_seconds=ttl_seconds)
            log.debug("voice_reconcile_ok", **summary)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — keep the loop alive across blips
            log.warning("voice_reconcile_failed", exc_info=True)
        await asyncio.sleep(interval_seconds)
