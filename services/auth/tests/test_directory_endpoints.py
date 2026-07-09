"""Tests für das Direktpfad-Telefonbuch (Plan 2026-07-09-direct-path-webrtc, Phase 1):
Heartbeat (Relay-Token-Auth) + membership-gated Lookup."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import update

from dcc_auth.models_instances import (
    InstanceDirectEndpoint,
    RegisteredInstance,
    UserInstanceMembership,
)
from dcc_auth.relay import generate_relay_token, hash_relay_token

_REG_A = {
    "username": "dir_alice",
    "email": "dir_alice@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Alice",
}
_REG_B = {
    "username": "dir_bob",
    "email": "dir_bob@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Bob",
}

_FAKE_HASH = "$argon2id$v=19$m=65536,t=3,p=4$fakehash"
_FINGERPRINT = "sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89"
_INSTANCE_ID = 21000000000000001


async def _reg_and_login(client, reg: dict) -> tuple[str, str]:
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
async def bob(client):
    cookie, uid = await _reg_and_login(client, _REG_B)
    return {"cookie": cookie, "id": uid}


@pytest_asyncio.fixture
async def instance(session_factory, alice):
    """Aktive Instanz mit bekanntem Relay-Token-Klartext + Alice-Membership."""
    token = generate_relay_token()
    async with session_factory() as session:
        inst = RegisteredInstance(
            id=_INSTANCE_ID,
            hostname="direct-path.example.com",
            client_id=f"ci_{secrets.token_hex(8)}",
            client_secret=_FAKE_HASH,
            worker_id_chat=310,
            worker_id_voice=311,
            worker_id_media=312,
            status="active",
            registered_by=int(alice["id"]),
            relay_tunnel_token_hash=hash_relay_token(token),
        )
        session.add(inst)
        session.add(
            UserInstanceMembership(
                user_id=int(alice["id"]), instance_id=inst.id, role="owner"
            )
        )
        await session.commit()
    return {"id": str(_INSTANCE_ID), "token": token}


def _heartbeat_body(instance: dict, **overrides) -> dict:
    body = {
        "instance_id": instance["id"],
        "token": instance["token"],
        "candidates": [{"ip": "46.128.100.64", "port": 7900, "protocol": "udp"}],
        "fingerprint": _FINGERPRINT,
    }
    body.update(overrides)
    return body


async def test_heartbeat_then_lookup_happy(client, alice, instance):
    r = await client.post("/selfhost/directory/heartbeat", json=_heartbeat_body(instance))
    assert r.status_code == 204, r.text

    r = await client.get(
        f"/me/instances/{instance['id']}/direct-endpoint",
        headers={"Cookie": alice["cookie"]},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["candidates"] == [{"ip": "46.128.100.64", "port": 7900, "protocol": "udp"}]
    assert data["fingerprint"] == _FINGERPRINT
    assert data["online"] is True


async def test_heartbeat_overwrites_previous_entry(client, alice, instance):
    await client.post("/selfhost/directory/heartbeat", json=_heartbeat_body(instance))
    second = _heartbeat_body(
        instance, candidates=[{"ip": "89.0.113.7", "port": 8100, "protocol": "udp"}]
    )
    r = await client.post("/selfhost/directory/heartbeat", json=second)
    assert r.status_code == 204, r.text

    r = await client.get(
        f"/me/instances/{instance['id']}/direct-endpoint",
        headers={"Cookie": alice["cookie"]},
    )
    assert r.json()["candidates"] == [{"ip": "89.0.113.7", "port": 8100, "protocol": "udp"}]


async def test_heartbeat_wrong_token_401(client, instance):
    r = await client.post(
        "/selfhost/directory/heartbeat",
        json=_heartbeat_body(instance, token="plse_relay_wrongwrongwrong"),
    )
    assert r.status_code == 401


async def test_heartbeat_unknown_instance_401(client, instance):
    r = await client.post(
        "/selfhost/directory/heartbeat",
        json=_heartbeat_body(instance, instance_id="999999999999"),
    )
    assert r.status_code == 401


async def test_heartbeat_suspended_instance_401(client, session_factory, instance):
    async with session_factory() as session:
        inst = await session.get(RegisteredInstance, _INSTANCE_ID)
        inst.status = "suspended"
        await session.commit()
    r = await client.post("/selfhost/directory/heartbeat", json=_heartbeat_body(instance))
    assert r.status_code == 401


async def test_heartbeat_private_ip_400(client, instance):
    r = await client.post(
        "/selfhost/directory/heartbeat",
        json=_heartbeat_body(
            instance, candidates=[{"ip": "192.168.178.87", "port": 7900, "protocol": "udp"}]
        ),
    )
    assert r.status_code == 400


async def test_lookup_without_membership_404(client, bob, instance):
    await client.post("/selfhost/directory/heartbeat", json=_heartbeat_body(instance))
    r = await client.get(
        f"/me/instances/{instance['id']}/direct-endpoint",
        headers={"Cookie": bob["cookie"]},
    )
    assert r.status_code == 404


async def test_lookup_without_heartbeat_404(client, alice, instance):
    r = await client.get(
        f"/me/instances/{instance['id']}/direct-endpoint",
        headers={"Cookie": alice["cookie"]},
    )
    assert r.status_code == 404


async def test_lookup_unauthenticated_401(client, instance):
    r = await client.get(f"/me/instances/{instance['id']}/direct-endpoint")
    assert r.status_code == 401


async def test_lookup_stale_heartbeat_marked_offline(
    client, session_factory, alice, instance
):
    await client.post("/selfhost/directory/heartbeat", json=_heartbeat_body(instance))
    async with session_factory() as session:
        await session.execute(
            update(InstanceDirectEndpoint)
            .where(InstanceDirectEndpoint.instance_id == _INSTANCE_ID)
            .values(updated_at=datetime.now(UTC) - timedelta(seconds=900))
        )
        await session.commit()

    r = await client.get(
        f"/me/instances/{instance['id']}/direct-endpoint",
        headers={"Cookie": alice["cookie"]},
    )
    assert r.status_code == 200
    assert r.json()["online"] is False
