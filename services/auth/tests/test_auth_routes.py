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
async def test_first_user_becomes_admin(client):
    """Bootstrap: the very first user on a fresh deploy gets is_admin
    set so the server operator can reach /app/admin without an SQL
    promotion. Subsequent users do not."""
    r1 = await client.post("/register", json=REG_PAYLOAD)
    assert r1.status_code == 201
    claims1 = jwt.decode(
        r1.json()["access_token"], options={"verify_signature": False}
    )
    assert claims1.get("admin") is True

    r2 = await client.post(
        "/register",
        json={**REG_PAYLOAD, "username": "bob", "email": "bob@example.com"},
    )
    assert r2.status_code == 201
    claims2 = jwt.decode(
        r2.json()["access_token"], options={"verify_signature": False}
    )
    # JwtSigner only stamps ``admin`` when True — absent == false.
    assert "admin" not in claims2


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
async def test_refresh_reuse_revokes_family(client):
    # Audit #4: replaying an already-rotated refresh token must invalidate the
    # whole family (the new token issued by the legitimate rotation included).
    tokens = (await client.post("/register", json=REG_PAYLOAD)).json()
    old_refresh = tokens["refresh_token"]

    rotated = (await client.post("/refresh", json={"refresh_token": old_refresh})).json()
    new_refresh = rotated["refresh_token"]

    # Replay the old (now revoked) token -> reuse detected.
    r_replay = await client.post("/refresh", json={"refresh_token": old_refresh})
    assert r_replay.status_code == 401

    # The freshly-issued token must now also be dead.
    r_new = await client.post("/refresh", json={"refresh_token": new_refresh})
    assert r_new.status_code == 401


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


# ---- GET /users (batch lookup) -------------------------------------------


@pytest.mark.asyncio
async def test_batch_users_requires_auth(client):
    r = await client.get("/users?ids=123")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_batch_users_returns_known_ids(client):
    reg = (await client.post("/register", json=REG_PAYLOAD)).json()
    token = reg["access_token"]
    # /me to get our own id
    me = (await client.get("/me", headers={"Authorization": f"Bearer {token}"})).json()
    own_id = me["id"]

    r = await client.get(f"/users?ids={own_id}", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body) == 1
    assert body[0]["id"] == own_id
    assert body[0]["username"] == REG_PAYLOAD["username"]
    # email must NOT appear in UserSummary
    assert "email" not in body[0]


@pytest.mark.asyncio
async def test_batch_users_unknown_id_omitted(client):
    reg = (await client.post("/register", json=REG_PAYLOAD)).json()
    token = reg["access_token"]
    r = await client.get("/users?ids=999999999999", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_batch_users_too_many_ids(client):
    reg = (await client.post("/register", json=REG_PAYLOAD)).json()
    token = reg["access_token"]
    ids = ",".join(str(i) for i in range(101))
    r = await client.get(f"/users?ids={ids}", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_batch_users_no_email_in_response(client):
    # Register two users, look up the second from the first's perspective.
    r1 = (await client.post("/register", json=REG_PAYLOAD)).json()
    r2 = (await client.post(
        "/register",
        json={**REG_PAYLOAD, "username": "bob", "email": "bob@dcc-test.example.com"},
    )).json()
    token1 = r1["access_token"]
    token2 = r2["access_token"]
    me2 = (await client.get("/me", headers={"Authorization": f"Bearer {token2}"})).json()
    id2 = me2["id"]

    r = await client.get(f"/users?ids={id2}", headers={"Authorization": f"Bearer {token1}"})
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert "email" not in body[0]
