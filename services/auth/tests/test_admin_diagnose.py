"""Tests für den Admin-Lesezugriff auf Diagnose-Berichte (Spec 2026-09-21 §6).

Pattern mirrors test_admin_instances.py: register via HTTP, promote via
SQLAlchemy, login, exercise endpoints. Die Berichte selbst werden über den
ÖFFENTLICHEN POST /experimental-logs geseedet — derselbe Weg, den die Clients
fahren; so deckt der Test gleich mit ab, dass der Write-Pfad die neuen
Lesewege füttert.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance, UserInstanceMembership
from dcc_auth.snowflake import next_id


async def _register(client, *, username: str, email: str) -> str:
    r = await client.post(
        "/register",
        json={"username": username, "email": email, "password": "correct horse battery staple"},
    )
    assert r.status_code == 201, r.text
    return r.json()["access_token"]


async def _promote_admin(session_factory, username: str) -> None:
    async with session_factory() as s:
        user = (await s.execute(select(User).where(User.username == username))).scalar_one()
        user.is_admin = True
        await s.commit()


async def _login(client, *, username: str) -> str:
    r = await client.post(
        "/login",
        json={"email_or_username": username, "password": "correct horse battery staple"},
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


async def _seed(client, *, reason: str, role: str, channel_id: str | None = None) -> dict:
    r = await client.post(
        "/experimental-logs",
        json={
            "reason": reason,
            "role": role,
            "channel_id": channel_id,
            "system_info": {"user_agent": "test"},
            "report": {
                "kopf": {"app": "pulse-web"},
                "ereignisse": [{"s": 0.0, "art": "fetch_failed", "anzahl": 2}],
                "ereignisse_verworfen": 0,
                "abschluss": {"notiz": "Community anlegen ging nicht"},
            },
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


@pytest.mark.asyncio
async def test_liste_und_details(client, session_factory):
    await _register(client, username="viewer1", email="viewer1@example.com")
    geplant = await _seed(client, reason="user_report", role="app", channel_id="42")
    await _seed(client, reason="stream_end", role="viewer")

    await _promote_admin(session_factory, "viewer1")
    token = await _login(client, username="viewer1")
    headers = {"Authorization": f"Bearer {token}"}

    r = await client.get("/admin/experimental-logs", headers=headers)
    assert r.status_code == 200, r.text
    zeilen = r.json()
    assert len(zeilen) == 2
    # Neueste zuerst (Snowflake wächst) — der erste Eintrag ist der zuletzt
    # geseedete (stream_end), der user_report liegt darunter.
    assert zeilen[0]["reason"] == "stream_end"
    # Die Liste trägt KEINE schweren Spalten (report/log_text) — die sind Detail.
    assert "report" not in zeilen[0]
    assert "log_text" not in zeilen[0]

    r = await client.get(
        f"/admin/experimental-logs/{geplant['id']}", headers=headers
    )
    assert r.status_code == 200, r.text
    details = r.json()
    assert details["role"] == "app"
    assert details["channel_id"] == "42"
    assert details["report"]["abschluss"]["notiz"] == "Community anlegen ging nicht"


@pytest.mark.asyncio
async def test_filter_rolle(client, session_factory):
    await _register(client, username="viewer2", email="viewer2@example.com")
    await _seed(client, reason="user_report", role="app")
    await _seed(client, reason="stream_end", role="viewer")

    await _promote_admin(session_factory, "viewer2")
    token = await _login(client, username="viewer2")
    r = await client.get(
        "/admin/experimental-logs?role=app", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 200
    zeilen = r.json()
    assert len(zeilen) == 1
    assert zeilen[0]["role"] == "app"


@pytest.mark.asyncio
async def test_loeschen(client, session_factory):
    await _register(client, username="viewer3", email="viewer3@example.com")
    erster = await _seed(client, reason="error", role="app")

    await _promote_admin(session_factory, "viewer3")
    token = await _login(client, username="viewer3")
    headers = {"Authorization": f"Bearer {token}"}

    r = await client.delete(f"/admin/experimental-logs/{erster['id']}", headers=headers)
    assert r.status_code == 204
    r = await client.get(f"/admin/experimental-logs/{erster['id']}", headers=headers)
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_nicht_admin_wird_abgewiesen(client):
    # Der ERSTE registrierte Nutzer wird Bootstrap-Admin (routes.py::register)
    # — für einen echten Nicht-Admin braucht es also einen Wegwerf-Erstnutzer.
    await _register(client, username="bootstrap", email="bootstrap@example.com")
    await _register(client, username="normalo", email="normalo@example.com")
    await _seed(client, reason="user_report", role="app")
    token = await _login(client, username="normalo")
    r = await client.get(
        "/admin/experimental-logs", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 403
    r = await client.get(
        "/admin/experimental-logs/1", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_ohne_anmeldung_401(client):
    r = await client.get("/admin/experimental-logs")
    assert r.status_code == 401


# --- Server-Paket (Spec §7): POST /me/instance-diagnose ---------------------


async def _seed_instanz(session_factory, *, owner_id: int, hostname: str) -> int:
    """Instanz + Owner-Membership anlegen (ForeignKey braucht beide Zeilen)."""
    instanz_id = next_id()
    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=instanz_id,
                hostname=hostname,
                client_id=f"clid-{instanz_id}",
                client_secret="hash-nur-test",
                # Unique-Pflichtfelder: drei getrennte Snowflakes, damit keine
                # Kollision mit anderen Seed-Instanzen im Testlauf entsteht.
                worker_id_chat=next_id(),
                worker_id_voice=next_id(),
                worker_id_media=next_id(),
                status="active",
                registered_by=owner_id,
            )
        )
        s.add(
            UserInstanceMembership(
                user_id=owner_id, instance_id=instanz_id, role="owner"
            )
        )
        await s.commit()
    return instanz_id


async def _user_id(session_factory, username: str) -> int:
    from sqlalchemy import select as _select

    async with session_factory() as s:
        return (
            await s.execute(_select(User).where(User.username == username))
        ).scalar_one().id


@pytest.mark.asyncio
async def test_server_paket_owner_reicht_ein(client, session_factory):
    await _register(client, username="owner1", email="owner1@example.com")
    token = await _login(client, username="owner1")
    owner_id = await _user_id(session_factory, "owner1")
    instanz_id = await _seed_instanz(
        session_factory, owner_id=owner_id, hostname="pulse.example.de"
    )
    headers = {"Authorization": f"Bearer {token}"}

    r = await client.post(
        "/me/instance-diagnose",
        headers=headers,
        json={
            "instance_id": str(instanz_id),
            "paket": {
                "kopf": {"hostname": "pulse.example.de", "version": "0.8.0+abc"},
                "setup_status": ["1\t06-run-migrations\tok"],
                "backups": {"enabled": True, "anzahl": 7},
            },
        },
    )
    assert r.status_code == 201, r.text

    # Als Admin lesbar und als Server-Bericht mit Instanz-Kanal abgelegt.
    await _promote_admin(session_factory, "owner1")
    admin_token = await _login(client, username="owner1")
    r = await client.get(
        "/admin/experimental-logs?role=server",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 200
    zeilen = r.json()
    assert len(zeilen) == 1
    assert zeilen[0]["channel_id"] == str(instanz_id)
    details = await client.get(
        f"/admin/experimental-logs/{zeilen[0]['id']}",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    paket = details.json()["report"]
    assert paket["kopf"]["hostname"] == "pulse.example.de"
    assert paket["backups"]["anzahl"] == 7


@pytest.mark.asyncio
async def test_server_paket_nicht_owner_403(client, session_factory):
    # Bootstrap-Admin (erster Nutzer) darf; ein zweiter User ohne Membership
    # darf NICHT für die fremde Instanz einreichen.
    await _register(client, username="boss", email="boss@example.com")
    await _register(client, username="fremd", email="fremd@example.com")
    owner_id = await _user_id(session_factory, "boss")
    instanz_id = await _seed_instanz(
        session_factory, owner_id=owner_id, hostname="pulse.fremd.de"
    )
    token = await _login(client, username="fremd")
    r = await client.post(
        "/me/instance-diagnose",
        headers={"Authorization": f"Bearer {token}"},
        json={"instance_id": str(instanz_id), "paket": {"kopf": {}}},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_server_paket_zu_gross_422(client, session_factory):
    await _register(client, username="owner2", email="owner2@example.com")
    token = await _login(client, username="owner2")
    owner_id = await _user_id(session_factory, "owner2")
    instanz_id = await _seed_instanz(
        session_factory, owner_id=owner_id, hostname="pulse.big.de"
    )
    r = await client.post(
        "/me/instance-diagnose",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "instance_id": str(instanz_id),
            "paket": {"kopf": {}, "muell": "x" * (400_001)},
        },
    )
    assert r.status_code == 422
