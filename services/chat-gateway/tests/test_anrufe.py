"""Tests für die Anruf-Routen (Anrufe-Epic A+B): Gates, Zustandsmaschine,
Signalisierung als user_events (Spy-Muster wie test_friend_ws_events)."""

from __future__ import annotations

import random

import pytest

from .conftest import make_auth_header

# DM routes are cloud-only — ensure cloud mode for all tests in this file.
pytestmark = pytest.mark.usefixtures("cloud_mode")


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


@pytest.fixture
def captured_events(app, monkeypatch):
    captured: list[tuple[str, dict]] = []
    mgr = app.state.connection_manager

    async def _cap(target_user_id, envelope):
        captured.append((str(target_user_id), dict(envelope)))

    monkeypatch.setattr(mgr, "publish_user_event", _cap)
    return captured


async def _dm_zwischen(client, _auth_signer, friend_pair, uid_a: int, uid_b: int) -> str:
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/dm-channels",
        json={"target_user_id": str(uid_b)},
        headers=make_auth_header(_auth_signer.issue_access(uid_a, f"u{uid_a}")),
    )
    assert r.status_code == 201
    return r.json()["id"]


@pytest.mark.asyncio
async def test_klingelt_geht_nur_an_den_partner(
    client, _auth_signer, friend_pair, captured_events
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    dm_id = await _dm_zwischen(client, _auth_signer, friend_pair, uid_a, uid_b)
    captured_events.clear()

    r = await client.post(
        "/anrufe",
        json={"art": "dm", "channel_id": dm_id},
        headers=make_auth_header(t_a),
    )
    assert r.status_code == 201
    call_id = r.json()["id"]

    # Nur bob klingelt — alice (Initiator) nicht, Fremde schon gar nicht.
    an_b = [(tid, e) for (tid, e) in captured_events if tid == str(uid_b)]
    assert [(tid, e["op"]) for (tid, e) in an_b] == [(str(uid_b), "call_klingelt")]
    assert an_b[0][1]["call_id"] == call_id
    assert an_b[0][1]["einleiter_id"] == str(uid_a)
    assert all(tid != str(uid_a) for tid, _ in captured_events)


@pytest.mark.asyncio
async def test_fremder_kann_nicht_klingeln(client, _auth_signer, friend_pair):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    dm_id = await _dm_zwischen(client, _auth_signer, friend_pair, uid_a, uid_b)
    t_fremd, _ = await _register(_auth_signer)

    r = await client.post(
        "/anrufe",
        json={"art": "dm", "channel_id": dm_id},
        headers=make_auth_header(t_fremd),
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_1zu1_laufzyklus_verpasst_und_abgelehnt(
    client, _auth_signer, friend_pair, captured_events
):
    """Zwei Durchläufe: kein Annehmen → verpasst; Ablehnen → abgelehnt."""
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    dm_id = await _dm_zwischen(client, _auth_signer, friend_pair, uid_a, uid_b)
    heads_a = make_auth_header(t_a)
    heads_b = make_auth_header(t_b)

    # Lauf 1: Initiator legt auf, ohne dass bob annahm → verpasst + Ende-Event.
    r = await client.post(
        "/anrufe", json={"art": "dm", "channel_id": dm_id}, headers=heads_a
    )
    call_id = r.json()["id"]
    captured_events.clear()
    r = await client.post(f"/anrufe/{call_id}/auflegen", headers=heads_a)
    assert r.status_code == 204
    ende = [e for (tid, e) in captured_events if e["op"] == "call_ende"]
    assert len(ende) == 2  # an beide Teilnehmer
    assert ende[0]["grund"] == "verpasst"

    # Nach dem Ende: annehmen schlägt fehl (Anruf ist vorbei).
    r = await client.post(f"/anrufe/{call_id}/annehmen", headers=heads_b)
    assert r.status_code == 409

    # Lauf 2: bob lehnt ausdrücklich ab → abgelehnt.
    captured_events.clear()
    r = await client.post(
        "/anrufe", json={"art": "dm", "channel_id": dm_id}, headers=heads_a
    )
    call_id = r.json()["id"]
    r = await client.post(f"/anrufe/{call_id}/ablehnen", headers=heads_b)
    assert r.status_code == 204
    ops = {e["op"] for (_tid, e) in captured_events}
    assert "call_abgelehnt" in ops
    assert "call_ende" in ops


@pytest.mark.asyncio
async def test_annahme_macht_laufend_und_auflegen_rechnet_dauer(
    client, _auth_signer, friend_pair, captured_events
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    dm_id = await _dm_zwischen(client, _auth_signer, friend_pair, uid_a, uid_b)
    heads_a = make_auth_header(t_a)
    heads_b = make_auth_header(t_b)

    r = await client.post(
        "/anrufe", json={"art": "dm", "channel_id": dm_id}, headers=heads_a
    )
    call_id = r.json()["id"]
    captured_events.clear()

    r = await client.post(f"/anrufe/{call_id}/annehmen", headers=heads_b)
    assert r.status_code == 204
    # Eine Kopie je Teilnehmer-Konto, aber inhaltlich nur BOBS Annahme.
    wer = {e["user_id"] for (_t, e) in captured_events if e["op"] == "call_angenommen"}
    assert wer == {str(uid_b)}

    captured_events.clear()
    r = await client.post(f"/anrufe/{call_id}/auflegen", headers=heads_a)
    assert r.status_code == 204
    ende = [e for (_t, e) in captured_events if e["op"] == "call_ende"]
    assert ende and ende[0]["grund"] == "aufgelegt"
    assert isinstance(ende[0]["dauer_sek"], int)


@pytest.mark.asyncio
async def test_mitgliedschaft_fuer_token_nur_fuer_teilnehmer(
    client, _auth_signer, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    dm_id = await _dm_zwischen(client, _auth_signer, friend_pair, uid_a, uid_b)

    r = await client.post(
        "/anrufe", json={"art": "dm", "channel_id": dm_id}, headers=make_auth_header(t_a)
    )
    call_id = r.json()["id"]

    r = await client.get(
        f"/anrufe/{call_id}/mitgliedschaft", headers=make_auth_header(t_a)
    )
    assert r.status_code == 200
    assert r.json()["room"] == f"call-{call_id}"

    t_fremd, _ = await _register(_auth_signer)
    r = await client.get(
        f"/anrufe/{call_id}/mitgliedschaft", headers=make_auth_header(t_fremd)
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_ablehnen_auf_laufendem_anruf_wird_abgewiesen(
    client, _auth_signer, friend_pair, captured_events
):
    """Befund 03.10. #1: das Zweitgerät des Angerufenen klingelt nach der
    Annahme weiter; sein 45-s-Wecker schickt „ablehnen“ — der laufende
    Anruf muss das überleben."""
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    dm_id = await _dm_zwischen(client, _auth_signer, friend_pair, uid_a, uid_b)
    heads_a = make_auth_header(t_a)
    heads_b = make_auth_header(t_b)

    r = await client.post(
        "/anrufe", json={"art": "dm", "channel_id": dm_id}, headers=heads_a
    )
    call_id = r.json()["id"]
    r = await client.post(f"/anrufe/{call_id}/annehmen", headers=heads_b)
    assert r.status_code == 204

    captured_events.clear()
    r = await client.post(f"/anrufe/{call_id}/ablehnen", headers=heads_b)
    assert r.status_code == 409
    assert not [e for (_t, e) in captured_events if e["op"] == "call_ende"]

    # Der Anruf läuft weiter: Auflegen des Initiators endet mit „aufgelegt“
    # (nicht „verpasst“) und Dauer ≥ 0.
    r = await client.post(f"/anrufe/{call_id}/auflegen", headers=heads_a)
    assert r.status_code == 204
    ende = [e for (_t, e) in captured_events if e["op"] == "call_ende"]
    assert ende and ende[0]["grund"] == "aufgelegt"


@pytest.mark.asyncio
async def test_doppel_annahme_publiziert_nur_einmal(
    client, _auth_signer, friend_pair, captured_events
):
    """Befund 03.10. #2: jeder /annehmen-Ruf publizierte erneut — das
    Doppel-Event war der Einstieg für die Doppel-Verbindung (Echo)."""
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    dm_id = await _dm_zwischen(client, _auth_signer, friend_pair, uid_a, uid_b)
    heads_b = make_auth_header(t_b)

    r = await client.post(
        "/anrufe", json={"art": "dm", "channel_id": dm_id}, headers=make_auth_header(t_a)
    )
    call_id = r.json()["id"]
    captured_events.clear()

    for _ in range(2):
        r = await client.post(f"/anrufe/{call_id}/annehmen", headers=heads_b)
        assert r.status_code == 204
    # Eine Kopie je Teilnehmer-Konto — auch nach zweiter Annahme nicht mehr.
    angenommene = [e for (_t, e) in captured_events if e["op"] == "call_angenommen"]
    assert len(angenommene) == 2


@pytest.mark.asyncio
async def test_gruppenanruf_ueberlebt_erstes_auflegen(
    client, _auth_signer, friend_pair, captured_events, _isolate_chat_settings
):
    """Befund 03.10. #3: beim Gruppenanruf beendet das erste Auflegen nur
    den eigenen Weg, nicht den Anruf für alle."""
    _isolate_chat_settings.private_groups_enabled = True
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)

    r = await client.post(
        "/gruppen", json={"name": "Anrufgruppe"}, headers=make_auth_header(t_a)
    )
    assert r.status_code == 201
    gid = r.json()["id"]
    r = await client.post(
        f"/gruppen/{gid}/mitglieder",
        json={"user_id": str(uid_b)},
        headers=make_auth_header(t_a),
    )
    assert r.status_code == 201

    heads_a = make_auth_header(t_a)
    heads_b = make_auth_header(t_b)

    r = await client.post(
        "/anrufe", json={"art": "gruppe", "channel_id": gid}, headers=heads_a
    )
    call_id = r.json()["id"]

    # Noch klingelnd: Auflegen des Initiators bricht den Ruf ab (verpasst).
    r = await client.post(f"/anrufe/{call_id}/auflegen", headers=heads_a)
    assert r.status_code == 204
    ende = [e for (_t, e) in captured_events if e["op"] == "call_ende"]
    assert ende and ende[0]["grund"] == "verpasst"

    # Zweiter Lauf: verbunden, dann legt b auf — der Anruf läuft für a weiter.
    r = await client.post(
        "/anrufe", json={"art": "gruppe", "channel_id": gid}, headers=heads_a
    )
    call_id = r.json()["id"]
    r = await client.post(f"/anrufe/{call_id}/annehmen", headers=heads_b)
    assert r.status_code == 204

    captured_events.clear()
    r = await client.post(f"/anrufe/{call_id}/auflegen", headers=heads_b)
    assert r.status_code == 204
    assert not [e for (_t, e) in captured_events if e["op"] == "call_ende"]


@pytest.mark.asyncio
async def test_anruf_start_ist_gedrosselt(client, _auth_signer, friend_pair):
    """Befund 03.10. #4: das Klingeln an eine ganze Gruppe ist ein
    Spam-Vektor — Regel „anruf_start“ bremst den sechsten Ruf je Minute."""
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    dm_id = await _dm_zwischen(client, _auth_signer, friend_pair, uid_a, uid_b)
    heads_a = make_auth_header(t_a)

    codes = []
    for i in range(7):
        r = await client.post(
            "/anrufe", json={"art": "dm", "channel_id": dm_id}, headers=heads_a
        )
        codes.append(r.status_code)
        if r.status_code == 201 and i < 6:
            # Anruf sofort beenden, damit nicht an der Zustandsmaschine
            # hängt — die Drossel zählt unabhängig davon.
            await client.post(
                f"/anrufe/{r.json()['id']}/auflegen", headers=heads_a
            )
    assert 429 in codes, f"keine Drossel nach 7 Rufen: {codes}"
    assert codes[0] == 201
