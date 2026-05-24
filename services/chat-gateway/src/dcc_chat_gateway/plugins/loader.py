"""Filesystem-level plugin discovery + load.

The loader walks a plugin directory, parses each ``plugin.toml``, hands
the manifest to the :class:`~dcc_chat_gateway.plugins.registry.PluginManager`,
and activates everything that's in the instance allowlist.

Allowlist-Gate (Schritt "Plugin-Admin-Aktivierung")
---------------------------------------------------
Ab dieser Etappe wird **nicht mehr alles auto-aktiviert**, was unter
``plugins/`` liegt. Stattdessen lädt der Loader beim Startup einen
Snapshot der Tabelle ``chat.instance_plugin_allowlist`` und aktiviert
nur Plugins, deren Name in der Allowlist steht. Nicht-erlaubte
Plugins werden trotzdem entdeckt (für die Admin-API sichtbar als
``discovered_but_not_allowed``), aber ihre WS-Ops/Channels/Settings-
Sections werden nicht in die Dispatch-Registries eingetragen.

Hot-Reload
~~~~~~~~~~
Allowlist-Mutationen über die Admin-API **wirken erst nach einem
Service-Restart**. Hot-Reload wäre riskant (laufende WS-Verbindungen
haben Snapshots der Op-Registries im Zustand zur Connect-Zeit; neue
Plugin-Ops mitten in einer Session führen leicht zu Verwirrung). Wenn
das später nötig wird: eine Pub/Sub-Channel ``plugin:allowlist`` mit
``loader.refresh()``-Signal wäre der Pfad. Heute: Doku-Hinweis und
fertig.

Hello-Self-Heal
~~~~~~~~~~~~~~~
Vor dem Allowlist-Read garantiert der Loader, dass ``hello`` in der
Allowlist steht (Idempotent-Insert). Backup zur Migrations-Seed: falls
jemand den Eintrag manuell entfernt hat, kommt er beim nächsten
Startup wieder.

Discovery
---------
* ``PULSE_PLUGINS_DIR`` env var → absolute path used as-is.
* Otherwise walk up from this file's package directory until we hit
  an ancestor that contains a sibling ``plugins/`` folder.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
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
    "LoadResult",
    "PluginLoadError",
    "discover_plugins_dir",
    "discover_manifests",
    "load_all",
    "load_all_with_allowlist",
    "load_directory",
    "load_directory_with_allowlist",
]


@dataclass
class LoadResult:
    """Resultat eines Allowlist-gegateten Loader-Laufs.

    * ``loaded`` — Plugins, die in der Allowlist standen UND erfolgreich
      aktiviert wurden.
    * ``discovered_but_not_allowed`` — Plugins, deren ``plugin.toml`` der
      Loader parsen konnte, die aber nicht in der Allowlist sind. Werden
      von der Admin-API für die Allowlist-UI gebraucht.
    * ``failed`` — Plugins, deren Manifest oder ``register()`` fehlgeschlagen
      ist (geloggt, aber nicht aktiviert).
    """

    loaded: list[PluginManifest] = field(default_factory=list)
    discovered_but_not_allowed: list[PluginManifest] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)


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

    **Allowlist-Bypass.** Diese Variante ignoriert die Allowlist und
    aktiviert alles. Wird nur noch in Tests benutzt
    (``test_plugin_loader.py``), die ohne DB-Setup laufen — die echte
    chat-gateway-Lifespan ruft :func:`load_all_with_allowlist`.
    """
    path = discover_plugins_dir()
    if path is None:
        log.info("no plugin directory discovered; plugin loader idle")
        return []
    return load_directory(path, manager=manager)


def _parse_manifests_in_dir(path: Path) -> list[tuple[Path, PluginManifest]]:
    """Parse jedes Plugin-Manifest unter ``path`` ohne zu aktivieren.

    Fehler werden geloggt + geskippt. Returnt eine sortierte Liste
    ``(plugin_dir, manifest)``. Wird vom Allowlist-Pfad genutzt, um
    "discovered" von "loaded" zu trennen.
    """
    out: list[tuple[Path, PluginManifest]] = []
    if not path.is_dir():
        return out
    for child in sorted(path.iterdir()):
        if not child.is_dir() or child.name.startswith((".", "_")):
            continue
        manifest_path = child / "plugin.toml"
        if not manifest_path.is_file():
            continue
        try:
            manifest = parse_manifest(manifest_path)
        except IncompatibleApiError as exc:
            log.error("plugin %s: incompatible API: %s", child.name, exc)
            continue
        except ValidationError as exc:
            log.error("plugin %s: invalid manifest: %s", child.name, exc)
            continue
        if manifest.name != child.name:
            log.error(
                "plugin %s: manifest name %r does not match directory name",
                child.name,
                manifest.name,
            )
            continue
        out.append((child, manifest))
    return out


def discover_manifests(path: Path | None = None) -> list[PluginManifest]:
    """Pure-Discovery für die Admin-API: parst alle Manifeste, ohne zu laden.

    Returnt die Liste aller Plugins, deren ``plugin.toml`` valide ist —
    unabhängig von Allowlist. Wird vom ``GET /admin/plugins``-Endpoint
    benutzt, um auch "noch nicht erlaubte" Plugins anzeigen zu können.
    """
    target = path if path is not None else discover_plugins_dir()
    if target is None:
        return []
    return [m for _, m in _parse_manifests_in_dir(target)]


def load_directory_with_allowlist(
    path: Path,
    allowed: set[str],
    *,
    manager: PluginManager | None = None,
) -> LoadResult:
    """Allowlist-gegatete Variante von :func:`load_directory`.

    Geht den Plugin-Ordner durch, parst alle Manifeste, und aktiviert
    **nur** die Plugins, deren Name in ``allowed`` enthalten ist. Die
    nicht-erlaubten Plugins werden trotzdem in :class:`PluginManager`
    eingetragen (aber nicht aktiviert), damit die Admin-API sie listen
    kann und ein nachträgliches Allowlist-PUT sie via ``manager.activate``
    ohne erneuten Filesystem-Scan aktivieren könnte (Stufe-B-Hook für
    Hot-Reload).
    """
    mgr = manager if manager is not None else get_manager()
    result = LoadResult()
    if not path.is_dir():
        log.info("plugin directory %s does not exist; nothing to load", path)
        return result

    for directory, manifest in _parse_manifests_in_dir(path):
        # In den Manager eintragen, damit auch nicht-erlaubte Plugins
        # für die Admin-UI sichtbar bleiben.
        try:
            mgr.add(manifest, directory)
        except ValueError:
            # Bereits hinzugefügt (z.B. zwei Loader-Pässe im selben
            # Prozess) — überspringen, der bestehende Record bleibt.
            pass

        if manifest.name not in allowed:
            log.info(
                "plugin %s discovered but not in allowlist; skipping activation",
                manifest.name,
            )
            result.discovered_but_not_allowed.append(manifest)
            continue

        try:
            mgr.activate(manifest.name)
        except Exception as exc:  # noqa: BLE001
            log.exception("plugin %s: activation failed", manifest.name)
            result.failed.append(manifest.name)
            _ = exc  # behalten für die Logs, nicht re-raisen
            continue
        result.loaded.append(manifest)

    log.info(
        "loaded %d plugin(s) (allowed=%d, skipped-not-allowed=%d, failed=%d) from %s",
        len(result.loaded),
        len(allowed),
        len(result.discovered_but_not_allowed),
        len(result.failed),
        path,
    )
    return result


def load_all_with_allowlist(
    allowed: set[str], *, manager: PluginManager | None = None
) -> LoadResult:
    """Discover-default-dir + Allowlist-gegateter Load.

    Lifespan-Pfad der chat-gateway-App: vor diesem Aufruf hat die
    Lifespan den Hello-Self-Heal gerufen und die Allowlist als Snapshot
    aus der DB geholt. Die DB selbst kennt der Loader nicht.
    """
    path = discover_plugins_dir()
    if path is None:
        log.info("no plugin directory discovered; plugin loader idle")
        return LoadResult()
    return load_directory_with_allowlist(path, allowed, manager=manager)
