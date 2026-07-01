"""Dropbox download routes — single-file URL + folder/multi ZIP archive.

MinIO is mocked via the shared ``_S3Mock`` (same as ``test_dropbox.py``);
``stream_object`` yields from the in-memory ``put`` dict so the ZIP streamer
runs against real bytes and we can validate the emitted archive with stdlib
``zipfile``.
"""

from __future__ import annotations

import io
import zipfile

import pytest
from dcc_chat_gateway import s3 as s3_mod

# Reuse the shared mock + helpers from the sibling test module.
from .test_dropbox import _create_guild, _provision_dropbox, _S3Mock, _user  # noqa: E402


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


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


async def _upload(client, token, gid, mock_s3, *, name, parent="", content=b"x"):
    """Run the full mint→PUT→finish handshake and return the live entry."""
    size = len(content)
    mint_r = await client.post(
        f"/guilds/{gid}/dropbox/upload-url",
        json={
            "parent_path": parent,
            "name": name,
            "content_type": "application/octet-stream",
            "size_bytes": size,
        },
        headers=auth(token),
    )
    assert mint_r.status_code == 200, mint_r.text
    mint = mint_r.json()
    mock_s3.put[mint["storage_key"]] = content
    finish_r = await client.post(
        f"/guilds/{gid}/dropbox/finish-upload",
        json={
            "id": mint["id"],
            "parent_path": parent,
            "name": name,
            "size_bytes": size,
            "content_type": "application/octet-stream",
        },
        headers=auth(token),
    )
    assert finish_r.status_code == 200, finish_r.text
    return finish_r.json()


async def _create_folder(client, token, gid, *, parent, name):
    r = await client.post(
        f"/guilds/{gid}/dropbox/folders",
        json={"parent_path": parent, "name": name},
        headers=auth(token),
    )
    assert r.status_code == 201, r.text
    return r.json()


# ─── Single-file download URL ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_download_url_returns_attachment_url(client, _auth_signer, mock_s3):
    """The download URL carries the attachment disposition (``?att``) so the
    browser downloads rather than renders — distinct from the inline listing
    URL (``?sig``)."""
    token, _ = await _user(_auth_signer)
    gid = (await _create_guild(client, token))["id"]
    await _provision_dropbox(client, token, gid)
    entry = await _upload(client, token, gid, mock_s3, name="doc.bin", content=b"abc")

    r = await client.get(
        f"/guilds/{gid}/dropbox/entries/{entry['id']}/download-url",
        headers=auth(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["url"].endswith("?att")


@pytest.mark.asyncio
async def test_download_url_non_member_forbidden(client, _auth_signer, mock_s3):
    token, _ = await _user(_auth_signer)
    other_token, _ = await _user(_auth_signer)
    gid = (await _create_guild(client, token))["id"]
    await _provision_dropbox(client, token, gid)
    entry = await _upload(client, token, gid, mock_s3, name="doc.bin")

    r = await client.get(
        f"/guilds/{gid}/dropbox/entries/{entry['id']}/download-url",
        headers=auth(other_token),
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_download_url_missing_entry_404(client, _auth_signer, mock_s3):
    token, _ = await _user(_auth_signer)
    gid = (await _create_guild(client, token))["id"]
    await _provision_dropbox(client, token, gid)

    r = await client.get(
        f"/guilds/{gid}/dropbox/entries/99999999/download-url",
        headers=auth(token),
    )
    assert r.status_code == 404, r.text


# ─── Folder ZIP archive ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_archive_folder_streams_valid_zip(client, _auth_signer, mock_s3):
    """A folder with a nested file downloads as a real ZIP whose tree mirrors
    the dropbox layout, rooted at the folder name."""
    token, _ = await _user(_auth_signer)
    gid = (await _create_guild(client, token))["id"]
    await _provision_dropbox(client, token, gid)
    await _create_folder(client, token, gid, parent="", name="proj")
    await _upload(
        client, token, gid, mock_s3, name="a.txt", parent="proj", content=b"AAA"
    )
    await _upload(
        client, token, gid, mock_s3, name="b.txt", parent="proj", content=b"BBBB"
    )

    r = await client.get(
        f"/guilds/{gid}/dropbox/download-archive?token={token}&path=proj",
        headers=auth(token),
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    assert 'filename="proj.zip"' in r.headers["content-disposition"]

    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = sorted(z.namelist())
    assert names == ["proj/a.txt", "proj/b.txt"], names
    assert z.read("proj/a.txt") == b"AAA"
    assert z.read("proj/b.txt") == b"BBBB"


@pytest.mark.asyncio
async def test_archive_folder_missing_404(client, _auth_signer, mock_s3):
    token, _ = await _user(_auth_signer)
    gid = (await _create_guild(client, token))["id"]
    await _provision_dropbox(client, token, gid)

    r = await client.get(
        f"/guilds/{gid}/dropbox/download-archive?token={token}&path=ghost",
        headers=auth(token),
    )
    assert r.status_code == 404, r.text


# ─── Multi-select ZIP archive ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_archive_multi_select(client, _auth_signer, mock_s3):
    """``entry_ids`` packs exactly the chosen files (order preserved), ignoring
    any id that doesn't resolve."""
    token, _ = await _user(_auth_signer)
    gid = (await _create_guild(client, token))["id"]
    await _provision_dropbox(client, token, gid)
    e1 = await _upload(client, token, gid, mock_s3, name="1.bin", content=b"1")
    e2 = await _upload(client, token, gid, mock_s3, name="2.bin", content=b"22")

    r = await client.get(
        f"/guilds/{gid}/dropbox/download-archive"
        f"?token={token}&entry_ids={e1['id']},{e2['id']}",
        headers=auth(token),
    )
    assert r.status_code == 200, r.text
    assert "dropbox-selection.zip" in r.headers["content-disposition"]
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert sorted(z.namelist()) == ["1.bin", "2.bin"]


@pytest.mark.asyncio
async def test_archive_too_many_ids_413(client, _auth_signer, mock_s3):
    token, _ = await _user(_auth_signer)
    gid = (await _create_guild(client, token))["id"]
    await _provision_dropbox(client, token, gid)
    ids = ",".join(str(10_000 + i) for i in range(101))  # > MAX_MULTI_IDS (100)

    r = await client.get(
        f"/guilds/{gid}/dropbox/download-archive?token={token}&entry_ids={ids}",
        headers=auth(token),
    )
    assert r.status_code == 413, r.text


@pytest.mark.asyncio
async def test_archive_neither_nor_both_422(client, _auth_signer, mock_s3):
    token, _ = await _user(_auth_signer)
    gid = (await _create_guild(client, token))["id"]
    await _provision_dropbox(client, token, gid)

    neither = await client.get(
        f"/guilds/{gid}/dropbox/download-archive?token={token}",
        headers=auth(token),
    )
    assert neither.status_code == 422, neither.text

    both = await client.get(
        f"/guilds/{gid}/dropbox/download-archive"
        f"?token={token}&path=x&entry_ids=1",
        headers=auth(token),
    )
    assert both.status_code == 422, both.text


@pytest.mark.asyncio
async def test_archive_non_member_403(client, _auth_signer, mock_s3):
    token, _ = await _user(_auth_signer)
    other_token, _ = await _user(_auth_signer)
    gid = (await _create_guild(client, token))["id"]
    await _provision_dropbox(client, token, gid)

    r = await client.get(
        f"/guilds/{gid}/dropbox/download-archive?token={other_token}&path=",
        headers=auth(other_token),
    )
    assert r.status_code == 403, r.text
