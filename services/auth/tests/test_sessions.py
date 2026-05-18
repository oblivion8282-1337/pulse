"""Tests for the ``/sessions`` routes (active-session management)."""

from __future__ import annotations

import pytest

REG_PAYLOAD = {
    "username": "alice",
    "email": "alice@example.com",
    "password": "correct horse battery staple",
    "display_name": "Alice",
}


async def _register(client, **overrides) -> dict:
    payload = {**REG_PAYLOAD, **overrides}
    r = await client.post("/register", json=payload)
    assert r.status_code == 201, r.text
    return r.json()


async def _login(client, *, user_agent: str | None = None) -> dict:
    headers = {"User-Agent": user_agent} if user_agent else {}
    r = await client.post(
        "/login",
        json={
            "email_or_username": REG_PAYLOAD["email"],
            "password": REG_PAYLOAD["password"],
        },
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.asyncio
async def test_list_sessions_requires_auth(client):
    r = await client.get("/sessions")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_list_sessions_returns_active_only(client):
    # Register seeds one refresh token; two follow-up logins add two more.
    tokens = await _register(client)
    access = tokens["access_token"]
    await _login(client)
    await _login(client)

    # Revoke one of the three via /logout (uses one of the refresh tokens
    # we still hold). We hold the very first one from /register.
    r_logout = await client.post(
        "/logout", json={"refresh_token": tokens["refresh_token"]}
    )
    assert r_logout.status_code == 200

    r = await client.get(
        "/sessions", headers={"Authorization": f"Bearer {access}"}
    )
    assert r.status_code == 200
    body = r.json()
    # 3 issued total, 1 revoked -> 2 active remain.
    assert len(body) == 2
    for row in body:
        assert isinstance(row["id"], str)
        assert "user_agent" in row
        assert "created_at" in row
        assert "last_used_at" in row
        assert "is_current" in row
        assert "ip_hash_prefix" in row


@pytest.mark.asyncio
async def test_list_sessions_marks_current(client):
    """is_current must hit for exactly the session whose UA matches the
    incoming request's UA (same IP since httpx ASGITransport is local)."""
    await _register(client)
    # The /register call above happened without a custom UA. Log in twice
    # with two different UAs so we can disambiguate.
    foo = await _login(client, user_agent="Foo/1.0")

    # Listing with UA=Foo should mark exactly one row as current.
    r = await client.get(
        "/sessions",
        headers={
            "Authorization": f"Bearer {foo['access_token']}",
            "User-Agent": "Foo/1.0",
        },
    )
    assert r.status_code == 200
    rows = r.json()
    current_rows = [row for row in rows if row["is_current"]]
    assert len(current_rows) == 1
    assert current_rows[0]["user_agent"] == "Foo/1.0"


@pytest.mark.asyncio
async def test_delete_session_revokes_only_that_token(client):
    tokens = await _register(client)
    access = tokens["access_token"]
    await _login(client)
    await _login(client)

    listed = await client.get(
        "/sessions", headers={"Authorization": f"Bearer {access}"}
    )
    rows = listed.json()
    assert len(rows) == 3

    target_id = rows[0]["id"]
    r_del = await client.delete(
        f"/sessions/{target_id}", headers={"Authorization": f"Bearer {access}"}
    )
    assert r_del.status_code == 204

    listed2 = await client.get(
        "/sessions", headers={"Authorization": f"Bearer {access}"}
    )
    remaining_ids = {row["id"] for row in listed2.json()}
    assert target_id not in remaining_ids
    assert len(remaining_ids) == 2


@pytest.mark.asyncio
async def test_delete_session_404_if_not_owner(client):
    # Alice registers + has one active refresh token.
    alice_tokens = await _register(client)
    listed = await client.get(
        "/sessions",
        headers={"Authorization": f"Bearer {alice_tokens['access_token']}"},
    )
    alice_session_id = listed.json()[0]["id"]

    # Bob registers; tries to delete Alice's session via Bob's token.
    bob_tokens = await _register(
        client, username="bob", email="bob@example.com"
    )
    r = await client.delete(
        f"/sessions/{alice_session_id}",
        headers={"Authorization": f"Bearer {bob_tokens['access_token']}"},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_delete_all_revokes_all_except_current(client):
    """Three active sessions; DELETE /sessions sweeps two, leaves the
    current one (matching IP-hash + UA) intact."""
    await _register(client)
    # Two side-sessions on different UAs.
    await _login(client, user_agent="OtherDevice/1")
    await _login(client, user_agent="OtherDevice/2")
    # Current session: log in with the UA we'll send on the DELETE call.
    current = await _login(client, user_agent="CurrentDevice/1")

    headers = {
        "Authorization": f"Bearer {current['access_token']}",
        "User-Agent": "CurrentDevice/1",
    }

    # Sanity: list should show 4 active (1 from register + 3 logins).
    listed_before = await client.get("/sessions", headers=headers)
    assert len(listed_before.json()) == 4

    r = await client.delete("/sessions", headers=headers)
    assert r.status_code == 200
    body = r.json()
    # 4 active, 1 current -> 3 swept.
    assert body == {"revoked_count": 3}

    listed_after = await client.get("/sessions", headers=headers)
    rows = listed_after.json()
    assert len(rows) == 1
    assert rows[0]["is_current"] is True
    assert rows[0]["user_agent"] == "CurrentDevice/1"


@pytest.mark.asyncio
async def test_refresh_updates_last_used_at(client):
    """After a refresh the newly-issued row carries a fresh last_used_at;
    the rotated-out row keeps its own timestamp (audit trail)."""
    tokens = await _register(client)
    access = tokens["access_token"]
    refresh = tokens["refresh_token"]

    before = (
        await client.get(
            "/sessions", headers={"Authorization": f"Bearer {access}"}
        )
    ).json()
    assert len(before) == 1
    initial_last_used = before[0]["last_used_at"]
    initial_id = before[0]["id"]

    # Rotate.
    r_refresh = await client.post(
        "/refresh", json={"refresh_token": refresh}
    )
    assert r_refresh.status_code == 200
    new_access = r_refresh.json()["access_token"]

    after = (
        await client.get(
            "/sessions", headers={"Authorization": f"Bearer {new_access}"}
        )
    ).json()
    # Old row revoked, only the new row is active.
    assert len(after) == 1
    new_row = after[0]
    assert new_row["id"] != initial_id
    assert new_row["last_used_at"] is not None
    # The new row's last_used_at should be >= the original.
    assert new_row["last_used_at"] >= initial_last_used
