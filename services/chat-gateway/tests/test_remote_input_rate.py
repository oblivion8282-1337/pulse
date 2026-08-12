"""Sekunden-Deckel des Eingabe-Weiterleiters (``remote_input``).

Als Einheitstest statt ueber die WebSocket: der Deckel liegt bei 300
Nachrichten je Sekunde, und ein WS-Test muesste dafuer 300+ Nachrichten in
weniger als einer Sekunde durch den Testclient schieben — das misst dann die
Geschwindigkeit des Testclients, nicht den Deckel.
"""

from __future__ import annotations

from dcc_chat_gateway.routes.ws_ops_registry import WSOpContext
from dcc_chat_gateway.routes.ws_remote_input import MAX_INPUT_MESSAGES_PER_S, _within_rate


class _User:
    id = 42


def _ctx() -> WSOpContext:
    return WSOpContext(websocket=None, user=_User(), manager=None, redis=None)


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
    ctx.remote_input_window -= 1.5
    assert _within_rate(ctx) is True
    assert ctx.remote_input_count == 1


def test_rate_cap_is_per_connection():
    """Der Zaehler haengt am Verbindungskontext — eine flutende Verbindung darf
    eine zweite nicht mit sperren (und ist beim Disconnect von selbst weg)."""
    a, b = _ctx(), _ctx()
    for _ in range(MAX_INPUT_MESSAGES_PER_S + 5):
        _within_rate(a)
    assert _within_rate(a) is False
    assert _within_rate(b) is True
