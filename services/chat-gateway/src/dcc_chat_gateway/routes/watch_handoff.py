"""Watch-party host promotion + explicit handoff.

Split out of ws_watch.py to keep both files under the size policy. The
promotion path runs under ``manager._lock`` and re-reads ``host_user_id``
after acquiring it, so two near-simultaneous departures can't double-promote.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from fastapi import WebSocket

from dcc_chat_gateway import watchkeys
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE
from dcc_chat_gateway.permissions import Permissions, has_permission, resolve_permissions
from dcc_chat_gateway.routes._deps import channel_membership

log = logging.getLogger(__name__)


def _redis(websocket: WebSocket):
    return getattr(websocket.app.state, "redis", None)


def _manager(websocket: WebSocket):
    return getattr(websocket.app.state, "connection_manager", None)


async def _err(websocket: WebSocket, code: int, msg: str) -> None:
    await websocket.send_json({"op": "error", "code": code, "msg": msg})


def _id(value: object) -> str | None:
    s = str(value or "").strip()
    if not s or not s.isdigit():
        return None
    return s


async def end_if_host(redis, channel_id: str, party_id: str, departing_uid: str) -> None:
    """Host left deliberately (tile unmount / channel switch) → end the party
    now. No-op if the departing user is a viewer."""
    if redis is None:
        return
    state = await watchkeys.read_party(redis, channel_id, party_id)
    if state is None or str(state.get("host_user_id")) != str(departing_uid):
        return
    await watchkeys.delete_party(redis, channel_id, party_id)


async def end_or_grace_if_host(
    redis, manager, channel_id: str, party_id: str, departing_uid: str
) -> None:
    """Host's WS dropped → start the grace timer (party ends after
    WATCH_HOST_GRACE_S unless the host reconnects). No-op for a viewer."""
    if redis is None:
        return
    state = await watchkeys.read_party(redis, channel_id, party_id)
    if state is None or str(state.get("host_user_id")) != str(departing_uid):
        return
    manager.schedule_host_end(redis, channel_id, party_id, str(departing_uid))


async def promote_or_end(
    redis, manager, channel_id: str, party_id: str, departing_uid: str
) -> None:
    """The departing user just left the watcher set. If they were the host,
    promote the oldest remaining watcher; if none remain, end the party."""
    if redis is None:
        return
    # Do NOT hold manager._lock across this Redis round-trip — that lock also
    # serialises subscribe / unsubscribe / remove_socket / watch_join /
    # watch_leave, so holding it across the network hop causes head-of-line
    # blocking if Redis is slow. The read needs no in-memory lock: it guards
    # nothing in the manager's dicts here, and the authoritative consistency
    # check is the re-read guard below (lines after next_host) plus the atomic
    # Redis writes.
    state = await watchkeys.read_party(redis, channel_id, party_id)
    if state is None:
        return
    if str(state.get("host_user_id")) != str(departing_uid):
        return  # departing user was a viewer — nothing to promote
    # next_host takes its own lock; keep it outside any held lock too.
    next_uid = await manager.next_host(channel_id, party_id, exclude_uid=str(departing_uid))
    if next_uid is None:
        await watchkeys.delete_party(redis, channel_id, party_id)
        return
    # Re-read after next_host released the lock: guard against a concurrent
    # promotion / stop having changed (or cleared) the host in the meantime, so
    # two interleaved departures can't double-write or resurrect a stopped
    # party. Also picks up the freshest position for the extrapolation.
    fresh = await watchkeys.read_party(redis, channel_id, party_id)
    if fresh is None or str(fresh.get("host_user_id")) != str(departing_uid):
        return
    # Re-validate that the chosen successor is still a watcher: next_host ran
    # before this re-read, so next_uid may have disconnected in the meantime.
    # Promoting a gone user would strand a "ghost host" in Redis (no socket, no
    # grace timer) until the 6h TTL. Re-pick the next available watcher; if the
    # candidate keeps vanishing or none remain, end the party (never write a
    # host without an active watcher).
    watchers_now = set(await manager.watchers(channel_id, party_id))
    while next_uid not in watchers_now:
        next_uid = await manager.next_host(
            channel_id, party_id, exclude_uid=str(departing_uid)
        )
        if next_uid is None:
            await watchkeys.delete_party(redis, channel_id, party_id)
            return
        watchers_now = set(await manager.watchers(channel_id, party_id))
    new_state = watchkeys.promoted_state(fresh, next_uid)
    await watchkeys.write_party(redis, channel_id, new_state)
    log.info(
        "watch-party promoted channel=%s party=%s from=%s to=%s",
        channel_id,
        party_id,
        departing_uid,
        next_uid,
    )


async def handle_handoff(
    websocket: WebSocket,
    user,
    msg: dict[str, Any],
    *,
    session_factory: Callable,
) -> None:
    """Explicit host-initiated handoff. With ``target_user_id`` → transfer to
    that specific watcher (must be watching). Without → promote the next
    oldest watcher; the handing-off host stays a viewer in the registry."""
    cid = _id(msg.get("channel_id"))
    pid = _id(msg.get("party_id"))
    if cid is None or pid is None:
        await _err(websocket, 4012, "channel_id and party_id required")
        return
    # Membership + VIEW_CHANNEL check — mirrors handle_start / handle_join so
    # party existence is not leaked via distinct error codes to non-members.
    cid_int = int(cid)
    async with session_factory() as session:
        channel = await channel_membership(session, cid_int, user.id)
        if channel is None or channel.type != CHANNEL_TYPE_VOICE:
            await _err(websocket, 4004, "channel not accessible")
            return
        perms = await resolve_permissions(session, user, channel.guild_id, cid_int)
        if not has_permission(perms, Permissions.VIEW_CHANNEL):
            await _err(websocket, 4004, "channel not accessible")
            return
    redis = _redis(websocket)
    mgr = _manager(websocket)
    if redis is None or mgr is None:
        return
    state = await watchkeys.read_party(redis, cid, pid)
    if state is None:
        await _err(websocket, 4016, "no active watch party")
        return
    if str(state.get("host_user_id")) != str(user.id):
        await _err(websocket, 4015, "only the host can hand off")
        return
    target = msg.get("target_user_id")
    if target:
        target = str(target)
        if target not in await mgr.watchers(cid, pid):
            await _err(websocket, 4018, "target not watching")
            return
        # Re-read after the two awaits above — a concurrent update (e.g. the
        # host's other socket leaving) may have changed or cleared the host.
        # Mirrors the re-read guard in promote_or_end (lines 85-87).
        fresh = await watchkeys.read_party(redis, cid, pid)
        if fresh is None or str(fresh.get("host_user_id")) != str(user.id):
            await _err(websocket, 4015, "only the host can hand off")
            return
        # Re-validate target presence after the re-read: the target may have
        # disconnected between the first watchers() check and now. Writing them
        # as host here would strand a party in Redis with no open socket and no
        # grace timer (a "ghost host" that lingers until the 6h TTL).
        if target not in await mgr.watchers(cid, pid):
            await _err(websocket, 4018, "target not watching")
            return
        new_state = watchkeys.promoted_state(fresh, target)
        await watchkeys.write_party(redis, cid, new_state)
        mgr.cancel_host_end(cid, pid)  # defensive: host changed → drop pending grace
        return
    # No target → promote next oldest (host stays a viewer in the registry).
    await promote_or_end(redis, mgr, cid, pid, str(user.id))
    mgr.cancel_host_end(cid, pid)  # defensive: host changed → drop any pending grace
