"""Tests for browser-session cookie auth (DE 11 Phase 1).

Coverage:
  * Cookie is set after successful /login
  * Cookie-based /me auth works
  * Expired session -> 401 from dependency
  * revoke_session -> immediate 401
  * Logout-Everywhere (revoke_all_for_user) revokes all sessions
  * SameSite + HttpOnly + Secure flags present in Set-Cookie header
  * Cookie-only /logout clears cookie + revokes session
  * Cleanup: purge_expired_sessions deletes expired rows
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from dcc_auth import browser_sessions as bs
from dcc_auth.models import UserSession

# Shared test credentials
_REG = {
    "username": "cookie_user",
    "email": "cookie@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Cookie Tester",
}

_LOGIN = {
    "email_or_username": _REG["email"],
    "password": _REG["password"],
}


# ---- helpers ----------------------------------------------------------


async def _register_and_login(client):
    """Register + login, return login response."""
    await client.post("/register", json=_REG)
    login_r = await client.post("/login", json=_LOGIN)
    assert login_r.status_code == 200, login_r.text
    return login_r


# ---- cookie-presence tests --------------------------------------------


@pytest.mark.asyncio
async def test_login_sets_session_cookie(client):
    """POST /login must emit a Set-Cookie: pulse_session=... header."""
    await client.post("/register", json=_REG)
    r = await client.post("/login", json=_LOGIN)
    assert r.status_code == 200
    assert "pulse_session" in r.cookies, "expected pulse_session cookie in response"


@pytest.mark.asyncio
async def test_login_cookie_flags(client):
    """pulse_session Set-Cookie must have HttpOnly + SameSite=strict + Secure."""
    await client.post("/register", json=_REG)
    r = await client.post("/login", json=_LOGIN)
    assert r.status_code == 200

    set_cookie_header = r.headers.get("set-cookie", "")
    assert set_cookie_header, "Set-Cookie header missing"
    lower = set_cookie_header.lower()
    assert "httponly" in lower, f"HttpOnly flag missing in: {set_cookie_header}"
    assert "samesite=strict" in lower, f"SameSite=strict missing in: {set_cookie_header}"
    assert "secure" in lower, f"Secure flag missing in: {set_cookie_header}"
    assert "max-age=" in lower, f"Max-Age missing in: {set_cookie_header}"


@pytest.mark.asyncio
async def test_login_also_returns_jwt(client):
    """JWT tokens must still be present alongside the cookie (parallel paths)."""
    await client.post("/register", json=_REG)
    r = await client.post("/login", json=_LOGIN)
    assert r.status_code == 200
    body = r.json()
    assert "access_token" in body
    assert "refresh_token" in body


# ---- cookie-auth tests ------------------------------------------------


@pytest.mark.asyncio
async def test_me_via_cookie(client):
    """GET /me authenticated via session cookie (no Authorization header)."""
    login_r = await _register_and_login(client)
    sid = login_r.cookies["pulse_session"]
    r = await client.get("/me", cookies={"pulse_session": sid})
    assert r.status_code == 200, r.text
    assert r.json()["email"] == _REG["email"]


@pytest.mark.asyncio
async def test_me_missing_cookie_returns_401(client):
    """Without any auth the /me endpoint must 401."""
    r = await client.get("/me")
    assert r.status_code == 401


# ---- expiry / revocation tests ----------------------------------------


@pytest.mark.asyncio
async def test_expired_session_returns_401(client, session_factory):
    """Manually-expired UserSession row -> cookie dependency raises 401."""
    login_r = await _register_and_login(client)
    sid_str = login_r.cookies["pulse_session"]
    sid = uuid.UUID(sid_str)

    # Force expiry in the DB
    async with session_factory() as db:
        row = await db.get(UserSession, str(sid))
        assert row is not None
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await db.commit()

    r = await client.get("/me", cookies={"pulse_session": sid_str})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_revoke_session_works_immediately(client, session_factory):
    """revoke_session() must make subsequent cookie-auth fail at once."""
    login_r = await _register_and_login(client)
    sid_str = login_r.cookies["pulse_session"]
    sid = uuid.UUID(sid_str)

    async with session_factory() as db:
        revoked = await bs.revoke_session(db, sid)
        assert revoked is True
        await db.commit()

    r = await client.get("/me", cookies={"pulse_session": sid_str})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_revoke_all_for_user(client, session_factory):
    """revoke_all_for_user() must expire all active sessions for the user."""
    # Two logins = two session rows
    await client.post("/register", json=_REG)
    r1 = await client.post("/login", json=_LOGIN)
    r2 = await client.post("/login", json=_LOGIN)
    sid1 = r1.cookies["pulse_session"]
    sid2 = r2.cookies["pulse_session"]

    # Get user_id from JWT
    import jwt as pyjwt
    claims = pyjwt.decode(r1.json()["access_token"], options={"verify_signature": False})
    user_id = int(claims["sub"])

    async with session_factory() as db:
        count = await bs.revoke_all_for_user(db, user_id)
        await db.commit()

    assert count >= 2

    for sid in (sid1, sid2):
        r = await client.get("/me", cookies={"pulse_session": sid})
        assert r.status_code == 401, f"session {sid} should be revoked"


# ---- logout tests -----------------------------------------------------


@pytest.mark.asyncio
async def test_logout_clears_cookie(client):
    """POST /logout must respond with a Set-Cookie that deletes pulse_session."""
    login_r = await _register_and_login(client)
    sid = login_r.cookies["pulse_session"]

    r = await client.post(
        "/logout",
        json={"refresh_token": login_r.json()["refresh_token"]},
        cookies={"pulse_session": sid},
    )
    assert r.status_code == 200
    set_cookie = r.headers.get("set-cookie", "")
    # delete_cookie sets max-age=0 or expires in the past
    assert "pulse_session" in set_cookie
    lower = set_cookie.lower()
    assert "max-age=0" in lower or "max-age=-1" in lower or "expires=" in lower


@pytest.mark.asyncio
async def test_logout_revokes_cookie_session(client, session_factory):
    """After /logout, the session cookie must no longer authenticate."""
    login_r = await _register_and_login(client)
    sid = login_r.cookies["pulse_session"]

    await client.post(
        "/logout",
        json={"refresh_token": login_r.json()["refresh_token"]},
        cookies={"pulse_session": sid},
    )

    # Cookie auth should now fail
    r = await client.get("/me", cookies={"pulse_session": sid})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_logout_without_refresh_token(client):
    """Cookie-only logout (no refresh_token in body) must still succeed."""
    login_r = await _register_and_login(client)
    sid = login_r.cookies["pulse_session"]

    r = await client.post(
        "/logout",
        json={},
        cookies={"pulse_session": sid},
    )
    assert r.status_code == 200

    r2 = await client.get("/me", cookies={"pulse_session": sid})
    assert r2.status_code == 401


# ---- cleanup tests ----------------------------------------------------


@pytest.mark.asyncio
async def test_purge_expired_sessions(session_factory, engine):
    """purge_expired_sessions() removes rows whose expires_at <= now."""
    from dcc_auth.models import User
    from dcc_auth.snowflake import next_id

    async with session_factory() as db:
        # Create a stub user
        user = User(
            id=next_id(),
            username="cleanup_test_usr",
            email="cleanup@dcc-test.example.com",
            password_hash="x",
        )
        db.add(user)
        await db.flush()

        now = datetime.now(UTC)
        expired_sid = str(uuid.uuid4())
        active_sid = str(uuid.uuid4())

        # One already-expired session
        expired = UserSession(
            session_id=expired_sid,
            user_id=user.id,
            created_at=now - timedelta(hours=2),
            last_seen_at=now - timedelta(hours=2),
            expires_at=now - timedelta(hours=1),
            amr=["pwd"],
            acr="0",
        )
        # One still-active session
        active = UserSession(
            session_id=active_sid,
            user_id=user.id,
            created_at=now,
            last_seen_at=now,
            expires_at=now + timedelta(hours=1),
            amr=["pwd"],
            acr="0",
        )
        db.add(expired)
        db.add(active)
        await db.commit()

        deleted = await bs.purge_expired_sessions(db)
        await db.commit()

    assert deleted >= 1  # the expired row
    # active session must still be there
    async with session_factory() as db:
        row = await db.get(UserSession, active_sid)
        assert row is not None
