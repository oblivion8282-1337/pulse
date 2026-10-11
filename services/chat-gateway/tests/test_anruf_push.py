"""Wann klingelt wessen Telefon — und wem ein Abbruch geschickt wird.

Der Kern ist Apples Regel: jeder VoIP-Push verpflichtet die App, einen Anruf
an CallKit zu melden, sonst beendet iOS sie und stellt die VoIP-Pushes
irgendwann ganz ab. Ein Abbruch an ein Gerät, das nie geklingelt hat oder auf
dem der Anruf schon zu ist, ist deshalb kein überzähliger, harmloser Push,
sondern der gefährlichste überhaupt (Bughunt 2026-10-11, K3). Die Tests hier
fahren die Routen durch und schreiben mit, was an Apple ginge — ohne Apple.
"""

from __future__ import annotations

import random

import pytest
from dcc_chat_gateway import anruf_push, apns_voip
from dcc_chat_gateway.anruf_push import Geraet, auswaehlen
from dcc_chat_gateway.models import Friendship, UserBlock, VoipToken
from sqlalchemy import delete, select

from .conftest import make_auth_header

pytestmark = pytest.mark.usefixtures("cloud_mode")


# MARK: - Die reine Auswahl


def _g(uid: int, gid: str) -> Geraet:
    return Geraet(user_id=uid, geraet_id=gid, token=f"tok-{uid}-{gid}")


def test_auswahl_ohne_einschraenkung_nimmt_alle():
    alle = [_g(1, "a"), _g(2, "b")]
    assert auswaehlen(alle) == alle


def test_auswahl_laesst_das_handelnde_geraet_aus():
    """Dort ist der Anruf schon zu — ein Push dorthin fände keinen Anruf."""
    alle = [_g(1, "a"), _g(1, "b"), _g(2, "c")]
    assert auswaehlen(alle, ausser=(1, "a")) == [_g(1, "b"), _g(2, "c")]


def test_auswahl_im_gruppenanruf_nur_die_eigenen_geraete():
    """Nimmt ein Mitglied an, hören nur SEINE anderen Geräte auf zu klingeln —
    die übrigen Mitglieder dürfen weiter beitreten."""
    alle = [_g(1, "a"), _g(1, "b"), _g(2, "c")]
    assert auswaehlen(alle, nur_konten={1}, ausser=(1, "a")) == [_g(1, "b")]


# MARK: - Durch die Routen


@pytest.fixture
def apple(monkeypatch):
    """Ein Zugang, der nie benutzt wird, und eine Mitschrift statt Apple."""
    gesendet: list[tuple[str, str]] = []

    async def _senden(*, zugang, geraete_token, nutzlast):
        gesendet.append((geraete_token, nutzlast["art"]))
        return "ok"

    monkeypatch.setattr(apns_voip, "zugang_aus_einstellungen", lambda _e: object())
    monkeypatch.setattr(apns_voip, "senden", _senden)
    return gesendet


def _konto(_auth_signer) -> tuple[dict, int]:
    uid = random.randint(1, 1_000_000_000)
    return make_auth_header(_auth_signer.issue_access(uid, f"u{uid}")), uid


async def _iphone(client, heads: dict, uid: int, gid: str) -> str:
    token = f"tok-{uid}-{gid}"
    r = await client.post("/voip/token", json={"token": token, "geraet_id": gid}, headers=heads)
    assert r.status_code == 204
    return token


async def _dm(client, friend_pair, heads_a, uid_a, uid_b) -> str:
    await friend_pair(uid_a, uid_b)
    r = await client.post("/dm-channels", json={"target_user_id": str(uid_b)}, headers=heads_a)
    assert r.status_code == 201
    return r.json()["id"]


async def _anrufen(client, heads: dict, art: str, channel_id: str) -> str:
    r = await client.post("/anrufe", json={"art": art, "channel_id": channel_id}, headers=heads)
    assert r.status_code == 201
    return r.json()["id"]


async def _gesendet(apple) -> list[tuple[str, str]]:
    await anruf_push.hintergrund_abwarten()
    kopie = sorted(apple)
    apple.clear()
    return kopie


@pytest.mark.asyncio
async def test_klingeln_geht_an_jedes_iphone_der_gerufenen_aber_nie_an_den_anrufer(
    client, _auth_signer, friend_pair, apple
):
    """Ohne Frische-Prüfung (T14): auch ein Telefon, dessen WebSocket eben
    noch etwas sagte, bekommt den Push — sein JS kann schon eingefroren sein."""
    heads_a, uid_a = _konto(_auth_signer)
    heads_b, uid_b = _konto(_auth_signer)
    await _iphone(client, heads_a, uid_a, "a1")
    b1 = await _iphone(client, heads_b, uid_b, "b1")
    b2 = await _iphone(client, heads_b, uid_b, "b2")
    dm = await _dm(client, friend_pair, heads_a, uid_a, uid_b)

    await _anrufen(client, heads_a, "dm", dm)
    assert await _gesendet(apple) == sorted([(b1, "klingelt"), (b2, "klingelt")])


@pytest.mark.asyncio
async def test_annahme_beendet_das_klingeln_der_uebrigen_und_das_ende_schickt_nichts_mehr(
    client, _auth_signer, friend_pair, apple
):
    """K3 + T4: nach der Annahme hört das Zweit-iPhone auf zu klingeln; das
    annehmende Gerät bekommt NIE einen Abbruch, auch nicht am Gesprächsende —
    dort ist der Anruf über die WebSocket längst zu, ein Push fände nichts."""
    heads_a, uid_a = _konto(_auth_signer)
    heads_b, uid_b = _konto(_auth_signer)
    await _iphone(client, heads_b, uid_b, "b1")
    b2 = await _iphone(client, heads_b, uid_b, "b2")
    dm = await _dm(client, friend_pair, heads_a, uid_a, uid_b)
    call_id = await _anrufen(client, heads_a, "dm", dm)
    await _gesendet(apple)

    r = await client.post(f"/anrufe/{call_id}/annehmen", json={"geraet_id": "b1"}, headers=heads_b)
    assert r.status_code == 204
    assert await _gesendet(apple) == [(b2, "abbruch")]

    r = await client.post(f"/anrufe/{call_id}/auflegen", headers=heads_a)
    assert r.status_code == 204
    assert await _gesendet(apple) == []


@pytest.mark.asyncio
async def test_ablehnen_schickt_den_abbruch_nicht_an_das_ablehnende_geraet(
    client, _auth_signer, friend_pair, apple
):
    heads_a, uid_a = _konto(_auth_signer)
    heads_b, uid_b = _konto(_auth_signer)
    await _iphone(client, heads_b, uid_b, "b1")
    b2 = await _iphone(client, heads_b, uid_b, "b2")
    dm = await _dm(client, friend_pair, heads_a, uid_a, uid_b)
    call_id = await _anrufen(client, heads_a, "dm", dm)
    await _gesendet(apple)

    r = await client.post(f"/anrufe/{call_id}/ablehnen", json={"geraet_id": "b1"}, headers=heads_b)
    assert r.status_code == 204
    assert await _gesendet(apple) == [(b2, "abbruch")]


@pytest.mark.asyncio
async def test_auflegen_vor_der_annahme_bricht_jedes_geklingelte_geraet_genau_einmal_ab(
    client, _auth_signer, friend_pair, apple
):
    """Der Anrufer hat nie geklingelt und bekommt deshalb auch keinen Abbruch —
    bis zum 2026-10-11 ging der an ALLE Teilnehmer (K3)."""
    heads_a, uid_a = _konto(_auth_signer)
    heads_b, uid_b = _konto(_auth_signer)
    await _iphone(client, heads_a, uid_a, "a1")
    b1 = await _iphone(client, heads_b, uid_b, "b1")
    dm = await _dm(client, friend_pair, heads_a, uid_a, uid_b)
    call_id = await _anrufen(client, heads_a, "dm", dm)
    await _gesendet(apple)

    r = await client.post(f"/anrufe/{call_id}/auflegen", json={"geraet_id": "a1"}, headers=heads_a)
    assert r.status_code == 204
    assert await _gesendet(apple) == [(b1, "abbruch")]
    # Ein zweites Ende (doppelter Klick) schickt nichts mehr hinterher.
    await client.post(f"/anrufe/{call_id}/auflegen", headers=heads_a)
    assert await _gesendet(apple) == []


@pytest.mark.asyncio
async def test_gruppe_annahme_laesst_die_anderen_mitglieder_weiter_klingeln_und_ablehnen_geht_noch(
    client, _auth_signer, apple, _isolate_chat_settings
):
    """T4: nach der ersten Annahme klingeln die übrigen Mitglieder weiter — und
    dürfen ablehnen, ohne ein 409 zu bekommen. Bis zum 2026-10-11 gab es für
    sie keinen Weg mehr aus dem Klingeln."""
    _isolate_chat_settings.private_groups_enabled = True
    heads_a, _ = _konto(_auth_signer)
    heads_b, uid_b = _konto(_auth_signer)
    heads_c, uid_c = _konto(_auth_signer)
    gid = (await client.post("/gruppen", json={"name": "G"}, headers=heads_a)).json()["id"]
    for uid in (uid_b, uid_c):
        r = await client.post(
            f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid)}, headers=heads_a
        )
        assert r.status_code == 201
    await _iphone(client, heads_b, uid_b, "b1")
    b2 = await _iphone(client, heads_b, uid_b, "b2")
    await _iphone(client, heads_c, uid_c, "c1")
    c2 = await _iphone(client, heads_c, uid_c, "c2")
    call_id = await _anrufen(client, heads_a, "gruppe", gid)
    await _gesendet(apple)

    r = await client.post(f"/anrufe/{call_id}/annehmen", json={"geraet_id": "b1"}, headers=heads_b)
    assert r.status_code == 204
    assert await _gesendet(apple) == [(b2, "abbruch")]

    r = await client.post(f"/anrufe/{call_id}/ablehnen", json={"geraet_id": "c1"}, headers=heads_c)
    assert r.status_code == 204
    assert await _gesendet(apple) == [(c2, "abbruch")]


@pytest.mark.asyncio
async def test_ohne_apns_schluessel_passiert_nichts_und_nichts_fliegt(
    client, _auth_signer, friend_pair
):
    """Fail-open ist die Zusage: eine Installation ohne APNs-Schlüssel ruft
    weiter über die WebSocket, und zwar ohne Ausnahme im Anruf-Pfad."""
    heads_a, uid_a = _konto(_auth_signer)
    heads_b, uid_b = _konto(_auth_signer)
    await _iphone(client, heads_b, uid_b, "b1")
    dm = await _dm(client, friend_pair, heads_a, uid_a, uid_b)
    call_id = await _anrufen(client, heads_a, "dm", dm)
    r = await client.post(f"/anrufe/{call_id}/auflegen", headers=heads_a)
    assert r.status_code == 204


# MARK: - Wer überhaupt anrufen darf (T3)


@pytest.mark.asyncio
async def test_blockierter_kontakt_laesst_nicht_klingeln(
    client, _auth_signer, friend_pair, session_factory, apple
):
    heads_a, uid_a = _konto(_auth_signer)
    heads_b, uid_b = _konto(_auth_signer)
    await _iphone(client, heads_b, uid_b, "b1")
    dm = await _dm(client, friend_pair, heads_a, uid_a, uid_b)
    async with session_factory() as s:
        s.add(UserBlock(blocker_id=uid_b, blocked_id=uid_a))
        await s.commit()

    r = await client.post("/anrufe", json={"art": "dm", "channel_id": dm}, headers=heads_a)
    assert r.status_code == 403
    assert r.json()["detail"] == "blocked"
    assert await _gesendet(apple) == []


@pytest.mark.asyncio
async def test_entfreundeter_kontakt_laesst_nicht_klingeln(
    client, _auth_signer, friend_pair, session_factory, apple
):
    heads_a, uid_a = _konto(_auth_signer)
    heads_b, uid_b = _konto(_auth_signer)
    await _iphone(client, heads_b, uid_b, "b1")
    dm = await _dm(client, friend_pair, heads_a, uid_a, uid_b)
    async with session_factory() as s:
        await s.execute(delete(Friendship))
        await s.commit()

    r = await client.post("/anrufe", json={"art": "dm", "channel_id": dm}, headers=heads_a)
    assert r.status_code == 403
    assert r.json()["detail"] == "not_friends"
    assert await _gesendet(apple) == []


# MARK: - Gerätetoken


@pytest.mark.asyncio
async def test_neue_geraete_kennung_mit_altem_token_ist_kein_dauerhaftes_409(
    client, _auth_signer, session_factory
):
    """Die Kennung lebt im `localStorage` der WebView, der Token beim System:
    nach dem Löschen der Website-Daten kommt derselbe Token mit neuer Kennung.
    Bis zum 2026-10-11 war das ein 409, bei jedem Start, für immer."""
    heads, uid = _konto(_auth_signer)
    for geraet_id in ("alt", "neu"):
        r = await client.post(
            "/voip/token", json={"token": "gleich", "geraet_id": geraet_id}, headers=heads
        )
        assert r.status_code == 204
    async with session_factory() as s:
        treffer = await s.execute(select(VoipToken).where(VoipToken.user_id == uid))
        zeilen = treffer.scalars().all()
    assert [(z.geraet_id, z.token) for z in zeilen] == [("neu", "gleich")]
