"""Broadcast-Test für Tamagotchi PR3.

Verifiziert den End-to-End-Pfad:

  WS-Op ``tamagotchi:feed`` (Client → Server)
    → State-Mutate in chat.guild_plugin_state
    → Redis-Publish auf ``plugin:tamagotchi:events``
    → Channel-Handler im ConnectionManager
    → WS-Frame ``tamagotchi:state_update`` (Server → Client)

Wir prüfen, dass eine zweite Connection in derselben Guild den
Broadcast empfängt. Nicht-Mitglieder dürfen den Frame NICHT
sehen (Guild-Filter via ``_ws_guilds``).
"""

from __future__ import annotations

import asyncio
import os
import random

import pytest
import pytest_asyncio
from redis.asyncio import Redis
from starlette.testclient import TestClient

from dcc_chat_gateway.models import InstancePluginAllowlist, GuildPlugin

_REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6380/0")


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest_asyncio.fixture
async def redis() -> Redis:
    r = Redis.from_url(_REDIS_URL, decode_responses=False)
    yield r
    await r.aclose()


def _setup_guild_with_tamagotchi(tc: TestClient, signer) -> tuple[str, str, int]:
    """Erstellt User + Guild + Allowlist-Eintrag + Guild-Toggle, gibt
    (token, guild_id_str, user_id) zurück. Direkt-Inserts in die Tabellen
    umgehen die Admin-Discovery, was im Test-Lauf einfacher ist.

    **Wichtig**: ``app.state.plugin_allowlist`` ist ein Snapshot, der
    in der Lifespan einmal aus der DB gelesen wird — der lebt parallel
    zur DB-Row. Wir patchen ihn direkt, damit der WS-Op-Gate Tamagotchi
    durchlässt.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    uid = random.randint(1, 1_000_000)
    token = signer.issue_access(uid, f"u{uid}")
    g = tc.post("/guilds", json={"name": "g"}, headers=_auth(token)).json()
    gid = g["id"]

    from dcc_chat_gateway.config import get_settings

    db_url = get_settings().database_url.replace("+aiosqlite", "")
    eng = create_engine(db_url, future=True)
    try:
        with Session(eng) as s:
            s.merge(
                InstancePluginAllowlist(
                    plugin_name="tamagotchi", added_by_user_id=None
                )
            )
            s.merge(
                GuildPlugin(
                    guild_id=int(gid),
                    plugin_name="tamagotchi",
                    enabled=True,
                    enabled_by_user_id=uid,
                )
            )
            s.commit()
    finally:
        eng.dispose()

    # Snapshot-Patch + Cache-Reset, damit der Gate den DB-Stand neu liest.
    tc.app.state.plugin_allowlist = frozenset({"hello", "tamagotchi"})
    from dcc_chat_gateway.plugins.ws_op_gate import _clear_cache

    _clear_cache()

    # Tamagotchi-Plugin nach-aktivieren: der Lifespan-Loader hatte
    # tamagotchi im "discovered but not allowed"-Topf, weil der DB-Seed
    # erst hier oben passiert. ``PluginManager.activate`` läuft idempotent
    # und registriert die ws_ops + den Channel-Handler. Zusätzlich
    # subscriben wir den Plugin-Channel, damit der Broadcast den Listener
    # erreicht.
    import asyncio

    from dcc_chat_gateway.plugins.registry import get_manager

    mgr = get_manager()
    rec = mgr.get("tamagotchi")
    if rec is not None and not rec.activated:
        mgr.activate("tamagotchi")
    cm = tc.app.state.connection_manager

    async def _subscribe():
        await cm.subscribe_plugin_channels(
            list(rec.manifest.uses.channels) if rec else []
        )

    # Wir laufen im sync-Threadkontext (TestClient); subscriben über das
    # Event-Loop des ConnectionManagers.
    fut = asyncio.run_coroutine_threadsafe(_subscribe(), cm._listener_task.get_loop())
    fut.result(timeout=5.0)

    return token, gid, uid


@pytest.mark.asyncio
async def test_state_update_broadcasts_to_same_guild(ws_app, _auth_signer):
    """User A klickt ``feed``; eine zweite WS-Connection (anderer User,
    selbe Guild) empfängt den ``tamagotchi:state_update``-Frame."""

    def _run():
        with TestClient(ws_app) as tc:
            token_a, gid, _ = _setup_guild_with_tamagotchi(tc, _auth_signer)
            # User B als Member hinzufügen — direkt-Insert in
            # guild_members + ihm einen Token geben.
            uid_b = random.randint(1_000_001, 2_000_000)
            token_b = _auth_signer.issue_access(uid_b, f"u{uid_b}")

            from sqlalchemy import create_engine
            from sqlalchemy.orm import Session
            from dcc_chat_gateway.config import get_settings
            from dcc_chat_gateway.models import GuildMember

            db_url = get_settings().database_url.replace("+aiosqlite", "")
            eng = create_engine(db_url, future=True)
            try:
                with Session(eng) as s:
                    s.add(GuildMember(guild_id=int(gid), user_id=uid_b))
                    s.commit()
            finally:
                eng.dispose()

            # Beide WS-Connections aufbauen.
            with tc.websocket_connect(f"/ws?token={token_a}") as ws_a:
                ws_a.receive_json()  # ready
                with tc.websocket_connect(f"/ws?token={token_b}") as ws_b:
                    ws_b.receive_json()  # ready
                    # presence_update von B könnte A noch sehen — wir
                    # filtern unten gezielt nach tamagotchi:state_update.

                    # User A schickt feed. Backend mutiert + broadcastet.
                    ws_a.send_json(
                        {"op": "tamagotchi:feed", "guild_id": str(gid)}
                    )

                    # User B muss den state_update empfangen.
                    found = _receive_until(ws_b, "tamagotchi:state_update")
                    assert found is not None, "user B never got the state_update"
                    assert found["guild_id"] == str(gid)
                    assert isinstance(found["state"], dict)
                    assert found["state"]["hunger"] == 100  # 80+20

                    # User A erhält denselben Broadcast (Server ist
                    # source-of-truth; eigener Broadcast kommt zurück).
                    found_a = _receive_until(ws_a, "tamagotchi:state_update")
                    assert found_a is not None
                    assert found_a["state"]["hunger"] == 100

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_state_update_not_delivered_to_outsider(ws_app, _auth_signer):
    """Ein User in einer anderen Guild empfängt den Broadcast NICHT
    (``_ws_guilds``-Filter)."""

    def _run():
        with TestClient(ws_app) as tc:
            token_a, gid_a, _ = _setup_guild_with_tamagotchi(tc, _auth_signer)
            # User B in einer COMPLETELY OTHER Guild.
            uid_b = random.randint(1_000_001, 2_000_000)
            token_b = _auth_signer.issue_access(uid_b, f"u{uid_b}")
            g_b = tc.post(
                "/guilds", json={"name": "other"}, headers=_auth(token_b)
            ).json()
            assert g_b["id"] != gid_a

            with tc.websocket_connect(f"/ws?token={token_a}") as ws_a:
                ws_a.receive_json()  # ready
                with tc.websocket_connect(f"/ws?token={token_b}") as ws_b:
                    ws_b.receive_json()  # ready

                    ws_a.send_json(
                        {"op": "tamagotchi:feed", "guild_id": str(gid_a)}
                    )
                    # User A erhält den state_update (eigene Guild).
                    found_a = _receive_until(ws_a, "tamagotchi:state_update")
                    assert found_a is not None

                    # User B darf den Frame NICHT sehen — bis zu 1s
                    # warten, dann muss saw_target=False sein.
                    leaked = _drain_for(ws_b, "tamagotchi:state_update", 1.0)
                    assert not leaked, "outsider got state_update"

    await asyncio.to_thread(_run)


def _receive_until(ws, target_op: str, max_frames: int = 10):
    """Receive bis target_op-Frame ankommt oder max_frames erschöpft."""
    for _ in range(max_frames):
        try:
            m = ws.receive_json()
        except Exception:
            return None
        if m.get("op") == target_op:
            return m
    return None


def _drain_for(ws, target_op: str, max_wait_s: float = 1.0) -> bool:
    """Lese non-blocking Frames für ``max_wait_s`` und gebe True zurück,
    wenn ``target_op`` darin auftauchte. False = der Op kam nicht.

    starlette.testclient.WebSocketTestSession hält intern eine
    ``anyio.from_thread.BlockingPortal`` + Queue. ``receive_json()``
    pollt ohne Timeout — also splitten wir per Thread und harten
    Cancel: wir warten max_wait_s, dann brechen wir den Thread *nicht*
    sauber ab (Python kann das nicht), sondern lassen ihn als Daemon
    laufen und der TestClient-shutdown bricht ihn implizit ab.
    """
    import threading

    found = threading.Event()
    saw_target = [False]

    def _worker():
        # Wir lesen N Frames; sobald target_op kommt, setzen wir saw_target.
        for _ in range(20):
            try:
                m = ws.receive_json()
            except Exception:
                return
            if m.get("op") == target_op:
                saw_target[0] = True
                found.set()
                return
        found.set()

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    found.wait(timeout=max_wait_s)
    return saw_target[0]
