"""Guild-lifecycle event broadcasts: channel created/updated/deleted +
guild_member_added are published on the `guild:events` Redis channel and
fanned out (verbatim, with their own `op`) to every connected WebSocket.

Regression: before the fix, `delete_channel` / `patch_channel` published on
`chat:channel:<id>`, where `_listen` wraps every payload as `op:"message"` —
so the client saw garbage in its message list instead of a lifecycle event.
"""

from __future__ import annotations

import asyncio
import random

import pytest
from starlette.testclient import TestClient


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _drain_until(ws, op: str, *, limit: int = 8) -> dict:
    """Read frames until one with the given op shows up (skipping ready etc.)."""
    for _ in range(limit):
        msg = ws.receive_json()
        if msg.get("op") == op:
            return msg
    raise AssertionError(f"did not receive op={op} within {limit} frames")


@pytest.mark.asyncio
async def test_channel_created_broadcast(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            owner_token = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_token)).json()
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                ws.receive_json()  # ready
                c = tc.post(
                    f"/guilds/{g['id']}/channels",
                    json={"name": "general"},
                    headers=_auth(owner_token),
                ).json()
                evt = _drain_until(ws, "channel_created")
                assert evt["channel"]["id"] == c["id"]
                assert evt["channel"]["guild_id"] == g["id"]
                assert evt["channel"]["name"] == "general"
                assert evt["channel"]["type"] == 0

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_channel_updated_broadcast(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            owner_token = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_token)).json()
            c = tc.post(
                f"/guilds/{g['id']}/channels",
                json={"name": "general"},
                headers=_auth(owner_token),
            ).json()
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                ws.receive_json()  # ready
                tc.patch(
                    f"/channels/{c['id']}",
                    json={"name": "renamed"},
                    headers=_auth(owner_token),
                )
                evt = _drain_until(ws, "channel_updated")
                assert evt["channel"]["id"] == c["id"]
                assert evt["channel"]["name"] == "renamed"

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_channel_deleted_broadcast(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            owner_token = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_token)).json()
            c = tc.post(
                f"/guilds/{g['id']}/channels",
                json={"name": "general"},
                headers=_auth(owner_token),
            ).json()
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                ws.receive_json()  # ready
                r = tc.delete(f"/channels/{c['id']}", headers=_auth(owner_token))
                assert r.status_code == 204
                evt = _drain_until(ws, "channel_deleted")
                assert evt["channel_id"] == c["id"]
                assert evt["guild_id"] == g["id"]
                # Crucially: it is NOT wrapped as a chat message.
                assert evt["op"] == "channel_deleted"

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_guild_member_added_broadcast_via_invite(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            joiner_uid = random.randint(1, 1_000_000)
            owner_token = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            joiner_token = _auth_signer.issue_access(joiner_uid, f"j{joiner_uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_token)).json()
            tc.post(
                f"/guilds/{g['id']}/channels",
                json={"name": "general"},
                headers=_auth(owner_token),
            )
            inv = tc.post(
                f"/guilds/{g['id']}/invites", json={}, headers=_auth(owner_token)
            ).json()
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                ws.receive_json()  # ready
                r = tc.post(f"/invites/{inv['code']}/accept", headers=_auth(joiner_token))
                assert r.status_code == 200, r.text
                evt = _drain_until(ws, "guild_member_added")
                assert evt["guild_id"] == g["id"]
                assert evt["user_id"] == str(joiner_uid)

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_guild_member_added_broadcast_via_add_member(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            joiner_uid = random.randint(1, 1_000_000)
            owner_token = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_token)).json()
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                ws.receive_json()  # ready
                r = tc.post(
                    f"/guilds/{g['id']}/members",
                    json={"user_id": str(joiner_uid)},
                    headers=_auth(owner_token),
                )
                assert r.status_code == 201, r.text
                evt = _drain_until(ws, "guild_member_added")
                assert evt["guild_id"] == g["id"]
                assert evt["user_id"] == str(joiner_uid)

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_guild_updated_broadcast(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            owner_token = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            g = tc.post("/guilds", json={"name": "old"}, headers=_auth(owner_token)).json()
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                ws.receive_json()  # ready
                r = tc.patch(
                    f"/guilds/{g['id']}",
                    json={"name": "new"},
                    headers=_auth(owner_token),
                )
                assert r.status_code == 200, r.text
                evt = _drain_until(ws, "guild_updated")
                assert evt["guild"]["id"] == g["id"]
                assert evt["guild"]["name"] == "new"
                assert evt["guild"]["owner_id"] == str(owner_uid)

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_guild_deleted_broadcast(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            owner_token = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            g = tc.post("/guilds", json={"name": "doomed"}, headers=_auth(owner_token)).json()
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                ws.receive_json()  # ready
                r = tc.delete(f"/guilds/{g['id']}", headers=_auth(owner_token))
                assert r.status_code == 204
                evt = _drain_until(ws, "guild_deleted")
                assert evt["op"] == "guild_deleted"
                assert evt["guild_id"] == g["id"]

    await asyncio.to_thread(_run)
