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
    assert reg.remote_disconnect_grace_active(sess.session_id, "host") is True
    await asyncio.sleep(0.05)
    assert calls == [(sess.session_id, "host")]
    # Der Zeitgeber räumt sich nach dem Feuern selbst ab.
    assert reg.remote_disconnect_grace_active(sess.session_id, "host") is False


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
    assert reg.remote_disconnect_grace_active(sess.session_id, "host") is False
    # Genug warten, dass der ALTE Zeitgeber laengst gefeuert hätte — er darf es
    # nicht mehr: `remote_reclaim` hat ihn abgebrochen.
    await asyncio.sleep(0.1)
    assert calls == [], "ein erfolgreicher Reclaim darf den Abbau nicht mehr auslösen"


@pytest.mark.asyncio
async def test_both_roles_drop_and_reclaim_independently():
    """Der zentrale Regressionsfall aus dem zweiten Prüflauf (2026-08-19):
    `uvicorn --reload` trennt IMMER beide Rollen gleichzeitig. Eine Frist je
    (Sitzung, Rolle) darf sich dabei nicht gegenseitig überschreiben — vorher
    tat sie das, und die Sitzung starb schneller als vor der Gnadenfrist."""
    reg = _Reg()
    sess, host_ws, ctrl_ws = await _active_session(reg)
    host_calls: list[str] = []
    ctrl_calls: list[str] = []

    async def host_expired(_sid: str, _role: str) -> None:
        host_calls.append("host")

    async def ctrl_expired(_sid: str, _role: str) -> None:
        ctrl_calls.append("controller")

    # Beide Rollen reissen ab, HOST zuerst, dann CONTROLLER — wie beim Reload.
    reg.remote_schedule_disconnect_grace(sess.session_id, "host", host_expired, delay=1.0)
    reg.remote_schedule_disconnect_grace(sess.session_id, "controller", ctrl_expired, delay=1.0)
    # Beide Fristen müssen GLEICHZEITIG laufen — keine darf die andere ersetzt haben.
    assert reg.remote_disconnect_grace_active(sess.session_id, "host") is True
    assert reg.remote_disconnect_grace_active(sess.session_id, "controller") is True

    new_host_ws, new_ctrl_ws = _Sock(), _Sock()
    host_reclaimed = await reg.remote_reclaim(sess.session_id, "host", "10", new_host_ws)
    ctrl_reclaimed = await reg.remote_reclaim(sess.session_id, "controller", "20", new_ctrl_ws)
    assert host_reclaimed is sess
    assert ctrl_reclaimed is sess
    assert reg.remote_get(sess.session_id).host_socket is new_host_ws
    assert reg.remote_get(sess.session_id).controller_socket is new_ctrl_ws
    await asyncio.sleep(1.2)
    assert host_calls == [], "der Host-Reclaim darf nicht am Controller-Abriss scheitern"
    assert ctrl_calls == [], "der Controller-Reclaim darf nicht am Host-Abriss scheitern"


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
    assert reg.remote_disconnect_grace_active(sess.session_id, "host") is True


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
    assert reg.remote_disconnect_grace_active(sess.session_id, "host") is True
    # Mit der richtigen Rolle schon.
    reg.remote_cancel_disconnect_grace(sess.session_id, role="host")
    assert reg.remote_disconnect_grace_active(sess.session_id, "host") is False


@pytest.mark.asyncio
async def test_cancel_disconnect_grace_without_role_clears_both():
    """Ohne `role` (der Aufruf, den `remote_end` fuer JEDEN Abbauweg macht)
    raeumt beide Rollen auf einmal ab — genau das, was ein `remote_end`
    waehrend einer laufenden Gnadenfrist braucht."""
    reg = _Reg()
    sess, _, _ = await _active_session(reg)

    async def on_expired(_sid: str, _role: str) -> None:
        pass

    reg.remote_schedule_disconnect_grace(sess.session_id, "host", on_expired, delay=1.0)
    reg.remote_schedule_disconnect_grace(sess.session_id, "controller", on_expired, delay=1.0)
    reg.remote_cancel_disconnect_grace(sess.session_id)
    assert reg.remote_disconnect_grace_active(sess.session_id, "host") is False
    assert reg.remote_disconnect_grace_active(sess.session_id, "controller") is False


@pytest.mark.asyncio
async def test_remote_end_cancels_any_running_grace():
    """`remote_end` ist der eine Trichter, durch den jede Sitzung verschwindet
    — er muss eine laufende Gnadenfrist mit abraeumen, sonst feuert ihr
    Zeitgeber spaeter ins Leere (harmlos, aber unnoetig)."""
    reg = _Reg()
    sess, host_ws, _ = await _active_session(reg)
    calls: list[str] = []

    async def on_expired(_sid: str, _role: str) -> None:
        calls.append("gefeuert")

    reg.remote_schedule_disconnect_grace(sess.session_id, "host", on_expired, delay=0.02)
    await reg.remote_end(sess.session_id)
    assert reg.remote_disconnect_grace_active(sess.session_id, "host") is False
    await asyncio.sleep(0.05)
    assert calls == []


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
    alter_task = reg._remote_disconnect_timers[(sess.session_id, "host")]
    # Neuer Abriss derselben Rolle VOR Ablauf des ersten — ersetzt den Timer.
    await asyncio.sleep(0.01)
    reg.remote_schedule_disconnect_grace(sess.session_id, "host", neuer_on_expired, delay=0.03)
    assert reg._remote_disconnect_timers[(sess.session_id, "host")] is not alter_task
    await asyncio.sleep(0.05)
    assert calls == ["neu"], "nur der neue Zeitgeber darf feuern"


@pytest.mark.asyncio
async def test_grace_expiry_calling_remote_end_does_not_cancel_itself():
    """CI-Befund 2026-08-20 — deterministischer Hänger, zweimal identisch
    reproduziert in `test_remote_disconnect_notifies_peer`.

    `_disconnect_grace_expired` ruft über `on_expired` irgendwann
    `remote_end` auf (genau das tut `_end_and_notify_peer` in
    `ws_remote_teardown.py`), und `remote_end` räumt seinerseits JEDE Frist
    der Sitzung auf — auch die eigene, gerade noch laufende. Ohne die
    Schutzklausel in `remote_cancel_disconnect_grace` (»storniere nie den
    eigenen, gerade laufenden Task«) storniert sich der Task mitten in seiner
    eigenen Ausführung: `cancel()` wirkt am NÄCHSTEN `await` — hier dem
    `await` NACH `remote_end`, der die Meldung verschickt. Eine
    `CancelledError` dort ist keine `Exception` und wird vom umschließenden
    `except Exception` (in `_on_grace_expired`) nicht gefangen — die Meldung
    geht nie hinaus, und wer darauf wartet, hängt bis zum Timeout."""
    reg = _Reg()
    sess, _, _ = await _active_session(reg)
    verschickt: list[str] = []

    async def on_expired(session_id: str, _role: str) -> None:
        # Genau die Reihenfolge aus `_end_and_notify_peer`: erst `remote_end`
        # (räumt die eigene Frist mit ab), DANACH noch ein `await` — der
        # "Versand" der Meldung. Ohne den Schutz hängt sich GENAU HIER die
        # `CancelledError` ein, und `verschickt` bleibt leer.
        await reg.remote_end(session_id)
        await asyncio.sleep(0)
        verschickt.append("remote_ended")

    reg.remote_schedule_disconnect_grace(sess.session_id, "controller", on_expired, delay=0)
    await asyncio.sleep(0.05)
    assert verschickt == ["remote_ended"], (
        "der ablaufende Zeitgeber hat sich über remote_end selbst storniert, "
        "bevor er seine Meldung verschicken konnte"
    )
