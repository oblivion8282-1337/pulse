"""Tests für die Cloud-Relay-Provisionierung (②a): Subdomain-Vergabe,
Tunnel-Token (Hash-only) + interne Validierung."""

from __future__ import annotations

import secrets

import pytest

from dcc_auth.config import get_settings
from dcc_auth.models_instances import RegisteredInstance


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
