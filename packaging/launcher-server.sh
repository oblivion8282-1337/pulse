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

# Schlüsselbund für safeStorage (Zugangsdaten der Instanz). Chromium wählt
# den Speicher nach XDG_CURRENT_DESKTOP: GNOME & Co. → libsecret, KDE →
# KWallet, ALLES ANDERE (Hyprland, Niri, Sway, …) → `basic_text`, ein fest
# eingebautes Passwort, also faktisch Klartext. Ausserhalb von KDE deshalb
# ausdrücklich libsecret — fehlt dort ein Secret-Service, fällt Chromium von
# selbst auf basic_text zurück, schlechter als bisher wird es also nicht.
# Bereits mit basic_text abgelegte Werte („v10"-Präfix) bleiben lesbar, das
# entschlüsselt Chromium unabhängig vom gewählten Speicher. (Beides aus dem
# Chromium-Quelltext gefolgert, os_crypt/key_storage_util_linux — im Flatpak
# nicht nachgemessen.)
# Übersteuern: PULSE_PASSWORD_STORE=basic|gnome-libsecret|kwallet6|… ;
# PULSE_PASSWORD_STORE=auto überlässt Chromium die Wahl.
if [ -n "$PULSE_PASSWORD_STORE" ]; then
  if [ "$PULSE_PASSWORD_STORE" != "auto" ]; then
    set -- "$@" --password-store="$PULSE_PASSWORD_STORE"
  fi
else
  case "${XDG_CURRENT_DESKTOP:-}" in
    *KDE*) ;;  # Chromium erkennt KWallet 5/6 selbst
    *) set -- "$@" --password-store=gnome-libsecret ;;
  esac
fi

exec zypak-wrapper /app/electron/electron --class=com.howispulse.PulseServer --disable-gpu /app/pulse-server "$@"
