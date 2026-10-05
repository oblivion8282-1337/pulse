"""Tests für die Archiv-Routen (Übergabe 2026-10-04 §5): Mitgliedschafts-
Gates, idempotente Einlieferung, Kanal-Schlüssel-Wraps nur für Teilnehmer
und der 120-Tage-Sweeper."""

from __future__ import annotations

import base64
from datetime import UTC

import pytest

from .conftest import make_auth_header

pytestmark = pytest.mark.usefixtures("cloud_mode")


async def _register(_auth_signer) -> tuple[str, int]:
    import random

    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _dm_zwischen(client, _auth_signer, friend_pair, uid_a: int, uid_b: int) -> str:
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/dm-channels",
        json={"target_user_id": str(uid_b)},
        headers=make_auth_header(_auth_signer.issue_access(uid_a, f"u{uid_a}")),
    )
    assert r.status_code == 201
    return r.json()["id"]


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


@pytest.mark.asyncio
async def test_einliefern_und_lesen_rundtrip(client, _auth_signer, friend_pair):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    dm_id = await _dm_zwischen(client, _auth_signer, friend_pair, uid_a, uid_b)

    nutzlast = _b64(b"\x01" * 60)
    r = await client.post(
        "/archiv",
        json={
            "zeilen": [{"id": 111, "channel_id": int(dm_id), "nutzlast_b64": nutzlast}],
            "wraps": [
                {"channel_id": int(dm_id), "user_id": uid_a, "wrap_b64": _b64(b"w" * 40)},
                {"channel_id": int(dm_id), "user_id": uid_b, "wrap_b64": _b64(b"x" * 40)},
            ],
        },
        headers=make_auth_header(t_a),
    )
    assert r.status_code == 204, r.text

    # Lesen: Teilnehmer sehen die Zeile (aufsteigend), base64 zurück.
    for token in (t_a, t_b):
        r = await client.get(f"/archiv/{dm_id}", headers=make_auth_header(token))
        assert r.status_code == 200
        zeilen = r.json()
        assert len(zeilen) == 1
        assert zeilen[0]["id"] == "111"
        assert zeilen[0]["nutzlast_b64"] == nutzlast

    # Eigener Wrap kommt zurück; der des Partners nicht.
    r = await client.get(f"/archiv/{dm_id}/schluessel", headers=make_auth_header(t_a))
    assert r.status_code == 200
    assert r.json()["wrap_b64"] == _b64(b"w" * 40)
    r = await client.get(f"/archiv/{dm_id}/schluessel", headers=make_auth_header(t_b))
    assert r.json()["wrap_b64"] == _b64(b"x" * 40)


@pytest.mark.asyncio
async def test_wiederholte_einlieferung_ist_idempotent(client, _auth_signer, friend_pair):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    dm_id = await _dm_zwischen(client, _auth_signer, friend_pair, uid_a, uid_b)

    rumpf = {
        "zeilen": [{"id": 222, "channel_id": int(dm_id), "nutzlast_b64": _b64(b"n" * 60)}],
        "wraps": [],
    }
    for _ in range(2):
        r = await client.post("/archiv", json=rumpf, headers=make_auth_header(t_a))
        assert r.status_code == 204
    r = await client.get(f"/archiv/{dm_id}", headers=make_auth_header(t_a))
    assert len(r.json()) == 1


@pytest.mark.asyncio
async def test_fremd_liest_und_schreibt_nicht(client, _auth_signer, friend_pair):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    dm_id = await _dm_zwischen(client, _auth_signer, friend_pair, uid_a, uid_b)
    t_fremd, _ = await _register(_auth_signer)

    r = await client.post(
        "/archiv",
        json={
            "zeilen": [{"id": 333, "channel_id": int(dm_id), "nutzlast_b64": _b64(b"f" * 60)}],
            "wraps": [],
        },
        headers=make_auth_header(t_fremd),
    )
    assert r.status_code == 404
    r = await client.get(f"/archiv/{dm_id}", headers=make_auth_header(t_fremd))
    assert r.status_code == 404
    r = await client.get(f"/archiv/{dm_id}/schluessel", headers=make_auth_header(t_fremd))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_wrap_nur_fuer_teilnehmer(client, _auth_signer, friend_pair):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    dm_id = await _dm_zwischen(client, _auth_signer, friend_pair, uid_a, uid_b)
    t_fremd, uid_fremd = await _register(_auth_signer)

    r = await client.post(
        "/archiv",
        json={
            "zeilen": [],
            "wraps": [
                {"channel_id": int(dm_id), "user_id": uid_fremd, "wrap_b64": _b64(b"z" * 40)}
            ],
        },
        headers=make_auth_header(t_a),
    )
    assert r.status_code == 404
    # Teilnehmer-Wraps (a und b) bleiben erlaubt — Deckel der Routine.


@pytest.mark.asyncio
async def test_pubkeys_nur_fuer_dm_partner(client, _auth_signer, friend_pair):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await _dm_zwischen(client, _auth_signer, friend_pair, uid_a, uid_b)
    _, uid_fremd = await _register(_auth_signer)

    # Partner: 200 (Wert kommt vom auth-Dienst — ohne internes Geheimnis null).
    r = await client.get(
        f"/archiv/pubkeys?user_ids={uid_b}", headers=make_auth_header(t_a)
    )
    assert r.status_code == 200
    assert r.json() == {str(uid_b): None}
    # Fremder: 404 — kein Metadaten-Orakel über beliebige Konten.
    r = await client.get(
        f"/archiv/pubkeys?user_ids={uid_fremd}", headers=make_auth_header(t_a)
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_sweeper_loescht_nur_abgelaufene(session_factory):
    from datetime import datetime, timedelta

    from dcc_chat_gateway.models import ArchivZeile
    from dcc_chat_gateway.routes.archiv import sweep_abgelaufene_archiv_zeilen
    from sqlalchemy import select

    jetzt = datetime.now(tz=UTC)
    async with session_factory() as session:
        session.add(
            ArchivZeile(id=900001, channel_id=1, nutzlast=b"alt", erstellt_at=jetzt - timedelta(days=121))
        )
        session.add(
            ArchivZeile(id=900002, channel_id=1, nutzlast=b"frisch", erstellt_at=jetzt - timedelta(days=10))
        )
        await session.commit()

        geloescht = await sweep_abgelaufene_archiv_zeilen(session)
        assert geloescht == 1
        rest = (await session.execute(select(ArchivZeile).where(ArchivZeile.channel_id == 1))).scalars().all()
        assert [z.id for z in rest] == [900002]


# --- Private Gruppen (2026-10-05, „Gruppen und Privatchats“) ------------------


@pytest.fixture
def gruppen_an(_isolate_chat_settings):
    """Wie in ``test_private_gruppen.py``: der Schalter steht per Vorgabe
    aus, Tests, die eine Gruppe brauchen, fordern ihn ausdrücklich an."""
    _isolate_chat_settings.private_groups_enabled = True
    return _isolate_chat_settings


async def _gruppe_mit(client, token, weitere_uids: list[int]) -> str:
    r = await client.post("/gruppen", json={"name": "g"}, headers=make_auth_header(token))
    assert r.status_code == 201, r.text
    gid = r.json()["id"]
    for uid in weitere_uids:
        r = await client.post(
            f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid)}, headers=make_auth_header(token)
        )
        assert r.status_code == 201, r.text
    return gid


@pytest.mark.asyncio
async def test_gruppe_einliefern_und_lesen_rundtrip(client, _auth_signer, gruppen_an):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    gid = await _gruppe_mit(client, t_a, [uid_b])
    t_fremd, _ = await _register(_auth_signer)

    nutzlast = _b64(b"\x02" * 60)
    r = await client.post(
        "/archiv",
        json={
            "zeilen": [{"id": 600, "channel_id": int(gid), "nutzlast_b64": nutzlast}],
            "wraps": [
                {"channel_id": int(gid), "user_id": uid_a, "wrap_b64": _b64(b"w" * 40)},
                {"channel_id": int(gid), "user_id": uid_b, "wrap_b64": _b64(b"x" * 40)},
            ],
        },
        headers=make_auth_header(t_a),
    )
    assert r.status_code == 204, r.text

    for token in (t_a, t_b):
        r = await client.get(f"/archiv/{gid}", headers=make_auth_header(token))
        assert r.status_code == 200
        assert [z["id"] for z in r.json()] == ["600"]
    r = await client.get(f"/archiv/{gid}/schluessel", headers=make_auth_header(t_b))
    assert r.json()["wrap_b64"] == _b64(b"x" * 40)

    # Fremde bleiben draußen — schreiben UND lesen.
    r = await client.post(
        "/archiv",
        json={"zeilen": [{"id": 601, "channel_id": int(gid), "nutzlast_b64": nutzlast}], "wraps": []},
        headers=make_auth_header(t_fremd),
    )
    assert r.status_code == 404
    r = await client.get(f"/archiv/{gid}", headers=make_auth_header(t_fremd))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_gruppe_wrap_nur_fuer_mitglieder(client, _auth_signer, gruppen_an):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    gid = await _gruppe_mit(client, t_a, [uid_b])
    _, uid_fremd = await _register(_auth_signer)

    r = await client.post(
        "/archiv",
        json={
            "zeilen": [],
            "wraps": [{"channel_id": int(gid), "user_id": uid_fremd, "wrap_b64": _b64(b"z" * 40)}],
        },
        headers=make_auth_header(t_a),
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_gruppe_beitrittsgrenze(client, _auth_signer, gruppen_an, session_factory):
    """Mitglieder lesen ab eigenem Beitritt — dasselbe Fenster wie Megolm.
    Beitritt direkt in der DB verschoben, sonst rennen zwei ``now()`` in
    dieselbe Sekunde und der Test wäre eine Münze."""
    from datetime import datetime, timedelta

    from dcc_chat_gateway.models import PrivateGroupMember
    from sqlalchemy import select

    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    gid = await _gruppe_mit(client, t_a, [uid_b])

    r = await client.post(
        "/archiv",
        json={
            "zeilen": [{"id": 610, "channel_id": int(gid), "nutzlast_b64": _b64(b"v" * 60)}],
            "wraps": [],
        },
        headers=make_auth_header(t_a),
    )
    assert r.status_code == 204, r.text

    async def beitritt_setzen(zeit: datetime) -> None:
        async with session_factory() as s:
            zeile = (
                await s.execute(
                    select(PrivateGroupMember).where(
                        PrivateGroupMember.gruppe_id == int(gid),
                        PrivateGroupMember.user_id == uid_b,
                    )
                )
            ).scalar_one()
            zeile.beigetreten_am = zeit
            await s.commit()

    # Beitritt LIEGT NACH der Zeile -> unsichtbar für B, sichtbar für A.
    await beitritt_setzen(datetime.now(tz=UTC) + timedelta(hours=1))
    r = await client.get(f"/archiv/{gid}", headers=make_auth_header(t_b))
    assert r.json() == []
    r = await client.get(f"/archiv/{gid}", headers=make_auth_header(t_a))
    assert len(r.json()) == 1

    # Beitritt LIEGT VOR der Zeile -> sichtbar.
    await beitritt_setzen(datetime.now(tz=UTC) - timedelta(hours=1))
    r = await client.get(f"/archiv/{gid}", headers=make_auth_header(t_b))
    assert len(r.json()) == 1


@pytest.mark.asyncio
async def test_pubkeys_kanal_skop_fuer_gruppen(client, _auth_signer, gruppen_an):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    gid = await _gruppe_mit(client, t_a, [uid_b])
    t_fremd, uid_fremd = await _register(_auth_signer)

    # Mitglied darf Mitgieler-Keys über den Kanal fragen (Wert kommt vom
    # auth-Dienst — ohne internes Geheimnis null).
    r = await client.get(
        f"/archiv/pubkeys?user_ids={uid_b}&channel_id={gid}", headers=make_auth_header(t_a)
    )
    assert r.status_code == 200
    assert r.json() == {str(uid_b): None}

    # Nicht-Mitglied über denselben Kanal: 404.
    r = await client.get(
        f"/archiv/pubkeys?user_ids={uid_b}&channel_id={gid}", headers=make_auth_header(t_fremd)
    )
    assert r.status_code == 404

    # Mitglied fragt über den Kanal einen Fremden: 404 (kein Orakel).
    r = await client.get(
        f"/archiv/pubkeys?user_ids={uid_fremd}&channel_id={gid}", headers=make_auth_header(t_a)
    )
    assert r.status_code == 404
