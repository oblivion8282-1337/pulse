"""Tests for the WS hello-frame (Phase 3.3).

Coverage:
1. Erstes Frame nach WS-Connect ist {op:"hello", server_version, capabilities}.
2. hello-Frame kommt vor dem ready-Frame.
3. server_version matches __version__.
"""

from __future__ import annotations

import asyncio
import random

import pytest
from starlette.testclient import TestClient

from dcc_chat_gateway import __version__


@pytest.mark.asyncio
async def test_ws_hello_is_first_frame(ws_app, _auth_signer):
    """First frame after WS connect is the hello op."""

    def _run():
        with TestClient(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            token = _auth_signer.issue_access(uid, f"u{uid}")
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                frame = ws.receive_json()
                assert frame["op"] == "hello"
                assert frame["server_version"] == __version__
                assert isinstance(frame["capabilities"], list)

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_hello_before_ready(ws_app, _auth_signer):
    """hello-Frame kommt vor dem ready-Frame."""

    def _run():
        with TestClient(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            token = _auth_signer.issue_access(uid, f"u{uid}")
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                first = ws.receive_json()
                second = ws.receive_json()
                assert first["op"] == "hello"
                assert second["op"] == "ready"

    await asyncio.to_thread(_run)
