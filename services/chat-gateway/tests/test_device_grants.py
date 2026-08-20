"""Tests für die Freigabeliste eines Standplatz-Geräts — lesen und ersetzen.

Die Liste sagt, WER einen Rechner ohne Rückfrage übernehmen darf. Sie lag bis
2026-08-20 auf dem Gerät selbst und war damit nur vor Ort änderbar; Entwurf:
``docs/superpowers/specs/2026-08-20-geraeteverwaltung-design.md``.
"""

from __future__ import annotations

import uuid

import pytest
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, SUBJECT_EVERYONE, DeviceGrant
from dcc_shared.permissions import Permissions


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _make_token(signer) -> tuple[str, int]:
    uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    return signer.issue_access(uid, f"u{uid}"), uid


async def _guild(client, token: str, name: str = "werkstatt") -> int:
    r = await client.post("/guilds", json={"name": name}, headers=_auth(token))
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _voice_channel(client, token: str, guild_id: int, name: str = "werkbank") -> int:
    r = await client.post(
        f"/guilds/{guild_id}/channels",
        json={"name": name, "type": CHANNEL_TYPE_VOICE},
        headers=_auth(token),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _mitglied(client, owner_token: str, gid: int, _auth_signer) -> tuple[str, int]:
    """Ein zweites Mitglied der Community — via Einladung beigetreten, wie im
    Muster aus ``tests/test_devices.py``."""
    token, uid = await _make_token(_auth_signer)
    invite = (
        await client.post(f"/guilds/{gid}/invites", json={}, headers=_auth(owner_token))
    ).json()
    r = await client.post(f"/invites/{invite['code']}/accept", headers=_auth(token))
    assert r.status_code in (200, 201), r.text
    return token, uid


@pytest.mark.asyncio
async def test_freigabe_haengt_am_geraet(session_factory):
    async with session_factory() as session:
        session.add(
            DeviceGrant(
                id=1,
                device_id=42,
                subject_type=SUBJECT_EVERYONE,
                subject_id=None,
                expires_at=None,
                created_by_user_id=7,
            )
        )
        await session.commit()
        geladen = await session.get(DeviceGrant, 1)
        assert geladen.subject_type == SUBJECT_EVERYONE
        assert geladen.subject_id is None
        assert geladen.created_at is not None


@pytest.mark.asyncio
async def test_nur_der_besitzer_sieht_und_setzt(client, _auth_signer):
    besitzer, b_uid = await _make_token(_auth_signer)
    gid = await _guild(client, besitzer, "studio")
    kanal = await _voice_channel(client, besitzer, gid)
    r = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(kanal), "name": "schnitt-1"},
        headers=_auth(besitzer),
    )
    did = r.json()["id"]

    # Der Fremde ist Mitglied der Community UND traegt MANAGE_GUILD — die
    # Sicherheits-Zusage ist erst dann geprueft, wenn require_member (403 wegen
    # fehlender Mitgliedschaft) nicht schon vorher greift.
    fremd, f_uid = await _mitglied(client, besitzer, gid, _auth_signer)
    role = (
        await client.post(
            f"/guilds/{gid}/roles",
            json={"name": "verwaltung", "permissions": str(int(Permissions.MANAGE_GUILD))},
            headers=_auth(besitzer),
        )
    ).json()
    await client.put(
        f"/guilds/{gid}/members/{f_uid}/roles/{role['id']}",
        headers=_auth(besitzer),
    )

    # Setzen
    r = await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": [{"subject_type": "user", "subject_id": str(f_uid)}]},
        headers=_auth(besitzer),
    )
    assert r.status_code == 200, r.text
    assert r.json()[0]["subject_id"] == str(f_uid)

    # Lesen
    r = await client.get(f"/guilds/{gid}/devices/{did}/grants", headers=_auth(besitzer))
    assert len(r.json()) == 1

    # Ein Fremder — auch mit MANAGE_GUILD — darf weder lesen noch setzen: 404,
    # nicht 403, damit die Antwort nicht verraet, wem welche Kennung gehoert.
    r = await client.get(f"/guilds/{gid}/devices/{did}/grants", headers=_auth(fremd))
    assert r.status_code == 404, r.text
    r = await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": []},
        headers=_auth(fremd),
    )
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_ersetzen_raeumt_die_alte_liste(client, _auth_signer):
    besitzer, _ = await _make_token(_auth_signer)
    _, a_uid = await _make_token(_auth_signer)
    _, b_uid = await _make_token(_auth_signer)
    gid = await _guild(client, besitzer, "studio")
    kanal = await _voice_channel(client, besitzer, gid)
    did = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(kanal), "name": "schnitt-1"},
            headers=_auth(besitzer),
        )
    ).json()["id"]

    await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": [{"subject_type": "user", "subject_id": str(a_uid)}]},
        headers=_auth(besitzer),
    )
    r = await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": [{"subject_type": "user", "subject_id": str(b_uid)}]},
        headers=_auth(besitzer),
    )
    assert [g["subject_id"] for g in r.json()] == [str(b_uid)]


@pytest.mark.asyncio
async def test_unsinnige_freigabe_wird_abgewiesen(client, _auth_signer):
    besitzer, _ = await _make_token(_auth_signer)
    gid = await _guild(client, besitzer, "studio")
    kanal = await _voice_channel(client, besitzer, gid)
    did = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(kanal), "name": "schnitt-1"},
            headers=_auth(besitzer),
        )
    ).json()["id"]

    # Unbekannte Art
    r = await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": [{"subject_type": "gruppe", "subject_id": "1"}]},
        headers=_auth(besitzer),
    )
    assert r.status_code == 422
    # user ohne Kennung
    r = await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": [{"subject_type": "user", "subject_id": None}]},
        headers=_auth(besitzer),
    )
    assert r.status_code == 422
