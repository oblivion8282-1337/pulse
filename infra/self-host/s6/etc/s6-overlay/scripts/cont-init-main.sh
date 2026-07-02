#!/bin/sh
# cont-init main entry — runs the numbered scripts in order. Anything that
# exits non-zero aborts the boot (s6-overlay treats the oneshot as failed),
# which lets `S6_BEHAVIOUR_IF_STAGE2_FAILS=2` terminate the container cleanly
# rather than spinning on broken state.
set -eu
SCRIPT_DIR=/etc/s6-overlay/scripts

echo "[cont-init] starting Pulse self-host bootstrap (v$(cat /opt/pulse/VERSION 2>/dev/null || echo dev))"

# Mandatory: check env vars FIRST so we fail fast with a clear message
"${SCRIPT_DIR}/10-check-cloud-creds.sh"

# Filesystem skeleton + ownership
"${SCRIPT_DIR}/01-init-data-dirs.sh"

# Generate any missing secrets (idempotent — only writes if file missing)
"${SCRIPT_DIR}/03-init-secrets.sh"

# Postgres data dir + initdb + Pulse databases
"${SCRIPT_DIR}/02-init-postgres.sh"

# coturn config from template + secret
"${SCRIPT_DIR}/04-init-coturn.sh"

# LiveKit config from template
"${SCRIPT_DIR}/05-init-livekit.sh"

# Compose the runtime env file the longrun services source
"${SCRIPT_DIR}/07-render-env.sh"

# Render MediaMTX config (no template vars in MVP, but here so 6.B can plug in)
"${SCRIPT_DIR}/08-init-mediamtx.sh"

# Caddyfile from template (Phase 6.B: auto-TLS via Let's Encrypt by default,
# or provided-cert mode if PULSE_TLS_MODE=provided).
"${SCRIPT_DIR}/09-init-caddy.sh"

# frpc-Tunnel-Config (nur wenn PULSE_RELAY_* gesetzt — App-Hosting via Relay)
"${SCRIPT_DIR}/11-render-frpc.sh"

# Ensure postgres is up, then run the Alembic migrations
"${SCRIPT_DIR}/06-run-migrations.sh"

echo "[cont-init] bootstrap done — handing off to longrun services"
