"""Tests für den Docker-Registry-Token-Auth-Realm (``GET /registry/token``).

Deckt: 401 ohne Auth; Instanz-Pfad (gültige Creds → Pull-Token mit korrekten
Claims + ``x5c``-Header; falsches Secret → 401; unbekannte client_id → 401;
suspended/deleted → 403; Instanz bekommt nie ``push``); CI-Pfad (``pulse-ci`` +
Token → pull+push; falsch → 401; Token=None → 401); Cloud-Gate (self-host → 403).
"""

from __future__ import annotations

import base64
import secrets as _secrets

import jwt
import pytest
import pytest_asyncio

from dcc_auth.config import get_settings
from dcc_auth.models_instances import RegisteredInstance
from dcc_auth.security import get_signer, hash_password

_REG = {
    "username": "reg_alice",
    "email": "reg_alice@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Alice",
}


async def _reg_and_login(client, reg: dict) -> str:
    await client.post("/register", json=reg)
    r = await client.post(
        "/login", json={"email_or_username": reg["email"], "password": reg["password"]}
    )
    assert r.status_code == 200, r.text
    sid = r.cookies.get("pulse_session")
    me = await client.get("/me", headers={"Cookie": f"pulse_session={sid}"})
    return me.json()["id"]


def _basic(user: str, pw: str) -> dict[str, str]:
    tok = base64.b64encode(f"{user}:{pw}".encode()).decode()
    return {"Authorization": f"Basic {tok}"}


def _decode(token: str) -> tuple[dict, dict]:
    settings = get_settings()
    payload = jwt.decode(
        token,
        get_signer().public_key,
        algorithms=["RS256"],
        audience=settings.registry_service,
        issuer=settings.jwt_issuer,
    )
    return payload, jwt.get_unverified_header(token)


@pytest_asyncio.fixture
async def instance(client, session_factory) -> tuple[RegisteredInstance, str]:
    """Active Instanz mit bekanntem client_secret-Klartext."""
    uid = await _reg_and_login(client, _REG)
    plain = _secrets.token_urlsafe(24)
    async with session_factory() as s:
        inst = RegisteredInstance(
            id=20000000000000007,
            hostname="reg-instance.example.com",
            client_id=f"ci_{_secrets.token_hex(8)}",
            client_secret=hash_password(plain),
            worker_id_chat=210,
            worker_id_voice=211,
            worker_id_media=212,
            status="active",
            registered_by=int(uid),
        )
        s.add(inst)
        await s.commit()
        await s.refresh(inst)
    return inst, plain


# --------------------------------------------------------------------------- #
# Instanz-Pfad                                                                 #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_no_auth_401(client):
    assert (await client.get("/registry/token")).status_code == 401


@pytest.mark.asyncio
async def test_instance_pull_happy(client, instance):
    inst, plain = instance
    r = await client.get(
        "/registry/token",
        headers=_basic(inst.client_id, plain),
        params={"service": "registry.howispulse.com", "scope": "repository:pulse-allinone:pull"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["token"] == data["access_token"]
    assert data["expires_in"] == 300

    payload, header = _decode(data["token"])
    settings = get_settings()
    assert payload["aud"] == settings.registry_service
    assert payload["iss"] == settings.jwt_issuer
    assert payload["sub"] == str(inst.id)
    assert payload["access"] == [
        {"type": "repository", "name": "pulse-allinone", "actions": ["pull"]}
    ]
    # x5c-Header (registry:2 verifiziert die Signatur darüber).
    assert header.get("x5c") and len(header["x5c"]) == 1


@pytest.mark.asyncio
async def test_instance_wrong_secret_401(client, instance):
    inst, _ = instance
    r = await client.get("/registry/token", headers=_basic(inst.client_id, "wrong"))
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_instance_unknown_client_id_401(client, instance):
    _, plain = instance
    r = await client.get("/registry/token", headers=_basic("ci_unknown", plain))
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_instance_suspended_403(client, instance, session_factory):
    inst, plain = instance
    async with session_factory() as s:
        row = await s.get(RegisteredInstance, inst.id)
        row.status = "suspended"
        await s.commit()
    r = await client.get("/registry/token", headers=_basic(inst.client_id, plain))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_instance_deleted_403(client, instance, session_factory):
    inst, plain = instance
    async with session_factory() as s:
        row = await s.get(RegisteredInstance, inst.id)
        row.status = "deleted"
        await s.commit()
    r = await client.get("/registry/token", headers=_basic(inst.client_id, plain))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_instance_never_gets_push(client, instance):
    """Instanzen bekommen NUR pull, selbst wenn sie push anfordern."""
    inst, plain = instance
    r = await client.get(
        "/registry/token",
        headers=_basic(inst.client_id, plain),
        params={"scope": "repository:pulse-allinone:push,pull"},
    )
    assert r.status_code == 200, r.text
    payload, _ = _decode(r.json()["token"])
    assert payload["access"][0]["actions"] == ["pull"]


# --------------------------------------------------------------------------- #
# CI-Pfad                                                                      #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_ci_push_happy(client):
    get_settings().registry_push_token = "test-ci-secret"
    r = await client.get(
        "/registry/token",
        headers=_basic("pulse-ci", "test-ci-secret"),
        params={"scope": "repository:pulse-allinone:push,pull"},
    )
    assert r.status_code == 200, r.text
    payload, _ = _decode(r.json()["token"])
    assert payload["sub"] == "pulse-ci"
    assert payload["access"][0]["actions"] == ["pull", "push"]


@pytest.mark.asyncio
async def test_ci_wrong_token_401(client):
    get_settings().registry_push_token = "test-ci-secret"
    r = await client.get("/registry/token", headers=_basic("pulse-ci", "wrong"))
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_ci_disabled_when_token_none(client):
    # Default: registry_push_token ist None → CI-Push nicht freigeschaltet.
    assert get_settings().registry_push_token is None
    r = await client.get("/registry/token", headers=_basic("pulse-ci", "anything"))
    assert r.status_code == 401


# --------------------------------------------------------------------------- #
# Cloud-Gate                                                                   #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_cloud_gate(client, instance):
    """Auf Self-Host-Deploys ist der Realm-Endpoint gesperrt (nur Cloud hält
    registered_instances + das Signier-Cert)."""
    inst, plain = instance
    get_settings().pulse_instance_mode = "self-host"
    r = await client.get("/registry/token", headers=_basic(inst.client_id, plain))
    assert r.status_code == 403
