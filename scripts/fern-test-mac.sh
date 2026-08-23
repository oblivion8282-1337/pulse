#!/usr/bin/env bash
#
# Baut und startet die GESTEUERTE Seite (den Host) des Zwei-Geraete-Tests der
# Fernsteuerung gegen den gemeinsamen Dev-Stack https://pulse.unicutmedia.com.
#
# Gegenstueck zu scripts/fern-test-linux.sh, das die STEUERNDE Seite fährt.
# Voller Zusammenhang: docs/plans/2026-08-23-zwei-geraete-test-mac-als-host.md
#
# WARUM ES DIESES SKRIPT GIBT: Auf dem Mac muessen VIER Dinge zusammenkommen,
# und zwei davon scheitern lautlos.
#
#   * Der Sidecar muss gebaut sein -- fehlt er, verschwindet HQ-Streaming
#     wortlos aus der Oberflaeche.
#   * Und der Mac braucht ZWEI Systemfreigaben, nicht eine. Einspielen haengt
#     an den Bedienungshilfen, Mithoeren an der Eingabeueberwachung. Fehlt die
#     zweite, wirkt die Fernsteuerung trotzdem -- aber die Wache sieht den Host
#     nicht mehr, der sich seinen Rechner zurueckholen will. Das ist der
#     gefaehrlichste Zustand ueberhaupt, und man sieht ihn dem laufenden System
#     nicht an. Deshalb fragt dieses Skript beide Freigaben ueber genau den
#     Op-Weg ab, den auch die App benutzt, und nennt die fehlende beim Namen.
#
#   ./scripts/fern-test-mac.sh              # bauen, pruefen, starten
#   ./scripts/fern-test-mac.sh --nur-pruefen
#
set -euo pipefail

WURZEL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NUR_PRUEFEN=0
[ "${1:-}" = "--nur-pruefen" ] && NUR_PRUEFEN=1

sag() { printf '\n=== %s ===\n' "$1"; }

[ "$(uname -s)" = "Darwin" ] || { echo "Dieses Skript ist fuer macOS. Auf Linux: scripts/fern-test-linux.sh"; exit 1; }

sag "Voraussetzungen"
command -v cargo >/dev/null || { echo "cargo fehlt"; exit 1; }
command -v pnpm  >/dev/null || { echo "pnpm fehlt";  exit 1; }
echo "  rustc $(rustc --version | awk '{print $2}')"
echo "  node  $(node --version)"

sag "1/3  Der Sidecar"
# PFLICHT. Electron sucht ihn per Aufwaertssuche in
# streaming/mac-hq-sidecar/target/{release,debug}/ -- ein Release-Bau hier
# genuegt, es braucht keine Umgebungsvariable.
cd "$WURZEL/streaming/mac-hq-sidecar"
cargo build --release
SIDECAR="$WURZEL/streaming/mac-hq-sidecar/target/release/pulse-mac-hq-sidecar"
echo "  gebaut: $(stat -f '%z Byte' "$SIDECAR")"

sag "2/3  Die beiden Freigaben"
# Ueber den echten health-Op, nicht ueber eine eigene Abfrage: so misst dieses
# Skript dasselbe, was die App spaeter sieht. `health` startet nichts -- kein
# Aufnahme-Portal, kein Stream.
ANTWORT="$(printf '{"op":"health","id":1}\n' | "$SIDECAR" 2>/dev/null | head -1)"
python3 - "$ANTWORT" <<'PY'
import json, sys
gsr = json.loads(sys.argv[1]).get("gsr", {})
kann, grund = gsr.get("remote_input"), gsr.get("remote_input_grund", "")
if kann:
    print("  Bedienungshilfen    erteilt")
    print("  Eingabeueberwachung erteilt")
    print("  -> Dieser Mac ist fernsteuerbar.")
    sys.exit(0)

print(f"  NICHT fernsteuerbar (Grund: {grund or 'unbekannt'})\n")
if grund == "bedienungshilfen":
    print("  Es fehlt die Freigabe zum EINSPIELEN von Ereignissen:")
    print("    Systemeinstellungen > Datenschutz & Sicherheit > Bedienungshilfen")
elif grund.startswith("eingabeueberwachung"):
    stand = grund.split(":", 1)[1] if ":" in grund else ""
    print("  Einspielen ist erlaubt, MITHOEREN nicht. Ohne das bekommt der Host")
    print("  seinen Rechner nicht zurueck, wenn er selbst an die Tastatur geht.")
    print("    Systemeinstellungen > Datenschutz & Sicherheit > Eingabeueberwachung")
    if stand == "ungefragt":
        print("\n  Stand 'ungefragt': der Eintrag entsteht erst beim ersten Versuch.")
        print("  Einmal eine Fernsteuer-Sitzung starten, dann erscheint er in der Liste.")
print("\n  ACHTUNG: Freigegeben wird das Programm, das den Sidecar STARTET")
print("  (also Terminal bzw. Pulse), nicht der Sidecar selbst -- ein Kindprozess")
print("  erbt die Freigabe. Nach einem Update muss der Eintrag ENTFERNT und neu")
print("  gesetzt werden, nicht nur der Haken neu geklickt: die Freigabe haengt")
print("  an der Code-Signatur, und das DMG ist nur ad-hoc signiert.")
sys.exit(1)
PY

[ "$NUR_PRUEFEN" = "1" ] && { echo; echo "Nur geprueft, nichts gestartet."; exit 0; }

sag "3/3  Vite und Electron gegen den gemeinsamen Stack"
echo "  Danach im Fenster: anmelden, in den Sprachkanal, HQ-Stream starten."
echo "  Der steuernde Rechner fragt dann bei dir an -- du musst zustimmen."
echo
echo "  Nicht vergessen: REMOTE_CONTROL (Bit 37) steht NICHT in den"
echo "  Vorgaberechten. Ohne Zuteilung durch einen Admin sieht der Steuernde"
echo "  den Anfrage-Knopf gar nicht."
cd "$WURZEL"
exec pnpm dev:remote
