"""Selbstbedienungs-Registrierung (Heim-Server, Entscheidung 2026-09-27).

``POST /me/instances``: eingeloggt genügt — keine Antrag+Freischalt-Strecke
mehr. Deckt ab: Happy Path (201, einmaliges Klartext-Secret, Hash in der DB,
Owner-Membership, ``self_host_enabled`` gesetzt), das 1-Pro-Konto-Limit (409)
und den Cookie-Zwang.
"""

from __future__ import annotations

import pytest

from sqlalchemy import select

from dcc_auth.models import User
from dcc_auth.models_instances import (
    RegisteredInstance,
    UserInstanceMembership,
)

_REG_A = {
    "username": "heim_alice",
    "email": "heim_alice@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Alice",
}
_LOGIN_A = {"email_or_username": _REG_A["email"], "password": _REG_A["password"]}


async def _reg_and_login(client, reg: dict, login: dict) -> str:
    await client.post("/register", json=reg)
    r = await client.post("/login", json=login)
    assert r.status_code == 200, r.text
    sid = r.cookies.get("pulse_session")
    assert sid, "pulse_session cookie fehlt"
    return f"pulse_session={sid}"


async def _user_id(client, cookie: str) -> int:
    r = await client.get("/me", headers={"Cookie": cookie})
    assert r.status_code == 200, r.text
    return int(r.json()["id"])


@pytest.fixture
async def alice_cookie(client) -> str:
    return await _reg_and_login(client, _REG_A, _LOGIN_A)


async def test_create_requires_cookie(client):
    r = await client.post("/me/instances")
    assert r.status_code in (401, 403), r.text


async def test_create_happy_path(client, alice_cookie, session_factory):
    uid = await _user_id(client, alice_cookie)
    r = await client.post("/me/instances", headers={"Cookie": alice_cookie})
    assert r.status_code == 201, r.text
    body = r.json()

    # Instanz-Shell da, app_host-Platzhalter-Hostname, Secret einmalig klar.
    assert body["instance"]["origin"] == "app_host"
    assert body["instance"]["hostname"].startswith("app-")
    assert body["instance"]["role"] == "owner"
    assert body["client_secret"], "Klartext-Secret fehlt"

    async with session_factory() as session:
        user = await session.get(User, uid)
        assert user is not None and user.self_host_enabled, "self_host_enabled nicht gesetzt"

        iid = int(body["instance"]["id"])
        inst = await session.get(RegisteredInstance, iid)
        assert inst is not None
        # In der DB liegt nur der Hash — das Klartext-Secret selbst darf nie
        # speicherbar sein, sonst wäre der Einmal-Charakter fakultativ.
        assert inst.client_secret != body["client_secret"]
        assert inst.client_secret.startswith("$argon2")

        member = (
            await session.execute(
                select(UserInstanceMembership).where(
                    UserInstanceMembership.instance_id == iid,
                    UserInstanceMembership.user_id == uid,
                )
            )
        ).scalars().first()
        assert member is not None and member.role == "owner"


async def test_second_create_conflicts_409(client, alice_cookie):
    r1 = await client.post("/me/instances", headers={"Cookie": alice_cookie})
    assert r1.status_code == 201, r1.text
    r2 = await client.post("/me/instances", headers={"Cookie": alice_cookie})
    assert r2.status_code == 409, r2.text


async def test_create_visible_in_listing(client, alice_cookie):
    r1 = await client.post("/me/instances", headers={"Cookie": alice_cookie})
    assert r1.status_code == 201, r1.text
    r2 = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    assert r2.status_code == 200, r2.text
    ids = {item["id"] for item in r2.json()}
    assert r1.json()["instance"]["id"] in ids


async def test_limits_are_per_account(client, session_factory):
    """Zwei Konten, zwei Server — das 1-Pro-Konto-Limit ist keine globale Sperre."""
    reg_a = dict(_REG_A)
    reg_b = {
        "username": "heim_bob",
        "email": "heim_bob@dcc-test.example.com",
        "password": "correct horse battery staple",
        "display_name": "Bob",
    }
    cookie_a = await _reg_and_login(
        client, reg_a, {"email_or_username": reg_a["email"], "password": reg_a["password"]}
    )
    cookie_b = await _reg_and_login(
        client, reg_b, {"email_or_username": reg_b["email"], "password": reg_b["password"]}
    )
    r_a = await client.post("/me/instances", headers={"Cookie": cookie_a})
    r_b = await client.post("/me/instances", headers={"Cookie": cookie_b})
    assert r_a.status_code == 201, r_a.text
    assert r_b.status_code == 201, r_b.text
    assert r_a.json()["instance"]["id"] != r_b.json()["instance"]["id"]


# ---------------------------------------------------------------------------
# Der volle Cloud-Durchlauf (Heim-Server 2026-09-27): Selbstbedienung →
# Bootstrap-Token → Einlösung → die Werte, ohne die der All-in-One-Container
# hart failt (10-check-cloud-creds.sh verlangt HOSTNAME, INSTANCE_ID,
# CLIENT_ID/SECRET, ADMIN_EMAIL, OWNER_ID). Genau diese Kette fährt die
# Server-App (`serverProvision.provision`) — der Test ist ihr Spiegelbild.
# ---------------------------------------------------------------------------


async def test_voller_durchlauf_selbstbedienung_bis_container_env(
    client, alice_cookie, session_factory
):
    uid = await _user_id(client, alice_cookie)

    # 1. Selbstbedienung: anlegen.
    r = await client.post("/me/instances", headers={"Cookie": alice_cookie})
    assert r.status_code == 201, r.text
    instanz = r.json()["instance"]
    iid = instanz["id"]

    # 2. Bootstrap-Token minten (Server-App-Schritt).
    mint = await client.post(
        f"/me/instances/{iid}/bootstrap-token", headers={"Cookie": alice_cookie}
    )
    assert mint.status_code == 201, mint.text
    token = mint.json()["token"]

    # 3. Zweiter Mint vor Einlösung: erlaubt, VERWIRFT aber Token #1 (Räumung
    #    der uneingelösten Tokens — nur ein lebender Installer je Instanz).
    mint2 = await client.post(
        f"/me/instances/{iid}/bootstrap-token", headers={"Cookie": alice_cookie}
    )
    assert mint2.status_code == 201, mint2.text
    token2 = mint2.json()["token"]
    stale = await client.post(
        "/selfhost/bootstrap", headers={"Authorization": f"Bearer {token}"}
    )
    assert stale.status_code == 401, "Token #1 hätte verworfen werden müssen"
    token = token2

    # 4. Einlösen (das tut der Container/Installer) → komplette Env.
    redeem = await client.post(
        "/selfhost/bootstrap",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert redeem.status_code == 200, redeem.text
    creds = redeem.json()
    # 10-check-cloud-creds.sh fordert genau diese fünf:
    assert creds["hostname"], "PULSE_HOSTNAME fehlt"
    assert creds["instance_id"] == iid, "PULSE_INSTANCE_ID fehlt"
    assert creds["client_id"] and creds["client_secret"], "CLOUD_CLIENT_ID/SECRET fehlen"
    assert creds["admin_email"] == _REG_A["email"], "PULSE_ADMIN_EMAIL fehlt"
    assert creds["owner_user_id"] == str(uid), "PULSE_INSTANCE_OWNER_ID fehlt"
    assert creds["cloud_origin"], "PULSE_CLOUD_ORIGIN fehlt"

    # 5. Token ist Einmal-Ware: Redeem #2 scheitert.
    again = await client.post(
        "/selfhost/bootstrap", headers={"Authorization": f"Bearer {token}"}
    )
    assert again.status_code == 401, again.text

    # 6. Friend-Join + Telefonbuch: die Cloud-seitige Hälfte des Mitglieder-
    #    Direktwegs (Baustein 3). Owner trägt Bob ein, Bob liest den Endpoint.
    _reg_b = {
        "username": "heim_bob_flow",
        "email": "heim_bob_flow@dcc-test.example.com",
        "password": "correct horse battery staple",
        "display_name": "Bob",
    }
    await client.post("/register", json=_reg_b)
    login_b = await client.post(
        "/login",
        json={
            "email_or_username": _reg_b["email"],
            "password": _reg_b["password"],
        },
    )
    assert login_b.status_code == 200, login_b.text
    bob_cookie = f"pulse_session={login_b.cookies.get('pulse_session')}"

    join = await client.post(
        f"/me/instances/{iid}/membership", headers={"Cookie": bob_cookie}
    )
    assert join.status_code in (200, 201, 204), join.text

    # Noch kein Heartbeat des Containers → 404 (offline), aber KEIN 404-wegen-
    # Berechtigung mehr: ein Nicht-Mitglied bleibt bei 404, das Mitglied
    # bekommt nach dem Heartbeat den Endpoint.
    fremd = await client.get(f"/me/instances/{iid}/direct-endpoint",
                             headers={"Cookie": alice_cookie})
    # Alice (Owner) darf fragen; ohne Heartbeat kommt 404 "not found" —
    # wichtig ist: kein 403/401.
    assert fremd.status_code == 404

    # Der Adapter ohne Relay weist sich mit den Pairing-Creds aus
    # (client_id + client_secret als Token) — exakt wie direct-adapter
    # config.rs::from_env sie aus der Env zieht.
    heartbeat = await client.post(
        "/selfhost/directory/heartbeat",
        json={
            "instance_id": iid,
            "token": creds["client_secret"],
            "client_id": creds["client_id"],
            "candidates": [{"ip": "93.184.216.34", "port": 7900, "protocol": "udp"}],
            "fingerprint": "sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
        },
    )
    assert heartbeat.status_code == 204, heartbeat.text

    # Und das Pairing-Secret ist KEIN gültiges Tunnel-Token für andere Wege:
    # falsche client_id (andere Instanz) muss weiter 401 liefern.
    wrong = await client.post(
        "/selfhost/directory/heartbeat",
        json={
            "instance_id": iid,
            "token": "falsch",
            "client_id": creds["client_id"],
            "candidates": [{"ip": "10.0.0.9", "port": 7900, "protocol": "udp"}],
            "fingerprint": "sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
        },
    )
    assert wrong.status_code == 401, wrong.text

    lookup = await client.get(
        f"/me/instances/{iid}/direct-endpoint", headers={"Cookie": bob_cookie}
    )
    assert lookup.status_code == 200, lookup.text
    assert lookup.json()["candidates"][0]["ip"] == "93.184.216.34"
