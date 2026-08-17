"""Reaction add/remove on guild + DM messages.

Regression for the bug where `_load_for_reaction` did a `session.get(Channel, ...)`
which returned `None` for DM messages (DM rows live in a separate table), so
DM reactions always 404'd. Fix is in routes/reactions.py — it now uses
`resolve_channel_or_raise` like messages.py.
"""

from __future__ import annotations

import random

import pytest


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer, uid: int | None = None) -> tuple[str, int]:
    uid = uid or random.randint(1, 1_000_000)
    token = _auth_signer.issue_access(uid, f"user{uid}")
    return token, uid


async def _make_guild_with_channel(client, _auth_signer):
    """Returns (owner_token, owner_uid, member_token, member_uid, channel_id)."""
    t1, uid1 = await _register_user(_auth_signer)
    t2, uid2 = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    await client.post(
        f"/guilds/{g['id']}/members", json={"user_id": uid2}, headers=auth(t1)
    )
    c = (await client.post(
        f"/guilds/{g['id']}/channels", json={"name": "general"}, headers=auth(t1)
    )).json()
    return t1, uid1, t2, uid2, c["id"]


async def _make_dm(client, _auth_signer, friend_pair):
    t_a, uid_a = await _register_user(_auth_signer)
    t_b, uid_b = await _register_user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm = (
        await client.post(
            "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
        )
    ).json()
    return t_a, uid_a, t_b, uid_b, dm["id"]


@pytest.mark.asyncio
async def test_guild_reaction_add_and_remove(client, _auth_signer):
    t1, _, t2, _, cid = await _make_guild_with_channel(client, _auth_signer)
    msg = (
        await client.post(
            f"/channels/{cid}/messages", json={"content": "hi"}, headers=auth(t1)
        )
    ).json()

    # Member adds + removes a reaction.
    r = await client.put(
        f"/messages/{msg['id']}/reactions/%F0%9F%91%8D/@me", headers=auth(t2)
    )
    assert r.status_code == 204, r.text
    r = await client.delete(
        f"/messages/{msg['id']}/reactions/%F0%9F%91%8D/@me", headers=auth(t2)
    )
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_dm_reaction_add_and_remove(client, _auth_signer, friend_pair, cloud_mode):
    """Regression: DM reactions used to always 404 because reactions.py
    looked up the channel in the guild ``Channel`` table only."""
    t_a, _, t_b, _, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    msg = (
        await client.post(
            f"/channels/{dm_id}/messages", json={"content": "dm hi"}, headers=auth(t_a)
        )
    ).json()

    # The other DM member can react.
    r = await client.put(
        f"/messages/{msg['id']}/reactions/%E2%9D%A4/@me", headers=auth(t_b)
    )
    assert r.status_code == 204, r.text
    r = await client.delete(
        f"/messages/{msg['id']}/reactions/%E2%9D%A4/@me", headers=auth(t_b)
    )
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_non_member_cannot_react_to_dm(client, _auth_signer, friend_pair, cloud_mode):
    """A third user (not in the DM) gets 404 — same status as listing the DM."""
    t_a, _, _, _, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    msg = (
        await client.post(
            f"/channels/{dm_id}/messages", json={"content": "private"}, headers=auth(t_a)
        )
    ).json()
    t_c, _ = await _register_user(_auth_signer)
    r = await client.put(
        f"/messages/{msg['id']}/reactions/%F0%9F%91%80/@me", headers=auth(t_c)
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_non_member_cannot_react_to_guild_message(client, _auth_signer):
    """Non-member of a guild gets 403 on the guild channel reaction route."""
    t1, _, _, _, cid = await _make_guild_with_channel(client, _auth_signer)
    msg = (
        await client.post(
            f"/channels/{cid}/messages", json={"content": "hi"}, headers=auth(t1)
        )
    ).json()
    t_other, _ = await _register_user(_auth_signer)
    r = await client.put(
        f"/messages/{msg['id']}/reactions/%F0%9F%91%8D/@me", headers=auth(t_other)
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_add_reaction_blocked_without_add_reactions(client, _auth_signer):
    """Member with ADD_REACTIONS denied via channel overwrite gets 403 on PUT.

    Remove-reaction stays unrestricted (users can always undo their own),
    so this test only pins the add side.
    """
    from dcc_shared.permission_resolver import OVERWRITE_TARGET_USER
    from dcc_shared.permissions import Permissions

    t1, _, t2, uid2, cid = await _make_guild_with_channel(client, _auth_signer)
    # t1 (owner) posts a message t2 will try to react to.
    msg = (
        await client.post(
            f"/channels/{cid}/messages", json={"content": "hi"}, headers=auth(t1)
        )
    ).json()
    # Owner denies ADD_REACTIONS for t2 in this channel.
    r = await client.put(
        f"/channels/{cid}/permissions/{OVERWRITE_TARGET_USER}/{uid2}",
        json={"allow": "0", "deny": str(int(Permissions.ADD_REACTIONS))},
        headers=auth(t1),
    )
    assert r.status_code == 200, r.text
    # t2 reaction add → 403.
    r = await client.put(
        f"/messages/{msg['id']}/reactions/%F0%9F%91%8D/@me", headers=auth(t2)
    )
    assert r.status_code == 403
    assert "ADD_REACTIONS" in r.json()["detail"]


@pytest.mark.asyncio
async def test_list_reactions_groups_by_emoji(client, _auth_signer):
    """``GET /messages/{id}/reactions`` returns ``[{emoji, user_ids}]``
    grouped by emoji, first-reactor first, regardless of the order the
    toggles arrived in. Mirrors the regular ``MessageOut.reactions``
    order so the popover matches the pill list.
    """
    t1, uid1, t2, uid2, cid = await _make_guild_with_channel(client, _auth_signer)
    msg = (
        await client.post(
            f"/channels/{cid}/messages", json={"content": "hi"}, headers=auth(t1)
        )
    ).json()
    # t2 reacts first with 👍, then t1 reacts with ❤️, then t2 adds 🎉.
    for token, emoji in [
        (t2, "%F0%9F%91%8D"),
        (t1, "%E2%9D%A4%EF%B8%8F"),  # ❤️ = U+2764 + U+FE0F (variation selector)
        (t2, "%F0%9F%8E%89"),
    ]:
        r = await client.put(
            f"/messages/{msg['id']}/reactions/{emoji}/@me", headers=auth(token)
        )
        assert r.status_code == 204, r.text

    r = await client.get(f"/messages/{msg['id']}/reactions", headers=auth(t1))
    assert r.status_code == 200, r.text
    payload = r.json()
    by_emoji = {entry["emoji"]: entry["user_ids"] for entry in payload}
    assert by_emoji["👍"] == [str(uid2)]  # t2 only
    assert by_emoji["❤️"] == [str(uid1)]  # t1 only
    assert by_emoji["🎉"] == [str(uid2)]  # t2 only
    # Response is sorted by emoji (alphabetical / codepoint).
    assert [e["emoji"] for e in payload] == sorted(by_emoji.keys())


@pytest.mark.asyncio
async def test_list_reactions_excludes_deleted_message(client, _auth_signer):
    """Deleted messages 404 on the list endpoint, same as on the
    single-message GET."""
    t1, _, _, _, cid = await _make_guild_with_channel(client, _auth_signer)
    msg = (
        await client.post(
            f"/channels/{cid}/messages", json={"content": "hi"}, headers=auth(t1)
        )
    ).json()
    r = await client.delete(
        f"/messages/{msg['id']}", headers=auth(t1)
    )
    assert r.status_code == 204
    r = await client.get(f"/messages/{msg['id']}/reactions", headers=auth(t1))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_non_member_cannot_list_reactions(client, _auth_signer):
    """Non-member of a guild gets 403 on the list endpoint (same gate
    as reacting). Mirrors ``test_non_member_cannot_react_to_guild_message``."""
    t1, _, _, _, cid = await _make_guild_with_channel(client, _auth_signer)
    msg = (
        await client.post(
            f"/channels/{cid}/messages", json={"content": "hi"}, headers=auth(t1)
        )
    ).json()
    t_other, _ = await _register_user(_auth_signer)
    r = await client.get(f"/messages/{msg['id']}/reactions", headers=auth(t_other))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_list_reactions_empty_message(client, _auth_signer):
    """A message with zero reactions returns an empty list (200, not 404)."""
    t1, _, _, _, cid = await _make_guild_with_channel(client, _auth_signer)
    msg = (
        await client.post(
            f"/channels/{cid}/messages", json={"content": "hi"}, headers=auth(t1)
        )
    ).json()
    r = await client.get(f"/messages/{msg['id']}/reactions", headers=auth(t1))
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_list_reactions_dm_visible_to_member(client, _auth_signer, friend_pair, cloud_mode):
    """DM participants can list reactions on a DM message — same gate
    as the existing add/remove routes."""
    t_a, _, t_b, _, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    msg = (
        await client.post(
            f"/channels/{dm_id}/messages", json={"content": "hi"}, headers=auth(t_a)
        )
    ).json()
    r = await client.put(
        f"/messages/{msg['id']}/reactions/%E2%9D%A4%EF%B8%8F/@me", headers=auth(t_b)
    )
    assert r.status_code == 204, r.text
    r = await client.get(f"/messages/{msg['id']}/reactions", headers=auth(t_a))
    assert r.status_code == 200, r.text
    payload = r.json()
    assert len(payload) == 1
    assert payload[0]["emoji"] == "❤️"


@pytest.mark.asyncio
async def test_list_reactions_denied_without_view_channel(client, _auth_signer):
    """Regression (Bughunt 2026-08-17 Nachtrag): ``GET .../reactions`` used
    to only check guild *membership*, not channel visibility — a member with
    VIEW_CHANNEL denied via a channel overwrite could still see who reacted
    to a message in a channel they can't otherwise see. Mirrors the
    READ_HISTORY gate on ``GET /channels/{id}/messages``."""
    from dcc_shared.permission_resolver import OVERWRITE_TARGET_USER
    from dcc_shared.permissions import Permissions

    t1, _, t2, uid2, cid = await _make_guild_with_channel(client, _auth_signer)
    msg = (
        await client.post(
            f"/channels/{cid}/messages", json={"content": "hi"}, headers=auth(t1)
        )
    ).json()
    r = await client.put(
        f"/messages/{msg['id']}/reactions/%F0%9F%91%8D/@me", headers=auth(t2)
    )
    assert r.status_code == 204, r.text

    # Owner denies VIEW_CHANNEL for t2 in this channel.
    r = await client.put(
        f"/channels/{cid}/permissions/{OVERWRITE_TARGET_USER}/{uid2}",
        json={"allow": "0", "deny": str(int(Permissions.VIEW_CHANNEL))},
        headers=auth(t1),
    )
    assert r.status_code == 200, r.text

    r = await client.get(f"/messages/{msg['id']}/reactions", headers=auth(t2))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_dm_reaction_add_blocked(client, _auth_signer, friend_pair, cloud_mode):
    """Regression: emoji reactions on DM messages used to skip the
    block-gate entirely — a blocked user could keep reacting visibly.
    Mirrors the block-gate on DM message sends
    (``routes/messages.py::post_message``)."""
    t_a, uid_a, t_b, _, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    msg = (
        await client.post(
            f"/channels/{dm_id}/messages", json={"content": "hi"}, headers=auth(t_a)
        )
    ).json()
    r = await client.post(
        "/blocks", json={"target_user_id": uid_a}, headers=auth(t_b)
    )
    assert r.status_code == 200, r.text

    # The blocked user (t_a) can no longer add a reaction to that DM.
    r = await client.put(
        f"/messages/{msg['id']}/reactions/%F0%9F%91%8D/@me", headers=auth(t_a)
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "blocked"

    # Nor can the blocker (t_b) — block gate applies either direction.
    r = await client.put(
        f"/messages/{msg['id']}/reactions/%E2%9D%A4/@me", headers=auth(t_b)
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "blocked"
