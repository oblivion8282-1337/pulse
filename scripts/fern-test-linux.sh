#!/usr/bin/env bash
#
# Baut und startet die STEUERNDE Seite des Zwei-Geraete-Tests der Fernsteuerung
# gegen die Testinstanz https://pulse.unicutmedia.com.
#
# Voller Zusammenhang: docs/plans/2026-08-12-zwei-geraete-test-aufbau.md
#
# WARUM ES DIESES SKRIPT GIBT: Drei Dinge muessen zusammenkommen, und eines
# davon wird regelmaessig vergessen -- der native Player. Fehlt sein Binary,
# faellt die App still auf das Browser-Videoelement zurueck, und dort ist der
# Anfrage-Knopf gar nicht eingehaengt. Der Fehler sieht dann aus wie "die
# Funktion ist kaputt" und ist eine fehlende Datei.
#
#   ./scripts/fern-test-linux.sh          # bauen und starten
#   ./scripts/fern-test-linux.sh --nur-bauen
#
set -euo pipefail

WURZEL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZIEL_URL="${PULSE_URL:-https://pulse.unicutmedia.com}"
DATEN="${PULSE_TEST_USERDATA:-/tmp/pulse-test}"
NUR_BAUEN=0
[ "${1:-}" = "--nur-bauen" ] && NUR_BAUEN=1

sag() { printf '\n=== %s ===\n' "$1"; }

sag "Voraussetzungen"
command -v cargo >/dev/null || { echo "cargo fehlt"; exit 1; }
command -v pnpm  >/dev/null || { echo "pnpm fehlt";  exit 1; }
RUSTV="$(rustc --version | awk '{print $2}')"
echo "  rustc $RUSTV   (der Player verlangt >= 1.95, s. streaming/pulse-player/README.md)"
echo "  node  $(node --version)"

sag "1/3  Nativer Player"
# PFLICHT, nicht Kuer. Die Erfassung von Maus und Tastatur passiert IM
# Player-Fenster (Zeigerfang, rohe Scancodes) -- ein <video> im Browser kann das
# nicht liefern, und der Anfrage-Knopf haengt genau an dieser Kachel.
cd "$WURZEL/streaming/pulse-player"
if cargo build --release; then
  echo "  gebaut: $(ls -la target/release/pulse-player | awk '{print $5" Byte"}')"
else
  cat <<'HINWEIS'

  Der Player-Bau ist gescheitert. Haeufigste Ursachen auf Linux:
    * FFmpeg-Entwicklungspakete fehlen (ffmpeg-sys-next sucht per pkg-config):
        Fedora:  sudo dnf install ffmpeg-devel clang-devel pkgconf-pkg-config
        Debian:  sudo apt install libavcodec-dev libavformat-dev libavutil-dev \
                                  libswscale-dev libavdevice-dev libclang-dev pkg-config
    * rustc zu alt -> rustup update stable
    * vendor/webrtc-rs fehlt -> scripts/bootstrap-webrtc.sh

  OHNE dieses Binary hat der Test keinen Sinn: die App faellt auf das
  Browser-Videoelement zurueck, und dort gibt es den Anfrage-Knopf nicht.
HINWEIS
  exit 1
fi

sag "2/3  Electron"
cd "$WURZEL/desktop"
pnpm install
pnpm run build:electron

if [ "$NUR_BAUEN" = "1" ]; then
  sag "Fertig (nur gebaut)"
  echo "  Starten:  PULSE_URL=$ZIEL_URL npx electron . --user-data-dir=$DATEN"
  exit 0
fi

sag "3/3  Starten gegen $ZIEL_URL"
# Eigenes Datenverzeichnis: sonst greift die Einzelinstanz-Sperre und es kommt
# nur die bereits laufende Pulse-App nach vorn. Nebenwirkung erwuenscht -- die
# echten Einstellungen des Nutzers bleiben unangetastet.
mkdir -p "$DATEN"
echo "  Datenverzeichnis: $DATEN"
echo "  (PULSE_URL wirkt nur in unverpackten Laeufen und nur mit https --"
echo "   desktop/electron/main.ts, Abschnitt PROD_URL.)"
echo
exec env PULSE_URL="$ZIEL_URL" npx electron . --user-data-dir="$DATEN"
