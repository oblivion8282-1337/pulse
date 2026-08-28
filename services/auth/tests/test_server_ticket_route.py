"""``POST /me/server-ticket`` — den Ausweis für einen Self-Host holen.

Die Route entscheidet ausdrücklich NICHT, ob der Nutzer auf diesen Server darf.
Das bleibt die Sache des Betreibers (Beitritts-Gate im chat-gateway). Geprüft
wird hier nur, was die Cloud wissen kann: Konto, Instanz, Sperre, Rate.
"""

from __future__ import annotations

import jwt as pyjwt
import pytest

_REG = {
    "username": "ticket_alice",
    "email": "ticket_alice@dcc-test.example.com",
    "password": "horse battery staple correct",
    "display_name": "Alice",
}
_LOGIN = {"email_or_username": _REG["email"], "password": _REG["password"]}


async def _reg_and_login(client):
    """Gibt ``(cookie, user_id)`` zurück.

    ``_reg_and_login`` in ``test_credentials_endpoints`` liefert den
    Access-Token statt der Kennung; die Kennung steht als ``sub`` darin.
    """
    await client.post("/register", json=_REG)
    r = await client.post("/login", json=_LOGIN)
    assert r.status_code == 200, r.text
    sid = r.cookies.get("pulse_session")
    assert sid
    sub = pyjwt.decode(
        r.json()["access_token"], options={"verify_signature": False}
    )["sub"]
    return f"pulse_session={sid}", int(sub)


async def _instanz_anlegen(session_factory, *, iid: int, hostname: str, besitzer: int):
    from dcc_auth.models_instances import RegisteredInstance

    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=iid,
                hostname=hostname,
                client_id=f"client-{iid}",
                client_secret="argon2-hash-egal",
                worker_id_chat=iid % 900 + 1,
                worker_id_voice=iid % 900 + 2,
                worker_id_media=iid % 900 + 3,
                status="active",
                registered_by=besitzer,
            )
        )
        await s.commit()


@pytest.mark.asyncio
async def test_ticket_wird_auf_die_angefragte_instanz_ausgestellt(client, session_factory):
    cookie, user_id = await _reg_and_login(client)
    await _instanz_anlegen(
        session_factory, iid=900001, hostname="a.example.com", besitzer=user_id
    )

    r = await client.post(
        "/me/server-ticket", json={"hostname": "a.example.com"}, headers={"Cookie": cookie}
    )
    assert r.status_code == 200, r.text
    c = pyjwt.decode(r.json()["ticket"], options={"verify_signature": False}, audience="900001")
    assert c["aud"] == "900001"
    assert c["sub"] == str(user_id)
    assert r.json()["expires_in"] == 60


@pytest.mark.asyncio
async def test_ohne_anmeldung_kein_ticket(client, session_factory):
    await _instanz_anlegen(
        session_factory, iid=900002, hostname="b.example.com", besitzer=1
    )
    r = await client.post("/me/server-ticket", json={"hostname": "b.example.com"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_unbekannte_instanz_gibt_404(client):
    cookie, _ = await _reg_and_login(client)
    r = await client.post(
        "/me/server-ticket", json={"hostname": "gibt-es-nicht.example.com"}, headers={"Cookie": cookie}
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_gesperrte_instanz_bekommt_kein_ticket(client, session_factory):
    """Die Sperre wirkt schon beim Ausstellen, nicht erst beim Einloesen.

    Sonst reist ein gueltiges Ticket zu einem Server, der es ohnehin ablehnt —
    und der Nutzer saehe einen Fehler des Servers statt der wahren Ursache.
    """
    from dcc_auth.models_instances import SuspendedInstance

    cookie, user_id = await _reg_and_login(client)
    await _instanz_anlegen(
        session_factory, iid=900003, hostname="c.example.com", besitzer=user_id
    )
    async with session_factory() as s:
        s.add(SuspendedInstance(instance_id=900003, reason="Test"))
        await s.commit()

    r = await client.post(
        "/me/server-ticket", json={"hostname": "c.example.com"}, headers={"Cookie": cookie}
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "instance_suspended"


@pytest.mark.asyncio
async def test_ratenlimit_greift(client, session_factory, app):
    """Der Schutz sitzt hier, wo der Dienst ohnehin einen Begrenzer fuehrt.

    Der Cert-Login musste sich im chat-gateway einen eigenen In-Prozess-Zaehler
    samt Verdraengungsstrategie halten, weil es dort keinen gibt. Mit dem
    Ticket-Weg entfaellt dieser Nachbau.
    """
    cookie, user_id = await _reg_and_login(client)
    await _instanz_anlegen(
        session_factory, iid=900004, hostname="d.example.com", besitzer=user_id
    )
    letzte = None
    for _ in range(61):
        letzte = await client.post(
            "/me/server-ticket", json={"hostname": "d.example.com"}, headers={"Cookie": cookie}
        )
    assert letzte.status_code == 429


@pytest.mark.asyncio
async def test_der_hostname_bestimmt_das_publikum_nicht_der_anfragende(
    client, session_factory
):
    """Ein Ticket gilt fuer den Server unter DIESEM Hostnamen — Punkt.

    Der Klient nannte bis zum Bughunt die Instanz-KENNUNG, und die konnte er nur
    vom Server selbst haben (``/.well-known/pulse-server-info``, unbeglaubigt).
    Ein boesartiger Host meldete dort die Kennung eines FREMDEN Servers, bekam
    ein darauf ausgestelltes Ticket ausgehaendigt und loeste es dort binnen der
    Gueltigkeit ein — volle Sitzung als der Nutzer.

    Dieser Test haelt fest, dass das ``aud`` aus der Aufloesung DURCH DIE CLOUD
    stammt und nicht aus der Anfrage.
    """
    cookie, user_id = await _reg_and_login(client)
    await _instanz_anlegen(
        session_factory, iid=900010, hostname="ehrlich.example.com", besitzer=user_id
    )
    await _instanz_anlegen(
        session_factory, iid=900011, hostname="boese.example.com", besitzer=user_id
    )

    r = await client.post(
        "/me/server-ticket",
        json={"hostname": "boese.example.com"},
        headers={"Cookie": cookie},
    )
    assert r.status_code == 200, r.text
    c = pyjwt.decode(r.json()["ticket"], options={"verify_signature": False}, audience="900011")
    assert c["aud"] == "900011", "das Ticket gilt fuer den genannten Host"
    assert r.json()["instance_id"] == "900011"

    # Gegenprobe: Es gibt keinen Weg, mit diesem Aufruf ein Ticket fuer die
    # andere Instanz zu bekommen — das Publikum haengt allein am Hostnamen.
    assert c["aud"] != "900010"


@pytest.mark.asyncio
async def test_hostname_wird_normalisiert(client, session_factory):
    """Ein Schema oder Grossbuchstaben duerfen die Aufloesung nicht scheitern lassen."""
    cookie, user_id = await _reg_and_login(client)
    await _instanz_anlegen(
        session_factory, iid=900012, hostname="gross.example.com", besitzer=user_id
    )
    for eingabe in ("gross.example.com", "GROSS.example.com", "https://gross.example.com"):
        r = await client.post(
            "/me/server-ticket", json={"hostname": eingabe}, headers={"Cookie": cookie}
        )
        assert r.status_code == 200, f"{eingabe}: {r.text}"
        assert r.json()["instance_id"] == "900012"


@pytest.mark.asyncio
async def test_das_ticket_traegt_den_echten_zweitfaktor(client, session_factory):
    """``amr``/``acr`` kommen aus der SITZUNG, nicht aus einer festen Zeile.

    Festverdrahtet saehe jeder Self-Host jeden Nutzer als „nur Passwort" — auch
    den, der sich gerade mit einem Passkey angemeldet hat, und der Server koennte
    fuer heikle Aktionen keinen zweiten Faktor mehr verlangen. Die
    Datenschutzerklaerung (Abschnitt 20) sagt Nutzern ausdruecklich zu, dass
    diese Angabe mitreist.
    """
    from sqlalchemy import text as _text

    cookie, user_id = await _reg_and_login(client)
    await _instanz_anlegen(
        session_factory, iid=900020, hostname="mfa.example.com", besitzer=user_id
    )
    # Die laufende Sitzung auf „mit zweitem Faktor" heben.
    async with session_factory() as s:
        await s.execute(
            _text("UPDATE user_sessions SET amr = :a, acr = :c").bindparams(
                a='["pwd", "webauthn"]', c="mfa"
            )
        )
        await s.commit()

    r = await client.post(
        "/me/server-ticket", json={"hostname": "mfa.example.com"}, headers={"Cookie": cookie}
    )
    assert r.status_code == 200, r.text
    c = pyjwt.decode(r.json()["ticket"], options={"verify_signature": False}, audience="900020")
    assert c["acr"] == "mfa", "der Zweitfaktor-Nachweis faellt unter den Tisch"
    assert "webauthn" in c["amr"]
