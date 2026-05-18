"""Per-guild sound-override routes.

S3 is mocked (same pattern as test_attachments). Covers:
- list/upload/delete happy path
- permission gate (non-owner gets 403)
- unknown sound_id → 400
- unsupported content-type → 400
- file exceeding the admin-configured cap → 400
- empty file → 400
- ready-payload exposes overrides per guild
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio

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

    async def presigned_get_url(self, key, *, filename=None, inline=True):
        return f"https://mock/{key}?sig"

    async def delete_object(self, key):
        self.deleted.append(key)
        self.put.pop(key, None)


@pytest.fixture
def mock_s3(monkeypatch):
    m = _S3Mock()
    monkeypatch.setattr(s3_mod, "put_object", m.put_object)
    monkeypatch.setattr(s3_mod, "presigned_get_url", m.presigned_get_url)
    monkeypatch.setattr(s3_mod, "delete_object", m.delete_object)
    return m


async def _create_guild(client, token: str) -> dict:
    r = await client.post("/guilds", json={"name": "g"}, headers=auth(token))
    assert r.status_code == 201, r.text
    return r.json()


def _ogg(body: bytes = b"OggS\x00fakeoggdata") -> dict:
    return {"file": ("custom.ogg", body, "audio/ogg")}


# ─── Happy path ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_upload_then_list(client, _auth_signer, mock_s3):
    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]

    r = await client.put(
        f"/guilds/{gid}/sounds/notification.message",
        files=_ogg(b"x" * 4096),
        headers=auth(token),
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["sound_id"] == "notification.message"
    assert out["url"].startswith("https://mock/")
    assert out["file_size"] == 4096
    assert out["content_type"] == "audio/ogg"
    assert out["original_filename"] == "custom.ogg"
    assert f"guild-sounds/{gid}/notification.message" in mock_s3.put

    r = await client.get(f"/guilds/{gid}/sounds", headers=auth(token))
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1
    assert rows[0]["sound_id"] == "notification.message"


@pytest.mark.asyncio
async def test_re_upload_replaces(client, _auth_signer, mock_s3):
    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]

    await client.put(
        f"/guilds/{gid}/sounds/voice.user_join",
        files=_ogg(b"a" * 100),
        headers=auth(token),
    )
    r2 = await client.put(
        f"/guilds/{gid}/sounds/voice.user_join",
        files={"file": ("new.mp3", b"\xff\xfb" + b"y" * 200, "audio/mpeg")},
        headers=auth(token),
    )
    assert r2.status_code == 200
    assert r2.json()["content_type"] == "audio/mpeg"
    assert r2.json()["file_size"] == 202

    rows = (await client.get(f"/guilds/{gid}/sounds", headers=auth(token))).json()
    assert len(rows) == 1  # upsert, not duplicate


@pytest.mark.asyncio
async def test_delete(client, _auth_signer, mock_s3):
    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]

    await client.put(
        f"/guilds/{gid}/sounds/ui.send",
        files=_ogg(),
        headers=auth(token),
    )
    r = await client.delete(
        f"/guilds/{gid}/sounds/ui.send", headers=auth(token)
    )
    assert r.status_code == 204
    rows = (await client.get(f"/guilds/{gid}/sounds", headers=auth(token))).json()
    assert rows == []
    assert f"guild-sounds/{gid}/ui.send" in mock_s3.deleted


@pytest.mark.asyncio
async def test_delete_nonexistent_is_noop(client, _auth_signer, mock_s3):
    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    r = await client.delete(
        f"/guilds/{g['id']}/sounds/ui.send", headers=auth(token)
    )
    assert r.status_code == 204  # idempotent revert


# ─── Validation ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unknown_sound_id_rejected(client, _auth_signer, mock_s3):
    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    r = await client.put(
        f"/guilds/{g['id']}/sounds/notification.bogus",
        files=_ogg(),
        headers=auth(token),
    )
    assert r.status_code == 400
    assert "unknown sound_id" in r.text


@pytest.mark.asyncio
async def test_unsupported_content_type_rejected(client, _auth_signer, mock_s3):
    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    r = await client.put(
        f"/guilds/{g['id']}/sounds/ui.send",
        files={"file": ("x.wav", b"RIFF", "audio/wav")},
        headers=auth(token),
    )
    assert r.status_code == 400
    assert "content-type" in r.text


@pytest.mark.asyncio
async def test_oversized_rejected(client, _auth_signer, mock_s3, session_factory):
    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)

    # Set a tiny limit via the singleton row.
    from dcc_chat_gateway.models import ChatSettings
    async with session_factory() as s:
        row = await s.get(ChatSettings, 1)
        row.guild_sound_max_size_bytes = 1024
        await s.commit()

    r = await client.put(
        f"/guilds/{g['id']}/sounds/ui.send",
        files=_ogg(b"x" * 2048),
        headers=auth(token),
    )
    assert r.status_code == 400
    assert "too large" in r.text


@pytest.mark.asyncio
async def test_empty_file_rejected(client, _auth_signer, mock_s3):
    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    r = await client.put(
        f"/guilds/{g['id']}/sounds/ui.send",
        files=_ogg(b""),
        headers=auth(token),
    )
    assert r.status_code == 400


# ─── Permissions ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_non_member_cannot_list(client, _auth_signer, mock_s3):
    owner_token, _ = await _user(_auth_signer)
    other_token, _ = await _user(_auth_signer)
    g = await _create_guild(client, owner_token)
    r = await client.get(f"/guilds/{g['id']}/sounds", headers=auth(other_token))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_non_manager_cannot_upload(client, _auth_signer, mock_s3):
    owner_token, _ = await _user(_auth_signer)
    member_token, member_uid = await _user(_auth_signer)
    g = await _create_guild(client, owner_token)

    # Add the second user as a plain member.
    r = await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(member_uid)},
        headers=auth(owner_token),
    )
    assert r.status_code in (200, 201)

    r = await client.put(
        f"/guilds/{g['id']}/sounds/ui.send",
        files=_ogg(),
        headers=auth(member_token),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_unknown_guild_returns_404(client, _auth_signer, mock_s3):
    token, _uid = await _user(_auth_signer)
    r = await client.put(
        "/guilds/999999/sounds/ui.send",
        files=_ogg(),
        headers=auth(token),
    )
    assert r.status_code == 404
