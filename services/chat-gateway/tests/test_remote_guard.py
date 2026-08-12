"""Rechte-Wache der Fernsteuerung (``remote_guard``).

Deckt die zweite Haelfte des Vertrags ab (Wire-Protokoll v2, "Sicherheit und
Robustheit"): Rechte werden nicht nur beim Aufbau geprueft. Ohne die Wache
ueberlebt eine laufende Sitzung Rollenentzug und Kanal-Overwrite bis der
Zugangstoken abgelaufen ist — 15 Minuten Tastatur auf fremdem Rechner.

Die Rechteabfrage selbst (``peer_channel_perms``) wird ersetzt: sie ist im
Aufbau-Pfad bereits durch die WS-Tests gedeckt, und hier geht es um die
Entscheidung *nach* der Abfrage.
"""

from __future__ import annotations

import asyncio

import pytest
from dcc_chat_gateway import remote_guard
from dcc_chat_gateway.remote_registry import _RemoteRegistryMixin
from dcc_shared.permissions import Permissions

ALLOWED = Permissions.VIEW_CHANNEL | Permissions.REMOTE_CONTROL


class _Sock:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


class _User:
    def __init__(self, uid: int) -> None:
        self.id = uid


class _FakeResult:
    def __init__(self, ids: list[int]) -> None:
        self._ids = ids

    def scalars(self):
        return self._ids


class _FakeSession:
    """Steht nur fuer die eine ``select(Channel.id)``-Abfrage im Rauswurf-Pfad."""

    def __init__(self, channel_ids: list[int] | None = None) -> None:
        self.channel_ids = channel_ids or []

    async def execute(self, _stmt):
        return _FakeResult(self.channel_ids)


class _Factory:
    def __init__(self, session) -> None:
        self.session = session

    def __call__(self):
        return self

    async def __aenter__(self):
        return self.session

    async def __aexit__(self, *_exc):
        return False


class _Mgr(_RemoteRegistryMixin):
    """Minimaler ConnectionManager-Ersatz — die Wache braucht nur die Registry,
    die Socket→Nutzer-Zuordnung und die Session-Factory."""

    def __init__(self, session=None) -> None:
        self._lock = asyncio.Lock()
        self._user_conns: dict[int, set] = {}
        self._ws_user: dict = {}
        self._session_factory = _Factory(session)
        self._init_remote_registry()


async def _live_session(mgr: _Mgr, *, cid: str = "77") -> tuple:
    host_ws, ctrl_ws = _Sock(), _Sock()
    mgr._ws_user[host_ws] = _User(10)
    mgr._ws_user[ctrl_ws] = _User(20)
    mgr._user_conns[10] = {host_ws}
    sess = await mgr.remote_create(cid, "10", host_ws, "20", ctrl_ws)
    await mgr.remote_activate(sess.session_id)
    return sess, host_ws, ctrl_ws


def _perms(monkeypatch, table: dict[int, int | None]) -> None:
    async def _fake(_session, _cid, user):
        return table.get(user.id)

    monkeypatch.setattr(remote_guard, "peer_channel_perms", _fake)


@pytest.mark.asyncio
async def test_audit_keeps_a_session_whose_peers_still_hold_the_rights(monkeypatch):
    mgr = _Mgr(_FakeSession())
    sess, host_ws, ctrl_ws = await _live_session(mgr)
    _perms(monkeypatch, {10: ALLOWED, 20: ALLOWED})
    assert await remote_guard.audit_remote_sessions(mgr) == 0
    assert mgr.remote_get(sess.session_id) is not None
    assert host_ws.sent == [] and ctrl_ws.sent == []


@pytest.mark.asyncio
async def test_audit_ends_when_the_controller_loses_remote_control(monkeypatch):
    """Der Rollenentzug ist der Fall, der die Wache ueberhaupt begruendet:
    ohne sie steuert der Entrechtete bis zum Ablauf des Tokens weiter."""
    mgr = _Mgr(_FakeSession())
    sess, host_ws, ctrl_ws = await _live_session(mgr)
    _perms(monkeypatch, {10: ALLOWED, 20: Permissions.VIEW_CHANNEL})
    assert await remote_guard.audit_remote_sessions(mgr) == 1
    assert mgr.remote_get(sess.session_id) is None
    for sock in (host_ws, ctrl_ws):
        assert sock.sent == [
            {
                "op": "remote_ended",
                "session_id": sess.session_id,
                "reason": "permission_revoked",
            }
        ]


@pytest.mark.asyncio
async def test_audit_ends_when_the_host_may_no_longer_see_the_channel(monkeypatch):
    mgr = _Mgr(_FakeSession())
    sess, _host_ws, _ctrl_ws = await _live_session(mgr)
    # ``None`` = kein Mitglied mehr (oder Community stillgelegt).
    _perms(monkeypatch, {10: None, 20: ALLOWED})
    assert await remote_guard.audit_remote_sessions(mgr) == 1
    assert mgr.remote_get(sess.session_id) is None


@pytest.mark.asyncio
async def test_audit_leaves_a_session_whose_peer_socket_is_already_gone(monkeypatch):
    """Ist ein Peer-Socket weg, gehoert der Abbau dem Disconnect-Pfad — die
    Wache wuerde ihm die Sitzung sonst unter den Haenden wegziehen."""
    mgr = _Mgr(_FakeSession())
    sess, host_ws, _ctrl_ws = await _live_session(mgr)
    del mgr._ws_user[host_ws]
    _perms(monkeypatch, {})
    assert await remote_guard.audit_remote_sessions(mgr) == 0
    assert mgr.remote_get(sess.session_id) is not None


@pytest.mark.asyncio
async def test_audit_enforces_the_absolute_session_cap(monkeypatch):
    """``created_at`` wird gelesen: eine Zustimmung gilt fuer eine Sitzung,
    nicht auf Dauer — ein vergessener Tab bleibt sonst ueber Nacht steuerbar."""
    mgr = _Mgr(_FakeSession())
    sess, _host_ws, ctrl_ws = await _live_session(mgr)
    _perms(monkeypatch, {10: ALLOWED, 20: ALLOWED})
    assert await remote_guard.audit_remote_sessions(mgr, max_session_s=0.0) == 1
    assert mgr.remote_get(sess.session_id) is None
    assert ctrl_ws.sent[-1]["reason"] == "session_expired"


@pytest.mark.asyncio
async def test_kick_teardown_is_scoped_to_the_guilds_channels():
    """Wer aus Server A fliegt, verliert keine Sitzung in Server B."""
    session = _FakeSession(channel_ids=[77])  # nur Kanal 77 gehoert zu Server A
    mgr = _Mgr(session)
    here, host_a, ctrl_a = await _live_session(mgr, cid="77")
    # Zweite Sitzung desselben Nutzers, aber in einem Kanal eines anderen Servers.
    elsewhere_host, elsewhere_ctrl = _Sock(), _Sock()
    mgr._ws_user[elsewhere_host] = _User(30)
    mgr._ws_user[elsewhere_ctrl] = _User(10)  # hier ist 10 der Steuernde
    other = await mgr.remote_create("88", "30", elsewhere_host, "10", elsewhere_ctrl)
    await mgr.remote_activate(other.session_id)

    ended = await remote_guard.end_remote_sessions_for_member(session, mgr, 1, 10)
    assert ended == 1
    assert mgr.remote_get(here.session_id) is None
    assert mgr.remote_get(other.session_id) is not None
    assert host_a.sent[-1]["reason"] == "membership_revoked"
    assert ctrl_a.sent[-1]["reason"] == "membership_revoked"


@pytest.mark.asyncio
async def test_kick_teardown_covers_the_controller_role_too():
    session = _FakeSession(channel_ids=[77])
    mgr = _Mgr(session)
    sess, _host_ws, _ctrl_ws = await _live_session(mgr, cid="77")
    # Nutzer 20 ist der Steuernde — auch der fliegt raus.
    assert await remote_guard.end_remote_sessions_for_member(session, mgr, 1, 20) == 1
    assert mgr.remote_get(sess.session_id) is None


@pytest.mark.asyncio
async def test_kick_teardown_without_sessions_touches_no_db():
    class _Boom(_FakeSession):
        async def execute(self, _stmt):
            raise AssertionError("no DB lookup when the user has no session")

    mgr = _Mgr(None)
    assert await remote_guard.end_remote_sessions_for_member(_Boom(), mgr, 1, 10) == 0
    # Und ohne Manager (Tests/Teilaufbauten) ist es ein No-op statt eines Absturzes.
    assert await remote_guard.end_remote_sessions_for_member(_Boom(), None, 1, 10) == 0
