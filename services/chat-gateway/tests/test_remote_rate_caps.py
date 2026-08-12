"""Sekunden-Deckel der Fernsteuer-Weiterleiter (``remote_input``/``remote_signal``).

Als Einheitstests statt ueber die WebSocket: die Deckel liegen bei 300 bzw. 60
Nachrichten je Sekunde, und ein WS-Test muesste sie in weniger als einer Sekunde
durch den Testclient schieben — das misst dann die Geschwindigkeit des
Testclients, nicht den Deckel.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from dcc_chat_gateway.routes.ws_ops_registry import WSOpContext
from dcc_chat_gateway.routes.ws_remote_handlers import (
    _SIGNAL_MAX_MESSAGES_PER_S,
    handle_signal,
)
from dcc_chat_gateway.routes.ws_remote_input import MAX_INPUT_MESSAGES_PER_S, _within_rate


class _User:
    id = 42


class _Sock:
    """Socket-Attrappe. ``app.state.connection_manager`` ist bewusst ``None``:
    diese Tests kommen nie bis zur Sitzungssuche."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.app = SimpleNamespace(state=SimpleNamespace(connection_manager=None))

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


def _ctx(websocket=None) -> WSOpContext:
    return WSOpContext(websocket=websocket, user=_User(), manager=None, redis=None)


def test_rate_cap_lets_the_normal_cadence_through():
    """120 Nachrichten/s ist der Bildtakt eines 120-Hz-Steuernden — der Deckel
    liegt deutlich darueber und darf ihn nicht anfassen."""
    ctx = _ctx()
    assert all(_within_rate(ctx) for _ in range(120))


def test_rate_cap_drops_above_the_ceiling_and_reopens_next_second():
    ctx = _ctx()
    for _ in range(MAX_INPUT_MESSAGES_PER_S):
        assert _within_rate(ctx) is True
    # Verwerfen, nicht trennen: der Aufrufer gibt nur diese Nachricht auf.
    assert _within_rate(ctx) is False
    assert _within_rate(ctx) is False
    # Fenster weiterdrehen (statt echt zu warten) → wieder frei.
    ctx.remote_input_rate.start -= 1.5
    assert _within_rate(ctx) is True
    assert ctx.remote_input_rate.count == 1


def test_rate_cap_is_per_connection():
    """Der Zaehler haengt am Verbindungskontext — eine flutende Verbindung darf
    eine zweite nicht mit sperren (und ist beim Disconnect von selbst weg)."""
    a, b = _ctx(), _ctx()
    for _ in range(MAX_INPUT_MESSAGES_PER_S + 5):
        _within_rate(a)
    assert _within_rate(a) is False
    assert _within_rate(b) is True


@pytest.mark.asyncio
async def test_signal_cap_drops_silently_above_the_ceiling():
    """``remote_signal`` war der ungedeckelte Zwilling von ``remote_input``:
    derselbe Weiterleiter, derselbe Empfaenger, aber ohne Sekunden-Deckel — ein
    Steuernder konnte darueber genau die Flut fahren, die beim Eingabe-Weg
    verhindert wird.

    Gemessen an einer missgeformten Nachricht: unter dem Deckel beantwortet der
    Handler sie (4050), darueber schweigt er ganz. Das belegt beides — dass der
    Deckel greift und dass er VOR jeder Antwort sitzt (eine Flut zu beantworten
    ist Teil des Problems)."""
    sock = _Sock()
    ctx = _ctx(sock)
    await handle_signal(ctx, {})
    assert [f["code"] for f in sock.sent] == [4050]

    for _ in range(_SIGNAL_MAX_MESSAGES_PER_S):
        await handle_signal(ctx, {})
    antworten = len(sock.sent)
    assert antworten == _SIGNAL_MAX_MESSAGES_PER_S  # der Deckel hat gegriffen
    await handle_signal(ctx, {})
    assert len(sock.sent) == antworten  # und schweigt weiter

    # Fenster weiterdrehen → wieder frei, Zaehler beginnt neu.
    ctx.remote_signal_rate.start -= 1.5
    await handle_signal(ctx, {})
    assert len(sock.sent) == antworten + 1


@pytest.mark.asyncio
async def test_signal_cap_is_per_connection():
    a_sock, b_sock = _Sock(), _Sock()
    a, b = _ctx(a_sock), _ctx(b_sock)
    for _ in range(_SIGNAL_MAX_MESSAGES_PER_S + 5):
        await handle_signal(a, {})
    vorher = len(a_sock.sent)
    await handle_signal(a, {})
    assert len(a_sock.sent) == vorher
    await handle_signal(b, {})
    assert [f["code"] for f in b_sock.sent] == [4050]
