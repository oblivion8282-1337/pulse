"""Zwei-Ebenen-Limits: Betreiber-Obergrenze klemmt den Wert der Community.

    Betreiber-Obergrenze   ──klemmt──▶   Wert der Community   ──▶  wirksam

Deckt die reine Klemm-Logik (``guild_limits``) und beide Endpoints ab:
``PATCH /guilds/{id}/limits`` (MANAGE_GUILD, Community-Wert) und
``PATCH /owner/communities/{id}/limits`` (Betreiber-Obergrenze), plus dass der
wirksame Wert im ``GuildOut`` ankommt.
"""

from __future__ import annotations

import uuid

import pytest

from dcc_chat_gateway import guild_limits as gl
from dcc_chat_gateway.models import Guild

pytestmark = pytest.mark.usefixtures("cloud_mode")


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _owned_guild(session_factory, _auth_signer) -> tuple[str, int, int]:
    """Eine Guild plus Access-Token ihres Owners (hat MANAGE_GUILD qua Owner)."""
    from dcc_chat_gateway.models import GuildMember
    from dcc_chat_gateway.snowflake import next_id

    uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    gid = next_id()
    async with session_factory() as s:
        s.add(Guild(id=gid, name="Limitierte", owner_id=uid))
        s.add(GuildMember(guild_id=gid, user_id=uid))
        await s.commit()
    return _auth_signer.issue_access(uid, f"u{uid}"), uid, gid


# ─── Reine Klemm-Logik ──────────────────────────────────────────────────────


def test_clamp_pulls_value_down_to_ceiling():
    g = Guild(id=1, name="g", owner_id=1)
    g.voice_bitrate_max_kbps = 128  # Obergrenze
    g.community_voice_bitrate_kbps = 256  # Wunsch der Community, zu hoch
    clamped = gl.clamp_to_ceilings(g)
    assert "voice_bitrate_kbps" in clamped
    assert g.community_voice_bitrate_kbps == 128


def test_clamp_leaves_value_below_ceiling_untouched():
    g = Guild(id=1, name="g", owner_id=1)
    g.voice_bitrate_max_kbps = 128
    g.community_voice_bitrate_kbps = 96
    assert gl.clamp_to_ceilings(g) == []
    assert g.community_voice_bitrate_kbps == 96


def test_resolution_clamps_on_the_ladder_not_by_string():
    g = Guild(id=1, name="g", owner_id=1)
    g.stream_resolution_max = "1080p"  # Obergrenze
    g.community_stream_resolution = "4K"  # höher auf der Leiter
    clamped = gl.clamp_to_ceilings(g)
    assert "stream_resolution" in clamped
    assert g.community_stream_resolution == "1080p"


def test_ceiling_zero_is_a_real_limit_not_unlimited():
    g = Guild(id=1, name="g", owner_id=1)
    g.max_concurrent_streams = 0  # gar keine Streams erlaubt
    g.community_max_concurrent_streams = 3
    gl.clamp_to_ceilings(g)
    assert g.community_max_concurrent_streams == 0


def test_effective_prefers_community_value_then_ceiling():
    g = Guild(id=1, name="g", owner_id=1)
    spec = gl.LIMITS_BY_KEY["stream_fps"]
    g.stream_fps_max = 60
    assert gl.effective(g, spec) == 60  # kein Community-Wert → Obergrenze
    g.community_stream_fps = 30
    assert gl.effective(g, spec) == 30  # Community-Wert gewinnt


# ─── Community-Endpoint ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_community_sets_own_value_within_ceiling(
    client, session_factory, _auth_signer
):
    token, _uid, gid = await _owned_guild(session_factory, _auth_signer)

    # Betreiber-Obergrenze setzen.
    async with session_factory() as s:
        g = await s.get(Guild, gid)
        g.stream_fps_max = 60
        await s.commit()

    r = await client.patch(
        f"/guilds/{gid}/limits",
        json={"limits": {"stream_fps": 30}},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["clamped"] == []
    assert body["limits"]["stream_fps"]["value"] == 30
    assert body["limits"]["stream_fps"]["ceiling"] == 60
    assert body["limits"]["stream_fps"]["effective"] == 30


@pytest.mark.asyncio
async def test_community_value_above_ceiling_is_clamped_visibly(
    client, session_factory, _auth_signer
):
    token, _uid, gid = await _owned_guild(session_factory, _auth_signer)
    async with session_factory() as s:
        g = await s.get(Guild, gid)
        g.voice_bitrate_max_kbps = 128
        await s.commit()

    r = await client.patch(
        f"/guilds/{gid}/limits",
        json={"limits": {"voice_bitrate_kbps": 256}},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "voice_bitrate_kbps" in body["clamped"]
    assert body["limits"]["voice_bitrate_kbps"]["value"] == 128


@pytest.mark.asyncio
async def test_community_null_clears_own_value(client, session_factory, _auth_signer):
    token, _uid, gid = await _owned_guild(session_factory, _auth_signer)
    async with session_factory() as s:
        g = await s.get(Guild, gid)
        g.stream_fps_max = 60
        g.community_stream_fps = 30
        await s.commit()

    r = await client.patch(
        f"/guilds/{gid}/limits",
        json={"limits": {"stream_fps": None}},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    fps = r.json()["limits"]["stream_fps"]
    assert fps["value"] is None
    assert fps["effective"] == 60  # fällt auf die Obergrenze zurück


@pytest.mark.asyncio
async def test_community_limits_require_manage_guild(
    client, session_factory, _auth_signer
):
    _owner_token, _uid, gid = await _owned_guild(session_factory, _auth_signer)
    stranger = _auth_signer.issue_access(
        abs(hash(uuid.uuid4())) & ((1 << 31) - 1), "stranger"
    )
    r = await client.patch(
        f"/guilds/{gid}/limits",
        json={"limits": {"stream_fps": 30}},
        headers=_auth(stranger),
    )
    assert r.status_code == 403


# ─── Betreiber senkt die Obergrenze → Community-Werte ziehen nach ───────────


@pytest.mark.asyncio
async def test_lowering_ceiling_pulls_existing_community_value_down(
    client, session_factory, _auth_signer, owner_token
):
    _token, _uid, gid = await _owned_guild(session_factory, _auth_signer)
    async with session_factory() as s:
        g = await s.get(Guild, gid)
        g.voice_bitrate_max_kbps = 256
        g.community_voice_bitrate_kbps = 256  # nutzt die volle Obergrenze
        await s.commit()

    owner_tok, _owner_uid = owner_token
    r = await client.patch(
        f"/owner/communities/{gid}/limits",
        json={"voice_bitrate_max_kbps": 96},  # Obergrenze senken
        headers=_auth(owner_tok),
    )
    assert r.status_code == 200, r.text

    async with session_factory() as s:
        g = await s.get(Guild, gid)
        assert g.voice_bitrate_max_kbps == 96
        assert g.community_voice_bitrate_kbps == 96  # nachgezogen


# ─── Wirksamer Wert im GuildOut ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_guild_out_serves_effective_value(client, session_factory, _auth_signer):
    token, _uid, gid = await _owned_guild(session_factory, _auth_signer)
    async with session_factory() as s:
        g = await s.get(Guild, gid)
        g.stream_bitrate_max_kbps = 50000  # Obergrenze
        g.community_stream_bitrate_kbps = 20000  # Community kleiner
        await s.commit()

    r = await client.get(f"/guilds/{gid}", headers=_auth(token))
    assert r.status_code == 200, r.text
    # Der Client liest ``stream_bitrate_max_kbps`` — muss der wirksame (= der
    # kleinere Community-)Wert sein, nicht die Obergrenze.
    assert r.json()["stream_bitrate_max_kbps"] == 20000
