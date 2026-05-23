"""Etappe-2 block filter on the cross-channel mention fan-out.

Scenario:
* B blocks A.
* A posts a guild-channel message mentioning B.
* The channel-scoped ``message`` envelope must still go out (no per-user
  channel hide).
* The per-user ``mention_added`` envelope (cross-channel counter bump)
  must NOT reach B.

We spy on ``manager.publish_user_event`` to assert the absence of a
mention_added for the blocked party. The channel broadcast goes through
``manager.publish`` so the two paths are independent — testing one
doesn't affect the other.
"""

from __future__ import annotations

import random

import pytest


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


@pytest.mark.asyncio
async def test_mention_added_skipped_when_receiver_blocks_sender(
    client, app, _auth_signer, monkeypatch
):
    captured: list[tuple[str, dict]] = []
    mgr = app.state.connection_manager

    async def _cap(target_user_id, envelope):
        captured.append((str(target_user_id), dict(envelope)))

    monkeypatch.setattr(mgr, "publish_user_event", _cap)

    # A is the owner; B is a member; both are in the same guild + channel.
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_a))).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_b)},
        headers=auth(t_a),
    )
    c = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general"},
            headers=auth(t_a),
        )
    ).json()

    # B blocks A.
    rb = await client.post(
        "/blocks", json={"target_user_id": str(uid_a)}, headers=auth(t_b)
    )
    assert rb.status_code == 200
    captured.clear()  # drop the user_blocked envelope from above

    # A posts a message mentioning B.
    r = await client.post(
        f"/channels/{c['id']}/messages",
        json={"content": f"yo <@{uid_b}>"},
        headers=auth(t_a),
    )
    assert r.status_code == 201, r.text

    # B (target_uid) must NOT have received a mention_added envelope.
    for tid, env in captured:
        assert not (
            tid == str(uid_b) and env.get("op") == "mention_added"
        ), f"unexpected mention_added for blocked receiver: {env}"


@pytest.mark.asyncio
async def test_mention_added_skipped_when_sender_blocked_receiver(
    client, app, _auth_signer, monkeypatch
):
    """Block in either direction must filter — A blocks B; A mentions B
    (technically nonsense, but the route should still gate cleanly)."""
    captured: list[tuple[str, dict]] = []
    mgr = app.state.connection_manager

    async def _cap(target_user_id, envelope):
        captured.append((str(target_user_id), dict(envelope)))

    monkeypatch.setattr(mgr, "publish_user_event", _cap)

    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_a))).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_b)},
        headers=auth(t_a),
    )
    c = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general"},
            headers=auth(t_a),
        )
    ).json()
    await client.post(
        "/blocks", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
    )
    captured.clear()
    r = await client.post(
        f"/channels/{c['id']}/messages",
        json={"content": f"yo <@{uid_b}>"},
        headers=auth(t_a),
    )
    assert r.status_code == 201
    for tid, env in captured:
        assert not (
            tid == str(uid_b) and env.get("op") == "mention_added"
        )


@pytest.mark.asyncio
async def test_mention_added_still_fires_for_unblocked_third_party(
    client, app, _auth_signer, monkeypatch
):
    """Block between A and B must not affect a mention to C in the same
    message — the filter is per-target, not per-message."""
    captured: list[tuple[str, dict]] = []
    mgr = app.state.connection_manager

    async def _cap(target_user_id, envelope):
        captured.append((str(target_user_id), dict(envelope)))

    monkeypatch.setattr(mgr, "publish_user_event", _cap)

    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    t_c, uid_c = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_a))).json()
    for uid in (uid_b, uid_c):
        await client.post(
            f"/guilds/{g['id']}/members",
            json={"user_id": str(uid)},
            headers=auth(t_a),
        )
    c = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general"},
            headers=auth(t_a),
        )
    ).json()
    # B blocks A.
    await client.post(
        "/blocks", json={"target_user_id": str(uid_a)}, headers=auth(t_b)
    )
    captured.clear()
    # A mentions both B and C in the same message.
    r = await client.post(
        f"/channels/{c['id']}/messages",
        json={"content": f"yo <@{uid_b}> and <@{uid_c}>"},
        headers=auth(t_a),
    )
    assert r.status_code == 201
    mention_targets = {
        tid for (tid, env) in captured if env.get("op") == "mention_added"
    }
    assert str(uid_c) in mention_targets
    assert str(uid_b) not in mention_targets
