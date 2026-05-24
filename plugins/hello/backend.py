"""Hello-Plugin backend — Pulse Plugin-System Schritt-4 smoke test.

Registers a single WS op (``hello:ping``) that echoes back as
``hello:pong``. Loaded by ``dcc_chat_gateway.plugins.loader`` via the
``backend = "backend:register"`` entrypoint in ``plugin.toml``.
"""

from __future__ import annotations

import logging
from typing import Any

from dcc_chat_gateway.routes.ws_ops_registry import (
    WSOpContext,
    register_ws_op,
)

log = logging.getLogger(__name__)


async def _handle_hello_ping(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    """Echo the inbound ``echo`` field back to the same socket.

    Deliberately tiny — the point is to prove the plugin manifest →
    loader → register-decorator → dispatcher path works end-to-end.
    """
    await ctx.websocket.send_json(
        {"op": "hello:pong", "echo": msg.get("echo")}
    )


def register() -> None:
    """Entrypoint called by the plugin loader at startup.

    The decorator on `_handle_hello_ping` has already done the
    registration at import time; this function is here for symmetry
    with the manifest contract and as a hook for future init code.
    """
    register_ws_op("hello:ping", _handle_hello_ping)
    log.info("hello-plugin: registered ws op 'hello:ping'")
