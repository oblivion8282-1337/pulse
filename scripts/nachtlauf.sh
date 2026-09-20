#!/usr/bin/env bash
# Der Nachtlauf — das komplette lokale Test-Gate PLUS die gesamte Playwright-
# E2E-Suite in einem Rutsch, mit Zeitstempel-Protokoll. Gebaut für die
# Rechte-Management-Kampagne (2026-09-11), aber generisch genug für jede
# Nacht. gate.sh allein reicht nicht: es fährt pytest + pnpm check/build/
# test:unit, aber bewusst KEINE Playwright-E2E (die gehören laut CLAUDE.md
# zum lokalen Gate vor dem Push, laufen hier aber einfach zusätzlich mit).
#
# Aufruf: bash scripts/nachtlauf.sh    (Ergebnis: /tmp/pulse-nachtlauf-*.log)
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

stempel="$(date +%Y-%m-%d_%H-%M-%S)"
log="/tmp/pulse-nachtlauf-${stempel}.log"

# Status je Teil in Dateien: im Pipeline-Block ({ ... } | tee) leben Variablen
# im Subshell — die Zuweisungen unten wären sonst hinter der Pipe verschwunden
# und die Endauswertung wäre STETS rot gewesen (Bughunt 2026-09-20).
statusdir="$(mktemp -d)"
trap 'rm -rf "$statusdir"' EXIT

{
  echo "Pulse-Nachtlauf $stempel (HEAD: $(git rev-parse --short HEAD))"
  echo

  echo "═══ Teil 1: volles Gate (pytest backend, pnpm check/build/test:unit) ═══"
  PULSE_GATE_VOLL=1 bash scripts/gate.sh
  echo $? > "$statusdir/gate"
  echo "Gate-Ende: Status $(cat "$statusdir/gate")"

  echo
  echo "═══ Teil 2: Playwright E2E (komplette Suite, lokal) ═══"
  ( cd web && pnpm exec playwright test --reporter=list )
  echo $? > "$statusdir/pw"
  echo "Playwright-Ende: Status $(cat "$statusdir/pw")"
} 2>&1 | tee "$log"

gate="$(cat "$statusdir/gate")"
pw="$(cat "$statusdir/pw")"

echo
echo "Protokoll: $log"
# 0 nur, wenn beide Teile grün waren.
[ "$gate" -eq 0 ] && [ "$pw" -eq 0 ]
