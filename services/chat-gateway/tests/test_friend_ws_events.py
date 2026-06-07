"""WS-Event fan-out tests for the friends / blocks lifecycle (Etappe 2).

Each REST mutation in routes/friends.py + routes/blocks.py publishes
a direct-delivery envelope on the user:events channel. We exercise the
manager's publish_user_event by spying — the listener loop's actual
fan-out is already covered by the broader pubsub tests.

Pattern: stub manager.publish_user_event to capture (target_uid, env)
tuples, then assert per route that the right envelopes hit the right
user(s) in the right order.
"""

from __future__ import annotations

import random

import pytest

# Friend/block routes are cloud-only — ensure cloud mode for all tests here.
pytestmark = pytest.mark.usefixtures("cloud_mode")


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


@pytest.fixture
def captured_events(app, monkeypatch):
    """Patch manager.publish_user_event so REST routes don't actually
    publish — instead we capture (target_uid, envelope) tuples."""
    captured: list[tuple[str, dict]] = []
    mgr = app.state.connection_manager

    async def _cap(target_user_id, envelope):
        captured.append((str(target_user_id), dict(envelope)))

    monkeypatch.setattr(mgr, "publish_user_event", _cap)
    return captured


def _ops_for(captured, target_uid: int) -> list[str]:
    return [e["op"] for (tid, e) in captured if tid == str(target_uid)]


# ---- friend_request_received -----------------------------------------------


@pytest.mark.asyncio
async def test_send_request_emits_received_to_receiver(
    client, _auth_signer, captured_events
):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    r = await client.post(
        "/friend-requests",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r.status_code == 201
    # Receiver got friend_request_received; sender got nothing (they
    # know from the REST response).
    assert _ops_for(captured_events, uid_b) == ["friend_request_received"]
    assert _ops_for(captured_events, uid_a) == []
    env = next(e for (tid, e) in captured_events if tid == str(uid_b))
    assert env["data"]["sender_id"] == str(uid_a)


# ---- friend_request_accepted (both sides) ----------------------------------


@pytest.mark.asyncio
async def test_accept_emits_accepted_to_both(
    client, _auth_signer, captured_events
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    req = (
        await client.post(
            "/friend-requests",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()
    captured_events.clear()  # drop the received event
    r = await client.post(
        f"/friend-requests/{req['id']}/accept", headers=auth(t_b)
    )
    assert r.status_code == 200
    # Both sides receive accepted; counterparty user_id in payload.
    accepted_for_a = [
        e for (tid, e) in captured_events
        if tid == str(uid_a) and e["op"] == "friend_request_accepted"
    ]
    accepted_for_b = [
        e for (tid, e) in captured_events
        if tid == str(uid_b) and e["op"] == "friend_request_accepted"
    ]
    assert len(accepted_for_a) == 1
    assert len(accepted_for_b) == 1
    assert accepted_for_a[0]["data"]["friendship"]["user_id"] == str(uid_b)
    assert accepted_for_b[0]["data"]["friendship"]["user_id"] == str(uid_a)
    assert accepted_for_a[0]["data"]["request_id"] == req["id"]


# ---- auto-accept on reverse ------------------------------------------------


@pytest.mark.asyncio
async def test_auto_accept_emits_accepted_to_both(
    client, _auth_signer, captured_events
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    # B sends first
    await client.post(
        "/friend-requests",
        json={"target_user_id": str(uid_a)},
        headers=auth(t_b),
    )
    captured_events.clear()  # drop the received event
    # A sends back → auto-accept; both should receive accepted.
    r = await client.post(
        "/friend-requests",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r.status_code == 201
    assert r.json()["auto_accepted"] is True
    ops_a = _ops_for(captured_events, uid_a)
    ops_b = _ops_for(captured_events, uid_b)
    assert "friend_request_accepted" in ops_a
    assert "friend_request_accepted" in ops_b


# ---- decline / cancel ------------------------------------------------------


@pytest.mark.asyncio
async def test_decline_emits_to_sender_only(
    client, _auth_signer, captured_events
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    req = (
        await client.post(
            "/friend-requests",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()
    captured_events.clear()
    r = await client.post(
        f"/friend-requests/{req['id']}/decline", headers=auth(t_b)
    )
    assert r.status_code == 204
    # Sender gets declined; receiver (caller) gets nothing.
    assert _ops_for(captured_events, uid_a) == ["friend_request_declined"]
    assert _ops_for(captured_events, uid_b) == []


@pytest.mark.asyncio
async def test_cancel_emits_to_receiver_only(
    client, _auth_signer, captured_events
):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    req = (
        await client.post(
            "/friend-requests",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()
    captured_events.clear()
    r = await client.delete(
        f"/friend-requests/{req['id']}", headers=auth(t_a)
    )
    assert r.status_code == 204
    assert _ops_for(captured_events, uid_b) == ["friend_request_cancelled"]
    assert _ops_for(captured_events, uid_a) == []


# ---- friend_removed --------------------------------------------------------


@pytest.mark.asyncio
async def test_unfriend_emits_friend_removed_to_other(
    client, _auth_signer, captured_events
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    req = (
        await client.post(
            "/friend-requests",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()
    await client.post(f"/friend-requests/{req['id']}/accept", headers=auth(t_b))
    captured_events.clear()
    r = await client.delete(f"/friends/{uid_b}", headers=auth(t_a))
    assert r.status_code == 204
    assert _ops_for(captured_events, uid_b) == ["friend_removed"]
    assert _ops_for(captured_events, uid_a) == []


# ---- user_blocked / user_unblocked / block-with-friendship ----------------


@pytest.mark.asyncio
async def test_block_emits_user_blocked_to_blocker_only(
    client, _auth_signer, captured_events
):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    r = await client.post(
        "/blocks",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r.status_code == 200
    # Blocker gets user_blocked; blocked party gets NOTHING (no leak).
    assert _ops_for(captured_events, uid_a) == ["user_blocked"]
    assert _ops_for(captured_events, uid_b) == []


@pytest.mark.asyncio
async def test_block_after_friend_also_emits_friend_removed_to_other(
    client, _auth_signer, captured_events
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    req = (
        await client.post(
            "/friend-requests",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()
    await client.post(f"/friend-requests/{req['id']}/accept", headers=auth(t_b))
    captured_events.clear()
    await client.post(
        "/blocks",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    # The blocker (A) gets user_blocked; the blocked (B) gets friend_removed
    # (not user_blocked — no leak).
    assert _ops_for(captured_events, uid_a) == ["user_blocked"]
    assert _ops_for(captured_events, uid_b) == ["friend_removed"]


@pytest.mark.asyncio
async def test_unblock_emits_user_unblocked_to_unblocker_only(
    client, _auth_signer, captured_events
):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await client.post(
        "/blocks",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    captured_events.clear()
    r = await client.delete(f"/blocks/{uid_b}", headers=auth(t_a))
    assert r.status_code == 204
    assert _ops_for(captured_events, uid_a) == ["user_unblocked"]
    assert _ops_for(captured_events, uid_b) == []
