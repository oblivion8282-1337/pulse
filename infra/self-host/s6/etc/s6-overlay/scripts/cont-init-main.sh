#!/bin/sh
# cont-init main entry — runs the numbered scripts in order. Anything that
# exits non-zero aborts the boot (s6-overlay treats the oneshot as failed),
# which lets `S6_BEHAVIOUR_IF_STAGE2_FAILS=2` terminate the container cleanly
# rather than spinning on broken state.
#
# Jeder Schritt wird zusätzlich in /data/setup-status protokolliert. Der
# chat-gateway macht daraus `GET /health/setup`, und der Installer druckt
# daraus eine mitlaufende Checkliste, statt fünf Minuten stumm zu warten.
# Ohne das steht ein hängender oder abgebrochener Erststart NUR im
# `docker logs` — dort, wo niemand nachsieht, der gerade zum ersten Mal
# einen Server aufsetzt.
set -eu
SCRIPT_DIR=/etc/s6-overlay/scripts
STATUS="${PULSE_DATA_PATH:-/data}/setup-status"

# Zeilenformat statt JSON, mit Absicht: JSON aus der Shell zu bauen heisst,
# jedes Anführungszeichen von Hand zu behandeln, und ein kaputter Status wäre
# schlimmer als gar keiner. Der Gateway macht daraus JSON.
#   <epoche>\t<name>\t<ok|fehler>
: > "$STATUS" 2>/dev/null || STATUS=/dev/null

merke() {
    printf '%s\t%s\t%s\n' "$(date +%s)" "$1" "$2" >> "$STATUS" 2>/dev/null || true
}

lauf() {
    name="$1"
    if "${SCRIPT_DIR}/${name}.sh"; then
        merke "$name" ok
    else
        code=$?
        merke "$name" fehler
        echo "[cont-init] ${name} abgebrochen (Code ${code})" >&2
        exit "$code"
    fi
}

echo "[cont-init] starting Pulse self-host bootstrap (v$(cat /opt/pulse/VERSION 2>/dev/null || echo dev))"
merke start ok

# Mandatory: check env vars FIRST so we fail fast with a clear message
lauf 10-check-cloud-creds

# Filesystem skeleton + ownership
lauf 01-init-data-dirs

# Generate any missing secrets (idempotent — only writes if file missing)
lauf 03-init-secrets

# Postgres data dir + initdb + Pulse databases
lauf 02-init-postgres

# coturn config from template + secret
lauf 04-init-coturn

# LiveKit config from template
lauf 05-init-livekit

# Compose the runtime env file the longrun services source
lauf 07-render-env

# Render MediaMTX config (no template vars in MVP, but here so 6.B can plug in)
lauf 08-init-mediamtx

# Caddyfile from template (Phase 6.B: auto-TLS via Let's Encrypt by default,
# or provided-cert mode if PULSE_TLS_MODE=provided).
lauf 09-init-caddy

# frpc-Tunnel-Config (nur wenn PULSE_RELAY_* gesetzt — App-Hosting via Relay)
lauf 11-render-frpc

# Ensure postgres is up, then run the Alembic migrations
lauf 06-run-migrations

merke fertig ok
echo "[cont-init] bootstrap done — handing off to longrun services"
