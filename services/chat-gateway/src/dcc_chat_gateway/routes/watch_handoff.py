"""Watch-party host promotion + explicit handoff.

Split out of ws_watch.py to keep both files under the size policy. The
promotion path runs under ``manager._lock`` and re-reads ``host_user_id``
after acquiring it, so two near-simultaneous departures can't double-promote.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import WebSocket

from dcc_chat_gateway import watchkeys

log = logging.getLogger(__name__)


def _redis(websocket: WebSocket):
    return getattr(websocket.app.state, "redis", None)


def _manager(websocket: WebSocket):
    return getattr(websocket.app.state, "connection_manager", None)


async def _err(websocket: WebSocket, code: int, msg: str) -> None:
    await websocket.send_json({"op": "error", "code": code, "msg": msg})


def _channel_id(value: object) -> str | None:
    s = str(value or "").strip()
    if not s or not s.isdigit():
        return None
    return s


async def promote_or_end(redis, manager, channel_id: str, departing_uid: str) -> None:
    """The departing user just left the watcher set. If they were the host,
    promote the oldest remaining watcher; if none remain, end the party."""
    if redis is None:
        return
    async with manager._lock:
        state = await watchkeys.read_state(redis, channel_id)
        if state is None:
            return
        if str(state.get("host_user_id")) != str(departing_uid):
            return  # departing user was a viewer — nothing to promote
    # next_host takes its own lock; compute outside the block above.
    next_uid = await manager.next_host(channel_id, exclude_uid=str(departing_uid))
    if next_uid is None:
        await watchkeys.delete_state(redis, channel_id)
        return
    new_state = watchkeys.promoted_state(state, next_uid)
    await watchkeys.write_state(redis, channel_id, new_state)
    log.info(
        "watch-party promoted channel=%s from=%s to=%s",
        channel_id,
        departing_uid,
        next_uid,
    )


async def handle_handoff(websocket: WebSocket, user, msg: dict[str, Any]) -> None:
    """Explicit host-initiated handoff. With ``target_user_id`` → transfer to
    that specific watcher (must be watching). Without → promote the next
    oldest watcher; the handing-off host stays a viewer in the registry."""
    cid = _channel_id(msg.get("channel_id"))
    if cid is None:
        await _err(websocket, 4012, "channel_id required")
        return
    redis = _redis(websocket)
    mgr = _manager(websocket)
    if redis is None or mgr is None:
        return
    state = await watchkeys.read_state(redis, cid)
    if state is None:
        await _err(websocket, 4016, "no active watch party")
        return
    if str(state.get("host_user_id")) != str(user.id):
        await _err(websocket, 4015, "only the host can hand off")
        return
    target = msg.get("target_user_id")
    if target:
        target = str(target)
        if target not in await mgr.watchers(cid):
            await _err(websocket, 4018, "target not watching")
            return
        new_state = watchkeys.promoted_state(state, target)
        await watchkeys.write_state(redis, cid, new_state)
        return
    # No target → promote next oldest (host stays a viewer in the registry).
    await promote_or_end(redis, mgr, cid, str(user.id))
