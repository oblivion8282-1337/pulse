"""Selbstbedienungs-Registrierung (Heim-Server, Entscheidung 2026-09-27).

``POST /me/instances``: eingeloggt genügt — keine Antrag+Freischalt-Strecke
mehr. Deckt ab: Happy Path (201, einmaliges Klartext-Secret, Hash in der DB,
Owner-Membership, ``self_host_enabled`` gesetzt), das 1-Pro-Konto-Limit (409)
und den Cookie-Zwang.
"""

from __future__ import annotations

import secrets

import pytest

from sqlalchemy import select, update

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
