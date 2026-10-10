"""Bremsen-Schlüssel (IPv6 nach /64) und Vorschau-Bremse für Angemeldete."""

from __future__ import annotations

import pytest
from dcc_chat_gateway.client_ip import bremsen_schluessel


def test_ipv4_unveraendert():
    assert bremsen_schluessel("203.0.113.7") == "203.0.113.7"


def test_ipv6_gleiches_64er_netz_gleicher_schluessel():
    a = bremsen_schluessel("2001:db8:1:2::1")
    b = bremsen_schluessel("2001:db8:1:2:ffff:ffff:ffff:ffff")
    assert a == b


def test_ipv6_verschiedene_64er_netze_verschieden():
    assert bremsen_schluessel("2001:db8:1:2::1") != bremsen_schluessel("2001:db8:1:3::1")


@pytest.mark.parametrize("muell", ["unknown", "", "not-an-ip", "1.2.3"])
def test_unparsbares_unveraendert(muell):
    assert bremsen_schluessel(muell) == muell


@pytest.mark.asyncio
async def test_vorschau_bremse_je_nutzer(client, _auth_signer):
    token = _auth_signer.issue_access(4242, "user4242")
    h = {"Authorization": f"Bearer {token}"}
    for _ in range(120):
        r = await client.get("/invites/gibtsnicht", headers=h)
        assert r.status_code == 404
    r = await client.get("/invites/gibtsnicht", headers=h)
    assert r.status_code == 429
    assert r.json()["detail"] == "rate limit exceeded"


def test_ipv4_mapped_ipv6_wird_zu_ipv4():
    a = bremsen_schluessel("::ffff:1.2.3.4")
    b = bremsen_schluessel("::ffff:5.6.7.8")
    assert a == "1.2.3.4"
    assert b == "5.6.7.8"
    assert a != b
