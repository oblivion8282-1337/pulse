"""Admin-only routes on chat-gateway: gate checks + happy paths.

Two fixtures from conftest do most of the work — ``admin_token`` mints a
JWT with ``admin: true``, ``access_token`` mints a regular one. The
``app`` fixture is the REST-only one (no live ConnectionManager); these
endpoints don't touch Redis.
"""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_admin_routes_403_for_non_admin(client, access_token):
    token, _ = access_token
    headers = {"Authorization": f"Bearer {token}"}
    for path in ("/admin/stats", "/admin/dm-limits", "/admin/audit-log"):
        r = await client.get(path, headers=headers)
        assert r.status_code == 403, f"{path}: {r.text}"


@pytest.mark.asyncio
async def test_admin_routes_401_without_token(client):
    r = await client.get("/admin/stats")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_stats_returns_counts(client, admin_token):
    token, _ = admin_token
    r = await client.get("/admin/stats", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    # Empty fresh DB.
    assert body == {
        "guild_count": 0,
        "channel_count": 0,
        "dm_channel_count": 0,
        "messages_24h": 0,
        "storage_bytes": None,
    }


@pytest.mark.asyncio
async def test_get_dm_limits_returns_defaults(client, admin_token):
    token, _ = admin_token
    r = await client.get(
        "/admin/dm-limits", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 200
    body = r.json()
    assert body == {
        "dm_attachment_max_size_bytes": 26214400,  # 25 MB default
        "dm_attachment_max_count_per_message": 4,
    }


@pytest.mark.asyncio
async def test_patch_dm_limits_changes_value(client, admin_token):
    token, admin_uid = admin_token
    headers = {"Authorization": f"Bearer {token}"}
    r = await client.patch(
        "/admin/dm-limits",
        json={"dm_attachment_max_size_bytes": 52428800, "dm_attachment_max_count_per_message": 8},
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json() == {
        "dm_attachment_max_size_bytes": 52428800,
        "dm_attachment_max_count_per_message": 8,
    }

    # Audit log captured the change with from/to payload.
    r = await client.get("/admin/audit-log", headers=headers)
    entries = r.json()
    assert len(entries) == 1
    e = entries[0]
    assert e["action"] == "dm_limits.patch"
    assert int(e["actor_id"]) == admin_uid
    assert e["payload"]["dm_attachment_max_size_bytes"] == {
        "from": 26214400,
        "to": 52428800,
    }
    assert e["payload"]["dm_attachment_max_count_per_message"] == {"from": 4, "to": 8}


@pytest.mark.asyncio
async def test_patch_dm_limits_partial(client, admin_token):
    token, _ = admin_token
    headers = {"Authorization": f"Bearer {token}"}
    # Only update one field — the other stays at default.
    r = await client.patch(
        "/admin/dm-limits",
        json={"dm_attachment_max_count_per_message": 10},
        headers=headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["dm_attachment_max_size_bytes"] == 26214400  # unchanged
    assert body["dm_attachment_max_count_per_message"] == 10


@pytest.mark.asyncio
async def test_patch_dm_limits_no_audit_when_unchanged(client, admin_token):
    token, _ = admin_token
    headers = {"Authorization": f"Bearer {token}"}
    # Sending the same values is a no-op — should not append an audit entry.
    r = await client.patch(
        "/admin/dm-limits",
        json={"dm_attachment_max_size_bytes": 26214400},
        headers=headers,
    )
    assert r.status_code == 200
    r = await client.get("/admin/audit-log", headers=headers)
    assert r.json() == []


@pytest.mark.asyncio
async def test_patch_dm_limits_rejects_out_of_range(client, admin_token):
    token, _ = admin_token
    headers = {"Authorization": f"Bearer {token}"}
    r = await client.patch(
        "/admin/dm-limits",
        json={"dm_attachment_max_size_bytes": 0},  # below the 1024-byte floor
        headers=headers,
    )
    assert r.status_code == 422
