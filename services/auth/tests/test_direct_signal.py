"""Tests für das Signal-Relay des Direktpfads (Phase 3):
SignalHub-Unit-Tests + WS/Offer-Integration über starlette TestClient.

Der TestClient läuft in einem eigenen Event-Loop → file-backed SQLite
(Muster: chat-gateway ``ws_app``-Fixture)."""

from __future__ import annotations

import asyncio
import secrets
import threading

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import create_async_engine
from starlette.testclient import TestClient

from dcc_auth.direct_signal import InstanceOffline, OfferTimeout, SignalHub
from dcc_auth.models import Base
from dcc_auth.relay import generate_relay_token, hash_relay_token

# ---------------------------------------------------------------------------
# SignalHub — Unit
# ---------------------------------------------------------------------------


class _FakeWs:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)


async def test_hub_offer_answer_roundtrip():
    hub = SignalHub()
    ws = _FakeWs()
    hub.register(1, ws)

    async def answer_when_offer_arrives():
        while not ws.sent:
            await asyncio.sleep(0.01)
        cid = ws.sent[0]["connection_id"]
        assert hub.resolve_answer(cid, "ANSWER-SDP") is True

    task = asyncio.create_task(answer_when_offer_arrives())
    answer = await hub.relay_offer(1, "OFFER-SDP", timeout_s=2.0)
    await task
    assert answer == "ANSWER-SDP"
    assert ws.sent[0]["t"] == "offer"
    assert ws.sent[0]["sdp"] == "OFFER-SDP"


async def test_hub_offline_and_timeout():
    hub = SignalHub()
    with pytest.raises(InstanceOffline):
        await hub.relay_offer(1, "x", timeout_s=0.1)
    ws = _FakeWs()
    hub.register(1, ws)
    with pytest.raises(OfferTimeout):
        await hub.relay_offer(1, "x", timeout_s=0.05)
    # Nach dem Timeout ist die Pending-Map leer → späte Answer verpufft.
    assert hub.resolve_answer(ws.sent[0]["connection_id"], "late") is False


async def test_hub_reconnect_replaces_and_stale_unregister_is_noop():
    hub = SignalHub()
    old, new = _FakeWs(), _FakeWs()
    hub.register(1, old)
    hub.register(1, new)
    hub.unregister(1, old)  # Disconnect-Handler des ALTEN Sockets
    assert hub.is_connected(1) is True
    hub.unregister(1, new)
    assert hub.is_connected(1) is False


# ---------------------------------------------------------------------------
# WS + Offer — Integration (TestClient, file-backed SQLite)
# ---------------------------------------------------------------------------

_INSTANCE_ID = 22000000000000001
_REG = {
    "username": "sig_alice",
    "email": "sig_alice@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Alice",
}


@pytest_asyncio.fixture
async def signal_env(tmp_path, _isolate_settings):
    """File-backed DB + geseedete Instanz; liefert (app, token)."""
    _isolate_settings.database_url = f"sqlite+aiosqlite:///{tmp_path / 'signal.db'}"
    token = generate_relay_token()

    engine = create_async_engine(_isolate_settings.database_url, future=True)
    async with engine.begin() as conn:
        for table in Base.metadata.tables.values():
            table.schema = None
        await conn.run_sync(Base.metadata.create_all)
        await conn.exec_driver_sql("INSERT INTO auth_settings (id) VALUES (1)")
        await conn.exec_driver_sql("INSERT INTO smtp_settings (id) VALUES (1)")
    await engine.dispose()

    from dcc_auth.app import create_app
    from dcc_auth.db import get_session

    app = create_app()

    # Engine LAZY im Event-Loop des TestClients erzeugen (aiosqlite-Objekte
    # sind loop-gebunden; die pytest-Loop-Engine wäre dort unbrauchbar).
    state: dict = {}

    async def _override_get_session():
        if "factory" not in state:
            from sqlalchemy.ext.asyncio import async_sessionmaker

            eng = create_async_engine(_isolate_settings.database_url, future=True)
            state["factory"] = async_sessionmaker(eng, expire_on_commit=False)
        async with state["factory"]() as session:
            yield session

    app.dependency_overrides[get_session] = _override_get_session
    yield {"app": app, "token": token}


def _seed_instance_and_membership(db_url: str, token: str, user_id: int | None) -> None:
    """Instanz (+ optional Membership) synchron über eine frische Engine seeden."""

    async def _run() -> None:
        engine = create_async_engine(db_url, future=True)
        from sqlalchemy import text

        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO registered_instances (id, hostname, client_id,"
                    " client_secret, worker_id_chat, worker_id_voice, worker_id_media,"
                    " status, origin, registered_by, relay_tunnel_token_hash)"
                    " VALUES (:iid, 'sig.example.com', :cid, 'x', 810, 811, 812,"
                    " 'active', 'app_host', :uid, :th)"
                ),
                {
                    "iid": _INSTANCE_ID,
                    "cid": f"ci_{secrets.token_hex(6)}",
                    "uid": user_id or 1,
                    "th": hash_relay_token(token),
                },
            )
            if user_id is not None:
                await conn.execute(
                    text(
                        "INSERT INTO user_instance_memberships (user_id, instance_id,"
                        " role, notification_mode) VALUES (:uid, :iid, 'owner', 'mentions')"
                    ),
                    {"uid": user_id, "iid": _INSTANCE_ID},
                )
        await engine.dispose()

    asyncio.run(_run())


def _login(client: TestClient) -> tuple[str, int]:
    client.post("/register", json=_REG)
    r = client.post(
        "/login", json={"email_or_username": _REG["email"], "password": _REG["password"]}
    )
    assert r.status_code == 200, r.text
    sid = r.cookies.get("pulse_session")
    me = client.get("/me", headers={"Cookie": f"pulse_session={sid}"})
    return f"pulse_session={sid}", int(me.json()["id"])


def test_ws_bad_token_closed_4001(signal_env, _isolate_settings):
    with TestClient(signal_env["app"]) as client:
        _seed_instance_and_membership(_isolate_settings.database_url, signal_env["token"], None)
        with client.websocket_connect("/selfhost/directory/ws") as ws:
            ws.send_json({"instance_id": str(_INSTANCE_ID), "token": "plse_relay_wrong"})
            # Server schließt mit 4001 → receive wirft.
            with pytest.raises(Exception):
                ws.receive_json()


def test_offer_without_connected_instance_409(signal_env, _isolate_settings):
    with TestClient(signal_env["app"]) as client:
        cookie, uid = _login(client)
        _seed_instance_and_membership(_isolate_settings.database_url, signal_env["token"], uid)
        r = client.post(
            f"/me/instances/{_INSTANCE_ID}/direct-offer",
            json={"sdp": "v=0 OFFER"},
            headers={"Cookie": cookie},
        )
        assert r.status_code == 409


def test_offer_without_membership_404(signal_env, _isolate_settings):
    with TestClient(signal_env["app"]) as client:
        cookie, _uid = _login(client)
        _seed_instance_and_membership(_isolate_settings.database_url, signal_env["token"], None)
        r = client.post(
            f"/me/instances/{_INSTANCE_ID}/direct-offer",
            json={"sdp": "v=0 OFFER"},
            headers={"Cookie": cookie},
        )
        assert r.status_code == 404


def test_ws_offer_answer_full_roundtrip(signal_env, _isolate_settings):
    """Client-POST und Server-App-WS gleichzeitig: Offer rein, Answer zurück."""
    with TestClient(signal_env["app"]) as client:
        cookie, uid = _login(client)
        _seed_instance_and_membership(_isolate_settings.database_url, signal_env["token"], uid)

        with client.websocket_connect("/selfhost/directory/ws") as ws:
            ws.send_json({"instance_id": str(_INSTANCE_ID), "token": signal_env["token"]})
            assert ws.receive_json() == {"t": "ready"}

            result: dict = {}

            def post_offer() -> None:
                result["response"] = client.post(
                    f"/me/instances/{_INSTANCE_ID}/direct-offer",
                    json={"sdp": "v=0 OFFER"},
                    headers={"Cookie": cookie},
                )

            poster = threading.Thread(target=post_offer)
            poster.start()
            offer = ws.receive_json()
            assert offer["t"] == "offer"
            assert offer["sdp"] == "v=0 OFFER"
            ws.send_json(
                {"t": "answer", "connection_id": offer["connection_id"], "sdp": "v=0 ANSWER"}
            )
            poster.join(timeout=10)
            assert not poster.is_alive()

        r = result["response"]
        assert r.status_code == 200, r.text
        assert r.json()["sdp"] == "v=0 ANSWER"
