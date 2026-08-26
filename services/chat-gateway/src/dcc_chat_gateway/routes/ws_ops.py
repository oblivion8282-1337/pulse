"""WebSocket op-loop + session cleanup (Phase B extract).

Extracted from :mod:`routes.ws` so the endpoint stays small. Owns the
long-running ``while True: receive → dispatch`` loop and the disconnect-side
cleanup.

Per-op handlers live in :mod:`routes.ws_ops_handlers` (small ops + watch
trampolines + ``send`` re-export) and :mod:`routes.ws_op_send` (the big
``send`` handler). The dispatch table is the :mod:`routes.ws_ops_registry`
module — Plugin-System Schritt 2's plug-in point for adding new client→server
ops without touching this file.
"""

from __future__ import annotations

import json
import logging

from fastapi import WebSocket, WebSocketDisconnect

# Re-export so external consumers (push.py opens its own session via
# ``routes.ws_ops.SessionLocal``, app.py wires the ConnectionManager through
# it) keep working after the Schritt-2 split. The actual op handlers now
# import ``SessionLocal`` directly from ``dcc_chat_gateway.db`` in their own
# modules; tests patch every module that holds a reference.
from dcc_chat_gateway.db import SessionLocal  # noqa: F401

# Import for side-effects: each handler in this module registers itself with
# the WS op-registry at import time, so by the time we enter the op-loop the
# registry is fully populated.
from dcc_chat_gateway.plugins.ws_op_gate import check_plugin_op_gate, parse_plugin_op
from dcc_chat_gateway.routes import ws_ops_handlers  # noqa: F401
from dcc_chat_gateway.routes import ws_device_handlers, ws_remote_teardown, ws_watch
from dcc_chat_gateway.routes.ws_ops_registry import WSOpContext, get_handler
from dcc_chat_gateway.routes.ws_token_renewal import TokenExpiryWatch
from dcc_chat_gateway.security import AuthenticatedUser

log = logging.getLogger(__name__)

_MAX_WS_FRAME_BYTES = 16 * 1024
_MAX_OVERSIZE_FRAMES = 5


async def run_session_op_loop(
    websocket: WebSocket,
    user: AuthenticatedUser,
    manager,
    redis,
    exp: float | int | None,
) -> None:
    """Drive the WebSocket op-loop and run cleanup on disconnect.

    State that handlers read and mutate (``subscribed``, ``hosted_parties``,
    ``current_voice_channel``) lives on the :class:`WSOpContext` so it
    survives across handler calls and the ``finally`` cleanup block.
    """
    ctx = WSOpContext(websocket=websocket, user=user, manager=manager, redis=redis)
    oversize_frames = 0

    # Tie the connection's lifetime to the token's ``exp``: when it passes,
    # the watch closes the socket with 4001. Anders als frueher ist das Ziel
    # verschiebbar — der ``token_refresh``-Op reicht ein frisches Token nach
    # und der Socket bleibt bestehen, statt im Token-Takt neu aufgebaut zu
    # werden (und dabei jedes Mal ein Praesenz-Flackern auszuloesen, s.
    # ``ws_token_renewal.py``). Bleibt die Erneuerung aus, gilt der alte Weg.
    if isinstance(exp, (int, float)):
        ctx.token_expiry = TokenExpiryWatch(websocket, float(exp))

    try:
        while True:
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                break
            if len(raw) > _MAX_WS_FRAME_BYTES:
                oversize_frames += 1
                await websocket.send_json(
                    {"op": "error", "code": 4009, "msg": "frame too large"}
                )
                if oversize_frames >= _MAX_OVERSIZE_FRAMES:
                    break
                continue
            # Leaky bucket: a valid frame decrements the oversize counter so a
            # legitimate client that occasionally sends an oversized frame amid
            # normal traffic is never disconnected. Intentional, not an evasion
            # risk — oversized frames are already rejected (4009) and never
            # processed; an alternating client gains nothing by staying open.
            oversize_frames = max(0, oversize_frames - 1)
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json(
                    {"op": "error", "code": 4002, "msg": "invalid JSON"}
                )
                continue
            if not isinstance(msg, dict):
                await websocket.send_json(
                    {"op": "error", "code": 4002, "msg": "invalid JSON"}
                )
                continue
            op = msg.get("op")
            # Plugin-Op-Gate: colon-namespaced Ops müssen durch
            # Allowlist + Guild-Membership + Guild-Toggle BEFORE handler lookup,
            # so unknown plugin op names do not leak handler existence.
            # ``hello:*`` ist nur durch die Allowlist gegated; alle anderen
            # Plugins brauchen guild_id im Payload. Siehe
            # ``plugins.ws_op_gate.check_plugin_op_gate`` für Details.
            gate_session = None
            gate_passed = True
            if isinstance(op, str) and parse_plugin_op(op) is not None:
                allowlist = getattr(
                    websocket.app.state, "plugin_allowlist", frozenset()
                )
                gate_session = SessionLocal()
                # Guard the gate check + denial-send: if check_plugin_op_gate
                # raises a DB error, or send_json raises WebSocketDisconnect on
                # the denial path, the session must still be closed — otherwise
                # it leaks a pool connection on every such occurrence.
                try:
                    decision = await check_plugin_op_gate(
                        session=gate_session,
                        op=op,
                        payload=msg,
                        user_id=user.id,
                        allowlist=allowlist,
                    )
                    if not decision.allowed:
                        await websocket.send_json(
                            {
                                "op": "error",
                                "code": decision.error_code,
                                "msg": decision.error_msg,
                            }
                        )
                        gate_passed = False
                except BaseException:
                    await gate_session.close()
                    gate_session = None
                    raise
                if not gate_passed:
                    await gate_session.close()
                    gate_session = None
                else:
                    # Thread the session to the handler to avoid double pool
                    # acquisition; closed in the handler's finally block below.
                    ctx._db_session = gate_session
            if not gate_passed:
                continue
            handler = get_handler(op) if isinstance(op, str) else None
            if handler is None:
                await websocket.send_json(
                    {"op": "error", "code": 4007, "msg": f"unknown op: {op}"}
                )
                if gate_session is not None:
                    await gate_session.close()
                continue
            try:
                await handler(ctx, msg)
            except WebSocketDisconnect:
                # Handlers may raise WebSocketDisconnect to request a clean
                # close (e.g. profile_statement on invalid JWT).  Propagate
                # so the outer loop exits normally via its finally block.
                raise
            except Exception:  # noqa: BLE001
                # An unhandled exception from a plugin handler must not tear
                # down the entire WebSocket session.  Log it and send an error
                # frame so the client knows something went wrong.
                log.exception(
                    "ws op handler raised for op=%s user=%s",
                    msg.get("op"),
                    user.id,
                )
                try:
                    await websocket.send_json(
                        {"op": "error", "code": 5000, "msg": "internal server error"}
                    )
                except Exception:  # noqa: BLE001
                    pass
            finally:
                # Close the gate session if it was threaded to the handler.
                if gate_session is not None:
                    await gate_session.close()
                    ctx._db_session = None
    finally:
        if ctx.token_expiry is not None:
            ctx.token_expiry.cancel()
            await ctx.token_expiry.wait_cancelled()
        # Watch parties: leave the watcher registry for every party this
        # socket watched and promote a new host (or end the party) where this
        # user was the host. Must run before remove_socket so the registry's
        # socket set still includes this connection.
        try:
            await ws_watch.cleanup_on_disconnect(
                websocket, user, manager, ctx.watched_parties
            )
        except Exception:  # noqa: BLE001
            log.exception("watch cleanup_on_disconnect failed for user=%s", user.id)
        # Remote-control sessions: an ACTIVE session this socket was a peer of
        # gets a short grace window before it ends (`remote_reconnect_registry.py`,
        # added 2026-08-19 — a socket drops every few minutes on the shared
        # remote-dev-stack, and treating every blip as final killed working
        # sessions); a still-PENDING one (just a dialog, nothing to save) ends
        # immediately as before. Must also run before remove_socket so the
        # per-user socket set is still intact for the registry lookup.
        # Standplatz-Geraete: eine Verbindung, die faellt, nimmt jedes Geraet
        # mit, das sie angemeldet hatte. **VOR dem Fernsteuer-Abbau**, und das
        # ist der ganze Trick: der Abbau einer Sitzung gibt das Geraet sonst
        # erst als „wieder bereit" frei und meldet das an alle, bevor eine
        # Millisekunde spaeter „offline" hinterherkommt. Das Geraet stuende in
        # dem Fenster als frei uebernehmbar in der Liste. Zuerst vergessen
        # heisst: eine einzige Meldung, und sie stimmt.
        try:
            await ws_device_handlers.on_disconnect(manager, websocket)
        except Exception:  # noqa: BLE001
            log.exception("device cleanup_on_disconnect failed for user=%s", user.id)
        try:
            await ws_remote_teardown.cleanup_remote_on_disconnect(websocket, manager)
        except Exception:  # noqa: BLE001
            log.exception("remote cleanup_on_disconnect failed for user=%s", user.id)
        await manager.remove_socket(websocket)
        if manager.user_socket_count(user.id) == 0:
            try:
                await manager.broadcast_presence_update(str(user.id), online=False)
            except Exception:  # noqa: BLE001
                log.exception(
                    "broadcast_presence_update(online=False) failed for user=%s",
                    user.id,
                )
        # If this was the user's last open socket, drop their self-mute
        # state. Without this, ``voice:user_state:<id>`` lingers for the
        # full 6h TTL and the user keeps appearing as muted to everyone
        # after they disconnect. Multi-tab users keep their state until
        # the last tab closes.
        if manager.user_socket_count(user.id) == 0:
            try:
                await manager.clear_user_voice_state(
                    str(user.id), channel_id=ctx.current_voice_channel
                )
            except Exception:  # noqa: BLE001
                log.exception(
                    "clear_user_voice_state failed for user=%s", user.id
                )
        # Try to close cleanly. Already-closed sockets raise.
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
