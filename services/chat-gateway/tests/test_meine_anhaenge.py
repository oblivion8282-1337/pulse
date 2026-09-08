"""Backfill eigener Anhang-Metadaten (Medien-Nachziehen A1): GET /meine-anhaenge.

Abgedeckt: Paginierung (newest-first, exklusiver Cursor), Konto-Grenze
(fremdes Konto sieht nichts) und die Zeilenauswahl — pendente Uploads,
gelöschte Zeilen und nie gebundene Hüllen bleiben außen; verschlüsselte
Zeilen kommen mit NULL-Metadaten und ``verschluesselt``-Marke.
"""

from __future__ import annotations

import random
from datetime import datetime, timezone

import pytest

from dcc_chat_gateway.models import MessageAttachment
from .conftest import make_auth_header


async def _user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _anhang(
    session_factory,
    *,
    uploader: int,
    channel: int = 42,
    mit_nachricht: bool = True,
    gebunden: bool = False,
    geloescht: bool = False,
    verschluesselt: bool = False,
    storage: str | None = None,
) -> int:
    """Eine Anhang-Zeile direkt anlegen (Routen-Pfad wäre ein eigener Test)."""
    anhang_id = random.randint(10**17, 9 * 10**17)
    async with session_factory() as s:
        s.add(
            MessageAttachment(
                id=anhang_id,
                message_id=(1000 + anhang_id % 999) if mit_nachricht else None,
                channel_id=channel,
                uploader_id=uploader,
                filename=None if verschluesselt else f"bild-{anhang_id}.png",
                storage_key=storage or f"key-{anhang_id}",
                mime=None if verschluesselt else "image/png",
                size=anhang_id % 5000 + 1,
                width=40 if not verschluesselt else None,
                height=30 if not verschluesselt else None,
                deleted_at=datetime.now(timezone.utc) if geloescht else None,
                postfach_gebunden_am=datetime.now(timezone.utc) if gebunden else None,
            )
        )
        await s.commit()
    return anhang_id


async def test_paginierung_newest_first_mit_exklusivem_cursor(
    client, _auth_signer, session_factory
):
    token, uid = await _user(_auth_signer)
    ids = []
    for _ in range(5):
        ids.append(await _anhang(session_factory, uploader=uid))
    erwartete_reihenfolge = [str(i) for i in reversed(sorted(ids))]

    headers = make_auth_header(token)
    r = await client.get("/meine-anhaenge?limit=2", headers=headers)
    assert r.status_code == 200, r.text
    seite1 = r.json()
    assert [row["id"] for row in seite1] == erwartete_reihenfolge[:2]
    assert len(seite1) == 2
    # Snowflakes kommen als Strings (JS verlöre als Number still Bits —
    # der Klient braucht die id exakt für Cursor und Medien-Index).
    assert all(isinstance(row["id"], str) for row in seite1)

    # Cursor = letzte gesehene id; exklusiv heißt: die kommt nicht nochmal.
    r = await client.get(
        f"/meine-anhaenge?limit=2&before={seite1[-1]['id']}", headers=headers
    )
    seite2 = r.json()
    assert [row["id"] for row in seite2] == erwartete_reihenfolge[2:4]

    r = await client.get(
        f"/meine-anhaenge?limit=2&before={seite2[-1]['id']}", headers=headers
    )
    rest = r.json()
    assert [row["id"] for row in rest] == erwartete_reihenfolge[4:]


async def test_fremdes_konto_sieht_nichts(client, _auth_signer, session_factory):
    token_a, uid_a = await _user(_auth_signer)
    token_b, uid_b = await _user(_auth_signer)
    await _anhang(session_factory, uploader=uid_a)
    await _anhang(session_factory, uploader=uid_a)
    r = await client.get("/meine-anhaenge", headers=make_auth_header(token_b))
    assert r.status_code == 200
    assert r.json() == []
    r = await client.get("/meine-anhaenge", headers=make_auth_header(token_a))
    assert len(r.json()) == 2


async def test_zeilenauswahl_pending_und_geloescht_bleiben_aussen(
    client, _auth_signer, session_factory
):
    token, uid = await _user(_auth_signer)
    # zustellbar: an Nachricht gebunden
    ok_id = await _anhang(session_factory, uploader=uid, mit_nachricht=True)
    # zustellbar: nie an Nachricht, aber postfach-gebunden (E2EE-Weg)
    ok_gebunden = await _anhang(
        session_factory, uploader=uid, mit_nachricht=False, gebunden=True
    )
    # außen: pendent Upload (kein message_id, nie gebunden) — Reaper-Gebiet
    await _anhang(session_factory, uploader=uid, mit_nachricht=False)
    # außen: gelöscht
    await _anhang(session_factory, uploader=uid, geloescht=True)

    r = await client.get("/meine-anhaenge", headers=make_auth_header(token))
    zeilen = r.json()
    assert {row["id"] for row in zeilen} == {str(ok_id), str(ok_gebunden)}


async def test_verschluesselte_zeile_mit_null_metadaten(
    client, _auth_signer, session_factory
):
    token, uid = await _user(_auth_signer)
    anhang_id = await _anhang(
        session_factory, uploader=uid, verschluesselt=True, gebunden=True
    )
    r = await client.get("/meine-anhaenge", headers=make_auth_header(token))
    zeile = next(row for row in r.json() if row["id"] == str(anhang_id))
    assert zeile["filename"] is None
    assert zeile["mime"] is None
    assert zeile["width"] is None and zeile["height"] is None
    assert zeile["verschluesselt"] is True
    assert zeile["size"] > 0
    assert zeile["laufwerk_verteilt"] is False


async def test_auth_pflicht(client):
    r = await client.get("/meine-anhaenge")
    assert r.status_code == 401, r.text
