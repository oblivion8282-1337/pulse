"""Admin-only routes: gate checks + happy paths + last-admin safety nets.

The fixture pattern: register two users via /register, then directly flip
``is_admin`` on one of them via SQLAlchemy, then /login to mint a fresh
access-token that carries the ``admin: true`` claim. Going through the
real public endpoints keeps these tests close to what production sees.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from dcc_auth.models import RefreshToken, User


async def _register_user(client, *, username: str, email: str) -> str:
    """Register, return the bearer access token."""
    r = await client.post(
        "/register",
        json={
            "username": username,
            "email": email,
            "password": "correct horse battery staple",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["access_token"]


async def _promote(session_factory, username: str) -> int:
    async with session_factory() as s:
        user = (
            await s.execute(select(User).where(User.username == username))
        ).scalar_one()
        user.is_admin = True
        await s.commit()
        return user.id


async def _login(client, *, username_or_email: str) -> str:
    r = await client.post(
        "/login",
        json={
            "email_or_username": username_or_email,
            "password": "correct horse battery staple",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture
async def admin_token(client, session_factory):
    """Register `alice`, promote to admin, return a fresh admin-claim token.

    Note: alice is the very first user the test DB sees, so the
    bootstrap-admin path in routes.py::register would already set
    is_admin=True. The explicit ``_promote`` is still here for tests
    that want to be portable to a non-empty DB layout (e.g. when a
    later test registers a "throwaway-first" before promoting). Going
    through _promote keeps the assertion stable either way."""
    await _register_user(client, username="alice", email="alice@example.com")
    await _promote(session_factory, "alice")
    return await _login(client, username_or_email="alice")


@pytest.fixture
async def regular_token(client):
    # The bootstrap path makes the *first* registered user an admin.
    # Burn that slot on a throwaway so bob arrives as a regular user.
    await _register_user(
        client, username="bootstrap", email="bootstrap@example.com"
    )
    return await _register_user(client, username="bob", email="bob@example.com")


@pytest.mark.asyncio
async def test_admin_routes_403_for_non_admin(client, regular_token):
    headers = {"Authorization": f"Bearer {regular_token}"}
    for path in ("/admin/users", "/admin/settings", "/admin/audit-log", "/admin/stats"):
        r = await client.get(path, headers=headers)
        assert r.status_code == 403, f"{path}: {r.text}"


@pytest.mark.asyncio
async def test_admin_routes_401_without_token(client):
    r = await client.get("/admin/users")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_list_users_returns_admin_view(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.get("/admin/users", headers=headers)
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1  # only alice exists
    assert rows[0]["username"] == "alice"
    assert rows[0]["is_admin"] is True
    assert rows[0]["disabled"] is False
    assert "email" in rows[0]  # admin view includes email


@pytest.mark.asyncio
async def test_stats_returns_counts(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    await _register_user(client, username="bob", email="bob@example.com")
    r = await client.get("/admin/stats", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body == {"user_count": 2, "admin_count": 1, "disabled_count": 0}


@pytest.mark.asyncio
async def test_patch_user_promote_to_admin(client, admin_token, session_factory):
    await _register_user(client, username="bob", email="bob@example.com")
    async with session_factory() as s:
        bob_id = (
            await s.execute(select(User.id).where(User.username == "bob"))
        ).scalar_one()

    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.patch(
        f"/admin/users/{bob_id}", json={"is_admin": True}, headers=headers
    )
    assert r.status_code == 200, r.text
    assert r.json()["is_admin"] is True

    # Audit-log records the change.
    r = await client.get("/admin/audit-log", headers=headers)
    entries = r.json()
    assert any(
        e["action"] == "user.patch" and int(e["target_id"]) == bob_id for e in entries
    )


@pytest.mark.asyncio
async def test_patch_user_demote_last_admin_blocked(
    client, admin_token, session_factory
):
    async with session_factory() as s:
        alice = (
            await s.execute(select(User).where(User.username == "alice"))
        ).scalar_one()
        alice_id = alice.id
        # alice ist Bootstrap-User → auch Owner; den Owner-Guard hier
        # abschalten, damit dieser Test gezielt den „letzter Admin"-Pfad prüft
        # (Owner-Schutz hat einen eigenen Test).
        alice.is_owner = False
        await s.commit()
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.patch(
        f"/admin/users/{alice_id}", json={"is_admin": False}, headers=headers
    )
    assert r.status_code == 400
    assert "last admin" in r.json()["detail"]


@pytest.mark.asyncio
async def test_patch_user_disable_revokes_refresh_tokens(
    client, admin_token, session_factory
):
    # Bob logs in, gets a refresh-token row. Admin then disables him.
    await _register_user(client, username="bob", email="bob@example.com")
    await _login(client, username_or_email="bob")

    async with session_factory() as s:
        bob = (
            await s.execute(select(User).where(User.username == "bob"))
        ).scalar_one()
        active_before = (
            await s.execute(
                select(RefreshToken).where(
                    RefreshToken.user_id == bob.id, RefreshToken.revoked_at.is_(None)
                )
            )
        ).scalars().all()
        assert len(active_before) >= 1  # register + login both issued
        bob_id = bob.id

    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.patch(
        f"/admin/users/{bob_id}", json={"disabled": True}, headers=headers
    )
    assert r.status_code == 200

    async with session_factory() as s:
        active_after = (
            await s.execute(
                select(RefreshToken).where(
                    RefreshToken.user_id == bob_id, RefreshToken.revoked_at.is_(None)
                )
            )
        ).scalars().all()
        assert active_after == []


@pytest.mark.asyncio
async def test_patch_user_disable_self_blocked(client, admin_token, session_factory):
    async with session_factory() as s:
        alice_id = (
            await s.execute(select(User.id).where(User.username == "alice"))
        ).scalar_one()
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.patch(
        f"/admin/users/{alice_id}", json={"disabled": True}, headers=headers
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_settings_round_trip(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.get("/admin/settings", headers=headers)
    assert r.status_code == 200
    assert r.json() == {"registration_mode": "open"}

    r = await client.patch(
        "/admin/settings", json={"registration_mode": "closed"}, headers=headers
    )
    assert r.status_code == 200
    assert r.json() == {"registration_mode": "closed"}

    r = await client.get("/admin/settings", headers=headers)
    assert r.json() == {"registration_mode": "closed"}


@pytest.mark.asyncio
async def test_register_blocked_when_closed(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    await client.patch(
        "/admin/settings", json={"registration_mode": "closed"}, headers=headers
    )
    r = await client.post(
        "/register",
        json={
            "username": "newbie",
            "email": "newbie@example.com",
            "password": "correct horse battery staple",
        },
    )
    assert r.status_code == 403
    assert "registration is closed" in r.json()["detail"]


@pytest.mark.asyncio
async def test_register_blocked_when_invite_only(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    await client.patch(
        "/admin/settings", json={"registration_mode": "invite_only"}, headers=headers
    )
    r = await client.post(
        "/register",
        json={
            "username": "newbie",
            "email": "newbie@example.com",
            "password": "correct horse battery staple",
        },
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_disabled_user_cant_login(client, admin_token, session_factory):
    await _register_user(client, username="bob", email="bob@example.com")
    async with session_factory() as s:
        bob_id = (
            await s.execute(select(User.id).where(User.username == "bob"))
        ).scalar_one()

    headers = {"Authorization": f"Bearer {admin_token}"}
    await client.patch(
        f"/admin/users/{bob_id}", json={"disabled": True}, headers=headers
    )

    r = await client.post(
        "/login",
        json={
            "email_or_username": "bob",
            "password": "correct horse battery staple",
        },
    )
    assert r.status_code == 401




# ─── Owner-Stufe: Schutz gegen Demote/Ban + is_owner im Admin-View ──────────


@pytest.mark.asyncio
async def test_owner_cannot_be_demoted_or_banned(
    client, admin_token, session_factory
):
    """Ein Zweit-Admin (nicht Owner) kann den Owner weder entmachten noch sperren."""
    # alice = Bootstrap-User → is_admin + is_owner. bob = zweiter, nur Admin.
    await _register_user(client, username="bob", email="bob@example.com")
    await _promote(session_factory, "bob")  # nur is_admin
    bob_token = await _login(client, username_or_email="bob")
    async with session_factory() as s:
        alice_id = (
            await s.execute(select(User.id).where(User.username == "alice"))
        ).scalar_one()
    headers = {"Authorization": f"Bearer {bob_token}"}

    r = await client.patch(
        f"/admin/users/{alice_id}", json={"is_admin": False}, headers=headers
    )
    assert r.status_code == 400
    assert "owner" in r.json()["detail"]

    r = await client.patch(
        f"/admin/users/{alice_id}", json={"disabled": True}, headers=headers
    )
    assert r.status_code == 400
    assert "owner" in r.json()["detail"]

    # Auch das Self-Host-Recht des Owners ist unantastbar.
    r = await client.patch(
        f"/admin/users/{alice_id}", json={"self_host_enabled": False}, headers=headers
    )
    assert r.status_code == 400
    assert "owner" in r.json()["detail"]


@pytest.mark.asyncio
async def test_admin_view_exposes_is_owner(client, admin_token):
    """Der Admin-User-View liefert is_owner (true für den Bootstrap-Owner)."""
    headers = {"Authorization": f"Bearer {admin_token}"}
    rows = (await client.get("/admin/users", headers=headers)).json()
    alice = next(u for u in rows if u["username"] == "alice")
    assert alice["is_owner"] is True


# ─── Userliste: Suche (q) + Rollenfilter ────────────────────────────────────


@pytest.mark.asyncio
async def test_list_users_search_matches_name_and_email(client, admin_token):
    """``q`` filtert case-insensitiv über Username / Anzeigename / E-Mail."""
    await _register_user(client, username="carol", email="carol@example.com")
    await _register_user(client, username="dave", email="dave@somewhere.org")
    headers = {"Authorization": f"Bearer {admin_token}"}

    # Teil des Usernamens, andere Groß-/Kleinschreibung.
    rows = (await client.get("/admin/users?q=CAR", headers=headers)).json()
    assert {u["username"] for u in rows} == {"carol"}

    # Treffer über die E-Mail-Domain.
    rows = (await client.get("/admin/users?q=somewhere", headers=headers)).json()
    assert {u["username"] for u in rows} == {"dave"}

    # Kein Treffer → leere Liste.
    rows = (await client.get("/admin/users?q=zzz-none", headers=headers)).json()
    assert rows == []


@pytest.mark.asyncio
async def test_list_users_filter_by_role(client, admin_token, session_factory):
    """``filter`` schränkt auf admins / disabled / self_host ein."""
    await _register_user(client, username="carol", email="carol@example.com")
    await _register_user(client, username="dave", email="dave@example.com")
    async with session_factory() as s:
        carol = (
            await s.execute(select(User).where(User.username == "carol"))
        ).scalar_one()
        carol.disabled = True
        dave = (
            await s.execute(select(User).where(User.username == "dave"))
        ).scalar_one()
        dave.self_host_enabled = True
        await s.commit()
    headers = {"Authorization": f"Bearer {admin_token}"}

    # admins → nur der Bootstrap-Owner alice (is_admin).
    rows = (await client.get("/admin/users?filter=admins", headers=headers)).json()
    assert {u["username"] for u in rows} == {"alice"}

    rows = (await client.get("/admin/users?filter=disabled", headers=headers)).json()
    assert {u["username"] for u in rows} == {"carol"}

    rows = (await client.get("/admin/users?filter=self_host", headers=headers)).json()
    assert {u["username"] for u in rows} == {"dave"}


@pytest.mark.asyncio
async def test_list_users_rejects_unknown_filter(client, admin_token):
    """Ein unbekannter filter-Wert → 422 (Query-Pattern), kein stiller Fallthrough."""
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.get("/admin/users?filter=bogus", headers=headers)
    assert r.status_code == 422
