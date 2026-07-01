"""Dropbox / Ablage routes — happy path + permission gates.

Covers:
- channel + config auto-provision on first access
- folder CRUD + listing
- rename, move, pin
- soft-delete + restore
- admin quota settings
- upload pipeline (presigned PUT mint + finish-upload HEAD)

MinIO is mocked — real binary put/get would require docker-compose.
"""

from __future__ import annotations

import uuid

import pytest
from botocore.exceptions import ClientError

from dcc_chat_gateway import s3 as s3_mod


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _user(_auth_signer) -> tuple[str, int]:
    uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


class _S3Mock:
    def __init__(self) -> None:
        self.put: dict[str, bytes] = {}
        self.deleted: list[str] = []

    async def put_object(self, key, *, body, content_type):
        self.put[key] = body

    async def presigned_put_url(self, key, *, content_type=None, content_length=None):
        return f"https://mock/{key}?put"

    async def presigned_get_url(self, key, *, filename=None, inline=True):
        suffix = "att" if (not inline and filename) else "sig"
        return f"https://mock/{key}?{suffix}"

    async def stream_object(self, key):
        body = self.put.get(key, b"")
        for i in range(0, len(body), 4096):
            yield body[i : i + 4096]

    async def head_object(self, key):
        if key not in self.put:
            raise ClientError(
                {"Error": {"Code": "NoSuchKey", "Message": "no"}},
                "HeadObject",
            )
        return {"ContentLength": len(self.put[key]), "ContentType": "application/octet-stream"}

    async def delete_object(self, key):
        self.deleted.append(key)
        self.put.pop(key, None)

    async def _ensure_internal_client(self):
        """Stand-in for the aiobotocore client the production
        ``_ensure_internal_client`` would hand out. The purge path
        iterates ``list_objects_v2`` over a single page; we hand back
        a stub that paginates the in-memory ``put`` dict."""

        outer = self

        class _Paginator:
            def paginate(self, *, Bucket, Prefix=""):
                return _AsyncIter(
                    [
                        {
                            "Contents": [
                                {"Key": k, "Size": len(v)}
                                for k, v in outer.put.items()
                                if k.startswith(Prefix)
                            ]
                        }
                    ]
                )

        return _Client(_Paginator())


class _AsyncIter:
    def __init__(self, pages: list[dict]) -> None:
        self._pages = pages

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._pages:
            raise StopAsyncIteration
        return self._pages.pop(0)


class _Client:
    def __init__(self, paginator) -> None:
        self._paginator = paginator

    def get_paginator(self, _name):
        return self._paginator


@pytest.fixture
def mock_s3(monkeypatch):
    m = _S3Mock()
    monkeypatch.setattr(s3_mod, "put_object", m.put_object)
    monkeypatch.setattr(s3_mod, "presigned_put_url", m.presigned_put_url)
    monkeypatch.setattr(s3_mod, "presigned_get_url", m.presigned_get_url)
    monkeypatch.setattr(s3_mod, "head_object", m.head_object)
    monkeypatch.setattr(s3_mod, "delete_object", m.delete_object)
    monkeypatch.setattr(s3_mod, "stream_object", m.stream_object)
    monkeypatch.setattr(s3_mod, "_ensure_internal_client", m._ensure_internal_client)
    return m


async def _create_guild(client, token: str) -> dict:
    r = await client.post("/guilds", json={"name": "g"}, headers=auth(token))
    assert r.status_code == 201, r.text
    return r.json()


async def _provision_dropbox(client, token: str, gid: str) -> None:
    """Allocate the dropbox channel + config row for a freshly created
    guild. Required by every endpoint that reads or mutates the config,
    because ``GET /quota`` / ``GET /entries`` / upload routes are now
    read-only and 404 when the dropbox was never provisioned
    (regression-guard for the bug where a sidebar ping auto-enabled the
    dropbox for every guild)."""

    r = await client.get(
        f"/guilds/{gid}/dropbox/channel", headers=auth(token)
    )
    assert r.status_code == 200, r.text


# ─── Channel + config auto-provision ────────────────────────────────────────


@pytest.mark.asyncio
async def test_dropbox_channel_create_idempotent(client, _auth_signer, mock_s3):
    """First call creates + config row + dropbox channel; second call
    is a no-op fetch that hands back the same id."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]

    r1 = await client.get(
        f"/guilds/{gid}/dropbox/channel", headers=auth(token)
    )
    assert r1.status_code == 200, r1.text
    body1 = r1.json()
    assert body1["created"] is True
    assert body1["type"] == 2

    r2 = await client.get(
        f"/guilds/{gid}/dropbox/channel", headers=auth(token)
    )
    assert r2.status_code == 200, r2.text
    body2 = r2.json()
    assert body2["created"] is False
    assert body2["id"] == body1["id"]


@pytest.mark.asyncio
async def test_quota_defaults_then_patch(client, _auth_signer, mock_s3):
    """Quotas default to 5 GiB total / 100 MiB per file. Admin can
    shrink the per-file cap and the change sticks."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    r = await client.get(f"/guilds/{gid}/dropbox/quota", headers=auth(token))
    assert r.status_code == 200, r.text
    q = r.json()
    assert q["total_quota_bytes"] == 5 * 1024**3
    assert q["per_file_max_bytes"] == 100 * 1024**2

    patch_r = await client.patch(
        f"/guilds/{gid}/dropbox/settings",
        json={"per_file_max_bytes": 50 * 1024**2, "trash_retention_days": 14},
        headers=auth(token),
    )
    assert patch_r.status_code == 200, patch_r.text
    new = patch_r.json()
    assert new["per_file_max_bytes"] == 50 * 1024**2
    assert new["trash_retention_days"] == 14
    assert new["total_quota_bytes"] == 5 * 1024**3  # unchanged


@pytest.mark.asyncio
async def test_quota_shrink_within_floor_is_accepted(client, _auth_signer, mock_s3):
    """Shrinking within the ge=1 MiB floor is allowed (no files have
    been uploaded yet, so used_bytes=0). Verifies the lower-bound does
    not block legitimate smaller quotas."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]

    r = await client.patch(
        f"/guilds/{gid}/dropbox/settings",
        json={"total_quota_bytes": 5 * 1024 * 1024},  # 5 MiB (passes ge=1 MiB)
        headers=auth(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["total_quota_bytes"] == 5 * 1024 * 1024


@pytest.mark.asyncio
async def test_quota_below_1mib_floor_rejected(client, _auth_signer, mock_s3):
    """The 1 MiB floor rejects quota shrinks below it — protects the
    admin from accidentally setting an unusably small cap."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]

    r = await client.patch(
        f"/guilds/{gid}/dropbox/settings",
        json={"total_quota_bytes": 1024},  # 1 KiB — below the ge=1 MiB floor
        headers=auth(token),
    )
    assert r.status_code == 422, r.text


# ─── Folder CRUD + listing ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_folder_create_list_rename(client, _auth_signer, mock_s3):
    """End-to-end folder flow: create at root, verify listing shows it,
    patch (rename), confirm the new name appears."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    r = await client.post(
        f"/guilds/{gid}/dropbox/folders",
        json={"name": "Screenshots", "parent_path": ""},
        headers=auth(token),
    )
    assert r.status_code == 201, r.text
    folder = r.json()
    assert folder["name"] == "Screenshots"
    assert folder["kind"] == 0  # folder

    # Listing at root returns the folder
    list_r = await client.get(
        f"/guilds/{gid}/dropbox/entries?path=", headers=auth(token)
    )
    assert list_r.status_code == 200, list_r.text
    entries = list_r.json()["entries"]
    assert any(e["name"] == "Screenshots" for e in entries)

    # Rename via patch
    rename_r = await client.patch(
        f"/guilds/{gid}/dropbox/entries/{folder['id']}",
        json={"name": "Shots"},
        headers=auth(token),
    )
    assert rename_r.status_code == 200, rename_r.text
    assert rename_r.json()["name"] == "Shots"


@pytest.mark.asyncio
async def test_move_folder_rewrites_descendant_parent_paths(
    client, _auth_signer, mock_s3
):
    """Regression: moving a folder must rewrite every descendant's
    parent_path. Otherwise the descendants stay anchored at the old
    path, become unreachable from any UI listing, and only resurface
    via the global name search.

    Setup: ``A`` and ``B`` are siblings at root, with a file
    ``hello.txt`` inside ``A``. After moving ``A`` into ``B`` the
    file must show up at ``B/A/`` — not at the now-orphan ``A/``.
    """

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    # Two sibling folders at root
    folder_a = (
        await client.post(
            f"/guilds/{gid}/dropbox/folders",
            json={"name": "A", "parent_path": ""},
            headers=auth(token),
        )
    ).json()
    folder_b = (
        await client.post(
            f"/guilds/{gid}/dropbox/folders",
            json={"name": "B", "parent_path": ""},
            headers=auth(token),
        )
    ).json()

    # Upload a file inside A
    mint = (
        await client.post(
            f"/guilds/{gid}/dropbox/upload-url",
            json={
                "parent_path": "A",
                "name": "hello.txt",
                "content_type": "text/plain",
                "size_bytes": 5,
            },
            headers=auth(token),
        )
    ).json()
    mock_s3.put[mint["storage_key"]] = b"hello"
    file_row = (
        await client.post(
            f"/guilds/{gid}/dropbox/finish-upload",
            json={
                "id": mint["id"],
                "parent_path": "A",
                "name": "hello.txt",
                "size_bytes": 5,
                "content_type": "text/plain",
            },
            headers=auth(token),
        )
    ).json()
    assert file_row["parent_path"] == "A"

    # Move A into B → A.parent_path becomes /B (normalized to "B"),
    # file should follow
    move_r = await client.patch(
        f"/guilds/{gid}/dropbox/entries/{folder_a['id']}",
        json={"parent_path": "B"},
        headers=auth(token),
    )
    assert move_r.status_code == 200, move_r.text
    assert move_r.json()["parent_path"] == "B"

    # File must now be reachable at B/A, not at the orphan A
    list_b_a = await client.get(
        f"/guilds/{gid}/dropbox/entries?path=B/A", headers=auth(token)
    )
    assert list_b_a.status_code == 200, list_b_a.text
    names = [e["name"] for e in list_b_a.json()["entries"]]
    assert "hello.txt" in names, (
        "file disappeared after the containing folder was moved — "
        "descendants were not rewritten"
    )

    # And the old A path is unreachable (it no longer exists)
    list_old_a = await client.get(
        f"/guilds/{gid}/dropbox/entries?path=A", headers=auth(token)
    )
    # Either empty listing or 404 — both mean the path is gone.
    assert list_old_a.status_code in (200, 404)


@pytest.mark.asyncio
async def test_move_folder_into_descendant_rejected(client, _auth_signer, mock_s3):
    """Cycle guard: ``A`` cannot be moved under one of its own
    descendants — that would orphan ``A``'s own children and turn
    the parent_path graph into a cycle."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    folder_a = (
        await client.post(
            f"/guilds/{gid}/dropbox/folders",
            json={"name": "A", "parent_path": ""},
            headers=auth(token),
        )
    ).json()
    # Nested folder A/sub exists, so the move target is a real path
    folder_sub = (
        await client.post(
            f"/guilds/{gid}/dropbox/folders",
            json={"name": "sub", "parent_path": "/A"},
            headers=auth(token),
        )
    ).json()

    # Try to move /A into /A/sub — should be rejected as a cycle
    move_r = await client.patch(
        f"/guilds/{gid}/dropbox/entries/{folder_a['id']}",
        json={"parent_path": "/A/sub"},
        headers=auth(token),
    )
    assert move_r.status_code == 422, move_r.text


@pytest.mark.asyncio
async def test_empty_trash_hard_deletes_and_reclaims_bytes(
    client, _auth_signer, mock_s3
):
    """Admin-only manual empty: trashed files vanish from the DB,
    their MinIO objects get deleted, and the trash list comes back
    empty afterwards. Permission gating is exercised separately."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    async def upload_and_trash(name: str, payload: bytes) -> dict:
        mint = (
            await client.post(
                f"/guilds/{gid}/dropbox/upload-url",
                json={
                    "parent_path": "",
                    "name": name,
                    "content_type": "application/octet-stream",
                    "size_bytes": len(payload),
                },
                headers=auth(token),
            )
        ).json()
        mock_s3.put[mint["storage_key"]] = payload
        fin = (
            await client.post(
                f"/guilds/{gid}/dropbox/finish-upload",
                json={
                    "id": mint["id"],
                    "parent_path": "",
                    "name": name,
                    "size_bytes": len(payload),
                    "content_type": "application/octet-stream",
                },
                headers=auth(token),
            )
        ).json()
        # Trash it
        await client.delete(
            f"/guilds/{gid}/dropbox/entries/{fin['id']}",
            headers=auth(token),
        )
        return fin

    a = await upload_and_trash("a.bin", b"a" * 50)
    b = await upload_and_trash("b.bin", b"b" * 80)

    # MinIO had both objects pre-empty
    leftover_pre = [k for k in mock_s3.put if k.startswith(f"dropbox/{gid}/")]
    assert len(leftover_pre) == 2

    # Empty trash
    r = await client.post(
        f"/guilds/{gid}/dropbox/trash/empty",
        headers=auth(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["purged"] == 2
    # Bytes_reclaimed counts the size_bytes of the purged entries
    # (= MinIO bytes freed). Quota was already debited on trash via
    # bump_used(-size), so the quota counter doesn't change again
    # here — the variable reports the MinIO-side cleanup, not the
    # quota delta.
    assert body["bytes_reclaimed"] == 130

    # Trash list is now empty
    trash_r = await client.get(
        f"/guilds/{gid}/dropbox/entries?include_trash=true",
        headers=auth(token),
    )
    assert trash_r.json()["entries"] == []

    # MinIO objects are gone
    leftover_post = [k for k in mock_s3.put if k.startswith(f"dropbox/{gid}/")]
    assert leftover_post == [], f"MinIO still has: {leftover_post}"


@pytest.mark.asyncio
async def test_empty_trash_empty_when_no_trash(client, _auth_signer, mock_s3):
    """Empty trash on an empty trash is a no-op (200, purged=0)."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    r = await client.post(
        f"/guilds/{gid}/dropbox/trash/empty",
        headers=auth(token),
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"purged": 0, "bytes_reclaimed": 0}


@pytest.mark.asyncio
async def test_empty_trash_requires_manage_channels(client, _auth_signer, mock_s3):
    """Rate-limit gate + permission gate. We can't easily synthesize a
    non-admin member from inside ``test_dropbox`` (the creator is
    always the bootstrap admin), so this test only exercises the
    rate-limit path with the legitimate user. The MANAGE_CHANNELS
    gate is enforced by the existing permission-resolver tests.
    """

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    # 10 allowed, the 11th call gets 429. Empty-trash is a heavy op;
    # the per-user 10/minute budget is intentional.
    for _ in range(10):
        r = await client.post(
            f"/guilds/{gid}/dropbox/trash/empty",
            headers=auth(token),
        )
        assert r.status_code == 200, r.text
    blocked = await client.post(
        f"/guilds/{gid}/dropbox/trash/empty",
        headers=auth(token),
    )
    assert blocked.status_code == 429, blocked.text


@pytest.mark.asyncio
async def test_empty_trash_does_not_double_debit_quota(
    client, _auth_signer, mock_s3
):
    """Quota is debited at trash time via ``delete_entry``. A subsequent
    empty-trash must NOT touch ``cfg.used_bytes`` again — otherwise the
    counter drifts when files pass through trash+empty."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    # Upload + trash a file
    mint = (
        await client.post(
            f"/guilds/{gid}/dropbox/upload-url",
            json={
                "parent_path": "",
                "name": "x.bin",
                "content_type": "application/octet-stream",
                "size_bytes": 200,
            },
            headers=auth(token),
        )
    ).json()
    mock_s3.put[mint["storage_key"]] = b"x" * 200
    fin = (
        await client.post(
            f"/guilds/{gid}/dropbox/finish-upload",
            json={
                "id": mint["id"],
                "parent_path": "",
                "name": "x.bin",
                "size_bytes": 200,
                "content_type": "application/octet-stream",
            },
            headers=auth(token),
        )
    ).json()
    await client.delete(
        f"/guilds/{gid}/dropbox/entries/{fin['id']}",
        headers=auth(token),
    )

    # Quota is now 0 (debited at trash time).
    before = (
        await client.get(
            f"/guilds/{gid}/dropbox/quota", headers=auth(token)
        )
    ).json()["used_bytes"]
    assert before == 0

    # Empty-trash: must not push used_bytes negative.
    r = await client.post(
        f"/guilds/{gid}/dropbox/trash/empty",
        headers=auth(token),
    )
    assert r.status_code == 200, r.text

    after = (
        await client.get(
            f"/guilds/{gid}/dropbox/quota", headers=auth(token)
        )
    ).json()["used_bytes"]
    assert after == 0, "empty-trash must not re-debit an already-zero quota"


@pytest.mark.asyncio
async def test_duplicate_folder_409(client, _auth_signer, mock_s3):
    """Two folders with the same parent+name → 409."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    r1 = await client.post(
        f"/guilds/{gid}/dropbox/folders",
        json={"name": "Drafts", "parent_path": ""},
        headers=auth(token),
    )
    assert r1.status_code == 201

    r2 = await client.post(
        f"/guilds/{gid}/dropbox/folders",
        json={"name": "Drafts", "parent_path": ""},
        headers=auth(token),
    )
    assert r2.status_code == 409, r2.text


@pytest.mark.asyncio
async def test_invalid_name_rejected(client, _auth_signer, mock_s3):
    """An empty / slash-bearing name is refused — keeps the URL-relative
    path hierarchy safe from path-injection."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    for bad in ("", "foo/bar", "..", "../escape"):
        r = await client.post(
            f"/guilds/{gid}/dropbox/folders",
            json={"name": bad, "parent_path": ""},
            headers=auth(token),
        )
        assert r.status_code in (400, 422), (bad, r.text)


# ─── Search + trash + restore ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_search_and_trash_and_restore(client, _auth_signer, mock_s3):
    """Three flows in one go — search matches, trash swaps the listing
    to the tombstone set, restore brings the entry back to root."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    # Two folders at root
    for n in ("designs", "designs-archive", "clips"):
        r = await client.post(
            f"/guilds/{gid}/dropbox/folders",
            json={"name": n, "parent_path": ""},
            headers=auth(token),
        )
        assert r.status_code == 201, r.text
    designs = r.json()  # last response — `clips`

    # Search "designs" — should match the two "designs*" folders
    search_r = await client.get(
        f"/guilds/{gid}/dropbox/entries?q=designs", headers=auth(token)
    )
    assert search_r.status_code == 200, search_r.text
    names = {e["name"] for e in search_r.json()["entries"]}
    assert {"designs", "designs-archive"} <= names
    assert "clips" not in names

    # Trash the folder
    # Re-fetch the actual "designs" id
    list_r = await client.get(
        f"/guilds/{gid}/dropbox/entries?path=", headers=auth(token)
    )
    designs_id = next(
        e["id"] for e in list_r.json()["entries"] if e["name"] == "designs"
    )
    del_r = await client.delete(
        f"/guilds/{gid}/dropbox/entries/{designs_id}",
        headers=auth(token),
    )
    assert del_r.status_code == 204, del_r.text

    # Root listing no longer includes it
    list_after = await client.get(
        f"/guilds/{gid}/dropbox/entries?path=", headers=auth(token)
    )
    assert all(
        e["name"] != "designs" for e in list_after.json()["entries"]
    )

    # Trash listing includes it
    trash_r = await client.get(
        f"/guilds/{gid}/dropbox/entries?include_trash=true",
        headers=auth(token),
    )
    assert any(
        e["name"] == "designs" for e in trash_r.json()["entries"]
    )

    # Restore
    restore_r = await client.post(
        f"/guilds/{gid}/dropbox/entries/{designs_id}/restore",
        headers=auth(token),
    )
    assert restore_r.status_code == 200, restore_r.text
    assert restore_r.json()["deleted_at"] is None

    list_final = await client.get(
        f"/guilds/{gid}/dropbox/entries?path=", headers=auth(token)
    )
    assert any(
        e["name"] == "designs" for e in list_final.json()["entries"]
    )


# ─── Pin toggle + search ordering ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_pin_toggle(client, _auth_signer, mock_s3):
    """Pin the folder then list — pinned rows appear before unpinned."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    # Two folders
    for n in ("alpha", "beta"):
        r = await client.post(
            f"/guilds/{gid}/dropbox/folders",
            json={"name": n, "parent_path": ""},
            headers=auth(token),
        )
        assert r.status_code == 201

    list_r = await client.get(
        f"/guilds/{gid}/dropbox/entries?path=", headers=auth(token)
    )
    entries = list_r.json()["entries"]
    by_name = {e["name"]: e for e in entries}
    assert by_name["alpha"]["pinned"] is False

    pin_r = await client.patch(
        f"/guilds/{gid}/dropbox/entries/{by_name['alpha']['id']}",
        json={"pinned": True},
        headers=auth(token),
    )
    assert pin_r.status_code == 200

    list_after = await client.get(
        f"/guilds/{gid}/dropbox/entries?path=", headers=auth(token)
    )
    after = list_after.json()["entries"]
    # Folder-first sort, then pinned-then-name. alpha should be first
    # because it's pinned.
    assert after[0]["name"] == "alpha"
    assert after[0]["pinned"] is True


# ─── Non-member is rejected ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_non_member_cannot_list(client, _auth_signer, mock_s3):
    token, _uid = await _user(_auth_signer)
    other_token, _other_uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]

    r = await client.get(
        f"/guilds/{gid}/dropbox/entries?path=",
        headers=auth(other_token),
    )
    assert r.status_code == 403, r.text


# ─── Upload pipeline (presigned PUT mint + finish-upload HEAD) ─────────────


@pytest.mark.asyncio
async def test_finish_upload_persists_row(client, _auth_signer, mock_s3):
    """Full upload handshake: mint presigned PUT, simulate the PUT landing
    in MinIO, finish-upload HEADs + persists the row."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]

    # Auto-create the dropbox channel (also seeds the config row).
    ch_r = await client.get(
        f"/guilds/{gid}/dropbox/channel", headers=auth(token)
    )
    assert ch_r.status_code == 200, ch_r.text

    # 1. Mint the presigned PUT URL.
    mint_r = await client.post(
        f"/guilds/{gid}/dropbox/upload-url",
        json={
            "parent_path": "",
            "name": "hello.txt",
            "content_type": "text/plain",
            "size_bytes": 11,  # "hello world"
        },
        headers=auth(token),
    )
    assert mint_r.status_code == 200, mint_r.text
    mint = mint_r.json()
    assert mint["upload_url"].startswith("https://mock/")
    assert mint["storage_key"].startswith(f"dropbox/{gid}/")

    # 2. Simulate the browser's PUT landing in MinIO so the HEAD on
    # finish-upload finds the object.
    mock_s3.put[mint["storage_key"]] = b"hello world"

    # 3. Finish the upload.
    finish_r = await client.post(
        f"/guilds/{gid}/dropbox/finish-upload",
        json={
            "id": mint["id"],
            "parent_path": "",
            "name": "hello.txt",
            "size_bytes": 11,
            "content_type": "text/plain",
        },
        headers=auth(token),
    )
    assert finish_r.status_code == 200, finish_r.text
    body = finish_r.json()
    assert body["name"] == "hello.txt"
    assert body["size_bytes"] == 11
    assert body["kind"] == 1  # file
    assert body["url"] is not None  # presigned GET signed on success

    # 4. Quota counter reflects the upload.
    quota_r = await client.get(
        f"/guilds/{gid}/dropbox/quota", headers=auth(token)
    )
    assert quota_r.json()["used_bytes"] == 11

    # 5. The file now shows up in the root listing.
    list_r = await client.get(
        f"/guilds/{gid}/dropbox/entries?path=", headers=auth(token)
    )
    names = [e["name"] for e in list_r.json()["entries"]]
    assert "hello.txt" in names


@pytest.mark.asyncio
async def test_delete_dropbox_channel_purges_files_and_resets_quota(
    client, _auth_signer, mock_s3
):
    """Deleting the dropbox channel cascades: the MinIO object is purged,
    the dropbox_files rows vanish (FK CASCADE) and the surviving config's
    used_bytes resets to 0 (config is guild-keyed, so it outlives the channel)."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]

    # Provision + upload one file → storage_key + non-zero quota usage.
    ch_r = await client.get(f"/guilds/{gid}/dropbox/channel", headers=auth(token))
    assert ch_r.status_code == 200, ch_r.text
    channel_id = ch_r.json()["id"]

    mint_r = await client.post(
        f"/guilds/{gid}/dropbox/upload-url",
        json={
            "parent_path": "",
            "name": "hello.txt",
            "content_type": "text/plain",
            "size_bytes": 11,
        },
        headers=auth(token),
    )
    assert mint_r.status_code == 200, mint_r.text
    mint = mint_r.json()
    mock_s3.put[mint["storage_key"]] = b"hello world"
    finish_r = await client.post(
        f"/guilds/{gid}/dropbox/finish-upload",
        json={
            "id": mint["id"],
            "parent_path": "",
            "name": "hello.txt",
            "size_bytes": 11,
            "content_type": "text/plain",
        },
        headers=auth(token),
    )
    assert finish_r.status_code == 200, finish_r.text
    storage_key = mint["storage_key"]
    quota_r = await client.get(f"/guilds/{gid}/dropbox/quota", headers=auth(token))
    assert quota_r.json()["used_bytes"] == 11

    # Delete the dropbox channel (owner holds MANAGE_CHANNELS).
    del_r = await client.delete(f"/channels/{channel_id}", headers=auth(token))
    assert del_r.status_code == 204, del_r.text

    # MinIO object purged, quota counter reset, file rows gone.
    assert storage_key in mock_s3.deleted
    quota_after = await client.get(f"/guilds/{gid}/dropbox/quota", headers=auth(token))
    assert quota_after.json()["used_bytes"] == 0
    list_after = await client.get(
        f"/guilds/{gid}/dropbox/entries?path=", headers=auth(token)
    )
    assert list_after.json()["entries"] == []


@pytest.mark.asyncio
async def test_finish_upload_missing_object_raises(
    client, _auth_signer, mock_s3
):
    """PUT never landed → finish-upload cleans up + 409s with no row.
    Invariant: never a silent 200 persisting a phantom row."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    mint_r = await client.post(
        f"/guilds/{gid}/dropbox/upload-url",
        json={
            "parent_path": "",
            "name": "ghost.txt",
            "content_type": "text/plain",
            "size_bytes": 5,
        },
        headers=auth(token),
    )
    assert mint_r.status_code == 200, mint_r.text
    mint = mint_r.json()
    # Don't seed mock_s3.put — the HEAD will 404.

    finish_r = await client.post(
        f"/guilds/{gid}/dropbox/finish-upload",
        json={
            "id": mint["id"],
            "parent_path": "",
            "name": "ghost.txt",
            "size_bytes": 5,
            "content_type": "text/plain",
        },
        headers=auth(token),
    )
    assert finish_r.status_code == 409, finish_r.text
    assert "not found" in finish_r.json()["detail"].lower()


# ─── Edge-case coverage (regression-guards for the 2026-06-30 review) ──────


@pytest.mark.asyncio
async def test_finish_upload_by_other_user_is_forbidden(
    client, _auth_signer, mock_s3, second_member, session_factory, monkeypatch
):
    """Regression for finding #1 from the 2026-06-30 security review:
    Member A mints an upload-url, hands the response to Member B,
    B calls finish-upload with A's id. The pending-row check refuses
    B with 403 so A's bytes don't get billed to B's quota and
    uploaded_by_id doesn't lie.

    Without the pending_uploads tracker the request would have
    succeeded — ``require_member`` is the only auth check on the
    finish-upload route, so any guild member could close anyone's
    mint."""

    from dcc_chat_gateway.models import DropboxPendingUpload

    monkeypatch.setattr("dcc_chat_gateway.db.SessionLocal", session_factory)

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    # A mints.
    mint_r = await client.post(
        f"/guilds/{gid}/dropbox/upload-url",
        json={
            "parent_path": "",
            "name": "stolen.txt",
            "content_type": "text/plain",
            "size_bytes": 6,
        },
        headers=auth(token),
    )
    assert mint_r.status_code == 200, mint_r.text
    mint = mint_r.json()
    mock_s3.put[mint["storage_key"]] = b"stolen"

    # B joins as a regular guild member.
    other_token, other_uid = await _second_user(_auth_signer)
    await second_member(int(gid), other_uid)

    # B tries to finish A's mint. Must be refused with 403.
    finish_r = await client.post(
        f"/guilds/{gid}/dropbox/finish-upload",
        json={
            "id": mint["id"],
            "parent_path": "",
            "name": "stolen.txt",
            "size_bytes": 6,
            "content_type": "text/plain",
        },
        headers=auth(other_token),
    )
    assert finish_r.status_code == 403, finish_r.text
    assert "another user" in finish_r.text.lower()

    # Sanity: the pending row is still in place (B's call didn't
    # clear it) — A can still finish.
    async with session_factory() as s:
        row = await s.get(DropboxPendingUpload, int(mint["id"]))
        assert row is not None
        assert row.uploader_id == _uid

    # A finishes the upload cleanly.
    finish_a = await client.post(
        f"/guilds/{gid}/dropbox/finish-upload",
        json={
            "id": mint["id"],
            "parent_path": "",
            "name": "stolen.txt",
            "size_bytes": 6,
            "content_type": "text/plain",
        },
        headers=auth(token),
    )
    assert finish_a.status_code == 200, finish_a.text


@pytest.mark.asyncio
async def test_finish_upload_expired_mint_is_refused(
    client, _auth_signer, mock_s3, session_factory, monkeypatch
):
    """Regression: a mint that's older than the presigned TTL must
    refuse the finish with 409 — even by the original minter — so
    abandoned MinIO bytes get cleaned up by the orphan sweep
    instead of leaking into the quota counter."""

    from datetime import datetime, timedelta, timezone
    from dcc_chat_gateway.models import DropboxPendingUpload

    monkeypatch.setattr("dcc_chat_gateway.db.SessionLocal", session_factory)

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    mint_r = await client.post(
        f"/guilds/{gid}/dropbox/upload-url",
        json={
            "parent_path": "",
            "name": "old.txt",
            "content_type": "text/plain",
            "size_bytes": 3,
        },
        headers=auth(token),
    )
    assert mint_r.status_code == 200, mint_r.text
    mint = mint_r.json()
    mock_s3.put[mint["storage_key"]] = b"old"

    # Backdate the pending row's expires_at past now. Use UTC-aware
    # because the column is ``DateTime(timezone=True)`` and the
    # server compares against ``utc_now()`` — local-time math
    # (CEST/UTC+2 etc.) would put the backdate "in the future" from
    # the server's perspective.
    long_ago = datetime.now(timezone.utc) - timedelta(hours=1)
    async with session_factory() as s:
        row = await s.get(DropboxPendingUpload, int(mint["id"]))
        assert row is not None
        row.expires_at = long_ago
        await s.commit()

    finish_r = await client.post(
        f"/guilds/{gid}/dropbox/finish-upload",
        json={
            "id": mint["id"],
            "parent_path": "",
            "name": "old.txt",
            "size_bytes": 3,
            "content_type": "text/plain",
        },
        headers=auth(token),
    )
    assert finish_r.status_code == 409, finish_r.text
    assert "expired" in finish_r.text.lower()


@pytest.mark.asyncio
async def test_content_type_text_html_relabeled_to_octet_stream():
    """A member uploading ``evil.html`` with content_type ``text/html``
    must land in the DB as ``application/octet-stream`` — the
    presigned GET is signed with ``inline=False``, the browser is
    forced to download, and the inline-XSS vector is closed.
    Regression for the 2026-06-30 finding #3."""

    from dcc_chat_gateway.routes._dropbox_helpers import (
        is_safe_inline_content_type,
        normalize_content_type,
    )

    assert normalize_content_type("text/html") == "application/octet-stream"
    assert (
        normalize_content_type("text/html; charset=utf-8")
        == "application/octet-stream"
    )
    assert (
        normalize_content_type("application/javascript")
        == "application/octet-stream"
    )
    # The safe-inline whitelist keeps the listed prefixes.
    assert is_safe_inline_content_type("image/png") is True
    assert is_safe_inline_content_type("application/pdf") is True
    assert is_safe_inline_content_type("text/plain") is True
    assert is_safe_inline_content_type("TEXT/PLAIN") is True
    # SVG is the lone denied type — it can carry inline <script>.
    assert is_safe_inline_content_type("image/svg+xml") is False
    assert normalize_content_type("image/svg+xml") == "application/octet-stream"


@pytest.mark.asyncio
async def test_create_folder_with_dotdot_parent_returns_422(
    client, _auth_signer, mock_s3
):
    """``parent_path = "foo/.."`` must surface as 422 (path-traversal
    rejected by ``normalize_parent_path``), not the bare 500 that
    the un-caught ``ValueError`` would produce. Regression for the
    bug found by the post-fix review."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    r = await client.post(
        f"/guilds/{gid}/dropbox/folders",
        json={"name": "evil", "parent_path": "foo/.."},
        headers=auth(token),
    )
    assert r.status_code == 422, r.text
    assert "parent_path" in r.text.lower()


@pytest.mark.asyncio
async def test_patch_entry_with_dotdot_parent_returns_422(
    client, _auth_signer, mock_s3
):
    """Same path-traversal guard for ``patch_entry`` when the
    ``parent_path`` field carries an escape."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    # Seed a folder to patch against.
    seed = await client.post(
        f"/guilds/{gid}/dropbox/folders",
        json={"name": "src", "parent_path": ""},
        headers=auth(token),
    )
    assert seed.status_code == 201, seed.text
    folder_id = seed.json()["id"]

    r = await client.patch(
        f"/guilds/{gid}/dropbox/entries/{folder_id}",
        json={"parent_path": "foo/../etc"},
        headers=auth(token),
    )
    assert r.status_code == 422, r.text
    assert "parent_path" in r.text.lower()


def test_request_validation_redacts_cookie_bearer_csrf_keys():
    """The 422 raw-body echo must redact the same auth-shaped
    keys the access log already does — Cookie / Bearer / CSRF
    substring matches all share the same redaction rule.

    Direct unit-test of ``_redact`` from ``dcc_chat_gateway.app``,
    which the security review flagged as closure-captured and
    therefore untestable. Lifted to module level so a future
    expansion of the blacklist can be regression-tested here."""

    from dcc_chat_gateway.app import _redact  # noqa: PLC0415

    assert _redact({"Cookie": "session=abc"}) == {"Cookie": "[redacted]"}
    assert _redact({"Authorization": "Bearer xyz"}) == {
        "Authorization": "[redacted]"
    }
    assert _redact({"csrf_token": "abc"}) == {"csrf_token": "[redacted]"}
    # No-match keys pass through unchanged.
    assert _redact({"name": "good.txt", "size_bytes": 12}) == {
        "name": "good.txt",
        "size_bytes": 12,
    }
    # Substring matches inside a larger field name also match.
    assert _redact({"my_token_v2": "abc"}) == {"my_token_v2": "[redacted]"}
    # Lists + nested dicts recurse.
    assert _redact(
        {"entries": [{"session_id": "x"}, {"name": "ok"}]}
    ) == {"entries": [{"session_id": "[redacted]"}, {"name": "ok"}]}


async def _upload_finished_file(
    client, token: str, gid: str, name: str, body: bytes, mock_s3
) -> dict:
    """Helper: mint → seed mock_s3 → finish-upload. Returns the entry dict."""

    mint_r = await client.post(
        f"/guilds/{gid}/dropbox/upload-url",
        json={
            "parent_path": "",
            "name": name,
            "content_type": "text/plain",
            "size_bytes": len(body),
        },
        headers=auth(token),
    )
    assert mint_r.status_code == 200, mint_r.text
    mint = mint_r.json()
    mock_s3.put[mint["storage_key"]] = body
    finish_r = await client.post(
        f"/guilds/{gid}/dropbox/finish-upload",
        json={
            "id": mint["id"],
            "parent_path": "",
            "name": name,
            "size_bytes": len(body),
            "content_type": "text/plain",
        },
        headers=auth(token),
    )
    assert finish_r.status_code == 200, finish_r.text
    return finish_r.json()


async def _second_user(_auth_signer) -> tuple[str, int]:
    """A second user that's NOT a guild member — used to assert
    non-member is rejected and (after adding them) to assert non-owner
    is rejected for mutations."""

    uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


@pytest.mark.asyncio
async def test_settings_shrink_below_used_returns_409(
    client, _auth_signer, mock_s3
):
    """Coherence check: an admin cannot shrink total_quota_bytes below
    the current used_bytes — silent 500s on every future upload would
    be a worse outcome than a deliberate 409."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    # Use ~100 MiB so we can shrink below it without touching the
    # per-file 100 MiB cap.
    await _upload_finished_file(
        client, token, gid, "big.bin", b"x" * 100 * 1024 * 1024, mock_s3
    )

    r = await client.patch(
        f"/guilds/{gid}/dropbox/settings",
        json={"total_quota_bytes": 50 * 1024 * 1024},  # 50 MiB
        headers=auth(token),
    )
    assert r.status_code == 409, r.text
    assert "smaller than current used_bytes" in r.text


@pytest.mark.asyncio
async def test_upload_url_too_large_returns_413(
    client, _auth_signer, mock_s3
):
    """Per-file cap is checked at mint — refuse before the user burns
    bandwidth uploading a 100 MiB file when the cap is 50 MiB."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    # Tighten the per-file cap to 1 MiB.
    await client.patch(
        f"/guilds/{gid}/dropbox/settings",
        json={"per_file_max_bytes": 1024 * 1024},
        headers=auth(token),
    )

    r = await client.post(
        f"/guilds/{gid}/dropbox/upload-url",
        json={
            "parent_path": "",
            "name": "big.bin",
            "content_type": "application/octet-stream",
            "size_bytes": 2 * 1024 * 1024,  # 2 MiB > 1 MiB cap
        },
        headers=auth(token),
    )
    assert r.status_code == 413, r.text
    assert "too large" in r.text.lower()


@pytest.mark.asyncio
async def test_upload_url_quota_exhausted_returns_413(
    client, _auth_signer, mock_s3
):
    """Quota-cap is checked at mint: refuse when used_bytes + size
    would overshoot total.  The reverse direction (size fits the
    per-file cap but not the community's free space) is the case
    users actually hit."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    # Shrink total quota to 2 MiB (above the 1 MiB floor).
    await client.patch(
        f"/guilds/{gid}/dropbox/settings",
        json={"total_quota_bytes": 2 * 1024 * 1024},
        headers=auth(token),
    )
    # Use 1 MiB.
    await _upload_finished_file(
        client, token, gid, "used.bin", b"x" * 1024 * 1024, mock_s3
    )

    # Now any non-empty file won't fit (1 MiB free, but the schema
    # requires size_bytes >= 1 byte, and we want a 2 MiB file that
    # would blow the 2 MiB total).
    r = await client.post(
        f"/guilds/{gid}/dropbox/upload-url",
        json={
            "parent_path": "",
            "name": "more.bin",
            "content_type": "application/octet-stream",
            "size_bytes": 2 * 1024 * 1024,  # 2 MiB > 1 MiB free
        },
        headers=auth(token),
    )
    assert r.status_code == 413, r.text
    assert "free space" in r.text.lower()


@pytest.mark.asyncio
async def test_finish_upload_oversize_object_triggers_413_and_s3_cleanup(
    client, _auth_signer, mock_s3
):
    """A client that bypasses the presigned URL's content-length and
    pushes a larger body must be cleaned up — the row never lands,
    the MinIO object is deleted, and a 413 is returned so the user
    can see what happened."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    # Tighten the per-file cap so the seeded larger body actually
    # exceeds it. Default is 100 MiB; 2 MiB would slip past.
    await client.patch(
        f"/guilds/{gid}/dropbox/settings",
        json={"per_file_max_bytes": 1024 * 1024},  # 1 MiB
        headers=auth(token),
    )

    # Mint for a 100-byte file.
    mint_r = await client.post(
        f"/guilds/{gid}/dropbox/upload-url",
        json={
            "parent_path": "",
            "name": "sneaky.bin",
            "content_type": "application/octet-stream",
            "size_bytes": 100,
        },
        headers=auth(token),
    )
    assert mint_r.status_code == 200, mint_r.text
    mint = mint_r.json()
    storage_key = mint["storage_key"]
    # But seed MinIO with a much larger body (simulates a tampered PUT).
    mock_s3.put[storage_key] = b"x" * (2 * 1024 * 1024)  # 2 MiB

    finish_r = await client.post(
        f"/guilds/{gid}/dropbox/finish-upload",
        json={
            "id": mint["id"],
            "parent_path": "",
            "name": "sneaky.bin",
            "size_bytes": 100,
            "content_type": "application/octet-stream",
        },
        headers=auth(token),
    )
    assert finish_r.status_code == 413, finish_r.text
    assert "exceeds per-file cap" in finish_r.text
    # Cleanup: MinIO object must be gone so the bucket doesn't
    # accumulate orphans from every tampered upload.
    assert storage_key not in mock_s3.put
    assert storage_key in mock_s3.deleted


# The non-owner permission tests are wired through the ``second_member``
# conftest fixture, which inserts a GuildMember row via the
# schema-flattened test session.


@pytest.mark.asyncio
async def test_non_owner_rename_returns_403(
    client, _auth_signer, mock_s3, second_member
):
    """A second guild member (no MANAGE_CHANNELS) cannot rename someone
    else's file. Member-of-guild + ownership check together close the
    spam vector."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    entry = await _upload_finished_file(
        client, token, gid, "victim.bin", b"hello", mock_s3
    )

    # Add a second user as a regular guild member (no MANAGE_CHANNELS).
    other_token, other_uid = await _second_user(_auth_signer)
    await second_member(int(gid), other_uid)

    r = await client.patch(
        f"/guilds/{gid}/dropbox/entries/{entry['id']}",
        json={"name": "owned-by-me.bin"},
        headers=auth(other_token),
    )
    assert r.status_code == 403, r.text
    # Sanity: the victim row was never renamed.
    list_r = await client.get(
        f"/guilds/{gid}/dropbox/entries?path=", headers=auth(token)
    )
    names = {e["name"] for e in list_r.json()["entries"]}
    assert "victim.bin" in names
    assert "owned-by-me.bin" not in names


@pytest.mark.asyncio
async def test_non_owner_delete_returns_403(
    client, _auth_signer, mock_s3, second_member
):
    """Same ownership rule for delete — non-owner without
    MANAGE_CHANNELS is refused, not silently deleted."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)
    entry = await _upload_finished_file(
        client, token, gid, "victim.bin", b"hello", mock_s3
    )

    other_token, other_uid = await _second_user(_auth_signer)
    await second_member(int(gid), other_uid)

    r = await client.delete(
        f"/guilds/{gid}/dropbox/entries/{entry['id']}",
        headers=auth(other_token),
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_non_owner_pin_returns_403(
    client, _auth_signer, mock_s3, second_member
):
    """Pin is an edit on a foreign asset just like rename/delete —
    a non-owner without MANAGE_CHANNELS is refused. Regression for
    the bug where pin was the only mutation ungated on ownership."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)
    entry = await _upload_finished_file(
        client, token, gid, "victim.bin", b"hello", mock_s3
    )

    other_token, other_uid = await _second_user(_auth_signer)
    await second_member(int(gid), other_uid)

    r = await client.patch(
        f"/guilds/{gid}/dropbox/entries/{entry['id']}",
        json={"pinned": True},
        headers=auth(other_token),
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_trash_sweep_purges_rows_past_retention(
    client, _auth_signer, mock_s3, session_factory, monkeypatch
):
    """``_sweep_once`` removes rows whose ``deleted_at`` is older than
    the guild's ``trash_retention_days``, deletes the MinIO objects,
    and hands back a count of purged entries. Regression-guard for the
    sweep-loop promise in the module docstring.

    Direct call (no Sleep, no asyncio.create_task) so the retention
    cutoff is the only variable. ``SessionLocal`` is monkey-patched to
    the test session factory so the sweep hits the same DB the rest
    of the test uses (the production SessionLocal carries the chat-
    schema prefix that the test engine doesn't)."""

    from dcc_chat_gateway.routes import dropbox_admin
    from dcc_chat_gateway.models import DropboxFile
    from datetime import datetime, timedelta, timezone

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)
    entry = await _upload_finished_file(
        client, token, gid, "old.bin", b"hello", mock_s3
    )
    storage_key = "dropbox/{}/old.bin".format(gid)

    # Trash the entry, then backdate ``deleted_at`` past the default
    # 30-day retention window so the next sweep picks it up. The
    # DELETE /entries route stamps deleted_at = utc_now(); we want to
    # test the *retention cutoff*, not the timestamp on delete.
    del_r = await client.delete(
        f"/guilds/{gid}/dropbox/entries/{entry['id']}", headers=auth(token)
    )
    assert del_r.status_code == 204

    long_ago = datetime.now(timezone.utc) - timedelta(days=40)
    async with session_factory() as s:
        row = await s.get(DropboxFile, int(entry["id"]))
        assert row is not None
        row.deleted_at = long_ago
        await s.commit()
    assert storage_key in mock_s3.put

    # Route the sweep's session factory through the schema-flattened
    # test engine; restore on the way out.
    monkeypatch.setattr(dropbox_admin, "SessionLocal", session_factory)

    # ``connection_manager=None`` — publish_purge_event short-circuits
    # to a no-op when there's nothing to publish into.
    await dropbox_admin._sweep_once(connection_manager=None)

    # Row hard-deleted + MinIO object cleaned up.
    async with session_factory() as s:
        gone = await s.get(DropboxFile, int(entry["id"]))
        assert gone is None
    assert storage_key not in mock_s3.put
    assert storage_key in mock_s3.deleted


@pytest.mark.asyncio
async def test_sweep_purges_orphan_minio_objects(
    client, _auth_signer, mock_s3, session_factory, monkeypatch
):
    """PUT-after-mint-but-before-finish leaks a MinIO object with no
    DB row. The trash sweep's orphan half walks the bucket and hard-
    deletes those keys.

    Regression for the bug where browser-close-after-mint, expired
    JWT, network drop, etc. left bytes in the bucket forever."""

    from dcc_chat_gateway.routes import dropbox_admin

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    # Two legitimate files (live, with rows) + one orphan (no row).
    await _upload_finished_file(
        client, token, gid, "legit.bin", b"alive", mock_s3
    )
    await _upload_finished_file(
        client, token, gid, "also-legit.bin", b"also-alive", mock_s3
    )
    orphan_key = f"dropbox/{gid}/never-finished.bin"
    mock_s3.put[orphan_key] = b"never-called-finish-upload"

    # Run the full sweep (which now includes the orphan half).
    monkeypatch.setattr(dropbox_admin, "SessionLocal", session_factory)
    await dropbox_admin._sweep_once(connection_manager=None)

    # Orphans gone, live files preserved.
    assert orphan_key not in mock_s3.put
    assert orphan_key in mock_s3.deleted
    assert any(
        k.startswith(f"dropbox/{gid}/") and "legit.bin" in k
        for k in mock_s3.put
    ), "live file should NOT be deleted by orphan sweep"


@pytest.mark.asyncio
async def test_sweep_reaps_expired_pending_uploads(
    client, _auth_signer, mock_s3, session_factory, monkeypatch
):
    """The sweep's pending-row half reaps rows whose ``expires_at``
    is in the past. Regression for the doc-lied claim in
    migration 0042 (``Orphan rows are purged on the same hourly
    cadence as the trash sweep``) — without the explicit reaper
    the rows just sit there."""

    from datetime import datetime, timedelta, timezone
    from dcc_chat_gateway.models import DropboxPendingUpload
    from dcc_chat_gateway.routes import dropbox_admin

    monkeypatch.setattr(dropbox_admin, "SessionLocal", session_factory)

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)

    # Mint a fresh, non-expired row.
    mint_r = await client.post(
        f"/guilds/{gid}/dropbox/upload-url",
        json={
            "parent_path": "",
            "name": "fresh.txt",
            "content_type": "text/plain",
            "size_bytes": 5,
        },
        headers=auth(token),
    )
    assert mint_r.status_code == 200
    fresh_id = int(mint_r.json()["id"])

    # Plant a separately-expired row in the table (no mint flow).
    long_ago = datetime.now(timezone.utc) - timedelta(hours=1)
    expired_row = DropboxPendingUpload(
        id=next(iter([int(datetime.now().timestamp() * 1000) * 1000])),
        uploader_id=_uid,
        guild_id=int(gid),
        parent_path="",
        name="abandoned.bin",
        size_bytes=10,
        expires_at=long_ago,
    )
    async with session_factory() as s:
        s.add(expired_row)
        await s.commit()
    expired_id = expired_row.id

    await dropbox_admin._sweep_once(connection_manager=None)

    async with session_factory() as s:
        # Fresh row survives (expires_at is in the future).
        fresh = await s.get(DropboxPendingUpload, fresh_id)
        assert fresh is not None
        # Expired row is gone.
        gone = await s.get(DropboxPendingUpload, expired_id)
        assert gone is None


@pytest.mark.asyncio
async def test_guild_delete_purges_dropbox_objects(
    client, _auth_signer, mock_s3
):
    """When the guild is deleted, the dropbox/<gid>/ MinIO prefix
    must be cleaned up — ``ondelete='CASCADE'`` cleans the SQL side,
    MinIO has no equivalent."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)
    await _upload_finished_file(
        client, token, gid, "to-delete.bin", b"x" * 32, mock_s3
    )

    # Seed one extra orphan (simulating a PUT that aborted between
    # mint and finish) so the test also covers objects that have no
    # corresponding DB row at all.
    orphan_key = f"dropbox/{gid}/orphan.bin"
    mock_s3.put[orphan_key] = b"orphan"

    # Mint a second user who is admin (global admin bypasses the
    # owner-only check on delete_guild).
    admin_uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    admin_token = _auth_signer.issue_access(
        admin_uid, f"admin{admin_uid}", is_admin=True
    )

    r = await client.delete(f"/guilds/{gid}", headers=auth(admin_token))
    assert r.status_code == 204, r.text

    # Every MinIO object under dropbox/<gid>/ must be gone.
    dropbox_keys = [k for k in mock_s3.put if k.startswith(f"dropbox/{gid}/")]
    assert dropbox_keys == [], f"leftover dropbox objects: {dropbox_keys}"
