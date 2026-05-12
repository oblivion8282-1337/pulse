"""Settings-Dataclass (Stream/Capture/Audio/Overrides).

Vendored aus ``~/Dokumente/GPU_Screen_Recorder/ui/config.py``. Im Pulse-
Sidecar wird die JSON-Persistenz **nicht aktiv genutzt** — die UI-State-
Persistenz wandert in T3 auf den Tauri-``store`` (chmod 600 auf Linux,
Linux-spezifischer Settings-Pfad). Die JSON-I/O-Funktionen bleiben hier
als Convenience und für Standalone-Debugging des Sidecars (z.B. eine
``Settings.from_dict()``-Probe bei manuellen Tests).

Wer in der Pulse-Tauri-App Settings persistieren will, ruft den Sidecar
mit den fertigen Werten an — der Sidecar selbst hält *keinen* langlebigen
State (nur die laufende GSR-Subprocess-Referenz).
"""
from __future__ import annotations
import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path


# Pfade nur für Standalone-Tests / Backwards-Compat. In Pulse: nicht verwendet.
CONFIG_DIR = Path.home() / ".config" / "gsr-stream-ui"
CONFIG_FILE = CONFIG_DIR / "config.json"
KEYS_FILE = CONFIG_DIR / "keys.json"


@dataclass
class Settings:
    """User-Auswahl (GSR-spezifisch). Im Pulse-Sidecar ungenutzt für Persistenz.

    Felder identisch zum GSR-Original — Werkzeug ``profiles.py`` und
    ``stream_controller.py`` erwarten genau diese Form.
    """
    profile_name: str = "AV1 Effizient"
    server_name: str = "Hetzner"
    capture_source: str = "portal"  # "portal" | monitor-name (DP-1, etc.)
    audio_mode: str = "Desktop"
    excluded_apps: list[str] = field(default_factory=list)
    custom_codec: str = "av1"
    custom_bitrate_kbps: int = 8000
    custom_fps: int = 60
    custom_resolution: str = "Native"  # "Native" | "1440p" | "1080p" | "720p"

    @classmethod
    def from_dict(cls, data: dict) -> "Settings":
        s = cls()
        for k, v in data.items():
            if hasattr(s, k):
                setattr(s, k, v)
        return s

    def to_dict(self) -> dict:
        return asdict(self)


# ── JSON-I/O (Standalone, im Pulse-Sidecar ungenutzt) ───────────────


def load_settings() -> Settings:
    """Lädt Settings aus ``~/.config/gsr-stream-ui/config.json``.

    Im Pulse-Sidecar nur für Standalone-Debugging — die echte Persistenz
    läuft in T3 über Tauri-store.
    """
    if not CONFIG_FILE.exists():
        return Settings()
    try:
        data = json.loads(CONFIG_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return Settings()
    return Settings.from_dict(data)


def save_settings(s: Settings) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(asdict(s), indent=2))


def _read_keys() -> dict[str, str]:
    if not KEYS_FILE.exists():
        return {}
    try:
        return json.loads(KEYS_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _write_keys(keys: dict[str, str]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    KEYS_FILE.write_text(json.dumps(keys, indent=2))
    os.chmod(KEYS_FILE, 0o600)


def get_stream_key(server_name: str) -> str | None:
    return _read_keys().get(server_name)


def save_stream_key(server_name: str, key: str) -> None:
    keys = _read_keys()
    keys[server_name] = key
    _write_keys(keys)


def forget_stream_key(server_name: str) -> None:
    keys = _read_keys()
    if server_name in keys:
        del keys[server_name]
        _write_keys(keys)
