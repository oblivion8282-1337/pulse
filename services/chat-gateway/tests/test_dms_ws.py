"""WebSocket round-trip tests for direct-message channels.

Mirrors test_ws.py for guild channels: subscribe + send + ready payload,
but exercising the DM-side of the polymorphic /ws endpoint.
"""

from __future__ import annotations

import asyncio
import random

import pytest
from starlette.testclient import TestClient


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _bootstrap_dm_sync(tc: TestClient, signer) -> tuple[str, int, str, int, str]:
    """Create two users + a DM channel between them; return tokens + ids."""
    uid_a = random.randint(1, 1_000_000)
    uid_b = random.randint(1, 1_000_000)
    t_a = signer.issue_access(uid_a, f"a{uid_a}")
    t_b = signer.issue_access(uid_b, f"b{uid_b}")
    r = tc.post(
        "/dm-channels", json={"target_user_id": uid_b}, headers=_auth(t_a)
    )
    assert r.status_code == 201, r.text
    return t_a, uid_a, t_b, uid_b, r.json()["id"]


@pytest.mark.asyncio
async def test_ws_ready_includes_dm_channels(ws_app, _auth_signer):
    """The ready payload must seed clients with their DM channel list."""

    def _run():
        with TestClient(ws_app) as tc:
            t_a, _, _, uid_b, dm_id = _bootstrap_dm_sync(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={t_a}") as ws:
                payload = ws.receive_json()
                assert payload["op"] == "ready"
                dm_list = payload.get("dm_channels")
                assert isinstance(dm_list, list)
                ids = {d["id"] for d in dm_list}
                assert dm_id in ids
                entry = next(d for d in dm_list if d["id"] == dm_id)
                assert entry["other_user_id"] == str(uid_b)
                assert entry["last_message_id"] is None

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_subscribe_dm_as_member(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            t_a, _, _, _, dm_id = _bootstrap_dm_sync(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={t_a}") as ws:
                ws.receive_json()  # ready
                ws.send_json({"op": "subscribe", "channel_id": dm_id})
                # No error frame should arrive — but pulling one would block,
                # so instead send a follow-up echo (a no-op subscribe to a
                # bogus id will error and round-trip).
                ws.send_json({"op": "subscribe", "channel_id": "not-a-number"})
                resp = ws.receive_json()
                # The error we expect is for the *second* (bogus) op only.
                assert resp["op"] == "error"
                assert resp["code"] == 4003

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_subscribe_dm_as_non_member_rejected(ws_app, _auth_signer):
    """A user who is NOT one of the DM's two members must not be allowed
    to subscribe — snowflake DM IDs are enumerable so this is the only
    barrier."""

    def _run():
        with TestClient(ws_app) as tc:
            _, _, _, _, dm_id = _bootstrap_dm_sync(tc, _auth_signer)
            uid_c = random.randint(1, 1_000_000)
            t_c = _auth_signer.issue_access(uid_c, f"c{uid_c}")
            with tc.websocket_connect(f"/ws?token={t_c}") as ws:
                ws.receive_json()  # ready
                ws.send_json({"op": "subscribe", "channel_id": dm_id})
                resp = ws.receive_json()
                assert resp["op"] == "error"
                assert resp["code"] == 4004

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_dm_send_and_fanout(ws_app, _auth_signer):
    """Both DM members receive the message via fanout; sender gets ack."""

    def _run():
        with TestClient(ws_app) as tc:
            t_a, _, t_b, _, dm_id = _bootstrap_dm_sync(tc, _auth_signer)
            with (
                tc.websocket_connect(f"/ws?token={t_a}") as ws_a,
                tc.websocket_connect(f"/ws?token={t_b}") as ws_b,
            ):
                ws_a.receive_json()
                ws_b.receive_json()
                ws_a.send_json({"op": "subscribe", "channel_id": dm_id})
                ws_b.send_json({"op": "subscribe", "channel_id": dm_id})

                ws_a.send_json(
                    {
                        "op": "send",
                        "channel_id": dm_id,
                        "content": "hallo per dm",
                        "nonce": "dm-n1",
                    }
                )

                msgs_a = [ws_a.receive_json() for _ in range(2)]
                ops_a = [m["op"] for m in msgs_a]
                assert "message_ack" in ops_a
                assert "message" in ops_a
                ack = next(m for m in msgs_a if m["op"] == "message_ack")
                assert ack["nonce"] == "dm-n1"

                got = ws_b.receive_json()
                assert got["op"] == "message"
                assert got["data"]["content"] == "hallo per dm"
                assert got["data"]["channel_id"] == dm_id

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_dm_send_publishes_dm_bump(ws_app, _auth_signer):
    """A send on a DM must publish a dm_bump on the guild:events channel
    carrying the (a, b) pair so receiving clients can decide membership."""

    def _run():
        with TestClient(ws_app) as tc:
            t_a, uid_a, t_b, uid_b, dm_id = _bootstrap_dm_sync(tc, _auth_signer)
            with (
                tc.websocket_connect(f"/ws?token={t_a}") as ws_a,
                tc.websocket_connect(f"/ws?token={t_b}") as ws_b,
            ):
                ws_a.receive_json()
                ws_b.receive_json()
                # A sends without subscribing — exercises the slow path
                # (membership resolved + dm_pair filled from the DM object).
                ws_a.send_json(
                    {
                        "op": "send",
                        "channel_id": dm_id,
                        "content": "bump payload",
                        "nonce": "bp",
                    }
                )
                # A receives ack + dm_bump (no `message` because A isn't
                # subscribed to the DM channel). Order isn't guaranteed.
                seen_ack = False
                seen_bump = False
                for _ in range(2):
                    m = ws_a.receive_json()
                    if m["op"] == "message_ack":
                        seen_ack = True
                    elif m["op"] == "dm_bump":
                        assert m["channel_id"] == dm_id
                        assert {m["user_a_id"], m["user_b_id"]} == {
                            str(uid_a),
                            str(uid_b),
                        }
                        assert m["author_id"] == str(uid_a)
                        seen_bump = True
                assert seen_ack and seen_bump
                # B also sees the dm_bump (fanned to all connections).
                b_bump = ws_b.receive_json()
                assert b_bump["op"] == "dm_bump"
                assert b_bump["channel_id"] == dm_id

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_dm_send_bumps_last_message_id(ws_app, _auth_signer):
    """A WS send on a DM must update last_message_id (visible on next ready)."""

    def _run():
        with TestClient(ws_app) as tc:
            t_a, _, _, _, dm_id = _bootstrap_dm_sync(tc, _auth_signer)
            sent_msg_id: str | None = None
            with tc.websocket_connect(f"/ws?token={t_a}") as ws:
                ws.receive_json()  # ready
                ws.send_json({"op": "subscribe", "channel_id": dm_id})
                ws.send_json(
                    {
                        "op": "send",
                        "channel_id": dm_id,
                        "content": "bump me",
                        "nonce": "bump",
                    }
                )
                msgs = [ws.receive_json() for _ in range(2)]
                ack = next(m for m in msgs if m["op"] == "message_ack")
                sent_msg_id = ack["id"]

            # Open a fresh connection; ready must reflect the bump.
            with tc.websocket_connect(f"/ws?token={t_a}") as ws2:
                payload = ws2.receive_json()
                entry = next(d for d in payload["dm_channels"] if d["id"] == dm_id)
                assert entry["last_message_id"] == sent_msg_id

    await asyncio.to_thread(_run)
