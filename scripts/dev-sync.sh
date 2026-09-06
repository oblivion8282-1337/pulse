#!/usr/bin/env bash
#
# Backend-Quellcode auf den gemeinsamen Remote-Dev-Stack schieben.
#
#   scripts/dev-sync.sh                 Quellcode -> Hetzner, Dienste laden selbst neu (~2 s)
#   scripts/dev-sync.sh --pull          umgekehrt gedacht: der Server holt sich den
#                                       Stand selbst von GitHub (nach ~/pulse-test/repo)
#                                       und legt ihn in src/ — Stand ist dann ein
#                                       benennbarer Commit, kein lokaler Zufall
#   scripts/dev-sync.sh --pull --branch X   diesen Branch ziehen (Vorgabe: main)
#   scripts/dev-sync.sh --watch         Dauerlauf: bei jedem Speichern automatisch
#   scripts/dev-sync.sh --web           zusätzlich die Oberfläche bauen und ausliefern
#                                       (auch bei --pull: der Server hat nur Node 18,
#                                       das für den Vite-Bau zu alt ist — gebaut wird
#                                       hier lokal und hochgeladen wie gehabt)
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

# Der Kurzname aus ~/.ssh/config hat Vorrang vor der nackten IP, WENN es ihn
# gibt. Grund: ssh sucht seinen `Host`-Block nach dem Namen auf der
# Kommandozeile, nicht nach der aufgelösten Adresse — mit `michael@77.42.71.166`
# greift der Block `Host pulse-test` also NICHT, und damit auch sein
# `IdentityFile` nicht. Auf einer Maschine ohne Agent endet das in
# "Permission denied (publickey,password)", obwohl `ssh pulse-test` daneben
# anstandslos durchläuft.
if [ -z "${PULSE_DEV_HOST:-}" ] && grep -qiE '^[[:space:]]*Host([[:space:]].*)?[[:space:]]pulse-test([[:space:]]|$)' "$HOME/.ssh/config" 2>/dev/null; then
  HOST="pulse-test"
else
  HOST="${PULSE_DEV_HOST:-michael@77.42.71.166}"
fi
DIR="${PULSE_DEV_DIR:-pulse-test}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Wiederverwendete SSH-Verbindung. Ohne das kostet jeder Lauf einen kompletten
# Verbindungsaufbau (~0,5 s) — im --watch-Dauerlauf ist das der Unterschied
# zwischen "sofort" und "spürbar".
#
# WINDOWS KANN DAS NICHT: Multiplexing reicht den Verbindungs-Dateideskriptor
# über einen Unix-Socket weiter, den es dort nicht gibt. Das scheitert nicht
# leise, sondern mit "mm_send_fd: sendmsg(2): Connection reset by peer" —
# eine Meldung, die nach kaputtem Netz aussieht, obwohl die Verbindung steht
# (`ssh <host> echo OK` läuft daneben einwandfrei durch). Dort also ohne
# Wiederverwendung; der halbe Verbindungsaufbau je Lauf ist der günstigere
# Preis gegenüber einem Sync, der auf dieser Plattform gar nicht läuft.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) SSH_OPTS=() ;;
  *) SSH_OPTS=(-o ControlMaster=auto -o ControlPath="${TMPDIR:-/tmp}/pulse-dev-%r@%h-%p" -o ControlPersist=5m) ;;
esac
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

do_web=0; do_migrate=0; do_restart=0; do_watch=0; do_pull=0
branch="main"
while [ $# -gt 0 ]; do
  case "$1" in
    --web)     do_web=1 ;;
    --migrate) do_migrate=1 ;;
    --restart) do_restart=1 ;;
    --watch)   do_watch=1 ;;
    --pull)    do_pull=1 ;;
    --branch)  [ $# -ge 2 ] || { echo "--branch braucht einen Namen" >&2; exit 2; }
               branch="$2"; shift ;;
    --branch=*) branch="${1#--branch=}" ;;
    # Kopfkommentar bis zur ersten Nicht-Kommentarzeile ausgeben — wächst der
    # Kopf, wächst die Hilfe mit, ohne dass hier eine Zeilennummer nachgezogen
    # werden muss.
    -h|--help) awk 'NR > 1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $1 (--help zeigt die Liste)" >&2; exit 2 ;;
  esac
  shift
done

if [ "$do_watch" = 1 ] && [ "$do_pull" = 1 ]; then
  echo "--watch und --pull zusammen ergibt keinen Sinn: der Dauerlauf schiebt lokale Änderungen, der Pull-Modus holt Commits." >&2
  exit 2
fi

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
    # --no-perms/-o/-g: das Ziel gehört je nach Nutzer einer anderen UID
    # (michael oder der externe Mobile-Entwickler), und chmod/chown darf nur
    # der Eigentümer. Die Rechte am Ziel regelt die gemeinsame Gruppe mit
    # setgid auf den Verzeichnissen (siehe infra/dev-remote/README.md).
    rsync -az --delete --no-perms --no-owner --no-group \
      --rsh="ssh ${SSH_OPTS[*]}" "${RSYNC_EXCLUDES[@]}" \
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

# ── Pull-Modus ───────────────────────────────────────────────────────────────
# Nicht von hier schieben, sondern den Server selbst von GitHub holen lassen.
# Der sichtbare Unterschied zum Schieben: der Stack steht danach auf einem
# Commit, den jeder nennen kann (`git log` im repo dort drüben), nicht auf
# dem halbfertigen Zustand eines Arbeitsverzeichnisses. Und das Auffrischen
# läuft in rsync AUF DEM SERVER — der kennt kein tar-Fallback und kann
# deshalb auch lokal gelöschte Dateien entfernen, was der Weg von Windows
# aus bislang nicht konnte.
#
# Das Server-Checkout `$DIR/repo` wird absichtlich nur per `--ff-only`
# angeschnallt: hängt dort lokale Arbeit drin, bricht der Pull ab, statt
# sie still wegzuwerfen.
pull_source() {
  echo "→ Server holt $branch von GitHub"
  ssh_run "set -e
    cd '$DIR'
    git -C repo fetch origin --prune
    git -C repo checkout '$branch' >/dev/null
    git -C repo pull --ff-only origin '$branch'
    git -C repo log --oneline -1
    cd repo
    rsync -az --delete --no-perms --no-owner --no-group \\
      ${RSYNC_EXCLUDES[*]} \\
      -R ${PATHS[*]} ../src/"
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
  if [ "$do_pull" = 1 ]; then pull_source; else push_source; fi
  if [ "$do_web" = 1 ]; then push_web; fi
  if [ "$do_migrate" = 1 ]; then run_migrations; fi
  if [ "$do_restart" = 1 ]; then restart_services; fi
}

if [ "$do_watch" = 0 ]; then
  if [ "$do_pull" = 1 ]; then
    echo "→ Server zieht GitHub-Stand nach $HOST:$DIR/src/"
  else
    echo "→ Quellcode -> $HOST:$DIR/src/"
  fi
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
