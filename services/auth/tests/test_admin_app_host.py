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
        # Herkunfts-Marker: App-Host-Instanzen erscheinen nur in der
        # App-Hosting-Karte, nicht in "Meine Instanzen" (Migration 0040).
        assert inst.origin == "app_host"
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
async def test_approve_provisions_despite_vps_instance(
    client, owner_token, applicant_id, session_factory
):
    """Eine bestehende VPS-Instanz blockt das App-Host-Provisioning NICHT.

    Die App-Hosting-Karte bietet nur origin=='app_host' an (Pairing rotiert
    das client_secret) — ohne diese Ausnahme säße ein VPS-Besitzer nach der
    Genehmigung im "no-instance"-Zustand fest."""
    async with session_factory() as s:
        vps = RegisteredInstance(
            id=next_id(),
            hostname="vps.example.org",
            client_id="vps-client-id",
            client_secret="x",
            worker_id_chat=901,
            worker_id_voice=902,
            worker_id_media=903,
            status="active",
            origin="vps",
            registered_by=applicant_id,
        )
        s.add(vps)
        s.add(
            UserInstanceMembership(
                user_id=applicant_id, instance_id=vps.id, role="owner"
            )
        )
        await s.commit()

    app_id = await _seed_app_host(session_factory, user_id=applicant_id)
    r = await client.post(
        f"/admin/app-host-applications/{app_id}/approve", headers=_auth(owner_token)
    )
    assert r.status_code == 200, r.text
    new_id = r.json()["instance_id"]
    assert new_id is not None

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, int(new_id))
        assert inst is not None and inst.origin == "app_host"


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


@pytest.mark.asyncio
async def test_revoke_disables_flag_and_suspends_instance(
    client, owner_token, applicant_id, session_factory
):
    """Rücknahme muss ALLE drei Wirkungen der Approval umkehren.

    Ein bloßer Statuswechsel ließe den User weiterhosten: das Flag stünde noch,
    und die auto-provisionierte Instanz liefe weiter.
    """
    app_id = await _seed_app_host(session_factory, user_id=applicant_id)
    r = await client.post(
        f"/admin/app-host-applications/{app_id}/approve", headers=_auth(owner_token)
    )
    assert r.status_code == 200, r.text
    instance_id = int(r.json()["instance_id"])

    r = await client.post(
        f"/admin/app-host-applications/{app_id}/revoke?reason=Missbrauch",
        headers=_auth(owner_token),
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        user = await s.get(User, applicant_id)
        assert user.self_host_enabled is False
        inst = await s.get(RegisteredInstance, instance_id)
        assert inst.status == "suspended"
        app = await s.get(AppHostApplication, app_id)
        assert app.status == "revoked"
        assert app.rejection_reason == "Missbrauch"

    # Kill-Switch: die Instanz steht auf der öffentlichen Sperrliste.
    r = await client.get("/.well-known/pulse-suspended-instances")
    assert r.status_code == 200
    assert str(instance_id) in r.json()["instance_ids"]


@pytest.mark.asyncio
async def test_revoke_only_on_approved(client, owner_token, applicant_id, session_factory):
    """Ein offener Antrag ist nicht "zurücknehmbar" — dafür gibt es reject."""
    app_id = await _seed_app_host(session_factory, user_id=applicant_id)
    r = await client.post(
        f"/admin/app-host-applications/{app_id}/revoke", headers=_auth(owner_token)
    )
    assert r.status_code == 409, r.text


@pytest.mark.asyncio
async def test_revoked_application_is_listable_and_user_may_reapply(
    client, owner_token, applicant_id, session_factory
):
    app_id = await _seed_app_host(session_factory, user_id=applicant_id)
    await client.post(
        f"/admin/app-host-applications/{app_id}/approve", headers=_auth(owner_token)
    )
    await client.post(
        f"/admin/app-host-applications/{app_id}/revoke", headers=_auth(owner_token)
    )

    r = await client.get(
        "/admin/app-host-applications?status=revoked", headers=_auth(owner_token)
    )
    assert r.status_code == 200, r.text
    assert [a["id"] for a in r.json()] == [str(app_id)]

    # Kein 'pending'-Antrag mehr offen → der Duplicate-Guard in
    # submit_app_host_application (prüft NUR auf 'pending') lässt einen
    # Neuantrag zu; ebenso der self_host_enabled-Guard, der jetzt false ist.
    r = await client.get(
        "/admin/app-host-applications?status=pending", headers=_auth(owner_token)
    )
    assert r.json() == []
