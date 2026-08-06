#!/usr/bin/env bash
# Setzt den Sitzungs-Stempel, sobald der Graph befragt wurde.
#
# Gegenstueck zu `graphify-gate.sh`: als PostToolUse an Bash gehaengt, prueft
# es den gelaufenen Befehl und legt bei einer Graph-Abfrage die Marke an, die
# das Gate danach durchlaesst.
#
# Der Stempel haengt an der SITZUNGS-ID, nicht an einer festen Datei. Damit
# gilt die Anforderung je Sitzung neu — genau das ist der Zweck: die
# Orientierung soll am Anfang der Arbeit stehen, nicht einmal im Leben eines
# Klons. Ein eigener SessionStart-Hook zum Aufraeumen eruebrigt sich dadurch.
#
# Aufgeraeumt wird trotzdem: Marken aelter als 7 Tage werden nebenbei
# entfernt, damit `.git/` nicht mit Altlasten volllaeuft.

set -uo pipefail

EINGABE=$(cat 2>/dev/null || true)

AUSWERTUNG=$(printf '%s' "$EINGABE" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    raise SystemExit
t=d.get('tool_input',d)
print((d.get('session_id') or '').strip())
print((t.get('command') or '').strip())
" 2>/dev/null || true)

SITZUNG=$(printf '%s' "$AUSWERTUNG" | sed -n '1p')
BEFEHL=$(printf '%s' "$AUSWERTUNG" | sed -n '2p')

[ -n "$SITZUNG" ] || exit 0

# Nur echte Abfragen zaehlen. `graphify update` ist Pflege, keine Orientierung
# — es wuerde das Gate sonst oeffnen, ohne dass jemand etwas erfahren hat.
case "$BEFEHL" in
  *"graphify query"*|*"graphify explain"*|*"graphify path"*)
    mkdir -p .git 2>/dev/null || exit 0
    : > ".git/.graphify-used-${SITZUNG}" 2>/dev/null || true
    find .git -maxdepth 1 -name '.graphify-used-*' -mtime +7 -delete 2>/dev/null || true
    ;;
esac
exit 0
