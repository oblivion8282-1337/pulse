"""Pydantic model for ``plugin.toml`` (Pulse Plugin Manifest v1).

Spec lives in ``docs/PLUGIN_MANIFEST.md``. We keep the model small and
deliberately permissive in the ``uses`` block — Schritt 4 stores the
declared interfaces; Schritt 5 will use them as a permission gate. All
list fields default to empty.

The on-disk format is TOML; ``parse_manifest(path)`` reads the file with
``tomllib`` (stdlib in 3.11+) and feeds the resulting dict into
:class:`PluginManifest`. A ``ValidationError`` from pydantic is the normal
"manifest is malformed" signal; an :class:`IncompatibleApiError` is raised
*after* the pydantic parse if the ``api`` field doesn't match.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

# Plugin-Loader's currently-supported Manifest-API-Major. Bumped only on
# breaking changes to the entrypoint/register-contract.
DEFAULT_PLUGIN_API = "1"


class IncompatibleApiError(ValueError):
    """Raised when a manifest declares a ``plugin.api`` value the host
    doesn't speak. Carries the plugin name + the unsupported value for the
    structured log line in the loader."""

    def __init__(self, name: str, requested: str, supported: str) -> None:
        super().__init__(
            f"plugin {name!r}: requires plugin-api {requested!r}, "
            f"host speaks {supported!r}"
        )
        self.name = name
        self.requested = requested
        self.supported = supported


_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")
PluginName = Annotated[str, StringConstraints(pattern=_NAME_RE.pattern)]

ScopeType = Literal["per-user", "per-guild", "global"]


class PluginScope(BaseModel):
    """``[plugin.scope]`` block. Purely informational in Schritt 4 — the
    loader does not enforce anything based on this; UI + Schritt 5 will."""

    model_config = ConfigDict(extra="forbid")
    type: ScopeType = "global"


class PluginUses(BaseModel):
    """``[plugin.uses]`` block. Declarative whitelist of interfaces the
    plugin claims to use. Schritt 4 records the declarations; Schritt 5
    will refuse registrations that aren't on the list."""

    model_config = ConfigDict(extra="forbid")
    ws_ops: list[str] = Field(default_factory=list)
    ws_emit_ops: list[str] = Field(default_factory=list)
    channels: list[str] = Field(default_factory=list)
    settings_sections: list[str] = Field(default_factory=list)
    ui_slots: list[str] = Field(default_factory=list)


class PluginEntrypoints(BaseModel):
    """``[plugin.entrypoints]`` block. Both fields are optional — a
    backend-only or frontend-only plugin leaves the other one unset."""

    model_config = ConfigDict(extra="forbid")
    # Python module:function. Module path resolves relative to the plugin
    # directory (sys.path entry added by the loader).
    backend: str | None = None
    # Path relative to the plugin directory, e.g. "frontend.ts". The
    # frontend loader resolves it via Vite glob; the backend Python code
    # only records it for the manifest dump.
    frontend: str | None = None


class PluginManifest(BaseModel):
    """Parsed ``plugin.toml`` — the top-level shape exposed to the loader.

    Field order mirrors the on-disk TOML so the model is easy to read
    alongside an example manifest.
    """

    model_config = ConfigDict(extra="forbid")
    name: PluginName
    version: str
    api: str
    author: str | None = None
    description: str | None = None
    scope: PluginScope = Field(default_factory=PluginScope)
    uses: PluginUses = Field(default_factory=PluginUses)
    entrypoints: PluginEntrypoints = Field(default_factory=PluginEntrypoints)

    @classmethod
    def from_dict(cls, raw: dict[str, object]) -> PluginManifest:
        """Build a :class:`PluginManifest` from the raw TOML dict.

        The on-disk file has a single ``[plugin]`` table at the top — we
        unpack that one level so the model fields read cleanly.
        """
        body = raw.get("plugin")
        if not isinstance(body, dict):
            raise ValueError("plugin.toml: missing top-level [plugin] table")
        return cls.model_validate(body)


def parse_manifest(path: Path, *, host_api: str = DEFAULT_PLUGIN_API) -> PluginManifest:
    """Read ``path`` (a ``plugin.toml`` file) and validate it.

    Raises :class:`pydantic.ValidationError` for shape/type problems and
    :class:`IncompatibleApiError` for an unsupported ``plugin.api``.
    """
    with path.open("rb") as fp:
        raw = tomllib.load(fp)
    manifest = PluginManifest.from_dict(raw)
    if manifest.api != host_api:
        raise IncompatibleApiError(manifest.name, manifest.api, host_api)
    return manifest
