"""Remote-control (Pulse-Fernsteuerung) WebSocket signaling tests.

Same harness as the watch-party WS tests: a real ``ws_app`` driven through a
``TestClient`` on a worker thread. The gateway is only the consent gate + SDP/ICE
relay, so these tests assert on the frames it emits, not on any media path.

Consent + permissions:
  * controller needs VIEW_CHANNEL + REMOTE_CONTROL (4051 otherwise)
  * host must be a connected member of the channel (4052 otherwise)
  * only the invited host may answer (4053), only the two peers may signal (4053)

``remote_input`` (wire protocol v2) is a one-way relay: only the controller
sends, the gateway never parses the frames, and every rejection drops the frames
of that one message without ending the session.
"""

from __future__ import annotations

import asyncio
import base64
import random

import pytest
from starlette.testclient import TestClient

from dcc_chat_gateway import remote_reconnect_registry

from .conftest import ping_barrier, skip_init_frames, trenne


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _drain_for(ws, op: str, *, max_drained: int = 20) -> dict:
    """Read up to ``max_drained`` frames and return the first with op ``op``."""
    last = None
    for _ in range(max_drained):
        last = ws.receive_json()
        if last.get("op") == op:
            return last
    raise AssertionError(f"no {op!r} frame after draining {max_drained}; last={last!r}")


def _setup_remote(tc: TestClient, _auth_signer):
    """Owner (has REMOTE_CONTROL implicitly) + a plain member, guild + voice
    channel. Returns (owner_token, owner_uid, member_token, member_uid, gid, cid)."""
    owner_uid = random.randint(1, 1_000_000)
    owner_token = _auth_signer.issue_access(owner_uid, f"u{owner_uid}")
    g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_token)).json()
    vc = tc.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "Voice", "type": 1},
        headers=_auth(owner_token),
    ).json()
    member_uid = random.randint(1, 1_000_000)
    member_token = _auth_signer.issue_access(member_uid, f"u{member_uid}")
    tc.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(member_uid)},
        headers=_auth(owner_token),
    )
    return owner_token, owner_uid, member_token, member_uid, g["id"], vc["id"]


@pytest.mark.asyncio
async def test_request_requires_remote_control_bit(ws_app, _auth_signer):
    """A plain member (VIEW but no REMOTE_CONTROL) asking to control the owner
    is rejected with 4051 — the sensitive bit is not in @everyone."""

    def _run():
        with TestClient(ws_app) as tc:
            _, owner_uid, member_token, _, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={member_token}") as ws:
                skip_init_frames(ws)
                ws.send_json(
                    {"op": "remote_request", "channel_id": cid, "host_user_id": str(owner_uid)}
                )
                err = ws.receive_json()
                assert err["op"] == "error"
                assert err["code"] == 4051

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_request_rejects_non_member(ws_app, _auth_signer):
    """An outsider (not in the guild) gets 4051 — same code as no-bit so a
    hidden channel's existence isn't confirmed."""

    def _run():
        with TestClient(ws_app) as tc:
            _, owner_uid, _, _, _, cid = _setup_remote(tc, _auth_signer)
            outsider_uid = random.randint(1, 1_000_000)
            outsider_token = _auth_signer.issue_access(outsider_uid, f"u{outsider_uid}")
            with tc.websocket_connect(f"/ws?token={outsider_token}") as ws:
                skip_init_frames(ws)
                ws.send_json(
                    {"op": "remote_request", "channel_id": cid, "host_user_id": str(owner_uid)}
                )
                err = ws.receive_json()
                assert err["op"] == "error"
                assert err["code"] == 4051

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_request_host_offline(ws_app, _auth_signer):
    """Host is a member but has no live socket → 4052."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, _, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                skip_init_frames(ws)
                ws.send_json(
                    {"op": "remote_request", "channel_id": cid, "host_user_id": str(member_uid)}
                )
                err = ws.receive_json()
                assert err["op"] == "error"
                assert err["code"] == 4052

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_consent_flow_and_signal_forwarding(ws_app, _auth_signer):
    """Full happy path: request → host accepts → both get remote_response;
    a signal from the controller reaches ONLY the host. Also covers the two
    4053 guards while the session is live."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, owner_uid, member_token, member_uid, gid, cid = _setup_remote(
                tc, _auth_signer
            )
            # A third member, connected but not a peer of the session.
            third_uid = random.randint(1, 1_000_000)
            third_token = _auth_signer.issue_access(third_uid, f"u{third_uid}")
            tc.post(
                f"/guilds/{gid}/members",
                json={"user_id": str(third_uid)},
                headers=_auth(owner_token),
            )
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws, \
                 tc.websocket_connect(f"/ws?token={third_token}") as third_ws:
                for ws in (ctrl_ws, host_ws, third_ws):
                    skip_init_frames(ws)

                # Controller asks to drive the host.
                ctrl_ws.send_json(
                    {"op": "remote_request", "channel_id": cid, "host_user_id": str(member_uid)}
                )
                req = _drain_for(host_ws, "remote_request")
                sid = req["session_id"]
                assert req["from_user_id"] == str(owner_uid)
                assert req["channel_id"] == cid

                # Only the host may answer: the controller answering → 4053.
                ctrl_ws.send_json({"op": "remote_respond", "session_id": sid, "accept": True})
                assert _drain_for(ctrl_ws, "error")["code"] == 4053

                # Host accepts → both peers get accepted:true.
                host_ws.send_json({"op": "remote_respond", "session_id": sid, "accept": True})
                resp_h = _drain_for(host_ws, "remote_response")
                resp_c = _drain_for(ctrl_ws, "remote_response")
                assert resp_h["accepted"] is True and resp_c["accepted"] is True

                # A non-peer signalling into the live session → 4053.
                third_ws.send_json(
                    {"op": "remote_signal", "session_id": sid, "kind": "ice", "data": {"x": 1}}
                )
                assert _drain_for(third_ws, "error")["code"] == 4053

                # Controller's offer reaches ONLY the host.
                ctrl_ws.send_json(
                    {"op": "remote_signal", "session_id": sid, "kind": "offer", "data": {"sdp": "v=0"}}
                )
                sig = _drain_for(host_ws, "remote_signal")
                assert sig["kind"] == "offer" and sig["data"] == {"sdp": "v=0"}
                # The controller must not receive its own forwarded signal: a
                # ping round-trips and pong is the next frame (no signal queued).
                ping_barrier(ctrl_ws)

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_remote_end_notifies_peer(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                ctrl_ws.send_json(
                    {"op": "remote_request", "channel_id": cid, "host_user_id": str(member_uid)}
                )
                sid = _drain_for(host_ws, "remote_request")["session_id"]
                host_ws.send_json({"op": "remote_respond", "session_id": sid, "accept": True})
                _drain_for(ctrl_ws, "remote_response")
                _drain_for(host_ws, "remote_response")

                ctrl_ws.send_json({"op": "remote_end", "session_id": sid})
                ended = _drain_for(host_ws, "remote_ended")
                assert ended["session_id"] == sid
                assert ended["reason"] == "peer_ended"

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_remote_disconnect_notifies_peer(ws_app, _auth_signer, monkeypatch):
    """Seit 2026-08-19 bekommt eine ANGENOMMENE Sitzung nach einem Abriss erst
    eine Gnadenfrist (`remote_reconnect_registry.py`), bevor `remote_ended`
    hinausgeht — die Frist wird hier auf 0 gesetzt, damit dieser Test weiterhin
    prüft, dass die Meldung am ENDE ankommt, ohne real zu warten. Der eigene
    Test für die Frist selbst ist `test_remote_reclaim_survives_disconnect`
    unten."""

    monkeypatch.setattr(remote_reconnect_registry, "REMOTE_DISCONNECT_GRACE_S", 0)

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(host_ws)
                with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws:
                    skip_init_frames(ctrl_ws)
                    ctrl_ws.send_json(
                        {"op": "remote_request", "channel_id": cid, "host_user_id": str(member_uid)}
                    )
                    sid = _drain_for(host_ws, "remote_request")["session_id"]
                    host_ws.send_json({"op": "remote_respond", "session_id": sid, "accept": True})
                    _drain_for(ctrl_ws, "remote_response")
                    _drain_for(host_ws, "remote_response")
                    # Trennung HIER schicken und die Folge NOCH IM Block lesen
                    # — sonst bricht `__exit__` die Server-Task ab, bevor ihr
                    # `finally` das Frame verschickt hat (s. `conftest.trenne`).
                    trenne(ctrl_ws)
                    ended = _drain_for(host_ws, "remote_ended")
                    assert ended["session_id"] == sid
                    assert ended["reason"] == "peer_disconnected"

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_remote_reclaim_survives_disconnect(ws_app, _auth_signer):
    """Die eigentliche Zusage der Gnadenfrist: reisst der Socket des
    Steuernden ab und meldet er sich mit einem NEUEN Socket rechtzeitig via
    `remote_reclaim` zurück, bleibt die Sitzung am Leben — der Host bekommt
    KEIN `remote_ended`, und Eingabe über den neuen Socket kommt weiter an.

    Bughunt 2026-08-19: eine echte, laufende Sitzung starb an genau so einem
    Wackler nach 37 s auf dem gemeinsamen Remote-Dev-Stack (jeder Backend-Sync
    dort laedt `uvicorn --reload` neu und trennt dabei jeden Socket)."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(host_ws)
                with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws:
                    skip_init_frames(ctrl_ws)
                    ctrl_ws.send_json(
                        {"op": "remote_request", "channel_id": cid, "host_user_id": str(member_uid)}
                    )
                    sid = _drain_for(host_ws, "remote_request")["session_id"]
                    host_ws.send_json({"op": "remote_respond", "session_id": sid, "accept": True})
                    _drain_for(ctrl_ws, "remote_response")
                    _drain_for(host_ws, "remote_response")
                # `ctrl_ws` geschlossen (Ende des `with`) — der Steuernde ist
                # weg, die Gnadenfrist läuft (Vorgabe 10 s, hier nicht
                # verändert: der Reclaim kommt lange davor).
                with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws2:
                    skip_init_frames(ctrl_ws2)
                    ctrl_ws2.send_json({"op": "remote_reclaim", "session_id": sid})
                    reclaimed = _drain_for(ctrl_ws2, "remote_reclaimed")
                    assert reclaimed["session_id"] == sid
                    # Eingabe über den NEUEN Socket kommt beim Host an — die
                    # Sitzung ist wirklich fortgesetzt, nicht nur bestätigt.
                    ctrl_ws2.send_json(
                        {
                            "op": "remote_input",
                            "session_id": sid,
                            "slot": 0,
                            "frames": [base64.b64encode(b"\x02\x00\x00").decode()],
                        }
                    )
                    # Bewusst KEIN `_drain_for` (das überliest jedes Frame mit
                    # anderem `op` stillschweigend) — hier zählt gerade, DASS
                    # kein `remote_ended` zwischen der Bestätigung und der
                    # Eingabe steckt.
                    gesehen = []
                    for _ in range(20):
                        f = host_ws.receive_json()
                        gesehen.append(f)
                        if f.get("op") == "remote_input":
                            break
                    assert gesehen[-1].get("op") == "remote_input", gesehen
                    assert gesehen[-1]["session_id"] == sid
                    assert not any(f.get("op") == "remote_ended" for f in gesehen), gesehen

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_remote_reclaim_wrong_user_rejected(ws_app, _auth_signer):
    """Ein DRITTER Nutzer darf die Gnadenfrist einer fremden Sitzung nicht für
    sich beanspruchen — auch nicht, wenn er die Sitzungskennung kennt (sie
    steht in jedem `remote_ended`/`remote_pending`-Frame und ist kein
    Geheimnis, nur ein Bezeichner)."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            bystander_uid = random.randint(1, 1_000_000)
            bystander_token = _auth_signer.issue_access(bystander_uid, f"u{bystander_uid}")
            with tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(host_ws)
                with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws:
                    skip_init_frames(ctrl_ws)
                    ctrl_ws.send_json(
                        {"op": "remote_request", "channel_id": cid, "host_user_id": str(member_uid)}
                    )
                    sid = _drain_for(host_ws, "remote_request")["session_id"]
                    host_ws.send_json({"op": "remote_respond", "session_id": sid, "accept": True})
                    _drain_for(ctrl_ws, "remote_response")
                    _drain_for(host_ws, "remote_response")
                with tc.websocket_connect(f"/ws?token={bystander_token}") as bystander_ws:
                    skip_init_frames(bystander_ws)
                    bystander_ws.send_json({"op": "remote_reclaim", "session_id": sid})
                    failed = _drain_for(bystander_ws, "remote_reclaim_failed")
                    assert failed["session_id"] == sid

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_other_host_tabs_told_to_dismiss(ws_app, _auth_signer):
    """The invite fans out to every host tab; when one answers, the others get
    a ``remote_canceled`` so their consent dialog dismisses (accept + decline)."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            # Two host tabs (same user, two sockets) + the controller.
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_a, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_b:
                for ws in (ctrl_ws, host_a, host_b):
                    skip_init_frames(ws)

                ctrl_ws.send_json(
                    {"op": "remote_request", "channel_id": cid, "host_user_id": str(member_uid)}
                )
                sid = _drain_for(host_a, "remote_request")["session_id"]
                _drain_for(host_b, "remote_request")

                # Tab A accepts → tab B is told to dismiss its (now stale) prompt.
                host_a.send_json({"op": "remote_respond", "session_id": sid, "accept": True})
                cancel = _drain_for(host_b, "remote_canceled")
                assert cancel["session_id"] == sid
                # The accepting tab gets its own remote_response, not a cancel.
                assert _drain_for(host_a, "remote_response")["accepted"] is True

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_second_tab_accept_does_not_hijack_active_session(ws_app, _auth_signer):
    """Two host tabs both accept the same invite: the first wins, and a second
    (racing) accept on the now-active session is rejected 4053 WITHOUT stealing
    host_socket — the first tab's signalling to the controller must survive."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_a, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_b:
                for ws in (ctrl_ws, host_a, host_b):
                    skip_init_frames(ws)
                ctrl_ws.send_json(
                    {"op": "remote_request", "channel_id": cid, "host_user_id": str(member_uid)}
                )
                sid = _drain_for(host_a, "remote_request")["session_id"]
                _drain_for(host_b, "remote_request")
                # host_a accepts first → session active, host_a is the host peer.
                host_a.send_json({"op": "remote_respond", "session_id": sid, "accept": True})
                assert _drain_for(host_a, "remote_response")["accepted"] is True
                _drain_for(ctrl_ws, "remote_response")
                # host_b races an accept on the now-active session → 4053, no hijack.
                host_b.send_json({"op": "remote_respond", "session_id": sid, "accept": True})
                assert _drain_for(host_b, "error")["code"] == 4053
                # host_a's signalling still reaches the controller (host_socket intact).
                host_a.send_json(
                    {"op": "remote_signal", "session_id": sid, "kind": "answer", "data": {"sdp": "v=0"}}
                )
                sig = _drain_for(ctrl_ws, "remote_signal")
                assert sig["kind"] == "answer" and sig["data"] == {"sdp": "v=0"}

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_respond_on_active_session_rejected(ws_app, _auth_signer):
    """A second respond of EITHER polarity on an already-active session is
    rejected 4053 and does NOT tear it down — a decline must not kill a live
    session, a second accept must not hijack it. The live signalling survives."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                ctrl_ws.send_json(
                    {"op": "remote_request", "channel_id": cid, "host_user_id": str(member_uid)}
                )
                sid = _drain_for(host_ws, "remote_request")["session_id"]
                host_ws.send_json({"op": "remote_respond", "session_id": sid, "accept": True})
                assert _drain_for(host_ws, "remote_response")["accepted"] is True
                _drain_for(ctrl_ws, "remote_response")
                # Decline the now-active session → 4053, session must survive.
                host_ws.send_json({"op": "remote_respond", "session_id": sid, "accept": False})
                assert _drain_for(host_ws, "error")["code"] == 4053
                # Signalling still forwards (session intact, host_socket unchanged).
                host_ws.send_json(
                    {"op": "remote_signal", "session_id": sid, "kind": "answer", "data": {"sdp": "v=0"}}
                )
                assert _drain_for(ctrl_ws, "remote_signal")["kind"] == "answer"

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_pending_disconnect_dismisses_all_host_tabs(ws_app, _auth_signer):
    """Controller drops while the request is still pending → EVERY host tab is
    told to dismiss its consent dialog, not just the representative socket that
    also gets remote_ended (else the other tabs' dialog hangs)."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={member_token}") as host_a, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_b:
                skip_init_frames(host_a)
                skip_init_frames(host_b)
                with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws:
                    skip_init_frames(ctrl_ws)
                    ctrl_ws.send_json(
                        {"op": "remote_request", "channel_id": cid, "host_user_id": str(member_uid)}
                    )
                    sid = _drain_for(host_a, "remote_request")["session_id"]
                    _drain_for(host_b, "remote_request")
                    # Wie oben: trennen und die Folge im Block lesen. Hier ist
                    # das Fenster sogar breiter — es gehen ZWEI Frames hinaus.
                    trenne(ctrl_ws)
                    assert _drain_for(host_a, "remote_canceled")["session_id"] == sid
                    assert _drain_for(host_b, "remote_canceled")["session_id"] == sid

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_kick_ends_the_remote_session_at_once(ws_app, _auth_signer):
    """Rauswurf trennt SOFORT. Der Takt-Prueflauf braucht bis zu 30 s; bis dahin
    tippt der Rausgeworfene sonst weiter auf einem fremden Rechner (im
    schlimmsten Fall bis der Zugangstoken nach 15 Minuten ablaeuft)."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, gid, cid = _setup_remote(
                tc, _auth_signer
            )
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                sid = _open_session(ctrl_ws, host_ws, cid, member_uid)
                assert (
                    tc.delete(
                        f"/guilds/{gid}/members/{member_uid}", headers=_auth(owner_token)
                    ).status_code
                    == 204
                )
                for ws in (ctrl_ws, host_ws):
                    ended = _drain_for(ws, "remote_ended")
                    assert ended["session_id"] == sid
                    assert ended["reason"] == "membership_revoked"

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ban_ends_the_remote_session_at_once(ws_app, _auth_signer):
    """Ein Bann, der dem Gebannten noch eine halbe Minute Tastatur auf dem
    Rechner eines Mitglieds laesst, ist kein Bann."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, gid, cid = _setup_remote(
                tc, _auth_signer
            )
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                sid = _open_session(ctrl_ws, host_ws, cid, member_uid)
                resp = tc.put(
                    f"/guilds/{gid}/bans/{member_uid}",
                    json={"reason": "weil"},
                    headers=_auth(owner_token),
                )
                assert resp.status_code == 200
                for ws in (ctrl_ws, host_ws):
                    ended = _drain_for(ws, "remote_ended", max_drained=40)
                    assert ended["session_id"] == sid
                    assert ended["reason"] == "membership_revoked"

    await asyncio.to_thread(_run)


def _request(ws, cid, host_uid) -> None:
    ws.send_json(
        {"op": "remote_request", "channel_id": cid, "host_user_id": str(host_uid)}
    )


def _frames_until_pong(ws, *, max_drained: int = 20) -> list[dict]:
    """Alles, was dieser Socket noch schuldet, bis zum eigenen ``pong``.

    Der Op-Loop arbeitet je Verbindung der Reihe nach ab (``routes/ws_ops.py``),
    ein ``pong`` beweist also, dass die vorher gesendeten Ops fertig sind. Ohne
    diesen Umweg wartet ein Test, der ein bestimmtes Frame erwartet, bei
    kaputtem Code bis ins Zeitlimit statt mit einer Aussage zu scheitern — und
    ein haengender Test sagt niemandem, was falsch ist."""
    ws.send_json({"op": "ping"})
    out: list[dict] = []
    for _ in range(max_drained):
        m = ws.receive_json()
        if m.get("op") == "pong":
            return out
        if m.get("op") in ("presence_update", "hello"):
            continue
        out.append(m)
    raise AssertionError(f"no pong after draining {max_drained}; got {out!r}")


@pytest.mark.asyncio
async def test_decline_starts_a_cooldown_before_the_next_invite(ws_app, _auth_signer):
    """Nach einer Absage darf derselbe Steuernde nicht sofort wieder klingeln —
    sonst kostet das "Nein" nichts und der modale Zustimmungsdialog laesst sich
    beliebig oft vor die Nase des Hosts setzen.

    Der zweite Anlauf laeuft ueber eine ZWEITE Verbindung desselben Steuernden:
    das umgeht die verbindungsgebundene Mindestpause (die sonst schon vorher
    greift) und belegt nebenbei, dass die Sperrfrist am Nutzerpaar haengt und
    nicht am Socket — ein neuer Tab hebt sie nicht auf."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(
                tc, _auth_signer
            )
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                _request(ctrl_ws, cid, member_uid)
                sid = _drain_for(host_ws, "remote_request")["session_id"]
                host_ws.send_json({"op": "remote_respond", "session_id": sid, "accept": False})
                assert _drain_for(ctrl_ws, "remote_response")["accepted"] is False
                # Sofortiger zweiter Anlauf → 4055, und beim Host klingelt nichts.
                with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws2:
                    skip_init_frames(ctrl_ws2)
                    _request(ctrl_ws2, cid, member_uid)
                    assert [f.get("code") for f in _frames_until_pong(ctrl_ws2)] == [4055]
                    ping_barrier(host_ws)

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_controller_is_told_its_pending_session_id(ws_app, _auth_signer):
    """Drahtvertrag: der Steuernde bekommt ``remote_pending``, sobald die
    Sitzung angelegt ist — mit ``session_id``, ``channel_id`` und
    ``host_user_id`` als Strings. Ohne dieses Frame kennt er seine Sitzung erst
    mit der Zustimmung und kann bis dahin weder abbrechen noch eine fremde
    Antwort von seiner eigenen unterscheiden. Der Abbruch danach belegt, dass
    die id sofort benutzbar ist."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(
                tc, _auth_signer
            )
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                _request(ctrl_ws, cid, member_uid)
                antwort = _frames_until_pong(ctrl_ws)
                assert len(antwort) == 1, f"genau ein Frame erwartet, kam {antwort!r}"
                pending = antwort[0]
                assert pending == {
                    "op": "remote_pending",
                    "session_id": pending.get("session_id"),
                    "channel_id": cid,
                    "host_user_id": str(member_uid),
                }
                assert isinstance(pending["session_id"], str) and pending["session_id"]
                assert _drain_for(host_ws, "remote_request")["session_id"] == (
                    pending["session_id"]
                )
                # Mit dieser id kann der Steuernde die wartende Sitzung sofort
                # zuruecknehmen — der Zustimmungsdialog des Hosts verschwindet.
                ctrl_ws.send_json(
                    {"op": "remote_end", "session_id": pending["session_id"]}
                )
                assert _drain_for(host_ws, "remote_canceled")["session_id"] == (
                    pending["session_id"]
                )

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_self_abort_of_a_pending_request_also_starts_the_cooldown(
    ws_app, _auth_signer
):
    """Das Schlupfloch in der Belaestigungsbremse: anfragen, der modale Dialog
    springt auf jedem Host-Tab auf, sofort selbst abbrechen — die Sperrfrist
    wurde nur bei Absage und Aussitzen gesetzt, blieb also null, und das Spiel
    liess sich unbegrenzt wiederholen. Eine wartende Sitzung, die ohne Antwort
    stirbt, zaehlt jetzt wie ein "Nein"."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(
                tc, _auth_signer
            )
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                _request(ctrl_ws, cid, member_uid)
                sid = _drain_for(ctrl_ws, "remote_pending")["session_id"]
                _drain_for(host_ws, "remote_request")
                ctrl_ws.send_json({"op": "remote_end", "session_id": sid})
                _drain_for(host_ws, "remote_canceled")
                # Zweite Verbindung desselben Steuernden (die Mindestpause haengt
                # am Socket, die Sperrfrist am Nutzerpaar) → 4055.
                with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws2:
                    skip_init_frames(ctrl_ws2)
                    _request(ctrl_ws2, cid, member_uid)
                    assert [f.get("code") for f in _frames_until_pong(ctrl_ws2)] == [4055]
                    ping_barrier(host_ws)  # kein zweiter Dialog beim Host

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_request_is_throttled_per_connection(ws_app, _auth_signer):
    """``remote_request`` kostet drei DB-Abfragen und hatte als einziger teurer
    Op auf diesem Socket keine Bremse (``resync``/``typing``/``send`` haben
    laengst eine). Die Mindestpause greift VOR der Rechtepruefung — deshalb
    genuegt hier ein Rufer, der ohnehin abgewiesen wird: die erste Anfrage
    beantwortet die Rechtepruefung (4051), die zweite gar nicht mehr (4056)."""

    def _run():
        with TestClient(ws_app) as tc:
            _, owner_uid, member_token, _, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={member_token}") as ws:
                skip_init_frames(ws)
                _request(ws, cid, owner_uid)
                assert _drain_for(ws, "error")["code"] == 4051
                _request(ws, cid, owner_uid)
                assert [f.get("code") for f in _frames_until_pong(ws)] == [4056]

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_any_host_tab_may_end_the_session(ws_app, _auth_signer):
    """Der Host darf seine Fernsteuerung von JEDEM seiner Tabs beenden — es ist
    sein Rechner. Geprueft wurde bisher die Socket-Identitaet, und ``host_socket``
    ist nur EIN Tab (waehrend der Wartezeit sogar nur der Stellvertreter): jeder
    andere Tab bekam auf ``remote_end`` ein 4053 und konnte nichts abbrechen.
    Mitgeprueft: die Gegenseite haengt an der Rolle — der Steuernde wird
    benachrichtigt, nicht etwa der Host selbst."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(
                tc, _auth_signer
            )
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_a:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_a)
                # Nur host_a ist offen → er ist zweifelsfrei der ``host_socket``.
                sid = _open_session(ctrl_ws, host_a, cid, member_uid)
                with tc.websocket_connect(f"/ws?token={member_token}") as host_b:
                    skip_init_frames(host_b)
                    host_b.send_json({"op": "remote_end", "session_id": sid})
                    # Zuerst der beendende Tab: kein 4053 — und der ``pong``
                    # beweist, dass der Abbau durch ist, bevor wir die anderen
                    # Sockets lesen (sonst haengt der Test bei kaputtem Code).
                    assert _frames_until_pong(host_b) == []
                    ended = _drain_for(ctrl_ws, "remote_ended")
                    assert ended["session_id"] == sid and ended["reason"] == "peer_ended"
                    # Auch der Tab, der zugestimmt hatte, erfaehrt das Ende —
                    # sonst zeigt er weiter eine laufende Fernsteuerung an.
                    assert _drain_for(host_a, "remote_ended")["session_id"] == sid

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_signal_payload_over_the_limit_is_rejected(ws_app, _auth_signer):
    """``remote_signal`` ist derselbe Weiterleiter zum selben Empfaenger wie
    ``remote_input``, hatte aber ausser der globalen Frame-Grenze keine eigene
    Nutzlastgrenze. Die Ablehnung verwirft nur diese Nachricht — die Sitzung
    bleibt stehen, genau wie beim Eingabe-Weiterleiter."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(
                tc, _auth_signer
            )
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                sid = _open_session(ctrl_ws, host_ws, cid, member_uid)
                ctrl_ws.send_json({
                    "op": "remote_signal",
                    "session_id": sid,
                    "kind": "offer",
                    "data": {"sdp": "v=0" + "a" * 9000},
                })
                assert [f.get("code") for f in _frames_until_pong(ctrl_ws)] == [4050]
                ping_barrier(host_ws)  # nichts weitergereicht
                # Ein normal grosses Angebot geht weiter durch.
                ctrl_ws.send_json(
                    {"op": "remote_signal", "session_id": sid, "kind": "offer",
                     "data": {"sdp": "v=0"}}
                )
                assert _drain_for(host_ws, "remote_signal")["data"] == {"sdp": "v=0"}

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_vorrang_signal_reaches_the_controller(ws_app, _auth_signer):
    """Der Vorrang des Hosts ist die einzige Auskunft, die vom HOST zum
    Steuernden laeuft (er meldet, dass er selbst an Maus und Tastatur sitzt).
    Sie reitet auf demselben Weiterleiter wie SDP/ICE — und muss deshalb in
    dessen Pruefliste stehen, sonst holte sich der Host wortlos ein 4050 ab und
    der Steuernde saehe eine Fernsteuerung, die grundlos nicht reagiert.

    Eine erfundene Art bleibt dagegen abgewiesen: die Liste ist eine Liste."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(
                tc, _auth_signer
            )
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                sid = _open_session(ctrl_ws, host_ws, cid, member_uid)
                host_ws.send_json({
                    "op": "remote_signal",
                    "session_id": sid,
                    "kind": "vorrang",
                    "data": {"aktiv": True, "rest_ms": 5000},
                })
                sig = _drain_for(ctrl_ws, "remote_signal")
                assert sig["kind"] == "vorrang"
                assert sig["data"] == {"aktiv": True, "rest_ms": 5000}

                host_ws.send_json({
                    "op": "remote_signal",
                    "session_id": sid,
                    "kind": "erfunden",
                    "data": {"x": 1},
                })
                assert [f.get("code") for f in _frames_until_pong(host_ws)] == [4050]
                ping_barrier(ctrl_ws)  # nichts weitergereicht

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_zeigerform_signal_reaches_the_controller(ws_app, _auth_signer):
    """Die zweite Auskunft in der Gegenrichtung: welche FORM der Zeiger des
    Hosts gerade hat (I-Balken, Groessenpfeil, Hand). Sie ersetzt beim
    Steuernden das, was das Cursor-Echo aus dem Bild nimmt
    (``streaming/win-hq-sidecar/src/remote_input/zeigerform.rs``) — steht sie
    nicht in der Pruefliste, faengt der Host sich je Formwechsel ein 4050 und
    der Steuernde bleibt beim Standardpfeil, ohne dass irgendwo etwas bricht.
    Genau deshalb hier ein Test: ein stiller Ausfall faellt sonst niemandem auf.
    """

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(
                tc, _auth_signer
            )
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                sid = _open_session(ctrl_ws, host_ws, cid, member_uid)
                host_ws.send_json({
                    "op": "remote_signal",
                    "session_id": sid,
                    "kind": "zeiger",
                    "data": {"form": "text"},
                })
                sig = _drain_for(ctrl_ws, "remote_signal")
                assert sig["kind"] == "zeiger"
                assert sig["data"] == {"form": "text"}

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_zeiger_im_bild_signal_reaches_the_controller(ws_app, _auth_signer):
    """Der RUECKFALL zur Formmeldung: kann der Host die Zeigerform gar nicht
    mehr abfragen (macOS liest sie ueber eine von Apple abgekuendigte
    Schnittstelle, die kuenftig immer ``nil`` liefert), legt er seinen Zeiger
    zurueck ins Videobild und meldet das. Der Steuernde blendet daraufhin
    seinen eigenen aus — sonst staenden zwei Zeiger im Bild, und der falsche
    waere der schnellere.

    Steht die Art nicht in der Pruefliste, faellt sie still aus: der Host holt
    sich ein 4050 ab, der Steuernde sieht doppelt und niemand sucht danach.
    Der Gateway deutet die Nutzlast selbst nicht — sie geht unveraendert
    durch (``$lib/remote/zeigerImBild.ts`` prueft sie).
    """

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(
                tc, _auth_signer
            )
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                sid = _open_session(ctrl_ws, host_ws, cid, member_uid)
                host_ws.send_json({
                    "op": "remote_signal",
                    "session_id": sid,
                    "kind": "zeiger_im_bild",
                    "data": {"aktiv": True},
                })
                sig = _drain_for(ctrl_ws, "remote_signal")
                assert sig["kind"] == "zeiger_im_bild"
                assert sig["data"] == {"aktiv": True}

                # Und das Ende des Rueckfalls ebenso — genau diese Meldung gibt
                # dem Steuernden seinen Zeiger zurueck.
                host_ws.send_json({
                    "op": "remote_signal",
                    "session_id": sid,
                    "kind": "zeiger_im_bild",
                    "data": {"aktiv": False},
                })
                assert _drain_for(ctrl_ws, "remote_signal")["data"] == {"aktiv": False}

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_remote_respond_decline(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                ctrl_ws.send_json(
                    {"op": "remote_request", "channel_id": cid, "host_user_id": str(member_uid)}
                )
                sid = _drain_for(host_ws, "remote_request")["session_id"]
                host_ws.send_json({"op": "remote_respond", "session_id": sid, "accept": False})
                resp = _drain_for(ctrl_ws, "remote_response")
                assert resp["session_id"] == sid
                assert resp["accepted"] is False

    await asyncio.to_thread(_run)


def _b64(*data: int) -> str:
    return base64.b64encode(bytes(data)).decode()


# A MouseMoveAbs (0x01) and a MouseButton-down (0x03) frame — the gateway never
# looks inside them, they are only realistic filler.
_MOVE = _b64(0x01, 0x00, 0x80, 0x00, 0x80)
_CLICK = _b64(0x03, 0x00, 0x01)


def _open_session(ctrl_ws, host_ws, cid, host_uid) -> str:
    """Run request → accept and return the id of the now-active session."""
    ctrl_ws.send_json(
        {"op": "remote_request", "channel_id": cid, "host_user_id": str(host_uid)}
    )
    sid = _drain_for(host_ws, "remote_request")["session_id"]
    host_ws.send_json({"op": "remote_respond", "session_id": sid, "accept": True})
    _drain_for(host_ws, "remote_response")
    _drain_for(ctrl_ws, "remote_response")
    return sid


def _send_input(ws, sid, frames, *, slot: object = 0, omit_slot: bool = False) -> None:
    msg = {"op": "remote_input", "session_id": sid, "frames": frames}
    if not omit_slot:
        msg["slot"] = slot
    ws.send_json(msg)


def _assert_input_rejected_but_session_alive(ctrl_ws, host_ws, sid, frames, **kw):
    """The bad message is answered 4050, the host sees nothing of it, and a
    following well-formed message still arrives — the session survived."""
    _send_input(ctrl_ws, sid, frames, **kw)
    assert _drain_for(ctrl_ws, "error")["code"] == 4050
    ping_barrier(host_ws)  # nothing was forwarded
    _send_input(ctrl_ws, sid, [_CLICK])
    assert _drain_for(host_ws, "remote_input")["frames"] == [_CLICK]


@pytest.mark.asyncio
async def test_input_forwarded_unchanged_to_host(ws_app, _auth_signer):
    """Happy path: the controller's frames reach ONLY the host, byte-identical,
    with session_id and slot intact — the gateway does not touch them."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                sid = _open_session(ctrl_ws, host_ws, cid, member_uid)

                _send_input(ctrl_ws, sid, [_MOVE, _CLICK], slot=2)
                got = _drain_for(host_ws, "remote_input")
                assert got == {
                    "op": "remote_input",
                    "session_id": sid,
                    "slot": 2,
                    "frames": [_MOVE, _CLICK],
                }
                # No echo back to the sender.
                ping_barrier(ctrl_ws)

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_input_from_host_rejected(ws_app, _auth_signer):
    """Input is a one-way street: the host is the injector, so input coming
    FROM the host is refused 4053 and never bounced to the controller."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                sid = _open_session(ctrl_ws, host_ws, cid, member_uid)

                _send_input(host_ws, sid, [_MOVE])
                assert _drain_for(host_ws, "error")["code"] == 4053
                ping_barrier(ctrl_ws)  # controller was not fed the host's frames

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_input_on_pending_session_rejected(ws_app, _auth_signer):
    """Consent first: input before the host accepted → 4053, nothing forwarded.
    Same code for an unknown session id."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                ctrl_ws.send_json(
                    {"op": "remote_request", "channel_id": cid, "host_user_id": str(member_uid)}
                )
                sid = _drain_for(host_ws, "remote_request")["session_id"]

                _send_input(ctrl_ws, sid, [_MOVE])
                assert _drain_for(ctrl_ws, "error")["code"] == 4053
                _send_input(ctrl_ws, "deadbeef", [_MOVE])
                assert _drain_for(ctrl_ws, "error")["code"] == 4053
                ping_barrier(host_ws)

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_input_limits_and_malformed_payloads(ws_app, _auth_signer):
    """The four 4050 cases — too many frames, too many decoded bytes, invalid
    base64, missing slot. Each drops only that message; the session stays up
    (a controller that oversteps a limit must not lose its session)."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                sid = _open_session(ctrl_ws, host_ws, cid, member_uid)

                # 33 frames — one over the limit, and far under 1024 bytes, so
                # only the count can be what rejects it.
                _assert_input_rejected_but_session_alive(
                    ctrl_ws, host_ws, sid, [_MOVE] * 33
                )
                # 32 frames × 40 bytes = 1280 decoded — within the frame count,
                # over the byte budget.
                big = base64.b64encode(bytes(40)).decode()
                _assert_input_rejected_but_session_alive(
                    ctrl_ws, host_ws, sid, [big] * 32
                )
                # Not base64 at all.
                _assert_input_rejected_but_session_alive(
                    ctrl_ws, host_ws, sid, ["!!!not base64!!!"]
                )
                # slot is mandatory: without it the host could not tell which of
                # its concurrent streams was meant.
                _assert_input_rejected_but_session_alive(
                    ctrl_ws, host_ws, sid, [_MOVE], omit_slot=True
                )
                # …and a negative or non-integer slot is just as invalid.
                _assert_input_rejected_but_session_alive(
                    ctrl_ws, host_ws, sid, [_MOVE], slot=-1
                )
                _assert_input_rejected_but_session_alive(
                    ctrl_ws, host_ws, sid, [_MOVE], slot="0"
                )
                # Empty frame list carries nothing to inject.
                _assert_input_rejected_but_session_alive(ctrl_ws, host_ws, sid, [])

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_input_with_out_of_range_slot_is_dropped_silently(ws_app, _auth_signer):
    """Ein Platz jenseits der Platzgrenze ist ein UNBEKANNTER Platz (Protokoll
    v2, praezisiert 2026-08-12): still verwerfen, keine Fehlerantwort, Sitzung
    bleibt stehen — sonst genuegt ein ``slot: 999``, um eine laufende
    Fernsteuerung abzuwuergen. Zurechtgebogen wird er auch nicht: ein
    verbogener Platz waere ein Klick auf dem falschen Bildschirm."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _setup_remote(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={owner_token}") as ctrl_ws, \
                 tc.websocket_connect(f"/ws?token={member_token}") as host_ws:
                skip_init_frames(ctrl_ws)
                skip_init_frames(host_ws)
                sid = _open_session(ctrl_ws, host_ws, cid, member_uid)

                _send_input(ctrl_ws, sid, [_MOVE], slot=999)
                ping_barrier(host_ws)  # nichts weitergereicht, auch nicht als slot 0
                ping_barrier(ctrl_ws)  # und keine Fehlerantwort
                # Die Sitzung lebt: der naechste gueltige Platz kommt an.
                _send_input(ctrl_ws, sid, [_CLICK], slot=1)
                got = _drain_for(host_ws, "remote_input")
                assert got["slot"] == 1 and got["frames"] == [_CLICK]

    await asyncio.to_thread(_run)
