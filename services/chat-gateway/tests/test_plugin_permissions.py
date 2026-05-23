"""Tests for the Plugin permission gate + activation-lifecycle hooks
(Schritt 5 Plugin-System).

The fixtures here mirror ``test_plugin_loader.py``: snapshot the two
dispatch registries + the plugin-manager singleton, wipe them for the
test, restore on teardown. Every test writes a temp plugin directory and
exercises one slice of the permission/lifecycle contract.

Coverage:

A. **strict mode** — declared op activates, undeclared op rolls back
   + raises :class:`PluginPermissionError`. No-uses-block plugin is
   refused outright.
B. **warn mode** — undeclared op stays registered, but a warning is
   logged.
C. **off mode** — undeclared op silently accepted (Schritt-4 behaviour).
D. **deactivate hook** — a plugin's ``register()`` returning
   ``{"deactivate": fn}`` causes ``fn`` to run before the registry diff
   is rolled back.
E. **channel violations** — same gate applies to Redis channels.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from dcc_chat_gateway.plugins import (
    PluginManager,
    PluginPermissionError,
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
    registrations) keeps working. Pattern is identical to
    ``test_plugin_loader._isolate_registries``."""
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


# ---------- Helpers --------------------------------------------------------


def _write_plugin(
    tmp_path: Path,
    name: str,
    *,
    declared_ops: list[str] | None = None,
    declared_channels: list[str] | None = None,
    backend_body: str | None = None,
) -> Path:
    """Write a plugin directory with the given declared `uses` + a
    custom backend body. The body must define ``register()`` (signature
    `() -> None | dict`)."""
    d = tmp_path / name
    d.mkdir()
    uses_lines: list[str] = []
    if declared_ops is not None:
        uses_lines.append(f"ws_ops = {declared_ops!r}")
    if declared_channels is not None:
        uses_lines.append(f"channels = {declared_channels!r}")
    uses_block = ""
    if uses_lines:
        uses_block = "[plugin.uses]\n" + "\n".join(uses_lines) + "\n\n"
    (d / "plugin.toml").write_text(
        textwrap.dedent(
            f'''
            [plugin]
            name = "{name}"
            version = "0.0.1"
            api = "1"

            '''
        ).lstrip()
        + uses_block
        + textwrap.dedent(
            '''
            [plugin.entrypoints]
            backend = "backend:register"
            '''
        ).lstrip()
    )
    (d / "backend.py").write_text(backend_body or "")
    return d


_BACKEND_PRELUDE = (
    "from dcc_chat_gateway.routes.ws_ops_registry import register_ws_op\n"
    "from dcc_chat_gateway.pubsub_channel_registry import (\n"
    "    register_channel_handler,\n"
    ")\n"
    "\n"
    "async def _stub(ctx, msg):\n"
    "    return None\n"
    "\n"
    "async def _chan_stub(manager, channel, msg):\n"
    "    return None\n"
    "\n"
)


def _make_backend(register_body: str) -> str:
    """Wrap a snippet so it becomes a complete backend.py module.

    Building a Python source string with ``textwrap.dedent`` over an
    f-string that *embeds* multi-line user code is brittle (the indent of
    the embedded snippet doesn't match the surrounding indent and dedent
    leaves the inner indentation untouched). We do plain concatenation
    instead — explicit and unambiguous.
    """
    return _BACKEND_PRELUDE + textwrap.dedent(register_body).strip() + "\n"


# ---------- A. Strict mode -------------------------------------------------


def test_strict_default_blocks_undeclared_op(tmp_path: Path, monkeypatch):
    """Default permission mode is strict. Registering an op that's not in
    `uses.ws_ops` rolls back + raises :class:`PluginPermissionError`.

    Critical: the rolled-back op MUST be gone from the dispatch registry,
    otherwise a half-activated plugin could leak handlers.
    """
    monkeypatch.delenv("PULSE_PLUGIN_PERMISSIONS", raising=False)
    _write_plugin(
        tmp_path,
        "alpha",
        declared_ops=["alpha:ok"],
        backend_body=_make_backend(
            'def register():\n'
            '    register_ws_op("alpha:ok", _stub)\n'
            '    register_ws_op("alpha:forbidden", _stub)\n'
        ),
    )
    mgr = PluginManager()
    # load_directory swallows the PluginLoadError into a log, so use the
    # manager methods directly to assert the raise.
    from dcc_chat_gateway.plugins.manifest import parse_manifest

    manifest = parse_manifest(tmp_path / "alpha" / "plugin.toml")
    mgr.add(manifest, tmp_path / "alpha")
    with pytest.raises(PluginPermissionError) as ei:
        mgr.activate("alpha")
    assert ei.value.name == "alpha"
    assert ei.value.undeclared_ops == {"alpha:forbidden"}
    # Rollback completeness: both ops are gone, including the declared one,
    # because the rollback wipes everything new in this activation phase.
    assert get_handler("alpha:ok") is None
    assert get_handler("alpha:forbidden") is None
    rec = mgr.get("alpha")
    assert rec is not None and rec.activated is False


def test_strict_allows_only_declared_ops(tmp_path: Path, monkeypatch):
    """Happy path: the plugin registers exactly what its manifest declares."""
    monkeypatch.setenv("PULSE_PLUGIN_PERMISSIONS", "strict")
    _write_plugin(
        tmp_path,
        "beta",
        declared_ops=["beta:ok"],
        backend_body=_make_backend(
            'def register():\n    register_ws_op("beta:ok", _stub)\n'
        ),
    )
    mgr = PluginManager()
    load_directory(tmp_path, manager=mgr)
    rec = mgr.get("beta")
    assert rec is not None and rec.activated is True
    assert get_handler("beta:ok") is not None


def test_strict_no_uses_block_blocks_any_registration(
    tmp_path: Path, monkeypatch
):
    """A plugin without a ``[plugin.uses]`` section has an *empty* whitelist
    (PluginUses default = all lists empty). In strict mode it can't
    register anything at all."""
    monkeypatch.setenv("PULSE_PLUGIN_PERMISSIONS", "strict")
    _write_plugin(
        tmp_path,
        "gamma",
        declared_ops=None,  # omit the [plugin.uses] block entirely
        backend_body=_make_backend(
            'def register():\n    register_ws_op("gamma:any", _stub)\n'
        ),
    )
    from dcc_chat_gateway.plugins.manifest import parse_manifest

    manifest = parse_manifest(tmp_path / "gamma" / "plugin.toml")
    mgr = PluginManager()
    mgr.add(manifest, tmp_path / "gamma")
    with pytest.raises(PluginPermissionError):
        mgr.activate("gamma")
    assert get_handler("gamma:any") is None


# ---------- B. Warn mode ---------------------------------------------------


def test_warn_mode_keeps_undeclared_but_logs(
    tmp_path: Path, monkeypatch, caplog
):
    """In warn mode, the undeclared op stays registered + a warning is logged.
    Useful when the plugin author is still iterating on the manifest."""
    monkeypatch.setenv("PULSE_PLUGIN_PERMISSIONS", "warn")
    _write_plugin(
        tmp_path,
        "delta",
        declared_ops=["delta:ok"],
        backend_body=_make_backend(
            'def register():\n'
            '    register_ws_op("delta:ok", _stub)\n'
            '    register_ws_op("delta:extra", _stub)\n'
        ),
    )
    mgr = PluginManager()
    with caplog.at_level("WARNING"):
        load_directory(tmp_path, manager=mgr)
    rec = mgr.get("delta")
    assert rec is not None and rec.activated is True
    assert get_handler("delta:ok") is not None
    assert get_handler("delta:extra") is not None
    assert any(
        "undeclared registrations" in r.message and "delta" in r.message
        for r in caplog.records
    )


# ---------- C. Off mode ----------------------------------------------------


def test_off_mode_accepts_undeclared_silently(tmp_path: Path, monkeypatch):
    """``off`` is the Schritt-4 escape hatch — no checks at all. The
    undeclared op activates without warning."""
    monkeypatch.setenv("PULSE_PLUGIN_PERMISSIONS", "off")
    _write_plugin(
        tmp_path,
        "epsilon",
        declared_ops=[],  # empty uses, but off bypasses the check
        backend_body=_make_backend(
            'def register():\n    register_ws_op("epsilon:any", _stub)\n'
        ),
    )
    mgr = PluginManager()
    load_directory(tmp_path, manager=mgr)
    rec = mgr.get("epsilon")
    assert rec is not None and rec.activated is True
    assert get_handler("epsilon:any") is not None


def test_unknown_mode_falls_back_to_strict(tmp_path: Path, monkeypatch):
    """Typo in the env var → fall back to strict (with a log line). We
    don't want a silent permission bypass because someone wrote
    'strikt' instead of 'strict'."""
    monkeypatch.setenv("PULSE_PLUGIN_PERMISSIONS", "strikt")
    _write_plugin(
        tmp_path,
        "zeta",
        declared_ops=["zeta:ok"],
        backend_body=_make_backend(
            'def register():\n    register_ws_op("zeta:forbidden", _stub)\n'
        ),
    )
    from dcc_chat_gateway.plugins.manifest import parse_manifest

    manifest = parse_manifest(tmp_path / "zeta" / "plugin.toml")
    mgr = PluginManager()
    mgr.add(manifest, tmp_path / "zeta")
    with pytest.raises(PluginPermissionError):
        mgr.activate("zeta")


# ---------- D. Deactivate hook --------------------------------------------


def test_deactivate_hook_runs_before_rollback(tmp_path: Path, monkeypatch):
    """The plugin returns ``{"deactivate": fn}``; the loader calls ``fn``
    on deactivate BEFORE the registry rollback. Inside the hook, the
    plugin's own handlers must still be reachable — that's the whole
    point of running the hook first."""
    monkeypatch.setenv("PULSE_PLUGIN_PERMISSIONS", "strict")
    body = """
        from dcc_chat_gateway.routes.ws_ops_registry import (
            register_ws_op, get_handler,
        )

        async def _stub(ctx, msg):
            return None

        seen = {}

        def _cleanup():
            # Read the live registry state at hook-call time.
            seen['handler_was_live'] = get_handler('eta:ok') is not None

        def register():
            register_ws_op('eta:ok', _stub)
            return {'deactivate': _cleanup}
    """
    _write_plugin(
        tmp_path,
        "eta",
        declared_ops=["eta:ok"],
        backend_body=textwrap.dedent(body).strip(),
    )
    mgr = PluginManager()
    load_directory(tmp_path, manager=mgr)
    rec = mgr.get("eta")
    assert rec is not None and rec.deactivate_hook is not None

    mgr.deactivate("eta")
    # Find the plugin module to read its `seen` dict — synthetic key is
    # ``pulse_plugin.<name>.<module>``.
    import sys

    mod = sys.modules.get("pulse_plugin.eta.backend")
    assert mod is not None
    assert mod.seen.get("handler_was_live") is True
    # After deactivate, the handler is gone.
    assert get_handler("eta:ok") is None


def test_deactivate_hook_exception_does_not_block_rollback(
    tmp_path: Path, monkeypatch, caplog
):
    """A misbehaving cleanup hook must not strand the plugin in an
    activated state. The loader logs + swallows."""
    monkeypatch.setenv("PULSE_PLUGIN_PERMISSIONS", "strict")
    body = """
        from dcc_chat_gateway.routes.ws_ops_registry import register_ws_op

        async def _stub(ctx, msg):
            return None

        def _bad():
            raise RuntimeError("boom")

        def register():
            register_ws_op('theta:ok', _stub)
            return {'deactivate': _bad}
    """
    _write_plugin(
        tmp_path,
        "theta",
        declared_ops=["theta:ok"],
        backend_body=textwrap.dedent(body).strip(),
    )
    mgr = PluginManager()
    load_directory(tmp_path, manager=mgr)
    with caplog.at_level("ERROR"):
        mgr.deactivate("theta")
    rec = mgr.get("theta")
    assert rec is not None and rec.activated is False
    assert get_handler("theta:ok") is None
    assert any("deactivate hook raised" in r.message for r in caplog.records)


def test_register_returning_garbage_logs_and_ignores(
    tmp_path: Path, monkeypatch, caplog
):
    """A plugin returning anything other than ``None`` or
    ``{"deactivate": fn}`` triggers a warning but still activates — silent
    drops would hide typos."""
    monkeypatch.setenv("PULSE_PLUGIN_PERMISSIONS", "strict")
    body = """
        from dcc_chat_gateway.routes.ws_ops_registry import register_ws_op

        async def _stub(ctx, msg):
            return None

        def register():
            register_ws_op('iota:ok', _stub)
            return 42  # garbage
    """
    _write_plugin(
        tmp_path,
        "iota",
        declared_ops=["iota:ok"],
        backend_body=textwrap.dedent(body).strip(),
    )
    mgr = PluginManager()
    with caplog.at_level("WARNING"):
        load_directory(tmp_path, manager=mgr)
    rec = mgr.get("iota")
    assert rec is not None and rec.activated is True
    assert rec.deactivate_hook is None
    assert any("register() returned 'int'" in r.message for r in caplog.records)


# ---------- E. Channel violations -----------------------------------------


def test_strict_blocks_undeclared_channel(tmp_path: Path, monkeypatch):
    """The gate applies symmetrically to pubsub channels — declaring a
    channel-handler not in ``uses.channels`` is a permission violation."""
    monkeypatch.setenv("PULSE_PLUGIN_PERMISSIONS", "strict")
    _write_plugin(
        tmp_path,
        "kappa",
        declared_ops=["kappa:ok"],
        declared_channels=["allowed:chan"],
        backend_body=_make_backend(
            'def register():\n'
            '    register_ws_op("kappa:ok", _stub)\n'
            '    register_channel_handler("forbidden:chan", _chan_stub)\n'
        ),
    )
    from dcc_chat_gateway.plugins.manifest import parse_manifest

    manifest = parse_manifest(tmp_path / "kappa" / "plugin.toml")
    mgr = PluginManager()
    mgr.add(manifest, tmp_path / "kappa")
    with pytest.raises(PluginPermissionError) as ei:
        mgr.activate("kappa")
    assert ei.value.undeclared_channels == {"forbidden:chan"}
    # Rollback wipes both the channel + the (declared) op.
    assert get_handler("kappa:ok") is None
    assert get_channel_handler("forbidden:chan") is None


# ---------- F. Hello-plugin smoke test ------------------------------------


def test_real_hello_plugin_passes_strict_gate(monkeypatch):
    """The shipped ``plugins/hello`` declares ``ws_ops=["hello:ping"]`` and
    registers exactly that — must survive the strict gate intact."""
    monkeypatch.setenv("PULSE_PLUGIN_PERMISSIONS", "strict")
    monkeypatch.delenv("PULSE_PLUGINS_DIR", raising=False)
    from dcc_chat_gateway.plugins import discover_plugins_dir

    plugins_dir = discover_plugins_dir()
    assert plugins_dir is not None
    mgr = PluginManager()
    load_directory(plugins_dir, manager=mgr)
    rec = mgr.get("hello")
    assert rec is not None
    assert rec.activated is True
    assert get_handler("hello:ping") is not None
