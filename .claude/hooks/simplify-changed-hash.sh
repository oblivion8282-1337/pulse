#!/usr/bin/env bash
# Gibt einen Inhalts-Hash des aktuellen Arbeitsstands ALLER App-Code-Dateien
# aus, die seit HEAD geändert oder neu (untracked) sind und unserer Quality-
# Pass unterliegen — gleiche Ausnahmen wie der Commit-Gate (Tests, Migrationen,
# vendored components/ui/). Leer, wenn nichts Gegatetes geändert ist.
#
# Gemeinsam genutzt von stop-require-simplifier.sh (Vergleich) und
# simplify-stamp.sh (Stempel), damit Gate und Stempel garantiert denselben
# Hash sehen. Den Datei-Filter bewusst identisch zu require-simplifier.sh
# halten (Commit-Gate) — beide spiegeln dieselbe Größen-Policy-Ausnahmeliste.
#
# Fail-open: kein git / kein Tooling → leerer Hash (Aufrufer erlaubt dann).
set -uo pipefail

git rev-parse --git-dir >/dev/null 2>&1 || { echo ""; exit 0; }

changed="$( { git diff HEAD --name-only --diff-filter=ACM 2>/dev/null; \
              git ls-files --others --exclude-standard 2>/dev/null; } \
  | grep -Ei '\.(py|ts|tsx|js|jsx|mjs|cjs|svelte|rs|go)$' \
  | grep -vE '(^|/)tests/|\.spec\.|\.test\.|/alembic/versions/|/components/ui/' \
  | sort -u || true )"

[ -z "$changed" ] && { echo ""; exit 0; }

printf '%s\n' "$changed" | while IFS= read -r f; do
  [ -f "$f" ] && sha256sum "$f"
done | sha256sum | awk '{print $1}'
