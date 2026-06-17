"""Tests für die Cloud-Relay-Provisionierung (②a): Subdomain-Vergabe,
Tunnel-Token (Hash-only) + interne Validierung."""

from __future__ import annotations

import re
import secrets

import pytest

from dcc_auth.config import get_settings
from dcc_auth.models_instances import RegisteredInstance
from dcc_auth.relay import (
    RELAY_TOKEN_PREFIX,
    allocate_relay_subdomain,
    generate_relay_slug,
    generate_relay_token,
    hash_relay_token,
)


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
