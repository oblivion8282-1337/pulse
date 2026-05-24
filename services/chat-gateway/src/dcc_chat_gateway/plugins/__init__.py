"""Pulse backend plugin loader (Schritt 4 + 5 Plugin-System).

Scans a configured plugin directory, parses ``plugin.toml`` manifests, and
calls each plugin's ``register()`` entrypoint. Plugins register WS ops +
pub/sub channel handlers via the Schritt-2 decorators
(`dcc_chat_gateway.routes.ws_ops_registry.register_ws_op`,
`dcc_chat_gateway.pubsub_channel_registry.register_channel_handler`) — this
loader only takes care of *finding* and *invoking* the plugin code, plus
tracking what each plugin registered so a later `deactivate(name)` call can
roll the registrations back.

Schritt-5 additions
-------------------
* Permission gate against ``[plugin.uses]`` (see :mod:`.permissions` and
  ``docs/PLUGIN_ROADMAP.md``). Strict by default; tunable via
  ``$PULSE_PLUGIN_PERMISSIONS=strict|warn|off``.
* Activation lifecycle: a plugin's ``register()`` may return
  ``{"deactivate": fn}``; ``fn`` runs before the registry rollback when
  the loader deactivates the plugin.

Discovery
---------
* Default directory: ``<repo-root>/plugins/`` (resolved relative to this
  file's package location — walks up to the first ancestor containing a
  ``plugins/`` subdir).
* Override: env var ``PULSE_PLUGINS_DIR`` — absolute path.

The loader is **opt-in** for production code: nothing imports it
automatically. The chat-gateway lifespan calls ``load_all()`` once at
startup. Tests can call ``load_directory(path)`` against a temp dir.

Public API
~~~~~~~~~~
* :func:`load_all`             — convenience wrapper: discover dir + load
* :func:`load_directory(path)` — load every plugin in ``path``
* :class:`PluginManager`       — full lifecycle (activate/deactivate)
* :class:`PluginManifest`      — pydantic model for parsed ``plugin.toml``
* :class:`PluginPermissionError` — raised in ``strict`` mode when a plugin
  registers an undeclared interface
"""

from __future__ import annotations

from dcc_chat_gateway.plugins.allowlist import (
    HELLO_PLUGIN_NAME,
    add_to_allowlist,
    ensure_hello_in_allowlist,
    list_allowed_names,
    remove_from_allowlist,
    update_plugin_allowlist_snapshot,
)
from dcc_chat_gateway.plugins.loader import (
    DEFAULT_PLUGIN_API,
    LoadResult,
    PluginLoadError,
    activate_plugin,
    deactivate_plugin,
    discover_manifests,
    discover_plugins_dir,
    load_all,
    load_all_with_allowlist,
    load_directory,
    load_directory_with_allowlist,
)
from dcc_chat_gateway.plugins.manifest import (
    IncompatibleApiError,
    PluginManifest,
    PluginScope,
    PluginUses,
    parse_manifest,
)
from dcc_chat_gateway.plugins.permissions import (
    DEFAULT_PERMISSION_MODE,
    PermissionMode,
    PluginPermissionError,
    resolve_permission_mode,
)
from dcc_chat_gateway.plugins.registry import PluginManager, PluginRecord, get_manager

__all__ = [
    "DEFAULT_PERMISSION_MODE",
    "DEFAULT_PLUGIN_API",
    "HELLO_PLUGIN_NAME",
    "IncompatibleApiError",
    "LoadResult",
    "PermissionMode",
    "PluginLoadError",
    "PluginManager",
    "PluginManifest",
    "PluginPermissionError",
    "PluginRecord",
    "PluginScope",
    "PluginUses",
    "activate_plugin",
    "add_to_allowlist",
    "deactivate_plugin",
    "discover_manifests",
    "discover_plugins_dir",
    "ensure_hello_in_allowlist",
    "get_manager",
    "list_allowed_names",
    "load_all",
    "load_all_with_allowlist",
    "load_directory",
    "load_directory_with_allowlist",
    "parse_manifest",
    "remove_from_allowlist",
    "resolve_permission_mode",
    "update_plugin_allowlist_snapshot",
]
