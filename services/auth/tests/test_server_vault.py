"""Tests for /server-vault endpoints — Zero-Knowledge E2E-Sync der Server-Liste."""

from __future__ import annotations

import base64

import pytest

_REG_A = {
    "username": "vault_alice",
    "email": "vault_alice@dcc-test.example.com",
    "password": "horse battery staple correct",
    "display_name": "Alice",
}
_REG_B = {
    "username": "vault_bob",
    "email": "vault_bob@dcc-test.example.com",
    "password": "horse battery staple correct",
    "display_name": "Bob",
}
_LOGIN_A = {"email_or_username": _REG_A["email"], "password": _REG_A["password"]}
_LOGIN_B = {"email_or_username": _REG_B["email"], "password": _REG_B["password"]}

_BLOB = base64.b64encode(b"\x01" * 64).decode()
_BLOB2 = base64.b64encode(b"\x02" * 80).decode()
_SALT = base64.b64encode(b"\x03" * 16).decode()
_PARAMS = '{"name":"Argon2id","parallelism":4,"memory_kib":65536,"iterations":3}'
_NONCE = base64.b64encode(b"\x04" * 12).decode()
_NONCE2 = base64.b64encode(b"\x05" * 12).decode()


def _vault_payload(blob: str = _BLOB, salt: str = _SALT, params: str = _PARAMS, nonce: str = _NONCE) -> dict:
    return {
        "encrypted_blob": blob,
        "kdf_salt": salt,
        "kdf_params": params,
        "gcm_nonce": nonce,
    }


async def _reg_and_login(client, reg=_REG_A, login=_LOGIN_A) -> str:
    await client.post("/register", json=reg)
    r = await client.post("/login", json=login)
    assert r.status_code == 200, r.text
    sid = r.cookies.get("pulse_session")
    assert sid
    return f"pulse_session={sid}"


# ---------------------------------------------------------------------------
# Auth-required
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_put_vault_requires_cookie(client):
    r = await client.put("/server-vault", json=_vault_payload())
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_get_vault_requires_cookie(client):
    r = await client.get("/server-vault")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_delete_vault_requires_cookie(client):
    r = await client.delete("/server-vault")
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# Happy path: PUT → GET → DELETE
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_put_vault_creates(client):
    cookie = await _reg_and_login(client)
    r = await client.put("/server-vault", json=_vault_payload(), headers={"Cookie": cookie})
    assert r.status_code == 200, r.text
    data = r.json()
    assert "created_at" in data
    assert "updated_at" in data


@pytest.mark.asyncio
async def test_get_vault_returns_blob(client):
    cookie = await _reg_and_login(client)
    await client.put("/server-vault", json=_vault_payload(), headers={"Cookie": cookie})

    r = await client.get("/server-vault", headers={"Cookie": cookie})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["kdf_params"] == _PARAMS
    assert base64.b64decode(data["encrypted_blob"]) == base64.b64decode(_BLOB)
    assert base64.b64decode(data["kdf_salt"]) == base64.b64decode(_SALT)
    assert base64.b64decode(data["gcm_nonce"]) == base64.b64decode(_NONCE)


@pytest.mark.asyncio
async def test_get_vault_404_when_not_exists(client):
    cookie = await _reg_and_login(client)
    r = await client.get("/server-vault", headers={"Cookie": cookie})
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_delete_vault_removes(client):
    cookie = await _reg_and_login(client)
    await client.put("/server-vault", json=_vault_payload(), headers={"Cookie": cookie})

    r_del = await client.delete("/server-vault", headers={"Cookie": cookie})
    assert r_del.status_code == 204

    r_get = await client.get("/server-vault", headers={"Cookie": cookie})
    assert r_get.status_code == 404


# ---------------------------------------------------------------------------
# Upsert: second PUT overwrites, keeps created_at, bumps updated_at
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_put_vault_upsert_overwrites(client):
    cookie = await _reg_and_login(client)
    r1 = await client.put("/server-vault", json=_vault_payload(), headers={"Cookie": cookie})
    created = r1.json()["created_at"]

    r2 = await client.put(
        "/server-vault",
        json=_vault_payload(blob=_BLOB2, nonce=_NONCE2),
        headers={"Cookie": cookie},
    )
    assert r2.status_code == 200, r2.text
    # created_at is preserved across the upsert.
    assert r2.json()["created_at"] == created

    r_get = await client.get("/server-vault", headers={"Cookie": cookie})
    data = r_get.json()
    assert base64.b64decode(data["encrypted_blob"]) == base64.b64decode(_BLOB2)
    assert base64.b64decode(data["gcm_nonce"]) == base64.b64decode(_NONCE2)


# ---------------------------------------------------------------------------
# Isolation: each user has their own vault
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_vault_is_per_user(client, app):
    cookie_a = await _reg_and_login(client, reg=_REG_A, login=_LOGIN_A)
    cookie_b = await _reg_and_login(client, reg=_REG_B, login=_LOGIN_B)

    await client.put("/server-vault", json=_vault_payload(blob=_BLOB), headers={"Cookie": cookie_a})

    # B has no vault yet → 404, and never sees A's blob.
    r_b = await client.get("/server-vault", headers={"Cookie": cookie_b})
    assert r_b.status_code == 404

    # B writes its own; A's stays untouched.
    await client.put("/server-vault", json=_vault_payload(blob=_BLOB2), headers={"Cookie": cookie_b})
    r_a = await client.get("/server-vault", headers={"Cookie": cookie_a})
    assert base64.b64decode(r_a.json()["encrypted_blob"]) == base64.b64decode(_BLOB)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_put_vault_rejects_bad_base64(client):
    cookie = await _reg_and_login(client)
    # A single data character is always invalid base64 (can't be 1 mod 4).
    r = await client.put(
        "/server-vault",
        json=_vault_payload(blob="A"),
        headers={"Cookie": cookie},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_put_vault_rejects_wrong_salt_length(client):
    cookie = await _reg_and_login(client)
    bad_salt = base64.b64encode(b"\x03" * 8).decode()  # 8 bytes, not 16
    r = await client.put(
        "/server-vault",
        json=_vault_payload(salt=bad_salt),
        headers={"Cookie": cookie},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_put_vault_rejects_wrong_nonce_length(client):
    cookie = await _reg_and_login(client)
    bad_nonce = base64.b64encode(b"\x04" * 16).decode()  # 16 bytes, not 12
    r = await client.put(
        "/server-vault",
        json=_vault_payload(nonce=bad_nonce),
        headers={"Cookie": cookie},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_put_vault_upsert_rotates_salt(client):
    """A re-key (Master-Passwort-Wechsel) sends a fresh salt — must be persisted."""
    cookie = await _reg_and_login(client)
    await client.put("/server-vault", json=_vault_payload(salt=_SALT), headers={"Cookie": cookie})

    new_salt = base64.b64encode(b"\x07" * 16).decode()
    await client.put(
        "/server-vault",
        json=_vault_payload(blob=_BLOB2, salt=new_salt, nonce=_NONCE2),
        headers={"Cookie": cookie},
    )

    r_get = await client.get("/server-vault", headers={"Cookie": cookie})
    assert base64.b64decode(r_get.json()["kdf_salt"]) == base64.b64decode(new_salt)
