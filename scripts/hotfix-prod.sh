#!/usr/bin/env bash
# Schiebt lokale Änderungen ohne CI-Umweg direkt in die laufenden Prod-Container.
#
# Wozu: Der normale Weg (Push → CI baut Images → GHCR → Cron zieht sie) dauert
# 10–15 Minuten. Für eine Testsession am Handy ist das zu langsam. Dieses Skript
# kopiert die Dateien direkt in den laufenden Container — Sekunden statt Minuten.
#
# WICHTIG — was das hier NICHT ist:
#   Ein Hotfix läuft an Git, CI und den Images vorbei. Auf Prod läuft danach
#   Code, der in keinem Image steckt. Jeder so gefundene Fix MUSS hinterher
#   regulär über einen PR landen, sonst ist er beim nächsten echten Deploy weg.
#   Deshalb: Fix lokal im Branch machen, von dort hochschieben. Dann existiert
#   er bereits als Änderung, und der PR danach ist reine Formsache.
#
#   `restore` holt jeden Container auf den Stand des GHCR-Images zurück.
#
# Der Cron-Updater (*/2) zieht nur *neue* Images und lässt unveränderte Container
# in Ruhe — ein Hotfix überlebt ihn normalerweise. Landet aber währenddessen ein
# Push auf main, wird der Container ersetzt und der Hotfix ist weg. Für die Dauer
# der Session deshalb: `cron-off` … testen … `cron-on`.
#
# Benutzung:
#   scripts/hotfix-prod.sh web          # web/ bauen + nach pulse_web schieben
#   scripts/hotfix-prod.sh auth         # dcc_auth nach pulse_auth + Neustart
#   scripts/hotfix-prod.sh restore web  # zurück auf das GHCR-Image (auch: auth, all)
#   scripts/hotfix-prod.sh cron-off     # Auto-Update pausieren
#   scripts/hotfix-prod.sh cron-on      # Auto-Update wieder scharf schalten
#   scripts/hotfix-prod.sh status       # was läuft, wann zuletzt gebaut, Cron an?
set -euo pipefail

HOST="${PULSE_PROD_HOST:-michael@159.195.150.54}"
STAGING="/home/michael/pulse-hotfix"   # Ablage auf dem Server, außerhalb von ~/pulse
COMPOSE_DIR="/home/michael/pulse/infra/prod"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "FEHLER: $*" >&2; exit 1; }
say() { echo "→ $*"; }

remote() { ssh -o BatchMode=yes "$HOST" "$@"; }

# --- web -------------------------------------------------------------------
# Statische Dateien; nginx liest sie beim nächsten Request. Kein Neustart nötig.
# Der Copy überlagert, löscht also nichts: /self-host/* aus dem Image bleibt.
hotfix_web() {
  say "Baue web/ lokal (pnpm build)"
  (cd "$REPO/web" && pnpm build) || die "web-Build fehlgeschlagen — nichts angefasst"
  [[ -f "$REPO/web/build/index.html" ]] || die "web/build/index.html fehlt"

  say "Übertrage nach $HOST:$STAGING/web"
  remote "mkdir -p $STAGING/web"
  rsync -a --delete -e "ssh -o BatchMode=yes" "$REPO/web/build/" "$HOST:$STAGING/web/"

  say "Kopiere in den laufenden pulse_web"
  remote "docker cp $STAGING/web/. pulse_web:/usr/share/nginx/html/"
  say "Fertig. Am Handy hart neu laden (Cache!)."
}

# --- auth ------------------------------------------------------------------
# dcc_auth ist als editable install verdrahtet (_editable_impl_dcc_auth.pth →
# /app/services/auth/src), deshalb wirkt der Copy dorthin. uvicorn läuft in Prod
# ohne --reload → Neustart ist Pflicht.
hotfix_auth() {
  local src="$REPO/services/auth/src/dcc_auth"
  [[ -d "$src" ]] || die "$src nicht gefunden"

  say "Übertrage dcc_auth nach $HOST:$STAGING/auth"
  remote "mkdir -p $STAGING/auth"
  rsync -a --delete --exclude '__pycache__' -e "ssh -o BatchMode=yes" \
    "$src/" "$HOST:$STAGING/auth/"

  say "Kopiere in pulse_auth + starte neu"
  remote "docker cp $STAGING/auth/. pulse_auth:/app/services/auth/src/dcc_auth/ \
          && docker restart pulse_auth >/dev/null"

  say "Warte auf Gesundheit"
  for _ in $(seq 1 15); do
    if remote "docker exec pulse_auth python -c 'import dcc_auth' 2>/dev/null"; then
      say "auth ist oben."; return 0
    fi
    sleep 1
  done
  echo "WARNUNG: auth antwortet nicht — Logs prüfen:" >&2
  remote "docker logs --tail 30 pulse_auth" >&2
  return 1
}

# --- restore ---------------------------------------------------------------
# Ersetzt den Container durch das unveränderte GHCR-Image. --no-deps, weil sonst
# die depends_on-Kaskade halbe Neustarts auslöst (502 während des Deploys).
restore() {
  local svc="${1:-}"
  local services
  case "$svc" in
    web)  services="web" ;;
    auth) services="auth" ;;
    all)  services="web auth" ;;
    *)    die "restore braucht: web | auth | all" ;;
  esac
  say "Hole $services zurück auf das GHCR-Image"
  remote "cd $COMPOSE_DIR && docker compose up -d --no-deps --force-recreate $services"
  say "Zurückgesetzt. Der Hotfix ist damit weg."
}

# --- cron ------------------------------------------------------------------
cron_off() {
  remote "crontab -l | sed '/pulse-update.sh/ s/^\([^#]\)/#\1/' | crontab -"
  say "Auto-Update pausiert. NICHT VERGESSEN: 'cron-on' nach der Session."
}
cron_on() {
  remote "crontab -l | sed '/pulse-update.sh/ s/^#\+//' | crontab -"
  say "Auto-Update wieder aktiv."
}

status() {
  remote "
    echo '=== Container (Start-Zeit = wann zuletzt ersetzt) ==='
    docker ps --filter name=pulse_web --filter name=pulse_auth \
      --format '{{.Names}}\t{{.Status}}'
    echo
    echo '=== Auto-Update-Crontab ==='
    crontab -l | grep pulse-update.sh || echo '(keine Zeile gefunden)'
    echo
    echo '=== letzte Update-Läufe ==='
    tail -3 $COMPOSE_DIR/pulse-update.log 2>/dev/null || echo '(kein Log)'
  "
}

case "${1:-}" in
  web)      hotfix_web ;;
  auth)     hotfix_auth ;;
  restore)  restore "${2:-}" ;;
  cron-off) cron_off ;;
  cron-on)  cron_on ;;
  status)   status ;;
  *)        sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 1 ;;
esac
