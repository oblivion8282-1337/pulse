"""WS-Replay-Cursor (``hist_replay``-Op): Stempel, Nachholen, Vollständigkeit.

Deckt die Centrifugo-Blaupause Ende-zu-Ende ab: ``publish`` stempelt
``seq``/``hist`` auf dauerhafte Kanal-Ops (und NICHT auf ``typing``),
``read_channel_history`` erkennt lückenlose Anschlüsse vs. Lücken, und ein
wiederverbindender Client bekommt die Offline-Zeit per ``replay``-Rahmen
nachgeliefert — inkl. ``complete:false``, wenn der Stream den Cursor nicht
mehr hergibt.
"""

from __future__ import annotations

import asyncio
import json
import os
import random

import pytest
from redis.asyncio import Redis
from starlette.testclient import TestClient

from dcc_chat_gateway.pubsub import ConnectionManager
from dcc_chat_gateway.pubsub_channels import (
    CHANNEL_HIST_KEY,
    CHANNEL_SEQ_KEY,
)

from .conftest import receive_skipping

# Dieselbe URL wie die App unter Test (REDIS_URL-Env), damit Schlüssel-
# Löschungen im Fabric gegen die echte Datenbank gehen — siehe conftest.
_REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6380/0").replace(
    "localhost", "127.0.0.1"
)


@pytest.fixture
async def redis() -> Redis:
    r = Redis.from_url(_REDIS_URL, decode_responses=False)
    yield r
    await r.aclose()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _loesche_hist(redis: Redis, *cids: str) -> None:
    """Stream + Sequenz-Zähler aller im Test benutzten Kanäle löschen."""
    await redis.delete(
        *[
            key.format(channel_id=cid)
            for cid in cids
            for key in (CHANNEL_HIST_KEY, CHANNEL_SEQ_KEY)
        ]
    )


async def test_publish_stamps_only_hist_ops(redis: Redis):
    mgr = ConnectionManager(redis)
    # Eigenen Kanal-Namensraum verwenden — eindeutig pro Testlauf.
    cid = str(random.randint(10**14, 10**15))
    try:
        # Nacktes Legacy-Dict ohne ``op``: wird in publish() zum Umschlag
        # gewickelt — der Stempel muss oben auf dem Umschlag landen, nicht
        # in ``data``.
        await mgr.publish(cid, {"channel_id": cid, "id": "1"})
        await mgr.publish(cid, {"channel_id": cid, "id": "2"})

        entries = await redis.xrange(CHANNEL_HIST_KEY.format(channel_id=cid), min="-", max="+")
        assert len(entries) == 2
        envs = [json.loads(fields[b"e"]) for _, fields in entries]
        assert all(e["op"] == "message" for e in envs)
        assert [e["seq"] for e in envs] == [1, 2]
        assert all("hist" not in e or e["hist"] for e in envs)
        # Auf dem Stream-Eintrag liegt der Stempel OBEN (kein data.seq).
        assert "seq" not in envs[0]["data"]

        typing = {"op": "typing", "channel_id": cid, "user_id": "77"}
        await mgr.publish(cid, typing)
        assert "seq" not in typing and "hist" not in typing
        assert await redis.xlen(CHANNEL_HIST_KEY.format(channel_id=cid)) == 2
    finally:
        await _loesche_hist(redis, cid)


async def test_read_channel_history_completeness(redis: Redis):
    mgr = ConnectionManager(redis)
    cid = str(random.randint(10**14, 10**15))
    hist_key = CHANNEL_HIST_KEY.format(channel_id=cid)
    try:
        for i in range(3):
            await mgr.publish(cid, {"op": "message", "data": {"channel_id": cid, "id": str(i)}})

        # Cursor aus dem Stream lesen — publish() mutiert Aufrufer-Dicts
        # bewusst nicht mehr (Stempel leben im Script). Cursor-Referenz ist
        # die Stream-Eintrag-ID, die nur XRANGE kennt.
        entries = await redis.xrange(hist_key, min="-", max="+")
        assert len(entries) == 3
        cursors = [(eid.decode(), json.loads(fields[b"e"])["seq"]) for eid, fields in entries]

        # Lückenloser Anschluss: alles nach Ereignis 1, vollständig.
        events, complete = await mgr.read_channel_history(cid, cursors[0][0], 1)
        assert complete is True and len(events) == 2
        assert events[0]["data"]["id"] == "1" and events[0]["seq"] == 2
        assert events[0]["hist"]  # Eintrag-ID injiziert

        # Cursor am Stream-Ende: nichts verpasst.
        events, complete = await mgr.read_channel_history(cid, cursors[2][0], 3)
        assert complete is True and events == []

        # Cursor in der Zukunft (Sequenz-Reset): Lücke ⇒ unvollständig.
        events, complete = await mgr.read_channel_history(cid, cursors[2][0], 99)
        assert complete is False

        # Müll-Cursor: wird gefressen, meldet unvollständig — kein raise.
        events, complete = await mgr.read_channel_history(cid, "kein-eintrag", 5)
        assert complete is False

        # Stream verloren (Redis-Verlust): unvollständig, nie ein raise.
        await redis.delete(hist_key)
        events, complete = await mgr.read_channel_history(cid, cursors[0][0], 1)
        assert events == [] and complete is False
    finally:
        await _loesche_hist(redis, cid)


def _setup_guild_channel(app, token: str) -> tuple[str, str]:
    """Guild + Textkanal anlegen, IDs zurückgeben."""
    with TestClient(app) as tc:
        g = tc.post("/guilds", json={"name": "g"}, headers=_auth(token)).json()
        ch = tc.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "Text", "type": 0},
            headers=_auth(token),
        ).json()
        return str(g["id"]), str(ch["id"])


def _post(app, token: str, cid: str, content: str) -> dict:
    with TestClient(app) as tc:
        return tc.post(
            f"/channels/{cid}/messages", json={"content": content}, headers=_auth(token)
        ).json()


def _subscribe_and_capture_cursor(app, token: str, cid: str) -> tuple[str, int]:
    """Kanal abonnieren, eine Nachricht posten, den Umschlag-Cursor holen.

    Der REST-Post läuft über denselben TestClient wie das WS — ein zweiter,
    gleichzeitiger würde die Lifespan (und damit den ConnectionManager)
    unterm offenen Socket neu starten.
    """
    with TestClient(app) as tc, tc.websocket_connect(f"/ws?token={token}") as ws:
        receive_skipping(ws)  # ready
        ws.send_json({"op": "subscribe", "channel_id": cid})
        sent = tc.post(
            f"/channels/{cid}/messages",
            json={"content": "cursor-anker"},
            headers=_auth(token),
        ).json()
        frame = receive_skipping(ws)
        assert frame["op"] == "message" and frame["data"]["id"] == sent["id"]
        assert isinstance(frame["seq"], int) and frame["hist"]
        return frame["hist"], frame["seq"]


def _replay_offline_window(
    app, token: str, cid: str, cursor: tuple[str, int]
) -> dict | None:
    """Wiederverbinden, Cursor vorlegen, den ``replay``-Rahmen abholen."""
    with TestClient(app) as tc, tc.websocket_connect(f"/ws?token={token}") as ws:
        receive_skipping(ws)  # ready
        ws.send_json({"op": "subscribe", "channel_id": cid})
        ws.send_json(
            {
                "op": "hist_replay",
                "cursors": {cid: {"hist": cursor[0], "seq": cursor[1]}},
            }
        )
        frame = receive_skipping(ws, ignore={"presence_update", "channel_bump", "dm_bump"})
        return frame if frame.get("op") == "replay" else None


@pytest.mark.asyncio
async def test_replay_delivers_offline_window(ws_app, _auth_signer, redis):
    """Die Kernaussage: Nachrichten aus der Offline-Zeit kommen komplett
    über den WS-Weg nach — ohne REST-Lückenfill."""

    def _run():
        uid = random.randint(1, 1_000_000)
        token = _auth_signer.issue_access(uid, f"u{uid}")
        _, cid = _setup_guild_channel(ws_app, token)
        cursor = _subscribe_and_capture_cursor(ws_app, token, cid)
        # Offline-Zeit: zwei Nachrichten, die WS#1 nie sieht.
        _post(ws_app, token, cid, "offline-1")
        _post(ws_app, token, cid, "offline-2")
        return token, cid, cursor

    token, cid, cursor = await asyncio.to_thread(_run)

    def _replay():
        return _replay_offline_window(ws_app, token, cid, cursor)

    try:
        frame = await asyncio.to_thread(_replay)
        assert frame is not None, "replay-Rahmen fehlt"
        assert frame["complete"] is True
        assert frame["channel_id"] == cid
        contents = [e["data"]["content"] for e in frame["events"]]
        assert contents == ["offline-1", "offline-2"]
        # Gestempelte Ereignisse, bereit für den nächsten Cursor-Schritt.
        assert all(e["seq"] == cursor[1] + i + 1 for i, e in enumerate(frame["events"]))
        assert all(e["hist"] for e in frame["events"])
    finally:
        await _loesche_hist(redis, cid)


@pytest.mark.asyncio
async def test_replay_reports_incomplete_when_stream_lost(
    ws_app, _auth_signer, redis
):
    def _run():
        uid = random.randint(1, 1_000_000)
        token = _auth_signer.issue_access(uid, f"u{uid}")
        _, cid = _setup_guild_channel(ws_app, token)
        cursor = _subscribe_and_capture_cursor(ws_app, token, cid)
        _post(ws_app, token, cid, "offline-nach-verlust")
        return token, cid, cursor

    token, cid, cursor = await asyncio.to_thread(_run)
    # Der Stream verliert die Offline-Zeit (Redis-Verlust/Trimming simuliert):
    await redis.delete(CHANNEL_HIST_KEY.format(channel_id=cid))

    try:
        frame = await asyncio.to_thread(_replay_offline_window, ws_app, token, cid, cursor)
        assert frame is not None
        assert frame["complete"] is False and frame["events"] == []
    finally:
        await _loesche_hist(redis, cid)


@pytest.mark.asyncio
async def test_replay_ignores_foreign_channels(ws_app, _auth_signer, redis):
    """Cursor für nicht abonnierte Kanäle bekommen einen LEEREN
    ``complete:false``-Rahmen — kein Inhalt, aber auch kein stilles Loch:
    der Client fällt dafür in seinen REST-Lückenfill (der bei fehlendem
    Zugriff erfolglos bleibt)."""

    def _run():
        uid = random.randint(1, 1_000_000)
        token = _auth_signer.issue_access(uid, f"u{uid}")
        _, sub = _setup_guild_channel(ws_app, token)
        _, fremd = _setup_guild_channel(ws_app, token)
        return token, sub, fremd

    token, sub_cid, fremd_cid = await asyncio.to_thread(_run)

    def _run2():
        with TestClient(ws_app) as tc, tc.websocket_connect(f"/ws?token={token}") as ws:
            receive_skipping(ws)  # ready
            ws.send_json({"op": "subscribe", "channel_id": sub_cid})
            ws.send_json(
                {
                    "op": "hist_replay",
                    "cursors": {
                        sub_cid: {"hist": "1-1", "seq": 1},
                        fremd_cid: {"hist": "1-1", "seq": 1},
                    },
                }
            )
            frames = []
            for _ in range(2):
                frames.append(
                    receive_skipping(
                        ws, ignore={"presence_update", "channel_bump", "dm_bump"}
                    )
                )
            return frames

    frames = await asyncio.to_thread(_run2)
    by_channel = {f["channel_id"]: f for f in frames if f.get("op") == "replay"}
    # Nicht abonnierter Kanal: Fallback-Rahmen ohne Inhalt.
    fremd_frame = by_channel.get(fremd_cid)
    assert fremd_frame is not None
    assert fremd_frame["complete"] is False and fremd_frame["events"] == []
    # Abonnierter Kanal mit Müll-Cursor: ebenfalls Fallback-Rahmen.
    sub_frame = by_channel.get(sub_cid)
    assert sub_frame is not None and sub_frame["complete"] is False

    await _loesche_hist(redis, sub_cid, fremd_cid)


@pytest.mark.asyncio
async def test_replay_skips_deleted_channel(ws_app, _auth_signer, redis):
    """Gelöschter Kanal: das Replay liefert NICHTS mehr — dieselbe
    Rechte-Schleuse wie der Live-Fanout (hier Kanal-Löschung statt
    VIEW_CHANNEL-Entzug, derselbe Filter)."""

    def _run():
        uid = random.randint(1, 1_000_000)
        token = _auth_signer.issue_access(uid, f"u{uid}")
        _, geloescht = _setup_guild_channel(ws_app, token)
        _, lebendig = _setup_guild_channel(ws_app, token)
        return token, geloescht, lebendig

    token, geloescht_cid, lebendig_cid = await asyncio.to_thread(_run)

    def _run2():
        with TestClient(ws_app) as tc, tc.websocket_connect(f"/ws?token={token}") as ws:
            receive_skipping(ws)  # ready
            ws.send_json({"op": "subscribe", "channel_id": geloescht_cid})
            ws.send_json({"op": "subscribe", "channel_id": lebendig_cid})
            # Cursor für den bald gelöschten Kanal einsammeln.
            sent = tc.post(
                f"/channels/{geloescht_cid}/messages",
                json={"content": "vor-dem-ende"},
                headers=_auth(token),
            ).json()
            frame = receive_skipping(ws, ignore={"presence_update"})
            assert frame["op"] == "message" and frame["data"]["id"] == sent["id"]
            cursor = {"hist": frame["hist"], "seq": frame["seq"]}
            tc.delete(f"/channels/{geloescht_cid}", headers=_auth(token))
            ws.send_json(
                {
                    "op": "hist_replay",
                    "cursors": {
                        geloescht_cid: cursor,
                        lebendig_cid: {"hist": "1-1", "seq": 1},
                    },
                }
            )
            return receive_skipping(
                ws,
                ignore={
                    "presence_update",
                    "channel_deleted",
                    "channel_bump",
                    "dm_bump",
                },
            )

    frame = await asyncio.to_thread(_run2)
    # Der erste (einzige) replay-Rahmen gehört zum LEBENDIGEN Kanal — für
    # den gelöschten kommt nichts (Live-Parität).
    assert frame.get("op") == "replay"
    assert frame["channel_id"] == lebendig_cid

    await _loesche_hist(redis, geloescht_cid, lebendig_cid)


@pytest.mark.asyncio
async def test_replay_overflow_reports_incomplete_with_events(
    ws_app, _auth_signer, redis, monkeypatch
):
    """Fenster kleiner als die Lücke (>HIST_REPLAY_CAP): der Rahmen trägt
    CAP Ereignisse nach dem Cursor UND complete:false — der Client liest
    den Rest per REST nach, statt alles zu verwerfen."""

    from dcc_chat_gateway import pubsub as pubsub_mod

    monkeypatch.setattr(pubsub_mod, "HIST_REPLAY_CAP", 2)

    def _run():
        uid = random.randint(1, 1_000_000)
        token = _auth_signer.issue_access(uid, f"u{uid}")
        _, cid = _setup_guild_channel(ws_app, token)
        cursor = _subscribe_and_capture_cursor(ws_app, token, cid)
        for i in range(3):
            _post(ws_app, token, cid, f"ueberlauf-{i}")
        return token, cid, cursor

    token, cid, cursor = await asyncio.to_thread(_run)
    try:
        frame = await asyncio.to_thread(
            _replay_offline_window, ws_app, token, cid, cursor
        )
        assert frame is not None
        assert frame["complete"] is False
        assert len(frame["events"]) == 2
        assert frame["events"][0]["seq"] == cursor[1] + 1
    finally:
        await _loesche_hist(redis, cid)


@pytest.mark.asyncio
async def test_replay_delivers_edits_and_reactions(ws_app, _auth_signer, redis):
    """Das zweite Kernversprechen: Bearbeitung + Reaktion aus der
    Offline-Zeit kommen gestempelt und in Sequenzordnung im Replay."""

    def _run():
        uid = random.randint(1, 1_000_000)
        token = _auth_signer.issue_access(uid, f"u{uid}")
        _, cid = _setup_guild_channel(ws_app, token)
        with TestClient(ws_app) as tc, tc.websocket_connect(
            f"/ws?token={token}"
        ) as ws:
            receive_skipping(ws)  # ready
            ws.send_json({"op": "subscribe", "channel_id": cid})
            sent = tc.post(
                f"/channels/{cid}/messages",
                json={"content": "original"},
                headers=_auth(token),
            ).json()
            frame = receive_skipping(ws, ignore={"presence_update"})
            cursor = {"hist": frame["hist"], "seq": frame["seq"]}
        # Offline-Zeit: bearbeiten + reagieren.
        with TestClient(ws_app) as tc:
            r_edit = tc.patch(
                f"/messages/{sent['id']}",
                json={"content": "bearbeitet"},
                headers=_auth(token),
            )
            assert r_edit.status_code == 200, r_edit.text
            r_react = tc.put(
                f"/messages/{sent['id']}/reactions/%F0%9F%91%8D/@me",
                headers=_auth(token),
            )
            assert r_react.status_code == 204, r_react.text
        return token, cid, cursor, sent["id"]

    token, cid, cursor, mid = await asyncio.to_thread(_run)
    try:
        frame = await asyncio.to_thread(
            _replay_offline_window,
            ws_app,
            token,
            cid,
            (cursor["hist"], cursor["seq"]),
        )
        assert frame is not None
        assert frame["complete"] is True
        ops = [e["op"] for e in frame["events"]]
        assert ops == ["message_update", "reaction_add"]
        assert frame["events"][0]["data"]["content"] == "bearbeitet"
        assert frame["events"][0]["data"]["id"] == mid
        # Stempel sitzen auf dem Umschlag, nicht in data.
        assert all("seq" not in e["data"] for e in frame["events"])
        seqs = [e["seq"] for e in frame["events"]]
        assert seqs == [cursor["seq"] + 1, cursor["seq"] + 2]
    finally:
        await _loesche_hist(redis, cid)
