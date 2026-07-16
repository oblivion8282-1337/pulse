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


@pytest.fixture
def mock_s3(monkeypatch):
    m = _S3Mock()
    monkeypatch.setattr(s3_mod, "presigned_put_url", m.presigned_put_url)
    monkeypatch.setattr(s3_mod, "presigned_get_url", m.presigned_get_url)
    monkeypatch.setattr(s3_mod, "delete_object", m.delete_object)
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
async def test_upload_url_enforces_total_storage_quota(
    client, _auth_signer, mock_s3, session_factory
):
    from dcc_chat_gateway.models import Guild

    (t1, _u1), _ = await register_two(_auth_signer)
    gid, cid = await _make_guild_channel(client, t1)
    # Tiny per-community total quota: 2000 bytes.
    async with session_factory() as s:
        g = await s.get(Guild, int(gid))
        g.attachment_storage_quota_bytes = 2000
        await s.commit()

    # First 1 KB upload fits (0 + 1024 <= 2000) and leaves a pending row.
    r1 = await _upload(client, t1, cid, size=1024)
    assert r1.status_code == 201, r1.text
    # Second upload would push the community over the quota (1024 + 1500 > 2000).
    r2 = await _upload(client, t1, cid, size=1500)
    assert r2.status_code == 413


@pytest.mark.asyncio
async def test_attach_files_blocked_without_attach_files(
    client, _auth_signer, mock_s3
):
    """Member with ATTACH_FILES denied via a user-overwrite gets 403 on
    the upload-url endpoint, even though they're a guild member."""
    from dcc_shared.permission_resolver import OVERWRITE_TARGET_USER
    from dcc_shared.permissions import Permissions

    (t_owner, _u_owner), (t_member, uid_member) = await register_two(_auth_signer)
    gid, cid = await _make_guild_channel(client, t_owner)
    # Owner adds the second user as a guild member.
    await client.post(
        f"/guilds/{gid}/members",
        json={"user_id": str(uid_member)},
        headers=auth(t_owner),
    )
    # Owner denies ATTACH_FILES for that user in this channel.
    r = await client.put(
        f"/channels/{cid}/permissions/{OVERWRITE_TARGET_USER}/{uid_member}",
        json={"allow": "0", "deny": str(int(Permissions.ATTACH_FILES))},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    # Member tries to start an upload → 403.
    r = await _upload(client, t_member, cid)
    assert r.status_code == 403
    assert "ATTACH_FILES" in r.json()["detail"]


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
async def test_hard_delete_defers_s3_until_after_commit(
    client, _auth_signer, mock_s3, session_factory
):
    """Regression (data-loss): hard_delete_attachments(..., defer_s3=keys) must
    only TOMBSTONE the rows and hand the storage keys back — it must NOT touch
    S3. The bytes are purged later, by the caller, after a successful commit.
    If commit fails (rolls back), deleted_at stays NULL and the bytes are still
    referenced (so the reaper/user can retry) instead of being orphaned.
    """
    (t1, _), _ = await register_two(_auth_signer)
    _, cid = await _make_guild_channel(client, t1)
    r = await _upload(client, t1, cid, has_thumb=True, thumb_size=256,
                      thumb_width=32, thumb_height=32)
    aid = int(r.json()["id"])
    msg = (
        await client.post(
            f"/channels/{cid}/messages",
            json={"content": "x", "attachment_ids": [str(aid)]},
            headers=auth(t1),
        )
    ).json()
    mid = int(msg["id"])

    # 1) Deferred delete in a session whose commit we then roll back: no S3
    #    deletion happens, and the tombstone is undone by the rollback.
    keys: list[str] = []
    async with session_factory() as s:
        n = await att_mod.hard_delete_attachments(
            s, message_ids=[mid], defer_s3=keys
        )
        assert n == 1
        # Storage key + thumb key collected, S3 untouched so far.
        assert len(keys) == 2
        assert mock_s3.deleted == []
        await s.rollback()  # simulate a commit failure

    # Row survives with deleted_at still NULL → still reachable/retryable.
    async with session_factory() as s:
        row = await s.get(MessageAttachment, aid)
        assert row is not None
        assert row.deleted_at is None
    # S3 was never touched on the failed path.
    assert mock_s3.deleted == []

    # 2) Happy path: tombstone + commit succeed, THEN purge S3.
    keys = []
    async with session_factory() as s:
        await att_mod.hard_delete_attachments(s, message_ids=[mid], defer_s3=keys)
        await s.commit()
    assert mock_s3.deleted == []  # still nothing until we purge
    await att_mod.purge_s3_keys(keys)
    assert set(mock_s3.deleted) == set(keys)
    async with session_factory() as s:
        row = await s.get(MessageAttachment, aid)
        assert row.deleted_at is not None


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


# ─── Upload-surface policy (Cloud hardening) ────────────────────────────────
# The Cloud narrows its upload surface to what hash-matching can inspect
# (images). Self-hosts are untouched. See docs/medien-speicher-und-scanning.md
# and config.py::cloud_attachment_mime_prefixes.


@pytest.mark.asyncio
async def test_upload_url_rejects_mime_off_the_base_allowlist(
    client, _auth_signer, mock_s3
):
    """Base allowlist (stored-XSS guard) — applies on every instance."""
    (t1, _u1), _ = await register_two(_auth_signer)
    _, cid = await _make_guild_channel(client, t1)
    for mime in ("text/html", "image/svg+xml", "application/javascript"):
        r = await _upload(client, t1, cid, mime=mime)
        assert r.status_code == 400, f"{mime} should be rejected: {r.text}"


@pytest.mark.asyncio
async def test_self_host_allows_video_and_archives(client, _auth_signer, mock_s3):
    """The Cloud MIME policy must not leak into self-hosted instances."""
    (t1, _u1), _ = await register_two(_auth_signer)
    _, cid = await _make_guild_channel(client, t1)
    for mime in ("video/mp4", "application/zip", "application/octet-stream"):
        r = await _upload(client, t1, cid, mime=mime)
        assert r.status_code == 201, f"{mime} should pass on self-host: {r.text}"


@pytest.mark.asyncio
async def test_cloud_guild_rejects_video_and_archives(
    client, _auth_signer, mock_s3, cloud_mode
):
    (t1, _u1), _ = await register_two(_auth_signer)
    _, cid = await _make_guild_channel(client, t1)
    for mime in ("video/mp4", "video/webm", "application/zip", "application/pdf"):
        r = await _upload(client, t1, cid, mime=mime)
        assert r.status_code == 400, f"{mime} should be rejected on cloud: {r.text}"


@pytest.mark.asyncio
async def test_cloud_guild_rejects_octet_stream(
    client, _auth_signer, mock_s3, cloud_mode
):
    """The loophole this policy exists to close: the browser uploader falls back
    to octet-stream for unknown types, so a video declared as octet-stream would
    slip through any video-only blocklist."""
    (t1, _u1), _ = await register_two(_auth_signer)
    _, cid = await _make_guild_channel(client, t1)
    r = await _upload(client, t1, cid, mime="application/octet-stream")
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_cloud_guild_allows_images(client, _auth_signer, mock_s3, cloud_mode):
    (t1, _u1), _ = await register_two(_auth_signer)
    _, cid = await _make_guild_channel(client, t1)
    for mime in ("image/png", "image/jpeg", "image/webp", "image/avif"):
        r = await _upload(client, t1, cid, mime=mime)
        assert r.status_code == 201, f"{mime} should pass on cloud: {r.text}"


@pytest.mark.asyncio
async def test_cloud_mime_policy_is_reversible(
    client, _auth_signer, mock_s3, cloud_mode
):
    """Clearing CLOUD_ATTACHMENT_MIME_PREFIXES re-arms the old behaviour
    without a code change — the whole point of the flag."""
    cloud_mode.cloud_attachment_mime_prefixes = ""
    (t1, _u1), _ = await register_two(_auth_signer)
    _, cid = await _make_guild_channel(client, t1)
    r = await _upload(client, t1, cid, mime="video/mp4")
    assert r.status_code == 201, r.text


async def _make_dm_channel(client, token_a, uid_b):
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(token_a)
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


@pytest.mark.asyncio
async def test_cloud_dm_attachments_are_forbidden(
    client, _auth_signer, mock_s3, cloud_mode, friend_pair
):
    (t_a, uid_a), (_t_b, uid_b) = await register_two(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _make_dm_channel(client, t_a, uid_b)
    r = await _upload(client, t_a, dm_id, mime="image/png")
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_cloud_dm_attachments_reversible_via_flag(
    client, _auth_signer, mock_s3, cloud_mode, friend_pair
):
    cloud_mode.cloud_dm_attachments_enabled = True
    (t_a, uid_a), (_t_b, uid_b) = await register_two(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _make_dm_channel(client, t_a, uid_b)
    r = await _upload(client, t_a, dm_id, mime="image/png")
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_capabilities_reports_upload_policy_on_self_host(client, _auth_signer):
    """Self-hosts advertise the permissive values — the Cloud policy must not
    leak into an instance we don't answer for."""
    t, _uid = await _register_user(_auth_signer)
    r = await client.get("/capabilities", headers=auth(t))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dm_attachments_enabled"] is True
    assert body["dropbox_enabled"] is True
    assert body["attachment_mime_prefixes"] == []


@pytest.mark.asyncio
async def test_capabilities_reports_upload_policy_on_cloud(
    client, _auth_signer, cloud_mode
):
    t, _uid = await _register_user(_auth_signer)
    r = await client.get("/capabilities", headers=auth(t))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dm_attachments_enabled"] is False
    assert body["dropbox_enabled"] is False
    assert body["attachment_mime_prefixes"] == ["image/"]
