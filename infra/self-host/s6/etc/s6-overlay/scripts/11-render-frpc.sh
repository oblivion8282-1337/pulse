#!/bin/sh
# Rendert /etc/pulse/frpc.toml für den Steuerungs-Relay-Tunnel (App-Hosting, ②a).
#
# Aktiv nur, wenn alle drei PULSE_RELAY_*-Variablen gesetzt sind — VPS-Self-Hosts
# ohne Relay bleiben unberührt (der frpc-longrun schläft dann, coturn-Muster).
# Der Cloud-frps routet <slug>.relay.howispulse.com in diesen Tunnel; das
# relay-frps-plugin autorisiert Login/NewProxy über metadatas.token gegen
# auth-svc /selfhost/relay/auth. Ein einziger HTTP-Proxy reicht: der interne
# Caddy (behind-proxy, PULSE_HTTP_PORT) routet alle Pfade selbst.
#
# Der Token ist ein Secret — die gerenderte Datei wird NIE geloggt.
set -eu

CONF=/etc/pulse/frpc.toml

if [ -z "${PULSE_RELAY_SUBDOMAIN:-}" ] || [ -z "${PULSE_RELAY_SERVER_ADDR:-}" ] || [ -z "${PULSE_RELAY_TUNNEL_TOKEN:-}" ]; then
    rm -f "$CONF"
    echo "[frpc] kein Relay konfiguriert (PULSE_RELAY_* unset) — Tunnel bleibt aus"
    exit 0
fi

# Der Relay terminiert TLS → der Container MUSS im behind-proxy-Modus laufen,
# sonst lauscht Caddy auf 80/443 statt auf dem HTTP-Port, den frpc forwardet.
if [ "${PULSE_TLS_MODE:-auto}" != "behind-proxy" ]; then
    echo "[frpc] FEHLER: PULSE_RELAY_* gesetzt, aber PULSE_TLS_MODE='${PULSE_TLS_MODE:-auto}' — Relay-Betrieb braucht PULSE_TLS_MODE=behind-proxy" >&2
    exit 1
fi

HOST=${PULSE_RELAY_SERVER_ADDR%%:*}
PORT=${PULSE_RELAY_SERVER_ADDR##*:}
case "$PORT" in
    ''|*[!0-9]*) echo "[frpc] FEHLER: PULSE_RELAY_SERVER_ADDR muss 'host:port' sein (ist: '${PULSE_RELAY_SERVER_ADDR}')" >&2; exit 1 ;;
esac
if [ "$HOST" = "$PORT" ]; then
    echo "[frpc] FEHLER: PULSE_RELAY_SERVER_ADDR muss 'host:port' sein (ist: '${PULSE_RELAY_SERVER_ADDR}')" >&2
    exit 1
fi

SLUG=${PULSE_RELAY_SUBDOMAIN%%.*}
LOCAL_PORT="${PULSE_HTTP_PORT:-8080}"

umask 077
cat > "$CONF" <<EOF
serverAddr = "${HOST}"
serverPort = ${PORT}
user = "${PULSE_RELAY_SUBDOMAIN}"
metadatas.token = "${PULSE_RELAY_TUNNEL_TOKEN}"
# Bei Login-Fehler (Relay down, Token noch nicht aktiv) intern retryen statt
# exiten — sonst zehrt der Crash-Loop das restart-gate auf (5/60s → Container-Halt).
loginFailExit = false

[[proxies]]
name = "${SLUG}-http"
type = "http"
localPort = ${LOCAL_PORT}
subdomain = "${SLUG}"
metadatas.token = "${PULSE_RELAY_TUNNEL_TOKEN}"
EOF
chown pulse:pulse "$CONF"
echo "[frpc] Konfiguration gerendert (subdomain=${PULSE_RELAY_SUBDOMAIN}, localPort=${LOCAL_PORT})"
