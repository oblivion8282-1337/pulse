"""Permission-Gate für den Plugin-Loader (Schritt 5 Plugin-System).

Schritt 4 hat die ``[plugin.uses]``-Listen geparst und im Manifest abgelegt,
aber **nichts blockiert**: ein Plugin konnte WS-Ops registrieren, die im
Manifest nicht standen. Schritt 5 zieht die Schraube an — der Loader
vergleicht die nach ``register()`` neu in den Registries gelandeten Einträge
gegen die ``uses``-Whitelist und reagiert je nach Modus.

Modell — *Soft-Sandbox*
-----------------------
Pulse läuft heute mit *internen / vertrauten* Plugins (Stufe A im Plan).
Eine echte Sandbox (WASM, Subinterpreter, Process-Isolation) ist für diesen
Modus überdimensioniert. Stattdessen: ein **capability-passing**-Stil —
das Plugin bekommt die Decorators (``register_ws_op``, …) als Importe und
darf damit *alles*, aber der Loader gated im Nachhinein:

* deklariere im Manifest, was du registrierst
* registriere im Code, was du deklariert hast
* alles andere → Rollback + Fehler (``strict``) oder Warning (``warn``)

Das schützt vor *versehentlicher* Capability-Inflation (Manifest sagt
"nur ``hello:ping``", Code registriert versehentlich noch
``admin:broadcast``) — nicht vor *bösartigen* Plugins. Stufe B (externe
Plugins) braucht später WASM oder eine Bot-API; das ist in
``plugin-sandbox-future.md`` (Memory) skizziert.

Modi
----
``strict`` (Default)
    Undeclared registration → ``PluginPermissionError`` + komplettes
    Rollback aller in dieser Activation-Phase neu erstellten Einträge.
``warn``
    Logge die Verletzung, lasse die Registrierung aber stehen. Nützlich
    während der Plugin-Entwicklung, wenn das Manifest noch nicht hinterher
    ist.
``off``
    Keine Prüfung — verhält sich wie Schritt 4. Escape-Hatch, sollte
    der Gate jemals fehlschlagen.

Der aktive Modus wird per ``$PULSE_PLUGIN_PERMISSIONS`` gewählt und bei
jedem Activate frisch gelesen — Operatoren + Tests können den Modus zur
Laufzeit drehen.
"""

from __future__ import annotations

import logging
import os
from typing import Literal

log = logging.getLogger(__name__)


PermissionMode = Literal["strict", "warn", "off"]
"""Drei-Wege-Modus für die Permission-Prüfung. Siehe Modul-Docstring."""

DEFAULT_PERMISSION_MODE: PermissionMode = "strict"
"""Production-Default. Tests overriden via ``monkeypatch.setenv``."""

ENV_VAR = "PULSE_PLUGIN_PERMISSIONS"


def resolve_permission_mode() -> PermissionMode:
    """Lies den aktuellen Modus aus der Umgebung.

    Unbekannter Wert (oder leer) → Default (``strict``) mit Warning-Log
    für nicht-leere fehlerhafte Werte, damit ein Tippfehler nicht still
    durchrutscht.
    """
    raw = os.environ.get(ENV_VAR, "").strip().lower()
    if raw in ("strict", "warn", "off"):
        return raw  # type: ignore[return-value]
    if raw:
        log.warning(
            "%s=%r unrecognised; using %r", ENV_VAR, raw, DEFAULT_PERMISSION_MODE
        )
    return DEFAULT_PERMISSION_MODE


class PluginPermissionError(RuntimeError):
    """Wirft der Loader, wenn ein Plugin im ``strict``-Modus eine
    Schnittstelle registriert hat, die nicht in ``[plugin.uses]`` steht.

    Trägt den Plugin-Namen + die Listen der verletzenden Registrierungen,
    damit die Loader-Logzeile strukturiert bleibt. Der Loader macht das
    Rollback aller in dieser Activation-Phase angelegten Einträge, *bevor*
    die Exception nach oben durchgereicht wird — eine halb-aktivierte
    Plugin-Spur darf es nie geben.
    """

    def __init__(
        self,
        name: str,
        undeclared_ops: set[str],
        undeclared_channels: set[str],
    ) -> None:
        parts: list[str] = []
        if undeclared_ops:
            parts.append(f"ws_ops={sorted(undeclared_ops)!r}")
        if undeclared_channels:
            parts.append(f"channels={sorted(undeclared_channels)!r}")
        detail = ", ".join(parts) if parts else "<empty>"
        super().__init__(
            f"plugin {name!r}: registered undeclared {detail} — "
            f"add them to [plugin.uses] in plugin.toml"
        )
        self.name = name
        self.undeclared_ops = set(undeclared_ops)
        self.undeclared_channels = set(undeclared_channels)


def compute_violations(
    *,
    declared_ops: set[str],
    declared_channels: set[str],
    new_ops: set[str],
    new_channels: set[str],
) -> tuple[set[str], set[str]]:
    """Berechne die Mengen-Differenz für die Permission-Prüfung.

    Reine Funktion, keine Side-Effects — der Loader kann das Ergebnis
    inspizieren und dann *entscheiden*, ob er rollbacken oder warnen will.
    Heraus kommen ``(undeclared_ops, undeclared_channels)``; leere Mengen =
    alles im grünen Bereich.
    """
    return (new_ops - declared_ops, new_channels - declared_channels)
