"""Plugin lifecycle registry — tracks loaded plugins + activate/deactivate.

The :class:`PluginManager` is the *runtime* state matching what the
:mod:`loader` discovered on disk. For each plugin we hold:

* the parsed :class:`~dcc_chat_gateway.plugins.manifest.PluginManifest`
* whether it's currently activated
* the set of WS ops + channel handlers it registered while activated
  (so deactivate can roll them back cleanly)
* (Schritt 5) the optional ``deactivate()`` callback the plugin's
  ``register()`` returned — runs before the registry rollback.

The dispatch registries themselves (`ws_ops_registry._handlers` and
`pubsub_channel_registry._handlers`) are *not* aware of which plugin
registered which entry. We snapshot the registry state before/after
``register()`` runs to figure out the diff — this avoids changing the
registry's public API for plugin attribution.

Schritt 5 — permission gate
---------------------------
After the ``register()`` diff is captured, we cross-check it against the
manifest's ``[plugin.uses]`` whitelist. In ``strict`` mode (default) an
undeclared op or channel rolls back the registrations and raises
:class:`~.permissions.PluginPermissionError`; ``warn`` logs but accepts;
``off`` skips the check. Mode is read fresh on each ``activate()`` from
``$PULSE_PLUGIN_PERMISSIONS``. The pure-functional bits (mode resolver,
violation diff, error type) live in :mod:`.permissions` so this module
stays focused on lifecycle.

Concurrent activate/deactivate isn't supported (and isn't needed — the
loader runs at app startup; UI activation is single-user). The manager
is a process-global singleton accessible via :func:`get_manager`.
"""

from __future__ import annotations

import asyncio
import importlib.util
import logging
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType

from dcc_chat_gateway.plugins.manifest import PluginManifest
from dcc_chat_gateway.plugins.permissions import (
    PluginPermissionError,
    compute_violations,
    resolve_permission_mode,
)
from dcc_chat_gateway.pubsub_channel_registry import (
    registered_channels,
    unregister_channel_handler,
)
from dcc_chat_gateway.routes.ws_ops_registry import (
    registered_ops,
    unregister_ws_op,
)

log = logging.getLogger(__name__)


@dataclass
class PluginRecord:
    """Per-plugin runtime state held by the :class:`PluginManager`."""

    manifest: PluginManifest
    directory: Path
    activated: bool = False
    # Tracking of *what* the plugin registered while activated, so
    # deactivate can roll back precisely. Filled by the diff captured
    # around the plugin's `register()` call.
    registered_ws_ops: set[str] = field(default_factory=set)
    registered_channels: set[str] = field(default_factory=set)
    # Optional plugin-supplied cleanup callback. The plugin's `register()`
    # may return ``{"deactivate": fn}``; the loader stashes ``fn`` here and
    # calls it from :meth:`deactivate` *before* the registry diff is rolled
    # back, so the plugin sees its own ops/channels still live during its
    # cleanup (e.g. to send a final farewell frame).
    deactivate_hook: Callable[[], None] | None = None


class PluginManager:
    """Single-process plugin lifecycle owner.

    Use :func:`get_manager` instead of constructing directly — tests can
    swap the singleton via :func:`_reset_for_tests` for isolation.
    """

    def __init__(self) -> None:
        self._records: dict[str, PluginRecord] = {}

    # ---- discovery / registration --------------------------------------

    def add(self, manifest: PluginManifest, directory: Path) -> PluginRecord:
        """Record a discovered plugin without activating it."""
        if manifest.name in self._records:
            raise ValueError(f"plugin {manifest.name!r} already added")
        rec = PluginRecord(manifest=manifest, directory=directory)
        self._records[manifest.name] = rec
        return rec

    def get(self, name: str) -> PluginRecord | None:
        return self._records.get(name)

    def list(self) -> list[PluginRecord]:
        return list(self._records.values())

    # ---- activate / deactivate -----------------------------------------

    def activate(self, name: str) -> PluginRecord:
        """Import the plugin's backend entrypoint and call ``register()``.

        Idempotent — re-activating a live plugin is a no-op and the
        existing registration set is preserved.
        """
        rec = self._records.get(name)
        if rec is None:
            raise KeyError(f"unknown plugin: {name!r}")
        if rec.activated:
            return rec

        ep = rec.manifest.entrypoints.backend
        if ep is None:
            # Frontend-only plugin — there's nothing to do on the backend
            # but mark it active so the manager state stays symmetric.
            rec.activated = True
            return rec

        try:
            module_name, _, func_name = ep.partition(":")
            if not module_name or not func_name:
                raise ValueError(
                    f"plugin {name!r}: backend entrypoint {ep!r} must be 'module:function'"
                )

            # Snapshot BEFORE the plugin module is imported — both
            # import-time `@register_ws_op` decorations and the explicit
            # `register()` call must be tracked, so deactivate() can roll
            # them back.
            before_ops = set(registered_ops())
            before_channels = set(registered_channels())

            # Load the plugin module from its file directly with a unique
            # ``sys.modules`` key (``pulse_plugin.<name>.<module>``) — this
            # sidesteps the cache-by-bare-name problem when two plugins
            # both ship a ``backend.py``. We keep the module in
            # ``sys.modules`` so subsequent ``importlib.import_module``
            # calls from inside the plugin (e.g. for sibling modules) hit
            # the same instance.
            module = _load_plugin_module(name, module_name, rec.directory)

            register_fn = getattr(module, func_name, None)
            if not callable(register_fn):
                raise AttributeError(
                    f"plugin {name!r}: {ep!r} did not resolve to a callable"
                )
            result = register_fn()

            new_ops = set(registered_ops()) - before_ops
            new_channels = set(registered_channels()) - before_channels

            # ---- Schritt-5 permission gate -------------------------------
            # Compare what the plugin actually registered against the
            # manifest's `[plugin.uses]` whitelist. Any registration not on
            # the list is an undeclared capability — in ``strict`` mode we
            # roll back and raise; in ``warn`` we log but accept. ``off``
            # short-circuits the whole check (Schritt-4 behaviour).
            mode = resolve_permission_mode()
            undeclared_ops, undeclared_channels = compute_violations(
                declared_ops=set(rec.manifest.uses.ws_ops),
                declared_channels=set(rec.manifest.uses.channels),
                new_ops=new_ops,
                new_channels=new_channels,
            )
            if (undeclared_ops or undeclared_channels) and mode != "off":
                if mode == "strict":
                    # Roll back every new registration before raising so
                    # the dispatch tables can't observe a half-activated
                    # plugin.
                    self._unregister_registrations(new_ops, new_channels)
                    raise PluginPermissionError(
                        name, undeclared_ops, undeclared_channels
                    )
                # warn: log but keep — useful during plugin authoring.
                log.warning(
                    "plugin %s: undeclared registrations (mode=warn) "
                    "ops=%s channels=%s",
                    name,
                    sorted(undeclared_ops),
                    sorted(undeclared_channels),
                )

            rec.registered_ws_ops = new_ops
            rec.registered_channels = new_channels
            rec.deactivate_hook = _extract_deactivate_hook(name, result)
            rec.activated = True
            log.info(
                "plugin %s activated (ws_ops=%d channels=%d hook=%s mode=%s)",
                name,
                len(rec.registered_ws_ops),
                len(rec.registered_channels),
                rec.deactivate_hook is not None,
                mode,
            )
            return rec
        except Exception:
            log.exception("plugin %s: activation failed", name)
            raise

    # ---- helpers -----------------------------------------------------------

    @staticmethod
    def _unregister_registrations(
        ops: object, channels: object
    ) -> None:
        """Unregister every WS op and channel handler in *ops* / *channels*.

        Accepts any iterable (set, list, …). Snapshots both into lists
        before iterating so callers need not worry about mutation-during-
        iteration when passing live sets.
        """
        for op in list(ops):  # type: ignore[arg-type]
            unregister_ws_op(op)
        for ch in list(channels):  # type: ignore[arg-type]
            unregister_channel_handler(ch)

    def deactivate(self, name: str) -> PluginRecord:
        """Remove every WS op + channel handler the plugin registered.

        Idempotent — deactivating an already-inactive plugin is a no-op.

        Order matters: the plugin's own ``deactivate()`` hook (returned
        from its ``register()``) runs *before* the loader rolls back the
        registry diff. That lets the plugin observe its own ops/channels
        still live for the duration of cleanup (e.g. to broadcast a final
        frame). A hook exception is logged + swallowed — rollback must
        always complete.
        """
        rec = self._records.get(name)
        if rec is None:
            raise KeyError(f"unknown plugin: {name!r}")
        if not rec.activated:
            return rec
        if rec.deactivate_hook is not None:
            try:
                rec.deactivate_hook()
            except Exception:  # noqa: BLE001
                log.exception("plugin %s: deactivate hook raised", name)
        self._unregister_registrations(rec.registered_ws_ops, rec.registered_channels)
        rec.registered_ws_ops.clear()
        rec.registered_channels.clear()
        rec.deactivate_hook = None
        rec.activated = False
        log.info("plugin %s deactivated", name)
        return rec

    def forget(self, name: str) -> bool:
        """Drop the manager's record for ``name`` entirely.

        Stronger than :meth:`deactivate` — that one rolls back the
        registry diff but keeps the :class:`PluginRecord` around (so
        a later :meth:`activate` doesn't need to re-discover the
        plugin). :meth:`forget` removes the record completely; the
        next time the loader runs (after a service restart), the
        record gets rebuilt from disk.

        Used by the admin-API ``DELETE /admin/plugins/{name}`` path
        when a plugin flies out of the instance allowlist: we want
        the manager to forget it ever existed so an accidental
        re-add doesn't reactivate stale state.

        Returns ``True`` if a record was removed, ``False`` otherwise.
        Best-effort: if the plugin was still activated, we try
        :meth:`deactivate` first and swallow any errors — forgetting
        must always succeed.
        """
        rec = self._records.get(name)
        if rec is None:
            return False
        if rec.activated:
            try:
                self.deactivate(name)
            except Exception:  # noqa: BLE001
                log.exception(
                    "plugin %s: deactivate during forget failed; "
                    "dropping record anyway",
                    name,
                )
        self._records.pop(name, None)
        return True

    def deactivate_all(self) -> None:
        for name in list(self._records):
            try:
                self.deactivate(name)
            except Exception:  # noqa: BLE001
                log.exception("plugin %s: deactivate failed", name)


_manager: PluginManager | None = None


def get_manager() -> PluginManager:
    """Return the process-global :class:`PluginManager`, creating it on
    first call. The chat-gateway lifespan + the loader use this; tests
    call :func:`_reset_for_tests` to start from a clean state."""
    global _manager
    if _manager is None:
        _manager = PluginManager()
    return _manager


def _reset_for_tests() -> None:
    """Drop the singleton so the next :func:`get_manager` builds a fresh
    one. Combine with `ws_ops_registry._clear_for_tests` /
    `pubsub_channel_registry._clear_for_tests` to fully isolate state."""
    global _manager
    if _manager is not None:
        _manager.deactivate_all()
    _manager = None
    # Drop the synthetic `pulse_plugin.*` modules so a re-load (e.g. in
    # tests that spin a fresh temp plugin dir under the same name) picks
    # up the file from disk instead of the cached module object.
    for key in [k for k in sys.modules if k.startswith("pulse_plugin.")]:
        sys.modules.pop(key, None)


def _extract_deactivate_hook(
    plugin_name: str, result: object
) -> Callable[[], None] | None:
    """Pull an optional ``deactivate`` callable out of what ``register()``
    returned. Accepted shapes:

    * ``None``                        — no hook (most plugins).
    * ``{"deactivate": fn}``          — explicit dict form, mirrors the
      frontend's ``{ deactivate?: () => void }``.

    Anything else logs a warning and is ignored — silently dropping the
    return value would hide a typo in the plugin code.
    """
    if result is None:
        return None
    if isinstance(result, dict):
        hook = result.get("deactivate")
        if hook is None:
            return None
        if asyncio.iscoroutinefunction(hook):
            log.warning(
                "plugin %s: register() returned async 'deactivate' hook; "
                "async hooks are not supported — hook will be ignored. "
                "Convert to a synchronous function.",
                plugin_name,
            )
            return None
        if callable(hook):
            return hook  # type: ignore[return-value]
        log.warning(
            "plugin %s: register() returned dict with non-callable "
            "'deactivate' (%r); ignoring",
            plugin_name,
            type(hook).__name__,
        )
        return None
    log.warning(
        "plugin %s: register() returned %r; expected None or "
        "{'deactivate': callable}",
        plugin_name,
        type(result).__name__,
    )
    return None


def _load_plugin_module(
    plugin_name: str, module_name: str, directory: Path
) -> ModuleType:
    """Load ``<directory>/<module_name>.py`` under the synthetic dotted
    name ``pulse_plugin.<plugin_name>.<module_name>``.

    Using a unique key per plugin avoids the import cache hazard where two
    plugins both ship a top-level ``backend.py``: a bare
    ``importlib.import_module("backend")`` returns whichever copy hit the
    interpreter first.
    """
    file_path = directory / f"{module_name}.py"
    if not file_path.is_file():
        raise ModuleNotFoundError(
            f"plugin {plugin_name!r}: entrypoint module {file_path} not found"
        )
    full_name = f"pulse_plugin.{plugin_name}.{module_name}"
    spec = importlib.util.spec_from_file_location(full_name, file_path)
    if spec is None or spec.loader is None:
        raise ImportError(
            f"plugin {plugin_name!r}: could not load spec for {file_path}"
        )
    module = importlib.util.module_from_spec(spec)
    sys.modules[full_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        # Roll the half-loaded module out of sys.modules so a retry can
        # start clean.
        sys.modules.pop(full_name, None)
        raise
    return module
