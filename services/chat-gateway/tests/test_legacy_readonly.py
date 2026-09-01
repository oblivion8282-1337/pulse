"""Alt-Kanal eingefroren (Entwurf §9, Etappe E9): Lesen ja, Schreiben nein.

Der Schalter (``legacy_readonly``) ist bewusst NICHT über die API setzbar in
dieser Etappe — kein Admin-Endpunkt, kein automatisches Umlegen über
``channel_creation_policy``. Das Umlegen ist ein späterer, bewusster
Handgriff des Betreibers. Tests setzen das Flag deshalb direkt in der
Test-DB, so wie es dieser Handgriff später auch täte.
"""

from __future__ import annotations

import asyncio
import random

import pytest
from sqlalchemy import update

from dcc_chat_gateway.models import Channel


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer):
    uid = random.randint(1, 1_000_000)
    token = _auth_signer.issue_access(uid, f"user{uid}")
    return token, uid


async def _freeze(session_factory, channel_id: str) -> None:
    async with session_factory() as session:
        await session.execute(
            update(Channel)
            .where(Channel.id == int(channel_id))
            .values(legacy_readonly=True)
        )
        await session.commit()


# ---------------------------------------------------------------------------
# REST — lesen bleibt erlaubt, schreiben wird begründend abgewiesen
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_alt_kanal_bleibt_lesbar(client, _auth_signer, session_factory):
    t1, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    c = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "alt"}, headers=auth(t1)
        )
    ).json()
    await client.post(
        f"/channels/{c['id']}/messages",
        json={"content": "vor dem Einfrieren"},
        headers=auth(t1),
    )
    await _freeze(session_factory, c["id"])

    r = await client.get(f"/channels/{c['id']}/messages", headers=auth(t1))
    assert r.status_code == 200
    assert len(r.json()) == 1


@pytest.mark.asyncio
async def test_alt_kanal_weist_neue_nachricht_ab_mit_begruendung(
    client, _auth_signer, session_factory
):
    t1, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    c = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "alt"}, headers=auth(t1)
        )
    ).json()
    await _freeze(session_factory, c["id"])

    r = await client.post(
        f"/channels/{c['id']}/messages",
        json={"content": "sollte nicht ankommen"},
        headers=auth(t1),
    )
    assert r.status_code == 403
    # Begruendend statt nacktem 403 — die Meldung sagt WARUM.
    assert "legacy_readonly" in r.text
    assert "frozen" in r.text

    # Und tatsaechlich nichts gelandet.
    hist = await client.get(f"/channels/{c['id']}/messages", headers=auth(t1))
    assert hist.json() == []


@pytest.mark.asyncio
async def test_alt_kanal_weist_anhang_upload_ab(client, _auth_signer, session_factory):
    t1, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    c = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "alt"}, headers=auth(t1)
        )
    ).json()
    await _freeze(session_factory, c["id"])

    r = await client.post(
        f"/channels/{c['id']}/attachments/upload-url",
        json={"filename": "a.png", "mime": "image/png", "size": 10},
        headers=auth(t1),
    )
    assert r.status_code == 403
    assert "legacy_readonly" in r.text


@pytest.mark.asyncio
async def test_alt_kanal_zeigt_zustand_in_channel_out(
    client, _auth_signer, session_factory
):
    t1, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    c = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "alt"}, headers=auth(t1)
        )
    ).json()
    assert c["legacy_readonly"] is False
    await _freeze(session_factory, c["id"])

    r = await client.get(f"/channels/{c['id']}", headers=auth(t1))
    assert r.status_code == 200
    assert r.json()["legacy_readonly"] is True


# ---------------------------------------------------------------------------
# WS — beide Pfade von ``handle_send`` (schnell UND langsam)
# ---------------------------------------------------------------------------


def _freeze_sync(db_url: str, channel_id: str) -> None:
    from sqlalchemy import create_engine

    sync_url = db_url.replace("+aiosqlite", "")
    eng = create_engine(sync_url, future=True)
    try:
        with eng.begin() as conn:
            conn.exec_driver_sql(
                "UPDATE channels SET legacy_readonly = 1 WHERE id = ?",
                (int(channel_id),),
            )
    finally:
        eng.dispose()


@pytest.mark.asyncio
async def test_ws_send_in_alt_kanal_wird_auf_beiden_pfaden_abgewiesen(
    ws_app, _auth_signer
):
    """Spiegelt ``test_ws_send_in_ablage_kanal_wird_auch_nach_subscribe_verworfen``
    (test_ablage_policy.py) — derselbe historische Fehler (schneller Pfad
    prüfte die Ablage-Sperre nicht) wäre hier genauso möglich, deshalb dieselbe
    Zweifach-Probe: einmal ohne vorheriges ``subscribe`` (langsamer Pfad),
    einmal danach (schneller Pfad, ``cid in ctx.subscribed``).
    """
    import dcc_chat_gateway.config as chat_cfg
    from starlette.testclient import TestClient

    from .conftest import receive_skipping

    def _run():
        with TestClient(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            token = _auth_signer.issue_access(uid, f"u{uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=auth(token)).json()
            kanal = tc.post(
                f"/guilds/{g['id']}/channels",
                json={"name": "alt"},
                headers=auth(token),
            ).json()
            _freeze_sync(chat_cfg.get_settings().database_url, kanal["id"])

            with tc.websocket_connect(f"/ws?token={token}") as ws:
                receive_skipping(ws)  # ready

                ws.send_json(
                    {
                        "op": "send",
                        "channel_id": kanal["id"],
                        "content": "langsamer pfad",
                        "nonce": "n-langsam",
                    }
                )
                langsam = receive_skipping(ws)
                assert langsam["op"] == "error"
                assert langsam["code"] == 4015
                assert "legacy_readonly" in langsam["msg"]

                ws.send_json({"op": "subscribe", "channel_id": kanal["id"]})
                ws.send_json(
                    {
                        "op": "send",
                        "channel_id": kanal["id"],
                        "content": "schneller pfad",
                        "nonce": "n-schnell",
                    }
                )
                schnell = receive_skipping(ws)
                assert schnell["op"] == "error", (
                    "schneller Pfad: ein vorheriges `subscribe` darf die "
                    f"Alt-Kanal-Sperre nicht aushebeln, war {schnell}"
                )
                assert schnell["code"] == 4015

            # Gegenprobe: es ist keine Nachricht entstanden.
            hist = tc.get(
                f"/channels/{kanal['id']}/messages", headers=auth(token)
            ).json()
            assert hist == []

    await asyncio.to_thread(_run)
