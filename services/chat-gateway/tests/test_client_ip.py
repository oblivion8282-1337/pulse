"""Tests für client_ip.py — XFF nur von trusted Proxies (cert-login-Rate-Limit)."""

from __future__ import annotations

import dcc_chat_gateway.client_ip as client_ip_mod
import pytest
from dcc_chat_gateway.config import Settings
from starlette.requests import Request


def _request(peer: str, xff: str | None = None) -> Request:
    headers = []
    if xff is not None:
        headers.append((b"x-forwarded-for", xff.encode()))
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": headers,
        "client": (peer, 12345),
    }
    return Request(scope)


@pytest.fixture
def _trusted(monkeypatch):
    def _set(trusted_proxies: str) -> None:
        settings = Settings(trusted_proxies=trusted_proxies)
        monkeypatch.setattr(client_ip_mod, "get_settings", lambda: settings)
        client_ip_mod._trusted_networks_cache = None

    yield _set
    client_ip_mod._trusted_networks_cache = None


def test_untrusted_peer_ignores_xff(_trusted):
    """Direkt-Caller können ihren Bucket nicht per Header wählen."""
    _trusted("127.0.0.1,::1")
    req = _request("203.0.113.7", xff="1.2.3.4")
    assert client_ip_mod.client_ip(req) == "203.0.113.7"


def test_trusted_loopback_peer_uses_first_xff_hop(_trusted):
    """Self-Host: Caddy im selben Container verbindet via loopback."""
    _trusted("127.0.0.1,::1")
    req = _request("127.0.0.1", xff="198.51.100.9, 10.0.6.2")
    assert client_ip_mod.client_ip(req) == "198.51.100.9"


def test_trusted_cidr_matches_bridge_subnet(_trusted):
    """Cloud: pulse_web (nginx) auf dem pulse-net-Bridge-Subnetz."""
    _trusted("10.0.6.0/24")
    req = _request("10.0.6.3", xff="198.51.100.9")
    assert client_ip_mod.client_ip(req) == "198.51.100.9"


def test_trusted_peer_without_xff_falls_back_to_peer(_trusted):
    _trusted("127.0.0.1")
    req = _request("127.0.0.1")
    assert client_ip_mod.client_ip(req) == "127.0.0.1"


def test_garbage_trusted_proxies_entry_is_skipped(_trusted):
    """Ein kaputter CSV-Eintrag deaktiviert nicht die übrigen."""
    _trusted("not-an-ip, 127.0.0.1")
    req = _request("127.0.0.1", xff="198.51.100.9")
    assert client_ip_mod.client_ip(req) == "198.51.100.9"


def test_empty_xff_falls_back_to_peer(_trusted):
    _trusted("127.0.0.1")
    req = _request("127.0.0.1", xff="  ")
    assert client_ip_mod.client_ip(req) == "127.0.0.1"
