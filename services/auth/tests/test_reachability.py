"""Tests für den NAT-Reachability-Probe-Endpoint (②b-②a)."""
from __future__ import annotations
from unittest.mock import patch
import pytest


def _body(**kw):
    base = {"udp_ports": [7882, 8189], "tcp_ports": [7881, 1936],
            "token": "tok", "public_ip": "203.0.113.5"}
    base.update(kw)
    return base


@pytest.mark.asyncio
async def test_probe_rejects_ip_mismatch(client):
    # client.host im Test ist 127.0.0.1 → public_ip 203.0.113.5 stimmt nicht.
    r = await client.post("/selfhost/reachability/probe", json=_body())
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_probe_rejects_port_outside_allowlist(client):
    with patch("dcc_auth.routes_reachability._client_ip", return_value="203.0.113.5"):
        r = await client.post("/selfhost/reachability/probe",
                              json=_body(tcp_ports=[22]))
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_probe_rejects_private_source_ip(client):
    with patch("dcc_auth.routes_reachability._client_ip", return_value="192.168.1.10"):
        r = await client.post("/selfhost/reachability/probe",
                              json=_body(public_ip="192.168.1.10"))
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_probe_happy_path(client):
    with patch("dcc_auth.routes_reachability._client_ip", return_value="203.0.113.5"), \
         patch("dcc_auth.routes_reachability._tcp_reachable", return_value=True) as tcp, \
         patch("dcc_auth.routes_reachability._send_udp_token") as udp:
        r = await client.post("/selfhost/reachability/probe", json=_body())
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["source_ip"] == "203.0.113.5"
    assert data["tcp"] == {"7881": True, "1936": True}
    assert udp.call_count == 2  # ein Datagramm pro UDP-Port
