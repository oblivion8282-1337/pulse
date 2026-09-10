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

{
  echo "Pulse-Nachtlauf $stempel (HEAD: $(git rev-parse --short HEAD))"
  echo

  echo "═══ Teil 1: volles Gate (pytest backend, pnpm check/build/test:unit) ═══"
  PULSE_GATE_VOLL=1 bash scripts/gate.sh
  gate=$?
  echo "Gate-Ende: Status $gate"

  echo
  echo "═══ Teil 2: Playwright E2E (komplette Suite, lokal) ═══"
  ( cd web && pnpm exec playwright test --reporter=list )
  pw=$?
  echo "Playwright-Ende: Status $pw"
} 2>&1 | tee "$log"

echo
echo "Protokoll: $log"
# 0 nur, wenn beide Teile grün waren.
[ "${gate:-1}" -eq 0 ] && [ "${pw:-1}" -eq 0 ]
