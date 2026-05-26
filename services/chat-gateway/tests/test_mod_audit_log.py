"""Tests for GET /guilds/{gid}/mod-audit-log.

Verifies:
  * Non-MANAGE_GUILD users → 403
  * MANAGE_GUILD holder → 200 + correct entries
  * Pagination via ``before`` timestamp
  * Audit-log is immutable: there is no DELETE/PATCH endpoint
"""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta

import pytest

from dcc_chat_gateway.audit_log import write_audit_log
from dcc_chat_gateway.models import ModAuditLog


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _uid() -> int:
    return random.randint(1, 1_000_000)


async def _token(signer, *, is_admin: bool = False) -> tuple[str, int]:
    uid = _uid()
    if is_admin:
        return signer.issue_access(uid, f"admin{uid}", is_admin=True), uid
    return signer.issue_access(uid, f"user{uid}"), uid


async def _make_guild(client, owner_token: str) -> dict:
    r = await client.post("/guilds", json={"name": "testguild"}, headers=auth(owner_token))
    assert r.status_code == 201, r.text
    return r.json()


async def _seed_entry(
    session_factory,
    guild_id: int,
    actor_id: int,
    action_type: str = "ban",
) -> int:
    """Insert an audit-log entry directly (bypasses HTTP)."""
    from dcc_chat_gateway.snowflake import next_id as _nid

    async with session_factory() as s:
        entry = ModAuditLog(
            id=_nid(),
            guild_id=guild_id,
            actor_user_id=actor_id,
            action_type=action_type,
            target_kind="user",
            target_id=_uid(),
            payload={"seeded": True},
        )
        s.add(entry)
        await s.commit()
        return entry.id


# ---------------------------------------------------------------------------
# Permission gate
# ---------------------------------------------------------------------------

_MANAGE_MESSAGES = 1 << 23  # not MANAGE_GUILD
_MANAGE_GUILD = 1 << 1


@pytest.mark.asyncio
async def test_audit_log_requires_manage_guild(client, _auth_signer):
    t_owner, uid_owner = await _token(_auth_signer)
    t_mod, uid_mod = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)

    # Give mod MANAGE_MESSAGES but NOT MANAGE_GUILD
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_mod)},
        headers=auth(t_owner),
    )
    role = (
        await client.post(
            f"/guilds/{g['id']}/roles",
            json={"name": "mod", "permissions": str(_MANAGE_MESSAGES)},
            headers=auth(t_owner),
        )
    ).json()
    await client.put(
        f"/guilds/{g['id']}/members/{uid_mod}/roles/{role['id']}",
        headers=auth(t_owner),
    )

    r = await client.get(f"/guilds/{g['id']}/mod-audit-log", headers=auth(t_mod))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_audit_log_accessible_to_manage_guild(client, _auth_signer, session_factory):
    t_owner, uid_owner = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    gid = int(g["id"])

    await _seed_entry(session_factory, gid, uid_owner, "ban")

    r = await client.get(f"/guilds/{g['id']}/mod-audit-log", headers=auth(t_owner))
    assert r.status_code == 200
    data = r.json()
    assert len(data) >= 1
    assert data[0]["guild_id"] == g["id"]


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_audit_log_pagination_before(client, _auth_signer, session_factory):
    """``before`` timestamp excludes entries at or after the cutoff.

    We use a future cutoff (now + 1 hour) to make the test independent of
    the exact wall-clock second, which avoids SQLite's 1-second ``func.now()``
    resolution causing tie-breaks when all entries land in the same second.
    """
    t_owner, uid_owner = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    gid = int(g["id"])

    for _ in range(3):
        await _seed_entry(session_factory, gid, uid_owner)

    # All entries are in the past; a cutoff far in the future must return them all.
    future_cutoff = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    r_all = await client.get(
        f"/guilds/{g['id']}/mod-audit-log",
        params={"before": future_cutoff},
        headers=auth(t_owner),
    )
    assert r_all.status_code == 200
    assert len(r_all.json()) >= 3

    # A cutoff in the past (yesterday) must return nothing.
    past_cutoff = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    r_empty = await client.get(
        f"/guilds/{g['id']}/mod-audit-log",
        params={"before": past_cutoff},
        headers=auth(t_owner),
    )
    assert r_empty.status_code == 200
    assert r_empty.json() == []


@pytest.mark.asyncio
async def test_audit_log_limit(client, _auth_signer, session_factory):
    t_owner, uid_owner = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    gid = int(g["id"])

    for _ in range(5):
        await _seed_entry(session_factory, gid, uid_owner)

    r = await client.get(
        f"/guilds/{g['id']}/mod-audit-log",
        params={"limit": 2},
        headers=auth(t_owner),
    )
    assert r.status_code == 200
    assert len(r.json()) <= 2


# ---------------------------------------------------------------------------
# Immutability — no DELETE/PATCH endpoint exists
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_audit_log_no_delete_endpoint(client, _auth_signer):
    """The audit-log must be append-only: DELETE must return 405 (or 404)."""
    t_owner, _ = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)

    r = await client.delete(
        f"/guilds/{g['id']}/mod-audit-log/999999999",
        headers=auth(t_owner),
    )
    # 404 or 405 — either means there's no delete route
    assert r.status_code in (404, 405)


@pytest.mark.asyncio
async def test_audit_log_no_patch_endpoint(client, _auth_signer):
    t_owner, _ = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)

    r = await client.patch(
        f"/guilds/{g['id']}/mod-audit-log/999999999",
        json={"action_type": "mutated"},
        headers=auth(t_owner),
    )
    assert r.status_code in (404, 405)


# ---------------------------------------------------------------------------
# write_audit_log helper — unit-level smoke test
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_write_audit_log_helper(session_factory):
    """write_audit_log inserts a row and returns it with an id."""
    from dcc_chat_gateway.db import Base

    async with session_factory() as s:
        entry = await write_audit_log(
            s,
            guild_id=1,
            actor_user_id=2,
            action_type="test_action",
            target_kind="user",
            target_id=3,
            payload={"key": "value"},
        )
        await s.commit()

    assert entry.id > 0
    assert entry.action_type == "test_action"
    assert entry.payload == {"key": "value"}
