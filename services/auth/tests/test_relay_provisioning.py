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
async def alice(client, session_factory):
    cookie, uid = await _reg_and_login(client, _REG_A)
    async with session_factory() as s:
        from dcc_auth.models import User
        user = await s.get(User, int(uid))
        user.self_host_enabled = True
        await s.commit()
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
            # Relay ist App-Host-only (2026-07-14): ein VPS bekommt beim
            # Bootstrap-Redeem KEINE Subdomain mehr — sonst meldet
            # /me/instances sie als Hostname und Clients laufen gegen einen
            # toten Tunnel. Die Relay-Tests brauchen deshalb app_host.
            origin="app_host",
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
async def test_redeem_vps_gets_no_relay(
    client, alice, session_factory, _isolate_settings, monkeypatch
):
    """Regression 2026-07-14: Relay ist App-Host-only. Ein VPS-Redeem darf
    KEINE Subdomain/Token bekommen, auch wenn Relay-Server konfiguriert +
    Provisioning eingeschaltet ist — /me/instances meldete die Subdomain
    sonst als Hostname und Clients liefen gegen einen toten Tunnel."""
    import dcc_auth.routes_selfhost_bootstrap as _rb
    monkeypatch.setattr(_rb, "get_settings", lambda: _isolate_settings)
    monkeypatch.setattr(_isolate_settings, "pulse_relay_server_addr", "relay.test:2333")
    monkeypatch.setattr(_isolate_settings, "pulse_relay_base_domain", "relay.test")

    async with session_factory() as session:
        vps = RegisteredInstance(
            id=20000000000000002,
            hostname="vps-instance.example.com",
            client_id=f"ci_{secrets.token_hex(8)}",
            client_secret=_FAKE_HASH,
            worker_id_chat=113,
            worker_id_voice=114,
            worker_id_media=115,
            status="active",
            registered_by=int(alice["id"]),
            origin="vps",
        )
        session.add(vps)
        await session.commit()

    token = await _mint_token(client, alice["cookie"], 20000000000000002)
    r = await client.post(
        "/selfhost/bootstrap", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["relay_subdomain"] is None
    assert data["relay_tunnel_token"] is None

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, 20000000000000002)
        assert inst.relay_subdomain is None
        assert inst.relay_tunnel_token_hash is None


@pytest.mark.asyncio
async def test_redeem_subdomain_stable_token_rotates(
    client, alice, alice_instance, _isolate_settings, monkeypatch
):
    """Subdomain wird beim ersten (und einzigen) Redeem vergeben, Tunnel-Token
    ist Klartext in der Antwort. Mehrfache Redeems sind seit
    One-Shot-pro-Antrag nicht mehr möglich (siehe test_bootstrap_token.py)."""
    import dcc_auth.routes_selfhost_bootstrap as _rb
    monkeypatch.setattr(_rb, "get_settings", lambda: _isolate_settings)
    monkeypatch.setattr(_isolate_settings, "pulse_relay_server_addr", "relay.test:2333")
    monkeypatch.setattr(_isolate_settings, "pulse_relay_base_domain", "relay.test")

    t1 = await _mint_token(client, alice["cookie"], alice_instance.id)
    d1 = (await client.post("/selfhost/bootstrap",
          headers={"Authorization": f"Bearer {t1}"})).json()

    assert d1["relay_subdomain"]                              # vergeben
    assert d1["relay_tunnel_token"]                           # im Klartext zurück
    # Folge-Mint ist nach erfolgreichem Setup geblockt (One-Shot).
    r = await client.post(
        f"/me/instances/{alice_instance.id}/bootstrap-token",
        headers={"Cookie": alice["cookie"]},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_redeem_no_relay_when_provisioning_flag_off(
    client, alice, alice_instance, session_factory, _isolate_settings, monkeypatch
):
    """PULSE_RELAY_PROVISION_ENABLED=false (Relay-Abbau für App-Hosting):
    trotz konfiguriertem Relay-Server werden KEINE relay_subdomain / kein
    Tunnel-Token vergeben — Response-Shape bleibt stabil mit null-Werten,
    die DB bleibt ohne Relay-Spuren."""
    import dcc_auth.routes_selfhost_bootstrap as _rb
    monkeypatch.setattr(_rb, "get_settings", lambda: _isolate_settings)
    monkeypatch.setattr(_isolate_settings, "pulse_relay_server_addr", "relay.test:2333")
    monkeypatch.setattr(_isolate_settings, "pulse_relay_base_domain", "relay.test")
    monkeypatch.setattr(_isolate_settings, "pulse_relay_provision_enabled", False)

    token = await _mint_token(client, alice["cookie"], alice_instance.id)
    r = await client.post(
        "/selfhost/bootstrap", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["relay_subdomain"] is None
    assert data["relay_server_addr"] is None
    assert data["relay_tunnel_token"] is None
    # Kern-Credentials unverändert vorhanden (Konsumenten sind null-tolerant).
    assert data["client_secret"]

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, alice_instance.id)
        assert inst.relay_subdomain is None
        assert inst.relay_tunnel_token_hash is None


@pytest.mark.asyncio
async def test_flag_off_keeps_existing_subdomain(
    client, alice, alice_instance, session_factory, _isolate_settings, monkeypatch
):
    """Bestehende Instanzen behalten ihre Subdomain (kein Daten-Rückbau) —
    das Flag stoppt nur die NEU-Vergabe beim Redeem."""
    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, alice_instance.id)
        inst.relay_subdomain = "brave-otter-4f2a.relay.test"
        inst.relay_tunnel_token_hash = "deadbeef"
        await s.commit()

    import dcc_auth.routes_selfhost_bootstrap as _rb
    monkeypatch.setattr(_rb, "get_settings", lambda: _isolate_settings)
    monkeypatch.setattr(_isolate_settings, "pulse_relay_server_addr", "relay.test:2333")
    monkeypatch.setattr(_isolate_settings, "pulse_relay_provision_enabled", False)

    token = await _mint_token(client, alice["cookie"], alice_instance.id)
    data = (await client.post("/selfhost/bootstrap",
            headers={"Authorization": f"Bearer {token}"})).json()
    # Antwort nennt keinen Relay mehr, aber die DB-Zeile bleibt unangetastet.
    assert data["relay_subdomain"] is None
    assert data["relay_tunnel_token"] is None
    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, alice_instance.id)
        assert inst.relay_subdomain == "brave-otter-4f2a.relay.test"
        assert inst.relay_tunnel_token_hash == "deadbeef"


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
        headers={"x-pulse-internal-secret": "s3cr3t"},
        json={"subdomain": provisioned["relay_subdomain"],
              "token": provisioned["relay_tunnel_token"]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["subdomain"] == provisioned["relay_subdomain"]


@pytest.mark.asyncio
async def test_relay_auth_wrong_token(client, provisioned):
    r = await client.post(
        "/selfhost/relay/auth",
        headers={"x-pulse-internal-secret": "s3cr3t"},
        json={"subdomain": provisioned["relay_subdomain"], "token": "plse_relay_wrong"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_relay_auth_unknown_subdomain(client, provisioned):
    r = await client.post(
        "/selfhost/relay/auth",
        headers={"x-pulse-internal-secret": "s3cr3t"},
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
        headers={"x-pulse-internal-secret": "s3cr3t"},
        json={"subdomain": provisioned["relay_subdomain"],
              "token": provisioned["relay_tunnel_token"]},
    )
    assert r.status_code == 403


# --------------------------------------------------------------------------- #
# Caddy On-Demand-TLS-Check                                                     #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_tls_check_active_subdomain_200(client, provisioned):
    r = await client.get(
        "/selfhost/relay/tls-check",
        params={"domain": provisioned["relay_subdomain"]},
    )
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_tls_check_unknown_subdomain_404(client, provisioned):
    r = await client.get(
        "/selfhost/relay/tls-check",
        params={"domain": "ghost-comet-0000.relay.test"},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_tls_check_suspended_subdomain_404(
    client, provisioned, alice_instance, session_factory
):
    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, alice_instance.id)
        inst.status = "suspended"
        await s.commit()
    r = await client.get(
        "/selfhost/relay/tls-check",
        params={"domain": provisioned["relay_subdomain"]},
    )
    assert r.status_code == 404
