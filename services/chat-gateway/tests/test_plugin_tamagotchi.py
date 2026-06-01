"""Tests for the Tamagotchi reference plugin (PR3 Server-shared Pet).

Tamagotchi ist das erste echte Pulse-Plugin (nach dem ``hello/``-Skelett);
diese Tests prüfen die *strukturellen* Eigenschaften — Manifest, Loader,
Permission-Gate, Deactivate-Rollback. Die Verhaltens-Tests (Mutation-
Pfad, Broadcast, Concurrency, HTTP-State-Endpoint) leben in den eigenen
Dateien ``test_tamagotchi_state.py`` + ``test_tamagotchi_broadcast.py``.

Fixtures-Pattern identisch zu ``test_plugin_loader.py`` /
``test_plugin_permissions.py``.
"""

from __future__ import annotations

import pytest

from dcc_chat_gateway.plugins import (
    PluginManager,
    discover_plugins_dir,
    load_directory,
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
    """Snapshot + restore both dispatch registries + the plugin manager
    so the rest of the test suite (which relies on the production
    registrations) keeps working.

    Unterschied zu ``test_plugin_loader._isolate_registries``: wir wipen
    die Ops + Channels auch *vor* dem Test, sodass ein vorheriger
    Lifespan-Load nicht den Pre/Post-Diff im PluginManager.activate
    leerräumt.
    """
    saved_ops = {op: get_handler(op) for op in registered_ops()}
    saved_channels = {ch: get_channel_handler(ch) for ch in registered_channels()}
    _reset_manager()
    _clear_ops()
    _clear_channels()
    # Built-in Ops + Channels aus dem Snapshot wiederherstellen — Plugin-
    # Ops (mit ``:``) und Plugin-Channels (mit ``plugin:`` prefix) lassen
    # wir weg; die sollen die Tests selbst aufbauen.
    for op, handler in saved_ops.items():
        if handler is not None and ":" not in op:
            register_ws_op(op, handler)
    for ch, handler in saved_channels.items():
        if handler is not None and not ch.startswith("plugin:"):
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


_EXPECTED_OPS = (
    "tamagotchi:feed",
    "tamagotchi:play",
    "tamagotchi:sleep",
    "tamagotchi:reset",
    "tamagotchi:revive",
)
_EXPECTED_CHANNEL = "plugin:tamagotchi:events"


def test_tamagotchi_plugin_loads_via_discovery(monkeypatch):
    """Discovery + Aktivierung registriert alle vier Action-Ops UND den
    Broadcast-Channel-Handler. Hello-Plugin bleibt parallel aktiv."""
    monkeypatch.delenv("PULSE_PLUGINS_DIR", raising=False)
    plugins_dir = discover_plugins_dir()
    assert plugins_dir is not None
    assert (plugins_dir / "tamagotchi" / "plugin.toml").is_file()

    mgr = PluginManager()
    loaded = load_directory(plugins_dir, manager=mgr)
    names = [m.name for m in loaded]
    assert "tamagotchi" in names
    assert "hello" in names

    rec = mgr.get("tamagotchi")
    assert rec is not None
    assert rec.activated is True
    for op in _EXPECTED_OPS:
        assert get_handler(op) is not None, f"missing handler for {op}"
    assert get_channel_handler(_EXPECTED_CHANNEL) is not None, (
        f"missing channel handler for {_EXPECTED_CHANNEL}"
    )

    # Permission-Gate hat alle Ops + den Channel als declared akzeptiert.
    assert set(_EXPECTED_OPS).issubset(rec.registered_ws_ops)
    assert _EXPECTED_CHANNEL in rec.registered_channels


def test_tamagotchi_passes_strict_permission_gate(monkeypatch):
    """Strict-Mode (Default). Manifest deklariert genau die registrierten
    Ops + Channel; ein Drift würde Rollback + PluginPermissionError
    auslösen."""
    monkeypatch.setenv("PULSE_PLUGIN_PERMISSIONS", "strict")
    monkeypatch.delenv("PULSE_PLUGINS_DIR", raising=False)

    plugins_dir = discover_plugins_dir()
    assert plugins_dir is not None

    mgr = PluginManager()
    load_directory(plugins_dir, manager=mgr)
    rec = mgr.get("tamagotchi")
    assert rec is not None
    assert rec.activated is True
    assert len(rec.registered_ws_ops) == len(_EXPECTED_OPS)
    assert len(rec.registered_channels) == 1


def test_tamagotchi_deactivate_rolls_back_all_ops_and_channel(monkeypatch):
    """Deactivate räumt alle vier Ops UND den Channel-Handler weg.
    Idempotent — zweiter Deactivate-Call darf nicht crashen."""
    monkeypatch.delenv("PULSE_PLUGINS_DIR", raising=False)
    plugins_dir = discover_plugins_dir()
    assert plugins_dir is not None

    mgr = PluginManager()
    load_directory(plugins_dir, manager=mgr)
    mgr.deactivate("tamagotchi")
    for op in _EXPECTED_OPS:
        assert get_handler(op) is None, f"{op} should be gone after deactivate"
    assert get_channel_handler(_EXPECTED_CHANNEL) is None
    # Hello-Plugin bleibt intakt — Deactivate ist plugin-lokal.
    assert get_handler("hello:ping") is not None

    mgr.deactivate("tamagotchi")
