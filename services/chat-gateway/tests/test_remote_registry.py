"""Unit tests for the in-process remote-control signaling registry."""

from __future__ import annotations

import asyncio

import pytest
from dcc_chat_gateway.remote_registry import RemoteSession, _RemoteRegistryMixin


class _Reg(_RemoteRegistryMixin):
    """Minimal host class — the mixin needs _lock + _user_conns + init."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._user_conns: dict[int, set] = {}
        self._init_remote_registry()


class _Sock:
    """A fake socket that records what was sent to it."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


@pytest.mark.asyncio
async def test_lifecycle_create_activate_end():
    reg = _Reg()
    host_ws, ctrl_ws = _Sock(), _Sock()
    sess = await reg.remote_create("chan", "10", host_ws, "20", ctrl_ws)
    assert isinstance(sess, RemoteSession)
    assert sess.state == "pending"
    assert reg.remote_get(sess.session_id) is sess

    assert await reg.remote_activate(sess.session_id) is True
    assert reg.remote_get(sess.session_id).state == "active"

    removed = await reg.remote_end(sess.session_id)
    assert removed is sess
    assert reg.remote_get(sess.session_id) is None
    # Ending an unknown / already-ended session is a no-op.
    assert await reg.remote_end(sess.session_id) is None
    assert await reg.remote_activate("nope") is False


@pytest.mark.asyncio
async def test_second_session_per_host_rejected():
    reg = _Reg()
    first = await reg.remote_create("chan", "10", _Sock(), "20", _Sock())
    assert first is not None
    # Same host, different controller → rejected while the first is live.
    assert await reg.remote_create("chan", "10", _Sock(), "30", _Sock()) is None
    # A different host is fine.
    assert await reg.remote_create("chan", "11", _Sock(), "20", _Sock()) is not None
    # After the first ends, the host can be targeted again.
    await reg.remote_end(first.session_id)
    assert await reg.remote_create("chan", "10", _Sock(), "40", _Sock()) is not None


@pytest.mark.asyncio
async def test_sessions_for_socket_finds_both_roles():
    reg = _Reg()
    host_ws, ctrl_ws, other = _Sock(), _Sock(), _Sock()
    sess = await reg.remote_create("chan", "10", host_ws, "20", ctrl_ws)
    assert [s.session_id for s in reg.remote_sessions_for_socket(host_ws)] == [
        sess.session_id
    ]
    assert [s.session_id for s in reg.remote_sessions_for_socket(ctrl_ws)] == [
        sess.session_id
    ]
    assert reg.remote_sessions_for_socket(other) == []


@pytest.mark.asyncio
async def test_user_sockets_lookup():
    reg = _Reg()
    a, b = _Sock(), _Sock()
    reg._user_conns[10] = {a, b}
    assert set(reg.remote_user_sockets(10)) == {a, b}
    assert set(reg.remote_user_sockets("10")) == {a, b}  # str id coerced
    assert reg.remote_user_sockets(999) == []


@pytest.mark.asyncio
async def test_end_if_pending_only_pops_pending():
    reg = _Reg()
    # A pending session is popped and returned.
    sess = await reg.remote_create("chan", "10", _Sock(), "20", _Sock())
    removed = await reg.remote_end_if_pending(sess.session_id)
    assert removed is sess
    assert reg.remote_get(sess.session_id) is None
    # An ACTIVE session is left untouched (a decline can't tear it down).
    sess2 = await reg.remote_create("chan", "11", _Sock(), "20", _Sock())
    await reg.remote_activate(sess2.session_id)
    assert await reg.remote_end_if_pending(sess2.session_id) is None
    assert reg.remote_get(sess2.session_id).state == "active"
    # An unknown session → None, no crash.
    assert await reg.remote_end_if_pending("nope") is None


@pytest.mark.asyncio
async def test_user_has_session_for_both_peers():
    reg = _Reg()
    assert reg.remote_user_has_session("10") is False
    sess = await reg.remote_create("chan", "10", _Sock(), "20", _Sock())
    # Host and controller both count as being in a session; a bystander doesn't.
    assert reg.remote_user_has_session("10") is True  # host
    assert reg.remote_user_has_session(20) is True  # controller, int id coerced
    assert reg.remote_user_has_session("30") is False
    # Ending the session clears it for both.
    await reg.remote_end(sess.session_id)
    assert reg.remote_user_has_session("10") is False
    assert reg.remote_user_has_session("20") is False


@pytest.mark.asyncio
async def test_pending_timeout_notifies_controller_and_drops():
    reg = _Reg()
    ctrl_ws = _Sock()
    sess = await reg.remote_create("chan", "10", _Sock(), "20", ctrl_ws)
    reg.remote_schedule_timeout(sess.session_id, ctrl_ws, delay=0.02)
    await asyncio.sleep(0.05)
    assert reg.remote_get(sess.session_id) is None
    assert ctrl_ws.sent == [
        {"op": "remote_ended", "session_id": sess.session_id, "reason": "timeout"}
    ]


@pytest.mark.asyncio
async def test_pending_timeout_dismisses_every_host_tab():
    """Der Ablauf der Zustimmungsfrist muss AUCH die Dialoge des Hosts
    abraeumen. Bleibt einer stehen, verwirft das Frontend (phase != 'idle')
    jede weitere Einladung still — der Host waere danach fuer alle
    unerreichbar, und sein spaeteres "Zulassen" liefe in 4053."""
    reg = _Reg()
    ctrl_ws, host_a, host_b = _Sock(), _Sock(), _Sock()
    reg._user_conns[10] = {host_a, host_b}
    sess = await reg.remote_create("chan", "10", host_a, "20", ctrl_ws)
    reg.remote_schedule_timeout(sess.session_id, ctrl_ws, delay=0.02)
    await asyncio.sleep(0.05)
    cancel = {"op": "remote_canceled", "session_id": sess.session_id}
    assert host_a.sent == [cancel]
    assert host_b.sent == [cancel]
    assert ctrl_ws.sent == [
        {"op": "remote_ended", "session_id": sess.session_id, "reason": "timeout"}
    ]


@pytest.mark.asyncio
async def test_timeout_pops_atomically_not_check_then_end():
    """Der Zeitgeber darf die Sitzung nur ueber den atomaren
    ``remote_end_if_pending`` abraeumen. Mit lesen-dann-entfernen liegt
    zwischen Pruefung und ``await`` ein Fenster, in dem ein Accept gewinnt —
    der Zeitgeber entfernte dann eine AKTIVE Sitzung."""

    class _NoPlainEnd(_Reg):
        async def remote_end(self, session_id):
            raise AssertionError("timeout must use remote_end_if_pending")

    reg = _NoPlainEnd()
    ctrl_ws = _Sock()
    sess = await reg.remote_create("chan", "10", _Sock(), "20", ctrl_ws)
    reg.remote_schedule_timeout(sess.session_id, ctrl_ws, delay=0.02)
    await asyncio.sleep(0.05)
    # Kam der Zeitgeber ueber den atomaren Weg, ist die Sitzung sauber weg und
    # der Steuernde benachrichtigt; sonst haette die Zusicherung oben zugeschlagen.
    assert reg.remote_get(sess.session_id) is None
    assert ctrl_ws.sent[-1]["reason"] == "timeout"


@pytest.mark.asyncio
async def test_refusal_cooldown_after_decline_and_timeout():
    reg = _Reg()
    assert reg.remote_refusal_wait_s("10", "20") == 0.0
    reg.remote_note_refused("10", "20")
    assert 0.0 < reg.remote_refusal_wait_s("10", "20") <= 30.0
    # Paar-genau: ein anderer Steuernder ist von der Absage nicht betroffen.
    assert reg.remote_refusal_wait_s("10", "21") == 0.0
    assert reg.remote_refusal_wait_s("11", "20") == 0.0
    # Auch das Aussitzen zaehlt als Absage — sonst waere der Zeitablauf der
    # billigste Weg, den Dialog erneut aufzuziehen.
    ctrl_ws = _Sock()
    sess = await reg.remote_create("chan", "30", _Sock(), "40", ctrl_ws)
    reg.remote_schedule_timeout(sess.session_id, ctrl_ws, delay=0.02)
    await asyncio.sleep(0.05)
    assert reg.remote_refusal_wait_s("30", "40") > 0.0


@pytest.mark.asyncio
async def test_terminate_notifies_both_peers_of_an_active_session():
    reg = _Reg()
    host_ws, ctrl_ws = _Sock(), _Sock()
    reg._user_conns[10] = {host_ws}
    sess = await reg.remote_create("chan", "10", host_ws, "20", ctrl_ws)
    await reg.remote_activate(sess.session_id)
    removed = await reg.remote_terminate(sess.session_id, "membership_revoked")
    assert removed is sess
    ended = {
        "op": "remote_ended",
        "session_id": sess.session_id,
        "reason": "membership_revoked",
    }
    assert host_ws.sent == [ended]
    assert ctrl_ws.sent == [ended]
    # Idempotent — ein zweiter Abbau findet nichts mehr vor.
    assert await reg.remote_terminate(sess.session_id, "membership_revoked") is None


@pytest.mark.asyncio
async def test_terminate_of_a_pending_session_clears_the_dialogs():
    """Solange die Sitzung wartet, hat der Host keinen Kanal, sondern einen
    Dialog — den raeumt ``remote_canceled`` ab, und zwar auf JEDEM Tab."""
    reg = _Reg()
    host_a, host_b, ctrl_ws = _Sock(), _Sock(), _Sock()
    reg._user_conns[10] = {host_a, host_b}
    sess = await reg.remote_create("chan", "10", host_a, "20", ctrl_ws)
    await reg.remote_terminate(sess.session_id, "membership_revoked")
    cancel = {"op": "remote_canceled", "session_id": sess.session_id}
    assert host_a.sent == [cancel] and host_b.sent == [cancel]
    assert ctrl_ws.sent[-1]["reason"] == "membership_revoked"


@pytest.mark.asyncio
async def test_session_age_is_readable():
    """``created_at`` wird gelesen — die Rechte-Wache haengt ihre absolute
    Sitzungsdauer daran."""
    reg = _Reg()
    sess = await reg.remote_create("chan", "10", _Sock(), "20", _Sock())
    assert sess.age_s() >= 0.0
    assert sess.age_s(now_ms=sess.created_at + 5000) == pytest.approx(5.0)


@pytest.mark.asyncio
async def test_cancel_timeout_prevents_expiry():
    reg = _Reg()
    ctrl_ws = _Sock()
    sess = await reg.remote_create("chan", "10", _Sock(), "20", ctrl_ws)
    reg.remote_schedule_timeout(sess.session_id, ctrl_ws, delay=0.05)
    reg.remote_cancel_timeout(sess.session_id)
    await reg.remote_activate(sess.session_id)
    await asyncio.sleep(0.08)
    # Session survives, controller was never told it timed out.
    assert reg.remote_get(sess.session_id).state == "active"
    assert ctrl_ws.sent == []


@pytest.mark.asyncio
async def test_timeout_no_op_when_already_active():
    reg = _Reg()
    ctrl_ws = _Sock()
    sess = await reg.remote_create("chan", "10", _Sock(), "20", ctrl_ws)
    await reg.remote_activate(sess.session_id)
    # Timer fires but the session is no longer pending → left untouched.
    reg.remote_schedule_timeout(sess.session_id, ctrl_ws, delay=0.02)
    await asyncio.sleep(0.05)
    assert reg.remote_get(sess.session_id).state == "active"
    assert ctrl_ws.sent == []
