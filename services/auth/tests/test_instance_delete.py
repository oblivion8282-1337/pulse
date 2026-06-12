"""Tests für DELETE /me/instances/{id} — Owner-Löschung (Soft-Delete).

Deckt ab: Happy-Path (Status/Hostname-Platzhalter/Kill-Switch-Eintrag),
Sichtbarkeit (Liste/Snippet/Bootstrap-Token nach Löschung), Ownership-404,
Hostname-Freigabe für Neuanträge und die Admin-Guards gegen 'deleted'.
"""

from __future__ import annotations

import secrets

import pytest
import pytest_asyncio
from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance, SuspendedInstance
from sqlalchemy import select

# ---------------------------------------------------------------------------
# Shared test credentials
# ---------------------------------------------------------------------------

_REG_OWNER = {
    "username": "del_owner",
    "email": "del_owner@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Owner",
}
_REG_OTHER = {
    "username": "del_other",
    "email": "del_other@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Other",
}
_LOGIN_OWNER = {"email_or_username": _REG_OWNER["email"], "password": _REG_OWNER["password"]}
_LOGIN_OTHER = {"email_or_username": _REG_OTHER["email"], "password": _REG_OTHER["password"]}

_HOSTNAME = "delete-me.example.com"
_INSTANCE_ID = 10000000000000042


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------


async def _reg_and_login(client, reg: dict, login: dict) -> str:
    await client.post("/register", json=reg)
    r = await client.post("/login", json=login)
    assert r.status_code == 200, r.text
    sid = r.cookies.get("pulse_session")
    assert sid, "pulse_session cookie fehlt"
    return f"pulse_session={sid}"


@pytest_asyncio.fixture
async def owner_cookie(client) -> str:
    return await _reg_and_login(client, _REG_OWNER, _LOGIN_OWNER)


@pytest_asyncio.fixture
async def other_cookie(client) -> str:
    return await _reg_and_login(client, _REG_OTHER, _LOGIN_OTHER)


async def _seed_instance(
    session_factory, client, owner_cookie: str, *, status: str = "active"
) -> RegisteredInstance:
    r = await client.get("/me", headers={"Cookie": owner_cookie})
    assert r.status_code == 200, r.text
    owner_id = int(r.json()["id"])

    async with session_factory() as session:
        inst = RegisteredInstance(
            id=_INSTANCE_ID,
            hostname=_HOSTNAME,
            client_id=f"ci_{secrets.token_hex(8)}",
            client_secret="$argon2id$v=19$m=65536,t=3,p=4$fakehash",
            worker_id_chat=100,
            worker_id_voice=101,
            worker_id_media=102,
            status=status,
            registered_by=owner_id,
        )
        session.add(inst)
        await session.commit()
    return inst


@pytest_asyncio.fixture
async def owner_instance(session_factory, client, owner_cookie) -> RegisteredInstance:
    return await _seed_instance(session_factory, client, owner_cookie)


async def _fetch_instance(session_factory) -> RegisteredInstance | None:
    async with session_factory() as session:
        return await session.get(RegisteredInstance, _INSTANCE_ID)


async def _fetch_suspend_rows(session_factory) -> list[SuspendedInstance]:
    async with session_factory() as session:
        rows = await session.execute(
            select(SuspendedInstance).where(SuspendedInstance.instance_id == _INSTANCE_ID)
        )
        return list(rows.scalars().all())


# ---------------------------------------------------------------------------
# Auth + Ownership
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_requires_cookie(client):
    r = await client.delete("/me/instances/12345")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_delete_404_for_other_user(client, other_cookie, owner_instance, session_factory):
    r = await client.delete(
        f"/me/instances/{owner_instance.id}", headers={"Cookie": other_cookie}
    )
    assert r.status_code == 404
    inst = await _fetch_instance(session_factory)
    assert inst is not None and inst.status == "active"


@pytest.mark.asyncio
async def test_delete_404_nonexistent_and_invalid_id(client, owner_cookie):
    r = await client.delete("/me/instances/999999999", headers={"Cookie": owner_cookie})
    assert r.status_code == 404
    r = await client.delete("/me/instances/not-a-number", headers={"Cookie": owner_cookie})
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_happy_path(client, owner_cookie, owner_instance, session_factory):
    r = await client.delete(
        f"/me/instances/{owner_instance.id}", headers={"Cookie": owner_cookie}
    )
    assert r.status_code == 204, r.text

    # Soft-Delete: Zeile bleibt (Worker-IDs verbrannt), Hostname freigegeben.
    inst = await _fetch_instance(session_factory)
    assert inst is not None
    assert inst.status == "deleted"
    assert inst.hostname == f"deleted-{_INSTANCE_ID}.invalid"

    # Kill-Switch: Eintrag auf der Suspend-Liste.
    suspend_rows = await _fetch_suspend_rows(session_factory)
    assert len(suspend_rows) == 1
    assert suspend_rows[0].reason == "Vom Besitzer gelöscht"

    # Für den Owner unsichtbar.
    r = await client.get("/me/instances", headers={"Cookie": owner_cookie})
    assert r.status_code == 200
    assert r.json() == []

    # Zweites Löschen → 404 (weg ist weg).
    r = await client.delete(
        f"/me/instances/{owner_instance.id}", headers={"Cookie": owner_cookie}
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_delete_appears_in_wellknown_deleted_list(
    client, owner_cookie, owner_instance, session_factory
):
    """Gelöschte Instanz steht in instance_ids UND deleted_instance_ids."""
    r = await client.delete(
        f"/me/instances/{owner_instance.id}", headers={"Cookie": owner_cookie}
    )
    assert r.status_code == 204

    r = await client.get("/.well-known/pulse-suspended-instances")
    assert r.status_code == 200
    # CORS-offen — der Browser-Sweep fetcht auch von Self-Host-Origins.
    assert r.headers.get("access-control-allow-origin") == "*"
    body = r.json()
    assert str(_INSTANCE_ID) in body["instance_ids"]
    assert str(_INSTANCE_ID) in body["deleted_instance_ids"]


@pytest.mark.asyncio
async def test_admin_suspend_not_in_deleted_list(client, owner_cookie, session_factory):
    """Nur admin-suspendiert (reversibel) → instance_ids ja, deleted_instance_ids nein."""
    await _seed_instance(session_factory, client, owner_cookie, status="suspended")
    async with session_factory() as session:
        session.add(SuspendedInstance(instance_id=_INSTANCE_ID, reason="admin"))
        await session.commit()

    r = await client.get("/.well-known/pulse-suspended-instances")
    assert r.status_code == 200
    body = r.json()
    assert str(_INSTANCE_ID) in body["instance_ids"]
    assert str(_INSTANCE_ID) not in body["deleted_instance_ids"]


@pytest.mark.asyncio
async def test_delete_blocks_snippet_and_bootstrap_token(
    client, owner_cookie, owner_instance, session_factory
):
    r = await client.delete(
        f"/me/instances/{owner_instance.id}", headers={"Cookie": owner_cookie}
    )
    assert r.status_code == 204

    r = await client.get(
        f"/me/instances/{owner_instance.id}/docker-compose-snippet",
        headers={"Cookie": owner_cookie},
    )
    assert r.status_code == 404

    r = await client.post(
        f"/me/instances/{owner_instance.id}/bootstrap-token",
        headers={"Cookie": owner_cookie},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_delete_frees_hostname_for_new_application(
    client, owner_cookie, owner_instance, session_factory
):
    # Vor der Löschung: Hostname ist belegt → Antrag 409.
    app_payload = {
        "hostname": _HOSTNAME,
        "purpose": "privat",
        "expected_users": 5,
        "contact_email": "owner@dcc-test.example.com",
    }
    r = await client.post(
        "/me/instance-applications", json=app_payload, headers={"Cookie": owner_cookie}
    )
    assert r.status_code == 409

    r = await client.delete(
        f"/me/instances/{owner_instance.id}", headers={"Cookie": owner_cookie}
    )
    assert r.status_code == 204

    # Nach der Löschung: Hostname wieder frei.
    r = await client.post(
        "/me/instance-applications", json=app_payload, headers={"Cookie": owner_cookie}
    )
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_delete_suspended_instance_keeps_single_suspend_entry(
    client, owner_cookie, session_factory
):
    """Admin-suspendierte Instanz darf der Owner löschen — ohne doppelten Suspend-Eintrag."""
    await _seed_instance(session_factory, client, owner_cookie, status="suspended")
    async with session_factory() as session:
        session.add(SuspendedInstance(instance_id=_INSTANCE_ID, reason="admin"))
        await session.commit()

    r = await client.delete(f"/me/instances/{_INSTANCE_ID}", headers={"Cookie": owner_cookie})
    assert r.status_code == 204

    inst = await _fetch_instance(session_factory)
    assert inst is not None and inst.status == "deleted"
    suspend_rows = await _fetch_suspend_rows(session_factory)
    assert len(suspend_rows) == 1
    assert suspend_rows[0].reason == "admin"


# ---------------------------------------------------------------------------
# Admin-Guards gegen 'deleted'
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def admin_token(client, session_factory, owner_cookie) -> str:
    """Eigener Admin-User (Bearer-Token) — owner_cookie zuerst, damit der
    Bootstrap-Admin-Slot (erster User) schon verbraucht ist."""
    await client.post(
        "/register",
        json={
            "username": "del_admin",
            "email": "del_admin@dcc-test.example.com",
            "password": "correct horse battery staple",
        },
    )
    async with session_factory() as s:
        user = (
            await s.execute(select(User).where(User.username == "del_admin"))
        ).scalar_one()
        user.is_admin = True
        await s.commit()
    r = await client.post(
        "/login",
        json={
            "email_or_username": "del_admin",
            "password": "correct horse battery staple",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.mark.asyncio
async def test_admin_actions_409_on_deleted(
    client, owner_cookie, owner_instance, session_factory, admin_token
):
    r = await client.delete(
        f"/me/instances/{owner_instance.id}", headers={"Cookie": owner_cookie}
    )
    assert r.status_code == 204

    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.delete(f"/admin/instances/{owner_instance.id}", headers=headers)
    assert r.status_code == 409
    r = await client.post(f"/admin/instances/{owner_instance.id}/unsuspend", headers=headers)
    assert r.status_code == 409
    r = await client.post(
        f"/admin/instances/{owner_instance.id}/rotate-secret", headers=headers
    )
    assert r.status_code == 409
