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


# --------------------------------------------------------------------------- #
# env-file gate (zweiter Credential-Pfad — behält das self_host_enabled-Gate)  #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_env_file_requires_self_host_enabled(client, carol, carol_instance):
    """env-file gibt dem Host echte Cloud-Credentials → ohne Flag 403 (sonst
    wäre das Gate über diesen Pfad umgehbar)."""
    r = await client.post(
        f"/me/instances/{carol_instance.id}/env-file",
        headers={"Cookie": carol["cookie"]},
    )
    assert r.status_code == 403, r.text
    assert "self-hosting not enabled" in r.json()["detail"]


@pytest.mark.asyncio
async def test_env_file_succeeds_when_enabled(client, carol, carol_instance, session_factory):
    async with session_factory() as s:
        user = await s.get(User, int(carol["id"]))
        user.self_host_enabled = True
        await s.commit()

    r = await client.post(
        f"/me/instances/{carol_instance.id}/env-file",
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
