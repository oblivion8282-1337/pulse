"""Dropbox / Ablage routes — happy path + permission gates.

Covers:
- channel + config auto-provision on first access
- folder CRUD + listing
- rename, move, pin
- soft-delete + restore
- admin quota settings

MinIO is mocked — real binary put/get would require docker-compose.
The route's HEAD-on-finish-upload lives in dropbox_uploads.py and is
exercised by a separate test (`test_dropbox_uploads.py`) once MinIO is
stand-up-able in CI.
"""

from __future__ import annotations

import uuid

import pytest

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

    async def delete_object(self, key):
        self.deleted.append(key)
        self.put.pop(key, None)


@pytest.fixture
def mock_s3(monkeypatch):
    m = _S3Mock()
    monkeypatch.setattr(s3_mod, "put_object", m.put_object)
    monkeypatch.setattr(s3_mod, "presigned_put_url", m.presigned_put_url)
    monkeypatch.setattr(s3_mod, "presigned_get_url", m.presigned_get_url)
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
