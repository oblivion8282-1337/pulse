#!/usr/bin/env bash
# Claude Code PreToolUse-Hook (matcher: Bash). Blockt `git commit`, wenn
# App-Code gestaged ist, der code-simplifier aber über DIESEN Stand noch nicht
# gelaufen + gestempelt wurde. Greift nur für Commits, die Claude über das
# Bash-Tool ausführt — manuelle Commits des Users sind nicht betroffen.
#
# Stempel schreibt .claude/hooks/simplify-stamp.sh (nach Simplifier + grünen
# Tests). Liegt in .git/ → nie getrackt, pro Klon lokal.
#
# Fail-open: bei Infra-Fehlern (kein git / kein python3) → erlauben statt
# blockieren, damit der Workflow nie wegen Randfällen festhängt.
set -uo pipefail

input="$(cat 2>/dev/null || true)"
cmd="$(printf '%s' "$input" | python3 -c 'import sys, json
try:
    d = json.load(sys.stdin)
    print((d.get("tool_input") or {}).get("command", ""))
except Exception:
    print("")' 2>/dev/null || true)"

# Nur git-Commits abfangen.
case "$cmd" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

gitdir="$(git rev-parse --git-dir 2>/dev/null)" || exit 0

# Gestageter App-Code, der unserer Quality-Pass unterliegt — spiegelt die
# Größen-Policy-Ausnahmen (Tests, Migrationen, vendored components/ui/).
code="$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null \
  | grep -Ei '\.(py|ts|tsx|js|jsx|mjs|cjs|svelte|rs|go)$' \
  | grep -vE '(^|/)tests/|\.spec\.|\.test\.|/alembic/versions/|/components/ui/' \
  || true)"
[ -z "$code" ] && exit 0   # kein gegateter Code → erlauben (Docs/Config/Tests/Changelog)

tree="$(git write-tree 2>/dev/null)" || exit 0
stamp="$(cat "$gitdir/.simplify-stamp" 2>/dev/null || true)"
[ "$tree" = "$stamp" ] && exit 0

cat >&2 <<'MSG'
[simplifier-gate] Commit blockiert — es sind App-Code-Änderungen gestaged, aber
der code-simplifier ist über DIESEN Stand noch nicht gelaufen.

Routine vor dem Commit:
  1) code-simplifier-Agent über die geänderten Dateien laufen lassen
  2) relevante Tests/Checks erneut grün ziehen (pytest / pnpm check + build)
  3) Ergebnis stagen + stempeln:  bash .claude/hooks/simplify-stamp.sh
  4) Commit erneut ausführen
MSG
exit 2
