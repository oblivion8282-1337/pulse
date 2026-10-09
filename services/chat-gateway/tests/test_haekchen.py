"""Häkchen-Treppe am Server (Migration 0101, ``haekchen.py``): der
Zustellstand kommt mit der Quittung, überlebt einen Neustart und erreicht nur
den Absender; der Lesebestätigungs-Schalter verbirgt DM-Lesestände in beide
Richtungen; Gruppen-Antworten tragen die Stände je Mitglied; Löschstellen
räumen mit."""

from __future__ import annotations

import base64
import random

import pytest
from sqlalchemy import select

from .conftest import make_auth_header
from .test_postfach import _abholen, _bundel_seeden_geraet, _dm_erstellen, _einliefern

pytestmark = pytest.mark.usefixtures("cloud_mode")

_DATEN = base64.b64encode(b"olm-umschlag").decode()


@pytest.fixture
def gruppen_an(_isolate_chat_settings):
    _isolate_chat_settings.private_groups_enabled = True
    return _isolate_chat_settings


@pytest.fixture
def ereignisse(app, monkeypatch):
    gesehen: list[tuple[str, dict]] = []

    async def _cap(target_user_id, envelope):
        gesehen.append((str(target_user_id), dict(envelope)))

    monkeypatch.setattr(app.state.connection_manager, "publish_user_event", _cap)
    return gesehen


def _konto(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _zugestellt_und_quittiert(
    client, session_factory, *, t_a, t_b, uid_a, uid_b, kanal, staende
) -> None:
    """A liefert eine Nachricht an B; B holt ab und quittiert mit ``staende``."""
    pub_b = await _bundel_seeden_geraet(session_factory, user_id=uid_b)
    r = await _einliefern(
        client, token=t_a, channel_id=kanal,
        nutzlasten=[{"art": 1, "daten": _DATEN, "empfaenger": [pub_b]}],
    )
    assert r.status_code == 200, r.text
    abgeholt = (await _abholen(client, token=t_b, pubkey=pub_b)).json()
    r = await client.post(
        "/postfach/quittung",
        json={
            "device_pubkey": pub_b,
            "zustellung_ids": [z["id"] for z in abgeholt],
            "zustellstaende": staende,
        },
        headers=make_auth_header(t_b),
    )
    assert r.status_code == 204, r.text


async def _dm_eintrag(client, token: str, dm_id: str) -> dict:
    r = await client.get("/dm-channels", headers=make_auth_header(token))
    assert r.status_code == 200
    return next(d for d in r.json() if d["id"] == dm_id)


@pytest.mark.asyncio
async def test_quittung_legt_zustellstand_ab_und_meldet_ihn_dem_absender(
    client, session_factory, _auth_signer, friend_pair, ereignisse
):
    t_a, uid_a = _konto(_auth_signer)
    t_b, uid_b = _konto(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, t_a, uid_b)

    stand = {"channel_id": dm_id, "absender_user_id": str(uid_a), "zugestellt_bis": "1760000000000000123"}
    await _zugestellt_und_quittiert(
        client, session_factory, t_a=t_a, t_b=t_b, uid_a=uid_a, uid_b=uid_b,
        kanal=dm_id, staende=[stand],
    )

    gemeldet = [(t, e) for t, e in ereignisse if e.get("op") == "zustellung_bestaetigt"]
    assert gemeldet == [
        (str(uid_a), {
            "op": "zustellung_bestaetigt", "channel_id": dm_id,
            "user_id": str(uid_b), "zugestellt_bis": "1760000000000000123",
        })
    ]
    # Dauerhaft: der Absender liest ihn nach einem Neustart aus der Liste.
    assert (await _dm_eintrag(client, t_a, dm_id))["partner_zugestellt_bis"] == "1760000000000000123"
    # Der Empfänger erfährt über seine EIGENEN Nachrichten nichts daraus.
    assert (await _dm_eintrag(client, t_b, dm_id))["partner_zugestellt_bis"] is None


@pytest.mark.asyncio
async def test_zustellstand_schiebt_nie_zurueck(
    client, session_factory, _auth_signer, friend_pair, ereignisse
):
    t_a, uid_a = _konto(_auth_signer)
    t_b, uid_b = _konto(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, t_a, uid_b)

    for bis in ("1760000000000000200", "1760000000000000100"):
        await _zugestellt_und_quittiert(
            client, session_factory, t_a=t_a, t_b=t_b, uid_a=uid_a, uid_b=uid_b, kanal=dm_id,
            staende=[{"channel_id": dm_id, "absender_user_id": str(uid_a), "zugestellt_bis": bis}],
        )

    assert (await _dm_eintrag(client, t_a, dm_id))["partner_zugestellt_bis"] == "1760000000000000200"
    # Das zweite Ereignis trägt den GELTENDEN Stand, nicht den veralteten.
    gemeldet = [e["zugestellt_bis"] for _t, e in ereignisse if e.get("op") == "zustellung_bestaetigt"]
    assert gemeldet == ["1760000000000000200", "1760000000000000200"]


@pytest.mark.asyncio
async def test_zustellstand_nur_fuer_tatsaechlich_quittierte_paare(
    client, session_factory, _auth_signer, friend_pair, ereignisse
):
    """Ein Klient kann sich keinen Stand ausdenken: weder in einem Kanal, aus
    dem er nichts quittiert hat, noch für einen Absender, der nichts schickte,
    noch für sich selbst."""
    t_a, uid_a = _konto(_auth_signer)
    t_b, uid_b = _konto(_auth_signer)
    t_c, uid_c = _konto(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await friend_pair(uid_c, uid_b)
    dm_ab = await _dm_erstellen(client, t_a, uid_b)
    dm_cb = await _dm_erstellen(client, t_c, uid_b)

    await _zugestellt_und_quittiert(
        client, session_factory, t_a=t_a, t_b=t_b, uid_a=uid_a, uid_b=uid_b, kanal=dm_ab,
        staende=[
            {"channel_id": dm_cb, "absender_user_id": str(uid_c), "zugestellt_bis": "1760000000000000001"},
            {"channel_id": dm_ab, "absender_user_id": str(uid_c), "zugestellt_bis": "1760000000000000002"},
            {"channel_id": dm_ab, "absender_user_id": str(uid_b), "zugestellt_bis": "1760000000000000003"},
        ],
    )

    assert not [e for _t, e in ereignisse if e.get("op") == "zustellung_bestaetigt"]
    assert (await _dm_eintrag(client, t_c, dm_cb))["partner_zugestellt_bis"] is None
    assert (await _dm_eintrag(client, t_a, dm_ab))["partner_zugestellt_bis"] is None


@pytest.mark.asyncio
async def test_lesebestaetigung_aus_verbirgt_den_lesestand_in_beide_richtungen(
    client, _auth_signer, friend_pair, ereignisse
):
    t_a, uid_a = _konto(_auth_signer)
    t_b, uid_b = _konto(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, t_a, uid_b)

    async def lesen(token: str, bis: str) -> None:
        r = await client.put(
            f"/dm-channels/{dm_id}/lesestand",
            json={"last_read_message_id": bis},
            headers=make_auth_header(token),
        )
        assert r.status_code == 204

    # B schaltet ab: sein Lesestand erreicht nur seine eigenen Geräte.
    r = await client.put(
        "/me/privacy", json={"lesebestaetigungen": False}, headers=make_auth_header(t_b)
    )
    assert r.json()["lesebestaetigungen"] is False
    await lesen(t_b, "1760000000000000500")
    empfaenger = {t for t, e in ereignisse if e.get("op") == "dm_lesestand"}
    assert empfaenger == {str(uid_b)}
    assert (await _dm_eintrag(client, t_a, dm_id))["partner_last_read_message_id"] is None
    assert (await _dm_eintrag(client, t_b, dm_id))["last_read_message_id"] == "1760000000000000500"

    # Umgekehrt: A liest bei eingeschaltetem eigenem Schalter — B hat
    # abgeschaltet und sieht deshalb auch A's Stand nicht (WhatsApp-Regel).
    ereignisse.clear()
    await lesen(t_a, "1760000000000000600")
    assert {t for t, e in ereignisse if e.get("op") == "dm_lesestand"} == {str(uid_a)}
    assert (await _dm_eintrag(client, t_b, dm_id))["partner_last_read_message_id"] is None

    # Wieder an: beide Stände sind sichtbar, das Ereignis geht an beide.
    await client.put("/me/privacy", json={"lesebestaetigungen": True}, headers=make_auth_header(t_b))
    ereignisse.clear()
    await lesen(t_b, "1760000000000000700")
    assert {t for t, e in ereignisse if e.get("op") == "dm_lesestand"} == {str(uid_a), str(uid_b)}
    assert (await _dm_eintrag(client, t_a, dm_id))["partner_last_read_message_id"] == "1760000000000000700"
    assert (await _dm_eintrag(client, t_b, dm_id))["partner_last_read_message_id"] == "1760000000000000600"


async def _gruppe_mit(client, t_a, uid_b) -> str:
    r = await client.post("/gruppen", json={"name": "Haken"}, headers=make_auth_header(t_a))
    gruppe_id = r.json()["id"]
    r = await client.post(
        f"/gruppen/{gruppe_id}/mitglieder", json={"user_id": str(uid_b)}, headers=make_auth_header(t_a)
    )
    assert r.status_code == 201, r.text
    return gruppe_id


def _mitglied(gruppen: list[dict], gruppe_id: str, uid: int) -> dict:
    gruppe = next(g for g in gruppen if g["id"] == gruppe_id)
    return next(m for m in gruppe["members"] if m["user_id"] == str(uid))


@pytest.mark.asyncio
async def test_gruppenliste_traegt_lese_und_zustellstand_je_mitglied(
    client, session_factory, _auth_signer, friend_pair, gruppen_an, ereignisse
):
    t_a, uid_a = _konto(_auth_signer)
    t_b, uid_b = _konto(_auth_signer)
    await friend_pair(uid_a, uid_b)
    gruppe_id = await _gruppe_mit(client, t_a, uid_b)

    await _zugestellt_und_quittiert(
        client, session_factory, t_a=t_a, t_b=t_b, uid_a=uid_a, uid_b=uid_b, kanal=gruppe_id,
        staende=[{"channel_id": gruppe_id, "absender_user_id": str(uid_a), "zugestellt_bis": "1760000000000000900"}],
    )
    r = await client.put(
        f"/gruppen/{gruppe_id}/lesestand",
        json={"last_read_message_id": "1760000000000000800"},
        headers=make_auth_header(t_b),
    )
    assert r.status_code == 204

    sicht_a = (await client.get("/gruppen", headers=make_auth_header(t_a))).json()
    b_aus_sicht_a = _mitglied(sicht_a, gruppe_id, uid_b)
    assert b_aus_sicht_a["gelesen_bis"] == "1760000000000000800"
    assert b_aus_sicht_a["zugestellt_bis"] == "1760000000000000900"

    # B sieht seinen eigenen Lesestand (Zähler auf seinen anderen Geräten),
    # aber keinen Zustellstand — der gilt nur für Nachrichten des Aufrufers.
    sicht_b = (await client.get(f"/gruppen/{gruppe_id}", headers=make_auth_header(t_b))).json()
    b_selbst = _mitglied([sicht_b], gruppe_id, uid_b)
    assert b_selbst["gelesen_bis"] == "1760000000000000800"
    assert b_selbst["zugestellt_bis"] is None


@pytest.mark.asyncio
async def test_austritt_und_kontoloeschung_raeumen_die_staende(
    client, session_factory, _auth_signer, friend_pair, gruppen_an, ereignisse
):
    from dcc_chat_gateway.haekchen import konto_loeschen
    from dcc_chat_gateway.models import GruppenLesestand, Zustellstand

    t_a, uid_a = _konto(_auth_signer)
    t_b, uid_b = _konto(_auth_signer)
    await friend_pair(uid_a, uid_b)
    gruppe_id = await _gruppe_mit(client, t_a, uid_b)
    dm_id = await _dm_erstellen(client, t_a, uid_b)
    for kanal in (gruppe_id, dm_id):
        await _zugestellt_und_quittiert(
            client, session_factory, t_a=t_a, t_b=t_b, uid_a=uid_a, uid_b=uid_b, kanal=kanal,
            staende=[{"channel_id": kanal, "absender_user_id": str(uid_a), "zugestellt_bis": "1760000000000000001"}],
        )
    await client.put(
        f"/gruppen/{gruppe_id}/lesestand",
        json={"last_read_message_id": "1760000000000000001"},
        headers=make_auth_header(t_b),
    )

    async def zeilen() -> tuple[set[int], int]:
        async with session_factory() as s:
            kanaele = set((await s.execute(
                select(Zustellstand.channel_id).where(Zustellstand.empfaenger_user_id == uid_b)
            )).scalars())
            lese = len((await s.execute(
                select(GruppenLesestand).where(GruppenLesestand.user_id == uid_b)
            )).scalars().all())
        return kanaele, lese

    assert await zeilen() == ({int(gruppe_id), int(dm_id)}, 1)

    r = await client.post(f"/gruppen/{gruppe_id}/verlassen", headers=make_auth_header(t_b))
    assert r.status_code == 200, r.text
    assert await zeilen() == ({int(dm_id)}, 0)

    async with session_factory() as s:
        await konto_loeschen(s, uid_b)
        await s.commit()
    assert await zeilen() == (set(), 0)
