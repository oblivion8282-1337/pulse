#!/bin/sh
# Launcher inside the Pulse Flatpak.
#
# - Points the GSR sidecar at the bundled, FLV-Opus-patched `gpu-screen-recorder`
#   (`/app/bin/gpu-screen-recorder`, built from source in the manifest) and at the
#   bundled Python sidecar (`/app/share/pulse/gsr-sidecar/control.py`).
# - Runs Electron through `zypak-wrapper` (from org.electronjs.Electron2.BaseApp) —
#   Chromium's setuid sandbox doesn't work inside a Flatpak; zypak replaces it with
#   a bubblewrap-based one.
# - The packaged app loads the live web app remotely (https://pulse.unicutmedia.com)
#   — no PULSE_DEV_URL is set, so electron/main.ts uses PROD_URL. Web-side fixes are
#   visible without a new Flatpak; only native changes (Electron/sidecar/GSR) need a
#   rebuild. Set PULSE_DEVTOOLS=1 to auto-open DevTools.
set -e

export GSR_BINARY="${GSR_BINARY:-/app/bin/gpu-screen-recorder}"
export PULSE_SIDECAR_PY="${PULSE_SIDECAR_PY:-/app/share/pulse/gsr-sidecar/control.py}"
export PULSE_PYTHON="${PULSE_PYTHON:-python3}"
# Force the X11 Ozone backend (over XWayland on a Wayland session; the manifest
# mounts --socket=x11). Recent Electron defaults to native Ozone-Wayland when
# WAYLAND_DISPLAY is set, but that trips over NVIDIA's DRM render-node detection
# here — same reason the non-Flatpak dev app sticks with XWayland. Override:
#   PULSE_OZONE=auto flatpak run com.unicutmedia.Pulse   (→ --ozone-platform-hint=auto, native Wayland)
PULSE_OZONE="${PULSE_OZONE:-x11}"
if [ "$PULSE_OZONE" = "auto" ]; then set -- "$@" --ozone-platform-hint=auto; else set -- "$@" --ozone-platform=x11; fi

exec zypak-wrapper /app/electron/electron /app/pulse/main.cjs "$@"
