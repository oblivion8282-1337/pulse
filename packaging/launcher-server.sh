#!/bin/sh
# Launcher für den Pulse-Server-Flatpak.
#
# Startet die Server-Electron-App (PULSE_BUILD_MODE=server-Bundle) via
# zypak-wrapper (ersetzt Chromiums setuid-Sandbox in Flatpak). Kein GSR-Sidecar
# — der Server streamt nicht selbst (der allinone-Container tut's).
#
# Electron wird mit dem App-Verzeichnis (/app/pulse-server) gestartet, damit es
# die package.json (→ desktopName → Wayland-app_id com.howispulse.PulseServer)
# liest. --class deckt X11/XWayland (WM_CLASS) ab.
set -e

# Display-Backend: Electron wählen lassen (auto → Wayland oder X11/XWayland).
PULSE_OZONE="${PULSE_OZONE:-auto}"
if [ "$PULSE_OZONE" = "auto" ]; then
  set -- "$@" --ozone-platform-hint=auto
else
  set -- "$@" --ozone-platform="$PULSE_OZONE"
fi

exec zypak-wrapper /app/electron/electron --class=com.howispulse.PulseServer --disable-gpu /app/pulse-server "$@"
