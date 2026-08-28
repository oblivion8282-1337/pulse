"""Serverticket prüfen — Frist, Publikum, Zweck, Einmal-Einlösung.

Drei Eigenschaften ersetzen zusammen die frühere Signatur über eine
Server-Nonce; jede einzelne wird hier gegengeprüft. Dazu ``jwks_cold`` als
eigener Befund: Ein Server ohne Cloud-Schlüssel hat kein falsches Ticket vor
sich, sondern die Cloud noch nie erreicht — anderer Handgriff, anderer Code.
"""

from __future__ import annotations

import time

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from dcc_chat_gateway.ticket_pruefung import ZWECK, TicketFehler, pruefe_ticket

SCHLUESSEL = rsa.generate_private_key(public_exponent=65537, key_size=2048)
KID = "test-1"
ISS = "https://howispulse.com"


def _ticket(**ueberschreiben):
    jetzt = int(time.time())
    n = {
        "iss": ISS,
        "aud": "42",
        "sub": "7",
        "purpose": ZWECK,
        "jti": "j1",
        "name": "G",
        "avatar": None,
        "amr": [],
        "acr": "0",
        "legacy_uid": 123,
        "iat": jetzt,
        "exp": jetzt + 60,
    }
    n.update(ueberschreiben)
    return pyjwt.encode(n, SCHLUESSEL, algorithm="RS256", headers={"kid": KID})


@pytest.fixture(autouse=True)
def jwks(monkeypatch):
    async def _keys(_redis):
        return {KID: SCHLUESSEL.public_key()}

    monkeypatch.setattr("dcc_chat_gateway.ticket_pruefung._get_jwks_keys", _keys)


class FakeRedis:
    """Nur ``set`` mit ``nx`` — mehr braucht die Einmal-Einlösung nicht."""

    def __init__(self):
        self.gesetzt: dict[str, str] = {}

    async def set(self, key, value, *, nx=False, ex=None):
        if nx and key in self.gesetzt:
            return None
        self.gesetzt[key] = value
        return True


@pytest.mark.asyncio
async def test_gueltiges_ticket_wird_angenommen():
    d = await pruefe_ticket(_ticket(), instanz_id=42, cloud_issuer=ISS, redis=FakeRedis())
    assert d.sub == "7"
    assert d.legacy_uid == 123
    assert d.jti == "j1"


@pytest.mark.asyncio
async def test_fremdes_publikum_wird_abgelehnt():
    """Ein Ticket fuer Server A darf bei Server B nicht gelten - sonst genuegte
    ein abgefangenes Ticket fuer jeden Server, den das Konto kennt."""
    with pytest.raises(TicketFehler) as e:
        await pruefe_ticket(
            _ticket(aud="99"), instanz_id=42, cloud_issuer=ISS, redis=FakeRedis()
        )
    assert e.value.code == "ticket_wrong_audience"


@pytest.mark.asyncio
async def test_falscher_zweck_wird_abgelehnt():
    """Die Cloud signiert auch Token fuer owner-check und Update-Anstoss. Ohne
    Zweckbindung taugte ein abgefangenes davon zum Anmelden."""
    with pytest.raises(TicketFehler) as e:
        await pruefe_ticket(
            _ticket(purpose="owner-check"), instanz_id=42, cloud_issuer=ISS, redis=FakeRedis()
        )
    assert e.value.code == "ticket_wrong_purpose"


@pytest.mark.asyncio
async def test_abgelaufenes_ticket_wird_abgelehnt():
    jetzt = int(time.time())
    with pytest.raises(TicketFehler) as e:
        await pruefe_ticket(
            _ticket(iat=jetzt - 300, exp=jetzt - 240),
            instanz_id=42,
            cloud_issuer=ISS,
            redis=FakeRedis(),
        )
    assert e.value.code == "ticket_expired"


@pytest.mark.asyncio
async def test_zweite_einloesung_desselben_tickets_wird_abgelehnt():
    r = FakeRedis()
    roh = _ticket()
    await pruefe_ticket(roh, instanz_id=42, cloud_issuer=ISS, redis=r)
    with pytest.raises(TicketFehler) as e:
        await pruefe_ticket(roh, instanz_id=42, cloud_issuer=ISS, redis=r)
    assert e.value.code == "ticket_replayed"


@pytest.mark.asyncio
async def test_kalte_jwks_sind_ein_eigener_befund(monkeypatch):
    """Ohne Cloud-Schluessel ist die Signatur nicht pruefbar.

    Das ist kein ungueltiges Ticket, sondern ein Server, der die Cloud noch nie
    erreicht hat. Zwei verschiedene Handgriffe, deshalb zwei Codes - genau die
    Unterscheidung, die dem alten Weg fehlte.
    """

    async def _leer(_redis):
        return {}

    monkeypatch.setattr("dcc_chat_gateway.ticket_pruefung._get_jwks_keys", _leer)
    with pytest.raises(TicketFehler) as e:
        await pruefe_ticket(_ticket(), instanz_id=42, cloud_issuer=ISS, redis=FakeRedis())
    assert e.value.code == "jwks_cold"


@pytest.mark.asyncio
async def test_fremder_aussteller_wird_abgelehnt():
    with pytest.raises(TicketFehler) as e:
        await pruefe_ticket(
            _ticket(iss="https://boese.example.com"),
            instanz_id=42,
            cloud_issuer=ISS,
            redis=FakeRedis(),
        )
    assert e.value.code == "ticket_wrong_issuer"
