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

from .conftest import receive_skipping


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
                receive_skipping(ws1)  # ready
                receive_skipping(ws2)  # ready

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
                msgs1 = [receive_skipping(ws1) for _ in range(2)]
                ops1 = [m["op"] for m in msgs1]
                assert "message_ack" in ops1
                assert "message" in ops1
                ack = next(m for m in msgs1 if m["op"] == "message_ack")
                assert ack["nonce"] == "n1"

                got = receive_skipping(ws2)
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


@pytest.mark.asyncio
async def test_ws_non_numeric_channel_id_errors(ws_app, _auth_signer):
    # Audit #3: a non-numeric channel_id must produce an error frame, not crash
    # the connection with a ValueError.
    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, _, _, _ = _bootstrap_sync(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                ws.receive_json()
                ws.send_json({"op": "subscribe", "channel_id": "not-a-number"})
                resp = ws.receive_json()
                assert resp["op"] == "error"
                # connection still alive — another op still works
                ws.send_json({"op": "subscribe", "channel_id": ""})
                assert ws.receive_json()["op"] == "error"

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_oversized_frame_rejected_but_survives(ws_app, _auth_signer):
    # Audit #11 (revised): a single oversized frame gets an error frame but the
    # session stays open — only repeated abuse closes it.
    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, _, _, channel_id = _bootstrap_sync(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                ws.receive_json()
                huge = "x" * (32 * 1024)
                ws.send_json({"op": "send", "channel_id": channel_id, "content": huge})
                resp = ws.receive_json()
                assert resp["op"] == "error"
                assert resp["code"] == 4009
                # Connection still alive — a normal op still works.
                ws.send_json({"op": "subscribe", "channel_id": channel_id})
                ws.send_json(
                    {"op": "send", "channel_id": channel_id, "content": "ok", "nonce": "n"}
                )
                ops = [ws.receive_json()["op"] for _ in range(2)]
                assert "message_ack" in ops

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_repeated_oversized_frames_close(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, _, _, channel_id = _bootstrap_sync(tc, _auth_signer)
            with pytest.raises(Exception):
                with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                    ws.receive_json()
                    huge = "x" * (32 * 1024)
                    for _ in range(6):
                        ws.send_json(
                            {"op": "send", "channel_id": channel_id, "content": huge}
                        )
                        ws.receive_json()  # 4009 error frame, until the socket closes
                    ws.receive_text()  # should raise: socket closed

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_closes_when_token_expires(ws_app, _auth_signer):
    # The WS connection must not outlive its access token: a 4001 close fires
    # once `exp` passes. We mint a token whose `exp` is ~1s out.
    import time as _time

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, _, guild_id, _ = _bootstrap_sync(tc, _auth_signer)
            uid = 424242
            now = int(_time.time())
            short_token = _auth_signer._sign(
                {
                    "iss": "dcc-auth",
                    "aud": "dcc",
                    "sub": str(uid),
                    "username": "shortlived",
                    "iat": now,
                    "exp": now + 1,
                    "typ": "access",
                }
            )
            with pytest.raises(Exception):
                with tc.websocket_connect(f"/ws?token={short_token}") as ws:
                    ws.receive_json()  # ready
                    # Block on a read; the server closes us within ~1s.
                    while True:
                        ws.receive_json()

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_already_expired_token_rejected_before_ready(ws_app, _auth_signer):
    # Fix 2: a token whose exp is already in the past must be rejected before
    # ready is sent — the client must not receive ready followed by 4001.
    import time as _time

    def _run():
        with TestClient(ws_app) as tc:
            now = int(_time.time())
            expired_token = _auth_signer._sign(
                {
                    "iss": "dcc-auth",
                    "aud": "dcc",
                    "sub": "999888",
                    "username": "expired",
                    "iat": now - 120,
                    "exp": now - 60,
                    "typ": "access",
                }
            )
            with pytest.raises(Exception):
                with tc.websocket_connect(f"/ws?token={expired_token}") as ws:
                    msg = ws.receive_json()
                    # If we got here, ensure it wasn't a ready frame.
                    assert msg.get("op") != "ready", "should not receive ready for expired token"

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_oversize_leaky_bucket_resets(ws_app, _auth_signer):
    # Fix 1: oversize_frames counter must decrement on valid frames so that a
    # client sending < _MAX_OVERSIZE_FRAMES oversized frames spread across
    # normal traffic is never disconnected.
    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, _, _, channel_id = _bootstrap_sync(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                ws.receive_json()  # ready
                ws.send_json({"op": "subscribe", "channel_id": channel_id})
                huge = "x" * (32 * 1024)
                # Send 4 oversized frames (threshold is 5), interspersed with
                # valid frames that should decrement the counter.
                for _ in range(4):
                    ws.send_json(
                        {"op": "send", "channel_id": channel_id, "content": huge}
                    )
                    resp = ws.receive_json()
                    assert resp["op"] == "error"
                    assert resp["code"] == 4009
                    # valid frame — should decrement oversize_frames.
                    # A successful send emits 3 frames: message_ack +
                    # message + channel_bump (the bump goes to guild:events
                    # and is delivered to every WS, including this one).
                    ws.send_json(
                        {"op": "send", "channel_id": channel_id, "content": "ok", "nonce": "n"}
                    )
                    ops = [ws.receive_json()["op"] for _ in range(3)]
                    assert "message_ack" in ops
                # After 4 oversized / 4 valid pairs the net counter is 0 or low —
                # send 4 more oversized frames; connection must still survive.
                for _ in range(4):
                    ws.send_json(
                        {"op": "send", "channel_id": channel_id, "content": huge}
                    )
                    resp = ws.receive_json()
                    assert resp["op"] == "error"
                    assert resp["code"] == 4009
                # Connection still alive.
                ws.send_json({"op": "send", "channel_id": channel_id, "content": "alive", "nonce": "fin"})
                ops = [ws.receive_json()["op"] for _ in range(3)]
                assert "message_ack" in ops

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_long_nonce_trimmed(ws_app, _auth_signer):
    # Audit #3: a long nonce must not blow past the VARCHAR(64) column.
    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, _, _, channel_id = _bootstrap_sync(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                ws.receive_json()
                ws.send_json({"op": "subscribe", "channel_id": channel_id})
                ws.send_json(
                    {
                        "op": "send",
                        "channel_id": channel_id,
                        "content": "hi",
                        "nonce": "n" * 500,
                    }
                )
                msgs = [ws.receive_json() for _ in range(2)]
                assert "message_ack" in [m["op"] for m in msgs]


@pytest.mark.asyncio
async def test_ws_close_4046_when_jwks_not_ready(ws_app, _auth_signer):
    """WS must close with 4046 while jwks_ready=False (cold-start gate)."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            token = _auth_signer.issue_access(owner_uid, f"u{owner_uid}")
            # Simulate cold-start: flip the flag after lifespan started.
            ws_app.state.jwks_ready = False
            try:
                with pytest.raises(Exception):
                    with tc.websocket_connect(f"/ws?token={token}") as ws:
                        ws.receive_text()
            finally:
                # Restore so subsequent tests in this run are unaffected.
                ws_app.state.jwks_ready = True

    await asyncio.to_thread(_run)

    await asyncio.to_thread(_run)
