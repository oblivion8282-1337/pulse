"""Tests für die Cloud-Relay-Provisionierung (②a): Subdomain-Vergabe,
Tunnel-Token (Hash-only) + interne Validierung."""

from __future__ import annotations

import re
import secrets

import pytest
import pytest_asyncio

from dcc_auth.config import get_settings
from dcc_auth.models_instances import RegisteredInstance
from dcc_auth.relay import (
    RELAY_TOKEN_PREFIX,
    allocate_relay_subdomain,
    generate_relay_slug,
    generate_relay_token,
    hash_relay_token,
)

# --- Fixtures (gespiegelt aus test_bootstrap_token.py, DRY-Grenze akzeptiert:
#     conftest stellt sie nicht bereit) ---

_REG_A = {
    "username": "relay_alice",
    "email": "relay_alice@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Alice",
}

_FAKE_HASH = "$argon2id$v=19$m=65536,t=3,p=4$fakehash"


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
async def alice(client):
    cookie, uid = await _reg_and_login(client, _REG_A)
    return {"cookie": cookie, "id": uid}


@pytest_asyncio.fixture
async def alice_instance(session_factory, alice) -> RegisteredInstance:
    async with session_factory() as session:
        inst = RegisteredInstance(
            id=20000000000000001,
            hostname="boot-instance.example.com",
            client_id=f"ci_{secrets.token_hex(8)}",
            client_secret=_FAKE_HASH,
            worker_id_chat=110,
            worker_id_voice=111,
            worker_id_media=112,
            status="active",
            registered_by=int(alice["id"]),
        )
        session.add(inst)
        await session.commit()
        await session.refresh(inst)
    return inst


async def _mint_token(client, cookie: str, instance_id: int) -> str:
    r = await client.post(
        f"/me/instances/{instance_id}/bootstrap-token",
        headers={"Cookie": cookie},
    )
    assert r.status_code == 201, r.text
    return r.json()["token"]


# --------------------------------------------------------------------------- #
# Relay-Modell + Helfer                                                         #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_registered_instance_has_relay_columns(session_factory):
    async with session_factory() as session:
        inst = RegisteredInstance(
            id=20000000000000010,
            hostname="relay-cols.example.com",
            client_id=f"ci_{secrets.token_hex(8)}",
            client_secret="$argon2id$v=19$m=65536,t=3,p=4$fakehash",
            worker_id_chat=200,
            worker_id_voice=201,
            worker_id_media=202,
            status="active",
            registered_by=1,
            relay_subdomain="brave-otter-4f2a.relay.howispulse.com",
            relay_tunnel_token_hash="deadbeef",
        )
        session.add(inst)
        await session.commit()
        await session.refresh(inst)
        assert inst.relay_subdomain == "brave-otter-4f2a.relay.howispulse.com"
        assert inst.relay_tunnel_token_hash == "deadbeef"


def test_relay_settings_defaults():
    s = get_settings()
    assert s.pulse_relay_base_domain == "relay.howispulse.com"
    assert s.pulse_relay_server_addr == ""


def test_slug_shape_and_randomness():
    a = generate_relay_slug()
    b = generate_relay_slug()
    # Form: <wort>-<wort>-<4 hex>, nur [a-z0-9-]
    assert re.fullmatch(r"[a-z]+-[a-z]+-[0-9a-f]{4}", a), a
    assert a != b  # praktisch nie gleich (4 hex + Wortwahl)


def test_token_prefix_and_hash_stable():
    t = generate_relay_token()
    assert t.startswith(RELAY_TOKEN_PREFIX)
    assert hash_relay_token(t) == hash_relay_token(t)  # deterministisch
    assert hash_relay_token(t) != t  # kein Klartext


@pytest.mark.asyncio
async def test_allocate_subdomain_unique(session_factory):
    async with session_factory() as session:
        sub1 = await allocate_relay_subdomain(session, "relay.test")
        assert sub1.endswith(".relay.test")
        # Belege den Slug → nächster Aufruf muss einen anderen liefern
        session.add(RegisteredInstance(
            id=20000000000000020, hostname="h.example.com",
            client_id=f"ci_{secrets.token_hex(8)}", client_secret="x",
            worker_id_chat=210, worker_id_voice=211, worker_id_media=212,
            status="active", registered_by=1, relay_subdomain=sub1,
        ))
        await session.commit()
        sub2 = await allocate_relay_subdomain(session, "relay.test")
        assert sub2 != sub1


# --------------------------------------------------------------------------- #
# Bootstrap-Redeem + Relay-Provisionierung                                      #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_redeem_assigns_relay_when_enabled(
    client, alice, alice_instance, session_factory, _isolate_settings, monkeypatch
):
    import dcc_auth.routes_selfhost_bootstrap as _rb
    monkeypatch.setattr(_rb, "get_settings", lambda: _isolate_settings)
    monkeypatch.setattr(_isolate_settings, "pulse_relay_server_addr", "relay.test:2333")
    monkeypatch.setattr(_isolate_settings, "pulse_relay_base_domain", "relay.test")

    token = await _mint_token(client, alice["cookie"], alice_instance.id)
    r = await client.post(
        "/selfhost/bootstrap", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["relay_server_addr"] == "relay.test:2333"
    assert data["relay_subdomain"].endswith(".relay.test")
    assert data["relay_tunnel_token"].startswith("plse_relay_")

    # DB hält NUR den Hash, nie den Klartext.
    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, alice_instance.id)
        assert inst.relay_subdomain == data["relay_subdomain"]
        assert inst.relay_tunnel_token_hash == hash_relay_token(data["relay_tunnel_token"])


@pytest.mark.asyncio
async def test_redeem_subdomain_stable_token_rotates(
    client, alice, alice_instance, _isolate_settings, monkeypatch
):
    import dcc_auth.routes_selfhost_bootstrap as _rb
    monkeypatch.setattr(_rb, "get_settings", lambda: _isolate_settings)
    monkeypatch.setattr(_isolate_settings, "pulse_relay_server_addr", "relay.test:2333")
    monkeypatch.setattr(_isolate_settings, "pulse_relay_base_domain", "relay.test")

    t1 = await _mint_token(client, alice["cookie"], alice_instance.id)
    d1 = (await client.post("/selfhost/bootstrap",
          headers={"Authorization": f"Bearer {t1}"})).json()
    t2 = await _mint_token(client, alice["cookie"], alice_instance.id)
    d2 = (await client.post("/selfhost/bootstrap",
          headers={"Authorization": f"Bearer {t2}"})).json()

    assert d1["relay_subdomain"] == d2["relay_subdomain"]          # stabil
    assert d1["relay_tunnel_token"] != d2["relay_tunnel_token"]    # rotiert


@pytest.mark.asyncio
async def test_redeem_no_relay_when_disabled(client, alice, alice_instance):
    # Default: pulse_relay_server_addr == "" → keine Relay-Felder (heutiges Verhalten).
    token = await _mint_token(client, alice["cookie"], alice_instance.id)
    data = (await client.post("/selfhost/bootstrap",
            headers={"Authorization": f"Bearer {token}"})).json()
    assert data["relay_subdomain"] is None
    assert data["relay_server_addr"] is None
    assert data["relay_tunnel_token"] is None


# --------------------------------------------------------------------------- #
# Interner Relay-Validierungs-Endpoint                                          #
# --------------------------------------------------------------------------- #


@pytest_asyncio.fixture
async def provisioned(client, alice, alice_instance, _isolate_settings, monkeypatch):
    """Eine Instanz mit vergebenem Relay (Subdomain + frischer Token-Klartext)."""
    import dcc_auth.routes_selfhost_bootstrap as _rb
    import dcc_auth.routes_selfhost_relay as _rr

    monkeypatch.setattr(_rb, "get_settings", lambda: _isolate_settings)
    monkeypatch.setattr(_rr, "get_settings", lambda: _isolate_settings)
    monkeypatch.setattr(_isolate_settings, "pulse_relay_server_addr", "relay.test:2333")
    monkeypatch.setattr(_isolate_settings, "pulse_relay_base_domain", "relay.test")
    monkeypatch.setattr(_isolate_settings, "internal_service_secret", "s3cr3t")
    token = await _mint_token(client, alice["cookie"], alice_instance.id)
    data = (await client.post("/selfhost/bootstrap",
            headers={"Authorization": f"Bearer {token}"})).json()
    return data  # enthält relay_subdomain + relay_tunnel_token


@pytest.mark.asyncio
async def test_relay_auth_happy(client, provisioned):
    r = await client.post(
        "/selfhost/relay/auth",
        headers={"x-internal-secret": "s3cr3t"},
        json={"subdomain": provisioned["relay_subdomain"],
              "token": provisioned["relay_tunnel_token"]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["subdomain"] == provisioned["relay_subdomain"]


@pytest.mark.asyncio
async def test_relay_auth_wrong_token(client, provisioned):
    r = await client.post(
        "/selfhost/relay/auth",
        headers={"x-internal-secret": "s3cr3t"},
        json={"subdomain": provisioned["relay_subdomain"], "token": "plse_relay_wrong"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_relay_auth_unknown_subdomain(client, provisioned):
    r = await client.post(
        "/selfhost/relay/auth",
        headers={"x-internal-secret": "s3cr3t"},
        json={"subdomain": "ghost-comet-0000.relay.test",
              "token": provisioned["relay_tunnel_token"]},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_relay_auth_missing_internal_secret(client, provisioned):
    r = await client.post(
        "/selfhost/relay/auth",
        json={"subdomain": provisioned["relay_subdomain"],
              "token": provisioned["relay_tunnel_token"]},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_relay_auth_suspended_instance(
    client, provisioned, alice_instance, session_factory
):
    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, alice_instance.id)
        inst.status = "suspended"
        await s.commit()
    r = await client.post(
        "/selfhost/relay/auth",
        headers={"x-internal-secret": "s3cr3t"},
        json={"subdomain": provisioned["relay_subdomain"],
              "token": provisioned["relay_tunnel_token"]},
    )
    assert r.status_code == 403
