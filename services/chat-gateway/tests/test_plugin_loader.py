"""Tests for the Pulse Plugin-Loader (Schritt 4 Plugin-System).

The tests cover four layers:

1. **Manifest parsing** — pydantic shape + ``IncompatibleApiError``.
2. **Discovery** — env-var override + repo-root walk.
3. **PluginManager lifecycle** — activate registers, deactivate rolls back.
4. **End-to-end** — point the loader at a temp dir with a fake plugin and
   verify the WS-op-registry sees the registration.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest
from pydantic import ValidationError

from dcc_chat_gateway.plugins import (
    IncompatibleApiError,
    PluginManager,
    PluginManifest,
    discover_plugins_dir,
    load_directory,
    parse_manifest,
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

# Built-in op set we have to restore around each test so the rest of the
# suite (which relies on the production registrations) keeps working.
_BUILTIN_OPS = (
    "send", "subscribe", "unsubscribe",
    "voice_self_state",
    "watch_start", "watch_stop", "watch_control", "watch_heartbeat",
    "activity",
)


@pytest.fixture(autouse=True)
def _isolate_registries():
    """Snapshot + restore both dispatch registries + the plugin manager
    so a test that wipes them doesn't leak into the rest of the suite.

    Pattern mirrors the existing ``test_ws_op_registry`` /
    ``test_pubsub_channel_registry`` fixtures — capture every callable,
    wipe, restore.
    """
    saved_ops = {op: get_handler(op) for op in registered_ops()}
    saved_channels = {ch: get_channel_handler(ch) for ch in registered_channels()}
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


# ---------- A. Manifest parsing -------------------------------------------


def _write_manifest(tmp_path: Path, body: str) -> Path:
    f = tmp_path / "plugin.toml"
    f.write_text(textwrap.dedent(body).lstrip("\n"))
    return f


def test_parse_minimal_manifest(tmp_path: Path):
    p = _write_manifest(tmp_path, '''
        [plugin]
        name = "hello"
        version = "0.1.0"
        api = "1"
    ''')
    m = parse_manifest(p)
    assert isinstance(m, PluginManifest)
    assert m.name == "hello"
    assert m.scope.type == "global"
    assert m.uses.ws_ops == []
    assert m.entrypoints.backend is None


def test_parse_full_manifest(tmp_path: Path):
    p = _write_manifest(tmp_path, '''
        [plugin]
        name = "tama"
        version = "1.2.3"
        api = "1"
        author = "Pulse Maintainer"
        description = "Virtuelles Haustier"

        [plugin.scope]
        type = "per-user"

        [plugin.uses]
        ws_ops = ["tama:feed", "tama:reset"]
        channels = ["tama:events"]

        [plugin.entrypoints]
        backend = "backend:register"
        frontend = "frontend.ts"
    ''')
    m = parse_manifest(p)
    assert m.name == "tama"
    assert m.scope.type == "per-user"
    assert m.uses.ws_ops == ["tama:feed", "tama:reset"]
    assert m.uses.channels == ["tama:events"]
    assert m.entrypoints.backend == "backend:register"
    assert m.entrypoints.frontend == "frontend.ts"


def test_parse_rejects_wrong_api(tmp_path: Path):
    p = _write_manifest(tmp_path, '''
        [plugin]
        name = "broken"
        version = "0.0.1"
        api = "99"
    ''')
    with pytest.raises(IncompatibleApiError) as ei:
        parse_manifest(p)
    assert ei.value.name == "broken"
    assert ei.value.requested == "99"


def test_parse_rejects_bad_name(tmp_path: Path):
    p = _write_manifest(tmp_path, '''
        [plugin]
        name = "Has-Caps"
        version = "0.0.1"
        api = "1"
    ''')
    with pytest.raises(ValidationError):
        parse_manifest(p)


def test_parse_rejects_missing_top_table(tmp_path: Path):
    p = _write_manifest(tmp_path, '''
        name = "no-table"
        version = "0.0.1"
    ''')
    with pytest.raises(ValueError):
        parse_manifest(p)


# ---------- B. Discovery --------------------------------------------------


def test_discover_uses_env_var_when_set(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("PULSE_PLUGINS_DIR", str(tmp_path))
    assert discover_plugins_dir() == tmp_path


def test_discover_env_var_nonexistent_returns_none(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("PULSE_PLUGINS_DIR", str(tmp_path / "missing"))
    assert discover_plugins_dir() is None


def test_discover_walks_up_to_repo_root(monkeypatch):
    """Without an env var, the loader should find the repo-root ``plugins/``
    we ship the hello-skeleton in."""
    monkeypatch.delenv("PULSE_PLUGINS_DIR", raising=False)
    found = discover_plugins_dir()
    assert found is not None
    assert found.name == "plugins"
    assert (found / "hello" / "plugin.toml").is_file()


# ---------- C. PluginManager lifecycle ------------------------------------


def _make_plugin(
    tmp_path: Path, name: str, backend: str | None = "backend:register"
) -> Path:
    """Write a minimal plugin to ``tmp_path/<name>/``. The backend module
    registers an op ``<name>:ping`` so we can verify the registration."""
    d = tmp_path / name
    d.mkdir()
    ep = (
        f'backend = "{backend}"\n'
        if backend is not None
        else ""
    )
    (d / "plugin.toml").write_text(textwrap.dedent(f'''
        [plugin]
        name = "{name}"
        version = "0.0.1"
        api = "1"

        [plugin.entrypoints]
        {ep}
    ''').strip() + "\n")
    if backend == "backend:register":
        (d / "backend.py").write_text(textwrap.dedent(f'''
            from dcc_chat_gateway.routes.ws_ops_registry import register_ws_op

            async def _ping(ctx, msg):
                return None

            def register():
                register_ws_op("{name}:ping", _ping)
        ''').strip() + "\n")
    return d


def test_load_directory_activates_plugin(tmp_path: Path):
    _clear_ops()
    _make_plugin(tmp_path, "alpha")
    mgr = PluginManager()
    loaded = load_directory(tmp_path, manager=mgr)
    assert [m.name for m in loaded] == ["alpha"]
    rec = mgr.get("alpha")
    assert rec is not None
    assert rec.activated is True
    assert "alpha:ping" in rec.registered_ws_ops
    assert get_handler("alpha:ping") is not None


def test_deactivate_removes_registrations(tmp_path: Path):
    _clear_ops()
    _make_plugin(tmp_path, "beta")
    mgr = PluginManager()
    load_directory(tmp_path, manager=mgr)
    assert get_handler("beta:ping") is not None
    mgr.deactivate("beta")
    assert get_handler("beta:ping") is None
    rec = mgr.get("beta")
    assert rec is not None
    assert rec.activated is False
    assert rec.registered_ws_ops == set()


def test_deactivate_is_idempotent(tmp_path: Path):
    _clear_ops()
    _make_plugin(tmp_path, "gamma")
    mgr = PluginManager()
    load_directory(tmp_path, manager=mgr)
    mgr.deactivate("gamma")
    # Second call must not raise.
    mgr.deactivate("gamma")


def test_frontend_only_plugin_activates_without_backend(tmp_path: Path):
    _clear_ops()
    _make_plugin(tmp_path, "delta", backend=None)
    # Add a frontend entry by hand — backend is intentionally missing.
    (tmp_path / "delta" / "plugin.toml").write_text(textwrap.dedent('''
        [plugin]
        name = "delta"
        version = "0.0.1"
        api = "1"

        [plugin.entrypoints]
        frontend = "frontend.ts"
    ''').strip() + "\n")
    mgr = PluginManager()
    loaded = load_directory(tmp_path, manager=mgr)
    assert [m.name for m in loaded] == ["delta"]
    rec = mgr.get("delta")
    assert rec is not None
    assert rec.activated is True
    assert rec.registered_ws_ops == set()


def test_loader_skips_dir_without_manifest(tmp_path: Path):
    (tmp_path / "not-a-plugin").mkdir()
    (tmp_path / "not-a-plugin" / "README.md").write_text("hi")
    mgr = PluginManager()
    loaded = load_directory(tmp_path, manager=mgr)
    assert loaded == []


def test_loader_skips_mismatched_directory_name(tmp_path: Path, caplog):
    d = tmp_path / "actual-dir"
    d.mkdir()
    (d / "plugin.toml").write_text(textwrap.dedent('''
        [plugin]
        name = "different-name"
        version = "0.0.1"
        api = "1"
    ''').strip() + "\n")
    mgr = PluginManager()
    loaded = load_directory(tmp_path, manager=mgr)
    assert loaded == []


def test_loader_one_bad_plugin_does_not_block_others(tmp_path: Path):
    """A plugin with an unsupported api version must not gate the others."""
    _clear_ops()
    _make_plugin(tmp_path, "good")
    bad = tmp_path / "bad"
    bad.mkdir()
    (bad / "plugin.toml").write_text(textwrap.dedent('''
        [plugin]
        name = "bad"
        version = "0.0.1"
        api = "99"
    ''').strip() + "\n")
    mgr = PluginManager()
    loaded = load_directory(tmp_path, manager=mgr)
    assert [m.name for m in loaded] == ["good"]
    assert get_handler("good:ping") is not None


# ---------- D. End-to-end: hello-plugin in plugins/ -----------------------


def test_real_hello_plugin_loads_via_discovery(monkeypatch):
    """The shipped ``plugins/hello`` registers ``hello:ping`` on activation."""
    _clear_ops()
    _reset_manager()
    monkeypatch.delenv("PULSE_PLUGINS_DIR", raising=False)
    plugins_dir = discover_plugins_dir()
    assert plugins_dir is not None

    mgr = PluginManager()
    loaded = load_directory(plugins_dir, manager=mgr)
    names = [m.name for m in loaded]
    assert "hello" in names
    assert get_handler("hello:ping") is not None
    rec = mgr.get("hello")
    assert rec is not None
    assert rec.activated is True
