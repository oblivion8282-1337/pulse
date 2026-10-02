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
async def test_submit_app_host_is_gone_410(client, bob_cookie):
    """Heim-Server-Entscheid 2026-09-27: App-Host-Anträge sind abgeschafft —
    die Server-App registriert sich selbst (POST /me/instances)."""
    r = await client.post(
        "/me/instance-applications",
        json={"origin": "app_host", "purpose": "privat"},
        headers={"Cookie": bob_cookie},
    )
    assert r.status_code == 410, r.text
    assert "Selbst" in r.json()["detail"] or "Server-App" in r.json()["detail"]


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
async def test_user_list_default_hides_app_host(client, bob_cookie, session_factory):
    """Alt-Client-Kompatibilität: ohne ?origin sieht die Liste nur VPS-Anträge
    (app_host-Zeile per DB-Seed — der POST-Weg ist zu, s. _seed_app_host_db)."""
    await _seed_app_host_db(session_factory, client, bob_cookie)
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


async def _seed_app_host_db(session_factory, cookie_client, cookie: str) -> int:
    """Legt eine app_host-Antragszeile DIREKT in die DB — der POST-Weg ist seit
    dem Heim-Server-Entscheid 2026-09-27 zu (410); Legacy-Zeilen (und damit
    Admin-Liste/Ablehnen) bleiben funktional."""
    from dcc_auth.models_instances import InstanceApplication
    from dcc_auth.snowflake import next_id as _next_id

    r = await cookie_client.get("/me", headers={"Cookie": cookie})
    uid = int(r.json()["id"])
    app_id = _next_id()
    async with session_factory() as s:
        s.add(
            InstanceApplication(
                id=app_id,
                applicant_user_id=uid,
                origin="app_host",
                hostname=f"app-{app_id}.relay.howispulse.com",
                purpose="privat",
                expected_users=1,
                contact_email="legacy@dcc-test.example.com",
                status="pending",
            )
        )
        await s.commit()
    return app_id


@pytest.mark.asyncio
async def test_admin_approve_app_host_is_gone_410(
    client, bob_cookie, owner_auth, session_factory
):
    """Legacy-Pending-Zeile: Approve antwortet 410 (Selbstbedienung), die
    Zeile bleibt unberührt — Ablehnen ist der einzige Weg."""
    app_id = await _seed_app_host_db(session_factory, client, bob_cookie)
    r = await client.post(
        f"/admin/instance-applications/{app_id}/approve", headers=owner_auth
    )
    assert r.status_code == 410, r.text


async def test_admin_reject_app_host_via_unified_path(client, bob_cookie, owner_auth, session_factory):
    app_id = await _seed_app_host_db(session_factory, client, bob_cookie)
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
