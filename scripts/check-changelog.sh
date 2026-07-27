#!/usr/bin/env bash
# Changelog-Erinnerung (CI): meldet, wenn ein Push Code/Verhalten ändert, aber
# web/static/changelog.json nicht mit aktualisiert wurde
# (Pflege-Regeln: CLAUDE.md → "Changelog").
#
# WARNUNG, KEIN GATE. Seit 2026-06-28 endet JEDER Pfad mit exit 0, damit
# Hotfixes nicht blockieren — der Name "Gate" hielt sich danach noch eine Weile
# in Kommentaren und in CLAUDE.md und war schlicht falsch (korrigiert
# 2026-07-27). Der ``images``-Job hängt zwar an diesem Job, aber der schlägt nie
# fehl; der Deploy läuft also in jedem Fall. Ein fehlender Eintrag ist eine
# redaktionelle Nachlässigkeit, kein technischer Fehler.
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
# Alembic-Migrationen (``*/alembic/...``) sind Schema-Plumbing: die
# user-sichtbare Wirkung wird vom begleitenden Code-Commit (Model/Route)
# angekündigt, der das Gate ohnehin auslöst. Ein reiner Migrations-Commit
# (z.B. ein Revision-Hotfix) braucht keinen eigenen Eintrag.
NON_USER_FACING='(^|/)[^/]*\.md$|^docs/|^\.github/|^infra/|^packaging/|(^|/)scripts/|(^|/)Dockerfile[^/]*$|\.toml$|\.ya?ml$|(^|/)build-resources/|(^|/)package\.json$|/tests/|(^|/)conftest\.py$|/alembic/|^web/static/changelog\.json$|^web/static/install\.sh$|(^|/)\.[a-z]+ignore$'

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

echo "::warning::Dieser Push ändert Code, aber web/static/changelog.json wurde nicht aktualisiert."
echo "::warning::Bitte einen Changelog-Eintrag nachreichen (Stil vorher mit dem User abstimmen). Siehe CLAUDE.md → Changelog."
echo "(2026-06-28: Gate ist jetzt Warning-only, damit Hotfixes nicht blocken — images-Job läuft trotzdem.)"
exit 0
