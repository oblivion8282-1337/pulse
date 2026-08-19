"""Rechte-Wache der Fernsteuerung (``remote_guard``).

Deckt die zweite Haelfte des Vertrags ab (Wire-Protokoll v2, "Sicherheit und
Robustheit"): Rechte werden nicht nur beim Aufbau geprueft. Ohne die Wache
ueberlebt eine laufende Sitzung Rollenentzug und Kanal-Overwrite bis der
Zugangstoken abgelaufen ist — 15 Minuten Tastatur auf fremdem Rechner.

Die Rechteabfrage selbst (``peer_channel_perms``) wird in den meisten Tests
ersetzt: dort geht es um die Entscheidung *nach* der Abfrage. Der letzte Test im
Modul laeuft bewusst OHNE Ersatz durch die echte Rechteauflösung auf der
Datenbank — sonst waere nirgends belegt, dass die Wache dort ueberhaupt ankommt.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from dcc_chat_gateway import remote_guard
from dcc_chat_gateway.remote_reconnect_registry import _RemoteReconnectMixin
from dcc_chat_gateway.remote_registry import _RemoteRegistryMixin
from dcc_chat_gateway.security import AuthenticatedUser
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


class _Mgr(_RemoteRegistryMixin, _RemoteReconnectMixin):
    """Minimaler ConnectionManager-Ersatz — die Wache braucht die Registry,
    die Gnadenfrist-Buchfuehrung (`remote_disconnect_grace_active`, seit
    2026-08-19 zweite Runde), die Socket→Nutzer-Zuordnung und die
    Session-Factory."""

    def __init__(self, session=None, *, factory=None) -> None:
        self._lock = asyncio.Lock()
        self._user_conns: dict[int, set] = {}
        self._ws_user: dict = {}
        # ``factory`` = echte ``async_sessionmaker`` (Test mit Datenbank),
        # sonst der Attrappen-Kontextmanager um ``session``.
        self._session_factory = factory or _Factory(session)
        self._init_remote_registry()
        self._init_remote_reconnect()


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
async def test_audit_ends_a_session_whose_peer_socket_is_already_gone(monkeypatch):
    """UMGEDREHT (vorher: "die Wache laesst sie leben").

    Die alte Begruendung — "ein abgemeldeter Socket heisst, der Disconnect-Pfad
    raeumt gleich auf" — stimmt nicht: ``_ws_user`` wird an einer ZWEITEN Stelle
    geleert. Der Pubsub-Verteiler meldet einen Socket bei Sendefehler oder
    abgelaufener Sendefrist ueber ``remove_socket`` ab, ohne ihn zu schliessen
    und ohne den Disconnect-Pfad zu rufen (``pubsub.py``/``pubsub_listener.py``).
    Damit konnte der Steuernde die Wache fuer seine eigene Sitzung dauerhaft
    abschalten: kurz nicht lesen, ein Broadcast laeuft in die Sendefrist, Socket
    abgemeldet — Eingaben flossen weiter (der Weiterleiter prueft nur Sitzung
    und Socket-Identitaet), aber jeder Prueflauf sagte fuer immer "leben
    lassen". Rollenentzug und Kanal-Overwrite blieben bis zu acht Stunden
    wirkungslos.

    Fail-closed ist billig: ``remote_terminate`` poppt unter dem Lock und ist
    idempotent, ein Wettlauf mit dem Disconnect-Pfad kostet nichts."""
    mgr = _Mgr(_FakeSession())
    sess, host_ws, ctrl_ws = await _live_session(mgr)
    # Genau das, was ``remove_socket`` tut: Abmeldung ohne Schliessen.
    del mgr._ws_user[host_ws]

    async def _boom(*_a, **_k):
        raise AssertionError("ohne Nutzer darf gar keine Rechteabfrage laufen")

    monkeypatch.setattr(remote_guard, "peer_channel_perms", _boom)
    assert await remote_guard.audit_remote_sessions(mgr) == 1
    assert mgr.remote_get(sess.session_id) is None
    assert ctrl_ws.sent[-1]["reason"] == "peer_disconnected"


@pytest.mark.asyncio
async def test_audit_spares_a_session_within_a_tracked_disconnect_grace(monkeypatch):
    """GEGENPROBE zum vorigen Test (Bughunt 2026-08-19, zweite Runde): fehlt
    ein Peer-Nutzer, WEIL genau seine Rolle gerade in einer bekannten
    Gnadenfrist steht (`remote_reconnect_registry.py`), ist das der erwartete
    Zwischenzustand — kein Grund zum Sofort-Ende. Vorher toetete das
    fail-closed rund ein Drittel aller Wackler noch waehrend ihrer eigenen
    Gnadenfrist (30 s Takt gegen 10 s Frist), bevor ueberhaupt eine Chance zum
    Reklamieren bestand."""
    mgr = _Mgr(_FakeSession())
    sess, host_ws, ctrl_ws = await _live_session(mgr)
    # Wie beim Disconnect-Pfad: Socket-Nutzer weg, UND — anders als im vorigen
    # Test — die Gnadenfrist fuer genau diese Rolle ist scharf.
    del mgr._ws_user[host_ws]

    async def _never(_sid: str, _role: str) -> None:
        raise AssertionError("die Frist darf in diesem Test nicht ablaufen")

    mgr.remote_schedule_disconnect_grace(sess.session_id, "host", _never, delay=999)

    async def _boom(*_a, **_k):
        raise AssertionError("ohne beide Nutzer darf gar keine Rechteabfrage laufen")

    monkeypatch.setattr(remote_guard, "peer_channel_perms", _boom)
    assert await remote_guard.audit_remote_sessions(mgr) == 0
    assert mgr.remote_get(sess.session_id) is sess
    assert ctrl_ws.sent == []


@pytest.mark.asyncio
async def test_audit_still_ends_a_session_whose_OTHER_role_lacks_grace(monkeypatch):
    """Fehlen BEIDE Nutzer, aber nur EINER hat eine laufende Gnadenfrist, bleibt
    es beim Sofort-Ende — eine befristete Abwesenheit deckt nicht automatisch
    die andere Rolle mit ab."""
    mgr = _Mgr(_FakeSession())
    sess, host_ws, ctrl_ws = await _live_session(mgr)
    del mgr._ws_user[host_ws]
    del mgr._ws_user[ctrl_ws]

    async def _never(_sid: str, _role: str) -> None:
        raise AssertionError("die Frist darf in diesem Test nicht ablaufen")

    # NUR der Host hat eine laufende Frist — der Controller fehlt ohne jede
    # bekannte Erklaerung (der zweite, aeltere Grund: der Pubsub-Verteiler).
    mgr.remote_schedule_disconnect_grace(sess.session_id, "host", _never, delay=999)

    async def _boom(*_a, **_k):
        raise AssertionError("ohne Nutzer darf gar keine Rechteabfrage laufen")

    monkeypatch.setattr(remote_guard, "peer_channel_perms", _boom)
    assert await remote_guard.audit_remote_sessions(mgr) == 1
    assert mgr.remote_get(sess.session_id) is None


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


# ─── Mit echter Rechteauflösung (ohne monkeypatch) ─────────────────────────


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _token(signer) -> tuple[str, int]:
    uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    return signer.issue_access(uid, f"u{uid}"), uid


def _real_user(uid: int) -> AuthenticatedUser:
    """Der Resolver liest ``id``/``is_admin``/``is_owner`` vom Nutzerobjekt —
    hier also ein echtes, kein Platzhalter mit nur einer id."""
    return AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={})


@pytest.mark.asyncio
async def test_audit_uses_the_real_permission_resolution(
    client, _auth_signer, session_factory
):
    """Ohne Ersatz fuer ``peer_channel_perms``: Community, Kanal und Rolle
    liegen wirklich in der Datenbank, und die Wache laeuft durch dieselbe
    Aufloesung wie der Aufbau-Pfad.

    Bis hierher ersetzten ALLE Wachen-Tests die Rechteabfrage — die eine Zeile,
    an der die Wache ihre Entscheidung holt, war damit nirgends durchlaufen. Ein
    Tippfehler im Kanal-/Nutzerbezug haette die Wache stumm gemacht, ohne dass
    ein Test rot geworden waere."""
    owner_t, owner_uid = await _token(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(owner_t))).json()
    ch = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "Voice", "type": 1},
            headers=_auth(owner_t),
        )
    ).json()
    member_t, member_uid = await _token(_auth_signer)
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(member_uid)},
        headers=_auth(owner_t),
    )

    mgr = _Mgr(factory=session_factory)
    host_ws, ctrl_ws = _Sock(), _Sock()
    mgr._ws_user[host_ws] = _real_user(owner_uid)  # Owner = Host
    mgr._ws_user[ctrl_ws] = _real_user(member_uid)  # einfaches Mitglied steuert
    mgr._user_conns[owner_uid] = {host_ws}

    async def _live() -> str:
        sess = await mgr.remote_create(
            ch["id"], str(owner_uid), host_ws, str(member_uid), ctrl_ws
        )
        await mgr.remote_activate(sess.session_id)
        return sess.session_id

    # REMOTE_CONTROL steckt nicht in @everyone: das Mitglied sieht den Kanal,
    # darf aber nicht steuern → die Wache beendet.
    sid = await _live()
    assert await remote_guard.audit_remote_sessions(mgr) == 1
    assert mgr.remote_get(sid) is None
    assert ctrl_ws.sent[-1]["reason"] == "permission_revoked"

    # Mit einer Rolle, die das Bit traegt, laesst dieselbe Abfrage sie stehen.
    role = (
        await client.post(
            f"/guilds/{g['id']}/roles",
            json={"name": "Fernsteuerer", "permissions": str(int(ALLOWED))},
            headers=_auth(owner_t),
        )
    ).json()
    assert (
        await client.put(
            f"/guilds/{g['id']}/members/{member_uid}/roles/{role['id']}",
            headers=_auth(owner_t),
        )
    ).status_code == 204
    sid = await _live()
    assert await remote_guard.audit_remote_sessions(mgr) == 0
    assert mgr.remote_get(sid) is not None
