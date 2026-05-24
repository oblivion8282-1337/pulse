"""Tests for the Tamagotchi reference plugin (Schritt 7 Plugin-System).

Tamagotchi ist das erste echte Pulse-Plugin (nach dem ``hello/``-Skelett);
diese Tests stellen sicher, dass:

* das Manifest sauber parst und den Permission-Gate passiert
  (alle vier ``tamagotchi:{feed,play,sleep,reset}``-Ops + die
  ``tamagotchi:ack``-Outbound-Op stehen in ``[plugin.uses].ws_ops``,
  die Settings-Section steht in ``settings_sections``),
* das Backend die vier Ops registriert,
* das Hello-Plugin parallel funktional bleibt (kein Konflikt).

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
    die Ops auch *vor* dem Test, *bevor* wir den Snapshot anlegen. Grund:
    in einem Full-Suite-Run kann die FastAPI-Lifespan (``app.py``) das
    echte Tamagotchi-Plugin vorher schon mal geladen haben (für einen
    anderen Test, der ``TestClient(app)`` benutzt). Dann hätte das
    Snapshot bereits ``tamagotchi:feed`` etc. drin → der Loader würde
    keinen Diff sehen und ``rec.registered_ws_ops`` bliebe leer.
    """
    saved_ops = {op: get_handler(op) for op in registered_ops()}
    saved_channels = {ch: get_channel_handler(ch) for ch in registered_channels()}
    # Pre-test wipe — Plugin-Tests bauen auf clean-slate vom Loader-Diff.
    _reset_manager()
    _clear_ops()
    _clear_channels()
    # Aber: die Built-in-Ops (send/subscribe/…) brauchen wir aus dem
    # Snapshot zurück, sonst crashed die nachgelagerte Suite. Plugin-Ops
    # filtern wir raus — die sollen die einzelnen Tests selbst aufbauen.
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
    # Post-test restore — alle Originalhandler zurück inkl. Plugin-Ops.
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
)


def test_tamagotchi_plugin_loads_via_discovery(monkeypatch):
    """The shipped ``plugins/tamagotchi`` registers all four action ops on
    activation. Discovery + activation must pick it up alongside the
    ``hello/`` skeleton without either blocking the other."""
    monkeypatch.delenv("PULSE_PLUGINS_DIR", raising=False)
    plugins_dir = discover_plugins_dir()
    assert plugins_dir is not None
    assert (plugins_dir / "tamagotchi" / "plugin.toml").is_file()

    mgr = PluginManager()
    loaded = load_directory(plugins_dir, manager=mgr)
    names = [m.name for m in loaded]
    assert "tamagotchi" in names
    # Hello-Plugin bleibt parallel aktiv — Plugins blockieren sich nicht
    # gegenseitig, kein Konflikt erwartet (ws_ops sind disjunkt).
    assert "hello" in names

    rec = mgr.get("tamagotchi")
    assert rec is not None
    assert rec.activated is True
    for op in _EXPECTED_OPS:
        assert get_handler(op) is not None, f"missing handler for {op}"

    # Manifest-Sanity: Permission-Gate hat alle Ops als declared akzeptiert.
    assert set(_EXPECTED_OPS).issubset(rec.registered_ws_ops)


def test_tamagotchi_passes_strict_permission_gate(monkeypatch):
    """Strict mode is the default since Schritt 5. The plugin's manifest
    explicitly declares every op it registers — an undeclared op would
    cause a rollback + PluginPermissionError. This test would catch a
    drift where ``backend.py`` adds an op without updating
    ``plugin.toml``'s ``[plugin.uses].ws_ops`` list."""
    monkeypatch.setenv("PULSE_PLUGIN_PERMISSIONS", "strict")
    monkeypatch.delenv("PULSE_PLUGINS_DIR", raising=False)

    plugins_dir = discover_plugins_dir()
    assert plugins_dir is not None

    mgr = PluginManager()
    load_directory(plugins_dir, manager=mgr)
    rec = mgr.get("tamagotchi")
    assert rec is not None
    assert rec.activated is True
    # Wenn der Gate gefeuert hätte, wäre `registered_ws_ops` leer (rollback)
    # und ein Re-Read würde `failedActivate` flaggen — beides wäre ein
    # Permission-Manifest-Drift-Bug.
    assert len(rec.registered_ws_ops) == len(_EXPECTED_OPS)


def test_tamagotchi_deactivate_rolls_back_all_ops(monkeypatch):
    """Deactivate räumt alle vier Ops weg. Idempotent — der zweite Deactivate-
    Call darf nicht crashen."""
    monkeypatch.delenv("PULSE_PLUGINS_DIR", raising=False)
    plugins_dir = discover_plugins_dir()
    assert plugins_dir is not None

    mgr = PluginManager()
    load_directory(plugins_dir, manager=mgr)
    mgr.deactivate("tamagotchi")
    for op in _EXPECTED_OPS:
        assert get_handler(op) is None, f"{op} should be gone after deactivate"
    # Hello-Plugin bleibt intakt — Deactivate ist plugin-lokal.
    assert get_handler("hello:ping") is not None

    # Zweiter Aufruf ist idempotent.
    mgr.deactivate("tamagotchi")


@pytest.mark.asyncio
async def test_tamagotchi_feed_handler_acks(monkeypatch):
    """End-to-end: einen feed-Frame durch den registrierten Handler jagen
    und prüfen, dass die ack-Frame zurück an die Socket geht. Verifiziert
    den Plugin → Dispatch → ws-Frame-Pfad ohne echte WebSocket-Connection
    (wir reichen einen Fake-Socket mit `send_json` durch).
    """
    monkeypatch.delenv("PULSE_PLUGINS_DIR", raising=False)
    plugins_dir = discover_plugins_dir()
    assert plugins_dir is not None

    mgr = PluginManager()
    load_directory(plugins_dir, manager=mgr)

    handler = get_handler("tamagotchi:feed")
    assert handler is not None

    sent: list[dict[str, object]] = []

    class _FakeSocket:
        async def send_json(self, payload: dict[str, object]) -> None:
            sent.append(payload)

    # WSOpContext interessiert sich nur für `websocket`/`user`/`manager`/
    # `redis` (alle drei letzteren bleiben für diesen Handler ungenutzt).
    from dcc_chat_gateway.routes.ws_ops_registry import WSOpContext

    ctx = WSOpContext(
        websocket=_FakeSocket(),  # type: ignore[arg-type]
        user=None,  # type: ignore[arg-type]
        manager=None,  # type: ignore[arg-type]
        redis=None,  # type: ignore[arg-type]
    )
    await handler(ctx, {"op": "tamagotchi:feed", "echo": "yum"})

    assert len(sent) == 1
    ack = sent[0]
    assert ack["op"] == "tamagotchi:ack"
    assert ack["action"] == "feed"
    assert ack["echo"] == "yum"
