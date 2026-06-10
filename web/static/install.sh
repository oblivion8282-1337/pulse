#!/usr/bin/env bash
#
# Pulse Self-Host — Ein-Befehl-Installer
# =====================================
# Aufruf (Token kommt aus der Pulse-App → Meine Instanzen → Server einrichten):
#
#     curl -fsSL https://howispulse.com/install | bash -s -- <TOKEN>
#
# Was das Script macht:
#   1. Löst den einmaligen Bootstrap-Token gegen die Cloud ein (holt Instanz-ID,
#      Hostname, Pairing-Credentials — der Token ist danach verbraucht).
#   2. Erkennt automatisch, ob Port 80/443 frei sind → TLS selbst (Let's Encrypt)
#      oder hinter deinem vorhandenen Reverse-Proxy.
#   3. Schreibt die Config (chmod 600), startet den Pulse-Container + Auto-Update.
#
# Keine Geheimnisse im Klartext in der URL: der Token wird beim Einlösen
# verbraucht und das Pairing-Secret frisch rotiert. Inspizieren erwünscht —
# das ist genau die Datei, die unter /install ausgeliefert wird.
set -euo pipefail

# --- Konfiguration (per Env überschreibbar) --------------------------------
CLOUD_ORIGIN="${PULSE_CLOUD_ORIGIN:-https://howispulse.com}"
IMAGE="${PULSE_IMAGE:-ghcr.io/oblivion8282-1337/pulse-allinone:edge}"
CONTAINER="${PULSE_CONTAINER:-pulse}"
VOLUME="${PULSE_VOLUME:-pulse-data}"
PULSE_DIR="${PULSE_DIR:-/opt/pulse}"
HTTP_PORT="${PULSE_HTTP_PORT:-8080}"

# --- Ausgabe-Helfer --------------------------------------------------------
log() { printf '\033[1;36m[pulse]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[pulse] FEHLER:\033[0m %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

# --- Token --------------------------------------------------------------- #
TOKEN="${1:-${PULSE_BOOTSTRAP_TOKEN:-}}"
[ -n "$TOKEN" ] || die "Kein Bootstrap-Token übergeben.
  Aufruf: curl -fsSL ${CLOUD_ORIGIN}/install | bash -s -- <TOKEN>
  Token holst du in der Pulse-App: Einstellungen → Self-Host → Server einrichten."

# --- Docker prüfen ------------------------------------------------------- #
command -v docker >/dev/null 2>&1 \
  || die "Docker ist nicht installiert. → https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 \
  || die "Docker-Daemon nicht erreichbar. Führe das Script als root aus (sudo) oder starte Docker."

# --- JSON-Feld auslesen (python3 bevorzugt, sonst grep/sed-Fallback) ----- #
# Newlines/CR werden hart entfernt: die Werte landen zeilenweise in der .env —
# ein eingeschleuster Zeilenumbruch im Cloud-Response könnte sonst eine extra
# Env-Zeile fabrizieren (Defense-in-Depth gegen eine manipulierte Antwort).
jget() {
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$1" \
      | python3 -c "import sys,json;print(json.load(sys.stdin).get('$2',''))" \
      | tr -d '\r\n'
  else
    printf '%s' "$1" \
      | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
      | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//' | tr -d '\r\n'
  fi
}

# --- Token einlösen ------------------------------------------------------ #
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
[ -n "$RESP_ORIGIN" ] && CLOUD_ORIGIN="$RESP_ORIGIN"

[ -n "$INSTANCE_ID" ] && [ -n "$CLIENT_SECRET" ] && [ -n "$SRV_HOST" ] \
  || die "Unerwartete Antwort von der Cloud — Abbruch."
log "Instanz: ${SRV_HOST} (ID ${INSTANCE_ID})"

# --- TLS-Modus automatisch erkennen -------------------------------------- #
port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
  else
    return 1  # kann nicht prüfen → als frei annehmen
  fi
}
TLS_MODE="${PULSE_TLS_MODE:-}"
if [ -z "$TLS_MODE" ]; then
  if port_busy 80 || port_busy 443; then
    TLS_MODE=behind-proxy
    log "Port 80/443 belegt → TLS-Modus 'behind-proxy' (dein vorhandener Reverse-Proxy macht HTTPS)."
  else
    TLS_MODE=auto
    log "Port 80/443 frei → TLS-Modus 'auto' (Container holt Let's-Encrypt-Zertifikat selbst)."
  fi
fi

# --- Config schreiben ---------------------------------------------------- #
mkdir -p "$PULSE_DIR"
ENV_FILE="${PULSE_DIR}/pulse.env"
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

# --- Port-Mapping -------------------------------------------------------- #
# Mirror von infra/self-host/docker-compose.yml.
PORTS=( -p 7882-7892:7882-7892/udp -p 3478:3478/tcp -p 3478:3478/udp -p 1936:1936/tcp )
if [ "$TLS_MODE" = "behind-proxy" ]; then
  # Nur auf Loopback exponieren — der Host-Reverse-Proxy terminiert TLS.
  PORTS+=( -p "127.0.0.1:${HTTP_PORT}:${HTTP_PORT}" )
else
  PORTS+=( -p 80:80 -p 443:443 )
fi

# --- Container starten --------------------------------------------------- #
log "Ziehe Image ${IMAGE}…"
docker pull "$IMAGE"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
log "Starte Pulse…"
docker run -d --name "$CONTAINER" --restart unless-stopped \
  --env-file "$ENV_FILE" \
  -v "${VOLUME}:/data" \
  "${PORTS[@]}" \
  "$IMAGE" >/dev/null

# --- Auto-Update (watchtower) ------------------------------------------- #
if [ -z "${PULSE_NO_WATCHTOWER:-}" ] \
   && ! docker ps -a --format '{{.Names}}' | grep -q '^pulse-watchtower$'; then
  log "Richte Auto-Update ein (watchtower, nur Pulse-Container)…"
  docker run -d --name pulse-watchtower --restart unless-stopped \
    -v /var/run/docker.sock:/var/run/docker.sock \
    ghcr.io/nicholas-fedor/watchtower:latest \
    --label-enable --scope pulse --interval 300 --cleanup >/dev/null 2>&1 || true
fi

# --- Health-Check -------------------------------------------------------- #
log "Warte auf Startup (Migrationen + TLS-Zertifikat, kann ~1 Min dauern)…"
if [ "$TLS_MODE" = "behind-proxy" ]; then
  HEALTH_URL="http://127.0.0.1:${HTTP_PORT}/api/chat/health"
else
  HEALTH_URL="https://${SRV_HOST}/api/chat/health"
fi
OK=""
for _ in $(seq 1 60); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then OK=1; break; fi
  sleep 5
done

echo
if [ -n "$OK" ]; then
  log "Pulse läuft → https://${SRV_HOST}"
else
  err "Health-Check noch nicht grün. Der Container läuft evtl. noch — prüfe:"
  err "  docker logs -f ${CONTAINER}"
  if [ "$TLS_MODE" = "auto" ]; then
    err "Bei 'auto': zeigt der DNS-A-Record von ${SRV_HOST} schon auf diesen Server? (Let's Encrypt braucht das)"
  fi
fi

# --- behind-proxy: nötige Proxy-Regel zeigen ----------------------------- #
if [ "$TLS_MODE" = "behind-proxy" ]; then
  cat <<EOF

  ----------------------------------------------------------------
  Letzter Schritt — deinen Reverse-Proxy auf Pulse zeigen lassen:

      ${SRV_HOST}  ->  http://127.0.0.1:${HTTP_PORT}

  WebSockets durchreichen! Caddy-Beispiel:

      ${SRV_HOST} {
          reverse_proxy 127.0.0.1:${HTTP_PORT}
      }

  (Läuft dein Proxy selbst in Docker, hänge ihn ins selbe Netz wie
   '${CONTAINER}' und proxye auf '${CONTAINER}:${HTTP_PORT}'.)
  ----------------------------------------------------------------
EOF
fi

log "Fertig."
