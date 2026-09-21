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
