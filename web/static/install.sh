#!/usr/bin/env bash
#
# Pulse Self-Host — One-command installer
# =======================================
#   curl -fsSL https://howispulse.com/install | PULSE_BOOTSTRAP_TOKEN=<TOKEN> bash
#
# Token bevorzugt per Env-Variable (argv wäre für jeden lokalen User in `ps`
# sichtbar, solange das Script läuft); `bash -s -- <TOKEN>` bleibt als
# Fallback unterstützt.
#
# Das Script erkennt die Umgebung selbst und richtet sich passend ein — auch
# wenn auf dem Server schon ein Reverse-Proxy läuft (User-Output ist Englisch,
# Kommentare bleiben Deutsch für die Wartung):
#
#   1. Auto-Discovery-Proxy (caddy-docker-proxy / Traefik / nginx-proxy) → der
#      Container hängt sich ins Proxy-Netz + setzt Labels/Env → automatisch.
#   2. Port 80 + 443 frei → Pulse terminiert HTTPS selbst (Let's Encrypt).
#   3. Statischer dockerisierter Proxy → Netz-Anbindung + eine Route ausgeben.
#   4. Reverse-Proxy außerhalb von Docker → Loopback-Port + Route ausgeben.
#
# Sicherheit: Bootstrap-Token wird beim Einlösen verbraucht, das Pairing-Secret
# serverseitig rotiert. --dry-run zeigt nur den Plan (kein Token-Verbrauch).
set -euo pipefail

# --- Konfiguration (per Env überschreibbar) --------------------------------
CLOUD_ORIGIN="${PULSE_CLOUD_ORIGIN:-https://howispulse.com}"
IMAGE="${PULSE_IMAGE:-ghcr.io/oblivion8282-1337/pulse-allinone:edge}"
CONTAINER="${PULSE_CONTAINER:-pulse}"
VOLUME="${PULSE_VOLUME:-pulse-data}"
# Config-Verzeichnis: root → /opt/pulse, sonst ins Home (Docker-Gruppen-User
# ohne root-FS-Zugriff). Per PULSE_DIR überschreibbar.
if [ -n "${PULSE_DIR:-}" ]; then
  :
elif [ "$(id -u)" = "0" ]; then
  PULSE_DIR="/opt/pulse"
else
  PULSE_DIR="${HOME:-/tmp}/.pulse"
fi
HTTP_PORT="${PULSE_HTTP_PORT:-8080}"
ENV_FILE="${PULSE_DIR}/pulse.env"
UPDATE_SH="${PULSE_DIR}/pulse-update.sh"
# Optionale harte Overrides:
#   PULSE_TLS_MODE = auto | behind-proxy ; PULSE_NETWORK = Docker-Netz
FORCE_TLS_MODE="${PULSE_TLS_MODE:-}"
FORCE_NETWORK="${PULSE_NETWORK:-}"

# --- Args ---------------------------------------------------------------- #
DRY_RUN=""
TOKEN=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --*) ;;                       # unbekannte Flags ignorieren
    *) [ -z "$TOKEN" ] && TOKEN="$arg" ;;
  esac
done
TOKEN="${TOKEN:-${PULSE_BOOTSTRAP_TOKEN:-}}"

# --- Ausgabe-Helfer --------------------------------------------------------
log()  { printf '\033[1;36m[pulse]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[pulse]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[pulse] ERROR:\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

[ -n "$TOKEN" ] || die "No bootstrap token provided.
  Usage: curl -fsSL ${CLOUD_ORIGIN}/install | PULSE_BOOTSTRAP_TOKEN=<TOKEN> bash
  Get a token in the Pulse app: Settings → Self-Host → Set up server."

# --- Docker prüfen ------------------------------------------------------- #
command -v docker >/dev/null 2>&1 \
  || die "Docker is not installed. → https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 \
  || die "Cannot reach the Docker daemon. Run this script as root (sudo) or start Docker."

# --- Helfer: Port belegt? ------------------------------------------------ #
port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
  else
    return 1   # kann nicht prüfen → als frei annehmen
  fi
}

# --- Helfer: erstes nicht-triviales Docker-Netz eines Containers --------- #
first_user_network() {
  docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$1" 2>/dev/null \
    | grep -vE '^(host|none|bridge|)$' | head -1
}

# --- Helfer: Traefik-certresolver von vorhandenen Containern erben ------- #
detect_traefik_certresolver() {
  docker ps -q 2>/dev/null | while read -r id; do
    docker inspect -f '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}' "$id" 2>/dev/null
  done | grep -oE 'certresolver=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2
}

# --- Reverse-Proxy erkennen --------------------------------------------- #
# Setzt: PROXY_KIND (none|caddy-docker-proxy|traefik|nginx-proxy|static-caddy|
#        static-nginx), PROXY_CONTAINER, PROXY_NET
PROXY_KIND=none; PROXY_CONTAINER=""; PROXY_NET=""
_set_proxy() { PROXY_CONTAINER="$1"; PROXY_KIND="$2"; PROXY_NET="$(first_user_network "$1")"; }

detect_proxy() {
  local name image
  # 1) Auto-Discovery-Proxies (höchste Priorität)
  while IFS=$'\t' read -r name image; do
    case "$image" in
      *caddy-docker-proxy*) _set_proxy "$name" caddy-docker-proxy; return ;;
    esac
  done < <(docker ps --format '{{.Names}}'$'\t''{{.Image}}' 2>/dev/null)
  while IFS=$'\t' read -r name image; do
    case "$image" in
      *traefik*)                              _set_proxy "$name" traefik;     return ;;
      *nginxproxy/nginx-proxy*|*jwilder/nginx-proxy*) _set_proxy "$name" nginx-proxy; return ;;
    esac
  done < <(docker ps --format '{{.Names}}'$'\t''{{.Image}}' 2>/dev/null)
  # 2) Statische dockerisierte Proxies — nur relevant, wenn 80/443 belegt
  if port_busy 80 || port_busy 443; then
    while IFS=$'\t' read -r name image; do
      case "$image" in
        *caddy*) _set_proxy "$name" static-caddy; return ;;
        *nginx*) _set_proxy "$name" static-nginx; return ;;
        *traefik*) _set_proxy "$name" traefik; return ;;
      esac
    done < <(docker ps --format '{{.Names}}'$'\t''{{.Image}}' 2>/dev/null)
  fi
}

# --- Modus festlegen ----------------------------------------------------- #
# MODE: greenfield | discovery | static-docker | hostproxy
decide_mode() {
  detect_proxy
  case "$PROXY_KIND" in
    caddy-docker-proxy|traefik|nginx-proxy)
      if [ -n "$PROXY_NET" ]; then MODE=discovery
      else warn "Proxy '${PROXY_CONTAINER}' is only on the default bridge — cannot auto-wire, using loopback."; MODE=hostproxy; fi ;;
    static-caddy|static-nginx)
      if [ -n "$PROXY_NET" ]; then MODE=static-docker; else MODE=hostproxy; fi ;;
    none)
      if port_busy 80 || port_busy 443; then MODE=hostproxy; else MODE=greenfield; fi ;;
  esac
  # Harte Overrides
  if [ "$FORCE_TLS_MODE" = "auto" ]; then MODE=greenfield; fi
  if [ -n "$FORCE_NETWORK" ]; then
    PROXY_NET="$FORCE_NETWORK"
    if [ "$MODE" = "greenfield" ]; then MODE=static-docker; fi
  fi
  return 0   # nie über den Exit-Status der letzten Bedingung stolpern (set -e)
}

# --- docker-run-Argumente nach Modus zusammenbauen ---------------------- #
build_run_args() {
  RUN_ARGS=( -d --name "$CONTAINER" --restart unless-stopped
             --env-file "$ENV_FILE" -v "${VOLUME}:/data" )
  # Voice/HQ-Ports immer (Mirror infra/self-host/docker-compose.yml):
  # LiveKit-WebRTC, TURN, RTMPS-Ingest + MediaMTX-WHEP-ICE (8189/udp —
  # ohne den kommt die HQ-Stream-Wiedergabe nicht über den ICE-Handshake).
  RUN_ARGS+=( -p 7882-7892:7882-7892/udp -p 3478:3478/tcp -p 3478:3478/udp
              -p 1936:1936/tcp -p 8189:8189/udp )

  case "$MODE" in
    greenfield)
      TLS_MODE=auto
      RUN_ARGS+=( -p 80:80 -p 443:443 ) ;;
    discovery)
      TLS_MODE=behind-proxy
      RUN_ARGS+=( --network "$PROXY_NET" )
      case "$PROXY_KIND" in
        caddy-docker-proxy)
          RUN_ARGS+=( --label "caddy=${SRV_HOST}"
                      --label "caddy.reverse_proxy={{upstreams ${HTTP_PORT}}}" ) ;;
        traefik)
          local r="pulse-${SRV_HOST}"
          RUN_ARGS+=( --label "traefik.enable=true"
                      --label "traefik.http.routers.${r}.rule=Host(\`${SRV_HOST}\`)"
                      --label "traefik.http.routers.${r}.entrypoints=websecure"
                      --label "traefik.http.routers.${r}.tls=true"
                      --label "traefik.http.services.${r}.loadbalancer.server.port=${HTTP_PORT}" )
          local cr; cr="$(detect_traefik_certresolver || true)"
          [ -n "$cr" ] && RUN_ARGS+=( --label "traefik.http.routers.${r}.tls.certresolver=${cr}" ) || true ;;
        nginx-proxy)
          RUN_ARGS+=( -e "VIRTUAL_HOST=${SRV_HOST}" -e "VIRTUAL_PORT=${HTTP_PORT}" )
          if docker ps --format '{{.Image}}' 2>/dev/null | grep -qiE 'acme-companion|nginx-proxy-companion'; then
            RUN_ARGS+=( -e "LETSENCRYPT_HOST=${SRV_HOST}" -e "LETSENCRYPT_EMAIL=${ADMIN_EMAIL}" )
          fi ;;
      esac ;;
    static-docker)
      TLS_MODE=behind-proxy
      RUN_ARGS+=( --network "$PROXY_NET" ) ;;
    hostproxy)
      TLS_MODE=behind-proxy
      RUN_ARGS+=( -p "127.0.0.1:${HTTP_PORT}:${HTTP_PORT}" ) ;;
  esac
  RUN_ARGS+=( "$IMAGE" )
}

# --- Plan ausgeben ------------------------------------------------------- #
print_plan() {
  log "Detected mode: ${MODE}${PROXY_KIND:+  (proxy: ${PROXY_KIND}${PROXY_CONTAINER:+ → ${PROXY_CONTAINER}}${PROXY_NET:+, network ${PROXY_NET}})}"
  case "$MODE" in
    greenfield)    log "→ Pulse binds 80/443 and obtains its own Let's Encrypt certificate." ;;
    discovery)     log "→ Pulse joins '${PROXY_NET}'; the proxy picks it up automatically. No manual step." ;;
    static-docker) log "→ Pulse joins '${PROXY_NET}', reachable as '${CONTAINER}:${HTTP_PORT}'. One route needed (see below)." ;;
    hostproxy)     log "→ Pulse listens on 127.0.0.1:${HTTP_PORT}. One route in your proxy needed (see below)." ;;
  esac
}

# --- JSON-Feld auslesen (python3 bevorzugt, sonst grep/sed) -------------- #
# Newlines werden hart entfernt: die Werte landen zeilenweise in der .env.
jget() {
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('$2',''))" | tr -d '\r\n'
  else
    printf '%s' "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 \
      | sed 's/.*:[[:space:]]*"//; s/"$//' | tr -d '\r\n'
  fi
}

# --- Host-Updater: Skript generieren (ersetzt Watchtower) --------------- #
# Statt eines dauerlaufenden Fremd-Containers mit Docker-Socket (= Root auf
# dem Host) schreibt der Installer ein kleines, lesbares Skript auf den Host
# und lässt es per systemd-Timer laufen. KEIN Container hält den Socket; der
# Update-Code führt nur fest verdrahtete Befehle aus, nimmt keine Anweisungen
# aus dem Image entgegen. Die exakten docker-run-Argumente werden quoting-sicher
# ins Skript eingebacken, damit der Container identisch neu erstellt wird.
write_update_script() {
  mkdir -p "$PULSE_DIR"
  {
    cat <<'HEADER'
#!/usr/bin/env bash
# Pulse self-host updater — generated by the installer, replaces Watchtower.
# Pulls the configured image; if its digest changed, recreates the container
# with the exact same run arguments. Run by systemd timer 'pulse-update' or
# manually. Edit nothing here — re-run the installer to regenerate.
set -euo pipefail
HEADER
    printf 'IMAGE=%q\n' "$IMAGE"
    printf 'CONTAINER=%q\n' "$CONTAINER"
    printf 'RUN_ARGS=('
    printf '%q ' "${RUN_ARGS[@]}"
    printf ')\n'
    cat <<'BODY'

docker pull "$IMAGE" >/dev/null 2>&1 \
  || { echo "pulse-update: pull failed (network/registry?), will retry next run" >&2; exit 0; }
new_id="$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
cur_id="$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
[ -n "$new_id" ] || { echo "pulse-update: cannot read image id, skipping" >&2; exit 0; }
[ "$new_id" = "$cur_id" ] && exit 0   # already up to date

echo "pulse-update: updating $CONTAINER -> $new_id"
# Alten Container beiseitestellen statt sofort löschen → Rollback bei Fehlstart.
# Single-Container mit festen Ports: der alte MUSS vor dem neuen gestoppt werden
# (kurze Downtime unvermeidbar), aber er bleibt als '<name>-old' erhalten, bis
# der neue nachweislich läuft.
docker rm -f "${CONTAINER}-old" >/dev/null 2>&1 || true   # Rest eines früheren Fehlversuchs
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  docker rename "$CONTAINER" "${CONTAINER}-old" >/dev/null 2>&1 || true
  docker stop "${CONTAINER}-old" >/dev/null 2>&1 || true
fi
if docker run "${RUN_ARGS[@]}" >/dev/null; then
  docker rm -f "${CONTAINER}-old" >/dev/null 2>&1 || true
  # Nur das vorige Pulse-Image entfernen — kein host-weites 'image prune'.
  { [ -n "$cur_id" ] && [ "$cur_id" != "$new_id" ] && docker image rm "$cur_id" >/dev/null 2>&1; } || true
  echo "pulse-update: done"
else
  echo "pulse-update: new container failed to start — rolling back" >&2
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if docker inspect "${CONTAINER}-old" >/dev/null 2>&1; then
    docker rename "${CONTAINER}-old" "$CONTAINER" >/dev/null 2>&1 || true
    docker start "$CONTAINER" >/dev/null 2>&1 || true
  fi
  exit 1
fi
BODY
  } > "$UPDATE_SH"
  chmod 700 "$UPDATE_SH"
}

# --- Host-Updater: systemd-Timer installieren --------------------------- #
install_update_timer() {
  cat > /etc/systemd/system/pulse-update.service <<EOF
[Unit]
Description=Pulse self-host auto-update
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=${UPDATE_SH}
EOF
  cat > /etc/systemd/system/pulse-update.timer <<'EOF'
[Unit]
Description=Pulse self-host auto-update (every 5 min)

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now pulse-update.timer >/dev/null 2>&1
}

# --- Host-Updater: User-Crontab (Fallback ohne root/systemd) ------------- #
# Ein docker-group-User (non-root) kann keinen System-Timer schreiben, aber
# seine eigene Crontab — die läuft sudo-frei und unabhängig vom Login. So
# bleibt Auto-Update auch beim non-root-Install erhalten (der alte Watchtower
# lief als Container ebenfalls non-root — ohne Fallback wäre das ein Regress).
install_update_cron() {
  local entry="*/5 * * * * ${UPDATE_SH} >> ${PULSE_DIR}/pulse-update.log 2>&1"
  # Bestehenden Eintrag für unser Skript ersetzen (idempotent), Rest behalten.
  { crontab -l 2>/dev/null | grep -vF "$UPDATE_SH"; echo "$entry"; } | crontab -
}

# ======================================================================== #
# Ablauf
# ======================================================================== #

# 1) Umgebung erkennen + Modus wählen (braucht KEINEN Token).
SRV_HOST="<hostname>"; ADMIN_EMAIL=""    # Platzhalter für die Dry-Run-Vorschau
decide_mode
build_run_args
print_plan

if [ -n "$DRY_RUN" ]; then
  echo
  log "DRY RUN — nothing changed, no token consumed."
  log "Planned container start:"
  printf '    docker run'; printf ' %q' "${RUN_ARGS[@]}"; echo
  exit 0
fi

# 2) Token einlösen (verbraucht ihn, rotiert das Secret).
log "Redeeming bootstrap token at ${CLOUD_ORIGIN}…"
RESP="$(curl -fsSL -X POST "${CLOUD_ORIGIN}/api/auth/selfhost/bootstrap" \
        -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json')" \
  || die "Token redemption failed — expired or already used?
  Generate a fresh command in the Pulse app (Set up server → regenerate)."

INSTANCE_ID="$(jget "$RESP" instance_id)"
OWNER_ID="$(jget "$RESP" owner_user_id)"
SRV_HOST="$(jget "$RESP" hostname)"
CLIENT_ID="$(jget "$RESP" client_id)"
CLIENT_SECRET="$(jget "$RESP" client_secret)"
ADMIN_EMAIL="$(jget "$RESP" admin_email)"
RESP_ORIGIN="$(jget "$RESP" cloud_origin)"
[ -n "$RESP_ORIGIN" ] && CLOUD_ORIGIN="$RESP_ORIGIN" || true
[ -n "$INSTANCE_ID" ] && [ -n "$CLIENT_SECRET" ] && [ -n "$SRV_HOST" ] \
  || die "Unexpected response from the cloud — aborting."
log "Instance: ${SRV_HOST} (ID ${INSTANCE_ID})"

# Hostname steht jetzt fest → Run-Args neu bauen (Labels brauchen ihn).
build_run_args

# 3) Config schreiben (chmod 600).
mkdir -p "$PULSE_DIR"
( umask 077
  cat > "$ENV_FILE" <<EOF
PULSE_HOSTNAME=${SRV_HOST}
PULSE_INSTANCE_ID=${INSTANCE_ID}
PULSE_INSTANCE_OWNER_ID=${OWNER_ID}
PULSE_INSTANCE_MODE=self-host
PULSE_CLOUD_ORIGIN=${CLOUD_ORIGIN}
PULSE_CLOUD_CLIENT_ID=${CLIENT_ID}
PULSE_CLOUD_CLIENT_SECRET=${CLIENT_SECRET}
PULSE_ADMIN_EMAIL=${ADMIN_EMAIL}
PULSE_TLS_MODE=${TLS_MODE}
PULSE_HTTP_PORT=${HTTP_PORT}
EOF
)
chmod 600 "$ENV_FILE"
log "Configuration written: ${ENV_FILE} (readable by root only)"

# 4) Container starten.
log "Pulling image ${IMAGE}…"
docker pull "$IMAGE"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
log "Starting Pulse (${MODE})…"
docker run "${RUN_ARGS[@]}" >/dev/null

# 5) Auto-Update — Host-systemd-Timer statt eines socket-haltenden Containers.
# Kein Container braucht den Docker-Socket; der Update-Code ist das oben
# generierte, lesbare Skript. PULSE_NO_AUTOUPDATE=1 schaltet es ab
# (PULSE_NO_WATCHTOWER bleibt als Alias erhalten).
# Migration: einen früher angelegten Watchtower-Container ablösen.
docker rm -f pulse-watchtower >/dev/null 2>&1 || true
if [ -z "${PULSE_NO_AUTOUPDATE:-${PULSE_NO_WATCHTOWER:-}}" ]; then
  write_update_script
  log "Update helper written: ${UPDATE_SH}"
  if [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    install_update_timer
    log "Auto-updates enabled (systemd timer 'pulse-update.timer', checks every 5 min)."
  elif command -v crontab >/dev/null 2>&1; then
    install_update_cron
    log "Auto-updates enabled (user crontab, checks every 5 min). 'crontab -l' to view."
  else
    warn "No root+systemd and no crontab — auto-update could not be scheduled."
    warn "Update manually anytime:   ${UPDATE_SH}"
  fi
fi

# 6) Health-Check.
log "Waiting for startup (migrations + TLS, may take ~1 min)…"
case "$MODE" in
  hostproxy) HEALTH_URL="http://127.0.0.1:${HTTP_PORT}/api/chat/health" ;;
  *)         HEALTH_URL="https://${SRV_HOST}/api/chat/health" ;;
esac
OK=""
for _ in $(seq 1 60); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then OK=1; break; fi
  sleep 5
done

echo
if [ -n "$OK" ]; then
  log "Pulse is running → https://${SRV_HOST}"
else
  warn "Health check not green yet — the container may still be starting. Check:"
  warn "  docker logs -f ${CONTAINER}"
  [ "$MODE" = "greenfield" ] && warn "For 'greenfield': does the DNS A record for ${SRV_HOST} already point to this server? (Let's Encrypt needs it)" || true
fi

# 7) Falls eine Route nötig ist, sie + den Reload-Befehl konkret ausgeben.
if [ "$MODE" = "static-docker" ] || [ "$MODE" = "hostproxy" ]; then
  if [ "$MODE" = "static-docker" ]; then TARGET="${CONTAINER}:${HTTP_PORT}"; else TARGET="127.0.0.1:${HTTP_PORT}"; fi
  # Reload-Befehl nach erkanntem Proxy (bei dockerisiertem statischem Proxy
  # kennen wir den Container-Namen → konkreter Befehl).
  case "$PROXY_KIND" in
    static-caddy) RELOAD_CMD="docker exec ${PROXY_CONTAINER} caddy reload --config /etc/caddy/Caddyfile" ;;
    static-nginx) RELOAD_CMD="docker exec ${PROXY_CONTAINER} nginx -s reload" ;;
    *)            RELOAD_CMD="# reload your reverse proxy, e.g.:  sudo systemctl reload caddy   (or: nginx -s reload)" ;;
  esac
  cat <<EOF

  ----------------------------------------------------------------
  Last step — ONE route in your existing reverse proxy.
  (If a route for ${SRV_HOST} already exists, just point it at http://${TARGET}.)

  Caddy — add to your Caddyfile:
      ${SRV_HOST} {
          reverse_proxy ${TARGET}
      }
  nginx — inside the server block (WebSockets must pass through):
      location / {
          proxy_pass http://${TARGET};
          proxy_http_version 1.1;
          proxy_set_header Upgrade \$http_upgrade;
          proxy_set_header Connection "upgrade";
          proxy_set_header Host \$host;
      }

  Then reload the proxy:
      ${RELOAD_CMD}
  ----------------------------------------------------------------
EOF
fi

log "Done."
