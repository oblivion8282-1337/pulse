#!/usr/bin/env bash
# Fuehrt eine Messung aus und haelt dabei die Bildschirme wach.
#
# **Warum es das gibt.** Am 2026-07-27 lief ein ganzer Messabend ins Leere,
# weil die Monitore zwischendurch ausgingen. Der Compositor liefert dann keine
# neuen Bilder mehr, die Aufnahme sieht ein stehendes Bild — und alles, was
# man misst, ist Unsinn, ohne dass es auffaellt:
#
#   * AV1 fiel auf 43 kbit/s (ein unbewegtes Bild komprimiert sich auf nichts)
#   * H.264 zeigte weiter ~25 000 kbit/s, weil er seine Zielrate auch mit
#     Stillstand auffuellt — die Datenrate allein verraet den Fehler also NICHT
#   * "Stillstaende" und "gute/schlechte Laeufe" waren nur Schirm an/aus
#
# `systemd-inhibit --what=idle` allein genuegte nicht. Deshalb zusaetzlich:
# DPMS explizit einschalten und die Leerlauf-Uhr regelmaessig zuruecksetzen.
#
# Die verlaessliche Gegenprobe ist NICHT die Datenrate, sondern `e2e_misses`
# aus `--e2e`: findet der Player das Zeitmuster im dekodierten Bild nicht,
# kommt kein echtes Bild an.
#
#   ./mit-bildschirm.sh python3 real-harness.py --secs 30 --e2e ...
set -uo pipefail

[ $# -gt 0 ] || { echo "Aufruf: $0 <befehl...>" >&2; exit 2; }

wach() {
    kscreen-doctor --dpms on >/dev/null 2>&1 || true
    # Setzt die Leerlauf-Uhr zurueck, ohne den Zeiger zu bewegen.
    qdbus org.freedesktop.ScreenSaver /ScreenSaver SimulateUserActivity >/dev/null 2>&1 || true
}

wach
while :; do sleep 20; wach; done &
WACH_PID=$!
trap 'kill "$WACH_PID" 2>/dev/null' EXIT INT TERM

systemd-inhibit --what=idle:sleep --why="Pulse-Messung" "$@"
ergebnis=$?

kill "$WACH_PID" 2>/dev/null
exit "$ergebnis"
