#!/usr/bin/env bash
# Stempelt den aktuell gestageten Stand als "code-simplifier gelaufen + Checks
# grün". Direkt vor `git commit` ausführen (siehe Simplifier-Regel in CLAUDE.md).
# Der Stempel = git-write-tree-Hash des Index, abgelegt in .git/.simplify-stamp.
set -euo pipefail
gitdir="$(git rev-parse --git-dir)"
tree="$(git write-tree)"
printf '%s\n' "$tree" > "$gitdir/.simplify-stamp"
echo "[simplify-stamp] Stand gestempelt ($tree) — Commit ist jetzt freigegeben."
