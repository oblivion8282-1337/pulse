"""WebSocket op handlers for Pulse-Fernsteuerung (remote control).

The gateway is a **signaling relay + consent gate** only — it never carries the
video/input stream (that is P2P webrtc-rs ↔ browser). These handlers own the
consent handshake and forward SDP/ICE between the two peer sockets; the session
bookkeeping lives in :mod:`remote_registry` (an in-process, single-pod registry,
same rationale as ``watch_registry``).

Op flow::

    controller --remote_request--> gateway --remote_request--> host (all tabs)
    host       --remote_respond--> gateway --remote_response--> both peers
    peer       --remote_signal---> gateway --remote_signal---> the *other* peer
    peer       --remote_end------> gateway --remote_ended----> the *other* peer

Error frames are fire-and-forget (``_err``) — the socket is never closed:
  * 4050 required field missing / invalid
  * 4051 no access (not a member / no VIEW_CHANNEL / no REMOTE_CONTROL)
  * 4052 host not reachable (offline or not a member of the channel)
  * 4053 no matching session / not authorised for this session
  * 4054 host already has an active session
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from fastapi import WebSocket

from dcc_chat_gateway.permissions import Permissions, has_permission, resolve_permissions
from dcc_chat_gateway.remote_registry import send_to_socket
from dcc_chat_gateway.routes._deps import channel_membership
from dcc_chat_gateway.security import AuthenticatedUser

log = logging.getLogger(__name__)


def _int_or_none(value: object) -> int | None:
    """Parse a stringified snowflake (channel_id / host_user_id) to int, or
    ``None`` when it is missing or malformed."""
    s = str(value or "").strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def _session_id(value: object) -> str:
    return str(value or "").strip()


def _manager(websocket: WebSocket):
    return getattr(websocket.app.state, "connection_manager", None)


async def _err(websocket: WebSocket, code: int, msg: str) -> None:
    await websocket.send_json({"op": "error", "code": code, "msg": msg})


async def handle_request(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
    *,
    session_factory: Callable,
) -> None:
    cid_int = _int_or_none(msg.get("channel_id"))
    host_uid = _int_or_none(msg.get("host_user_id"))
    if cid_int is None or host_uid is None or host_uid == user.id:
        await _err(websocket, 4050, "channel_id and a different host_user_id required")
        return
    mgr = _manager(websocket)
    if mgr is None:
        return
    cid = str(cid_int)
    async with session_factory() as session:
        channel = await channel_membership(session, cid_int, user.id)
        if channel is None:
            # Same 4051 whether the channel is hidden or the caller isn't a
            # member — never confirm a hidden channel's existence.
            await _err(websocket, 4051, "no access")
            return
        perms = await resolve_permissions(session, user, channel.guild_id, cid_int)
        if not has_permission(perms, Permissions.VIEW_CHANNEL) or not has_permission(
            perms, Permissions.REMOTE_CONTROL
        ):
            await _err(websocket, 4051, "no access")
            return
        # The host must be a member of the same channel (its guild). No stream
        # check — remote control is independent of HQ streaming.
        if await channel_membership(session, cid_int, host_uid) is None:
            await _err(websocket, 4052, "host not reachable")
            return
    host_sockets = mgr.remote_user_sockets(host_uid)
    if not host_sockets:
        await _err(websocket, 4052, "host not reachable")
        return
    sess = await mgr.remote_create(cid, host_uid, host_sockets[0], user.id, websocket)
    if sess is None:
        await _err(websocket, 4054, "host already has an active remote session")
        return
    frame = {
        "op": "remote_request",
        "session_id": sess.session_id,
        "channel_id": cid,
        "from_user_id": str(user.id),
    }
    for hs in host_sockets:
        await send_to_socket(hs, frame)
    mgr.remote_schedule_timeout(sess.session_id, websocket)


async def handle_respond(
    websocket: WebSocket, user: AuthenticatedUser, msg: dict[str, Any]
) -> None:
    session_id = _session_id(msg.get("session_id"))
    accept = msg.get("accept")
    if not session_id or not isinstance(accept, bool):
        await _err(websocket, 4050, "session_id and boolean accept required")
        return
    mgr = _manager(websocket)
    if mgr is None:
        return
    sess = mgr.remote_get(session_id)
    # Only the invited host may answer their own session.
    if sess is None or sess.host_user_id != str(user.id):
        await _err(websocket, 4053, "no such session")
        return
    mgr.remote_cancel_timeout(session_id)
    # The invite fanned out to every host tab; the moment one tab answers, tell
    # the *others* to dismiss their consent dialog (stale otherwise).
    await _dismiss_other_host_tabs(mgr, sess, answered=websocket)
    if not accept:
        await mgr.remote_end(session_id)
        await send_to_socket(
            sess.controller_socket,
            {"op": "remote_response", "session_id": session_id, "accepted": False},
        )
        return
    # Activate FIRST (atomic, only the first pending→active transition wins),
    # THEN claim this socket as the authoritative host peer. Order matters: a
    # second host tab accepting the same invite — or the session vanishing in
    # the await window (controller disconnected) — must NOT reassign
    # `host_socket` away from the tab that already owns the live session.
    if not await mgr.remote_activate(session_id):
        await _err(websocket, 4053, "no such session")
        return
    # The request fanned out to every tab; this one owns the session now.
    sess.host_socket = websocket
    frame = {"op": "remote_response", "session_id": session_id, "accepted": True}
    await send_to_socket(sess.controller_socket, frame)
    await send_to_socket(websocket, frame)


async def _dismiss_other_host_tabs(mgr, sess, *, answered) -> None:
    """Tell every host tab except the one that answered to drop the pending
    consent prompt for this session."""
    frame = {"op": "remote_canceled", "session_id": sess.session_id}
    for hs in mgr.remote_user_sockets(sess.host_user_id):
        if hs is not answered:
            await send_to_socket(hs, frame)


async def handle_signal(
    websocket: WebSocket, user: AuthenticatedUser, msg: dict[str, Any]
) -> None:
    session_id = _session_id(msg.get("session_id"))
    kind = msg.get("kind")
    data = msg.get("data")
    if not session_id or kind not in ("offer", "answer", "ice") or data is None:
        await _err(websocket, 4050, "session_id, kind and data required")
        return
    mgr = _manager(websocket)
    if mgr is None:
        return
    sess = mgr.remote_get(session_id)
    if sess is None or sess.state != "active":
        await _err(websocket, 4053, "no active session")
        return
    if websocket is sess.host_socket:
        peer = sess.controller_socket
    elif websocket is sess.controller_socket:
        peer = sess.host_socket
    else:
        await _err(websocket, 4053, "not a session peer")
        return
    await send_to_socket(
        peer,
        {"op": "remote_signal", "session_id": session_id, "kind": kind, "data": data},
    )


async def handle_end(
    websocket: WebSocket, user: AuthenticatedUser, msg: dict[str, Any]
) -> None:
    session_id = _session_id(msg.get("session_id"))
    if not session_id:
        await _err(websocket, 4050, "session_id required")
        return
    mgr = _manager(websocket)
    if mgr is None:
        return
    sess = mgr.remote_get(session_id)
    if sess is None:
        return  # idempotent
    if websocket is not sess.host_socket and websocket is not sess.controller_socket:
        await _err(websocket, 4053, "not a session peer")
        return
    mgr.remote_cancel_timeout(session_id)
    removed = await mgr.remote_end(session_id)
    if removed is None:
        return
    other = (
        removed.controller_socket
        if websocket is removed.host_socket
        else removed.host_socket
    )
    await send_to_socket(
        other,
        {"op": "remote_ended", "session_id": session_id, "reason": "peer_ended"},
    )


async def cleanup_remote_on_disconnect(websocket: WebSocket, manager) -> None:
    """Socket closing: end every remote session this socket was a peer of and
    tell the other peer immediately — no grace window (unlike watch parties)."""
    for sess in manager.remote_sessions_for_socket(websocket):
        try:
            manager.remote_cancel_timeout(sess.session_id)
            removed = await manager.remote_end(sess.session_id)
            if removed is None:
                continue
            other = (
                removed.controller_socket
                if websocket is removed.host_socket
                else removed.host_socket
            )
            await send_to_socket(
                other,
                {
                    "op": "remote_ended",
                    "session_id": removed.session_id,
                    "reason": "peer_disconnected",
                },
            )
            # A pending session's invite is still up on EVERY host tab (only the
            # representative socket is `host_socket`); tell the rest to dismiss,
            # else their consent dialog hangs (a later accept hits 4053, which
            # the host frontend ignores in the 'incoming' phase).
            if removed.state != "active":
                await _dismiss_other_host_tabs(manager, removed, answered=websocket)
        except Exception:  # noqa: BLE001
            log.exception("remote disconnect cleanup failed for session %s", sess.session_id)
