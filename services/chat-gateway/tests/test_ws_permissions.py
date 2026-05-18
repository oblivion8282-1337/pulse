"""WebSocket coverage for the permission layer wired up in Phase 3:

* ``ready`` now carries the user's role list + resolved guild-level
  permissions per guild.
* role mutations broadcast on guild:events and reach every connected
  client (with the per-socket permission cache invalidated).
* Channel-broadcast filter: a member without ``VIEW_CHANNEL`` on a
  channel does not receive its messages, voice_state, or stream_state
  events — the load-bearing security invariant for private channels.

Tests live in their own file so the file stays under the §12.1 line cap
and grouped by feature rather than by surface."""

from __future__ import annotations

import asyncio
import json
import random
from contextlib import contextmanager

import pytest
from starlette.testclient import TestClient

from dcc_shared.permission_resolver import (
    OVERWRITE_TARGET_ROLE,
    OVERWRITE_TARGET_USER,
)
from dcc_shared.permissions import DEFAULT_EVERYONE_PERMISSIONS, Permissions


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _drain_until(ws, op: str, *, limit: int = 12) -> dict:
    for _ in range(limit):
        msg = ws.receive_json()
        if msg.get("op") == op:
            return msg
    raise AssertionError(f"never received {op}")


def _ready_payload(tc, token: str):
    with tc.websocket_connect(f"/ws?token={token}") as ws:
        return ws.receive_json()


@contextmanager
def _client(ws_app):
    """Run TestClient in its lifespan; yield it so each test starts with
    a clean ConnectionManager subscription set."""
    with TestClient(ws_app) as tc:
        yield tc


# ---- ready-Frame shape ----------------------------------------------------


@pytest.mark.asyncio
async def test_ready_contains_role_list_and_my_permissions(ws_app, _auth_signer):
    def _run():
        with _client(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            token = _auth_signer.issue_access(uid, f"o{uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(token)).json()
            ready = _ready_payload(tc, token)
            assert ready["op"] == "ready"
            assert len(ready["guilds"]) == 1
            guild = ready["guilds"][0]
            assert guild["id"] == g["id"]
            assert guild["owner_id"] == str(uid)
            # GRANT_ALL_SAFE = (1<<52) - 1, owner short-circuit.
            assert int(guild["my_permissions"]) == (1 << 52) - 1
            assert guild["my_role_ids"] == []
            # Auto-created @everyone present, with default-everyone perms.
            assert len(guild["roles"]) == 1
            everyone = guild["roles"][0]
            assert everyone["is_everyone"] is True
            assert int(everyone["permissions"]) == DEFAULT_EVERYONE_PERMISSIONS

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ready_member_my_permissions_equals_everyone_default(
    ws_app, _auth_signer
):
    def _run():
        with _client(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            other_uid = random.randint(1, 1_000_000)
            owner_t = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            other_t = _auth_signer.issue_access(other_uid, f"o{other_uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_t)).json()
            tc.post(
                f"/guilds/{g['id']}/members",
                json={"user_id": str(other_uid)},
                headers=_auth(owner_t),
            )
            ready = _ready_payload(tc, other_t)
            guild = ready["guilds"][0]
            assert int(guild["my_permissions"]) == DEFAULT_EVERYONE_PERMISSIONS

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ready_my_role_ids_lists_assigned(ws_app, _auth_signer):
    def _run():
        with _client(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            other_uid = random.randint(1, 1_000_000)
            owner_t = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            other_t = _auth_signer.issue_access(other_uid, f"o{other_uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_t)).json()
            tc.post(
                f"/guilds/{g['id']}/members",
                json={"user_id": str(other_uid)},
                headers=_auth(owner_t),
            )
            mod = tc.post(
                f"/guilds/{g['id']}/roles",
                json={"name": "Mod", "permissions": str(int(Permissions.MANAGE_MESSAGES))},
                headers=_auth(owner_t),
            ).json()
            tc.put(
                f"/guilds/{g['id']}/members/{other_uid}/roles/{mod['id']}",
                headers=_auth(owner_t),
            )
            ready = _ready_payload(tc, other_t)
            assert ready["guilds"][0]["my_role_ids"] == [mod["id"]]

    await asyncio.to_thread(_run)


# ---- role event broadcasts -------------------------------------------------


@pytest.mark.asyncio
async def test_role_created_broadcasts_to_open_sockets(ws_app, _auth_signer):
    def _run():
        with _client(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            token = _auth_signer.issue_access(uid, f"o{uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(token)).json()
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                ws.receive_json()  # ready
                created = tc.post(
                    f"/guilds/{g['id']}/roles",
                    json={"name": "Mod", "permissions": str(int(Permissions.MANAGE_MESSAGES))},
                    headers=_auth(token),
                ).json()
                evt = _drain_until(ws, "role_created")
                assert evt["role"]["id"] == created["id"]
                assert evt["role"]["name"] == "Mod"
                assert int(evt["role"]["permissions"]) == int(Permissions.MANAGE_MESSAGES)

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_member_roles_updated_broadcasts(ws_app, _auth_signer):
    def _run():
        with _client(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            other_uid = random.randint(1, 1_000_000)
            owner_t = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_t)).json()
            tc.post(
                f"/guilds/{g['id']}/members",
                json={"user_id": str(other_uid)},
                headers=_auth(owner_t),
            )
            role = tc.post(
                f"/guilds/{g['id']}/roles",
                json={"name": "Mod", "permissions": "0"},
                headers=_auth(owner_t),
            ).json()
            with tc.websocket_connect(f"/ws?token={owner_t}") as ws:
                ws.receive_json()
                tc.put(
                    f"/guilds/{g['id']}/members/{other_uid}/roles/{role['id']}",
                    headers=_auth(owner_t),
                )
                evt = _drain_until(ws, "member_roles_updated")
                assert evt["guild_id"] == g["id"]
                assert evt["user_id"] == str(other_uid)

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_channel_permissions_updated_broadcasts(ws_app, _auth_signer):
    def _run():
        with _client(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            token = _auth_signer.issue_access(uid, f"o{uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(token)).json()
            c = tc.post(
                f"/guilds/{g['id']}/channels",
                json={"name": "general"},
                headers=_auth(token),
            ).json()
            roles = tc.get(f"/guilds/{g['id']}/roles", headers=_auth(token)).json()
            everyone_id = next(r["id"] for r in roles if r["is_everyone"])
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                ws.receive_json()
                tc.put(
                    f"/channels/{c['id']}/permissions/{OVERWRITE_TARGET_ROLE}/{everyone_id}",
                    json={"allow": "0", "deny": str(int(Permissions.SEND_MESSAGES))},
                    headers=_auth(token),
                )
                evt = _drain_until(ws, "channel_permissions_updated")
                assert evt["channel_id"] == c["id"]
                assert any(
                    int(ow["deny"]) & int(Permissions.SEND_MESSAGES)
                    for ow in evt["overwrites"]
                )

    await asyncio.to_thread(_run)


# ---- channel-visibility filter --------------------------------------------


@pytest.mark.asyncio
async def test_private_channel_blocks_member_from_message_broadcast(
    ws_app, _auth_signer
):
    """Owner posts a message in a channel where @everyone has been
    deny-VIEW'd. A regular member subscribed before the deny no longer
    receives the message — the filter drops them at fan-out time."""
    def _run():
        with _client(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            other_uid = random.randint(1, 1_000_000)
            owner_t = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            other_t = _auth_signer.issue_access(other_uid, f"o{other_uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_t)).json()
            c = tc.post(
                f"/guilds/{g['id']}/channels",
                json={"name": "general"},
                headers=_auth(owner_t),
            ).json()
            tc.post(
                f"/guilds/{g['id']}/members",
                json={"user_id": str(other_uid)},
                headers=_auth(owner_t),
            )
            everyone_id = next(
                r["id"]
                for r in tc.get(
                    f"/guilds/{g['id']}/roles", headers=_auth(owner_t)
                ).json()
                if r["is_everyone"]
            )
            with tc.websocket_connect(f"/ws?token={other_t}") as other_ws:
                other_ws.receive_json()
                other_ws.send_text(
                    json.dumps({"op": "subscribe", "channel_id": c["id"]})
                )
                # Drain any incidental events the subscribe might produce.
                # Now: revoke VIEW on @everyone via owner.
                tc.put(
                    f"/channels/{c['id']}/permissions/{OVERWRITE_TARGET_ROLE}/{everyone_id}",
                    json={
                        "allow": "0",
                        "deny": str(int(Permissions.VIEW_CHANNEL)),
                    },
                    headers=_auth(owner_t),
                )
                # The channel_permissions_updated invalidates the cache.
                _drain_until(other_ws, "channel_permissions_updated")
                # Owner posts via REST → the member should NOT get it.
                tc.post(
                    f"/channels/{c['id']}/messages",
                    json={"content": "secret"},
                    headers=_auth(owner_t),
                )
                # Give the listener a moment, then expect no message frame.
                import time
                time.sleep(0.3)
                received_ops: list[str] = []
                # Pull anything that arrived (non-blocking via short
                # receive_text + json.loads loop). receive_json blocks, so
                # we use a poll with a timeout fall-through via send_text-
                # ping pattern.
                # Easier: just verify the next op is a channel_bump (always
                # broadcast to every connection) OR nothing — definitely
                # NOT a 'message' op for this private channel.
                for _ in range(4):
                    msg = other_ws.receive_json()
                    received_ops.append(msg.get("op"))
                    if msg.get("op") == "channel_bump":
                        # channel_bump goes to every guild member via
                        # guild:events (not gated by VIEW_CHANNEL). The
                        # message itself though must NOT have arrived.
                        break
                assert "message" not in received_ops, received_ops

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_role_grants_view_back_unlocks_broadcast(ws_app, _auth_signer):
    """Inverse of the private-channel test: grant VIEW back via a role
    overwrite, and the same member starts receiving messages again."""
    def _run():
        with _client(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            other_uid = random.randint(1, 1_000_000)
            owner_t = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            other_t = _auth_signer.issue_access(other_uid, f"o{other_uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_t)).json()
            c = tc.post(
                f"/guilds/{g['id']}/channels",
                json={"name": "general"},
                headers=_auth(owner_t),
            ).json()
            tc.post(
                f"/guilds/{g['id']}/members",
                json={"user_id": str(other_uid)},
                headers=_auth(owner_t),
            )
            everyone_id = next(
                r["id"]
                for r in tc.get(
                    f"/guilds/{g['id']}/roles", headers=_auth(owner_t)
                ).json()
                if r["is_everyone"]
            )
            # Deny VIEW on @everyone, then give "other_uid" a user-level
            # ALLOW VIEW overwrite.
            tc.put(
                f"/channels/{c['id']}/permissions/{OVERWRITE_TARGET_ROLE}/{everyone_id}",
                json={"allow": "0", "deny": str(int(Permissions.VIEW_CHANNEL))},
                headers=_auth(owner_t),
            )
            tc.put(
                f"/channels/{c['id']}/permissions/{OVERWRITE_TARGET_USER}/{other_uid}",
                json={
                    "allow": str(
                        int(Permissions.VIEW_CHANNEL | Permissions.READ_HISTORY)
                    ),
                    "deny": "0",
                },
                headers=_auth(owner_t),
            )
            with tc.websocket_connect(f"/ws?token={other_t}") as other_ws:
                other_ws.receive_json()
                other_ws.send_text(
                    json.dumps({"op": "subscribe", "channel_id": c["id"]})
                )
                tc.post(
                    f"/channels/{c['id']}/messages",
                    json={"content": "hi"},
                    headers=_auth(owner_t),
                )
                evt = _drain_until(other_ws, "message")
                assert evt["data"]["content"] == "hi"

    await asyncio.to_thread(_run)


# ---- subscribe / send permission gates ------------------------------------


@pytest.mark.asyncio
async def test_subscribe_blocked_without_view_channel(ws_app, _auth_signer):
    """A guild member with deny-VIEW_CHANNEL on a channel must get an explicit
    error frame on ``subscribe`` rather than a silent success that produces an
    invisible-channel UX."""
    def _run():
        with _client(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            other_uid = random.randint(1, 1_000_000)
            owner_t = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            other_t = _auth_signer.issue_access(other_uid, f"o{other_uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_t)).json()
            c = tc.post(
                f"/guilds/{g['id']}/channels",
                json={"name": "secret"},
                headers=_auth(owner_t),
            ).json()
            tc.post(
                f"/guilds/{g['id']}/members",
                json={"user_id": str(other_uid)},
                headers=_auth(owner_t),
            )
            everyone_id = next(
                r["id"]
                for r in tc.get(
                    f"/guilds/{g['id']}/roles", headers=_auth(owner_t)
                ).json()
                if r["is_everyone"]
            )
            tc.put(
                f"/channels/{c['id']}/permissions/{OVERWRITE_TARGET_ROLE}/{everyone_id}",
                json={"allow": "0", "deny": str(int(Permissions.VIEW_CHANNEL))},
                headers=_auth(owner_t),
            )
            with tc.websocket_connect(f"/ws?token={other_t}") as ws:
                ws.receive_json()  # ready
                ws.send_text(
                    json.dumps({"op": "subscribe", "channel_id": c["id"]})
                )
                err = _drain_until(ws, "error")
                assert err["code"] == 4012

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_send_blocked_without_send_messages(ws_app, _auth_signer):
    """Member retains VIEW_CHANNEL (so subscribe works + messages still flow
    to them) but has SEND_MESSAGES denied — ``send`` op must return an error
    frame instead of persisting the message."""
    def _run():
        with _client(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            other_uid = random.randint(1, 1_000_000)
            owner_t = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            other_t = _auth_signer.issue_access(other_uid, f"o{other_uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_t)).json()
            c = tc.post(
                f"/guilds/{g['id']}/channels",
                json={"name": "readonly"},
                headers=_auth(owner_t),
            ).json()
            tc.post(
                f"/guilds/{g['id']}/members",
                json={"user_id": str(other_uid)},
                headers=_auth(owner_t),
            )
            everyone_id = next(
                r["id"]
                for r in tc.get(
                    f"/guilds/{g['id']}/roles", headers=_auth(owner_t)
                ).json()
                if r["is_everyone"]
            )
            # Deny SEND_MESSAGES; VIEW_CHANNEL stays allowed.
            tc.put(
                f"/channels/{c['id']}/permissions/{OVERWRITE_TARGET_ROLE}/{everyone_id}",
                json={"allow": "0", "deny": str(int(Permissions.SEND_MESSAGES))},
                headers=_auth(owner_t),
            )
            with tc.websocket_connect(f"/ws?token={other_t}") as ws:
                ws.receive_json()  # ready
                ws.send_text(
                    json.dumps({"op": "subscribe", "channel_id": c["id"]})
                )
                ws.send_text(
                    json.dumps(
                        {"op": "send", "channel_id": c["id"], "content": "hi"}
                    )
                )
                err = _drain_until(ws, "error")
                assert err["code"] == 4013

    await asyncio.to_thread(_run)
