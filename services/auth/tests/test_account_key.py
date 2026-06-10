"""Tests für GET/PUT /me/account-key (Envelope-Encryption, ein AK pro Account)."""

from __future__ import annotations

import base64

import pytest
import pytest_asyncio

_REG = {
    "username": "ak_alice",
    "email": "ak_alice@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Alice",
}

_PAYLOAD = {
    "wrapped_key": base64.b64encode(b"\x01" * 48).decode(),
    "kdf_salt": base64.b64encode(b"\x02" * 16).decode(),
    "kdf_params": '{"name":"Argon2id","memory_kib":65536,"iterations":3,"parallelism":4}',
    "gcm_nonce": base64.b64encode(b"\x03" * 12).decode(),
}


@pytest_asyncio.fixture
async def cookie(client) -> str:
    await client.post("/register", json=_REG)
    r = await client.post(
        "/login", json={"email_or_username": _REG["email"], "password": _REG["password"]}
    )
    assert r.status_code == 200, r.text
    return f"pulse_session={r.cookies.get('pulse_session')}"


@pytest.mark.asyncio
async def test_requires_cookie(client):
    assert (await client.get("/me/account-key")).status_code == 401
    assert (await client.put("/me/account-key", json=_PAYLOAD)).status_code == 401


@pytest.mark.asyncio
async def test_get_404_when_absent(client, cookie):
    r = await client.get("/me/account-key", headers={"Cookie": cookie})
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_create_and_fetch_roundtrip(client, cookie):
    r = await client.put("/me/account-key", json=_PAYLOAD, headers={"Cookie": cookie})
    assert r.status_code == 200, r.text
    r2 = await client.get("/me/account-key", headers={"Cookie": cookie})
    assert r2.status_code == 200
    data = r2.json()
    assert data["wrapped_key"] == _PAYLOAD["wrapped_key"]
    assert data["kdf_salt"] == _PAYLOAD["kdf_salt"]
    assert data["kdf_params"] == _PAYLOAD["kdf_params"]
    assert data["gcm_nonce"] == _PAYLOAD["gcm_nonce"]


@pytest.mark.asyncio
async def test_second_create_conflicts_without_overwrite(client, cookie):
    r1 = await client.put("/me/account-key", json=_PAYLOAD, headers={"Cookie": cookie})
    assert r1.status_code == 200
    other = {**_PAYLOAD, "wrapped_key": base64.b64encode(b"\x09" * 48).decode()}
    r2 = await client.put("/me/account-key", json=other, headers={"Cookie": cookie})
    assert r2.status_code == 409
    # Original unverändert
    cur = (await client.get("/me/account-key", headers={"Cookie": cookie})).json()
    assert cur["wrapped_key"] == _PAYLOAD["wrapped_key"]


@pytest.mark.asyncio
async def test_overwrite_replaces(client, cookie):
    await client.put("/me/account-key", json=_PAYLOAD, headers={"Cookie": cookie})
    other = {
        **_PAYLOAD,
        "wrapped_key": base64.b64encode(b"\x09" * 48).decode(),
        "overwrite": True,
    }
    r = await client.put("/me/account-key", json=other, headers={"Cookie": cookie})
    assert r.status_code == 200
    cur = (await client.get("/me/account-key", headers={"Cookie": cookie})).json()
    assert cur["wrapped_key"] == other["wrapped_key"]


@pytest.mark.asyncio
async def test_invalid_base64_rejected(client, cookie):
    bad = {**_PAYLOAD, "wrapped_key": "не-base64-!!!"}
    r = await client.put("/me/account-key", json=bad, headers={"Cookie": cookie})
    assert r.status_code == 422
