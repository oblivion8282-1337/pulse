"""Tests für den Gruppen-Lesestand (Übergabe 05.10., „Haken wenn alle
gelesen"): Mitgliedsgate, Monotonie-Guard, Ereignis an alle Mitglieder."""

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
async def test_lesestand_monoton_und_ereignis_an_alle(
    client, _auth_signer, friend_pair, gruppen_an, captured_events
):
    uid_a = random.randint(1, 1_000_000)
    uid_b = random.randint(1, 1_000_000)
    t_a = _auth_signer.issue_access(uid_a, f"u{uid_a}")
    t_b = _auth_signer.issue_access(uid_b, f"u{uid_b}")
    await friend_pair(uid_a, uid_b)

    r = await client.post("/gruppen", json={"name": "Lese-Gruppe"}, headers=make_auth_header(t_a))
    gruppe_id = r.json()["id"]
    await client.post(
        f"/gruppen/{gruppe_id}/mitglieder",
        json={"user_id": str(uid_b)},
        headers=make_auth_header(t_a),
    )
    captured_events.clear()

    # Erster Stand — Ereignis an beide Mitglieder.
    r = await client.put(
        f"/gruppen/{gruppe_id}/lesestand",
        json={"last_read_message_id": 900000000000000100},
        headers=make_auth_header(t_b),
    )
    assert r.status_code == 204, r.text
    ereignisse = [(t, e) for (t, e) in captured_events if e.get("op") == "gruppe_lesestand"]
    assert {(t, e["user_id"], e["last_read_message_id"]) for (t, e) in ereignisse} == {
        (str(uid_a), str(uid_b), "900000000000000100"),
        (str(uid_b), str(uid_b), "900000000000000100"),
    }

    # Zurückrollen: der ältere Stand wird abgewiesen (Monotonie-Guard) und
    # erzeugt KEIN Ereignis mit dem alten Wert.
    captured_events.clear()
    r = await client.put(
        f"/gruppen/{gruppe_id}/lesestand",
        json={"last_read_message_id": 900000000000000050},
        headers=make_auth_header(t_b),
    )
    assert r.status_code == 204
    assert not [e for (_t, e) in captured_events if e.get("op") == "gruppe_lesestand" and e["last_read_message_id"] == "900000000000000050"]


@pytest.mark.asyncio
async def test_lesestand_nur_fuer_mitglieder(client, _auth_signer, friend_pair, gruppen_an):
    uid_a = random.randint(1, 1_000_000)
    t_a = _auth_signer.issue_access(uid_a, f"u{uid_a}")
    r = await client.post("/gruppen", json={"name": "Lese 2"}, headers=make_auth_header(t_a))
    gruppe_id = r.json()["id"]

    uid_fremd = random.randint(1, 1_000_000)
    t_fremd = _auth_signer.issue_access(uid_fremd, f"u{uid_fremd}")
    r = await client.put(
        f"/gruppen/{gruppe_id}/lesestand",
        json={"last_read_message_id": 5},
        headers=make_auth_header(t_fremd),
    )
    assert r.status_code == 404
