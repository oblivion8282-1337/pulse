#!/usr/bin/env bash
# Claude Code Stop-Hook. Blockt das Beenden des Turns, solange App-Code seit dem
# letzten Commit geändert/neu ist, der code-simplifier aber über DIESEN Stand
# noch nicht gelaufen + gestempelt wurde. Analog zu require-simplifier.sh, nur
# bei Stop (Turn-Ende) statt bei `git commit` — der Simplifier läuft so am Ende
# JEDER Änderung, nicht erst vor dem Commit.
#
# Loop-frei: der Stop-Gate vergleicht den Inhalts-Hash der geänderten Dateien
# (simplify-changed-hash.sh) mit dem Stempel in .git/.simplify-stamp-stop.
# Sobald der code-simplifier gelaufen ist und simplify-stamp.sh den Stand
# stempelt, stimmt der Hash → der nächste Stop wird erlaubt. Macht der
# Simplifier keine Änderungen, reicht das blosse Stempeln.
#
# Fail-open: bei Infra-Fehlern (kein git / kein Tooling) → erlauben statt
# blockieren, damit der Turn nie wegen Randfällen festhängt.
set -uo pipefail

# Stop-JSON von stdin verwerfen (wir brauchen den Inhalt nicht).
cat >/dev/null 2>&1 || true

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hash="$(bash "$dir/simplify-changed-hash.sh" 2>/dev/null || true)"
[ -z "$hash" ] && exit 0   # keine gegateten App-Code-Änderungen → Stop erlauben

gitdir="$(git rev-parse --git-dir 2>/dev/null)" || exit 0
stamp="$(cat "$gitdir/.simplify-stamp-stop" 2>/dev/null || true)"
[ "$hash" = "$stamp" ] && exit 0   # bereits simplifiziert + gestempelt → erlauben

cat >&2 <<'MSG'
[simplifier-stop-gate] Turn-Ende blockiert — es gibt App-Code-Änderungen, über
die der code-simplifier auf DIESEM Stand noch nicht gelaufen ist.

Bevor der Turn endet:
  1) code-simplifier-Agent über die geänderten Dateien laufen lassen
  2) relevante Tests/Checks erneut grün ziehen (pytest / pnpm check + build)
  3) stempeln:  bash .claude/hooks/simplify-stamp.sh

Danach normal beenden — der Gate lässt den Stop dann durch.
MSG
exit 2
