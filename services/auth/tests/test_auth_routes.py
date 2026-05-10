"""Route-level tests for the auth service."""

from __future__ import annotations

import jwt
import pytest


REG_PAYLOAD = {
    "username": "alice",
    "email": "alice@example.com",
    "password": "correct horse battery staple",
    "display_name": "Alice",
}


@pytest.mark.asyncio
async def test_health(client):
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_register_returns_tokens(client):
    r = await client.post("/register", json=REG_PAYLOAD)
    assert r.status_code == 201, r.text
    body = r.json()
    assert "access_token" in body and "refresh_token" in body
    assert body["token_type"] == "bearer"
    assert body["access_token"].count(".") == 2


@pytest.mark.asyncio
async def test_register_rejects_duplicate(client):
    r1 = await client.post("/register", json=REG_PAYLOAD)
    assert r1.status_code == 201
    r2 = await client.post("/register", json=REG_PAYLOAD)
    assert r2.status_code == 409


@pytest.mark.asyncio
async def test_register_rejects_invalid_username(client):
    bad = {**REG_PAYLOAD, "username": "a"}  # too short
    r = await client.post("/register", json=bad)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_register_rejects_short_password(client):
    bad = {**REG_PAYLOAD, "password": "1234567"}
    r = await client.post("/register", json=bad)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_login_with_email(client):
    await client.post("/register", json=REG_PAYLOAD)
    r = await client.post(
        "/login",
        json={"email_or_username": REG_PAYLOAD["email"], "password": REG_PAYLOAD["password"]},
    )
    assert r.status_code == 200
    assert r.json()["access_token"]


@pytest.mark.asyncio
async def test_login_with_username(client):
    await client.post("/register", json=REG_PAYLOAD)
    r = await client.post(
        "/login",
        json={"email_or_username": REG_PAYLOAD["username"], "password": REG_PAYLOAD["password"]},
    )
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_login_invalid_password(client):
    await client.post("/register", json=REG_PAYLOAD)
    r = await client.post(
        "/login",
        json={"email_or_username": REG_PAYLOAD["email"], "password": "wrong"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_login_unknown_user(client):
    r = await client.post(
        "/login",
        json={"email_or_username": "ghost@nowhere", "password": "12345678"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_me_requires_bearer(client):
    r = await client.get("/me")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_me_returns_user(client):
    reg = (await client.post("/register", json=REG_PAYLOAD)).json()
    r = await client.get("/me", headers={"Authorization": f"Bearer {reg['access_token']}"})
    assert r.status_code == 200
    body = r.json()
    assert body["username"] == REG_PAYLOAD["username"]
    assert body["email"] == REG_PAYLOAD["email"]
    # id must be string-serialized
    assert isinstance(body["id"], str)
    assert body["id"].isdigit()


@pytest.mark.asyncio
async def test_me_rejects_invalid_token(client):
    r = await client.get("/me", headers={"Authorization": "Bearer not-a-jwt"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_jwks_endpoint(client):
    r = await client.get("/.well-known/jwks.json")
    assert r.status_code == 200
    body = r.json()
    assert "keys" in body and len(body["keys"]) == 1
    k = body["keys"][0]
    assert k["kty"] == "RSA"
    assert k["alg"] == "RS256"
    assert "n" in k and "e" in k


@pytest.mark.asyncio
async def test_access_token_payload(client):
    tokens = (await client.post("/register", json=REG_PAYLOAD)).json()
    # Decode without verification just to look at claims.
    payload = jwt.decode(tokens["access_token"], options={"verify_signature": False})
    assert payload["typ"] == "access"
    assert payload["username"] == REG_PAYLOAD["username"]
    assert payload["aud"] == "dcc"


@pytest.mark.asyncio
async def test_refresh_rotation(client):
    tokens = (await client.post("/register", json=REG_PAYLOAD)).json()
    old_refresh = tokens["refresh_token"]

    r = await client.post("/refresh", json={"refresh_token": old_refresh})
    assert r.status_code == 200
    new_tokens = r.json()
    assert new_tokens["refresh_token"] != old_refresh

    # Old refresh must now be revoked.
    r2 = await client.post("/refresh", json={"refresh_token": old_refresh})
    assert r2.status_code == 401


@pytest.mark.asyncio
async def test_refresh_rejects_access_token(client):
    tokens = (await client.post("/register", json=REG_PAYLOAD)).json()
    r = await client.post("/refresh", json={"refresh_token": tokens["access_token"]})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_logout_revokes_refresh(client):
    tokens = (await client.post("/register", json=REG_PAYLOAD)).json()
    r = await client.post("/logout", json={"refresh_token": tokens["refresh_token"]})
    assert r.status_code == 200
    # subsequent refresh fails
    r2 = await client.post("/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert r2.status_code == 401


@pytest.mark.asyncio
async def test_logout_is_idempotent(client):
    r = await client.post("/logout", json={"refresh_token": "garbage"})
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_rate_limit_register(client):
    # rule = 5/minute by default
    for i in range(5):
        payload = {**REG_PAYLOAD, "username": f"alice{i}", "email": f"a{i}@ex.com"}
        r = await client.post("/register", json=payload)
        assert r.status_code == 201, f"iter {i}: {r.text}"
    over = {**REG_PAYLOAD, "username": "alice5", "email": "a5@ex.com"}
    r = await client.post("/register", json=over)
    assert r.status_code == 429
