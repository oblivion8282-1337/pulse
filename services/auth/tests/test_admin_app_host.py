"""App-Host-Approval provisioniert automatisch eine Relay-Instanz (Feature 1).

Vor dem Fix setzte ``approve`` nur ``self_host_enabled=true`` und der User landete
auf der „Keine Instanz"-Karte. Jetzt legt die Genehmigung eine ``RegisteredInstance``
(+ Owner-Membership) an, sodass der User sofort aus der App hosten kann.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from dcc_auth.models import User
from dcc_auth.models_app_host import AppHostApplication
from dcc_auth.models_instances import RegisteredInstance, UserInstanceMembership
from dcc_auth.snowflake import next_id


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
        app = AppHostApplication(
            id=next_id(), user_id=user_id, purpose="privat", status="pending"
        )
        s.add(app)
        await s.commit()
        return app.id


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
async def test_approve_provisions_relay_instance(
    client, owner_token, applicant_id, session_factory
):
    app_id = await _seed_app_host(session_factory, user_id=applicant_id)
    r = await client.post(
        f"/admin/app-host-applications/{app_id}/approve", headers=_auth(owner_token)
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["self_host_enabled"] is True
    assert data["instance_id"] is not None

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, int(data["instance_id"]))
        assert inst is not None
        assert inst.status == "active"
        assert inst.registered_by == applicant_id
        # Synthetischer Hostname + Relay-Subdomain noch NULL (kommt beim Pairing).
        assert inst.hostname.startswith("app-")
        assert inst.relay_subdomain is None
        membership = await s.get(
            UserInstanceMembership, (applicant_id, inst.id)
        )
        assert membership is not None and membership.role == "owner"
        # Flag gesetzt.
        bob = await s.get(User, applicant_id)
        assert bob.self_host_enabled is True


@pytest.mark.asyncio
async def test_approve_idempotent_when_user_has_instance(
    client, owner_token, applicant_id, session_factory
):
    """Hat der User schon eine aktive Instanz, wird keine zweite angelegt."""
    # Erste Genehmigung legt eine Instanz an.
    app1 = await _seed_app_host(session_factory, user_id=applicant_id)
    r1 = await client.post(
        f"/admin/app-host-applications/{app1}/approve", headers=_auth(owner_token)
    )
    first_id = r1.json()["instance_id"]
    assert first_id is not None

    # Zweite (künstliche) Genehmigung → keine neue Instanz (instance_id null).
    app2 = await _seed_app_host(session_factory, user_id=applicant_id)
    r2 = await client.post(
        f"/admin/app-host-applications/{app2}/approve", headers=_auth(owner_token)
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["instance_id"] is None

    async with session_factory() as s:
        count = len(
            (
                await s.execute(
                    select(RegisteredInstance.id).where(
                        RegisteredInstance.registered_by == applicant_id
                    )
                )
            ).scalars().all()
        )
        assert count == 1


@pytest.mark.asyncio
async def test_approve_requires_owner(
    client, owner_token, applicant_id, session_factory
):
    """Ein Admin OHNE Owner-Recht darf nicht genehmigen → 403, keine Instanz."""
    await _register(client, username="modonly", email="modonly@dcc-test.example.com")
    await _make_owner(session_factory, "modonly", owner=False)
    mod_token = await _login(client, username="modonly")
    app_id = await _seed_app_host(session_factory, user_id=applicant_id)
    r = await client.post(
        f"/admin/app-host-applications/{app_id}/approve", headers=_auth(mod_token)
    )
    assert r.status_code == 403
