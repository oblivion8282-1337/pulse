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
import json

import structlog
from livekit.protocol.models import TrackSource
from redis.asyncio import Redis

from dcc_shared import gaeste as _gaeste

from dcc_voice_signaling.webhook import (
    _is_camera,
    _is_microphone,
    _is_unknown_video,
    _is_screen_share,
    _publish_state,
    camera_key,
    channel_id_from_room,
    gast_stumm_key,
    room_key,
    streaming_key,
    user_id_from_identity,
)

log = structlog.get_logger(__name__)

_KEY_PREFIX = "voice:room:"
_SCAN_PATTERN = f"{_KEY_PREFIX}channel-*"

# Atomically rewrite the presence, streaming, camera AND guest-mute sets for
# one room in a single round-trip, so a concurrent ``_publish_state`` can never
# observe a partially-rewritten snapshot (e.g. the new presence set with the old
# streaming set, yielding streaming_user_ids that contain a user absent from
# user_ids). Each set is replaced wholesale: DEL, then SADD the desired members
# (decoded from a JSON array argument), then a plain non-NX EXPIRE. An empty
# target leaves the key deleted — mirroring the webhook's leave-empty +
# room_finished behaviour, where an absent key reads as "nobody".
#
# KEYS[1] = presence set, KEYS[2] = streaming set, KEYS[3] = camera set,
# KEYS[4] = guest-mute set.
# ARGV[1..4] = JSON arrays of member strings for KEYS[1..4].
# ARGV[5] = TTL seconds (applied to whichever keys end up non-empty).
_LUA_SET_EXACT_TRIPLE = """
local ttl = tonumber(ARGV[5])
for i = 1, 4 do
    redis.call('DEL', KEYS[i])
    local members = cjson.decode(ARGV[i])
    if #members > 0 then
        redis.call('SADD', KEYS[i], unpack(members))
        redis.call('EXPIRE', KEYS[i], ttl)
    end
end
return 0
"""


async def _set_exact_triple(
    redis: Redis,
    presence_key: str,
    streaming_key_: str,
    camera_key_: str,
    members: set[str],
    streaming: set[str],
    camera: set[str],
    ttl_seconds: int,
    gast_stumm_key_: str | None = None,
    gast_stumm: set[str] | None = None,
) -> None:
    """Rewrite all per-room sets atomically (single Lua round-trip).

    Plain (non-NX) EXPIRE: reconcile is now the authority, so refreshing the
    TTL every pass is correct — a set only expires if reconcile itself stops
    running (backstop), not while a channel stays occupied. Doing the rewrites
    in one Lua script (vs. separate transactions) closes the window in which a
    reader could see a mismatched mix of old/new sets. The guest-mute set is
    optional: older callers (tests) may pass only the three original sets.
    """
    keys = [presence_key, streaming_key_, camera_key_]
    argv = [
        json.dumps(sorted(members), separators=(",", ":")),
        json.dumps(sorted(streaming), separators=(",", ":")),
        json.dumps(sorted(camera), separators=(",", ":")),
    ]
    if gast_stumm_key_ is not None:
        keys.append(gast_stumm_key_)
        argv.append(json.dumps(sorted(gast_stumm or set()), separators=(",", ":")))
    argv.append(str(ttl_seconds))
    await redis.eval(  # type: ignore[arg-type]
        _LUA_SET_EXACT_TRIPLE,
        len(keys),
        *keys,
        *argv,
    )


async def _reconcile_room(
    redis: Redis, lk_api, room_name: str, cid: str, ttl_seconds: int
) -> None:
    """Rewrite one room's three sets from its live LiveKit participant list,
    then publish the fresh snapshot. Pulled out of ``reconcile_once`` so the
    per-room work (a gRPC ``list_participants`` round-trip each) can run
    concurrently across rooms rather than serially."""
    from livekit import api as lk

    parts = await lk_api.room.list_participants(
        lk.ListParticipantsRequest(room=room_name)
    )
    members: set[str] = set()
    streaming: set[str] = set()
    camera: set[str] = set()
    # Stumme Gäste. LiveKit sendet KEINE track_muted-Webhooks — der Mute-Zustand
    # eines Gastes existiert für den Server nur in dieser Abfrage. Mitglieder
    # melden ihren Zustand selbst und tauchen hier bewusst nicht auf.
    gast_stumm: set[str] = set()
    # Gesperrte Gäste, die mit ihrem noch gültigen LiveKit-JWT neu gejoint
    # sind: LiveKit hat keine Sperrliste, also wirft sie der Sweep hier raus
    # (Audit 2026-09 — vorher galt der Rauswurf nur für NEUE Tokens).
    rauszuwerfen: list[str] = []
    for p in parts.participants:
        uid = user_id_from_identity(p.identity)
        if uid is None:
            continue
        is_gast = _gaeste.ist_gast(uid)
        if is_gast and await _gaeste.ist_gesperrt(redis, uid):
            rauszuwerfen.append(p.identity)
            continue
        members.add(uid)
        mikro_da = False
        for track in p.tracks:
            # Für Gäste entfällt der UNKNOWN→Screen-Share-Fallback: sie
            # dürfen gar nicht teilen; ein UNKNOWN-Video von ihnen ist eine
            # Kamera (Drittclient). Deshalb die Gast-Prüfung VOR dem
            # Screen-Share-Fallback.
            if is_gast and _is_unknown_video(track):
                camera.add(uid)
            elif _is_screen_share(track):
                streaming.add(uid)
            elif _is_camera(track):
                camera.add(uid)
            elif is_gast and _is_microphone(track):
                mikro_da = True
                if track.muted:
                    gast_stumm.add(uid)
        if is_gast and not mikro_da:
            # Kein publiziertes Mikrofon (Drittclient, Publish-Fehler): ohne
            # diese Regel würde der stumme Gast als „laut" geführt.
            gast_stumm.add(uid)

    for identity in rauszuwerfen:
        try:
            await lk_api.room.remove_participant(
                lk.RoomParticipantIdentity(room=room_name, identity=identity)
            )
        except Exception:  # noqa: BLE001 — der Sitzungs-TTL-Rückfall greift
            log.warning(
                "reconcile_gast_removal_failed", identity=identity, room=room_name
            )
    await _set_exact_triple(
        redis,
        room_key(room_name),
        streaming_key(room_name),
        camera_key(room_name),
        members,
        streaming,
        camera,
        ttl_seconds,
        gast_stumm_key_=gast_stumm_key(room_name),
        gast_stumm=gast_stumm,
    )
    await _publish_state(redis, room_name, cid)


async def _clear_ghost_room(redis: Redis, room_name: str, cid: str) -> None:
    """Delete one ghost room's sets and publish the empty snapshot so clients
    clear it. Each room is independent → safe to run concurrently."""
    await redis.delete(
        room_key(room_name),
        streaming_key(room_name),
        camera_key(room_name),
        gast_stumm_key(room_name),
    )
    await _publish_state(redis, room_name, cid)  # publishes empty → clients clear


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

    # Reconcile every active room concurrently — each is an independent gRPC +
    # Redis round-trip, so wall-clock is the slowest single room, not the sum.
    if active:
        await asyncio.gather(
            *(
                _reconcile_room(redis, lk_api, room_name, cid, ttl_seconds)
                for room_name, cid in active.items()
            )
        )

    # Clear ghost channels: a ``voice:room:channel-<id>`` set still in Redis
    # for a room LiveKit no longer has (missed ``room_finished``/``_left``).
    # Collect first (the SCAN cursor can't overlap the deletes), then fan out.
    ghosts: list[tuple[str, str]] = []
    async for raw in redis.scan_iter(match=_SCAN_PATTERN):
        key = raw.decode() if isinstance(raw, (bytes, bytearray)) else raw
        suffix = key[len(_KEY_PREFIX) :]  # channel-<id>[:streaming|:camera|:gast-stumm]
        if (
            suffix.endswith(":streaming")
            or suffix.endswith(":camera")
            or suffix.endswith(":gast-stumm")
        ):
            continue  # base presence key drives the cleanup; siblings go with it
        room_name = suffix
        if room_name in active:
            continue
        cid = channel_id_from_room(room_name)
        if cid is None:
            continue
        ghosts.append((room_name, cid))

    if ghosts:
        ghosts = await _drop_live_rooms(lk_api, ghosts)

    if ghosts:
        await asyncio.gather(
            *(_clear_ghost_room(redis, room_name, cid) for room_name, cid in ghosts)
        )

    return {"rooms": len(active), "stale_cleared": len(ghosts)}


async def _drop_live_rooms(
    lk_api, ghosts: list[tuple[str, str]]
) -> list[tuple[str, str]]:
    """Re-confirm against LiveKit that each ghost room is *really* gone.

    Closes a TOCTOU race: a new room can be created (and its presence key
    written by a ``participant_joined`` webhook) in the window between the
    ``list_rooms`` snapshot and the ghost SCAN. Such a room is absent from
    ``active`` and would be wrongly cleared. A second, name-scoped ``list_rooms``
    here — issued *after* the webhook has had time to register the room with
    LiveKit — drops any ghost LiveKit now reports as live, so we never wipe a
    freshly-joined participant. On error we fall back to the unfiltered list
    (the periodic pass self-corrects), never raising out of reconcile."""
    from livekit import api as lk

    names = [room_name for room_name, _ in ghosts]
    try:
        resp = await lk_api.room.list_rooms(lk.ListRoomsRequest(names=names))
        live = {r.name for r in resp.rooms}
    except Exception:  # noqa: BLE001 — keep reconcile resilient to LiveKit blips
        log.warning("voice_reconcile_ghost_recheck_failed", exc_info=True)
        return ghosts
    return [(room_name, cid) for room_name, cid in ghosts if room_name not in live]


async def reconcile_loop(
    redis: Redis, lk_api, *, interval_seconds: int, ttl_seconds: int
) -> None:
    """Reconcile on startup, then every ``interval_seconds``. Never raises out
    of the loop — a transient LiveKit/Redis error is logged and retried."""
    log.info("voice_reconcile_loop_start", interval=interval_seconds)
    while True:
        failed = False
        try:
            summary = await reconcile_once(redis, lk_api, ttl_seconds=ttl_seconds)
            log.debug("voice_reconcile_ok", **summary)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — keep the loop alive across blips
            log.warning("voice_reconcile_failed", exc_info=True)
            failed = True
        await asyncio.sleep(5 if failed else interval_seconds)
