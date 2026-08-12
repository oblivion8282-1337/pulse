"""WebSocket op handlers for Pulse-Fernsteuerung (remote control).

The gateway is the **consent gate** plus a relay for two small payload kinds —
it never carries video (that rides the HQ-stream path). These handlers own the
consent handshake, forward SDP/ICE between the peer sockets (the P2P fallback
branch), and pass the controller's **input frames** to the host. Session
bookkeeping lives in :mod:`remote_registry` (in-process, single-pod).

Op flow::

    controller --remote_request--> gateway --remote_request--> host (all tabs)
    host       --remote_respond--> gateway --remote_response--> both peers
    peer       --remote_signal---> gateway --remote_signal---> the *other* peer
    controller --remote_input----> gateway --remote_input----> host
    peer       --remote_end------> gateway --remote_ended----> the *other* peer

``remote_input`` carries the input wire protocol v2 (spec:
``docs/plans/2026-08-12-input-wire-protokoll-v2.md``, "Die Hülle auf dem
Serverweg"). The gateway checks session, role and size and **does not parse the
frames** — that would mean maintaining the format in two places for no gain.

Error frames are fire-and-forget (``_err``) — the socket is never closed:
  * 4050 required field missing / invalid (input: bad slot, bad base64, or a
    batch over the limits — those frames are dropped, the session survives)
  * 4051 no access (not a member / no VIEW_CHANNEL / no REMOTE_CONTROL)
  * 4052 host not reachable (offline or not a member of the channel)
  * 4053 no matching session / not a peer / input from the host, not the controller
  * 4054 host already has an active session
"""

from __future__ import annotations

import base64
import logging
from collections.abc import Callable
from typing import Any

from fastapi import WebSocket

from dcc_chat_gateway.permissions import Permissions, has_permission, resolve_permissions
from dcc_chat_gateway.remote_registry import send_to_socket
from dcc_chat_gateway.routes._deps import channel_membership
from dcc_chat_gateway.security import AuthenticatedUser

log = logging.getLogger(__name__)

# Flood limits for ``remote_input`` (protocol v2, "Grenzen"). They protect the
# *gateway*, not the host — the host is fail-closed on its own. The largest
# frame is 5 bytes, so a well-behaved controller never comes near them.
MAX_INPUT_FRAMES = 32
MAX_INPUT_DECODED_BYTES = 1024


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
    """Reject one op. **Logged**, weil eine Ablehnung am Client nur als
    ausbleibende Wirkung ankommt: die Anfrage setzt sich still zurück, kein
    Dialog erscheint, und von aussen sieht das aus wie ein toter Knopf.

    Am 2026-08-12 im Zwei-Geraete-Test genau so aufgelaufen — ohne diese Zeile
    liess sich nicht unterscheiden, ob die Anfrage nie ankam oder abgewiesen
    wurde. Der Code allein genuegt (4051 = kein Zugriff, 4052 = Host nicht
    erreichbar, …); Nutzdaten stehen bewusst nicht drin."""
    log.info("remote op rejected: code=%s msg=%s", code, msg)
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
        # Der haeufigste Grund fuer "der Knopf tut nichts": der Host ist zwar
        # Mitglied, hat aber gerade keine offene Verbindung. Die Zahl im Log
        # trennt das von "gar nicht angekommen".
        await _err(websocket, 4052, "host not reachable")
        return
    log.info(
        "remote request accepted for relay: channel=%s host_sockets=%d",
        cid,
        len(host_sockets),
    )
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
    # Only a still-pending session may be answered. A second respond of EITHER
    # polarity — a second host tab, or the same tab changing its mind after
    # accepting — must NOT tear down or re-notify an already-active session
    # (decline would otherwise `remote_end` a live session; both would fan out a
    # stale `remote_canceled`). Bail before any side effect so accept and decline
    # are symmetric with the activate guard below.
    if sess.state != "pending":
        await _err(websocket, 4053, "session already answered")
        return
    # EVERY side effect (dismiss/notify/teardown) must happen only AFTER this tab
    # atomically wins the answer — otherwise, in a concurrent double-answer, a
    # losing tab's `_dismiss_other_host_tabs` broadcast could reach and reset the
    # winning tab (orphaning a live session). Accept wins via `remote_activate`
    # (pending→active CAS), decline via `remote_end_if_pending` (pop-if-pending);
    # the loser gets 4053 and touches nothing.
    if not accept:
        removed = await mgr.remote_end_if_pending(session_id)
        if removed is None:
            await _err(websocket, 4053, "session already answered")
            return
        mgr.remote_cancel_timeout(session_id)
        await _dismiss_other_host_tabs(mgr, removed, answered=websocket)
        await send_to_socket(
            removed.controller_socket,
            {"op": "remote_response", "session_id": session_id, "accepted": False},
        )
        return
    if not await mgr.remote_activate(session_id):
        await _err(websocket, 4053, "no such session")
        return
    mgr.remote_cancel_timeout(session_id)
    # This socket now owns the live session (authoritative host peer for signal
    # forwarding). Only the winner dismisses the other tabs → no tab can dismiss
    # the winner.
    sess.host_socket = websocket
    await _dismiss_other_host_tabs(mgr, sess, answered=websocket)
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


def _input_payload_error(msg: dict[str, Any]) -> str | None:
    """``None`` when ``slot`` and ``frames`` are well-formed and within the
    flood limits, else the reason for the 4050. Frames are only *measured*:
    the decoded bytes are discarded, never interpreted."""
    slot = msg.get("slot")
    if not isinstance(slot, int) or isinstance(slot, bool) or slot < 0:
        return "slot must be a non-negative integer"
    frames = msg.get("frames")
    if not isinstance(frames, list) or not frames:
        return "frames must be a non-empty list"
    if len(frames) > MAX_INPUT_FRAMES:
        return f"at most {MAX_INPUT_FRAMES} frames per message"
    total = 0
    for frame in frames:
        if not isinstance(frame, str):
            return "frames must be base64 strings"
        try:
            total += len(base64.b64decode(frame, validate=True))
        except ValueError:  # bad alphabet/padding, or a non-ASCII string
            return "frames must be base64 strings"
        if total > MAX_INPUT_DECODED_BYTES:
            return f"at most {MAX_INPUT_DECODED_BYTES} decoded bytes per message"
    return None


async def handle_input(
    websocket: WebSocket, user: AuthenticatedUser, msg: dict[str, Any]
) -> None:
    """Forward input frames from the controller to the host, unchanged. Checks
    session, role and size — nothing else. Every rejection drops the frames of
    *this* message only and leaves the session standing: overstepping a gateway
    limit should cost the controller a mouse move, not its session."""
    session_id = _session_id(msg.get("session_id"))
    if not session_id:
        await _err(websocket, 4050, "session_id required")
        return
    mgr = _manager(websocket)
    if mgr is None:
        return
    sess = mgr.remote_get(session_id)
    if sess is None or sess.state != "active":
        await _err(websocket, 4053, "no active session")
        return
    # One-way street: only the controller sends. The host is the injector, so
    # input arriving from it would mean it is driving itself.
    if websocket is not sess.controller_socket:
        await _err(websocket, 4053, "only the controlling peer may send input")
        return
    problem = _input_payload_error(msg)
    if problem is not None:
        await _err(websocket, 4050, problem)
        return
    # ``slot`` selects one of the host's concurrent streams; resolving it to a
    # source rectangle is the host's job.
    await send_to_socket(
        sess.host_socket,
        {
            "op": "remote_input",
            "session_id": session_id,
            "slot": msg["slot"],
            "frames": msg["frames"],
        },
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
