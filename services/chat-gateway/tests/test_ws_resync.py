"""WS ``resync`` op — re-sends a fresh ``ready`` snapshot on demand.

The client requests this when it switches the active server back to an
already-open connection: its cached ``ready`` is the snapshot from connect
time, so live voice/stream/watch changes since then are missing from the
client-side replay. ``resync`` rebuilds the frame from current state. This
test pins the server half of that contract.
"""

from __future__ import annotations

import asyncio
import random

import pytest
from starlette.testclient import TestClient


@pytest.mark.asyncio
async def test_ws_resync_resends_ready(ws_app, _auth_signer):
    """A ``resync`` op must produce a fresh ``ready`` frame for the same user."""

    def _run():
        uid = random.randint(1, 1_000_000)
        token = _auth_signer.issue_access(uid, f"u{uid}")
        with TestClient(ws_app) as tc:
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                ws.receive_json()  # hello
                first_ready = ws.receive_json()
                assert first_ready["op"] == "ready"
                assert first_ready["user_id"] == str(uid)

                ws.send_json({"op": "resync"})
                second = ws.receive_json()
                assert second["op"] == "ready"
                assert second["user_id"] == str(uid)
                # Carries the same snapshot keys as the initial frame.
                assert "voice_states" in second
                assert "guilds" in second

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_resync_is_throttled(ws_app, _auth_signer):
    """A rapid second ``resync`` is swallowed by the per-connection throttle.

    Rebuilding the ready frame is expensive (DB + Redis/S3), so a tight loop
    must not get a fresh frame each time. We prove the second resync produced
    no ``ready`` by interleaving a ``ping`` and asserting the next frame is the
    ``pong`` — if the throttle were missing, a second ``ready`` would arrive
    first.
    """

    def _run():
        uid = random.randint(1, 1_000_000)
        token = _auth_signer.issue_access(uid, f"u{uid}")
        with TestClient(ws_app) as tc:
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                ws.receive_json()  # hello
                ws.receive_json()  # initial ready

                ws.send_json({"op": "resync"})
                first = ws.receive_json()
                assert first["op"] == "ready"  # first resync served

                # Second resync within the throttle window → no ready frame.
                ws.send_json({"op": "resync"})
                ws.send_json({"op": "ping"})
                nxt = ws.receive_json()
                assert nxt["op"] == "pong", f"expected pong, got {nxt['op']}"

    await asyncio.to_thread(_run)
