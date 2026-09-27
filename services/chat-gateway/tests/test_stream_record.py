"""``stream_record``: Zuschauer meldet Aufnahme, Live-Streamer erfährt sie.

Live-only, ohne Persistenz (Michaels Entscheidung 2026-09-27). Getestet wird:
Zustellung an den Streamer, Zustandsfilter (nur Veraenderungen), Ablehnung
fuer Nicht-Mitglieder, Verfallen ohne Stream, und der Disconnect-Aufraeumer.
"""

import asyncio
import json
import os
import random

import pytest
from starlette.testclient import TestClient

from .conftest import ping_barrier, skip_init_frames, trenne


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _drain_for(ws, op: str, *, max_drained: int = 20) -> dict:
    last = None
    for _ in range(max_drained):
        last = ws.receive_json()
        if last.get("op") == op:
            return last
    raise AssertionError(f"no {op!r} frame after draining {max_drained}; last={last!r}")


def _setup(tc: TestClient, signer):
    """Guild + Voice-Kanal; Owner (streamt spaeter) + Mitglied (nimmt auf).
    VIEW_CHANNEL bleibt in @everyone — anders als remote_request braucht die
    Aufnahme-Meldung kein Sonderrecht, nur Mitgliedschaft."""
    owner_uid = random.randint(1, 1_000_000)
    owner_token = signer.issue_access(owner_uid, f"u{owner_uid}")
    g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_token)).json()
    vc = tc.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "Voice", "type": 1},
        headers=_auth(owner_token),
    ).json()
    member_uid = random.randint(1, 1_000_000)
    member_token = signer.issue_access(member_uid, f"u{member_uid}")
    tc.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(member_uid)},
        headers=_auth(owner_token),
    )
    return owner_token, owner_uid, member_token, member_uid, vc["id"]


class _StreamState:
    """Setzt den Redis-Live-State „Owner streamt auf dem Kanal" für einen Test."""

    def __init__(self, cid: str, user_ids: list[str]):
        import redis as redis_sync

        self.key = f"stream:channel:{cid}"
        self.r = redis_sync.Redis.from_url(os.environ["REDIS_URL"])
        self.value = json.dumps(
            {"user_ids": user_ids, "since": "2026-09-27T00:00:00+00:00"}
        )

    def __enter__(self):
        self.r.set(self.key, self.value)
        return self

    def __exit__(self, *exc):
        self.r.delete(self.key)
        self.r.close()


@pytest.mark.asyncio
async def test_aufnahme_wird_dem_streamer_gemeldet(ws_app, _auth_signer):
    """Start und Stopp kommen an, Geflacker desselben Zustands nicht."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, owner_uid, member_token, member_uid, cid = _setup(
                tc, _auth_signer
            )
            with _StreamState(cid, [str(owner_uid)]):
                with (
                    tc.websocket_connect(f"/ws?token={owner_token}") as owner_ws,
                    tc.websocket_connect(f"/ws?token={member_token}") as member_ws,
                ):
                    skip_init_frames(owner_ws)
                    skip_init_frames(member_ws)

                    member_ws.send_json(
                        {"op": "stream_record", "channel_id": cid, "recording": True}
                    )
                    frame = _drain_for(owner_ws, "stream_record")
                    assert frame["recording"] is True
                    assert frame["from_user_id"] == str(member_uid)
                    assert frame["channel_id"] == str(cid)

                    member_ws.send_json(
                        {"op": "stream_record", "channel_id": cid, "recording": False}
                    )
                    frame = _drain_for(owner_ws, "stream_record")
                    assert frame["recording"] is False

                    # Zustandsfilter: dieselbe Meldung nochmal erreicht den
                    # Streamer nicht (ping bekommt das naechste Frame).
                    member_ws.send_json(
                        {"op": "stream_record", "channel_id": cid, "recording": False}
                    )
                    owner_ws.send_json({"op": "ping"})
                    pong = _drain_for(owner_ws, "pong")
                    assert pong is not None

                    trenne(member_ws)
                    trenne(owner_ws)

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_nichtmitglied_wird_abgelehnt(ws_app, _auth_signer):
    """4051 wie bei remote_request — die Existenz des Kanals wird nicht
    bestaetigt."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, owner_uid, _, _, cid = _setup(tc, _auth_signer)
            outsider_uid = random.randint(1, 1_000_000)
            outsider_token = _auth_signer.issue_access(outsider_uid, f"u{outsider_uid}")
            with tc.websocket_connect(f"/ws?token={outsider_token}") as ws:
                skip_init_frames(ws)
                ws.send_json(
                    {"op": "stream_record", "channel_id": cid, "recording": True}
                )
                err = ws.receive_json()
                assert err["op"] == "error"
                assert err["code"] == 4051

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ohne_stream_verfaellt_die_meldung_lautlos(ws_app, _auth_signer):
    """Kein Live-State am Kanal: niemand zu informieren, kein Fehler."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, owner_uid, member_token, _, cid = _setup(tc, _auth_signer)
            # absichtlich OHNE _StreamState
            with (
                tc.websocket_connect(f"/ws?token={owner_token}") as owner_ws,
                tc.websocket_connect(f"/ws?token={member_token}") as member_ws,
            ):
                skip_init_frames(owner_ws)
                skip_init_frames(member_ws)
                member_ws.send_json(
                    {"op": "stream_record", "channel_id": cid, "recording": True}
                )
                member_ws.send_json({"op": "ping"})
                pong = _drain_for(member_ws, "pong")
                assert pong is not None
                ping_barrier(owner_ws)  # nichts angekommen
                trenne(member_ws)
                trenne(owner_ws)

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_disconnect_beendet_gemeldete_aufnahme(ws_app, _auth_signer):
    """Geht die Verbindung des Zuschauers unter, meldet der Aufraeumer das
    Ende — sonst bliebe der Chip beim Streamer stehen."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, owner_uid, member_token, _, cid = _setup(tc, _auth_signer)
            with _StreamState(cid, [str(owner_uid)]):
                with tc.websocket_connect(f"/ws?token={owner_token}") as owner_ws:
                    skip_init_frames(owner_ws)
                    with tc.websocket_connect(f"/ws?token={member_token}") as member_ws:
                        skip_init_frames(member_ws)
                        member_ws.send_json(
                            {
                                "op": "stream_record",
                                "channel_id": cid,
                                "recording": True,
                            }
                        )
                        frame = _drain_for(owner_ws, "stream_record")
                        assert frame["recording"] is True
                        # NOCH IM Block des getrennten Sockets lesen: sein
                        # with-Exit bricht die Server-Task ab, bevor der
                        # Aueraeumer laeuft (conftest::trenne, Falle vom
                        # 2026-08-13) — das Folgeframe kaeme nie an.
                        trenne(member_ws)
                        frame = _drain_for(owner_ws, "stream_record", max_drained=30)
                        assert frame["recording"] is False
                    ping_barrier(owner_ws)
                    trenne(owner_ws)

    await asyncio.to_thread(_run)
