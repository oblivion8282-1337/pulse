"""Regression: DM @-mentions are scoped to the two channel participants.

Bug: ``filter_to_valid`` accepted *every* ``<@uid>`` marker in a DM channel
(``guild_id is None``) without checking the target is actually one of the two
DM participants. A crafted DM message ``<@victim_id>`` therefore fanned a
``mention_added`` WS event + push notification out to an arbitrary user who is
not a member of (and cannot even see) that DM channel.

Fix: in the DM path, restrict valid user-mention targets to the channel's two
participants. These tests pin both halves: a participant mention still pings,
a stranger mention is silently dropped.
"""

from __future__ import annotations

import random

import pytest

# DM routes are cloud-only — ensure cloud mode for all tests in this file.
pytestmark = pytest.mark.usefixtures("cloud_mode")


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer, uid: int | None = None) -> tuple[str, int]:
    uid = uid or random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


async def _make_dm(client, _auth_signer, friend_pair):
    t_a, uid_a = await _register_user(_auth_signer)
    t_b, uid_b = await _register_user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
    )
    return t_a, uid_a, t_b, uid_b, r.json()["id"]


@pytest.mark.asyncio
async def test_dm_mention_of_participant_persists(client, _auth_signer, friend_pair):
    """Mentioning the *other* DM participant is a valid ping and is kept."""
    t_a, _, _, uid_b, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    r = await client.post(
        f"/channels/{dm_id}/messages",
        json={"content": f"hey <@{uid_b}>"},
        headers=auth(t_a),
    )
    assert r.status_code == 201, r.text
    assert any(m["type"] == 0 and m["id"] == str(uid_b) for m in r.json()["mentions"])


@pytest.mark.asyncio
async def test_dm_mention_of_stranger_is_dropped(client, _auth_signer, friend_pair):
    """A ``<@stranger>`` who is not a DM participant must NOT become a mention
    target — otherwise an arbitrary user gets spurious mention events/pushes
    for a channel they cannot access."""
    t_a, _, _, _, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    stranger_uid = random.randint(900_000, 999_999)
    r = await client.post(
        f"/channels/{dm_id}/messages",
        json={"content": f"hi <@{stranger_uid}>"},
        headers=auth(t_a),
    )
    assert r.status_code == 201, r.text
    assert r.json()["mentions"] == []


@pytest.mark.asyncio
async def test_dm_mention_self_kept_but_stranger_dropped(
    client, _auth_signer, friend_pair
):
    """A message that mentions both a real participant and a stranger keeps
    only the participant marker."""
    t_a, uid_a, _, uid_b, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    stranger_uid = random.randint(900_000, 999_999)
    r = await client.post(
        f"/channels/{dm_id}/messages",
        json={"content": f"<@{uid_b}> meet <@{stranger_uid}>"},
        headers=auth(t_a),
    )
    assert r.status_code == 201, r.text
    ids = {m["id"] for m in r.json()["mentions"] if m["type"] == 0}
    assert ids == {str(uid_b)}
