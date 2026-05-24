"""Loader-Tests für das Allowlist-Gate (Plugin-Admin-Aktivierungs-PR).

Deckt:
* Plugin nicht in Allowlist → discovered, aber Op-Handler nicht
  registriert. ``discovered_but_not_allowed``-Liste enthält das Plugin.
* Plugin in Allowlist → Op-Handler registriert (Status-Quo aus
  Schritt 4 + 5).
* Hello-Self-Heal: ``ensure_hello_in_allowlist`` ist idempotent.
"""

from __future__ import annotations

import pytest
from dcc_chat_gateway.plugins import (
    HELLO_PLUGIN_NAME,
    PluginManager,
    discover_plugins_dir,
    ensure_hello_in_allowlist,
    list_allowed_names,
    load_directory_with_allowlist,
)
from dcc_chat_gateway.plugins.registry import _reset_for_tests as _reset_manager
from dcc_chat_gateway.pubsub_channel_registry import (
    _clear_for_tests as _clear_channels,
)
from dcc_chat_gateway.pubsub_channel_registry import (
    get_channel_handler,
    register_channel_handler,
    registered_channels,
)
from dcc_chat_gateway.routes.ws_ops_registry import (
    _clear_for_tests as _clear_ops,
)
from dcc_chat_gateway.routes.ws_ops_registry import (
    get_handler,
    register_ws_op,
    registered_ops,
)


@pytest.fixture(autouse=True)
def _isolate_registries():
    """Pattern wie in test_plugin_tamagotchi.py — Plugin-Ops vor dem Test
    aktiv wegwischen, Built-in-Ops behalten + nach dem Test restaurieren.
    """
    saved_ops = {op: get_handler(op) for op in registered_ops()}
    saved_channels = {
        ch: get_channel_handler(ch) for ch in registered_channels()
    }
    _reset_manager()
    _clear_ops()
    _clear_channels()
    for op, handler in saved_ops.items():
        if handler is not None and ":" not in op:
            register_ws_op(op, handler)
    for ch, handler in saved_channels.items():
        if handler is not None:
            register_channel_handler(ch, handler)
    yield
    _reset_manager()
    _clear_ops()
    _clear_channels()
    for op, handler in saved_ops.items():
        if handler is not None:
            register_ws_op(op, handler)
    for ch, handler in saved_channels.items():
        if handler is not None:
            register_channel_handler(ch, handler)


def test_allowlist_gates_activation(monkeypatch):
    """Plugin nicht in Allowlist → wird NICHT aktiviert; ``hello``
    (im Allowlist-Set) wird aktiviert + registriert seine Ops."""
    monkeypatch.delenv("PULSE_PLUGINS_DIR", raising=False)
    plugins_dir = discover_plugins_dir()
    assert plugins_dir is not None

    mgr = PluginManager()
    result = load_directory_with_allowlist(
        plugins_dir, allowed={"hello"}, manager=mgr
    )
    loaded_names = [m.name for m in result.loaded]
    skipped_names = [m.name for m in result.discovered_but_not_allowed]

    assert "hello" in loaded_names
    assert "tamagotchi" in skipped_names
    # hello-Op ist registriert, tamagotchi-Op ist's nicht.
    assert get_handler("hello:ping") is not None
    assert get_handler("tamagotchi:feed") is None


def test_allowlist_empty_skips_everything(monkeypatch):
    """Leere Allowlist → nichts wird aktiviert; alle Plugins landen in
    discovered_but_not_allowed."""
    monkeypatch.delenv("PULSE_PLUGINS_DIR", raising=False)
    plugins_dir = discover_plugins_dir()
    assert plugins_dir is not None

    mgr = PluginManager()
    result = load_directory_with_allowlist(
        plugins_dir, allowed=set(), manager=mgr
    )
    assert result.loaded == []
    assert {m.name for m in result.discovered_but_not_allowed} >= {
        "hello",
        "tamagotchi",
    }
    assert get_handler("hello:ping") is None


def test_allowlist_with_both_plugins_activates_both(monkeypatch):
    """Beide Plugins in der Allowlist → beide aktiviert (Status-Quo
    Verhalten aus Schritt 4)."""
    monkeypatch.delenv("PULSE_PLUGINS_DIR", raising=False)
    plugins_dir = discover_plugins_dir()
    assert plugins_dir is not None

    mgr = PluginManager()
    result = load_directory_with_allowlist(
        plugins_dir, allowed={"hello", "tamagotchi"}, manager=mgr
    )
    assert {m.name for m in result.loaded} >= {"hello", "tamagotchi"}
    assert result.discovered_but_not_allowed == []
    assert get_handler("hello:ping") is not None
    assert get_handler("tamagotchi:feed") is not None


@pytest.mark.asyncio
async def test_ensure_hello_in_allowlist_is_idempotent(session_factory):
    """Self-Heal-Insert läuft sauber durch — auch zweimal hintereinander."""
    async with session_factory() as s:
        await ensure_hello_in_allowlist(s)
    async with session_factory() as s:
        await ensure_hello_in_allowlist(s)
        names = await list_allowed_names(s)
    assert HELLO_PLUGIN_NAME in names


@pytest.mark.asyncio
async def test_ensure_hello_in_allowlist_brings_back_removed_entry(
    session_factory,
):
    """Wenn jemand ``hello`` manuell entfernt hat, kommt es beim
    nächsten Self-Heal-Lauf zurück."""
    from dcc_chat_gateway.models import InstancePluginAllowlist
    from dcc_chat_gateway.plugins.allowlist import remove_from_allowlist

    async with session_factory() as s:
        await ensure_hello_in_allowlist(s)
    async with session_factory() as s:
        assert (
            await s.get(InstancePluginAllowlist, HELLO_PLUGIN_NAME)
        ) is not None
        await remove_from_allowlist(s, HELLO_PLUGIN_NAME)
        assert (
            await s.get(InstancePluginAllowlist, HELLO_PLUGIN_NAME)
        ) is None
    async with session_factory() as s:
        await ensure_hello_in_allowlist(s)
        assert (
            await s.get(InstancePluginAllowlist, HELLO_PLUGIN_NAME)
        ) is not None
