"""Tests for /credentials/{cert_id}/backup endpoints (DE 11 Block 2.A)."""

from __future__ import annotations

import base64

import pytest

_REG_A = {
    "username": "backup_alice",
    "email": "backup_alice@dcc-test.example.com",
    "password": "horse battery staple correct",
    "display_name": "Alice",
}
_REG_B = {
    "username": "backup_bob",
    "email": "backup_bob@dcc-test.example.com",
    "password": "horse battery staple correct",
    "display_name": "Bob",
}
_LOGIN_A = {"email_or_username": _REG_A["email"], "password": _REG_A["password"]}
_LOGIN_B = {"email_or_username": _REG_B["email"], "password": _REG_B["password"]}
_PUBKEY_A = base64.b64encode(b"\xaa" * 32).decode()
_PUBKEY_B = base64.b64encode(b"\xbb" * 32).decode()

# Valid backup payload fields.
_BLOB = base64.b64encode(b"\x01" * 48).decode()
_BLOB2 = base64.b64encode(b"\x02" * 48).decode()
_SALT = base64.b64encode(b"\x03" * 16).decode()
_PARAMS = "t=3,m=65536,p=4"
_NONCE = base64.b64encode(b"\x04" * 12).decode()


def _backup_payload(
    blob: str = _BLOB,
    salt: str = _SALT,
    params: str = _PARAMS,
    nonce: str = _NONCE,
    label: str = "My Device",
) -> dict:
    return {
        "encrypted_blob": blob,
        "argon2_salt": salt,
        "argon2_params": params,
        "gcm_nonce": nonce,
        "device_label": label,
    }


async def _reg_and_login(client, reg=_REG_A, login=_LOGIN_A):
    await client.post("/register", json=reg)
    r = await client.post("/login", json=login)
    assert r.status_code == 200, r.text
    sid = r.cookies.get("pulse_session")
    assert sid
    return f"pulse_session={sid}"


async def _issue_cert(client, cookie: str, pubkey: str = _PUBKEY_A) -> str:
    r = await client.post(
        "/credentials/issue",
        json={"device_pubkey": pubkey, "device_label": "Test Device"},
        headers={"Cookie": cookie},
    )
    assert r.status_code == 200, r.text
    import jwt as pyjwt
    return pyjwt.decode(r.json()["cert"], options={"verify_signature": False})["cert_id"]


# ---------------------------------------------------------------------------
# Auth-required tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_backup_requires_cookie(client):
    cert_id = "00000000-0000-0000-0000-000000000000"
    r = await client.post(f"/credentials/{cert_id}/backup", json=_backup_payload())
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_get_backup_requires_cookie(client):
    cert_id = "00000000-0000-0000-0000-000000000000"
    r = await client.get(f"/credentials/{cert_id}/backup")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_delete_backup_requires_cookie(client):
    cert_id = "00000000-0000-0000-0000-000000000000"
    r = await client.delete(f"/credentials/{cert_id}/backup")
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# Happy path: POST → GET → DELETE
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_backup_creates_backup(client):
    cookie = await _reg_and_login(client)
    cert_id = await _issue_cert(client, cookie)

    r = await client.post(
        f"/credentials/{cert_id}/backup",
        json=_backup_payload(),
        headers={"Cookie": cookie},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["cert_id"] == cert_id
    assert "created_at" in data
    assert "updated_at" in data


@pytest.mark.asyncio
async def test_get_backup_returns_blob(client):
    cookie = await _reg_and_login(client)
    cert_id = await _issue_cert(client, cookie)

    await client.post(
        f"/credentials/{cert_id}/backup",
        json=_backup_payload(blob=_BLOB, salt=_SALT, nonce=_NONCE),
        headers={"Cookie": cookie},
    )

    r = await client.get(f"/credentials/{cert_id}/backup", headers={"Cookie": cookie})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["cert_id"] == cert_id
    assert data["device_label"] == "My Device"
    assert data["argon2_params"] == _PARAMS
    # Base64 round-trip: decode both sides to compare bytes.
    assert base64.b64decode(data["encrypted_blob"]) == base64.b64decode(_BLOB)
    assert base64.b64decode(data["argon2_salt"]) == base64.b64decode(_SALT)
    assert base64.b64decode(data["gcm_nonce"]) == base64.b64decode(_NONCE)
    assert "created_at" in data


@pytest.mark.asyncio
async def test_delete_backup_removes_backup(client):
    cookie = await _reg_and_login(client)
    cert_id = await _issue_cert(client, cookie)

    await client.post(
        f"/credentials/{cert_id}/backup",
        json=_backup_payload(),
        headers={"Cookie": cookie},
    )
    r_del = await client.delete(f"/credentials/{cert_id}/backup", headers={"Cookie": cookie})
    assert r_del.status_code == 204

    r_get = await client.get(f"/credentials/{cert_id}/backup", headers={"Cookie": cookie})
    assert r_get.status_code == 404


# ---------------------------------------------------------------------------
# Ownership: User B cannot touch User A's backup
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_backup_foreign_cert_returns_404(client, app):
    cookie_a = await _reg_and_login(client, reg=_REG_A, login=_LOGIN_A)
    cookie_b = await _reg_and_login(client, reg=_REG_B, login=_LOGIN_B)

    cert_id_a = await _issue_cert(client, cookie_a, pubkey=_PUBKEY_A)
    await client.post(
        f"/credentials/{cert_id_a}/backup",
        json=_backup_payload(),
        headers={"Cookie": cookie_a},
    )

    r = await client.get(f"/credentials/{cert_id_a}/backup", headers={"Cookie": cookie_b})
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_post_backup_foreign_cert_returns_404(client, app):
    cookie_a = await _reg_and_login(client, reg=_REG_A, login=_LOGIN_A)
    cookie_b = await _reg_and_login(client, reg=_REG_B, login=_LOGIN_B)

    cert_id_a = await _issue_cert(client, cookie_a, pubkey=_PUBKEY_A)

    r = await client.post(
        f"/credentials/{cert_id_a}/backup",
        json=_backup_payload(),
        headers={"Cookie": cookie_b},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_delete_backup_foreign_cert_returns_404(client, app):
    cookie_a = await _reg_and_login(client, reg=_REG_A, login=_LOGIN_A)
    cookie_b = await _reg_and_login(client, reg=_REG_B, login=_LOGIN_B)

    cert_id_a = await _issue_cert(client, cookie_a, pubkey=_PUBKEY_A)
    await client.post(
        f"/credentials/{cert_id_a}/backup",
        json=_backup_payload(),
        headers={"Cookie": cookie_a},
    )

    r = await client.delete(f"/credentials/{cert_id_a}/backup", headers={"Cookie": cookie_b})
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Upsert: second POST overwrites first
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upsert_overwrites_previous_backup(client):
    cookie = await _reg_and_login(client)
    cert_id = await _issue_cert(client, cookie)

    await client.post(
        f"/credentials/{cert_id}/backup",
        json=_backup_payload(blob=_BLOB, label="Device v1"),
        headers={"Cookie": cookie},
    )

    r2 = await client.post(
        f"/credentials/{cert_id}/backup",
        json=_backup_payload(blob=_BLOB2, label="Device v2"),
        headers={"Cookie": cookie},
    )
    assert r2.status_code == 200, r2.text

    r_get = await client.get(f"/credentials/{cert_id}/backup", headers={"Cookie": cookie})
    data = r_get.json()
    assert base64.b64decode(data["encrypted_blob"]) == base64.b64decode(_BLOB2)
    assert data["device_label"] == "Device v2"


# ---------------------------------------------------------------------------
# has_backup field in GET /credentials/list
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_has_backup_false_before_post(client, app):
    cookie = await _reg_and_login(client)
    await _issue_cert(client, cookie)

    r = await client.get("/credentials/list", headers={"Cookie": cookie})
    assert r.status_code == 200
    devices = r.json()["devices"]
    assert len(devices) >= 1
    assert all(not d["has_backup"] for d in devices)


@pytest.mark.asyncio
async def test_has_backup_true_after_post(client, app):
    cookie = await _reg_and_login(client)
    cert_id = await _issue_cert(client, cookie)

    await client.post(
        f"/credentials/{cert_id}/backup",
        json=_backup_payload(),
        headers={"Cookie": cookie},
    )

    r = await client.get("/credentials/list", headers={"Cookie": cookie})
    devices = r.json()["devices"]
    target = next(d for d in devices if d["cert_id"] == cert_id)
    assert target["has_backup"] is True


@pytest.mark.asyncio
async def test_has_backup_false_after_delete(client, app):
    cookie = await _reg_and_login(client)
    cert_id = await _issue_cert(client, cookie)

    await client.post(
        f"/credentials/{cert_id}/backup",
        json=_backup_payload(),
        headers={"Cookie": cookie},
    )
    await client.delete(f"/credentials/{cert_id}/backup", headers={"Cookie": cookie})

    r = await client.get("/credentials/list", headers={"Cookie": cookie})
    devices = r.json()["devices"]
    target = next(d for d in devices if d["cert_id"] == cert_id)
    assert target["has_backup"] is False


# ---------------------------------------------------------------------------
# GET /backup 404 when no backup exists
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_backup_404_when_not_exists(client):
    cookie = await _reg_and_login(client)
    cert_id = await _issue_cert(client, cookie)

    r = await client.get(f"/credentials/{cert_id}/backup", headers={"Cookie": cookie})
    assert r.status_code == 404
