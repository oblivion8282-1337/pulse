"""Integration coverage: moderation routes write audit-log entries.

The audit-log table + GET endpoint + viewer existed, but the destructive
mutation routes never recorded anything except report-resolutions. These
tests pin the wiring added so that ban/unban/kick/message_delete/role_change
actually land in ``chat.mod_audit_log`` — and that self-removal / self-delete
deliberately do NOT.
"""

from __future__ import annotations

import random

import pytest


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


async def _make_guild(client, owner_token: str) -> dict:
    r = await client.post("/guilds", json={"name": "auditville"}, headers=auth(owner_token))
    assert r.status_code == 201, r.text
    return r.json()


async def _add_member(client, owner_token: str, gid: str, uid: int) -> None:
    r = await client.post(
        f"/guilds/{gid}/members", json={"user_id": str(uid)}, headers=auth(owner_token)
    )
    assert r.status_code in (200, 201), r.text


async def _audit_actions(client, owner_token: str, gid: str) -> list[str]:
    """All action_type strings currently in the guild's audit log."""
    r = await client.get(f"/guilds/{gid}/mod-audit-log", headers=auth(owner_token))
    assert r.status_code == 200, r.text
    return [e["action_type"] for e in r.json()]


@pytest.mark.asyncio
async def test_ban_and_unban_write_audit(client, _auth_signer):
    t_owner, _ = await _register_user(_auth_signer)
    _, uid_target = await _register_user(_auth_signer)
    g = await _make_guild(client, t_owner)
    gid = g["id"]
    await _add_member(client, t_owner, gid, uid_target)

    r = await client.put(
        f"/guilds/{gid}/bans/{uid_target}", json={"reason": "spam"}, headers=auth(t_owner)
    )
    assert r.status_code == 200, r.text
    assert "ban" in await _audit_actions(client, t_owner, gid)

    r = await client.delete(f"/guilds/{gid}/bans/{uid_target}", headers=auth(t_owner))
    assert r.status_code == 204, r.text
    assert "unban" in await _audit_actions(client, t_owner, gid)


@pytest.mark.asyncio
async def test_kick_writes_audit_but_leave_does_not(client, _auth_signer):
    t_owner, _ = await _register_user(_auth_signer)
    t_kicked, uid_kicked = await _register_user(_auth_signer)
    t_leaver, uid_leaver = await _register_user(_auth_signer)
    g = await _make_guild(client, t_owner)
    gid = g["id"]
    await _add_member(client, t_owner, gid, uid_kicked)
    await _add_member(client, t_owner, gid, uid_leaver)

    # Moderator kick → audited.
    r = await client.delete(f"/guilds/{gid}/members/{uid_kicked}", headers=auth(t_owner))
    assert r.status_code == 204, r.text

    # Self-leave → shares removal mechanics but must NOT be audited.
    r = await client.delete(f"/guilds/{gid}/members/@me", headers=auth(t_leaver))
    assert r.status_code == 204, r.text

    actions = await _audit_actions(client, t_owner, gid)
    assert actions.count("kick") == 1


@pytest.mark.asyncio
async def test_role_create_patch_delete_write_audit(client, _auth_signer):
    t_owner, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, t_owner)
    gid = g["id"]

    role = (
        await client.post(
            f"/guilds/{gid}/roles",
            json={"name": "mods", "permissions": "0"},
            headers=auth(t_owner),
        )
    ).json()
    await client.patch(
        f"/guilds/{gid}/roles/{role['id']}",
        json={"name": "supermods"},
        headers=auth(t_owner),
    )
    await client.delete(f"/guilds/{gid}/roles/{role['id']}", headers=auth(t_owner))

    actions = await _audit_actions(client, t_owner, gid)
    # create + patch + delete all log under the generic ``role_change`` type.
    assert actions.count("role_change") == 3


@pytest.mark.asyncio
async def test_mod_delete_writes_audit_self_delete_does_not(client, _auth_signer):
    t_owner, _ = await _register_user(_auth_signer)
    t_author, uid_author = await _register_user(_auth_signer)
    g = await _make_guild(client, t_owner)
    gid = g["id"]
    await _add_member(client, t_owner, gid, uid_author)
    channel = (
        await client.post(
            f"/guilds/{gid}/channels", json={"name": "general"}, headers=auth(t_owner)
        )
    ).json()
    cid = channel["id"]

    # Author posts two messages.
    m1 = (
        await client.post(
            f"/channels/{cid}/messages", json={"content": "one"}, headers=auth(t_author)
        )
    ).json()
    m2 = (
        await client.post(
            f"/channels/{cid}/messages", json={"content": "two"}, headers=auth(t_author)
        )
    ).json()

    # Owner (MANAGE_MESSAGES) deletes the author's message → audited.
    r = await client.delete(f"/messages/{m1['id']}", headers=auth(t_owner))
    assert r.status_code == 204, r.text

    # Author deletes their own message → NOT audited.
    r = await client.delete(f"/messages/{m2['id']}", headers=auth(t_author))
    assert r.status_code == 204, r.text

    actions = await _audit_actions(client, t_owner, gid)
    assert actions.count("message_delete") == 1
