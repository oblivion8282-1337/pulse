"""Permission-gate enforcement at the route layer.

Two server-wide toggles in chat_settings drive these:
* allow_guild_creation — when false, POST /guilds 403s non-admins.
* allow_member_invites — when false, POST /guilds/{id}/invites 403s
  callers who aren't the guild's owner.

Tests flip the chat_settings row directly via the engine so we don't
have to walk through the admin endpoint for every case.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import update

from dcc_chat_gateway.models import ChatSettings


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _set_permissions(session_factory, **fields):
    async with session_factory() as s:
        await s.execute(update(ChatSettings).where(ChatSettings.id == 1).values(**fields))
        await s.commit()


async def _make_token(signer, *, is_admin: bool = False) -> tuple[str, int]:
    uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    return signer.issue_access(uid, f"u{uid}", is_admin=is_admin), uid


# ─── Guild creation ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_guild_create_open_by_default(client, _auth_signer):
    token, _ = await _make_token(_auth_signer)
    r = await client.post("/guilds", json={"name": "g1"}, headers=auth(token))
    assert r.status_code == 201


@pytest.mark.asyncio
async def test_guild_create_blocked_when_disabled(client, _auth_signer, session_factory):
    await _set_permissions(session_factory, allow_guild_creation=False)
    token, _ = await _make_token(_auth_signer)
    r = await client.post("/guilds", json={"name": "g1"}, headers=auth(token))
    assert r.status_code == 403
    assert "disabled" in r.json()["detail"]


@pytest.mark.asyncio
async def test_guild_create_admin_bypass(client, _auth_signer, session_factory):
    await _set_permissions(session_factory, allow_guild_creation=False)
    token, _ = await _make_token(_auth_signer, is_admin=True)
    r = await client.post("/guilds", json={"name": "admin-server"}, headers=auth(token))
    assert r.status_code == 201


# ─── Invite creation ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_invites_open_by_default(client, _auth_signer):
    """Two users — owner creates the guild, the other joins, both can invite."""
    owner_t, owner_uid = await _make_token(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(owner_t))).json()
    other_t, other_uid = await _make_token(_auth_signer)
    # Add the other as a member.
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(other_uid)},
        headers=auth(owner_t),
    )
    # Default = open: non-owner member can create an invite.
    r = await client.post(f"/guilds/{g['id']}/invites", json={}, headers=auth(other_t))
    assert r.status_code == 201


@pytest.mark.asyncio
async def test_invites_blocked_for_non_owner_when_disabled(
    client, _auth_signer, session_factory
):
    owner_t, _ = await _make_token(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(owner_t))).json()
    other_t, other_uid = await _make_token(_auth_signer)
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(other_uid)},
        headers=auth(owner_t),
    )

    await _set_permissions(session_factory, allow_member_invites=False)

    r = await client.post(f"/guilds/{g['id']}/invites", json={}, headers=auth(other_t))
    assert r.status_code == 403
    assert "owner" in r.json()["detail"]

    # Owner still works.
    r = await client.post(f"/guilds/{g['id']}/invites", json={}, headers=auth(owner_t))
    assert r.status_code == 201


@pytest.mark.asyncio
async def test_invites_admin_not_special(
    client, _auth_signer, session_factory
):
    """Per design: a global admin who isn't the guild owner still can't
    create invites when the toggle is off. They'd have to either flip the
    toggle, or be granted ownership."""
    owner_t, _ = await _make_token(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(owner_t))).json()
    admin_t, admin_uid = await _make_token(_auth_signer, is_admin=True)
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(admin_uid)},
        headers=auth(owner_t),
    )

    await _set_permissions(session_factory, allow_member_invites=False)

    r = await client.post(f"/guilds/{g['id']}/invites", json={}, headers=auth(admin_t))
    assert r.status_code == 403


# ─── Instanzweiter Anzeigename (instance_name) ──────────────────────────────


@pytest.mark.asyncio
async def test_instance_name_default_null(client, _auth_signer):
    """Frisch → kein instance_name."""
    token, _ = await _make_token(_auth_signer, is_admin=True)
    r = await client.get("/admin/permissions", headers=auth(token))
    assert r.status_code == 200
    assert r.json()["instance_name"] is None


@pytest.mark.asyncio
async def test_admin_sets_and_clears_instance_name(client, _auth_signer):
    """Admin setzt den Namen; Leerstring setzt ihn wieder zurück."""
    token, _ = await _make_token(_auth_signer, is_admin=True)
    r = await client.patch(
        "/admin/permissions",
        json={"instance_name": "  Unicut Media  "},
        headers=auth(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["instance_name"] == "Unicut Media"  # getrimmt

    # Leerstring → zurücksetzen auf NULL.
    r2 = await client.patch(
        "/admin/permissions", json={"instance_name": "   "}, headers=auth(token)
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["instance_name"] is None


@pytest.mark.asyncio
async def test_instance_name_partial_patch_keeps_other_fields(client, _auth_signer):
    """instance_name patchen lässt andere Flags unangetastet."""
    token, _ = await _make_token(_auth_signer, is_admin=True)
    await client.patch(
        "/admin/permissions", json={"instance_name": "Server X"}, headers=auth(token)
    )
    # Nur locked patchen → Name bleibt.
    r = await client.patch(
        "/admin/permissions", json={"locked": True}, headers=auth(token)
    )
    assert r.json()["instance_name"] == "Server X"
    assert r.json()["locked"] is True


@pytest.mark.asyncio
async def test_instance_name_patch_requires_admin(client, _auth_signer):
    """Nicht-Admin darf den Namen nicht setzen."""
    token, _ = await _make_token(_auth_signer, is_admin=False)
    r = await client.patch(
        "/admin/permissions", json={"instance_name": "Hack"}, headers=auth(token)
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_instance_name_too_long_rejected(client, _auth_signer):
    """Über 60 Zeichen → 422 (Schema-Grenze)."""
    token, _ = await _make_token(_auth_signer, is_admin=True)
    r = await client.patch(
        "/admin/permissions", json={"instance_name": "x" * 61}, headers=auth(token)
    )
    assert r.status_code == 422
