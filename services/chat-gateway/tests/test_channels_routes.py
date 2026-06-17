"""Channel route tests — focus on the bulk position reorder (drag-and-drop)."""

from __future__ import annotations

import random

import pytest


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _make_guild_with_member(client, _auth_signer):
    t_owner, _ = await _register_user(_auth_signer)
    t_other, uid_other = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_other)},
        headers=auth(t_owner),
    )
    return t_owner, t_other, uid_other, g


async def _make_channel(client, token, guild_id, name, type_):
    return (await client.post(
        f"/guilds/{guild_id}/channels",
        json={"name": name, "type": type_},
        headers=auth(token),
    )).json()


@pytest.mark.asyncio
async def test_channel_positions_happy_path(client, _auth_signer):
    """Owner reorders text + voice channels in one PATCH; the listing reflects
    the new positions. Text and voice share the position space but the client
    filters by type, so a voice channel may reuse a text channel's position."""
    t_owner, _, _, g = await _make_guild_with_member(client, _auth_signer)
    a = await _make_channel(client, t_owner, g["id"], "alpha", 0)
    b = await _make_channel(client, t_owner, g["id"], "beta", 0)
    v = await _make_channel(client, t_owner, g["id"], "voice", 1)

    r = await client.patch(
        f"/guilds/{g['id']}/channels-positions",
        json={
            "positions": [
                {"id": b["id"], "position": 0},
                {"id": a["id"], "position": 1},
                {"id": v["id"], "position": 0},
            ]
        },
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text

    chans = (
        await client.get(f"/guilds/{g['id']}/channels", headers=auth(t_owner))
    ).json()
    by_id = {c["id"]: c for c in chans}
    assert by_id[b["id"]]["position"] == 0
    assert by_id[a["id"]]["position"] == 1
    assert by_id[v["id"]]["position"] == 0


@pytest.mark.asyncio
async def test_channel_positions_requires_manage_channels(client, _auth_signer):
    """A plain member without MANAGE_CHANNELS cannot reorder."""
    t_owner, t_other, _, g = await _make_guild_with_member(client, _auth_signer)
    a = await _make_channel(client, t_owner, g["id"], "alpha", 0)
    r = await client.patch(
        f"/guilds/{g['id']}/channels-positions",
        json={"positions": [{"id": a["id"], "position": 3}]},
        headers=auth(t_other),
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_channel_positions_rejects_foreign_channel(client, _auth_signer):
    """A channel id that isn't in the target guild is rejected (400)."""
    t_owner, _, _, g = await _make_guild_with_member(client, _auth_signer)
    g2 = (
        await client.post("/guilds", json={"name": "g2"}, headers=auth(t_owner))
    ).json()
    foreign = await _make_channel(client, t_owner, g2["id"], "x", 0)
    r = await client.patch(
        f"/guilds/{g['id']}/channels-positions",
        json={"positions": [{"id": foreign["id"], "position": 1}]},
        headers=auth(t_owner),
    )
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_patch_channel_sets_name_gradient(client, _auth_signer):
    """Owner sets a two-color gradient + angle; it round-trips in the response."""
    t_owner, _, _, g = await _make_guild_with_member(client, _auth_signer)
    c = await _make_channel(client, t_owner, g["id"], "alpha", 0)
    r = await client.patch(
        f"/channels/{c['id']}",
        json={
            "name_color": "#ff8800",
            "name_color_secondary": "#3b82f6",
            "name_gradient_angle": 135,
        },
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name_color"] == "#ff8800"
    assert body["name_color_secondary"] == "#3b82f6"
    assert body["name_gradient_angle"] == 135


@pytest.mark.asyncio
async def test_patch_channel_clear_color_independent_of_name(client, _auth_signer):
    """Sending name_color=null clears it without requiring a name change; an
    omitted field is left untouched."""
    t_owner, _, _, g = await _make_guild_with_member(client, _auth_signer)
    c = await _make_channel(client, t_owner, g["id"], "alpha", 0)
    await client.patch(
        f"/channels/{c['id']}",
        json={"name_color": "#abcdef"},
        headers=auth(t_owner),
    )
    r = await client.patch(
        f"/channels/{c['id']}",
        json={"name_color": None},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    assert r.json()["name_color"] is None


@pytest.mark.asyncio
async def test_patch_channel_rejects_bad_hex(client, _auth_signer):
    """A non-hex color string is rejected (no CSS injection)."""
    t_owner, _, _, g = await _make_guild_with_member(client, _auth_signer)
    c = await _make_channel(client, t_owner, g["id"], "alpha", 0)
    r = await client.patch(
        f"/channels/{c['id']}",
        json={"name_color": "red; font-size:99px"},
        headers=auth(t_owner),
    )
    assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_patch_channel_rejects_out_of_range_angle(client, _auth_signer):
    """Gradient angle outside 0–360 is rejected."""
    t_owner, _, _, g = await _make_guild_with_member(client, _auth_signer)
    c = await _make_channel(client, t_owner, g["id"], "alpha", 0)
    r = await client.patch(
        f"/channels/{c['id']}",
        json={"name_gradient_angle": 999},
        headers=auth(t_owner),
    )
    assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_patch_channel_color_requires_manage_channels(client, _auth_signer):
    """A plain member without MANAGE_CHANNELS cannot restyle a channel."""
    t_owner, t_other, _, g = await _make_guild_with_member(client, _auth_signer)
    c = await _make_channel(client, t_owner, g["id"], "alpha", 0)
    r = await client.patch(
        f"/channels/{c['id']}",
        json={"name_color": "#abcdef"},
        headers=auth(t_other),
    )
    assert r.status_code == 403, r.text
