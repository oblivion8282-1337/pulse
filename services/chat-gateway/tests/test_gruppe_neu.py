"""Tests für das `gruppe_neu`-Ereignis (Befund 05.10.): Anlegen und
Mitglieder-Hinzufügen wecken alle Mitglieder-Klienten, damit sie die
Gruppe abonnieren — sonst keine Benachrichtigung, keine Live-Nachricht."""

from __future__ import annotations

import random

import pytest

from .conftest import make_auth_header

pytestmark = pytest.mark.usefixtures("cloud_mode")


@pytest.fixture
def gruppen_an(_isolate_chat_settings):
    _isolate_chat_settings.private_groups_enabled = True
    return _isolate_chat_settings


@pytest.fixture
def captured_events(app, monkeypatch):
    captured: list[tuple[str, dict]] = []
    mgr = app.state.connection_manager

    async def _cap(target_user_id, envelope):
        captured.append((str(target_user_id), dict(envelope)))

    monkeypatch.setattr(mgr, "publish_user_event", _cap)
    return captured


@pytest.mark.asyncio
async def test_erstellen_weckt_ersteller(client, _auth_signer, gruppen_an, captured_events):
    uid = random.randint(1, 1_000_000)
    token = _auth_signer.issue_access(uid, f"u{uid}")
    r = await client.post(
        "/gruppen", json={"name": "Wecker-Gruppe"}, headers=make_auth_header(token)
    )
    assert r.status_code == 201, r.text
    gruppe_id = r.json()["id"]
    ereignisse = [(t, e) for (t, e) in captured_events if e.get("op") == "gruppe_neu"]
    assert ereignisse == [(str(uid), {"op": "gruppe_neu", "gruppe_id": str(gruppe_id)})]


@pytest.mark.asyncio
async def test_mitglied_hinzufuegen_weckt_alle(
    client, _auth_signer, friend_pair, gruppen_an, captured_events
):
    uid_a = random.randint(1, 1_000_000)
    uid_b = random.randint(1, 1_000_000)
    t_a = _auth_signer.issue_access(uid_a, f"u{uid_a}")
    t_b = _auth_signer.issue_access(uid_b, f"u{uid_b}")
    await friend_pair(uid_a, uid_b)

    r = await client.post("/gruppen", json={"name": "Wecker 2"}, headers=make_auth_header(t_a))
    gruppe_id = r.json()["id"]
    captured_events.clear()

    r = await client.post(
        f"/gruppen/{gruppe_id}/mitglieder",
        json={"user_id": str(uid_b)},
        headers=make_auth_header(t_a),
    )
    assert r.status_code == 201, r.text
    ereignisse = {t for (t, e) in captured_events if e.get("op") == "gruppe_neu"}
    assert ereignisse == {str(uid_a), str(uid_b)}
