#!/usr/bin/env bash
# Changelog-Gate (CI): blockt einen Deploy, wenn er Code/Verhalten ändert, aber
# web/static/changelog.json nicht mit aktualisiert wurde. So ist garantiert,
# dass jeder Push auf main, der die App verändert, einen Changelog-Eintrag hat
# (Pflege-Regeln: CLAUDE.md → "Changelog").
#
# Usage: check-changelog.sh <before-sha> <after-sha>
#   In ci.yml mit ${{ github.event.before }} und ${{ github.sha }} aufgerufen.
#
# Nur USER-FACING Code verlangt einen Eintrag. Nicht-user-facing Pfade (Doku,
# CI/Workflows, Infra, Packaging, Build-Scripts, Tests, Config, changelog
# selbst) sind ausgenommen — die ändern nichts, was ein Endnutzer im
# „Was ist neu?"-Dialog sehen würde.
set -euo pipefail

# Erweitern, wenn neue nicht-user-facing Top-Level-Bereiche dazukommen.
NON_USER_FACING='(^|/)[^/]*\.md$|^docs/|^\.github/|^infra/|^packaging/|^scripts/|(^|/)Dockerfile[^/]*$|\.toml$|/tests/|(^|/)conftest\.py$|^web/static/changelog\.json$'

before="${1:-}"
after="${2:-HEAD}"

# Erster Push auf einen Branch: before = lauter Nullen → kein sinnvoller Range.
if [[ -z "$before" || "$before" =~ ^0+$ ]]; then
  echo "Kein Vorgänger-Commit (erster Push) — Changelog-Gate übersprungen."
  exit 0
fi

# Force-Push / verwaister before-Commit: nicht hart failen, nur warnen.
if ! git cat-file -e "$before^{commit}" 2>/dev/null; then
  echo "::warning::before-Commit $before nicht erreichbar — Changelog-Gate übersprungen."
  exit 0
fi

changed="$(git diff --name-only "$before" "$after")"
echo "Geänderte Dateien in diesem Push:"
echo "$changed" | sed 's/^/  /'

# Code = alles außer den nicht-user-facing Pfaden oben.
code="$(echo "$changed" | grep -vE "$NON_USER_FACING" || true)"

if [[ -z "$code" ]]; then
  echo "✓ Nur nicht-user-facing Änderungen (Doku/CI/Infra/Tests) — kein Eintrag nötig."
  exit 0
fi

if echo "$changed" | grep -qx 'web/static/changelog.json'; then
  echo "✓ Code geändert UND Changelog aktualisiert."
  exit 0
fi

echo "::error::Dieser Push ändert Code, aber web/static/changelog.json wurde nicht aktualisiert."
echo "::error::Bitte einen Changelog-Eintrag ergänzen (Claude: erst Stil-Vorschläge an den User, dann Eintrag schreiben). Siehe CLAUDE.md → Changelog."
exit 1
