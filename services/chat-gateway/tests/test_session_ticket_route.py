"""``POST /session`` — ein Cloud-Ticket gegen eine Sitzung dieses Servers tauschen.

Die Signatur wird hier **echt** geprüft, nicht wegge-mockt: Das Ticket wird mit
demselben Schlüssel signiert, dessen JWKS die Tests in Redis legen. Ein Mock an
dieser Stelle prüfte nur die eigene Verdrahtung — und genau diese Kette (Cloud
signiert, Self-Host verifiziert) ist der Kern des Umbaus.
"""

from __future__ import annotations

import json
import time
import uuid

import jwt as pyjwt
import pytest
import pytest_asyncio

from dcc_chat_gateway.session_tokens import reset_session_signer, validate_session_token
from dcc_chat_gateway.ticket_pruefung import ZWECK

INSTANZ = 100  # ``pulse_instance_id`` der Testumgebung (conftest)
ISSUER = "https://howispulse.com"
NUTZER = "73315227868860416"


@pytest_asyncio.fixture
async def jwks_in_redis(app, _auth_signer):
    """Legt die Cloud-JWKS dorthin, wo der Server sie sucht.

    **Beide** Schlüssel, mit Absicht: ``_get_jwks_keys`` wählt zwischen
    ``auth:cloud_jwks:cached`` (Self-Host) und ``auth:jwks:cached`` (Cloud)
    anhand der Betriebsart — und die liest es aus einer Stelle, die der conftest
    nicht patcht. Im Einzellauf gilt deshalb der eine, im Gate (dort steht die
    Umgebung auf ``cloud``) der andere. Nur einen zu setzen hiesse, dass diese
    Tests je nach Umgebung etwas anderes prüfen, und das ist schlimmer als ein
    überzähliger Schlüssel im Test-Redis.
    """
    from dcc_chat_gateway.credential_validator import (
        REDIS_CLOUD_JWKS_KEY,
        REDIS_JWKS_KEY,
    )

    roh = json.dumps(_auth_signer.jwks())
    await app.state.redis.set(REDIS_CLOUD_JWKS_KEY, roh)
    await app.state.redis.set(REDIS_JWKS_KEY, roh)
    yield
    await app.state.redis.delete(REDIS_CLOUD_JWKS_KEY, REDIS_JWKS_KEY)


@pytest.fixture
def ticket_bauer(_auth_signer, _isolate_chat_settings):
    """Baut ein echtes, mit dem Cloud-Schlüssel signiertes Serverticket."""

    def _bauen(**ueberschreiben):
        jetzt = int(time.time())
        n = {
            "iss": ISSUER,
            "aud": str(INSTANZ),
            "sub": NUTZER,
            "purpose": ZWECK,
            "jti": str(uuid.uuid4()),
            "name": "GordonBradley",
            "avatar": None,
            "amr": ["pwd"],
            "acr": "0",
            "legacy_uid": None,
            "iat": jetzt,
            "exp": jetzt + 60,
        }
        n.update(ueberschreiben)
        return pyjwt.encode(
            n,
            _auth_signer._private_key,
            algorithm="RS256",
            headers={"kid": _auth_signer._settings.jwt_key_id},
        )

    return _bauen


@pytest.fixture(autouse=True)
def _kein_betreiber(_isolate_chat_settings):
    """Setzt ``pulse_instance_owner_id`` vor JEDEM Test zurueck.

    ``_isolate_chat_settings`` im conftest setzt nur Betriebsart und
    Instanz-Kennung zurueck, nicht den Betreiber. Ohne diese Fixture haengt das
    Ergebnis eines Tests davon ab, welcher vorher lief — und das faellt erst
    auf, wenn jemand die Reihenfolge aendert oder einen Test einzeln fahren
    laesst.
    """
    _isolate_chat_settings.pulse_instance_owner_id = 0
    return _isolate_chat_settings


@pytest.fixture(autouse=True)
def _frischer_sitzungsschluessel(tmp_path, _isolate_chat_settings):
    """Eigener Signierschlüssel je Test — sonst trägt ein Lauf den des vorigen."""
    _isolate_chat_settings.session_signing_key_file = str(tmp_path / "session.pem")
    reset_session_signer()
    yield
    reset_session_signer()


@pytest.fixture
def als_betreiber(_isolate_chat_settings):
    """Der Ticket-Inhaber ist der Betreiber dieser Instanz.

    Ohne das weist das Beitritts-Gate ihn ab — zu Recht: Ein Ticket beweist, WER
    jemand ist, nicht dass er hier hereindarf. Die Trennung ist Absicht und
    bleibt vom Ticket-Weg unberuehrt.
    """
    _isolate_chat_settings.pulse_instance_owner_id = int(NUTZER)
    return _isolate_chat_settings


@pytest.mark.asyncio
async def test_gueltiges_ticket_ergibt_eine_sitzung(
    client, ticket_bauer, jwks_in_redis, als_betreiber
):
    r = await client.post("/session", json={"ticket": ticket_bauer()})
    assert r.status_code == 200, r.text
    assert r.json()["expires_in"] == 3600
    assert r.json()["session_token"]


@pytest.mark.asyncio
async def test_ein_gueltiges_ticket_ist_noch_keine_eintrittskarte(
    client, ticket_bauer, jwks_in_redis
):
    """Wer weder Betreiber noch Mitglied ist und keine Einladung vorlegt, kommt
    nicht herein — auch mit einwandfreiem Ausweis.

    Das ist die Trennung, auf der der ganze Entwurf steht: Die Cloud sagt, WER
    jemand ist; ob er hier hereindarf, entscheidet der Betreiber.
    """
    r = await client.post("/session", json={"ticket": ticket_bauer()})
    assert r.status_code == 403
    assert r.json()["detail"] == "join_not_permitted"


@pytest.mark.asyncio
async def test_der_betreiber_wird_als_admin_erkannt(
    client, ticket_bauer, jwks_in_redis, _isolate_chat_settings
):
    """Admin entsteht auf einem Self-Host an genau EINER Stelle — dem Vergleich
    der Kennung aus dem Ausweis mit ``PULSE_INSTANCE_OWNER_ID``.

    Der Ticket-Weg aendert daran nichts; er macht den Vergleich sogar
    geradliniger, weil ``sub`` dieselbe Zahl traegt, die in der ``.env`` steht.
    """
    _isolate_chat_settings.pulse_instance_owner_id = int(NUTZER)
    r = await client.post("/session", json={"ticket": ticket_bauer()})
    assert r.status_code == 200, r.text
    claims = validate_session_token(
        r.json()["session_token"],
        key_path=_isolate_chat_settings.session_signing_key_file,
    )
    assert claims is not None
    assert claims.admin is True


@pytest.mark.asyncio
async def test_wer_nicht_betreiber_ist_bekommt_kein_admin(
    client, ticket_bauer, jwks_in_redis, _isolate_chat_settings
):
    _isolate_chat_settings.pulse_instance_owner_id = 999
    r = await client.post("/session", json={"ticket": ticket_bauer()})
    assert r.status_code in (200, 403)
    if r.status_code == 200:
        claims = validate_session_token(
            r.json()["session_token"],
            key_path=_isolate_chat_settings.session_signing_key_file,
        )
        assert claims.admin is False


@pytest.mark.asyncio
async def test_abgelehntes_ticket_nennt_seinen_grund(client, ticket_bauer, jwks_in_redis):
    """Der Grund reist bis in die Oberflaeche.

    Genau das fehlte am 2026-08-28 und kostete zwei Stunden Fehlersuche an einem
    vollkommen gesunden Server: Die App zeigte „Anmeldung abgelaufen oder Server
    nicht erreichbar", obwohl sie den echten Grund kannte.
    """
    r = await client.post("/session", json={"ticket": ticket_bauer(aud="999")})
    assert r.status_code == 403
    assert r.json()["detail"] == "ticket_wrong_audience"


@pytest.mark.asyncio
async def test_zweite_einloesung_wird_abgelehnt(
    client, ticket_bauer, jwks_in_redis, als_betreiber
):
    roh = ticket_bauer()
    erste = await client.post("/session", json={"ticket": roh})
    assert erste.status_code == 200, erste.text
    zweite = await client.post("/session", json={"ticket": roh})
    assert zweite.status_code == 403
    assert zweite.json()["detail"] == "ticket_replayed"


@pytest.mark.asyncio
async def test_ohne_cloud_schluessel_eigener_grund(client, app, ticket_bauer):
    """Der Server hat die Cloud nie erreicht — ein eigener Grund.

    Das ist kein ungueltiges Ticket, sondern ein anderer Handgriff: Der Server
    muss ans Netz. Deshalb ein eigener Code.

    BEIDE Schluessel werden ausdruecklich geloescht. Zwei Gruende, beide
    nachgemessen: Redis ist in der Suite geteilt, ein anderer Test hatte den
    Schluessel hinterlassen (Einzellauf gruen, Gesamtlauf rot). Und
    ``_get_jwks_keys`` waehlt zwischen ``auth:cloud_jwks:cached`` und
    ``auth:jwks:cached`` anhand der Betriebsart — die es aus einer NICHT vom
    conftest gepatchten Stelle liest, weshalb im Gate (dort steht die Umgebung
    auf ``cloud``) der jeweils andere Schluessel gilt als im Einzellauf.
    """
    from dcc_chat_gateway.credential_validator import (
        REDIS_CLOUD_JWKS_KEY,
        REDIS_JWKS_KEY,
    )

    await app.state.redis.delete(REDIS_CLOUD_JWKS_KEY, REDIS_JWKS_KEY)
    r = await client.post("/session", json={"ticket": ticket_bauer()})
    assert r.status_code == 403
    assert r.json()["detail"] == "jwks_cold"


@pytest.mark.asyncio
async def test_ticket_sitzung_erfuellt_die_bedingungen_der_erneuerung(
    client, ticket_bauer, jwks_in_redis, als_betreiber
):
    """Eine Sitzung aus dem Ticket-Weg muss am offenen Socket erneuerbar sein.

    Sonst waere die Stunde eine Wand statt einer Frist: Der Nutzer floege mitten
    im Gespraech heraus, und bei einem Cloud-Ausfall koennte er sich nicht
    einmal neu anmelden. Der Weg (``ws_token_renewal``) existierte schon, war
    aber nie mit einem Token aus DIESEM Ausstellungspfad benutzt worden — genau
    die Sorte Annahme, die still bricht.

    Geprueft werden die drei Bedingungen, die ``handle_token_refresh`` stellt:
    das Token muss dekodierbar sein, auf denselben Nutzer lauten und dieselben
    Rechte-Claims tragen.

    **Was dieser Test NICHT abdeckt:** den Socket-Rundlauf selbst. Der braucht
    ``ws_app``, und dessen Lifespan-Guard verlangt eine Umgebung, die die Suite
    im Gate auf ``cloud`` stellt — in Cloud-Betriebsart weist ``decode_token``
    ein Sitzungs-Token ohne ``kid`` aber grundsaetzlich ab. Der Rundlauf ist
    fuer Cloud-Token in ``test_ws_token_renewal.py`` abgedeckt; die Luecke
    betrifft die Kombination Self-Host + Socket und ist hier benannt statt
    verschwiegen.
    """
    from dcc_chat_gateway.security import decode_token

    r = await client.post("/session", json={"ticket": ticket_bauer()})
    assert r.status_code == 200, r.text
    token = r.json()["session_token"]

    payload = await decode_token(token)
    assert payload["sub"] == NUTZER, "Erneuerung wuerde als fremder Nutzer abgelehnt"
    assert payload["admin"] is True, "Erneuerung wuerde als Rechte-Aenderung abgelehnt"
    assert payload["exp"] > time.time(), "Erneuerung wuerde als abgelaufen abgelehnt"


@pytest.mark.asyncio
async def test_beitritt_mit_einladung_ueber_das_ticket(
    client, ticket_bauer, jwks_in_redis, session_factory
):
    """Ein Neuling kommt mit einem Community-Einladungscode herein.

    Der alte Weg (``cert-login/verify``) nahm ``community_grant_code`` und
    ``public_join_handle`` entgegen und reichte sie ans Beitritts-Gate. Ohne
    dieselben Felder hier stirbt mit dem Cert-Weg auch der Beitritt per
    Einladung — und das faellt erst auf, wenn jemand einen Server BETRETEN
    will, nicht beim Wiederanmelden eines Mitglieds.
    """
    from sqlalchemy import text

    # Eine oeffentliche Community auf dieser Instanz ist ihre eigene Erlaubnis.
    async with session_factory() as s:
        await s.execute(
            text(
                "INSERT INTO guilds (id, name, owner_id, is_public, handle) "
                "VALUES (777, 'Offen', 1, 1, 'offen')"
            )
        )
        await s.commit()

    r = await client.post(
        "/session",
        json={"ticket": ticket_bauer(), "public_join_handle": "offen"},
    )
    assert r.status_code == 200, r.text
