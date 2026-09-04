"""``POST /internal/guest-token`` — Gast-Tickets ausstellen.

auth-svc weiss von Gast-Links nichts. Es hält den RS256-Schlüssel, dessen JWKS
chat-gateway, voice-signaling und media-svc in beiden Betriebsarten schon
vertrauen — deshalb entsteht das Ticket hier und nirgends sonst.

Geprüft wird vor allem, was die Route NICHT tut: sie mintet genau eine Form
und deckelt die Laufzeit. Ein Aufrufer, der beliebige Claims setzen dürfte,
machte aus dem internen Dienst-Geheimnis einen Generalschlüssel für jede
Identität.
"""

from __future__ import annotations

import jwt
import pytest

from dcc_auth.routes_gast_ticket import MAX_TTL_S

_SECRET = "test-internal-secret-gast"


def _body(**over) -> dict:
    b = {
        "gast_id": "gast-12345",
        "guild_id": "9",
        "channel_id": "555",
        "name": "Frau Meier",
        "ttl_s": 3600,
    }
    b.update(over)
    return b


class TestGastTicket:
    async def test_stellt_ticket_mit_kanalbindung_aus(self, client, _isolate_settings):
        _isolate_settings.internal_service_secret = _SECRET
        r = await client.post(
            "/internal/guest-token",
            json=_body(),
            headers={"X-Pulse-Internal-Secret": _SECRET},
        )
        assert r.status_code == 200, r.text
        payload = jwt.decode(r.json()["token"], options={"verify_signature": False})
        assert payload["typ"] == "gast"
        assert payload["sub"] == "gast-12345"
        assert payload["channel_id"] == "555"
        assert payload["guild_id"] == "9"
        assert payload["name"] == "Frau Meier"
        assert payload["exp"] - payload["iat"] == 3600

    async def test_ohne_geheimnis_kein_ticket(self, client, _isolate_settings):
        _isolate_settings.internal_service_secret = _SECRET
        r = await client.post("/internal/guest-token", json=_body())
        assert r.status_code == 401

    async def test_ungesetztes_geheimnis_schliesst_die_route(self, client, _isolate_settings):
        """Fail-closed: ohne serverseitiges Geheimnis ist die Route zu.

        Sonst wäre eine Fehlkonfiguration ein offener Ticket-Automat.
        """
        _isolate_settings.internal_service_secret = None
        r = await client.post(
            "/internal/guest-token",
            json=_body(),
            headers={"X-Pulse-Internal-Secret": "irgendwas"},
        )
        assert r.status_code == 401

    async def test_laufzeit_ist_gedeckelt(self, client, _isolate_settings):
        _isolate_settings.internal_service_secret = _SECRET
        r = await client.post(
            "/internal/guest-token",
            json=_body(ttl_s=MAX_TTL_S + 1),
            headers={"X-Pulse-Internal-Secret": _SECRET},
        )
        # Die Grenze wirkt schon an der Form: eine längere Laufzeit ist gar
        # nicht erst gültige Eingabe.
        assert r.status_code == 422

    @pytest.mark.parametrize(
        "feld,wert",
        [
            ("gast_id", "12345"),          # ohne gast--Präfix
            ("gast_id", "user-12345"),     # eine Nutzer-Kennung untergeschoben
            ("channel_id", "abc"),         # keine Snowflake
            ("name", ""),                  # leerer Name
        ],
    )
    async def test_verformte_eingabe_wird_abgewiesen(
        self, client, _isolate_settings, feld, wert
    ):
        _isolate_settings.internal_service_secret = _SECRET
        r = await client.post(
            "/internal/guest-token",
            json=_body(**{feld: wert}),
            headers={"X-Pulse-Internal-Secret": _SECRET},
        )
        assert r.status_code == 422
