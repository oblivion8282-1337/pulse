"""Filesystem-level plugin discovery + load.

The loader walks a plugin directory, parses each ``plugin.toml``, hands
the manifest to the :class:`~dcc_chat_gateway.plugins.registry.PluginManager`,
and activates everything it found. The Schritt-4 default policy is
**auto-activate every discovered plugin** — Schritt 6 will introduce a
persisted activate-state.

Discovery
---------
* ``PULSE_PLUGINS_DIR`` env var → absolute path used as-is.
* Otherwise walk up from this file's package directory until we hit
  an ancestor that contains a sibling ``plugins/`` folder.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from pydantic import ValidationError

from dcc_chat_gateway.plugins.manifest import (
    DEFAULT_PLUGIN_API,
    IncompatibleApiError,
    PluginManifest,
    parse_manifest,
)
from dcc_chat_gateway.plugins.registry import PluginManager, get_manager

log = logging.getLogger(__name__)

# Re-export so consumers don't need to import from two modules.
__all__ = [
    "DEFAULT_PLUGIN_API",
    "PluginLoadError",
    "discover_plugins_dir",
    "load_all",
    "load_directory",
]


class PluginLoadError(RuntimeError):
    """Wraps a single-plugin load failure with the plugin's directory.

    The loader catches per-plugin errors so one bad plugin can't break
    the others. This exception type is the structured payload it logs.
    """

    def __init__(self, directory: Path, cause: BaseException) -> None:
        super().__init__(f"plugin {directory.name!r}: {cause}")
        self.directory = directory
        self.cause = cause


def discover_plugins_dir() -> Path | None:
    """Resolve the plugin directory.

    Order:
    1. ``$PULSE_PLUGINS_DIR`` env var (must point at an existing dir).
    2. Walk up the package tree until we find a ``plugins/`` sibling.
    Returns ``None`` if neither approach finds a directory.
    """
    env = os.environ.get("PULSE_PLUGINS_DIR", "").strip()
    if env:
        p = Path(env).expanduser().resolve()
        if p.is_dir():
            return p
        log.warning("PULSE_PLUGINS_DIR=%r is not an existing directory", env)
        return None

    # Walk up from this file's location (services/chat-gateway/src/dcc_chat_gateway/plugins/loader.py)
    # to the first ancestor that has a sibling ``plugins/`` directory at
    # the repo root.
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "plugins"
        if candidate.is_dir() and candidate != here.parent:
            return candidate
    return None


def _load_one(directory: Path, manager: PluginManager) -> PluginManifest | None:
    """Parse one plugin directory + activate. Returns the manifest on
    success, ``None`` on a tolerated failure (logged + skipped)."""
    manifest_path = directory / "plugin.toml"
    if not manifest_path.is_file():
        # Silently skip directories without a manifest — they could be
        # docs, a draft plugin without a TOML yet, etc.
        return None
    try:
        manifest = parse_manifest(manifest_path)
    except IncompatibleApiError as exc:
        log.error("plugin %s: incompatible API: %s", directory.name, exc)
        return None
    except ValidationError as exc:
        log.error("plugin %s: invalid manifest: %s", directory.name, exc)
        return None
    if manifest.name != directory.name:
        log.error(
            "plugin %s: manifest name %r does not match directory name",
            directory.name,
            manifest.name,
        )
        return None
    try:
        manager.add(manifest, directory)
        manager.activate(manifest.name)
    except Exception as exc:  # noqa: BLE001
        log.exception("plugin %s: load failed", directory.name)
        raise PluginLoadError(directory, exc) from exc
    return manifest


def load_directory(
    path: Path, *, manager: PluginManager | None = None
) -> list[PluginManifest]:
    """Discover + load every plugin under ``path``. Returns the list of
    successfully-loaded manifests, in directory-sorted order.

    Per-plugin errors are logged and the rest of the directory is
    processed — a broken plugin must not gate the working ones.
    """
    mgr = manager if manager is not None else get_manager()
    if not path.is_dir():
        log.info("plugin directory %s does not exist; nothing to load", path)
        return []
    loaded: list[PluginManifest] = []
    for child in sorted(path.iterdir()):
        if not child.is_dir() or child.name.startswith((".", "_")):
            continue
        try:
            manifest = _load_one(child, mgr)
        except PluginLoadError:
            # Already logged in _load_one.
            continue
        if manifest is not None:
            loaded.append(manifest)
    log.info("loaded %d plugin(s) from %s", len(loaded), path)
    return loaded


def load_all(*, manager: PluginManager | None = None) -> list[PluginManifest]:
    """Discover the default plugin directory + load it.

    No-op (returns ``[]``) if no plugin directory is found.
    """
    path = discover_plugins_dir()
    if path is None:
        log.info("no plugin directory discovered; plugin loader idle")
        return []
    return load_directory(path, manager=manager)
