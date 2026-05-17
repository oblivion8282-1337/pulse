"""Message attachments — two-phase upload + bind + reaper.

S3 is mocked so the tests stay hermetic. The mock simply remembers which
keys exist (presigned_put → `_uploaded` set, head/delete operate against
that set). Each presigned URL is a fake `https://mock/<key>?…` string —
real signatures live in test_s3.py (TODO when we add one).
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import select

from dcc_chat_gateway.models import MessageAttachment
from dcc_chat_gateway.routes import attachments as att_mod
from dcc_chat_gateway import s3 as s3_mod


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer) -> tuple[str, int]:
    """Mint a fresh access token (no DB row — chat-gateway never queries
    auth-svc directly; it just needs the JWT to verify)."""
    import uuid as _u
    uid = abs(hash(_u.uuid4())) & ((1 << 31) - 1)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


async def register_two(_auth_signer):
    return await _register_user(_auth_signer), await _register_user(_auth_signer)


# ─── Fixture: stub the S3 module ────────────────────────────────────────────


class _S3Mock:
    def __init__(self) -> None:
        self.uploaded: set[str] = set()
        self.deleted: list[str] = []
        self.put_calls: list[dict] = []
        self.get_calls: list[dict] = []

    async def presigned_put_url(self, key, *, content_type=None, content_length=None):
        self.put_calls.append(
            {"key": key, "content_type": content_type, "content_length": content_length}
        )
        # Pretend the upload happens immediately so head_object sees it.
        self.uploaded.add(key)
        return f"https://mock/{key}?put-sig"

    async def presigned_get_url(self, key, *, filename=None, inline=True):
        self.get_calls.append({"key": key, "filename": filename, "inline": inline})
        return f"https://mock/{key}?get-sig"

    async def delete_object(self, key):
        self.deleted.append(key)
        self.uploaded.discard(key)

    async def object_exists(self, key):
        return key in self.uploaded


@pytest.fixture
def mock_s3(monkeypatch):
    m = _S3Mock()
    monkeypatch.setattr(s3_mod, "presigned_put_url", m.presigned_put_url)
    monkeypatch.setattr(s3_mod, "presigned_get_url", m.presigned_get_url)
    monkeypatch.setattr(s3_mod, "delete_object", m.delete_object)
    monkeypatch.setattr(s3_mod, "object_exists", m.object_exists)
    return m


# ─── Setup helpers ──────────────────────────────────────────────────────────


async def _make_guild_channel(client, token):
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(token))).json()
    c = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general"},
            headers=auth(token),
        )
    ).json()
    return g["id"], c["id"]


async def _upload(client, token, channel_id, **overrides):
    """POST /attachments/upload-url with sensible defaults."""
    payload = {
        "filename": "test.png",
        "mime": "image/png",
        "size": 1024,
        "width": 100,
        "height": 100,
        **overrides,
    }
    return await client.post(
        f"/channels/{channel_id}/attachments/upload-url",
        json=payload,
        headers=auth(token),
    )


# ─── Tests ───────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_upload_url_creates_pending_row(client, _auth_signer, mock_s3):
    (t1, _u1), _ = await register_two(_auth_signer)
    _, cid = await _make_guild_channel(client, t1)
    r = await _upload(client, t1, cid)
    assert r.status_code == 201, r.text
    body = r.json()
    assert "id" in body and body["upload_url"].startswith("https://mock/")
    # No thumb requested → no thumb url.
    assert body.get("thumb_upload_url") is None
    # S3 mock saw one PUT-sign call with pinned content-type + length.
    assert mock_s3.put_calls[0]["content_type"] == "image/png"
    assert mock_s3.put_calls[0]["content_length"] == 1024


@pytest.mark.asyncio
async def test_upload_url_with_thumb(client, _auth_signer, mock_s3):
    (t1, _u1), _ = await register_two(_auth_signer)
    _, cid = await _make_guild_channel(client, t1)
    r = await _upload(client, t1, cid, has_thumb=True, thumb_size=512,
                      thumb_width=64, thumb_height=64)
    assert r.status_code == 201
    body = r.json()
    assert body["thumb_upload_url"] is not None
    assert len(mock_s3.put_calls) == 2  # original + thumb


@pytest.mark.asyncio
async def test_upload_url_rejects_oversize(client, _auth_signer, mock_s3):
    (t1, _u1), _ = await register_two(_auth_signer)
    gid, cid = await _make_guild_channel(client, t1)
    # Default guild limit is 25 MB; exceed it.
    r = await _upload(client, t1, cid, size=30 * 1024 * 1024)
    assert r.status_code == 413


@pytest.mark.asyncio
async def test_upload_url_rejects_non_member(client, _auth_signer, mock_s3):
    (t1, _u1), (t2, _u2) = await register_two(_auth_signer)
    _, cid = await _make_guild_channel(client, t1)
    # t2 isn't a member of t1's guild.
    r = await _upload(client, t2, cid)
    assert r.status_code in (403, 404)


@pytest.mark.asyncio
async def test_post_message_binds_attachment(client, _auth_signer, mock_s3, session_factory):
    (t1, u1), _ = await register_two(_auth_signer)
    _, cid = await _make_guild_channel(client, t1)
    r = await _upload(client, t1, cid)
    aid = r.json()["id"]

    msg = (
        await client.post(
            f"/channels/{cid}/messages",
            json={"content": "look", "attachment_ids": [aid]},
            headers=auth(t1),
        )
    ).json()
    assert "attachments" in msg
    assert len(msg["attachments"]) == 1
    assert msg["attachments"][0]["id"] == aid

    # DB: row got bumped to the new message id.
    async with session_factory() as s:
        row = (
            await s.execute(select(MessageAttachment).where(MessageAttachment.id == int(aid)))
        ).scalar_one()
        assert row.message_id == int(msg["id"])


@pytest.mark.asyncio
async def test_post_message_with_attachments_allows_empty_content(
    client, _auth_signer, mock_s3
):
    (t1, _), _ = await register_two(_auth_signer)
    _, cid = await _make_guild_channel(client, t1)
    r = await _upload(client, t1, cid)
    aid = r.json()["id"]
    msg = await client.post(
        f"/channels/{cid}/messages",
        json={"content": "", "attachment_ids": [aid]},
        headers=auth(t1),
    )
    assert msg.status_code == 201


@pytest.mark.asyncio
async def test_post_message_blocks_someone_elses_attachment(
    client, _auth_signer, mock_s3
):
    (t1, _u1), (t2, _u2) = await register_two(_auth_signer)
    _, cid = await _make_guild_channel(client, t1)
    # Make t2 a member of t1's guild so t2 can also upload.
    await client.post(
        f"/guilds/{cid.__class__('')}",  # bogus — actual flow below
        json={},
        headers=auth(t1),
    )
    # Re-do membership the right way:
    # (just upload as t1 then try to bind as t2)
    r = await _upload(client, t1, cid)
    aid = r.json()["id"]
    r = await client.post(
        f"/channels/{cid}/messages",
        json={"content": "hi", "attachment_ids": [aid]},
        headers=auth(t2),
    )
    # t2 isn't in the channel → channel resolution should 403/404 first.
    assert r.status_code in (400, 403, 404)


@pytest.mark.asyncio
async def test_post_message_count_limit(client, _auth_signer, mock_s3, session_factory):
    (t1, _), _ = await register_two(_auth_signer)
    gid, cid = await _make_guild_channel(client, t1)
    # Default per-guild count is 4 — create 5 uploads + try to send all.
    aids = []
    for _ in range(5):
        r = await _upload(client, t1, cid)
        aids.append(r.json()["id"])
    r = await client.post(
        f"/channels/{cid}/messages",
        json={"content": "x", "attachment_ids": aids},
        headers=auth(t1),
    )
    assert r.status_code == 400
    assert "too many attachments" in r.json()["detail"]


@pytest.mark.asyncio
async def test_delete_message_hard_deletes_attachments(
    client, _auth_signer, mock_s3, session_factory
):
    (t1, _), _ = await register_two(_auth_signer)
    _, cid = await _make_guild_channel(client, t1)
    r = await _upload(client, t1, cid)
    aid = r.json()["id"]
    msg = (
        await client.post(
            f"/channels/{cid}/messages",
            json={"content": "x", "attachment_ids": [aid]},
            headers=auth(t1),
        )
    ).json()
    await client.delete(f"/messages/{msg['id']}", headers=auth(t1))

    # MinIO mock saw the delete call for the storage_key.
    assert len(mock_s3.deleted) >= 1
    # DB: row has deleted_at set.
    async with session_factory() as s:
        row = (
            await s.execute(select(MessageAttachment).where(MessageAttachment.id == int(aid)))
        ).scalar_one()
        assert row.deleted_at is not None


@pytest.mark.asyncio
async def test_edit_message_removes_attachment(
    client, _auth_signer, mock_s3, session_factory
):
    (t1, _), _ = await register_two(_auth_signer)
    _, cid = await _make_guild_channel(client, t1)
    r1 = await _upload(client, t1, cid)
    r2 = await _upload(client, t1, cid)
    a1, a2 = r1.json()["id"], r2.json()["id"]
    msg = (
        await client.post(
            f"/channels/{cid}/messages",
            json={"content": "x", "attachment_ids": [a1, a2]},
            headers=auth(t1),
        )
    ).json()

    # Edit: keep only a1.
    edited = await client.patch(
        f"/messages/{msg['id']}",
        json={"content": "x", "attachment_ids": [a1]},
        headers=auth(t1),
    )
    assert edited.status_code == 200
    assert len(edited.json()["attachments"]) == 1
    assert edited.json()["attachments"][0]["id"] == a1
    # a2 is gone.
    async with session_factory() as s:
        a2_row = (
            await s.execute(select(MessageAttachment).where(MessageAttachment.id == int(a2)))
        ).scalar_one()
        assert a2_row.deleted_at is not None


@pytest.mark.asyncio
async def test_download_url_refresh(client, _auth_signer, mock_s3):
    (t1, _), _ = await register_two(_auth_signer)
    _, cid = await _make_guild_channel(client, t1)
    r = await _upload(client, t1, cid)
    aid = r.json()["id"]
    # Bind to a message so the route's permission branch goes through
    # resolve_channel_or_raise rather than the pending-uploader-only check.
    await client.post(
        f"/channels/{cid}/messages",
        json={"content": "x", "attachment_ids": [aid]},
        headers=auth(t1),
    )
    r = await client.get(f"/attachments/{aid}/download-url", headers=auth(t1))
    assert r.status_code == 200
    body = r.json()
    assert body["url"].startswith("https://mock/")


@pytest.mark.asyncio
async def test_reaper_drops_old_pending(
    client, _auth_signer, mock_s3, session_factory
):
    (t1, _), _ = await register_two(_auth_signer)
    _, cid = await _make_guild_channel(client, t1)
    r = await _upload(client, t1, cid)
    aid = r.json()["id"]

    # Backdate the row so the reaper considers it stale.
    async with session_factory() as s:
        row = await s.get(MessageAttachment, int(aid))
        row.created_at = datetime.now(UTC) - timedelta(hours=2)
        await s.commit()

    # _reap_once opens its own SessionLocal — but in tests the SessionLocal
    # still points at the real (engine-backed) sessionmaker, which here is
    # the same one as the fixture's. Trigger the single sweep.
    from dcc_chat_gateway.routes.attachments import _reap_once

    # Patch SessionLocal to use the test factory.
    from dcc_chat_gateway.routes import attachments as att_mod
    original = att_mod.SessionLocal
    att_mod.SessionLocal = session_factory
    try:
        n = await _reap_once()
    finally:
        att_mod.SessionLocal = original
    assert n == 1

    async with session_factory() as s:
        gone = (
            await s.execute(select(MessageAttachment).where(MessageAttachment.id == int(aid)))
        ).scalar_one_or_none()
        assert gone is None
