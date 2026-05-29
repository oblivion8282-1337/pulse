"""Registration invite-code flow (registration_mode == "invite_only").

Covers: admin gate on the invite routes, create/list/revoke, and the
/register enforcement — required-when-invite-only, single-use exhaustion,
revoked + expired rejection, and "open mode ignores the code".
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from dcc_auth.models import AuthSettings, RegistrationInvite, User
from sqlalchemy import select

_PW = "correct horse battery staple"


async def _register(client, *, username, email, invite_code=None):
    body = {"username": username, "email": email, "password": _PW}
    if invite_code is not None:
        body["invite_code"] = invite_code
    return await client.post("/register", json=body)


async def _login(client, who):
    r = await client.post("/login", json={"email_or_username": who, "password": _PW})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


async def _set_mode(session_factory, mode):
    async with session_factory() as s:
        row = await s.get(AuthSettings, 1)
        row.registration_mode = mode
        await s.commit()


@pytest.fixture
async def admin_headers(client, session_factory):
    # First user is the bootstrap admin.
    r = await _register(client, username="alice", email="alice@example.com")
    assert r.status_code == 201, r.text
    token = await _login(client, "alice")
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_invite_routes_require_admin(client):
    # No token → 401.
    assert (await client.get("/admin/invites")).status_code == 401
    # Register a regular (non-first) user → 403.
    await _register(client, username="boot", email="boot@example.com")  # bootstrap admin
    await _register(client, username="bob", email="bob@example.com")
    tok = await _login(client, "bob")
    h = {"Authorization": f"Bearer {tok}"}
    assert (await client.get("/admin/invites", headers=h)).status_code == 403
    assert (await client.post("/admin/invites", json={}, headers=h)).status_code == 403


@pytest.mark.asyncio
async def test_create_and_list_invite(client, admin_headers):
    r = await client.post("/admin/invites", json={"note": "für Max"}, headers=admin_headers)
    assert r.status_code == 201, r.text
    code = r.json()["code"]
    assert code and r.json()["max_uses"] == 1 and r.json()["uses"] == 0

    rows = (await client.get("/admin/invites", headers=admin_headers)).json()
    assert any(row["code"] == code and row["note"] == "für Max" for row in rows)


@pytest.mark.asyncio
async def test_invite_only_requires_valid_code(client, admin_headers, session_factory):
    code = (await client.post("/admin/invites", json={}, headers=admin_headers)).json()["code"]
    await _set_mode(session_factory, "invite_only")

    # No code → 403.
    r = await _register(client, username="nocode", email="nocode@example.com")
    assert r.status_code == 403 and "invite code required" in r.text

    # Bogus code → 403.
    r = await _register(client, username="bogus", email="bogus@example.com", invite_code="nope")
    assert r.status_code == 403

    # Valid code → 201, and the code's use count ticks up.
    r = await _register(client, username="real", email="real@example.com", invite_code=code)
    assert r.status_code == 201, r.text
    async with session_factory() as s:
        inv = await s.get(RegistrationInvite, code)
        assert inv.uses == 1


@pytest.mark.asyncio
async def test_single_use_code_exhausts(client, admin_headers, session_factory):
    code = (await client.post("/admin/invites", json={}, headers=admin_headers)).json()["code"]
    await _set_mode(session_factory, "invite_only")

    r1 = await _register(client, username="first", email="first@example.com", invite_code=code)
    assert r1.status_code == 201
    # Second use of a single-use code → 403, no second user created.
    r2 = await _register(client, username="second", email="second@example.com", invite_code=code)
    assert r2.status_code == 403
    async with session_factory() as s:
        assert (
            await s.scalar(select(User).where(User.username == "second"))
        ) is None


@pytest.mark.asyncio
async def test_multi_use_code(client, admin_headers, session_factory):
    code = (
        await client.post("/admin/invites", json={"max_uses": 3}, headers=admin_headers)
    ).json()["code"]
    await _set_mode(session_factory, "invite_only")
    for i in range(3):
        r = await _register(
            client, username=f"muser{i}", email=f"m{i}@example.com", invite_code=code
        )
        assert r.status_code == 201, r.text
    # 4th → exhausted.
    r = await _register(client, username="muser3", email="m3@example.com", invite_code=code)
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_revoked_code_rejected(client, admin_headers, session_factory):
    code = (await client.post("/admin/invites", json={}, headers=admin_headers)).json()["code"]
    assert (
        await client.delete(f"/admin/invites/{code}", headers=admin_headers)
    ).status_code == 204
    await _set_mode(session_factory, "invite_only")
    r = await _register(client, username="rvuser", email="rv@example.com", invite_code=code)
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_expired_code_rejected(client, admin_headers, session_factory):
    # Insert a code that expired yesterday directly.
    async with session_factory() as s:
        s.add(
            RegistrationInvite(
                code="expired-code",
                created_by=1,
                expires_at=datetime.now(UTC) - timedelta(days=1),
                max_uses=1,
            )
        )
        await s.commit()
    await _set_mode(session_factory, "invite_only")
    r = await _register(
        client, username="exuser", email="ex@example.com", invite_code="expired-code"
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_open_mode_ignores_invite_code(client, admin_headers):
    # Mode stays open (default). A passed code is simply ignored; no code is fine.
    r = await _register(client, username="open1", email="open1@example.com")
    assert r.status_code == 201
    r = await _register(
        client, username="open2", email="open2@example.com", invite_code="whatever"
    )
    assert r.status_code == 201
