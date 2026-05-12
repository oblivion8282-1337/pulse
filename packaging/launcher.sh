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
# We deliberately set NO ELECTRON_OZONE_PLATFORM_HINT: Electron uses its default
# X11 backend (over XWayland on a Wayland session; the manifest mounts --socket=x11).
# Native Ozone-Wayland trips over NVIDIA DRM render-node detection here. To force
# native Wayland anyway:  ELECTRON_OZONE_PLATFORM_HINT=auto flatpak run com.unicutmedia.Pulse

exec zypak-wrapper /app/electron/electron /app/pulse/main.cjs "$@"
