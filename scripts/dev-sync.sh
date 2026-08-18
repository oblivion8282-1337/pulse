#!/usr/bin/env bash
#
# Backend-Quellcode auf den gemeinsamen Remote-Dev-Stack schieben.
#
#   scripts/dev-sync.sh                 Quellcode -> Hetzner, Dienste laden selbst neu (~2 s)
#   scripts/dev-sync.sh --watch         Dauerlauf: bei jedem Speichern automatisch
#   scripts/dev-sync.sh --web           zusätzlich die Oberfläche bauen und ausliefern
#   scripts/dev-sync.sh --migrate       zusätzlich Alembic laufen lassen
#   scripts/dev-sync.sh --restart       Dienste hart neu starten statt nur neu laden
#
# Ziel überschreibbar:  PULSE_DEV_HOST=michael@1.2.3.4  PULSE_DEV_DIR=~/pulse-test
#
# ── Warum das ohne Image-Bau reicht ──────────────────────────────────────────
# Die Dienste sind im Image *editable* installiert; der Stack hängt genau die
# Verzeichnisse ein, die dabei in den Suchpfad eingetragen wurden, und fährt
# `uvicorn --reload` (siehe infra/dev-remote/docker-compose.yml). Neu gebaut
# werden muss nur, wenn sich `uv.lock` ändert.
#
# ── Bewusst NICHT enthalten ──────────────────────────────────────────────────
# `.env`, `secrets/`, `mediamtx.yml`, `livekit.yaml`, die nginx-Konfiguration:
# das sind maschinenspezifische Dateien mit Zugangsdaten, die auf dem Server
# leben und dort gepflegt werden. Ein Sync würde sie mit lokalen Dev-Werten
# überschreiben und den Stack lahmlegen.
#
# ── Grenze, die man kennen muss ──────────────────────────────────────────────
# Es gibt EIN gemeinsames Backend. Wer synchronisiert, setzt den Backend-Stand
# für alle Rechner. Das ist gewollt (ein Zustand, von überall testbar), aber
# zwei Leute können sich damit gegenseitig überschreiben.

set -euo pipefail

HOST="${PULSE_DEV_HOST:-michael@77.42.71.166}"
DIR="${PULSE_DEV_DIR:-pulse-test}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Wiederverwendete SSH-Verbindung. Ohne das kostet jeder Lauf einen kompletten
# Verbindungsaufbau (~0,5 s) — im --watch-Dauerlauf ist das der Unterschied
# zwischen "sofort" und "spürbar".
SSH_OPTS=(-o ControlMaster=auto -o ControlPath="${TMPDIR:-/tmp}/pulse-dev-%r@%h-%p" -o ControlPersist=5m)
ssh_run() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

# Pfade, die den Stack ausmachen. `-R` von rsync hält die Struktur, deshalb
# landen sie unter <DIR>/src/ genau so wieder wie hier.
PATHS=(
  shared/src
  services/auth/src
  services/auth/alembic
  services/auth/alembic.ini
  services/chat-gateway/src
  services/chat-gateway/alembic
  services/chat-gateway/alembic.ini
  services/voice-signaling/src
  services/media-svc/src
  services/mediamtx-auth-hook/src
  plugins
)

# Dieselben Ausschlüsse in den drei Schreibweisen, die rsync, tar und
# inotifywait jeweils verstehen — nur gemeinsam ändern.
RSYNC_EXCLUDES=(--exclude='__pycache__/' --exclude='*.pyc' --exclude='.pytest_cache/' --exclude='*.egg-info/')
TAR_EXCLUDES=(--exclude='__pycache__' --exclude='*.pyc' --exclude='.pytest_cache')
WATCH_EXCLUDE='(__pycache__|\.pyc$|\.pytest_cache)'

do_web=0; do_migrate=0; do_restart=0; do_watch=0
for arg in "$@"; do
  case "$arg" in
    --web)     do_web=1 ;;
    --migrate) do_migrate=1 ;;
    --restart) do_restart=1 ;;
    --watch)   do_watch=1 ;;
    # Kopfkommentar bis zur ersten Nicht-Kommentarzeile ausgeben — wächst der
    # Kopf, wächst die Hilfe mit, ohne dass hier eine Zeilennummer nachgezogen
    # werden muss.
    -h|--help) awk 'NR > 1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $arg (--help zeigt die Liste)" >&2; exit 2 ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }

# rsync ist der schnelle Weg (überträgt nur Unterschiede, kann löschen).
# Git-Bash auf Windows bringt kein rsync mit — dort greift der tar-Weg, der mit
# den Bordmitteln jeder Installation auskommt. Er kann nur nicht löschen:
# eine lokal gelöschte Datei bleibt auf dem Server liegen. Beim Umbenennen
# von Modulen deshalb einmal mit --restart nachfassen.
push_source() {
  # rsync legt nur das LETZTE Verzeichnis der Zielangabe an, nicht den Pfad
  # darüber — beim ersten Lauf gegen ein frisches Ziel bricht es sonst mit
  # „mkdir … failed". Über die wiederverwendete Verbindung kostet das nichts.
  ssh_run "mkdir -p '$DIR/src'"
  if have rsync; then
    rsync -az --delete --rsh="ssh ${SSH_OPTS[*]}" "${RSYNC_EXCLUDES[@]}" \
      -R "${PATHS[@]}" "$HOST:$DIR/src/"
  else
    tar czf - "${TAR_EXCLUDES[@]}" "${PATHS[@]}" | ssh_run "tar xzf - -C '$DIR/src'"
  fi
}

push_web() {
  echo "→ Oberfläche bauen (pnpm build)"
  (cd web && pnpm build >/dev/null)
  echo "→ Oberfläche ausliefern"
  # Der INHALT wird ersetzt, nie das Verzeichnis selbst: `web-build` ist als
  # Volume in den nginx-Container gehängt, und ein Bind-Mount hängt am Inode.
  # Ein `rm -rf` des Verzeichnisses lässt den Container auf ein totes Inode
  # zeigen — er liefert dann weiter die alte Fassung aus oder gar nichts, ohne
  # dass irgendwo ein Fehler steht.
  ssh_run "mkdir -p '$DIR/web-build'"
  if have rsync; then
    rsync -az --delete --rsh="ssh ${SSH_OPTS[*]}" web/build/ "$HOST:$DIR/web-build/"
  else
    # Ohne rsync bleiben entfallene Dateien liegen (tar kann nicht löschen).
    # Für eine SvelteKit-Ausgabe mit gehashten Namen ist das folgenlos.
    tar czf - -C web/build . | ssh_run "tar xzf - -C '$DIR/web-build'"
  fi
}

run_migrations() {
  echo "→ Alembic (auth + chat-gateway)"
  ssh_run "cd '$DIR' && docker compose up migrate-auth migrate-chat"
}

restart_services() {
  echo "→ Dienste neu starten"
  ssh_run "cd '$DIR' && docker compose restart auth chat-gateway voice-signaling media-svc mediamtx-auth-hook"
}

sync_once() {
  push_source
  if [ "$do_web" = 1 ]; then push_web; fi
  if [ "$do_migrate" = 1 ]; then run_migrations; fi
  if [ "$do_restart" = 1 ]; then restart_services; fi
}

if [ "$do_watch" = 0 ]; then
  echo "→ Quellcode -> $HOST:$DIR/src/"
  sync_once
  echo "✓ fertig — die Dienste laden binnen ~2 s neu (Log: scripts/dev-remote.mjs --logs)"
  exit 0
fi

# ── Dauerlauf ────────────────────────────────────────────────────────────────
# inotifywait meldet Änderungen sofort; ohne das Werkzeug wird im
# Zwei-Sekunden-Takt nachgesehen. rsync ist bei "nichts geändert" praktisch
# kostenlos, das Pollen fällt also nicht ins Gewicht.
echo "→ Dauerlauf gegen $HOST:$DIR — Strg+C beendet"
sync_once
echo "✓ Erstabgleich fertig, warte auf Änderungen"

if have inotifywait; then
  while inotifywait -qq -r -e modify,create,delete,move \
        --exclude "$WATCH_EXCLUDE" "${PATHS[@]}"; do
    printf '  %s  ' "$(date +%H:%M:%S)"
    sync_once && echo "abgeglichen"
  done
else
  echo "  (inotify-tools nicht installiert — es wird im 2-Sekunden-Takt nachgesehen)"
  # Bewusst nur der Quellcode-Abgleich: --web/--migrate/--restart hier
  # mitlaufen zu lassen hiesse, den Stack im Zwei-Sekunden-Takt anzufassen.
  while true; do
    sleep 2
    out="$(push_source 2>&1)" || { echo "  Sync-Fehler: $out" >&2; continue; }
  done
fi
