"""Tamagotchi-Plugin backend — Pulse Plugin-System Schritt-7 reference.

The Tamagotchi-State *lives on the client* (Settings-Section, localStorage).
The backend here is deliberately tiny: it accepts the four action ops
(``feed``/``play``/``sleep``/``reset``) and echoes a ``tamagotchi:ack`` back
to the same socket. That gives the frontend a definite "round-trip
succeeded" signal — and lays a foundation for Schritt 3b (server-side
`user_preferences` table) where cross-device-sync would replace this echo
with a real persisted state update.

Why ack instead of just dropping the message? Two reasons:

1. **Proof of contract.** Manual smoke-testing the plugin via a WS client
   needs an observable round-trip. The ack guarantees the registry path
   ran end-to-end.
2. **UI hooks.** The frontend can latch ``tamagotchi:ack`` to play a sound
   or animate the pet — without round-tripping through the server it would
   be hard to distinguish "I clicked the button" from "the server saw my
   click". For Schritt 7 we just log, but the seam is there.

Loaded by ``dcc_chat_gateway.plugins.loader`` via the
``backend = "backend:register"`` entrypoint in ``plugin.toml``. The
permission gate (Schritt 5) verifies that the ops we register here match
the ``[plugin.uses].ws_ops`` list.
"""

from __future__ import annotations

import logging
from typing import Any

from dcc_chat_gateway.routes.ws_ops_registry import (
    WSOpContext,
    register_ws_op,
)

log = logging.getLogger(__name__)


_ACTIONS = ("feed", "play", "sleep", "reset")


async def _ack(ctx: WSOpContext, action: str, msg: dict[str, Any]) -> None:
    """Send a ``tamagotchi:ack`` frame back to the originating socket.

    Keeps any caller-supplied ``echo`` field for parity with the hello-plugin
    smoke-test; the frontend doesn't need it but a manual WS client does.
    """
    payload: dict[str, Any] = {"op": "tamagotchi:ack", "action": action}
    if "echo" in msg:
        payload["echo"] = msg["echo"]
    await ctx.websocket.send_json(payload)


async def _handle_feed(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    """Pet got fed — hunger drops on the client; we just ack."""
    await _ack(ctx, "feed", msg)


async def _handle_play(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    """Pet played — happiness up, energy down on the client; we just ack."""
    await _ack(ctx, "play", msg)


async def _handle_sleep(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    """Pet napped — energy up + time skip on the client; we just ack."""
    await _ack(ctx, "sleep", msg)


async def _handle_reset(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    """Reset to factory state. Same ack-shape so the client treats every
    action identically (a single ``tamagotchi:ack`` handler in the frontend)."""
    await _ack(ctx, "reset", msg)


_HANDLERS: dict[str, Any] = {
    "feed": _handle_feed,
    "play": _handle_play,
    "sleep": _handle_sleep,
    "reset": _handle_reset,
}


def register() -> None:
    """Entrypoint called by the plugin loader at startup.

    Idempotent — re-running `register()` rebinds the same handler under the
    same op (last-writer-wins, matches `register_ws_op`'s contract). The
    permission gate in `plugins.registry.PluginManager.activate` snapshots
    the registry before/after this call, so anything we register here must
    be in `[plugin.uses].ws_ops` in `plugin.toml`.
    """
    for action in _ACTIONS:
        register_ws_op(f"tamagotchi:{action}", _HANDLERS[action])
    log.info("tamagotchi-plugin: registered ws ops %s", list(_ACTIONS))
