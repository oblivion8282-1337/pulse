"""Pinned Messages: pin/unpin/list auf Guild- und DM-Nachrichten.

Deckt die Vertrauensgrenzen: MANAGE_MESSAGES-Gate für Guild-Kanäle,
Pin-Limit (50), Lese-Gate auf der Listen-Route und Soft-Delete-Lösung.
"""

from __future__ import annotations

import random

import pytest


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


async def _make_guild_with_channel(client, _auth_signer):
    """Returns (owner_token, owner_uid, member_token, member_uid, channel_id)."""
    t1, uid1 = await _register(_auth_signer)
    t2, uid2 = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    await client.post(
        f"/guilds/{g['id']}/members", json={"user_id": uid2}, headers=auth(t1)
    )
    c = (await client.post(
        f"/guilds/{g['id']}/channels", json={"name": "general"}, headers=auth(t1)
    )).json()
    return t1, uid1, t2, uid2, c["id"]


async def _post(client, token, cid, content="hi"):
    r = await client.post(
        f"/channels/{cid}/messages", json={"content": content}, headers=auth(token)
    )
    assert r.status_code == 201, r.text
    return r.json()


@pytest.mark.asyncio
async def test_pin_unpin_roundtrip_and_list(client, _auth_signer):
    t1, _, t2, _, cid = await _make_guild_with_channel(client, _auth_signer)
    msg = await _post(client, t1, cid)

    # Nicht-Moderator (einfaches Mitglied) darf nicht pinnen.
    r = await client.put(f"/messages/{msg['id']}/pin", headers=auth(t2))
    assert r.status_code == 403
    assert "MANAGE_MESSAGES" in r.json()["detail"]

    r = await client.put(f"/messages/{msg['id']}/pin", headers=auth(t1))
    assert r.status_code == 204, r.text
    # Idempotent.
    r = await client.put(f"/messages/{msg['id']}/pin", headers=auth(t1))
    assert r.status_code == 204

    r = await client.get(f"/channels/{cid}/pins", headers=auth(t2))
    assert r.status_code == 200, r.text
    pins = r.json()
    assert len(pins) == 1
    assert pins[0]["id"] == msg["id"]
    assert pins[0]["pinned_at"] is not None

    r = await client.delete(f"/messages/{msg['id']}/pin", headers=auth(t1))
    assert r.status_code == 204
    r = await client.get(f"/channels/{cid}/pins", headers=auth(t1))
    assert r.json() == []


@pytest.mark.asyncio
async def test_pin_limit(client, _auth_signer, monkeypatch):
    # 51 Nachrichten in einer Sekunde — der Send-Ratelimit würde sonst vor
    # dem Pin-Limit zuschlagen; für diesen Test ist er Störfaktor, nicht
    # Prüfgegenstand.
    import dcc_chat_gateway.ratelimit as ratelimit

    monkeypatch.setattr(ratelimit, "check", lambda *a, **k: True)
    t1, _, _, _, cid = await _make_guild_with_channel(client, _auth_signer)
    from dcc_chat_gateway.routes.pins import PIN_LIMIT

    for i in range(PIN_LIMIT):
        msg = await _post(client, t1, cid, f"m{i}")
        r = await client.put(f"/messages/{msg['id']}/pin", headers=auth(t1))
        assert r.status_code == 204, r.text
    msg = await _post(client, t1, cid, "overflow")
    r = await client.put(f"/messages/{msg['id']}/pin", headers=auth(t1))
    assert r.status_code == 400
    assert r.json()["detail"] == "pin_limit_reached"
    # Unpin gibt den Platz wieder frei.
    first = (await client.get(f"/channels/{cid}/pins", headers=auth(t1))).json()[0]
    r = await client.delete(f"/messages/{first['id']}/pin", headers=auth(t1))
    assert r.status_code == 204
    r = await client.put(f"/messages/{msg['id']}/pin", headers=auth(t1))
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_delete_message_unpins(client, _auth_signer):
    t1, _, _, _, cid = await _make_guild_with_channel(client, _auth_signer)
    msg = await _post(client, t1, cid)
    await client.put(f"/messages/{msg['id']}/pin", headers=auth(t1))
    r = await client.delete(f"/messages/{msg['id']}", headers=auth(t1))
    assert r.status_code == 204
    r = await client.get(f"/channels/{cid}/pins", headers=auth(t1))
    assert r.json() == []


@pytest.mark.asyncio
async def test_non_member_cannot_list_or_pin(client, _auth_signer):
    t1, _, _, _, cid = await _make_guild_with_channel(client, _auth_signer)
    msg = await _post(client, t1, cid)
    t_other, _ = await _register(_auth_signer)
    r = await client.put(f"/messages/{msg['id']}/pin", headers=auth(t_other))
    assert r.status_code == 403
    r = await client.get(f"/channels/{cid}/pins", headers=auth(t_other))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_dm_members_can_pin(client, _auth_signer, friend_pair, cloud_mode):
    """In DMs darf jeder Teilnehmer pinnen — es gibt kein Moderationsbit und
    ``resolve_channel_or_raise`` kapselt die Mitgliedschaft."""
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm = (
        await client.post(
            "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
        )
    ).json()
    msg = await _post(client, t_a, dm["id"], "dm pin me")
    r = await client.put(f"/messages/{msg['id']}/pin", headers=auth(t_b))
    assert r.status_code == 204, r.text
    r = await client.get(f"/channels/{dm['id']}/pins", headers=auth(t_a))
    assert r.status_code == 200
    assert [p["id"] for p in r.json()] == [msg["id"]]
