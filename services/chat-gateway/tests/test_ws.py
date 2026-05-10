"""WebSocket round-trip tests using starlette's TestClient.

These tests run the entire scenario (REST setup + WS exchange) inside a
single TestClient context so they share one event loop. The
ConnectionManager is created by the app's production lifespan in that same
loop, which avoids cross-loop Redis issues that the async fixture pattern
hits.
"""

from __future__ import annotations

import asyncio
import random

import pytest
from starlette.testclient import TestClient


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _bootstrap_sync(tc: TestClient, signer) -> tuple[str, str, int, str, str]:
    owner_uid = random.randint(1, 1_000_000)
    member_uid = random.randint(1, 1_000_000)
    owner_token = signer.issue_access(owner_uid, f"o{owner_uid}")
    member_token = signer.issue_access(member_uid, f"m{member_uid}")
    g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_token)).json()
    tc.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": member_uid},
        headers=_auth(owner_token),
    )
    c = tc.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "general"},
        headers=_auth(owner_token),
    ).json()
    return owner_token, member_token, member_uid, g["id"], c["id"]


@pytest.mark.asyncio
async def test_ws_unauthorized_token_closes(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            with pytest.raises(Exception):
                with tc.websocket_connect("/ws?token=garbage") as ws:
                    ws.receive_text()

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_ready_payload(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, _, guild_id, _ = _bootstrap_sync(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                payload = ws.receive_json()
                assert payload["op"] == "ready"
                assert guild_id in {g["id"] for g in payload["guilds"]}

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_send_and_fanout(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_token, member_token, _, _, channel_id = _bootstrap_sync(
                tc, _auth_signer
            )
            with (
                tc.websocket_connect(f"/ws?token={owner_token}") as ws1,
                tc.websocket_connect(f"/ws?token={member_token}") as ws2,
            ):
                ws1.receive_json()  # ready
                ws2.receive_json()

                ws1.send_json({"op": "subscribe", "channel_id": channel_id})
                ws2.send_json({"op": "subscribe", "channel_id": channel_id})

                ws1.send_json(
                    {
                        "op": "send",
                        "channel_id": channel_id,
                        "content": "hello world",
                        "nonce": "n1",
                    }
                )

                # Author gets ack + the broadcast (order is not guaranteed).
                msgs1 = [ws1.receive_json() for _ in range(2)]
                ops1 = [m["op"] for m in msgs1]
                assert "message_ack" in ops1
                assert "message" in ops1
                ack = next(m for m in msgs1 if m["op"] == "message_ack")
                assert ack["nonce"] == "n1"

                got = ws2.receive_json()
                assert got["op"] == "message"
                assert got["data"]["content"] == "hello world"

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_subscribe_to_unknown_channel_errors(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, _, _, _ = _bootstrap_sync(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                ws.receive_json()
                ws.send_json({"op": "subscribe", "channel_id": "999999999"})
                resp = ws.receive_json()
                assert resp["op"] == "error"

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_send_to_non_member_channel_rejected(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            outsider_uid = random.randint(1, 1_000_000)
            owner_token = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            outsider_token = _auth_signer.issue_access(outsider_uid, f"x{outsider_uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_token)).json()
            c = tc.post(
                f"/guilds/{g['id']}/channels",
                json={"name": "general"},
                headers=_auth(owner_token),
            ).json()
            channel_id = c["id"]
            with tc.websocket_connect(f"/ws?token={outsider_token}") as ws:
                ws.receive_json()
                ws.send_json(
                    {"op": "send", "channel_id": channel_id, "content": "x", "nonce": "n"}
                )
                resp = ws.receive_json()
                assert resp["op"] == "error"

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_invalid_json(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, _, _, _ = _bootstrap_sync(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                ws.receive_json()
                ws.send_text("not-json")
                resp = ws.receive_json()
                assert resp["op"] == "error"

    await asyncio.to_thread(_run)
