"""``remote_request``: die Host-Tabs muessen NACH dem Datenbank-Block gelesen werden.

Zwischen "welche Tabs hat der Host offen?" und "wem schicken wir die Einladung?"
liegen drei ``await`` auf der Datenbank (Mitgliedschaft, Rechte des Rufers,
Rechte des Hosts). Wurde die Liste davor gelesen und danach benutzt, bekam die
Sitzung im ungluecklichen Fall einen toten ``host_socket`` — der Host war bis
zum Ablauf der Zustimmungsfrist blockiert (eine Sitzung je Host), waehrend ein
inzwischen geoeffneter Tab keine Einladung sah, spaeter aber ein
``remote_canceled``.

Das Rennen ist ueber die WebSocket nicht zuverlaessig herstellbar (man muesste
einen Tab genau im DB-Fenster schliessen), deshalb hier als Einheitstest: die
Socket-Liste des Managers wechselt zwischen den Abfragen, und der Test prueft,
welche Liste am Ende gilt.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from dcc_chat_gateway.device_registry import _DeviceRegistryMixin
from dcc_chat_gateway.remote_registry import _RemoteRegistryMixin
from dcc_chat_gateway.routes import ws_remote_handlers
from dcc_chat_gateway.routes.ws_ops_registry import WSOpContext
from dcc_shared.permissions import Permissions

HOST_UID = 10
CTRL_UID = 20
CID = 77


class _Sock:
    def __init__(self, name: str = "") -> None:
        self.name = name
        self.sent: list[dict] = []
        self.app = SimpleNamespace(state=SimpleNamespace(connection_manager=None))

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


class _User:
    def __init__(self, uid: int) -> None:
        self.id = uid
        self.is_admin = False
        self.is_owner = False


class _Mgr(_RemoteRegistryMixin, _DeviceRegistryMixin):
    """Registry mit einer *drehbaren* Socket-Liste: der erste Aufruf liefert die
    Tabs von vor dem DB-Block, jeder weitere die von danach.

    Das Geraete-Register haengt mit dran, weil der Aufbau-Pfad die Faecherung
    seit 2026-08-16 daran misst (``ws_remote_geraet.einladungsziele``): ein
    angemeldetes Geraet sieht nur Einladungen, die es nennen. Hier ist keines
    angemeldet — die Tabs sind Menschen, und genau die sollen alles sehen.
    """

    def __init__(self, first: list, later: list) -> None:
        self._lock = asyncio.Lock()
        self._user_conns: dict[int, set] = {}
        self._ws_user: dict = {}
        self._init_remote_registry()
        self._init_device_registry()
        self._scripted = [first, later]

    def remote_user_sockets(self, user_id):  # type: ignore[override]
        return self._scripted.pop(0) if len(self._scripted) > 1 else self._scripted[0]

    def remote_socket_user(self, socket):  # type: ignore[override]
        return self._ws_user.get(socket)


class _Factory:
    """Session-Attrappe — alle DB-Zugriffe sind ersetzt, hier fliesst nichts."""

    def __call__(self):
        return self

    async def __aenter__(self):
        return object()

    async def __aexit__(self, *_exc):
        return False


@pytest.fixture
def _db_stubs(monkeypatch):
    """Die drei DB-Abfragen des Aufbau-Pfads durch Zusagen ersetzen — geprueft
    wird hier die Reihenfolge der Socket-Abfrage, nicht die Rechtelogik (die
    deckt ``test_remote_guard.py`` mit echter Datenbank ab)."""

    async def _membership(_s, _cid, _uid):
        return SimpleNamespace(guild_id=1)

    async def _perms(_s, _user, _gid, _cid):
        return int(Permissions.VIEW_CHANNEL | Permissions.REMOTE_CONTROL)

    async def _peer_perms(_s, _cid, _user):
        return int(Permissions.VIEW_CHANNEL)

    monkeypatch.setattr(ws_remote_handlers, "channel_membership", _membership)
    monkeypatch.setattr(ws_remote_handlers, "resolve_permissions", _perms)
    monkeypatch.setattr(ws_remote_handlers, "peer_channel_perms", _peer_perms)


async def _request(mgr, ctrl_sock) -> WSOpContext:
    ctrl_sock.app.state.connection_manager = mgr
    ctx = WSOpContext(
        websocket=ctrl_sock, user=_User(CTRL_UID), manager=mgr, redis=None
    )
    await ws_remote_handlers.handle_request(
        ctx,
        {"channel_id": str(CID), "host_user_id": str(HOST_UID)},
        session_factory=_Factory(),
    )
    return ctx


@pytest.mark.asyncio
async def test_invite_goes_to_the_tabs_open_after_the_db_block(_db_stubs):
    """Der Tab, der waehrend der DB-Abfragen zumacht, bekommt weder die
    Einladung noch die Rolle des ``host_socket``; der inzwischen geoeffnete
    bekommt beides."""
    alt, neu, ctrl = _Sock("alt"), _Sock("neu"), _Sock("ctrl")
    mgr = _Mgr(first=[alt], later=[neu])
    mgr._ws_user[alt] = _User(HOST_UID)
    mgr._ws_user[neu] = _User(HOST_UID)
    await _request(mgr, ctrl)

    sessions = mgr.remote_sessions_snapshot()
    assert len(sessions) == 1
    assert sessions[0].host_socket is neu
    assert [f["op"] for f in neu.sent] == ["remote_request"]
    assert alt.sent == []
    # Der Steuernde erfaehrt seine Sitzung (Drahtvertrag ``remote_pending``).
    assert ctrl.sent[0]["op"] == "remote_pending"
    assert ctrl.sent[0]["session_id"] == sessions[0].session_id
    mgr.remote_cancel_timeout(sessions[0].session_id)


@pytest.mark.asyncio
async def test_last_host_tab_closing_during_the_db_block_yields_4052(_db_stubs):
    """Schliesst der letzte Tab im DB-Fenster, entsteht gar keine Sitzung —
    sonst haenge eine Einladung an einem toten Socket und blockierte den Host
    bis zum Zeitgeber."""
    alt, ctrl = _Sock("alt"), _Sock("ctrl")
    mgr = _Mgr(first=[alt], later=[])
    mgr._ws_user[alt] = _User(HOST_UID)
    await _request(mgr, ctrl)

    assert mgr.remote_sessions_snapshot() == []
    assert [(f["op"], f.get("code")) for f in ctrl.sent] == [("error", 4052)]
