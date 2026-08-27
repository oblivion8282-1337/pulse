"""Tests for the self_host_enabled gate on mint_bootstrap_token and /me."""

from __future__ import annotations

import secrets

import pytest
import pytest_asyncio
from sqlalchemy import select

from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance

_FAKE_HASH = "$argon2id$v=19$m=65536,t=3,p=4$fakehash"

_REG_CAROL = {
    "username": "gate_carol",
    "email": "gate_carol@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Carol",
}
_REG_ADMIN = {
    "username": "gate_admin",
    "email": "gate_admin@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "GateAdmin",
}


async def _reg_and_login(client, reg: dict) -> tuple[str, str]:
    """Register + login → (cookie-header, user_id)."""
    await client.post("/register", json=reg)
    r = await client.post(
        "/login", json={"email_or_username": reg["email"], "password": reg["password"]}
    )
    assert r.status_code == 200, r.text
    sid = r.cookies.get("pulse_session")
    me = await client.get("/me", headers={"Cookie": f"pulse_session={sid}"})
    return f"pulse_session={sid}", me.json()["id"]


@pytest_asyncio.fixture
async def carol(client, session_factory):
    cookie, uid = await _reg_and_login(client, _REG_CAROL)
    return {"cookie": cookie, "id": uid}


@pytest_asyncio.fixture
async def admin_user(client, session_factory):
    cookie, uid = await _reg_and_login(client, _REG_ADMIN)
    async with session_factory() as s:
        user = await s.get(User, int(uid))
        user.is_admin = True
        await s.commit()
    # Re-login to get an admin-token (JWT carries the claim at mint time).
    r = await client.post(
        "/login",
        json={"email_or_username": _REG_ADMIN["email"], "password": _REG_ADMIN["password"]},
    )
    assert r.status_code == 200, r.text
    token = r.json()["access_token"]
    return {"token": token, "id": uid}


@pytest_asyncio.fixture
async def carol_instance(session_factory, carol) -> RegisteredInstance:
    async with session_factory() as s:
        inst = RegisteredInstance(
            id=30000000000000001,
            hostname="gate-instance.example.com",
            client_id=f"ci_{secrets.token_hex(8)}",
            client_secret=_FAKE_HASH,
            worker_id_chat=120,
            worker_id_voice=121,
            worker_id_media=122,
            status="active",
            registered_by=int(carol["id"]),
        )
        s.add(inst)
        await s.commit()
        await s.refresh(inst)
    return inst


@pytest_asyncio.fixture
async def carol_app_host_instance(session_factory, carol) -> RegisteredInstance:
    """Dieselbe Instanz, nur aus der App heraus gehostet — dort IST das
    ``self_host_enabled``-Flag das Widerrufs-Instrument."""
    async with session_factory() as s:
        inst = RegisteredInstance(
            id=30000000000000002,
            hostname="gate-app-host.example.com",
            client_id=f"ci_{secrets.token_hex(8)}",
            client_secret=_FAKE_HASH,
            worker_id_chat=130,
            worker_id_voice=131,
            worker_id_media=132,
            status="active",
            origin="app_host",
            registered_by=int(carol["id"]),
        )
        s.add(inst)
        await s.commit()
        await s.refresh(inst)
    return inst


# --------------------------------------------------------------------------- #
# env-file gate — haengt an der INSTANZ, nicht am Nutzer                        #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_env_file_app_host_requires_self_host_enabled(
    client, carol, carol_app_host_instance
):
    """App-Host: ohne Flag 403 — sonst holte sich ein Widerrufener über diesen
    Pfad frische Cloud-Credentials, obwohl der Widerruf genau das beendet."""
    r = await client.post(
        f"/me/instances/{carol_app_host_instance.id}/env-file",
        headers={"Cookie": carol["cookie"]},
    )
    assert r.status_code == 403, r.text
    assert "self-hosting not enabled" in r.json()["detail"]


@pytest.mark.asyncio
async def test_env_file_vps_ohne_flag_erlaubt(client, carol, carol_instance):
    """VPS: das Flag setzt ``_approve_vps`` nie — es hier zu verlangen sperrte
    jeden VPS-Eigentuemer vom manuellen Compose-Weg aus (Fehler 2026-08-27).
    Gedeckt ist der Fall durch Eigentuemer + aktive, genehmigte Instanz, genau
    wie beim Bootstrap-Mint, der dieselben Zugangsdaten liefert."""
    r = await client.post(
        f"/me/instances/{carol_instance.id}/env-file",
        headers={"Cookie": carol["cookie"]},
    )
    assert r.status_code == 200, r.text
    assert "PULSE_CLOUD_CLIENT_SECRET=" in r.text


@pytest.mark.asyncio
async def test_env_file_gesperrte_instanz(client, carol, carol_instance, session_factory):
    """Suspendiert → keine frischen Zugangsdaten. Vorher prueften wir nur auf
    „nicht geloescht"; ein gesperrter Server konnte sich neu versorgen."""
    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, carol_instance.id)
        inst.status = "suspended"
        await s.commit()

    r = await client.post(
        f"/me/instances/{carol_instance.id}/env-file",
        headers={"Cookie": carol["cookie"]},
    )
    assert r.status_code == 403, r.text
    assert "gesperrt" in r.json()["detail"]


@pytest.mark.asyncio
async def test_env_file_succeeds_when_enabled(
    client, carol, carol_app_host_instance, session_factory
):
    async with session_factory() as s:
        user = await s.get(User, int(carol["id"]))
        user.self_host_enabled = True
        await s.commit()

    r = await client.post(
        f"/me/instances/{carol_app_host_instance.id}/env-file",
        headers={"Cookie": carol["cookie"]},
    )
    assert r.status_code == 200, r.text
    assert "PULSE_CLOUD_CLIENT_SECRET=" in r.text


# --------------------------------------------------------------------------- #
# Admin PATCH toggle                                                            #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_admin_patch_toggles_self_host(client, admin_user, carol, session_factory):
    """PATCH /admin/users/{id} with self_host_enabled=true → 200, flag set."""
    r = await client.patch(
        f"/admin/users/{carol['id']}",
        json={"self_host_enabled": True},
        headers={"Authorization": f"Bearer {admin_user['token']}"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["self_host_enabled"] is True

    # Verify DB column was actually updated.
    async with session_factory() as s:
        user = await s.get(User, int(carol["id"]))
        assert user.self_host_enabled is True


# --------------------------------------------------------------------------- #
# /me exposes the flag                                                          #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_me_exposes_self_host_enabled(client, carol):
    """GET /me must include self_host_enabled (default false for a new user)."""
    r = await client.get("/me", headers={"Cookie": carol["cookie"]})
    assert r.status_code == 200, r.text
    data = r.json()
    assert "self_host_enabled" in data
    assert data["self_host_enabled"] is False
