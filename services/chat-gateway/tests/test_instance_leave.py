"""Selbst-Austritt aus der Instanz: DELETE /me/instance-membership.

Covers: Cloud-Modus → 404 · Austritt entfernt InstanceMember + alle
GuildMember-Zeilen · Owner (joined_via='owner') → 403 · Community-Besitzer →
409 · idempotent ohne Mitgliedschaft → 204.
"""

from __future__ import annotations

import random
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy import select

from dcc_chat_gateway.models import GuildMember, InstanceMember


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _self_host_settings():
    return patch(
        "dcc_chat_gateway.routes.instance_membership.get_settings",
        return_value=SimpleNamespace(pulse_instance_mode="self-host"),
    )


async def _register_user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"leaver{uid}"), uid


async def _seed_instance_member(
    session_factory, user_identifier: str, joined_via: str = "community_invite"
) -> None:
    async with session_factory() as session:
        session.add(
            InstanceMember(user_identifier=user_identifier, joined_via=joined_via)
        )
        await session.commit()


@pytest.mark.asyncio
async def test_cloud_mode_404(client, _auth_signer):
    token, _uid = await _register_user(_auth_signer)
    with patch(
        "dcc_chat_gateway.routes.instance_membership.get_settings",
        return_value=SimpleNamespace(pulse_instance_mode="cloud"),
    ):
        r = await client.delete("/me/instance-membership", headers=auth(token))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_leave_removes_instance_and_guild_memberships(
    client, _auth_signer, session_factory
):
    t_owner, _uid_owner = await _register_user(_auth_signer)
    t_a, uid_a = await _register_user(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "exitvale"}, headers=auth(t_owner))
    ).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_a)},
        headers=auth(t_owner),
    )
    await _seed_instance_member(session_factory, str(uid_a))

    with _self_host_settings():
        r = await client.delete("/me/instance-membership", headers=auth(t_a))
    assert r.status_code == 204, r.text

    async with session_factory() as session:
        assert await session.get(InstanceMember, str(uid_a)) is None
        rows = (
            (
                await session.execute(
                    select(GuildMember).where(GuildMember.user_id == uid_a)
                )
            )
            .scalars()
            .all()
        )
        assert rows == []
        # Nur die EIGENEN Mitgliedschaften fallen — der Guild-Owner bleibt drin.
        assert (
            await session.get(GuildMember, (int(g["id"]), _uid_owner))
        ) is not None


@pytest.mark.asyncio
async def test_owner_cannot_leave(client, _auth_signer, session_factory):
    token, uid = await _register_user(_auth_signer)
    await _seed_instance_member(session_factory, str(uid), joined_via="owner")

    with _self_host_settings():
        r = await client.delete("/me/instance-membership", headers=auth(token))
    assert r.status_code == 403
    assert r.json()["detail"] == "owner_cannot_leave_instance"
    async with session_factory() as session:
        assert await session.get(InstanceMember, str(uid)) is not None


@pytest.mark.asyncio
async def test_guild_owner_blocked_409(client, _auth_signer, session_factory):
    token, uid = await _register_user(_auth_signer)
    await client.post("/guilds", json={"name": "ownedtown"}, headers=auth(token))
    await _seed_instance_member(session_factory, str(uid))

    with _self_host_settings():
        r = await client.delete("/me/instance-membership", headers=auth(token))
    assert r.status_code == 409
    assert r.json()["detail"] == "owns_communities"
    async with session_factory() as session:
        assert await session.get(InstanceMember, str(uid)) is not None


@pytest.mark.asyncio
async def test_idempotent_without_membership(client, _auth_signer):
    token, _uid = await _register_user(_auth_signer)
    with _self_host_settings():
        r = await client.delete("/me/instance-membership", headers=auth(token))
    assert r.status_code == 204
