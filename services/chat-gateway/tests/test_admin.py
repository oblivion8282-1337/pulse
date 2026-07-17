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
    # Empty fresh DB — counts are always 0.
    assert body["guild_count"] == 0
    assert body["channel_count"] == 0
    assert body["dm_channel_count"] == 0
    assert body["messages_24h"] == 0
    # storage_bytes reflects the live MinIO bucket (s3.total_bucket_bytes()).
    # It can be None (MinIO unreachable), 0 (empty bucket), or a positive
    # integer when the dev bucket contains avatar uploads from previous runs.
    # We only assert the type/range — not the exact value — so the test is
    # bucket-state agnostic and doesn't flake on dirty local MinIO instances.
    assert body["storage_bytes"] is None or (
        isinstance(body["storage_bytes"], int) and body["storage_bytes"] >= 0
    )


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


# ─── Permissions ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_permissions_returns_defaults(client, admin_token):
    token, _ = admin_token
    r = await client.get(
        "/admin/permissions", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 200
    assert r.json() == {
        "allow_guild_creation": True,
        "allow_member_invites": True,
        "locked": False,
        "instance_name": None,
        "guild_sound_max_size_bytes": 524288,
        "hq_bitrate_min_kbps": 1000,
        "hq_bitrate_max_kbps": 10000,
        "hq_fps_min": 1,
        "hq_fps_max": 360,
        "hq_resolution_max": "Native",
        "ns_bitrate_min_kbps": 1000,
        "ns_bitrate_max_kbps": 10000,
        "ns_fps_min": 1,
        "ns_fps_max": 240,
        "ns_resolution_max": "native",
        "cam_resolution_max": "720p",
        "cam_fps_max": 30,
        "voice_bitrate_max_kbps": 128,
    }


@pytest.mark.asyncio
async def test_patch_permissions_records_audit(client, admin_token):
    token, _ = admin_token
    headers = {"Authorization": f"Bearer {token}"}
    r = await client.patch(
        "/admin/permissions",
        json={"allow_guild_creation": False, "allow_member_invites": False},
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json() == {
        "allow_guild_creation": False,
        "allow_member_invites": False,
        "locked": False,
        "instance_name": None,
        "guild_sound_max_size_bytes": 524288,
        "hq_bitrate_min_kbps": 1000,
        "hq_bitrate_max_kbps": 10000,
        "hq_fps_min": 1,
        "hq_fps_max": 360,
        "hq_resolution_max": "Native",
        "ns_bitrate_min_kbps": 1000,
        "ns_bitrate_max_kbps": 10000,
        "ns_fps_min": 1,
        "ns_fps_max": 240,
        "ns_resolution_max": "native",
        "cam_resolution_max": "720p",
        "cam_fps_max": 30,
        "voice_bitrate_max_kbps": 128,
    }
    log = (await client.get("/admin/audit-log", headers=headers)).json()
    entry = next(e for e in log if e["action"] == "permissions.patch")
    assert entry["payload"]["allow_guild_creation"] == {"from": True, "to": False}
    assert entry["payload"]["allow_member_invites"] == {"from": True, "to": False}


@pytest.mark.asyncio
async def test_patch_voice_bitrate_cap(client, admin_token):
    token, _ = admin_token
    headers = {"Authorization": f"Bearer {token}"}
    # Senken wirkt und landet im Payload.
    r = await client.patch(
        "/admin/permissions", json={"voice_bitrate_max_kbps": 96}, headers=headers
    )
    assert r.status_code == 200
    assert r.json()["voice_bitrate_max_kbps"] == 96
    # Außerhalb der Grenzen (16-512) → Validierungsfehler, Wert unverändert.
    r = await client.patch(
        "/admin/permissions", json={"voice_bitrate_max_kbps": 600}, headers=headers
    )
    assert r.status_code == 422
    r = await client.get("/admin/permissions", headers=headers)
    assert r.json()["voice_bitrate_max_kbps"] == 96


@pytest.mark.asyncio
async def test_permissions_non_admin_blocked(client, access_token):
    token, _ = access_token
    r = await client.get(
        "/admin/permissions", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_patch_hq_stream_limits(client, admin_token):
    token, _ = admin_token
    headers = {"Authorization": f"Bearer {token}"}
    r = await client.patch(
        "/admin/permissions",
        json={
            "hq_bitrate_min_kbps": 2000,
            "hq_bitrate_max_kbps": 8000,
            "hq_fps_min": 24,
            "hq_fps_max": 60,
            "hq_resolution_max": "1080p",
        },
        headers=headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["hq_bitrate_min_kbps"] == 2000
    assert body["hq_bitrate_max_kbps"] == 8000
    assert body["hq_fps_min"] == 24
    assert body["hq_fps_max"] == 60
    assert body["hq_resolution_max"] == "1080p"
    # Surfaced to every client via /capabilities, not just the admin route.
    caps = (await client.get("/capabilities", headers=headers)).json()
    assert caps["hq_resolution_max"] == "1080p"
    assert caps["hq_fps_max"] == 60


@pytest.mark.asyncio
async def test_patch_hq_limits_rejects_inverted_band(client, admin_token):
    token, _ = admin_token
    headers = {"Authorization": f"Bearer {token}"}
    # min > max on a single side (partial patch) must be rejected against the
    # stored max (10000), keeping the singleton coherent.
    r = await client.patch(
        "/admin/permissions",
        json={"hq_bitrate_min_kbps": 20000},
        headers=headers,
    )
    assert r.status_code == 422
    # Unknown resolution value rejected by the schema validator.
    r2 = await client.patch(
        "/admin/permissions",
        json={"hq_resolution_max": "8K"},
        headers=headers,
    )
    assert r2.status_code == 422


@pytest.mark.asyncio
async def test_patch_normal_stream_limits(client, admin_token):
    token, _ = admin_token
    headers = {"Authorization": f"Bearer {token}"}
    r = await client.patch(
        "/admin/permissions",
        json={
            "ns_bitrate_max_kbps": 3000,
            "ns_fps_max": 30,
            "ns_resolution_max": "720p",
        },
        headers=headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ns_bitrate_max_kbps"] == 3000
    assert body["ns_fps_max"] == 30
    assert body["ns_resolution_max"] == "720p"
    # HQ limits stay independent (separate value set).
    assert body["hq_resolution_max"] == "Native"
    caps = (await client.get("/capabilities", headers=headers)).json()
    assert caps["ns_resolution_max"] == "720p"

    # ns uses its own resolution set — an HQ-only value ('4K') is rejected.
    r2 = await client.patch(
        "/admin/permissions", json={"ns_resolution_max": "4K"}, headers=headers
    )
    assert r2.status_code == 422
    # Inverted ns band rejected against the stored max.
    r3 = await client.patch(
        "/admin/permissions", json={"ns_bitrate_min_kbps": 9000}, headers=headers
    )
    assert r3.status_code == 422


@pytest.mark.asyncio
async def test_patch_instance_name_broadcasts_live(client, admin_token, app):
    """Regression 2026-07-14: eine Umbenennung muss SOFORT bei allen
    verbundenen Mitgliedern ankommen (Live-Broadcast), nicht erst beim
    nächsten ``ready``. Der ``permissions_updated``-Broadcast trägt den
    Namen: gesetzt → der Name, zurückgesetzt → "", unverändert → None."""
    token, _ = admin_token
    headers = {"Authorization": f"Bearer {token}"}

    captured: list = []

    async def _capture(envelope):
        captured.append(envelope)

    app.state.connection_manager.publish_guild_event = _capture

    # (1) Setzen → Broadcast trägt den Namen.
    r = await client.patch(
        "/admin/permissions", json={"instance_name": "Mein Server"}, headers=headers
    )
    assert r.status_code == 200
    assert captured, "kein Broadcast beim Umbenennen"
    assert captured[-1].op == "permissions_updated"
    assert captured[-1].instance_name == "Mein Server"

    # (2) Zurücksetzen (leer) → Broadcast trägt "" (Adresse zeigen), nicht None.
    captured.clear()
    r = await client.patch(
        "/admin/permissions", json={"instance_name": ""}, headers=headers
    )
    assert r.status_code == 200
    assert captured[-1].instance_name == ""

    # (3) Anderes Feld ändern, Name NICHT anfassen → instance_name bleibt None
    #     (Feld unverändert), damit Clients ihren Namen nicht fälschlich leeren.
    captured.clear()
    r = await client.patch(
        "/admin/permissions", json={"allow_guild_creation": False}, headers=headers
    )
    assert r.status_code == 200
    assert captured[-1].instance_name is None
