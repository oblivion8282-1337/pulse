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
# verbindliche Test-Gate läuft HIER, lokal, BEVOR gepusht wird: rot = kein Push.
# Reine Doku-Änderungen (**.md / docs/ / .claude/) überspringen es (wie ci.yml).
# Notausgang für echte Ausnahmen: SKIP_TESTS=1 bash scripts/ship.sh
git fetch -q origin main 2>/dev/null || true
mergebase="$(git merge-base origin/main HEAD 2>/dev/null || true)"
changed="$(git diff --name-only "${mergebase:-HEAD~1}"..HEAD 2>/dev/null || true)"
code_changed=false
if [ -z "$changed" ]; then
  code_changed=true   # Änderungen nicht bestimmbar → sicherheitshalber testen
else
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      *.md | docs/* | .claude/*) : ;;   # inert → ignorieren
      *) code_changed=true ;;
    esac
  done <<< "$changed"
fi

if [ "${SKIP_TESTS:-}" = "1" ]; then
  echo "⚠  SKIP_TESTS=1 — Test-Gate übersprungen (auf eigene Verantwortung)."
elif [ "$code_changed" != true ]; then
  echo "→ Nur Doku/Config geändert — Test-Gate übersprungen."
else
  echo "→ Code-Änderung erkannt → lokales Test-Gate läuft (ersetzt den CI-Pflicht-Check)…"
  # Test-Infra sicherstellen: Redis (:6380) muss laufen; best-effort hochfahren.
  if ! (exec 3<>/dev/tcp/127.0.0.1/6380) 2>/dev/null; then
    echo "  Test-Infra (Redis/Postgres) nicht erreichbar — fahre sie hoch…"
    docker compose up -d redis postgres >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/6380) 2>/dev/null && break; sleep 1; done
  fi
  if ! (exec 3<>/dev/tcp/127.0.0.1/6380) 2>/dev/null; then
    echo "✗ Test-Infra (Redis :6380) nicht erreichbar. Starte den Dev-Stack: scripts/dev-up.fish" >&2
    exit 1
  fi
  echo "  Backend-Tests (~4 min)…"
  REDIS_URL=redis://localhost:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 \
    uv run --all-packages pytest -q --reruns 2 --only-rerun AssertionError --only-rerun RuntimeError \
    || { echo "✗ Backend-Tests ROT — Push abgebrochen. Erst grün ziehen." >&2; exit 1; }
  echo "  Frontend check + build…"
  ( cd web && pnpm check && pnpm build ) \
    || { echo "✗ Frontend check/build ROT — Push abgebrochen." >&2; exit 1; }
  echo "✓ Test-Gate grün."
fi
echo

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
