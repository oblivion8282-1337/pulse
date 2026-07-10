#!/usr/bin/env bash
# Schiebt lokale Änderungen ohne CI-Umweg direkt in die laufenden Prod-Container.
#
# Wozu: Der normale Weg (Push → CI baut Images → GHCR → Cron zieht sie) dauert
# 10–15 Minuten. Für einen engen Test-Loop (Handy gegen howispulse.com) ist das
# zu langsam. Dieses Skript kopiert die Dateien direkt in den laufenden
# Container — Sekunden statt Minuten.
#
# WICHTIG — was das hier NICHT ist:
#   Ein Hotfix läuft an Git, CI und den Images vorbei. Auf Prod läuft danach
#   Code, der in keinem Image steckt, und es ist die ECHTE Produktion mit echten
#   Nutzern — ein kaputter Build ist sofort live. Jede so getestete Änderung MUSS
#   hinterher regulär über einen PR landen, sonst ist sie beim nächsten echten
#   Deploy weg. Deshalb: immer im Git-Arbeitsverzeichnis editieren, nie auf dem
#   Server. `restore` holt jeden Container auf den Stand des GHCR-Images zurück.
#
# Der Cron-Updater (*/2) zieht nur *neue* Images und lässt unveränderte Container
# in Ruhe — ein Hotfix überlebt ihn normalerweise. Landet aber währenddessen ein
# Push auf main, wird der Container ersetzt und der Hotfix ist weg. Für die Dauer
# der Session deshalb: `cron-off` … testen … `cron-on`.
#
# Benutzung:
#   scripts/hotfix-prod.sh web            # web/ bauen + nach pulse_web (inkl. nginx.conf)
#   scripts/hotfix-prod.sh auth           # ein Python-Dienst (auch: chat voice media hook)
#   scripts/hotfix-prod.sh shared         # dcc_shared → ALLE Python-Dienste
#   scripts/hotfix-prod.sh py             # alle Python-Dienste auf einmal
#   scripts/hotfix-prod.sh restore web    # zurück aufs GHCR-Image (svc-Name | all)
#   scripts/hotfix-prod.sh cron-off|cron-on
#   scripts/hotfix-prod.sh status
set -euo pipefail

HOST="${PULSE_PROD_HOST:-michael@159.195.150.54}"
STAGING="/home/michael/pulse-hotfix"   # Ablage auf dem Server, außerhalb von ~/pulse
COMPOSE_DIR="/home/michael/pulse/infra/prod"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Kurzname → "Container|lokaler Pfad|Paketname|compose-Service".
# Alle Dienste sind als editable install verdrahtet (_editable_impl_*.pth zeigt
# auf /app/services/*/src), deshalb wirkt ein Copy dorthin. uvicorn läuft in
# Prod ohne --reload → Neustart ist Pflicht.
declare -A SERVICES=(
  [auth]="pulse_auth|services/auth/src/dcc_auth|dcc_auth|auth"
  [chat]="pulse_chat_gateway|services/chat-gateway/src/dcc_chat_gateway|dcc_chat_gateway|chat-gateway"
  [voice]="pulse_voice_signaling|services/voice-signaling/src/dcc_voice_signaling|dcc_voice_signaling|voice-signaling"
  [media]="pulse_media_svc|services/media-svc/src/dcc_media_svc|dcc_media_svc|media-svc"
  [hook]="pulse_mediamtx_auth_hook|services/mediamtx-auth-hook/src/dcc_mediamtx_auth_hook|dcc_mediamtx_auth_hook|mediamtx-auth-hook"
)
PY_ORDER=(auth chat voice media hook)

die() { echo "FEHLER: $*" >&2; exit 1; }
say() { echo "→ $*"; }
remote() { ssh -o BatchMode=yes "$HOST" "$@"; }

# rsync eines Verzeichnisses in die Server-Ablage.
stage() {  # stage <lokaler-pfad> <ablage-name>
  remote "mkdir -p $STAGING/$2"
  rsync -a --delete --exclude '__pycache__' -e "ssh -o BatchMode=yes" "$1/" "$HOST:$STAGING/$2/"
}

# --- web -------------------------------------------------------------------
# Statische Dateien; nginx liest sie beim nächsten Request. Der Copy überlagert,
# löscht also nichts: /self-host/* aus dem Image bleibt. Die nginx-Config kommt
# mit, weil Routing-Fehler (z.B. fehlende WS-Location) sonst nicht testbar sind
# — `nginx -t` VOR dem Reload, sonst legt eine kaputte Config die Seite lahm.
hotfix_web() {
  say "Baue web/ lokal (pnpm build)"
  (cd "$REPO/web" && pnpm build) || die "web-Build fehlgeschlagen — nichts angefasst"
  [[ -f "$REPO/web/build/index.html" ]] || die "web/build/index.html fehlt"

  say "Übertrage nach $HOST:$STAGING/web"
  stage "$REPO/web/build" web
  remote "docker cp $STAGING/web/. pulse_web:/usr/share/nginx/html/"

  say "nginx-Config prüfen + laden"
  scp -q -o BatchMode=yes "$REPO/infra/prod/web-nginx.conf" "$HOST:$STAGING/web-nginx.conf"
  remote "docker cp $STAGING/web-nginx.conf pulse_web:/etc/nginx/conf.d/default.conf \
          && docker exec pulse_web nginx -t >/dev/null 2>&1 \
          && docker exec pulse_web nginx -s reload" \
    || die "nginx-Config fehlerhaft — 'restore web' holt den letzten guten Stand"

  say "Fertig. Im Browser/Handy HART neu laden (Cache!)."
}

# --- Python-Dienste ---------------------------------------------------------
hotfix_service() {  # hotfix_service <kurzname>
  local key="$1"
  local spec="${SERVICES[$key]:-}"
  [[ -n "$spec" ]] || die "unbekannter Dienst '$key' (${!SERVICES[*]})"
  IFS='|' read -r container relpath pkg _ <<<"$spec"
  [[ -d "$REPO/$relpath" ]] || die "$REPO/$relpath nicht gefunden"

  say "$key → $container"
  stage "$REPO/$relpath" "$key"
  remote "docker cp $STAGING/$key/. $container:/app/$relpath/ && docker restart $container >/dev/null"
  await_health "$container" "$pkg"
}

# dcc_shared lebt in JEDEM Dienst-Image unter /app/shared/src — ein Copy pro
# Container, danach alle neu starten.
hotfix_shared() {
  say "dcc_shared → alle Python-Dienste"
  stage "$REPO/shared/src/dcc_shared" shared
  for key in "${PY_ORDER[@]}"; do
    IFS='|' read -r container _ pkg _ <<<"${SERVICES[$key]}"
    remote "docker cp $STAGING/shared/. $container:/app/shared/src/dcc_shared/ \
            && docker restart $container >/dev/null"
    await_health "$container" "$pkg"
  done
}

await_health() {  # await_health <container> <import-name>
  local container="$1" pkg="$2"
  for _ in $(seq 1 20); do
    if remote "docker exec $container python -c 'import $pkg' 2>/dev/null"; then
      say "$container ist oben."; return 0
    fi
    sleep 1
  done
  echo "WARNUNG: $container antwortet nicht — Logs:" >&2
  remote "docker logs --tail 30 $container" >&2
  return 1
}

# --- restore ---------------------------------------------------------------
# Ersetzt den Container durch das unveränderte GHCR-Image. --no-deps, weil sonst
# die depends_on-Kaskade halbe Neustarts auslöst (502 während des Deploys).
restore() {
  local target="${1:-}" services=""
  case "$target" in
    web) services="web" ;;
    all) services="web ${PY_ORDER[*]}"
         services="web $(for k in "${PY_ORDER[@]}"; do IFS='|' read -r _ _ _ c <<<"${SERVICES[$k]}"; printf '%s ' "$c"; done)" ;;
    "") die "restore braucht: web | ${!SERVICES[*]} | all" ;;
    *)  [[ -n "${SERVICES[$target]:-}" ]] || die "unbekannt: $target"
        IFS='|' read -r _ _ _ services <<<"${SERVICES[$target]}" ;;
  esac
  say "Hole '$services' zurück auf das GHCR-Image"
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
    echo '=== Container (Start-Zeit = wann zuletzt ersetzt/neugestartet) ==='
    docker ps --filter name=pulse_ --format '{{.Names}}\t{{.Status}}'
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
  shared)   hotfix_shared ;;
  py)       for k in "${PY_ORDER[@]}"; do hotfix_service "$k"; done ;;
  restore)  restore "${2:-}" ;;
  cron-off) cron_off ;;
  cron-on)  cron_on ;;
  status)   status ;;
  "")       sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 1 ;;
  *)        hotfix_service "$1" ;;
esac
