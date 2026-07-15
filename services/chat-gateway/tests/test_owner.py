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
