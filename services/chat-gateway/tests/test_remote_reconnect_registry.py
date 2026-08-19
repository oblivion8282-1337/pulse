"""Unit tests for the disconnect-grace mixin (`remote_reconnect_registry.py`).

Same style as `test_remote_registry.py` — a minimal host class, no Redis, no
WS harness. Runs standalone (`uv run --all-packages pytest
services/chat-gateway/tests/test_remote_reconnect_registry.py`), unlike the
WS-level tests in `test_remote_handlers.py` which need a live Redis for the
`ws_app` fixture.
"""

from __future__ import annotations

import asyncio

import pytest
from dcc_chat_gateway.remote_reconnect_registry import _RemoteReconnectMixin
from dcc_chat_gateway.remote_registry import _RemoteRegistryMixin


class _Reg(_RemoteRegistryMixin, _RemoteReconnectMixin):
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._user_conns: dict[int, set] = {}
        self._init_remote_registry()
        self._init_remote_reconnect()


class _Sock:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


async def _active_session(reg: _Reg) -> tuple:
    host_ws, ctrl_ws = _Sock(), _Sock()
    sess = await reg.remote_create("chan", "10", host_ws, "20", ctrl_ws)
    await reg.remote_activate(sess.session_id)
    return sess, host_ws, ctrl_ws


@pytest.mark.asyncio
async def test_grace_expires_and_calls_on_expired_when_nobody_reclaims():
    reg = _Reg()
    sess, host_ws, _ = await _active_session(reg)
    calls: list[tuple[str, str]] = []

    async def on_expired(session_id: str, role: str) -> None:
        calls.append((session_id, role))

    reg.remote_schedule_disconnect_grace(sess.session_id, "host", on_expired, delay=0.02)
    # Sofort danach ist noch nichts passiert — die Frist läuft erst.
    assert calls == []
    assert reg.remote_disconnect_grace_role(sess.session_id) == "host"
    await asyncio.sleep(0.05)
    assert calls == [(sess.session_id, "host")]
    # Der Zeitgeber räumt sich nach dem Feuern selbst ab.
    assert reg.remote_disconnect_grace_role(sess.session_id) is None


@pytest.mark.asyncio
async def test_reclaim_within_grace_cancels_expiry_and_swaps_socket():
    reg = _Reg()
    sess, host_ws, ctrl_ws = await _active_session(reg)
    calls: list[tuple[str, str]] = []

    async def on_expired(session_id: str, role: str) -> None:
        calls.append((session_id, role))

    reg.remote_schedule_disconnect_grace(sess.session_id, "host", on_expired, delay=0.05)
    new_host_ws = _Sock()
    reclaimed = await reg.remote_reclaim(sess.session_id, "host", "10", new_host_ws)
    assert reclaimed is sess
    assert reg.remote_get(sess.session_id).host_socket is new_host_ws
    assert reg.remote_disconnect_grace_role(sess.session_id) is None
    # Genug warten, dass der ALTE Zeitgeber laengst gefeuert hätte — er darf es
    # nicht mehr: `remote_reclaim` hat ihn abgebrochen.
    await asyncio.sleep(0.1)
    assert calls == [], "ein erfolgreicher Reclaim darf den Abbau nicht mehr auslösen"


@pytest.mark.asyncio
async def test_reclaim_wrong_role_fails():
    reg = _Reg()
    sess, host_ws, ctrl_ws = await _active_session(reg)

    async def on_expired(_sid: str, _role: str) -> None:
        pass

    reg.remote_schedule_disconnect_grace(sess.session_id, "host", on_expired, delay=1.0)
    # Der CONTROLLER versucht, die Gnadenfrist des HOSTS für sich zu beanspruchen.
    assert await reg.remote_reclaim(sess.session_id, "controller", "20", _Sock()) is None
    # Der richtige Nutzer, aber die falsche Rolle behauptet — ebenfalls nein.
    assert await reg.remote_reclaim(sess.session_id, "controller", "10", _Sock()) is None
    # Die Frist läuft unbeeinflusst weiter.
    assert reg.remote_disconnect_grace_role(sess.session_id) == "host"


@pytest.mark.asyncio
async def test_reclaim_wrong_user_fails():
    reg = _Reg()
    sess, host_ws, ctrl_ws = await _active_session(reg)

    async def on_expired(_sid: str, _role: str) -> None:
        pass

    reg.remote_schedule_disconnect_grace(sess.session_id, "host", on_expired, delay=1.0)
    # Der richtige Nutzer waere "10" — ein anderer darf die Rolle nicht kapern.
    assert await reg.remote_reclaim(sess.session_id, "host", "999", _Sock()) is None
    assert reg.remote_get(sess.session_id).host_socket is host_ws  # unverändert


@pytest.mark.asyncio
async def test_reclaim_without_a_running_grace_fails():
    reg = _Reg()
    sess, host_ws, ctrl_ws = await _active_session(reg)
    # Niemand ist abgerissen — ein Reclaim-Versuch ins Leere.
    assert await reg.remote_reclaim(sess.session_id, "host", "10", _Sock()) is None


@pytest.mark.asyncio
async def test_reclaim_unknown_session_fails():
    reg = _Reg()
    assert await reg.remote_reclaim("nope", "host", "10", _Sock()) is None


@pytest.mark.asyncio
async def test_repeated_disconnect_restarts_the_grace_window():
    """Eine flatternde Verbindung bekommt bei jedem Abriss die VOLLE Frist,
    nicht eine schrumpfende — genau das im Log vom 2026-08-19 beobachtete
    Muster (mehrere Abrisse binnen Sekunden)."""
    reg = _Reg()
    sess, _, _ = await _active_session(reg)
    calls: list[tuple[str, str]] = []

    async def on_expired(session_id: str, role: str) -> None:
        calls.append((session_id, role))

    reg.remote_schedule_disconnect_grace(sess.session_id, "host", on_expired, delay=0.05)
    await asyncio.sleep(0.03)
    # Zweiter Abriss VOR Ablauf der ersten Frist — die Uhr wird neu gestellt.
    reg.remote_schedule_disconnect_grace(sess.session_id, "host", on_expired, delay=0.05)
    await asyncio.sleep(0.03)
    # Zum Zeitpunkt, zu dem die ERSTE Frist abgelaufen wäre (0.03 + 0.03 = 0.06
    # > 0.05), darf noch nichts passiert sein.
    assert calls == []
    await asyncio.sleep(0.05)
    assert calls == [(sess.session_id, "host")]


@pytest.mark.asyncio
async def test_cancel_disconnect_grace_only_matching_role():
    reg = _Reg()
    sess, _, _ = await _active_session(reg)

    async def on_expired(_sid: str, _role: str) -> None:
        pass

    reg.remote_schedule_disconnect_grace(sess.session_id, "host", on_expired, delay=1.0)
    # Abbrechen mit der FALSCHEN Rolle wirkt nicht.
    reg.remote_cancel_disconnect_grace(sess.session_id, role="controller")
    assert reg.remote_disconnect_grace_role(sess.session_id) == "host"
    # Mit der richtigen Rolle schon.
    reg.remote_cancel_disconnect_grace(sess.session_id, role="host")
    assert reg.remote_disconnect_grace_role(sess.session_id) is None


@pytest.mark.asyncio
async def test_stale_expiry_task_noop_after_being_superseded():
    """Der ALTE Zeitgeber-Task darf nicht abbauen, nachdem ihn ein neuerer
    Abriss (oder ein Reclaim) schon abgelöst hat — geprüft direkt an der
    Task-Identität, wie `_remote_timeout`/`_host_end_after_grace` es tun."""
    reg = _Reg()
    sess, _, _ = await _active_session(reg)
    calls: list[str] = []

    async def alter_on_expired(_sid: str, _role: str) -> None:
        calls.append("alt")

    async def neuer_on_expired(_sid: str, _role: str) -> None:
        calls.append("neu")

    reg.remote_schedule_disconnect_grace(sess.session_id, "host", alter_on_expired, delay=0.03)
    alter_task = reg._remote_disconnect_timers[sess.session_id][1]
    # Neuer Abriss derselben Rolle VOR Ablauf des ersten — ersetzt den Timer.
    await asyncio.sleep(0.01)
    reg.remote_schedule_disconnect_grace(sess.session_id, "host", neuer_on_expired, delay=0.03)
    assert reg._remote_disconnect_timers[sess.session_id][1] is not alter_task
    await asyncio.sleep(0.05)
    assert calls == ["neu"], "nur der neue Zeitgeber darf feuern"
