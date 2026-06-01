"""WS ping/pong keepalive round-trip.

The client sends ``{"op": "ping"}`` on an interval and force-closes the socket
if no ``{"op": "pong"}`` comes back within a timeout — that's how a half-open
TCP connection (silent drop, no browser ``close`` event) gets detected so the
client reconnects. This test pins the server half of that contract.
"""

from __future__ import annotations

import asyncio
import random

import pytest
from starlette.testclient import TestClient


@pytest.mark.asyncio
async def test_ws_ping_replies_pong(ws_app, _auth_signer):
    """A ``ping`` op must get an immediate ``pong`` reply, nothing else."""

    def _run():
        uid = random.randint(1, 1_000_000)
        token = _auth_signer.issue_access(uid, f"u{uid}")
        with TestClient(ws_app) as tc:
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                ws.receive_json()  # hello
                ws.receive_json()  # ready
                ws.send_json({"op": "ping"})
                reply = ws.receive_json()
                assert reply == {"op": "pong"}

    await asyncio.to_thread(_run)
