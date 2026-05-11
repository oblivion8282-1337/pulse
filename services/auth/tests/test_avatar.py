"""Tests for avatar upload/delete/serve endpoints."""

from __future__ import annotations

import io

import pytest
from PIL import Image


REG_PAYLOAD = {
    "username": "avataruser",
    "email": "avataruser@dcc-test.example.com",
    "password": "correct horse battery staple",
}


def _make_png(width: int = 100, height: int = 100) -> bytes:
    img = Image.new("RGB", (width, height), color=(100, 150, 200))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture(autouse=True)
def _set_avatar_dir(tmp_path, _isolate_settings):
    """Point avatar uploads at a temp dir for each test."""
    _isolate_settings.avatar_upload_dir = str(tmp_path)


async def _register_and_token(client) -> tuple[str, str]:
    reg = (await client.post("/register", json=REG_PAYLOAD)).json()
    token = reg["access_token"]
    me = (await client.get("/me", headers={"Authorization": f"Bearer {token}"})).json()
    return token, me["id"]


@pytest.mark.asyncio
async def test_upload_valid_png(client, tmp_path):
    token, user_id = await _register_and_token(client)

    png_data = _make_png()
    r = await client.post(
        "/me/avatar",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("avatar.png", io.BytesIO(png_data), "image/png")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["avatar_url"] is not None
    # URL enthält den Dateipfad + einen Cache-Buster-Query (?v=...)
    assert body["avatar_url"].startswith(f"/api/auth/avatars/{user_id}.webp?v=")

    saved = tmp_path / f"{user_id}.webp"
    assert saved.exists()
    with Image.open(saved) as img:
        assert img.width <= 256
        assert img.height <= 256


@pytest.mark.asyncio
async def test_upload_valid_jpeg(client):
    token, _ = await _register_and_token(client)

    img = Image.new("RGB", (100, 100), color=(200, 100, 50))
    buf = io.BytesIO()
    img.save(buf, "JPEG")
    jpeg_data = buf.getvalue()

    r = await client.post(
        "/me/avatar",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("avatar.jpg", io.BytesIO(jpeg_data), "image/jpeg")},
    )
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_upload_large_image_gets_resized(client, tmp_path):
    token, user_id = await _register_and_token(client)
    png_data = _make_png(512, 512)

    r = await client.post(
        "/me/avatar",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("big.png", io.BytesIO(png_data), "image/png")},
    )
    assert r.status_code == 200, r.text

    saved = tmp_path / f"{user_id}.webp"
    with Image.open(saved) as img:
        assert img.width <= 256
        assert img.height <= 256


@pytest.mark.asyncio
async def test_upload_invalid_content_type(client):
    token, _ = await _register_and_token(client)
    r = await client.post(
        "/me/avatar",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("file.txt", io.BytesIO(b"not an image"), "text/plain")},
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_upload_non_image_data_with_image_content_type(client):
    token, _ = await _register_and_token(client)
    r = await client.post(
        "/me/avatar",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("fake.png", io.BytesIO(b"this is not a real png"), "image/png")},
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_upload_requires_auth(client):
    png_data = _make_png()
    r = await client.post(
        "/me/avatar",
        files={"file": ("avatar.png", io.BytesIO(png_data), "image/png")},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_serve_avatar(client, tmp_path):
    token, user_id = await _register_and_token(client)
    png_data = _make_png()
    await client.post(
        "/me/avatar",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("avatar.png", io.BytesIO(png_data), "image/png")},
    )

    r = await client.get(f"/avatars/{user_id}.webp")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/webp")
    assert "public" in r.headers.get("cache-control", "")


@pytest.mark.asyncio
async def test_serve_avatar_no_auth_required(client, tmp_path):
    token, user_id = await _register_and_token(client)
    png_data = _make_png()
    await client.post(
        "/me/avatar",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("avatar.png", io.BytesIO(png_data), "image/png")},
    )

    # No Authorization header — must still work
    r = await client.get(f"/avatars/{user_id}.webp")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_serve_avatar_not_found(client):
    r = await client.get("/avatars/9999999.webp")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_serve_avatar_path_traversal_blocked(client):
    for bad in ["../etc/passwd", "../../etc/passwd", "/etc/passwd", "foo.png", "abc.webp"]:
        r = await client.get(f"/avatars/{bad}")
        assert r.status_code in (404, 422), f"expected 404/422 for {bad!r}, got {r.status_code}"


@pytest.mark.asyncio
async def test_delete_avatar(client, tmp_path):
    token, user_id = await _register_and_token(client)
    png_data = _make_png()
    await client.post(
        "/me/avatar",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("avatar.png", io.BytesIO(png_data), "image/png")},
    )

    r = await client.delete("/me/avatar", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 204

    saved = tmp_path / f"{user_id}.webp"
    assert not saved.exists()

    me = (await client.get("/me", headers={"Authorization": f"Bearer {token}"})).json()
    assert me["avatar_url"] is None


@pytest.mark.asyncio
async def test_delete_avatar_requires_auth(client):
    r = await client.delete("/me/avatar")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_delete_avatar_idempotent(client):
    token, _ = await _register_and_token(client)
    # Delete when no avatar set — should not error
    r = await client.delete("/me/avatar", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 204
