"""Verschluesselter Kanal mit Bestand bei Pulse (Entscheidung 2026-09-03).

Derselbe Weg wie beim Nextcloud-Ordner (``test_postfach_ablage_ordner.py``),
nur ohne fremde Cloud: der Server markiert den ERSTEN Umschlag eines Inhalts
mit ``archiv``, und diese Zeile ist danach der Kanalverlauf. Geprueft wird
deshalb vor allem, wer sie NICHT mehr loeschen darf — Quittung,
verwaist-Sweep und Kontoloeschung gehen an ihr vorbei, der Kanal nimmt sie
mit.

Helfer bewusst aus ``test_postfach_ablage_ordner.py`` kopiert statt
importiert: Testmodule laufen unter ``--import-mode=importlib`` und sind
untereinander nicht verlaesslich importierbar (dieselbe Begruendung wie
dort).
"""

from __future__ import annotations

import base64
import itertools
import random
from datetime import UTC, datetime

import pytest
from dcc_chat_gateway.models import (
    AblageKanalNachtrag,
    AblageKanalOrdner,
    Channel,
    DmNutzlast,
    Guild,
    GuildMember,
    Role,
)
from dcc_chat_gateway.permissions import Permissions
from dcc_chat_gateway.postfach_pflege import sweep_verwaiste_nutzlasten
from dcc_chat_gateway.routes import postfach as postfach_mod
from dcc_chat_gateway.snowflake import next_id
from dcc_chat_gateway.user_purge_postfach import purge_postfach
from sqlalchemy import select

pytestmark = pytest.mark.usefixtures("cloud_mode")

_geraete_zaehler = itertools.count()


def _make_device() -> str:
    return f"pulsegeraet-{next(_geraete_zaehler):030d}"


def _b64_unpadded(data: bytes) -> str:
    return base64.b64encode(data).rstrip(b"=").decode()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _dm_erstellen(client, token_a: str, uid_b: int) -> str:
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=_auth(token_a)
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _sendegeraet(client, token: str) -> str:
    pubkey = _make_device()
    r = await client.put(
        "/keys/bundle",
        json={"device_pubkey": pubkey, "curve25519": "curve-" + pubkey},
        headers=_auth(token),
    )
    assert r.status_code == 204, r.text
    return pubkey


async def _bundel_seeden(session_factory, *, user_id: int) -> str:
    from dcc_chat_gateway.models import DeviceKeyBundle

    pubkey = _make_device()
    async with session_factory() as s:
        s.add(
            DeviceKeyBundle(
                id=next_id(),
                user_id=user_id,
                device_pubkey=pubkey,
                curve25519="curve-" + pubkey,
            )
        )
        await s.commit()
    return pubkey


async def _pulse_ordner_eintragen(session_factory, *, channel_id, ersteller_id: int) -> None:
    """Nur die Ordner-Zeile, KEIN Konto-Laufwerk — genau das ist der Punkt
    des Pulse-Speichers."""
    async with session_factory() as s:
        s.add(
            AblageKanalOrdner(
                channel_id=int(channel_id), ersteller_id=ersteller_id, speicher="pulse"
            )
        )
        await s.commit()


async def _aufbau(client, session_factory, _auth_signer, friend_pair):
    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    pub_b = await _bundel_seeden(session_factory, user_id=uid_b)
    await _pulse_ordner_eintragen(session_factory, channel_id=dm_id, ersteller_id=uid_a)
    return token_a, uid_a, token_b, uid_b, dm_id, pub_b


async def _einliefern(client, *, token: str, channel_id, empfaenger, daten: bytes = b"olm"):
    return await client.post(
        "/postfach",
        json={
            "channel_id": str(channel_id),
            "device_pubkey": await _sendegeraet(client, token),
            "nutzlasten": [
                {
                    "art": 1,
                    "daten": _b64_unpadded(daten),
                    "empfaenger": empfaenger,
                    "archiv": True,
                }
            ],
        },
        headers=_auth(token),
    )


async def _archiv_zeilen(session_factory, channel_id) -> list[DmNutzlast]:
    async with session_factory() as s:
        return list(
            (
                await s.execute(
                    select(DmNutzlast).where(
                        DmNutzlast.channel_id == int(channel_id),
                        DmNutzlast.archiv.is_(True),
                    )
                )
            ).scalars()
        )


async def _abholen_und_quittieren(client, *, token: str, geraet: str) -> None:
    offen = await client.post(
        "/postfach/abholen", json={"device_pubkey": geraet}, headers=_auth(token)
    )
    assert offen.status_code == 200, offen.text
    quittung = await client.post(
        "/postfach/quittung",
        json={"device_pubkey": geraet, "zustellung_ids": [z["id"] for z in offen.json()]},
        headers=_auth(token),
    )
    assert quittung.status_code == 204, quittung.text


# ---------------------------------------------------------------------------
# Einliefern
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_einliefern_setzt_archiv_und_ruft_keinen_hintergrundlauf(
    client, session_factory, _auth_signer, friend_pair, monkeypatch
):
    """Der Bestand steht mit dem Commit — es gibt nichts nachzureichen, also
    laeuft weder eine Hintergrundaufgabe noch entsteht ein Marker."""
    gerufen: list[list[int]] = []

    async def _nichts_tun(nutzlast_ids, *, ableger):
        gerufen.append(list(nutzlast_ids))

    monkeypatch.setattr(postfach_mod, "festigung_nachlaufen", _nichts_tun)
    token_a, _uid_a, _tb, _uid_b, dm_id, pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )

    r = await _einliefern(client, token=token_a, channel_id=dm_id, empfaenger=[pub_b])

    assert r.status_code == 200, r.text
    zeilen = await _archiv_zeilen(session_factory, dm_id)
    assert len(zeilen) == 1
    assert gerufen == []
    async with session_factory() as s:
        assert await s.get(AblageKanalNachtrag, zeilen[0].id) is None


@pytest.mark.asyncio
async def test_zwei_bloecke_mit_gleichem_inhalt_ergeben_eine_archiv_zeile(
    client, session_factory, _auth_signer, friend_pair
):
    """Dieselbe Dedup wie im Nextcloud-Weg (ueber ``sha256(daten)``): der
    Klient markiert ALLE Empfaenger-Bloecke, im Verlauf steht die Nachricht
    trotzdem einmal."""
    token_a, _uid_a, _tb, uid_b, dm_id, pub_b1 = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )
    pub_b2 = await _bundel_seeden(session_factory, user_id=uid_b)
    daten = _b64_unpadded(b"olm")

    r = await client.post(
        "/postfach",
        json={
            "channel_id": str(dm_id),
            "device_pubkey": await _sendegeraet(client, token_a),
            "nutzlasten": [
                {"art": 1, "daten": daten, "empfaenger": [pub_b1], "archiv": True},
                {"art": 1, "daten": daten, "empfaenger": [pub_b2], "archiv": True},
            ],
        },
        headers=_auth(token_a),
    )

    assert r.status_code == 200, r.text
    assert r.json()["zustellungen_angelegt"] == 2
    assert len(await _archiv_zeilen(session_factory, dm_id)) == 1


@pytest.mark.asyncio
async def test_archiv_nutzlast_ohne_empfaengergeraet_entsteht_trotzdem(
    client, session_factory, _auth_signer, friend_pair
):
    """Ein Kanal, in dem gerade kein Empfaengergeraet erreichbar ist, hat
    trotzdem einen Verlauf — genau er ist der Zweck des Kanals."""
    token_a, _uid_a, _tb, _uid_b, dm_id, _pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )

    r = await _einliefern(
        client, token=token_a, channel_id=dm_id, empfaenger=[_make_device()]
    )

    assert r.status_code == 200, r.text
    assert r.json()["zustellungen_angelegt"] == 0
    assert r.json()["verworfene_nutzlasten"] == 0
    assert len(await _archiv_zeilen(session_factory, dm_id)) == 1


# ---------------------------------------------------------------------------
# Die drei Loescher gehen an der Archiv-Zeile vorbei
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_quittung_sweep_und_kontoloeschung_lassen_die_archiv_zeile_stehen(
    client, session_factory, _auth_signer, friend_pair
):
    """Die drei Wege, auf denen eine Postfach-Nutzlast sonst verschwindet.
    Bliebe einer davon scharf, waere der Kanalverlauf weg, sobald das letzte
    anwesende Geraet abgeholt hat."""
    token_a, uid_a, token_b, _uid_b, dm_id, pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )
    r = await _einliefern(client, token=token_a, channel_id=dm_id, empfaenger=[pub_b])
    assert r.status_code == 200, r.text
    nutzlast_id = (await _archiv_zeilen(session_factory, dm_id))[0].id

    await _abholen_und_quittieren(client, token=token_b, geraet=pub_b)
    async with session_factory() as s:
        assert await s.get(DmNutzlast, nutzlast_id) is not None

    async with session_factory() as s:
        await sweep_verwaiste_nutzlasten(s)
    async with session_factory() as s:
        assert await s.get(DmNutzlast, nutzlast_id) is not None

    async with session_factory() as s:
        await purge_postfach(s, uid_a)
        await s.commit()
    async with session_factory() as s:
        assert await s.get(DmNutzlast, nutzlast_id) is not None


# ---------------------------------------------------------------------------
# Kanal anlegen und loeschen
# ---------------------------------------------------------------------------


async def _guild_mit_ablage_kanal(client, token: str) -> tuple[str, str]:
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    c = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "verschluesselt", "ablage": True},
            headers=_auth(token),
        )
    ).json()
    return g["id"], c["id"]


@pytest.mark.asyncio
async def test_kanal_mit_ablage_bekommt_die_ordner_zeile_beim_anlegen(
    client, session_factory, _auth_signer
):
    token, uid = await _register(_auth_signer)

    _gid, cid = await _guild_mit_ablage_kanal(client, token)

    async with session_factory() as s:
        zeile = await s.get(AblageKanalOrdner, int(cid))
    assert zeile is not None
    assert (zeile.ersteller_id, zeile.speicher) == (uid, "pulse")


@pytest.mark.asyncio
async def test_kanal_ohne_ablage_bekommt_keine_ordner_zeile(
    client, session_factory, _auth_signer
):
    token, _uid = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    c = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "klartext"}, headers=_auth(token)
        )
    ).json()

    async with session_factory() as s:
        assert await s.get(AblageKanalOrdner, int(c["id"])) is None


async def _guild_kanal_mit_archiv_zeile(session_factory, *, owner_id: int) -> tuple[int, int]:
    """Kanal direkt ueber die Modelle, mit einer Archiv-Nutzlast darin — der
    Weg ueber die Routen braeuchte fuer das Einliefern Geraetebuendel und
    Rechte, gemeint ist hier aber nur das Loeschen."""
    gid, cid, nid = next_id(), next_id(), next_id()
    async with session_factory() as s:
        s.add(Guild(id=gid, name="g", owner_id=owner_id))
        await s.flush()
        s.add(
            Role(
                id=next_id(),
                guild_id=gid,
                name="@everyone",
                permissions=int(Permissions.VIEW_CHANNEL | Permissions.MANAGE_CHANNELS),
                position=0,
                is_everyone=True,
            )
        )
        s.add(Channel(id=cid, guild_id=gid, name="k", type=0, ablage=True))
        s.add(GuildMember(guild_id=gid, user_id=owner_id, joined_at=datetime.now(UTC)))
        await s.flush()
        s.add(AblageKanalOrdner(channel_id=cid, ersteller_id=owner_id, speicher="pulse"))
        s.add(
            DmNutzlast(
                id=nid,
                channel_id=cid,
                absender_device_pubkey=_make_device(),
                absender_user_id=owner_id,
                art=1,
                daten=_b64_unpadded(b"olm"),
                groesse=3,
                archiv=True,
            )
        )
        await s.commit()
    return cid, nid


@pytest.mark.asyncio
async def test_kanal_loeschen_raeumt_die_archiv_zeilen(client, session_factory, _auth_signer):
    """Die Archiv-Zeile faellt NUR mit ihrem Kanal — und ``channel_id``
    traegt keinen Fremdschluessel, es gibt also keine Kaskade, die das
    taete."""
    token, uid = await _register(_auth_signer)
    cid, nid = await _guild_kanal_mit_archiv_zeile(session_factory, owner_id=uid)

    antwort = await client.delete(f"/channels/{cid}", headers=_auth(token))

    assert antwort.status_code == 204, antwort.text
    async with session_factory() as s:
        assert await s.get(DmNutzlast, nid) is None
