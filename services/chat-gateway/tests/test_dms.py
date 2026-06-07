"""REST-level tests for the 1:1 DM channel endpoints."""

from __future__ import annotations

import pytest

# DM routes are cloud-only — ensure cloud mode for all tests in this file.
pytestmark = pytest.mark.usefixtures("cloud_mode")


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer, uid: int | None = None) -> tuple[str, int]:
    import random

    uid = uid or random.randint(1, 1_000_000)
    token = _auth_signer.issue_access(uid, f"user{uid}")
    return token, uid


@pytest.mark.asyncio
async def test_create_dm_channel_returns_201(client, _auth_signer, friend_pair):
    t_a, uid_a = await _register_user(_auth_signer)
    _, uid_b = await _register_user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/dm-channels",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r.status_code == 201
    body = r.json()
    assert isinstance(body["id"], str)  # snowflake → string over the wire
    assert body["other_user_id"] == str(uid_b)
    assert body["last_message_id"] is None
    assert body["can_send"] is True


@pytest.mark.asyncio
async def test_create_dm_channel_idempotent(client, _auth_signer, friend_pair):
    """Same (a, b) returns the existing channel; same id; status 201 still."""
    t_a, uid_a = await _register_user(_auth_signer)
    _, uid_b = await _register_user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r1 = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
    )
    r2 = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
    )
    assert r1.status_code == 201
    assert r2.status_code == 201
    assert r1.json()["id"] == r2.json()["id"]


@pytest.mark.asyncio
async def test_dm_channel_sorted_pair_invariant(client, _auth_signer, friend_pair):
    """A→B and B→A must resolve to the same channel id."""
    t_a, uid_a = await _register_user(_auth_signer)
    t_b, uid_b = await _register_user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    ra = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
    )
    rb = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_a)}, headers=auth(t_b)
    )
    assert ra.status_code == 201
    assert rb.status_code == 201
    assert ra.json()["id"] == rb.json()["id"]
    # other_user_id is computed from each caller's perspective.
    assert ra.json()["other_user_id"] == str(uid_b)
    assert rb.json()["other_user_id"] == str(uid_a)


@pytest.mark.asyncio
async def test_create_dm_channel_self_rejected(client, _auth_signer):
    t, uid = await _register_user(_auth_signer)
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(uid)}, headers=auth(t)
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_create_dm_channel_requires_auth(client, _auth_signer):
    _, uid_b = await _register_user(_auth_signer)
    r = await client.post("/dm-channels", json={"target_user_id": str(uid_b)})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_list_dm_channels_only_includes_caller(
    client, _auth_signer, friend_pair
):
    t_a, uid_a = await _register_user(_auth_signer)
    t_b, uid_b = await _register_user(_auth_signer)
    t_c, uid_c = await _register_user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await friend_pair(uid_b, uid_c)
    # A↔B
    await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
    )
    # B↔C (caller A is NOT a member of this one)
    await client.post(
        "/dm-channels", json={"target_user_id": str(uid_c)}, headers=auth(t_b)
    )
    r = await client.get("/dm-channels", headers=auth(t_a))
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert body[0]["other_user_id"] == str(uid_b)


@pytest.mark.asyncio
async def test_get_dm_channel_as_member(client, _auth_signer, friend_pair):
    t_a, uid_a = await _register_user(_auth_signer)
    _, uid_b = await _register_user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
    )
    dm_id = r.json()["id"]
    r2 = await client.get(f"/dm-channels/{dm_id}", headers=auth(t_a))
    assert r2.status_code == 200
    assert r2.json()["id"] == dm_id


@pytest.mark.asyncio
async def test_get_dm_channel_non_member_404(client, _auth_signer, friend_pair):
    """Non-members get 404 (not 403) to avoid leaking channel existence."""
    t_a, uid_a = await _register_user(_auth_signer)
    _, uid_b = await _register_user(_auth_signer)
    t_c, _ = await _register_user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
    )
    dm_id = r.json()["id"]
    r2 = await client.get(f"/dm-channels/{dm_id}", headers=auth(t_c))
    assert r2.status_code == 404


@pytest.mark.asyncio
async def test_get_dm_channel_not_found(client, _auth_signer):
    t, _ = await _register_user(_auth_signer)
    r = await client.get("/dm-channels/999999999", headers=auth(t))
    assert r.status_code == 404


# ---- Messages on DM channels ------------------------------------------------
# DM messages reuse the polymorphic /channels/{id}/messages endpoint. These
# tests pin the polymorphism: same routes, same wire shape, separate access
# rules (DM membership instead of guild membership).


async def _make_dm(client, _auth_signer, friend_pair):
    t_a, uid_a = await _register_user(_auth_signer)
    t_b, uid_b = await _register_user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
    )
    return t_a, uid_a, t_b, uid_b, r.json()["id"]


@pytest.mark.asyncio
async def test_dm_post_and_list_messages(client, _auth_signer, friend_pair):
    t_a, _, t_b, _, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    r = await client.post(
        f"/channels/{dm_id}/messages",
        json={"content": "hallo b"},
        headers=auth(t_a),
    )
    assert r.status_code == 201
    posted = r.json()
    assert posted["channel_id"] == dm_id
    assert posted["content"] == "hallo b"

    # Both members can list.
    for token in (t_a, t_b):
        r = await client.get(f"/channels/{dm_id}/messages", headers=auth(token))
        assert r.status_code == 200
        body = r.json()
        assert len(body) == 1
        assert body[0]["content"] == "hallo b"


@pytest.mark.asyncio
async def test_dm_non_member_cannot_post_or_list(client, _auth_signer, friend_pair):
    """Non-member gets 404 (not 403) on a DM channel — see resolve_channel_or_raise."""
    _, _, _, _, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    t_c, _ = await _register_user(_auth_signer)
    rp = await client.post(
        f"/channels/{dm_id}/messages",
        json={"content": "snoop"},
        headers=auth(t_c),
    )
    assert rp.status_code == 404
    rl = await client.get(f"/channels/{dm_id}/messages", headers=auth(t_c))
    assert rl.status_code == 404


@pytest.mark.asyncio
async def test_dm_post_message_bumps_last_message_id(client, _auth_signer, friend_pair):
    """The DM list sorts by last_message_id; posting a message must bump it."""
    t_a, _, _, uid_b, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    # Before: last_message_id is null in the list.
    r0 = await client.get("/dm-channels", headers=auth(t_a))
    assert r0.json()[0]["last_message_id"] is None
    # Post a message.
    r1 = await client.post(
        f"/channels/{dm_id}/messages",
        json={"content": "first"},
        headers=auth(t_a),
    )
    posted_id = r1.json()["id"]
    # After: last_message_id matches.
    r2 = await client.get("/dm-channels", headers=auth(t_a))
    assert r2.json()[0]["last_message_id"] == posted_id


@pytest.mark.asyncio
async def test_dm_edit_message_author_only(client, _auth_signer, friend_pair):
    t_a, _, t_b, _, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    r = await client.post(
        f"/channels/{dm_id}/messages",
        json={"content": "v1"},
        headers=auth(t_a),
    )
    msg_id = r.json()["id"]
    # Author edits — ok.
    r1 = await client.patch(
        f"/messages/{msg_id}", json={"content": "v2"}, headers=auth(t_a)
    )
    assert r1.status_code == 200
    assert r1.json()["content"] == "v2"
    # Other DM member tries to edit — 403.
    r2 = await client.patch(
        f"/messages/{msg_id}", json={"content": "hacked"}, headers=auth(t_b)
    )
    assert r2.status_code == 403


@pytest.mark.asyncio
async def test_dm_delete_message_no_owner_override(client, _auth_signer, friend_pair):
    """In a DM there is no guild owner — only the author may delete."""
    t_a, _, t_b, _, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    r = await client.post(
        f"/channels/{dm_id}/messages",
        json={"content": "to be deleted"},
        headers=auth(t_a),
    )
    msg_id = r.json()["id"]
    # Other DM member tries to delete — 403 (no owner-override exists).
    r1 = await client.delete(f"/messages/{msg_id}", headers=auth(t_b))
    assert r1.status_code == 403
    # Author deletes — 204.
    r2 = await client.delete(f"/messages/{msg_id}", headers=auth(t_a))
    assert r2.status_code == 204


@pytest.mark.asyncio
async def test_dm_reply_target_must_be_in_same_channel(client, _auth_signer, friend_pair):
    """Reply-to validation works for DMs the same way as guild channels."""
    t_a, _, _, _, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    r1 = await client.post(
        f"/channels/{dm_id}/messages",
        json={"content": "parent"},
        headers=auth(t_a),
    )
    parent_id = r1.json()["id"]
    r2 = await client.post(
        f"/channels/{dm_id}/messages",
        json={"content": "reply", "reply_to_id": parent_id},
        headers=auth(t_a),
    )
    assert r2.status_code == 201
    assert r2.json()["reply_to_id"] == parent_id
