"""Voice-Eviction beim Löschen von Voice-Channels / Communitys.

Lücke (Gap-Scan 2026-06-29): ein gelöschter Voice-Channel — bzw. eine ganze
gelöschte Community — ließ die anwesenden Teilnehmer in einer verwaisten
LiveKit-Session hängen (Ghost-Channel, kein Self-Heal innerhalb der Session).
Diese Tests prüfen, dass die Delete-Pfade die Bulk-Eviction *überhaupt* anstoßen
(der Bug war: gar kein Aufruf) und dass der Helfer pro anwesendem User feuert.
"""

from __future__ import annotations

import random

import dcc_chat_gateway.routes.channels as channels_mod
import dcc_chat_gateway.routes.guilds as guilds_mod
import dcc_chat_gateway.voice_evict as voice_evict
import pytest


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _owner(_auth_signer) -> str:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}")


async def _make_channel(client, token, guild_id, name, type_):
    return (
        await client.post(
            f"/guilds/{guild_id}/channels",
            json={"name": name, "type": type_},
            headers=auth(token),
        )
    ).json()


@pytest.mark.asyncio
async def test_delete_voice_channel_evicts_occupants(
    client, _auth_signer, monkeypatch
):
    """Voice-Channel löschen → Bulk-Eviction für genau diesen Channel."""
    calls: list[list[int]] = []

    async def _capture(_redis, channel_ids):
        calls.append([int(c) for c in channel_ids])

    monkeypatch.setattr(channels_mod, "evict_all_from_voice_channels", _capture)

    t = await _owner(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t))).json()
    v = await _make_channel(client, t, g["id"], "voice", 1)

    r = await client.delete(f"/channels/{v['id']}", headers=auth(t))
    assert r.status_code == 204, r.text
    assert calls == [[int(v["id"])]]


@pytest.mark.asyncio
async def test_delete_text_channel_does_not_evict(
    client, _auth_signer, monkeypatch
):
    """Text-Channel löschen → keine Eviction (nur Voice-Channels betroffen)."""
    calls: list[list[int]] = []

    async def _capture(_redis, channel_ids):
        calls.append([int(c) for c in channel_ids])

    monkeypatch.setattr(channels_mod, "evict_all_from_voice_channels", _capture)

    t = await _owner(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t))).json()
    c = await _make_channel(client, t, g["id"], "text", 0)

    r = await client.delete(f"/channels/{c['id']}", headers=auth(t))
    assert r.status_code == 204, r.text
    assert calls == []


@pytest.mark.asyncio
async def test_delete_guild_evicts_all_voice_channels(
    client, _auth_signer, monkeypatch
):
    """Community löschen → Eviction für ALLE ihre Voice-Channels."""
    calls: list[set[int]] = []

    async def _capture(_redis, channel_ids):
        calls.append({int(c) for c in channel_ids})

    monkeypatch.setattr(guilds_mod, "evict_all_from_voice_channels", _capture)

    t = await _owner(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t))).json()
    v1 = await _make_channel(client, t, g["id"], "voice1", 1)
    v2 = await _make_channel(client, t, g["id"], "voice2", 1)
    await _make_channel(client, t, g["id"], "text", 0)

    r = await client.delete(f"/guilds/{g['id']}", headers=auth(t))
    assert r.status_code in (200, 204), r.text
    assert calls == [{int(v1["id"]), int(v2["id"])}]


class _FakeRedis:
    def __init__(self, presence: dict[str, set[bytes]]):
        self._presence = presence

    async def smembers(self, key):
        k = key.decode() if isinstance(key, (bytes, bytearray)) else key
        return self._presence.get(k, set())


@pytest.mark.asyncio
async def test_evict_all_fires_per_present_user(monkeypatch):
    """Der Helfer feuert eine Eviction pro anwesendem (numerischem) User und
    überspringt nicht-numerische Streureste."""
    posted: list[tuple[list[int], str]] = []

    async def _capture(_secret, channel_ids, user_id):
        posted.append(([int(c) for c in channel_ids], user_id))

    monkeypatch.setattr(voice_evict, "_post_evict", _capture)
    monkeypatch.setattr(
        voice_evict,
        "get_settings",
        lambda: type("S", (), {"internal_service_secret": "x"})(),
    )

    redis = _FakeRedis(
        {
            "voice:room:channel-10": {b"100", b"101", b"not-numeric"},
            "voice:room:channel-20": {b"100"},
        }
    )
    await voice_evict.evict_all_from_voice_channels(redis, [10, 20])

    assert ([10], "100") in posted
    assert ([10], "101") in posted
    assert ([20], "100") in posted
    # 'not-numeric' wird übersprungen → genau drei Evictions.
    assert len(posted) == 3


@pytest.mark.asyncio
async def test_evict_all_noop_without_secret(monkeypatch):
    """Ohne internal_service_secret passiert nichts (dev / no-voice-mod)."""
    posted: list = []

    async def _capture(*_a):
        posted.append(_a)

    monkeypatch.setattr(voice_evict, "_post_evict", _capture)
    monkeypatch.setattr(
        voice_evict,
        "get_settings",
        lambda: type("S", (), {"internal_service_secret": ""})(),
    )

    redis = _FakeRedis({"voice:room:channel-10": {b"100"}})
    await voice_evict.evict_all_from_voice_channels(redis, [10])
    assert posted == []
