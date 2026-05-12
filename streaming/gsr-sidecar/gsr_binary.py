"""Resolver für das ``gpu-screen-recorder``-Binary + Capability-Probe.

Sucht das Binary in folgender Reihenfolge:

1. ``$GSR_BINARY`` Override (für Tests / explizite Pfad-Auswahl).
2. Flatpak-Pfad ``/app/bin/gpu-screen-recorder`` wenn ``/.flatpak-info``
   existiert oder ``$FLATPAK_ID`` gesetzt ist.
3. Custom-Build aus ``bootstrap-gsr.fish`` unter
   ``/tmp/gsr-analysis/gpu-screen-recorder/build/gpu-screen-recorder``.
4. System-Binary über ``$PATH`` (``shutil.which``).

Wenn nichts gefunden wird, gibt der Resolver einen ``GsrBinary`` mit
``path=None`` zurück — kein Crash; das ``health``-RPC kann das melden,
und Start-Anfragen scheitern dann sauber mit einer Fehlermeldung.

Parst ausserdem die ``--info``-Ausgabe (sectioned ``key|value`` Format)
und gibt ``vendor`` + verfügbare ``video_codecs`` zurück. Das Format
ist vom GSR-Source dokumentiert (``main.cpp``: ``section=...``,
dann je Sektion ``key|value`` oder ``token``-Zeilen).

(Capture-Quelle ist im Pulse-Pfad immer das Wayland-Portal — der
frühere ``--list-monitors``-Parser ist entfernt.)
"""
from __future__ import annotations
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path


# Bekannte Binary-Pfade (Flatpak-Default + Custom-Build aus bootstrap-gsr.fish).
_FLATPAK_PATH = Path("/app/bin/gpu-screen-recorder")
_CUSTOM_BUILD_PATH = Path("/tmp/gsr-analysis/gpu-screen-recorder/build/gpu-screen-recorder")


@dataclass(frozen=True)
class GsrBinary:
    """Aufgelöstes GSR-Binary plus Metadaten."""

    path: str | None
    """Absoluter Pfad zum Binary, oder ``None`` wenn keins gefunden wurde."""

    source: str
    """Wie es gefunden wurde: ``env`` | ``flatpak`` | ``custom`` | ``system`` | ``missing``."""

    is_flatpak: bool = False
    """True wenn das Sidecar selbst in einer Flatpak-Sandbox läuft."""

    @property
    def available(self) -> bool:
        return self.path is not None


def is_flatpak() -> bool:
    """True wenn das Sidecar in einer Flatpak-Sandbox läuft."""
    return os.path.exists("/.flatpak-info") or "FLATPAK_ID" in os.environ


def resolve() -> GsrBinary:
    """Sucht das GSR-Binary nach der dokumentierten Reihenfolge."""
    flatpak = is_flatpak()

    env_override = os.environ.get("GSR_BINARY")
    if env_override and Path(env_override).is_file() and os.access(env_override, os.X_OK):
        return GsrBinary(path=env_override, source="env", is_flatpak=flatpak)

    if flatpak and _FLATPAK_PATH.exists():
        return GsrBinary(path=str(_FLATPAK_PATH), source="flatpak", is_flatpak=True)

    if _CUSTOM_BUILD_PATH.exists() and os.access(_CUSTOM_BUILD_PATH, os.X_OK):
        return GsrBinary(path=str(_CUSTOM_BUILD_PATH), source="custom", is_flatpak=flatpak)

    system = shutil.which("gpu-screen-recorder")
    if system:
        return GsrBinary(path=system, source="system", is_flatpak=flatpak)

    return GsrBinary(path=None, source="missing", is_flatpak=flatpak)


# ── Capability-Probe ────────────────────────────────────────────────


@dataclass
class GsrInfo:
    """Geparste ``gpu-screen-recorder --info``-Ausgabe."""

    version: str | None = None
    vendor: str | None = None             # nvidia | amd | intel
    card_path: str | None = None
    display_server: str | None = None     # wayland | x11
    video_codecs: list[str] = field(default_factory=list)
    capture_options: list[str] = field(default_factory=list)
    has_flv_opus_patch: bool | None = None
    """``True`` wenn das Binary die FLV-Opus-Whitelist-Erweiterung hat
    (siehe ``patches/0001-opus-flv-whitelist.patch``). ``None`` wenn
    ``strings`` nicht ausführbar war."""


def _parse_info(stdout: str) -> GsrInfo:
    """Parst die sectioned ``--info``-Ausgabe.

    Format (aus ``main.cpp``):

    .. code-block:: text

        section=system_info
        display_server|wayland
        gsr_version|5.13.4
        section=gpu_info
        vendor|nvidia
        section=video_codecs
        h264
        hevc
        ...
    """
    info = GsrInfo()
    section: str | None = None
    for raw in stdout.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("section="):
            section = line.split("=", 1)[1]
            continue
        if section in ("video_codecs",):
            info.video_codecs.append(line)
            continue
        if section == "capture_options":
            # Format pro Zeile: "DP-1|2560x1440" oder einfach "portal"/"region"
            info.capture_options.append(line)
            continue
        if "|" in line:
            key, _, value = line.partition("|")
            if section == "system_info":
                if key == "gsr_version":
                    info.version = value
                elif key == "display_server":
                    info.display_server = value
            elif section == "gpu_info":
                if key == "vendor":
                    info.vendor = value
                elif key == "card_path":
                    info.card_path = value
    return info


def probe_info(binary: GsrBinary, timeout: float = 6.0) -> GsrInfo | None:
    """Ruft ``gpu-screen-recorder --info`` auf und parst das Ergebnis."""
    if not binary.available or binary.path is None:
        return None
    try:
        result = subprocess.run(
            [binary.path, "--info"],
            capture_output=True, text=True, timeout=timeout,
        )
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return None
    info = _parse_info(result.stdout)
    if info.version is None:
        # Fallback: --version
        try:
            ver = subprocess.run(
                [binary.path, "--version"],
                capture_output=True, text=True, timeout=timeout,
            )
            if ver.returncode == 0:
                info.version = ver.stdout.strip().splitlines()[0] if ver.stdout else None
        except (subprocess.SubprocessError, OSError):
            pass
    info.has_flv_opus_patch = _has_flv_opus_patch(binary.path)
    return info


def _has_flv_opus_patch(binary_path: str) -> bool | None:
    """Prüft via ``strings`` ob der FLV-Opus-Patch im Binary drin ist.

    Sucht nach dem Fragment ``.ts and .flv files`` aus dem gepatchten
    Fehler-String — siehe ``patches/0001-opus-flv-whitelist.patch``.
    """
    try:
        result = subprocess.run(
            ["strings", binary_path],
            capture_output=True, text=True, timeout=8,
        )
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return None
    return ".ts and .flv files" in result.stdout
