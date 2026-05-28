#!/bin/sh
# Launcher inside the Pulse Flatpak.
#
# - Points the GSR sidecar at the bundled, FLV-Opus-patched `gpu-screen-recorder`
#   (`/app/bin/gpu-screen-recorder`, built from source in the manifest) and at the
#   bundled Python sidecar (`/app/share/pulse/gsr-sidecar/control.py`).
# - Runs Electron through `zypak-wrapper` (from org.electronjs.Electron2.BaseApp) —
#   Chromium's setuid sandbox doesn't work inside a Flatpak; zypak replaces it with
#   a bubblewrap-based one.
# - The packaged app loads the live web app remotely (https://howispulse.com)
#   — no PULSE_DEV_URL is set, so electron/main.ts uses PROD_URL. Web-side fixes are
#   visible without a new Flatpak; only native changes (Electron/sidecar/GSR) need a
#   rebuild. Set PULSE_DEVTOOLS=1 to auto-open DevTools.
set -e

export GSR_BINARY="${GSR_BINARY:-/app/bin/gpu-screen-recorder}"
export PULSE_SIDECAR_PY="${PULSE_SIDECAR_PY:-/app/share/pulse/gsr-sidecar/control.py}"
export PULSE_PYTHON="${PULSE_PYTHON:-python3}"

# Display backend: let Electron pick it (`--ozone-platform-hint=auto` → native
# Wayland when a Wayland session is available, X11/XWayland otherwise). The manifest
# mounts both --socket=wayland and --socket=x11, so either works. If native Wayland
# ever misbehaves (e.g. NVIDIA quirks), force XWayland:
#   PULSE_OZONE=x11 flatpak run com.howispulse.Pulse
# (PULSE_OZONE=wayland forces native Wayland.)
PULSE_OZONE="${PULSE_OZONE:-auto}"
if [ "$PULSE_OZONE" = "auto" ]; then
  set -- "$@" --ozone-platform-hint=auto
else
  set -- "$@" --ozone-platform="$PULSE_OZONE"
fi

# Electron mit dem App-Verzeichnis starten (NICHT mit main.cjs als Dateipfad!) —
# nur dann liest es `/app/pulse/package.json` ein und greift `desktopName` →
# Wayland-`app_id` = `com.howispulse.Pulse` (statt "electron"). Wird stattdessen
# die `main.cjs` direkt übergeben, ignoriert Electron die package.json daneben
# und Compositoren (Niri/Hyprland/Plasma) können das Fenster nicht der
# `.desktop`-Datei zuordnen → kein App-Icon in der Taskleiste.
# `--class=…` deckt zusätzlich X11/XWayland (WM_CLASS) ab.
exec zypak-wrapper /app/electron/electron --class=com.howispulse.Pulse /app/pulse "$@"
