"""Remote-control (Pulse-Fernsteuerung) WebSocket signaling tests.

Same harness as the watch-party WS tests: a real ``ws_app`` driven through a
``TestClient`` on a worker thread. The gateway is only the consent gate + SDP/ICE
relay, so these tests assert on the frames it emits, not on any media path.

Consent + permissions:
  * controller needs VIEW_CHANNEL + REMOTE_CONTROL (4051 otherwise)
  * host must be a connected member of the channel (4052 otherwise)
  * only the invited host may answer (4053), only the two peers may signal (4053)
"""

from __future__ import annotations

import asyncio
import random

import pytest
from starlette.testclient import TestClient

from .conftest import ping_barrier, skip_init_frames


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _drain_for(ws, op: str, *, max_drained: int = 20) -> dict:
    """Read up to ``max_drained`` frames and return the first with op ``op``."""
    last = None
    for _ in range(max_drained):
        last = ws.receive_json()
        if last.get("op") == op:
            return last
    raise AssertionError(f"no {op!r} frame after draining {max_drained}; last={last!r}")


def _setup_remote(tc: TestClient, _auth_signer):
    """Owner (has REMOTE_CONTROL implicitly) + a plain member, guild + voice
    channel. Returns (owner_token, owner_uid, member_token, member_uid, gid, cid)."""
    owner_uid = random.randint(1, 1_000_000)
    owner_token = _auth_signer.issue_access(owner_uid, f"u{owner_uid}")
    g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_token)).json()
    vc = tc.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "Voice", "type": 1},
        headers=_auth(owner_token),
    ).json()
    member_uid = random.randint(1, 1_000_000)
    member_token = _auth_signer.issue_access(member_uid, f"u{member_uid}")
    tc.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(member_uid)},
        headers=_auth(owner_token),
    )
    return owner_token, owner_uid, member_token, member_uid, g["id"], vc["id"]


@pytest.mark.asyncio
async def test_request_requires_remote_control_bit(ws_app, _auth_signer):
    """A plain member (VIEW but no REMOTE_CONTROL) asking to control the owner
    is rejected with 4051 — the sensitive bit is not in @everyone."""

    def _run():
        with TestClient(ws_app) as tc:
            _, owner_uid, member_token, _, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={member_token}") as ws:
                skip_init_frames(ws)
                ws.send_json(
                    {"op": "remote_request", "channel_id": cid, "host_user_id": str(owner_uid)}
                )
                err = ws.receive_json()
                assert err["op"] == "error"
                assert err["code"] == 4051

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_request_rejects_non_member(ws_app, _auth_signer):
    """An outsider (not in the guild) gets 4051 — same code as no-bit so a
    hidden channel's existence isn't confirmed."""

    def _run():
        with TestClient(ws_app) as tc:
            _, owner_uid, _, _, _, cid = _setup_remote(tc, _auth_signer)
            outsider_uid = random.randint(1, 1_000_000)
            outsider_token = _auth_signer.issue_access(outsider_uid, f"u{outsider_uid}")
            with tc.websocket_connect(f"/ws?token={outsider_token}") as ws:
                skip_init_frames(ws)
                ws.send_json(
                    {"op": "remote_request", "channel_id": cid, "host_user_id": str(owner_uid)}
                )
                err = ws.receive_json()
                assert err["op"] == "error"
                assert err["code"] == 4051

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_request_host_offline(ws_app, _auth_signer):
    """Host is a member but has no live socket → 4052."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, _, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                skip_init_frames(ws)
                ws.send_json(
                    {"op": "remote_request", "channel_id": cid, "host_user_id": str(member_uid)}
                )
                err = ws.receive_json()
                assert err["op"] == "error"
                assert err["code"] == 4052

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_consent_flow_and_signal_forwarding(ws_app, _auth_signer):
    """Full happy path: request → host accepts → both get remote_response;
    a signal from the controller reaches ONLY the host. Also covers the two
    4053 guards while the session is live."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, owner_uid, member_token, member_uid, gid, cid = _setup_remote(
                tc, _auth_signer
            )
            # A third member, connected but not a peer of the session.
            third_uid = random.randint(1, 1_000_000)
            third_token = _auth_signer.issue_access(third_uid, f"u{third_uid}")
            tc.post(
                f"/guilds/{gid}/members",
                json={"user_id": str(third_uid)},
                headers=_auth(owner_token),
            )
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws, \
                 tc.websocket_connect(f"/ws?token={third_token}") as third_ws:
                for ws in (ctrl_ws, host_ws, third_ws):
                    skip_init_frames(ws)

                # Controller asks to drive the host.
                ctrl_ws.send_json(
                    {"op": "remote_request", "channel_id": cid, "host_user_id": str(member_uid)}
                )
                req = _drain_for(host_ws, "remote_request")
                sid = req["session_id"]
                assert req["from_user_id"] == str(owner_uid)
                assert req["channel_id"] == cid

                # Only the host may answer: the controller answering → 4053.
                ctrl_ws.send_json({"op": "remote_respond", "session_id": sid, "accept": True})
                assert _drain_for(ctrl_ws, "error")["code"] == 4053

                # Host accepts → both peers get accepted:true.
                host_ws.send_json({"op": "remote_respond", "session_id": sid, "accept": True})
                resp_h = _drain_for(host_ws, "remote_response")
                resp_c = _drain_for(ctrl_ws, "remote_response")
                assert resp_h["accepted"] is True and resp_c["accepted"] is True

                # A non-peer signalling into the live session → 4053.
                third_ws.send_json(
                    {"op": "remote_signal", "session_id": sid, "kind": "ice", "data": {"x": 1}}
                )
                assert _drain_for(third_ws, "error")["code"] == 4053

                # Controller's offer reaches ONLY the host.
                ctrl_ws.send_json(
                    {"op": "remote_signal", "session_id": sid, "kind": "offer", "data": {"sdp": "v=0"}}
                )
                sig = _drain_for(host_ws, "remote_signal")
                assert sig["kind"] == "offer" and sig["data"] == {"sdp": "v=0"}
                # The controller must not receive its own forwarded signal: a
                # ping round-trips and pong is the next frame (no signal queued).
                ping_barrier(ctrl_ws)

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_remote_end_notifies_peer(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                ctrl_ws.send_json(
                    {"op": "remote_request", "channel_id": cid, "host_user_id": str(member_uid)}
                )
                sid = _drain_for(host_ws, "remote_request")["session_id"]
                host_ws.send_json({"op": "remote_respond", "session_id": sid, "accept": True})
                _drain_for(ctrl_ws, "remote_response")
                _drain_for(host_ws, "remote_response")

                ctrl_ws.send_json({"op": "remote_end", "session_id": sid})
                ended = _drain_for(host_ws, "remote_ended")
                assert ended["session_id"] == sid
                assert ended["reason"] == "peer_ended"

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_remote_disconnect_notifies_peer(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(host_ws)
                with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws:
                    skip_init_frames(ctrl_ws)
                    ctrl_ws.send_json(
                        {"op": "remote_request", "channel_id": cid, "host_user_id": str(member_uid)}
                    )
                    sid = _drain_for(host_ws, "remote_request")["session_id"]
                    host_ws.send_json({"op": "remote_respond", "session_id": sid, "accept": True})
                    _drain_for(ctrl_ws, "remote_response")
                    _drain_for(host_ws, "remote_response")
                # Controller socket closed here → host is told peer_disconnected.
                ended = _drain_for(host_ws, "remote_ended")
                assert ended["session_id"] == sid
                assert ended["reason"] == "peer_disconnected"

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_remote_respond_decline(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                ctrl_ws.send_json(
                    {"op": "remote_request", "channel_id": cid, "host_user_id": str(member_uid)}
                )
                sid = _drain_for(host_ws, "remote_request")["session_id"]
                host_ws.send_json({"op": "remote_respond", "session_id": sid, "accept": False})
                resp = _drain_for(ctrl_ws, "remote_response")
                assert resp["session_id"] == sid
                assert resp["accepted"] is False

    await asyncio.to_thread(_run)
