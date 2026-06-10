#!/usr/bin/env bash
#
# Pulse Self-Host — Ein-Befehl-Installer
# =====================================
#   curl -fsSL https://howispulse.com/install | bash -s -- <TOKEN>
#
# Das Script erkennt deine Umgebung selbst und richtet sich passend ein —
# auch wenn auf dem Server schon ein Reverse-Proxy läuft:
#
#   1. Auto-Discovery-Proxy (caddy-docker-proxy / Traefik / nginx-proxy) gefunden
#      → Pulse hängt sich in dessen Netz + setzt die passenden Labels/Env →
#        der Proxy nimmt Pulse automatisch auf. Keine Handarbeit.
#   2. Port 80 + 443 frei → Pulse terminiert HTTPS selbst (Let's Encrypt).
#   3. Statischer dockerisierter Proxy (festes Caddyfile/nginx.conf) → Pulse
#      hängt sich in dessen Netz (per Container-Name erreichbar) und gibt die
#      EINE Route aus, die du einfügst.
#   4. Reverse-Proxy außerhalb von Docker → Loopback-Port + Route-Snippet.
#
# Sicherheit: der Bootstrap-Token wird beim Einlösen verbraucht und das
# Pairing-Secret serverseitig rotiert. --dry-run zeigt nur den Plan (ohne
# Token-Verbrauch, ohne Änderung). Inspizieren erwünscht — genau diese Datei
# wird unter /install ausgeliefert.
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
# Optionale harte Overrides (Auto-Detect übergehen):
#   PULSE_TLS_MODE = auto | behind-proxy
#   PULSE_NETWORK  = Docker-Netz, in das der Container gehängt wird
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
err()  { printf '\033[1;31m[pulse] FEHLER:\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

[ -n "$TOKEN" ] || die "Kein Bootstrap-Token übergeben.
  Aufruf: curl -fsSL ${CLOUD_ORIGIN}/install | bash -s -- <TOKEN>
  Token holst du in der Pulse-App: Einstellungen → Self-Host → Server einrichten."

# --- Docker prüfen ------------------------------------------------------- #
command -v docker >/dev/null 2>&1 \
  || die "Docker ist nicht installiert. → https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 \
  || die "Docker-Daemon nicht erreichbar. Führe das Script als root aus (sudo) oder starte Docker."

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
    docker inspect -f '{{range $k,$v := .Config.Labels}}{{$v}}{{"\n"}}{{end}}' "$id" 2>/dev/null
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
      else warn "Proxy '${PROXY_CONTAINER}' nur im Default-Bridge — Auto-Wire nicht möglich, nutze Loopback."; MODE=hostproxy; fi ;;
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
  # Voice/HQ-Ports immer (Mirror infra/self-host/docker-compose.yml)
  RUN_ARGS+=( -p 7882-7892:7882-7892/udp -p 3478:3478/tcp -p 3478:3478/udp -p 1936:1936/tcp )

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
  log "Erkannter Modus: ${MODE}${PROXY_KIND:+  (Proxy: ${PROXY_KIND}${PROXY_CONTAINER:+ → ${PROXY_CONTAINER}}${PROXY_NET:+, Netz ${PROXY_NET}})}"
  case "$MODE" in
    greenfield)    log "→ Pulse belegt 80/443 und holt sich selbst ein Let's-Encrypt-Zertifikat." ;;
    discovery)     log "→ Pulse hängt in '${PROXY_NET}', der Proxy nimmt es automatisch auf. Kein Handgriff nötig." ;;
    static-docker) log "→ Pulse hängt in '${PROXY_NET}', erreichbar als '${CONTAINER}:${HTTP_PORT}'. Eine Route nötig (s.u.)." ;;
    hostproxy)     log "→ Pulse lauscht auf 127.0.0.1:${HTTP_PORT}. Eine Route in deinem Proxy nötig (s.u.)." ;;
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
  log "DRY-RUN — es wird nichts geändert und kein Token verbraucht."
  log "Geplanter Container-Start:"
  printf '    docker run'; printf ' %q' "${RUN_ARGS[@]}"; echo
  exit 0
fi

# 2) Token einlösen (verbraucht ihn, rotiert das Secret).
log "Löse Bootstrap-Token bei ${CLOUD_ORIGIN} ein…"
RESP="$(curl -fsSL -X POST "${CLOUD_ORIGIN}/api/auth/selfhost/bootstrap" \
        -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json')" \
  || die "Token-Einlösung fehlgeschlagen — abgelaufen oder schon verbraucht?
  Generiere in der Pulse-App einen frischen Befehl (Server einrichten → neu generieren)."

INSTANCE_ID="$(jget "$RESP" instance_id)"
OWNER_ID="$(jget "$RESP" owner_user_id)"
SRV_HOST="$(jget "$RESP" hostname)"
CLIENT_ID="$(jget "$RESP" client_id)"
CLIENT_SECRET="$(jget "$RESP" client_secret)"
ADMIN_EMAIL="$(jget "$RESP" admin_email)"
RESP_ORIGIN="$(jget "$RESP" cloud_origin)"
[ -n "$RESP_ORIGIN" ] && CLOUD_ORIGIN="$RESP_ORIGIN" || true
[ -n "$INSTANCE_ID" ] && [ -n "$CLIENT_SECRET" ] && [ -n "$SRV_HOST" ] \
  || die "Unerwartete Antwort von der Cloud — Abbruch."
log "Instanz: ${SRV_HOST} (ID ${INSTANCE_ID})"

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
log "Konfiguration geschrieben: ${ENV_FILE} (nur für root lesbar)"

# 4) Container starten.
log "Ziehe Image ${IMAGE}…"
docker pull "$IMAGE"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
log "Starte Pulse (${MODE})…"
docker run "${RUN_ARGS[@]}" >/dev/null

# 5) Auto-Update (watchtower) — nur Pulse-Container, optional abschaltbar.
if [ -z "${PULSE_NO_WATCHTOWER:-}" ] \
   && ! docker ps -a --format '{{.Names}}' | grep -q '^pulse-watchtower$'; then
  log "Richte Auto-Update ein (watchtower, nur Pulse-Container)…"
  docker run -d --name pulse-watchtower --restart unless-stopped \
    -v /var/run/docker.sock:/var/run/docker.sock \
    ghcr.io/nicholas-fedor/watchtower:latest \
    --label-enable --scope pulse --interval 300 --cleanup >/dev/null 2>&1 || true
fi

# 6) Health-Check.
log "Warte auf Startup (Migrationen + TLS, kann ~1 Min dauern)…"
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
  log "Pulse läuft → https://${SRV_HOST}"
else
  warn "Health-Check noch nicht grün — der Container startet evtl. noch. Prüfe:"
  warn "  docker logs -f ${CONTAINER}"
  [ "$MODE" = "greenfield" ] && warn "Bei 'greenfield': zeigt der DNS-A-Record von ${SRV_HOST} schon auf diesen Server?" || true
fi

# 7) Falls eine Route nötig ist, sie konkret ausgeben.
if [ "$MODE" = "static-docker" ] || [ "$MODE" = "hostproxy" ]; then
  if [ "$MODE" = "static-docker" ]; then TARGET="${CONTAINER}:${HTTP_PORT}"; else TARGET="127.0.0.1:${HTTP_PORT}"; fi
  cat <<EOF

  ----------------------------------------------------------------
  Letzter Schritt — EINE Route in deinem vorhandenen Proxy:

      ${SRV_HOST}  ->  http://${TARGET}

  WebSockets durchreichen! Caddy:
      ${SRV_HOST} {
          reverse_proxy ${TARGET}
      }
  nginx (im server-Block):
      location / {
          proxy_pass http://${TARGET};
          proxy_http_version 1.1;
          proxy_set_header Upgrade \$http_upgrade;
          proxy_set_header Connection "upgrade";
          proxy_set_header Host \$host;
      }
  ----------------------------------------------------------------
EOF
fi

log "Fertig."
