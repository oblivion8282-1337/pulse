"""Owner-only cloud-wide oversight routes (``/owner/*``).

Gated by ``require_owner`` — stricter than admin. The owner claim only
resolves in cloud mode (self-host tokens never carry it), so every happy-path
test opts into ``cloud_mode``. Covers:

* community list gating (401 no token / 403 admin-but-not-owner) + happy path
  with member count + storage aggregation,
* emergency reported-content access (404 unknown report, happy path returns
  the message + an audit row, media metadata without bytes).
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

pytestmark = pytest.mark.usefixtures("cloud_mode")


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _seed_guild(session_factory, *, owner_id: int, name: str = "Test") -> int:
    from dcc_chat_gateway.models import Guild
    from dcc_chat_gateway.snowflake import next_id

    gid = next_id()
    async with session_factory() as s:
        s.add(Guild(id=gid, name=name, owner_id=owner_id))
        await s.commit()
    return gid


# ─── /owner/communities ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_communities_401_without_token(client):
    r = await client.get("/owner/communities")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_communities_403_for_admin_but_not_owner(client, admin_token):
    token, _ = admin_token
    r = await client.get("/owner/communities", headers=_auth(token))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_communities_lists_with_member_count(
    client, owner_token, session_factory, second_member
):
    token, owner_uid = owner_token
    gid = await _seed_guild(session_factory, owner_id=owner_uid, name="Alpha")
    # Owner + one extra member → member_count == 2.
    await second_member(gid, owner_uid)
    await second_member(gid, owner_uid + 1)

    r = await client.get("/owner/communities", headers=_auth(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["next_before"] is None  # short page → no cursor
    row = next(c for c in body["communities"] if c["id"] == str(gid))
    assert row["name"] == "Alpha"
    assert row["owner_id"] == str(owner_uid)  # snowflake as string
    assert row["member_count"] == 2
    assert row["storage_bytes"] == 0
    assert row["is_public"] is False


@pytest.mark.asyncio
async def test_communities_search_filters_by_name(
    client, owner_token, session_factory
):
    token, owner_uid = owner_token
    await _seed_guild(session_factory, owner_id=owner_uid, name="Gardening")
    await _seed_guild(session_factory, owner_id=owner_uid, name="Racing")

    r = await client.get("/owner/communities?q=garden", headers=_auth(token))
    assert r.status_code == 200
    names = [c["name"] for c in r.json()["communities"]]
    assert "Gardening" in names
    assert "Racing" not in names


# ─── suspend / unsuspend + enforcement ───────────────────────────────────────


async def _guild_with_channel(client, _auth_signer):
    """Register a fresh user, create a guild (they become owner+member) and a
    channel. Returns (member_token, guild_id, channel_id)."""
    import uuid as _uuid

    uid = abs(hash(_uuid.uuid4())) & ((1 << 31) - 1)
    token = _auth_signer.issue_access(uid, f"u{uid}")
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    c = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general"},
            headers=_auth(token),
        )
    ).json()
    return token, g["id"], c["id"]


@pytest.mark.asyncio
async def test_suspend_requires_owner(client, admin_token):
    token, _ = admin_token
    r = await client.post("/owner/communities/123/suspend", json={}, headers=_auth(token))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_suspend_unknown_guild_404(client, owner_token):
    token, _ = owner_token
    r = await client.post(
        "/owner/communities/999999/suspend", json={}, headers=_auth(token)
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_suspend_freezes_members_then_unsuspend_restores(
    client, owner_token, _auth_signer
):
    member_token, gid, cid = await _guild_with_channel(client, _auth_signer)
    owner_tok, _ = owner_token

    # Baseline: the guild owner (a normal member) can post.
    r = await client.post(
        f"/channels/{cid}/messages", json={"content": "hi"}, headers=_auth(member_token)
    )
    assert r.status_code == 201, r.text

    # Operator suspends → the community is frozen.
    r = await client.post(
        f"/owner/communities/{gid}/suspend",
        json={"reason": "abuse under review"},
        headers=_auth(owner_tok),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["suspended"] is True
    assert body["suspended_reason"] == "abuse under review"

    # Frozen: even the guild's own owner can't post OR read.
    r = await client.post(
        f"/channels/{cid}/messages", json={"content": "again"}, headers=_auth(member_token)
    )
    assert r.status_code == 403
    r = await client.get(f"/channels/{cid}/messages", headers=_auth(member_token))
    assert r.status_code == 403

    # It still shows in the owner list flagged suspended.
    listing = (await client.get("/owner/communities", headers=_auth(owner_tok))).json()
    row = next(c for c in listing["communities"] if c["id"] == str(gid))
    assert row["suspended"] is True

    # Unsuspend → access restored.
    r = await client.post(
        f"/owner/communities/{gid}/unsuspend", headers=_auth(owner_tok)
    )
    assert r.status_code == 200
    assert r.json()["suspended"] is False
    r = await client.post(
        f"/channels/{cid}/messages", json={"content": "back"}, headers=_auth(member_token)
    )
    assert r.status_code == 201, r.text


# ─── /owner/communities/{id}/limits ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_set_limits_requires_owner(client, admin_token):
    token, _ = admin_token
    r = await client.patch(
        "/owner/communities/123/limits", json={}, headers=_auth(token)
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_set_and_clear_community_limits(client, owner_token, session_factory):
    token, owner_uid = owner_token
    gid = await _seed_guild(session_factory, owner_id=owner_uid, name="Boosted")

    # Set overrides (incl. higher-than-default = a boost).
    r = await client.patch(
        f"/owner/communities/{gid}/limits",
        json={
            "voice_bitrate_max_kbps": 256,
            "stream_bitrate_max_kbps": 50000,
            "stream_fps_max": 120,
            "stream_resolution_max": "4K",
            "attachment_max_size_bytes": 52428800,
            "attachment_max_count_per_message": 10,
            "attachment_storage_quota_bytes": 5368709120,
            "max_members": 500,
            "max_channels": 50,
            "max_roles": 30,
            "max_concurrent_streams": 4,
        },
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["voice_bitrate_max_kbps"] == 256
    assert body["stream_bitrate_max_kbps"] == 50000
    assert body["stream_fps_max"] == 120
    assert body["stream_resolution_max"] == "4K"
    assert body["attachment_max_size_bytes"] == 52428800
    assert body["attachment_max_count_per_message"] == 10
    assert body["attachment_storage_quota_bytes"] == 5368709120
    assert body["max_members"] == 500
    assert body["max_channels"] == 50
    assert body["max_roles"] == 30
    assert body["max_concurrent_streams"] == 4

    # Clear back to inherit (null).
    r = await client.patch(
        f"/owner/communities/{gid}/limits",
        json={
            "voice_bitrate_max_kbps": None,
            "stream_bitrate_max_kbps": None,
            "stream_fps_max": None,
            "stream_resolution_max": None,
        },
        headers=_auth(token),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["voice_bitrate_max_kbps"] is None
    assert body["stream_resolution_max"] is None


@pytest.mark.asyncio
async def test_set_limits_rejects_bad_resolution(client, owner_token, session_factory):
    token, owner_uid = owner_token
    gid = await _seed_guild(session_factory, owner_id=owner_uid)
    r = await client.patch(
        f"/owner/communities/{gid}/limits",
        json={"stream_resolution_max": "8K"},
        headers=_auth(token),
    )
    assert r.status_code == 422


# ─── /owner/reports/{id}/content ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_reported_content_403_for_admin(client, admin_token):
    token, _ = admin_token
    r = await client.get("/owner/reports/123/content", headers=_auth(token))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_reported_content_404_unknown_report(client, owner_token):
    token, _ = owner_token
    r = await client.get("/owner/reports/999999/content", headers=_auth(token))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_reported_content_returns_message_and_audits(
    client, owner_token, session_factory
):
    from dcc_chat_gateway.models import AdminAuditLog, Message, Report
    from dcc_chat_gateway.snowflake import next_id
    from sqlalchemy import select

    token, owner_uid = owner_token
    channel_id = next_id()
    author_id = owner_uid + 7
    msg_id = next_id()
    report_id = next_id()
    async with session_factory() as s:
        s.add(
            Message(
                id=msg_id,
                channel_id=channel_id,
                author_id=author_id,
                content="the offending text",
                created_at=datetime.now(timezone.utc),
            )
        )
        s.add(
            Report(
                id=report_id,
                reporter_user_id=owner_uid + 1,
                target_message_id=msg_id,
                target_channel_id=channel_id,
                reason_code="harassment",
                body="please review",
            )
        )
        await s.commit()

    r = await client.get(
        f"/owner/reports/{report_id}/content", headers=_auth(token)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["report_id"] == str(report_id)
    assert body["reason_code"] == "harassment"
    assert body["content"] == "the offending text"
    assert body["author_id"] == str(author_id)
    assert body["message_id"] == str(msg_id)
    assert body["deleted"] is False
    assert body["attachments"] == []

    # The emergency view is audit-logged (owner looked at member-only content).
    async with session_factory() as s:
        rows = (
            await s.execute(
                select(AdminAuditLog).where(
                    AdminAuditLog.action == "owner.view_reported_content"
                )
            )
        ).scalars().all()
    assert len(rows) == 1
    assert rows[0].actor_id == owner_uid
    assert rows[0].payload["report_id"] == str(report_id)
