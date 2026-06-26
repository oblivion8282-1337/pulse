#!/usr/bin/env bash
# Stempelt den aktuellen Stand als "code-simplifier gelaufen + Checks grün".
# Direkt nach dem Simplifier (und vor `git commit` bzw. vor dem Turn-Ende)
# ausführen — siehe Simplifier-Regel in CLAUDE.md.
#
# Schreibt ZWEI Stempel in .git/ (nie getrackt, pro Klon lokal):
#   .simplify-stamp       = git-write-tree des Index            → Commit-Gate
#   .simplify-stamp-stop  = Inhalts-Hash der geänderten Dateien → Stop-Gate
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gitdir="$(git rev-parse --git-dir)"

tree="$(git write-tree)"
printf '%s\n' "$tree" > "$gitdir/.simplify-stamp"

stophash="$(bash "$dir/simplify-changed-hash.sh" 2>/dev/null || true)"
printf '%s\n' "$stophash" > "$gitdir/.simplify-stamp-stop"

echo "[simplify-stamp] Stand gestempelt (index=$tree, stop=${stophash:-leer}) — Commit + Turn-Ende sind jetzt freigegeben."
