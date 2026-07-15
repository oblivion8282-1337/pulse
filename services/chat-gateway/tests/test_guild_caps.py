"""Per-community scale caps (Etappe 3.3): members / channels / roles.

Each cap is a Cloud-operator-set column on the guild (NULL = unlimited),
server-enforced with a count-check before the relevant insert. The concurrent
HQ-stream cap (3.4) is best-effort at token issuance and covered by the owner
round-trip test, not here (it needs live Redis stream state).
"""

from __future__ import annotations

import uuid

import pytest


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _fresh(_auth_signer):
    uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _set_cap(session_factory, guild_id: str, **caps) -> None:
    from dcc_chat_gateway.models import Guild

    async with session_factory() as s:
        guild = await s.get(Guild, int(guild_id))
        for k, v in caps.items():
            setattr(guild, k, v)
        await s.commit()


@pytest.mark.asyncio
async def test_member_cap_blocks_extra_member(client, _auth_signer, session_factory):
    token, uid = _fresh(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    # Owner is member #1 already; cap of 1 means no more may join.
    await _set_cap(session_factory, g["id"], max_members=1)
    r = await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid + 1)},
        headers=_auth(token),
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_member_cap_allows_under_limit(client, _auth_signer, session_factory):
    token, uid = _fresh(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    await _set_cap(session_factory, g["id"], max_members=5)
    r = await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid + 1)},
        headers=_auth(token),
    )
    assert r.status_code in (200, 201), r.text


@pytest.mark.asyncio
async def test_channel_cap_blocks_extra_channel(client, _auth_signer, session_factory):
    token, _ = _fresh(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    c = await client.post(
        f"/guilds/{g['id']}/channels", json={"name": "general"}, headers=_auth(token)
    )
    assert c.status_code == 201, c.text
    # One channel exists; cap at 1 blocks the next.
    await _set_cap(session_factory, g["id"], max_channels=1)
    r = await client.post(
        f"/guilds/{g['id']}/channels", json={"name": "second"}, headers=_auth(token)
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_role_cap_blocks_extra_role(client, _auth_signer, session_factory):
    token, _ = _fresh(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    # @everyone is seeded but excluded from the cap; create one user role (ok).
    r1 = await client.post(
        f"/guilds/{g['id']}/roles", json={"name": "mod", "permissions": "0"}, headers=_auth(token)
    )
    assert r1.status_code in (200, 201), r1.text
    await _set_cap(session_factory, g["id"], max_roles=1)
    r2 = await client.post(
        f"/guilds/{g['id']}/roles", json={"name": "vip", "permissions": "0"}, headers=_auth(token)
    )
    assert r2.status_code == 403, r2.text
