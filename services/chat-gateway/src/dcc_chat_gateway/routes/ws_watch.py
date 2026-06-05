"""WebSocket op handlers for watch parties.

Extracted from ``routes/ws.py`` to keep the dispatcher under the file-size
policy. Each handler is one async function called from the elif chain; they
all share the same shape (``websocket``, ``user``, ``msg``, plus per-op
extras) and own the full response — including error frames — themselves.

``hosted_parties`` is the per-connection set of channel ids this socket has
claimed by calling ``watch_start``; the dispatcher's finally block uses it
(via :func:`cleanup_on_disconnect`) to end parties when the host's last
socket goes away.

The session_factory parameter on :func:`handle_start` exists so the
dispatcher can pass *its* module-level ``SessionLocal`` symbol — which tests
monkeypatch — and keep the membership lookup honouring that override.
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
from dcc_chat_gateway.security import AuthenticatedUser
from dcc_chat_gateway.watch_source import parse_source

log = logging.getLogger(__name__)

# Wider than typical WHEP/voice rooms — covers a 100h Twitch VOD.
_MAX_POSITION_S = 360_000

# Per-host heartbeat write debounce. Only needs to collapse genuine back-to-
# back bursts (reconnect double-send, UI race — those land within a few ms);
# it must stay comfortably below the host's ~1s heartbeat cadence (web
# `startHeartbeat`) so no regular beat is dropped even under timer throttling.
# 500ms gives a 500ms margin on the 1s interval while still killing bursts.
_HEARTBEAT_DEBOUNCE_MS = 500


def _channel_id(value: object) -> int | None:
    s = str(value or "").strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def _redis(websocket: WebSocket):
    return getattr(websocket.app.state, "redis", None)


def _manager(websocket: WebSocket):
    return getattr(websocket.app.state, "connection_manager", None)


async def _err(websocket: WebSocket, code: int, msg: str) -> None:
    await websocket.send_json({"op": "error", "code": code, "msg": msg})


async def handle_start(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
    *,
    session_factory: Callable,
    hosted_parties: set[str],
    watched_parties: set[str],
) -> None:
    cid_int = _channel_id(msg.get("channel_id"))
    source_url = msg.get("source_url")
    if cid_int is None or not isinstance(source_url, str):
        await _err(websocket, 4012, "invalid watch_start payload")
        return
    source = parse_source(source_url)
    if source is None:
        await _err(websocket, 4013, "unsupported source")
        return
    cid = str(cid_int)
    async with session_factory() as session:
        channel = await channel_membership(session, cid_int, user.id)
        if channel is None or channel.type != CHANNEL_TYPE_VOICE:
            await _err(websocket, 4004, "channel not accessible")
            return
        # Native URLs (direct https:// media links) additionally require
        # MANAGE_CHANNELS — mitigates DNS-rebinding SSRF by limiting who can
        # direct viewers' browsers at arbitrary hostnames.
        if source.get("type") == "native":
            perms = await resolve_permissions(session, user, channel.guild_id, cid_int)
            if not has_permission(perms, Permissions.MANAGE_CHANNELS):
                await _err(websocket, 4003, "missing permission: MANAGE_CHANNELS")
                return
    redis = _redis(websocket)
    if redis is None:
        await _err(websocket, 4017, "watch service unavailable")
        return
    if (await watchkeys.read_state(redis, cid)) is not None:
        await _err(websocket, 4014, "watch party already active")
        return
    ts = watchkeys.now_ms()
    state = {
        "source": source,
        "host_user_id": str(user.id),
        "position": float(source.get("start_seconds") or 0),
        "is_playing": True,
        "updated_at": ts,
        "started_at": ts,
    }
    await watchkeys.write_state(redis, cid, state)
    hosted_parties.add(cid)
    # The host is implicitly a watcher (their tile is mounted) — add them to
    # the registry so a later host departure can promote, and tell viewers.
    mgr = _manager(websocket)
    if mgr is not None:
        await mgr.watch_join(cid, str(user.id), websocket)
        watched_parties.add(cid)
        await mgr.broadcast_watchers(cid)


async def handle_join(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
    *,
    session_factory: Callable,
    watched_parties: set[str],
) -> None:
    cid_int = _channel_id(msg.get("channel_id"))
    if cid_int is None:
        await _err(websocket, 4012, "channel_id required")
        return
    async with session_factory() as session:
        channel = await channel_membership(session, cid_int, user.id)
        if channel is None or channel.type != CHANNEL_TYPE_VOICE:
            await _err(websocket, 4004, "channel not accessible")
            return
    cid = str(cid_int)
    mgr = _manager(websocket)
    if mgr is None:
        return
    await mgr.watch_join(cid, str(user.id), websocket)
    watched_parties.add(cid)
    await mgr.broadcast_watchers(cid)


async def handle_leave(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
    *,
    watched_parties: set[str],
) -> None:
    cid_int = _channel_id(msg.get("channel_id"))
    if cid_int is None:
        return
    cid = str(cid_int)
    watched_parties.discard(cid)
    mgr = _manager(websocket)
    if mgr is None:
        return
    fully_left = await mgr.watch_leave(cid, str(user.id), websocket)
    await mgr.broadcast_watchers(cid)
    if fully_left:
        from dcc_chat_gateway.routes.watch_handoff import end_if_host

        await end_if_host(_redis(websocket), cid, str(user.id))


async def handle_stop(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
    *,
    hosted_parties: set[str],
) -> None:
    cid_int = _channel_id(msg.get("channel_id"))
    if cid_int is None:
        await _err(websocket, 4012, "channel_id required")
        return
    cid = str(cid_int)
    redis = _redis(websocket)
    if redis is None:
        return
    state = await watchkeys.read_state(redis, cid)
    if state is None:
        # Idempotent stop.
        hosted_parties.discard(cid)
        return
    if str(state.get("host_user_id")) != str(user.id):
        await _err(websocket, 4015, "only the host can stop")
        return
    await watchkeys.delete_state(redis, cid)
    hosted_parties.discard(cid)
    mgr = _manager(websocket)
    if mgr is not None:
        mgr.cancel_host_end(cid)


async def handle_control(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
) -> None:
    cid_int = _channel_id(msg.get("channel_id"))
    action = msg.get("action")
    position = msg.get("position")
    if cid_int is None or action not in ("play", "pause", "seek"):
        await _err(websocket, 4012, "invalid watch_control payload")
        return
    if not isinstance(position, (int, float)) or position < 0 or position > _MAX_POSITION_S:
        await _err(websocket, 4012, "invalid position")
        return
    cid = str(cid_int)
    redis = _redis(websocket)
    if redis is None:
        return
    state = await watchkeys.read_state(redis, cid)
    if state is None:
        await _err(websocket, 4016, "no active watch party")
        return
    if str(state.get("host_user_id")) != str(user.id):
        await _err(websocket, 4015, "only the host can control")
        return
    state["position"] = float(position)
    state["is_playing"] = action != "pause"
    state["updated_at"] = watchkeys.now_ms()
    await watchkeys.write_state(redis, cid, state)


async def handle_heartbeat(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
) -> None:
    # Heartbeats are best-effort. Drop silently on malformed input rather than
    # spamming error frames — the host emits one every ~3s during playback.
    cid_int = _channel_id(msg.get("channel_id"))
    position = msg.get("position")
    # Same position bounds as handle_control — an out-of-range heartbeat must
    # not be able to set a position the control op would reject.
    if (
        cid_int is None
        or not isinstance(position, (int, float))
        or position < 0
        or position > _MAX_POSITION_S
    ):
        return
    cid = str(cid_int)
    redis = _redis(websocket)
    if redis is None:
        return
    state = await watchkeys.read_state(redis, cid)
    if state is None or str(state.get("host_user_id")) != str(user.id):
        return
    ts = watchkeys.now_ms()
    if ts - int(state.get("updated_at") or 0) < _HEARTBEAT_DEBOUNCE_MS:
        return
    state["position"] = float(position)
    state["updated_at"] = ts
    await watchkeys.write_state(redis, cid, state)


async def cleanup_on_disconnect(
    websocket: WebSocket,
    user: AuthenticatedUser,
    manager,
    watched_parties: set[str],
) -> None:
    """Socket closing: leave every party this socket watched, promoting a new
    host (or ending the party) wherever this socket's user was the host and is
    now fully gone. Runs BEFORE ``manager.remove_socket`` so the registry's
    socket set is still accurate."""
    if not watched_parties:
        return
    from dcc_chat_gateway.routes.watch_handoff import end_or_grace_if_host

    redis = _redis(websocket)
    for cid in list(watched_parties):
        try:
            fully_left = await manager.watch_leave(cid, str(user.id), websocket)
            await manager.broadcast_watchers(cid)
            if fully_left:
                await end_or_grace_if_host(redis, manager, cid, str(user.id))
        except Exception:
            log.exception("watch-party disconnect cleanup failed for channel %s", cid)
