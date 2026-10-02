"""App-Host-Approval provisioniert automatisch eine Relay-Instanz (Feature 1).

Vor dem Fix setzte ``approve`` nur ``self_host_enabled=true`` und der User landete
auf der „Keine Instanz"-Karte. Jetzt legt die Genehmigung eine ``RegisteredInstance``
(+ Owner-Membership) an, sodass der User sofort aus der App hosten kann.

Seit dem vereinten Antragssystem (Migration 0044) laufen diese Tests über die
DEPRECATED-Wrapper-Pfade ``/admin/app-host-applications/*`` — sie verifizieren
damit gleichzeitig, dass die Wrapper das alte Verhalten exakt erhalten.
Die vereinten Pfade deckt ``test_unified_applications.py`` ab.
"""

from __future__ import annotations

import pytest
from dcc_auth.models import User
from dcc_auth.models_instances import (
    InstanceApplication,
    RegisteredInstance,
    UserInstanceMembership,
)
from dcc_auth.snowflake import next_id
from sqlalchemy import select


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register(client, *, username: str, email: str) -> str:
    r = await client.post(
        "/register",
        json={
            "username": username,
            "email": email,
            "password": "correct horse battery staple",
        },
    )
    assert r.status_code in (200, 201), r.text
    return r.json()["access_token"]


async def _login(client, *, username: str) -> str:
    r = await client.post(
        "/login",
        json={
            "email_or_username": username,
            "password": "correct horse battery staple",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


async def _make_owner(session_factory, username: str, *, owner: bool = True) -> None:
    async with session_factory() as s:
        u = (
            await s.execute(select(User).where(User.username == username))
        ).scalar_one()
        u.is_admin = True
        u.is_owner = owner
        await s.commit()


async def _user_id(session_factory, username: str) -> int:
    async with session_factory() as s:
        return (
            await s.execute(select(User.id).where(User.username == username))
        ).scalar_one()


async def _seed_app_host(session_factory, *, user_id: int) -> int:
    async with session_factory() as s:
        app_id = next_id()
        app = InstanceApplication(
            id=app_id,
            applicant_user_id=user_id,
            origin="app_host",
            hostname=f"app-{app_id}.relay.howispulse.com",
            purpose="privat",
            expected_users=1,
            contact_email="applicant@dcc-test.example.com",
            status="pending",
        )
        s.add(app)
        await s.commit()
        return app_id


@pytest.fixture
async def owner_token(client, session_factory):
    await _register(client, username="alice", email="alice@dcc-test.example.com")
    await _make_owner(session_factory, "alice")
    return await _login(client, username="alice")


@pytest.fixture
async def applicant_id(client, session_factory):
    await _register(client, username="bob", email="bob@dcc-test.example.com")
    return await _user_id(session_factory, "bob")


@pytest.mark.asyncio
async def test_approve_is_gone_since_selfservice(client, owner_token, applicant_id, session_factory):
    """Heim-Server-Entscheid 2026-09-27: App-Host-Freischaltung ist obsolet —
    die Server-App registriert sich selbst (POST /me/instances). Approve
    antwortet 410; alte Pending-Zeilen können nur noch abgelehnt werden."""
    app_id = await _seed_app_host(session_factory, user_id=applicant_id)
    async with session_factory() as session:
        app_row = await session.get(InstanceApplication, app_id)
        assert app_row is not None and app_row.status == "pending"
    r = await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        json={},
        headers=_auth(owner_token),
    )
    assert r.status_code == 410, r.text


async def test_approve_requires_owner(
    client, owner_token, applicant_id, session_factory
):
    """Ein Admin OHNE Owner-Recht darf nicht genehmigen → 403, keine Instanz."""
    await _register(client, username="modonly", email="modonly@dcc-test.example.com")
    await _make_owner(session_factory, "modonly", owner=False)
    mod_token = await _login(client, username="modonly")
    app_id = await _seed_app_host(session_factory, user_id=applicant_id)
    r = await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        json={},
        headers=_auth(mod_token),
    )
    assert r.status_code == 403
