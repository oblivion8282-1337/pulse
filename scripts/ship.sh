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

# Branch sicher auf dem Remote haben.
git push -u origin "$branch"

# PR anlegen, falls noch keiner offen ist (Titel/Body aus den Commits).
if ! gh pr view "$branch" >/dev/null 2>&1; then
  gh pr create --base main --head "$branch" --fill
fi

# Rebase-Merge, Branch-Delete nach Erfolg, Auto-Merge sobald die Checks grün sind.
gh pr merge "$branch" --rebase --delete-branch --auto

echo
echo "✓ PR auf Auto-Merge gesetzt — landet auf main, sobald die Pflicht-Checks grün sind."
echo "  Status:  gh pr checks $branch --watch"
