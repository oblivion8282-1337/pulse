"""Tests for the WS-op handler registry (Schritt 2 Plugin-System).

Plain unit tests — no websocket round-trip. The op-loop dispatcher in
``routes/ws_ops.py`` is exercised by the existing test_ws.py /
test_dms_ws.py / test_ws_permissions.py suites; here we only lock in
the registry's contract so plugin authors can rely on it.
"""

from __future__ import annotations

import asyncio

import pytest

from dcc_chat_gateway.routes.ws_ops_registry import (
    WSOpContext,
    _clear_for_tests,
    get_handler,
    register_ws_op,
    registered_ops,
)


@pytest.fixture(autouse=True)
def _reset_registry_around_each_test():
    """Wipe + restore so a test that calls ``_clear_for_tests`` doesn't
    break sibling tests that rely on the production op set."""
    saved = {}
    # Snapshot the production registrations before the test runs. We do
    # this via the public ``get_handler`` API so we don't reach into the
    # module's private ``_handlers`` dict.
    for op in registered_ops():
        saved[op] = get_handler(op)
    yield
    _clear_for_tests()
    for op, handler in saved.items():
        register_ws_op(op, handler)


def test_register_and_get_handler_direct_call():
    async def my_handler(ctx, msg):
        return None

    register_ws_op("tamagotchi:feed", my_handler)
    assert get_handler("tamagotchi:feed") is my_handler


def test_register_as_decorator_returns_function():
    @register_ws_op("plugin:ping")
    async def handler(ctx, msg):
        return "pong"

    # Decorator must return the function unchanged so chained decorators /
    # later direct calls keep working.
    assert get_handler("plugin:ping") is handler


def test_unknown_op_returns_none():
    assert get_handler("definitely:not:registered") is None


def test_override_last_writer_wins():
    async def first(ctx, msg):
        return "first"

    async def second(ctx, msg):
        return "second"

    register_ws_op("conflict", first)
    register_ws_op("conflict", second)
    assert get_handler("conflict") is second


def test_registered_ops_includes_builtins():
    # Importing the dispatcher should populate the built-in op set —
    # ``send``, ``subscribe``, ``unsubscribe``, the watch quartet,
    # ``voice_self_state``, ``activity``.
    from dcc_chat_gateway.routes import ws_ops  # noqa: F401 — side-effect import

    ops = set(registered_ops())
    expected = {
        "send", "subscribe", "unsubscribe",
        "voice_self_state",
        "watch_start", "watch_stop", "watch_control", "watch_heartbeat",
        "activity",
    }
    assert expected.issubset(ops), f"missing built-in ops: {expected - ops}"


def test_handler_invocation_via_registry():
    """Round-trip: register → resolve → call. The handler is async and
    the context object is mutable, mirroring the real dispatch path."""
    seen: list[tuple[str, dict]] = []

    async def my_handler(ctx, msg):
        seen.append(("called", msg))
        ctx.subscribed["xyz"] = 42

    register_ws_op("test:roundtrip", my_handler)

    ctx = WSOpContext(
        websocket=object(),  # type: ignore[arg-type]
        user=object(),       # type: ignore[arg-type]
        manager=object(),    # type: ignore[arg-type]
        redis=object(),      # type: ignore[arg-type]
    )
    handler = get_handler("test:roundtrip")
    assert handler is not None
    asyncio.run(handler(ctx, {"op": "test:roundtrip", "foo": 1}))

    assert seen == [("called", {"op": "test:roundtrip", "foo": 1})]
    assert ctx.subscribed == {"xyz": 42}  # mutation visible to caller
