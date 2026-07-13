"""Vereintes Antragssystem (Migration 0044): ein Antragsweg, origin unterscheidet.

Deckt ab:
- App-Host-Antrag über den vereinten Pfad (POST /me/instance-applications,
  origin='app_host'): Platzhalter-Hostname, Dup-/Freischaltungs-Guards.
- Admin-Approve über den vereinten Pfad: Instanz origin='app_host' +
  Owner-Membership + self_host_enabled.
- VPS-Regression: der vereinte Approve liefert weiterhin die alte
  Credential-Shape und legt die Owner-Membership an.
- Origin-Filter der Listen (Alt-Client-Default 'vps').
- DEPRECATED User-Wrapper (/me/app-host-application[s]) delegieren korrekt.
"""

from __future__ import annotations

import pytest
from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance, UserInstanceMembership
from sqlalchemy import select, update

_PW = "correct horse battery staple"


async def _reg_and_login(client, username: str) -> str:
    await client.post(
        "/register",
        json={
            "username": username,
            "email": f"{username}@dcc-test.example.com",
            "password": _PW,
        },
    )
    r = await client.post("/login", json={"email_or_username": username, "password": _PW})
    assert r.status_code == 200, r.text
    return f"pulse_session={r.cookies.get('pulse_session')}"


async def _make_owner(session_factory, username: str) -> None:
    async with session_factory() as s:
        await s.execute(
            update(User).where(User.username == username).values(is_admin=True, is_owner=True)
        )
        await s.commit()


async def _bearer(client, username: str) -> dict[str, str]:
    r = await client.post("/login", json={"email_or_username": username, "password": _PW})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
async def bob_cookie(client):
    return await _reg_and_login(client, "uni_bob")


@pytest.fixture
async def owner_auth(client, session_factory):
    await _reg_and_login(client, "uni_admin")
    await _make_owner(session_factory, "uni_admin")
    return await _bearer(client, "uni_admin")


# ---------------------------------------------------------------------------
# Submit (vereint)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_submit_app_host_via_unified_path(client, bob_cookie):
    r = await client.post(
        "/me/instance-applications",
        json={
            "origin": "app_host",
            "purpose": "privat",
            "notes": "vom Handy",
            "network_check": "ok",
        },
        headers={"Cookie": bob_cookie},
    )
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["origin"] == "app_host"
    assert data["status"] == "pending"
    # Platzhalter-Hostname im App-Host-Instanz-Muster (NOT-NULL-Spalte).
    assert data["hostname"].startswith(f"app-{data['id']}.")
    assert data["notes"] == "vom Handy"
    # contact_email aus dem eingeloggten User abgeleitet.
    assert data["contact_email"] == "uni_bob@dcc-test.example.com"
    # Anschluss-Check-Ergebnis wird gespeichert und zurückgegeben (beratend).
    assert data["network_check"] == "ok"


@pytest.mark.asyncio
async def test_submit_app_host_duplicate_pending_409(client, bob_cookie):
    body = {"origin": "app_host", "purpose": "privat"}
    r1 = await client.post(
        "/me/instance-applications", json=body, headers={"Cookie": bob_cookie}
    )
    assert r1.status_code == 201, r1.text
    r2 = await client.post(
        "/me/instance-applications", json=body, headers={"Cookie": bob_cookie}
    )
    assert r2.status_code == 409, r2.text


@pytest.mark.asyncio
async def test_submit_app_host_already_enabled_422(client, bob_cookie, session_factory):
    async with session_factory() as s:
        await s.execute(
            update(User).where(User.username == "uni_bob").values(self_host_enabled=True)
        )
        await s.commit()
    r = await client.post(
        "/me/instance-applications",
        json={"origin": "app_host", "purpose": "privat"},
        headers={"Cookie": bob_cookie},
    )
    assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_submit_vps_still_requires_hostname(client, bob_cookie):
    """VPS-Regression: ohne Hostname bleibt der vps-Antrag 422."""
    r = await client.post(
        "/me/instance-applications",
        json={"purpose": "privat"},
        headers={"Cookie": bob_cookie},
    )
    assert r.status_code == 422, r.text


# ---------------------------------------------------------------------------
# Origin-Filter der User-Liste
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_user_list_default_hides_app_host(client, bob_cookie):
    """Alt-Client-Kompatibilität: ohne ?origin sieht die Liste nur VPS-Anträge."""
    await client.post(
        "/me/instance-applications",
        json={"origin": "app_host", "purpose": "privat"},
        headers={"Cookie": bob_cookie},
    )
    await client.post(
        "/me/instance-applications",
        json={"hostname": "pulse.uni-bob.example.com"},
        headers={"Cookie": bob_cookie},
    )
    r = await client.get("/me/instance-applications", headers={"Cookie": bob_cookie})
    assert [a["origin"] for a in r.json()] == ["vps"]

    r = await client.get(
        "/me/instance-applications?origin=all", headers={"Cookie": bob_cookie}
    )
    assert sorted(a["origin"] for a in r.json()) == ["app_host", "vps"]

    r = await client.get(
        "/me/instance-applications?origin=app_host", headers={"Cookie": bob_cookie}
    )
    assert [a["origin"] for a in r.json()] == ["app_host"]


# ---------------------------------------------------------------------------
# Admin: vereinter Approve/Reject
# ---------------------------------------------------------------------------


async def _submit_app_host(client, cookie: str) -> str:
    r = await client.post(
        "/me/instance-applications",
        json={"origin": "app_host", "purpose": "privat"},
        headers={"Cookie": cookie},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


@pytest.mark.asyncio
async def test_admin_approve_app_host_via_unified_path(
    client, bob_cookie, owner_auth, session_factory
):
    app_id = await _submit_app_host(client, bob_cookie)

    # Pending-Liste liefert origin.
    r = await client.get("/admin/instance-applications", headers=owner_auth)
    assert r.status_code == 200, r.text
    entry = next(a for a in r.json() if a["id"] == app_id)
    assert entry["origin"] == "app_host"
    # network_check erscheint in der Admin-Liste (hier nicht mitgesendet → None).
    assert entry["network_check"] is None

    r = await client.post(
        f"/admin/instance-applications/{app_id}/approve", headers=owner_auth
    )
    assert r.status_code == 200, r.text
    data = r.json()
    # App-Host-Shape: kein client_secret, dafür Flag + Instanz-ID.
    assert data["self_host_enabled"] is True
    assert data["instance_id"] is not None
    assert "client_secret" not in data

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, int(data["instance_id"]))
        assert inst is not None and inst.origin == "app_host" and inst.status == "active"
        bob_id = (
            await s.execute(select(User.id).where(User.username == "uni_bob"))
        ).scalar_one()
        membership = await s.get(UserInstanceMembership, (bob_id, inst.id))
        assert membership is not None and membership.role == "owner"
        bob = await s.get(User, bob_id)
        assert bob.self_host_enabled is True

    # Die Admin-Liste liefert approved_instance_id — der „Aktiv"-Tab mappt
    # darüber die app_host-Instanz auf ihren Antrag (Revoke braucht die
    # Antrags-ID, nicht die Instanz-ID).
    r = await client.get(
        "/admin/instance-applications?status=approved&origin=app_host", headers=owner_auth
    )
    assert r.status_code == 200, r.text
    entry = next(a for a in r.json() if a["id"] == app_id)
    assert entry["approved_instance_id"] == data["instance_id"]


@pytest.mark.asyncio
async def test_admin_reject_app_host_via_unified_path(client, bob_cookie, owner_auth):
    app_id = await _submit_app_host(client, bob_cookie)
    r = await client.post(
        f"/admin/instance-applications/{app_id}/reject",
        json={"rejection_reason": "kein Bedarf"},
        headers=owner_auth,
    )
    assert r.status_code == 204, r.text
    r = await client.get(
        "/me/instance-applications?origin=app_host", headers={"Cookie": bob_cookie}
    )
    (entry,) = r.json()
    assert entry["status"] == "rejected"
    assert entry["rejection_reason"] == "kein Bedarf"


@pytest.mark.asyncio
async def test_admin_approve_vps_regression(client, bob_cookie, owner_auth, session_factory):
    """VPS-Zweig unverändert: Credential-Shape + Owner-Membership."""
    r = await client.post(
        "/me/instance-applications",
        json={"hostname": "vps.uni-bob.example.com"},
        headers={"Cookie": bob_cookie},
    )
    assert r.status_code == 201, r.text
    app_id = r.json()["id"]

    r = await client.post(
        f"/admin/instance-applications/{app_id}/approve", headers=owner_auth
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["hostname"] == "vps.uni-bob.example.com"
    assert data["client_secret"]  # einmalig gezeigt
    assert data["worker_id_chat"] >= 100

    async with session_factory() as s:
        bob_id = (
            await s.execute(select(User.id).where(User.username == "uni_bob"))
        ).scalar_one()
        membership = await s.get(
            UserInstanceMembership, (bob_id, int(data["instance_id"]))
        )
        assert membership is not None and membership.role == "owner"
        # VPS-Approve setzt self_host_enabled NICHT (Gate nur für env-file).
        bob = await s.get(User, bob_id)
        assert bob.self_host_enabled is False


# ---------------------------------------------------------------------------
# DEPRECATED User-Wrapper
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_user_wrapper_paths_still_work(client, bob_cookie):
    r = await client.post(
        "/me/app-host-application",
        json={"purpose": "privat", "message": "alter Client"},
        headers={"Cookie": bob_cookie},
    )
    assert r.status_code == 201, r.text
    data = r.json()
    # Alte Shape: message statt notes, user_id statt applicant_user_id.
    assert data["message"] == "alter Client"
    assert "user_id" in data and "hostname" not in data

    r = await client.get("/me/app-host-applications", headers={"Cookie": bob_cookie})
    assert r.status_code == 200, r.text
    assert [a["status"] for a in r.json()] == ["pending"]

    # Wrapper und vereinter Pfad sehen denselben Antrag.
    r = await client.get(
        "/me/instance-applications?origin=app_host", headers={"Cookie": bob_cookie}
    )
    assert len(r.json()) == 1
