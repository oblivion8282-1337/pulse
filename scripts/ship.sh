#!/usr/bin/env bash
# Landet den aktuellen Feature-Branch atomar + sicher auf main — über GitHub-PR.
#
# Warum nicht lokal `git merge`: Wenn main zwischenzeitlich gewandert ist (anderer
# Rechner hat gepusht), bricht ein Fast-Forward-Merge um, und ein ungeschützter
# Cleanup verwaist den Branch. Der PR-Flow rebased server-seitig auf main, wartet
# auf die Pflicht-Checks (mergt nie was Rotes) und löscht den Branch erst NACH
# erfolgreichem Merge.
#
# Voraussetzung (einmalig, schon gesetzt): Repo hat allow_auto_merge=true +
# delete_branch_on_merge=true. Merge nach main = Prod-Deploy → nur mit Freigabe.
set -euo pipefail

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" = "main" ]; then
  echo "Du bist auf main — es gibt keinen Feature-Branch zum Landen." >&2
  exit 1
fi

# ── Lokales Test-Gate (ersetzt den entfernten CI-Pflicht-Check) ─────────────
# Seit 2026-07-15 sind backend/frontend KEINE GitHub-Pflicht-Checks mehr → das
# verbindliche Test-Gate läuft LOKAL, BEVOR gepusht wird: rot = kein Push.
#
# Es liegt seit 2026-08-26 in `scripts/gate.sh`, damit derselbe Lauf auch
# MITTEN in der Arbeit gefahren werden kann und sein Ergebnis hier zählt. Was
# dort schon grün war und sich seither nicht geändert hat, läuft nicht noch
# einmal — bis dahin fuhr ship.sh alles ein zweites Mal, auch wenn seit dem
# ersten Lauf keine Zeile des betroffenen Bereichs angefasst worden war.
# Begründung der beiden Abkürzungen (Stempel + Vergleich mit origin/main) steht
# im Kopf von gate.sh.
#
# Notausgang für echte Ausnahmen: SKIP_TESTS=1 bash scripts/ship.sh
git fetch -q origin main 2>/dev/null || true
if [ "${SKIP_TESTS:-}" = "1" ]; then
  echo "⚠  SKIP_TESTS=1 — Test-Gate übersprungen (auf eigene Verantwortung)."
else
  bash "$(dirname "$0")/gate.sh"
fi
echo

# Branch sicher auf dem Remote haben.
git push -u origin "$branch"
head_sha="$(git rev-parse HEAD)"

# PR anlegen, falls für diesen Branch keiner OFFEN ist.
#
# Warum nicht `gh pr view "$branch"`: das findet auch längst GEMERGTE PRs
# desselben Branch-Namens. Wird ein Themen-Branch ein zweites Mal verwendet —
# hier der Normalfall, dieselbe Sache läuft über mehrere Runden —, sah das
# Skript den alten PR, legte keinen neuen an, und `gh pr merge` lief danach
# gegen den bereits gemergten. Das gibt keinen Fehler: die Erfolgsmeldung kam,
# der Branch lag aber unangetastet auf dem Server. Am 2026-08-06 genau so
# passiert (alter PR #270 statt eines neuen), und ohne Nachsehen hätte es
# ausgesehen wie gelandet.
pr="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty')"
if [ -z "$pr" ]; then
  gh pr create --base main --head "$branch" --fill >/dev/null
  pr="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty')"
fi
if [ -z "$pr" ]; then
  echo "✗ Kein offener PR für '$branch' — Anlegen fehlgeschlagen." >&2
  exit 1
fi

# Zeigt der PR auf den Stand, den das Test-Gate gerade geprüft hat? Sonst würde
# etwas anderes gemergt als das, was hier grün war (z.B. nach einem halb
# durchgelaufenen Push).
pr_sha="$(gh pr view "$pr" --json headRefOid --jq .headRefOid)"
if [ "$pr_sha" != "$head_sha" ]; then
  echo "✗ PR #$pr zeigt auf ${pr_sha:0:8}, lokal ist ${head_sha:0:8} — Push unvollständig?" >&2
  exit 1
fi

# Rebase-Merge, Branch-Delete nach Erfolg, Auto-Merge sobald die Checks grün sind.
# Über die NUMMER statt über den Branch-Namen — die ist eindeutig.
gh pr merge "$pr" --rebase --delete-branch --auto

# Nachprüfen statt behaupten: ohne das war die Erfolgsmeldung oben eine reine
# Vermutung, und genau daran ist es einmal vorbeigelaufen.
if [ "$(gh pr view "$pr" --json autoMergeRequest --jq '.autoMergeRequest != null')" != "true" ]; then
  echo "✗ Auto-Merge wurde für PR #$pr NICHT gesetzt — bitte von Hand prüfen." >&2
  exit 1
fi

echo
echo "✓ PR #$pr auf Auto-Merge gesetzt — landet auf main, sobald die Pflicht-Checks grün sind."
echo "  Status:  gh pr checks $pr --watch"
