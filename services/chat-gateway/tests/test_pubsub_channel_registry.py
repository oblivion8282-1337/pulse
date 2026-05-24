"""Tests for the pub/sub channel handler registry (Schritt 2 Plugin-System).

Mirrors the WS-op registry tests in shape — register, resolve, override,
pattern-match for ``chat:channel:*``. The full listener round-trip is
covered indirectly by every WS test that exercises voice / watch / stream /
guild / user events.
"""

from __future__ import annotations

import asyncio

import pytest

from dcc_chat_gateway.pubsub_channel_registry import (
    _clear_for_tests,
    get_channel_handler,
    register_channel_handler,
    registered_channels,
)


@pytest.fixture(autouse=True)
def _reset_registry_around_each_test():
    """Snapshot + restore the production registrations so a test that
    calls ``_clear_for_tests`` doesn't break sibling tests."""
    saved = {}
    for ch in registered_channels():
        saved[ch] = get_channel_handler(ch)
    yield
    _clear_for_tests()
    for ch, handler in saved.items():
        register_channel_handler(ch, handler)


def test_register_and_get_handler_direct_call():
    async def my_handler(manager, channel, msg):
        return None

    register_channel_handler("plugin:events", my_handler)
    assert get_channel_handler("plugin:events") is my_handler


def test_register_as_decorator_returns_function():
    @register_channel_handler("plugin:decorated")
    async def handler(manager, channel, msg):
        return None

    assert get_channel_handler("plugin:decorated") is handler


def test_unknown_channel_returns_none():
    assert get_channel_handler("never:registered") is None


def test_override_last_writer_wins():
    async def first(manager, channel, msg):
        return "first"

    async def second(manager, channel, msg):
        return "second"

    register_channel_handler("conflict:channel", first)
    register_channel_handler("conflict:channel", second)
    assert get_channel_handler("conflict:channel") is second


def test_chat_channel_pattern_match():
    """A handler registered under ``chat:channel:*`` resolves for any
    concrete ``chat:channel:<id>`` Redis channel."""
    async def chat_handler(manager, channel, msg):
        return None

    # Wipe so we exclude any production registration interfering with
    # this assertion — the autouse fixture restores them afterwards.
    _clear_for_tests()
    register_channel_handler("chat:channel:*", chat_handler)

    assert get_channel_handler("chat:channel:12345") is chat_handler
    assert get_channel_handler("chat:channel:99999999999") is chat_handler
    # Exact match still has no handler for anything that doesn't fit
    # the pattern prefix.
    assert get_channel_handler("voice:events") is None
    # The pattern itself is not a Redis channel name a publisher would
    # use, but resolving it returns the handler too (exact-match path).
    assert get_channel_handler("chat:channel:*") is chat_handler


def test_pattern_does_not_match_unrelated_prefix():
    """The pattern is a strict prefix — a sibling channel like
    ``chat:dm:1`` must NOT accidentally fall into the chat:channel:*
    bucket."""
    async def chat_handler(manager, channel, msg):
        return None

    _clear_for_tests()
    register_channel_handler("chat:channel:*", chat_handler)

    assert get_channel_handler("chat:dm:1") is None


def test_handler_invocation_via_registry():
    """Round-trip: register → resolve → call."""
    seen: list[tuple[str, dict]] = []

    async def my_handler(manager, channel, msg):
        seen.append((channel, msg))

    register_channel_handler("test:roundtrip", my_handler)

    handler = get_channel_handler("test:roundtrip")
    assert handler is not None
    asyncio.run(handler(object(), "test:roundtrip", {"data": "{}"}))

    assert seen == [("test:roundtrip", {"data": "{}"})]


def test_registered_channels_includes_builtins():
    """Importing :mod:`pubsub` must populate the built-in channel set."""
    from dcc_chat_gateway.pubsub import ConnectionManager  # noqa: F401

    channels = set(registered_channels())
    expected = {
        "voice:events", "watch:events", "stream:events",
        "user:events", "guild:events", "chat:channel:*",
    }
    assert expected.issubset(channels), (
        f"missing built-in channels: {expected - channels}"
    )
