"""WS ``typing`` op — ephemeral "user is typing" fan-out.

The composer sends ``{"op": "typing", "channel_id": …}`` (debounced) while the
user types; the server broadcasts ``{"op": "typing", channel_id, user_id}`` to
the channel's other subscribers (view-channel-filtered, no persistence). A
per-connection throttle drops bursts so a client can't flood the fan-out.

The fan-out path is one integration round-trip; the throttle + subscription
gate are unit-tested directly on the handler so they don't depend on
cross-connection frame ordering.
"""

from __future__ import annotations

import asyncio
import random

import pytest
from starlette.testclient import TestClient

from dcc_chat_gateway.routes.ws_ops_handlers import handle_typing
from dcc_chat_gateway.routes.ws_ops_registry import WSOpContext

from .conftest import receive_skipping
from .test_ws import _bootstrap_sync


@pytest.mark.asyncio
async def test_ws_typing_fans_out(ws_app, _auth_signer):
    """A subscribed member's ``typing`` reaches the channel's other members,
    tagged with the sender's user id."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, member_token, member_uid, _, channel_id = _bootstrap_sync(
                tc, _auth_signer
            )
            with (
                tc.websocket_connect(f"/ws?token={owner_token}") as ws1,
                tc.websocket_connect(f"/ws?token={member_token}") as ws2,
            ):
                receive_skipping(ws1)  # ready
                receive_skipping(ws2)  # ready
                ws1.send_json({"op": "subscribe", "channel_id": channel_id})
                # ping→pong round-trip: ops are processed in order per
                # connection, so a pong proves ws1's subscribe is done before
                # ws2 broadcasts (kills the cross-connection subscribe race).
                ws1.send_json({"op": "ping"})
                assert receive_skipping(ws1)["op"] == "pong"

                ws2.send_json({"op": "subscribe", "channel_id": channel_id})
                ws2.send_json({"op": "typing", "channel_id": channel_id})

                got = receive_skipping(ws1)
                assert got["op"] == "typing"
                assert got["channel_id"] == channel_id
                assert got["user_id"] == str(member_uid)

    await asyncio.to_thread(_run)


class _FakeManager:
    """Records ``publish`` calls so the handler unit-tests can assert fan-out
    without a real Redis / WebSocket."""

    def __init__(self) -> None:
        self.published: list[tuple[str, dict]] = []

    async def publish(self, channel_id: str, payload: dict) -> None:
        self.published.append((channel_id, payload))


class _User:
    def __init__(self, uid: int) -> None:
        self.id = uid


def _ctx(manager: _FakeManager, subscribed: dict) -> WSOpContext:
    return WSOpContext(
        websocket=None,  # type: ignore[arg-type]  # unused by handle_typing
        user=_User(42),  # type: ignore[arg-type]
        manager=manager,  # type: ignore[arg-type]
        redis=None,  # type: ignore[arg-type]
        subscribed=subscribed,
    )


@pytest.mark.asyncio
async def test_typing_handler_throttles_burst():
    """Two ``typing`` ops within the throttle window → exactly one broadcast."""
    mgr = _FakeManager()
    ctx = _ctx(mgr, {"100": None})
    await handle_typing(ctx, {"channel_id": "100"})
    await handle_typing(ctx, {"channel_id": "100"})  # inside the 2s window
    assert len(mgr.published) == 1
    cid, payload = mgr.published[0]
    assert cid == "100"
    assert payload == {"op": "typing", "channel_id": "100", "user_id": "42"}


@pytest.mark.asyncio
async def test_typing_handler_ignores_unsubscribed():
    """A ``typing`` for a channel the socket never subscribed to is a no-op."""
    mgr = _FakeManager()
    ctx = _ctx(mgr, {})  # nothing subscribed
    await handle_typing(ctx, {"channel_id": "100"})
    assert mgr.published == []


@pytest.mark.asyncio
async def test_typing_handler_ignores_bad_channel_id():
    """Missing / non-numeric channel_id is ignored, no broadcast."""
    mgr = _FakeManager()
    ctx = _ctx(mgr, {"100": None})
    await handle_typing(ctx, {})
    await handle_typing(ctx, {"channel_id": "not-a-number"})
    assert mgr.published == []
