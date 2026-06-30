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
        return f"https://mock/{key}?sig"

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


@pytest.fixture
def mock_s3(monkeypatch):
    m = _S3Mock()
    monkeypatch.setattr(s3_mod, "put_object", m.put_object)
    monkeypatch.setattr(s3_mod, "presigned_put_url", m.presigned_put_url)
    monkeypatch.setattr(s3_mod, "presigned_get_url", m.presigned_get_url)
    monkeypatch.setattr(s3_mod, "head_object", m.head_object)
    monkeypatch.setattr(s3_mod, "delete_object", m.delete_object)
    return m


async def _create_guild(client, token: str) -> dict:
    r = await client.post("/guilds", json={"name": "g"}, headers=auth(token))
    assert r.status_code == 201, r.text
    return r.json()


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
async def test_duplicate_folder_409(client, _auth_signer, mock_s3):
    """Two folders with the same parent+name → 409."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]

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
async def test_finish_upload_missing_object_raises(
    client, _auth_signer, mock_s3
):
    """PUT never landed → HEAD raises ClientError (bubbles as 500 today).
    Invariant: never a silent 200 persisting a phantom row."""

    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]

    await client.get(f"/guilds/{gid}/dropbox/channel", headers=auth(token))

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

    with pytest.raises(ClientError):
        await client.post(
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
