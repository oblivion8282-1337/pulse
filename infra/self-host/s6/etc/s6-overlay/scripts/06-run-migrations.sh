#!/bin/sh
# Postgres-Alembic migrations. We need a running Postgres → spin up a private
# instance the same way 02-init-postgres did (since the longrun unit hasn't
# started yet — cont-init runs *before* services).
#
# Postgres binds 127.0.0.1:5432 here (not just the unix socket) because the
# rendered env.sh — which the alembic env.py reads via DATABASE_URL — wires
# everything against 127.0.0.1:5432. Easier than carrying a parallel socket
# URL through the env-renderer.
set -eu
DATA="${PULSE_DATA_PATH:-/data}"
PG_DATA="${DATA}/pg"
PG_BIN=/usr/lib/postgresql/15/bin
PG_SOCKET=/var/run/pulse/pg-bootstrap
mkdir -p "${PG_SOCKET}"
chown pulse:pulse "${PG_SOCKET}"

# Defense in depth: if any earlier hand-off left a Postgres bound to 5432
# (very rare — cont-init is serialised before longrun services), attach to
# it instead of trying to start a second one (would die with "Address
# already in use").
if /usr/sbin/gosu pulse "${PG_BIN}/pg_isready" -h 127.0.0.1 -p 5432 -U pulse -q 2>/dev/null; then
    echo "[06-run-migrations] Postgres already up on 127.0.0.1:5432 — reusing it"
    STARTED_PG=0
else
    # Postgres binds *both* the unix socket (so pg_ctl -w can probe quickly)
    # and 127.0.0.1:5432 (so the alembic env.py reaches it via DATABASE_URL
    # from the rendered env.sh).
    echo "[06-run-migrations] starting transient Postgres for migrations"
    /usr/sbin/gosu pulse "${PG_BIN}/pg_ctl" \
        -D "${PG_DATA}" \
        -o "-k ${PG_SOCKET} -h 127.0.0.1 -p 5432" \
        -l "/var/log/pulse/pg-migrations.log" \
        -w start
    STARTED_PG=1
fi

# Wait for ready
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if /usr/sbin/gosu pulse "${PG_BIN}/pg_isready" -h 127.0.0.1 -p 5432 -U pulse -q; then
        break
    fi
    sleep 1
done

# Source the rendered env so Alembic sees DATABASE_URL etc.
. /etc/pulse/env.sh

run_alembic() {
    svc_dir="$1"
    echo "[06-run-migrations] alembic upgrade head — ${svc_dir}"
    cd "/opt/pulse/services/${svc_dir}"
    /usr/sbin/gosu pulse /opt/pulse/venv/bin/alembic upgrade head
}

run_alembic auth
run_alembic chat-gateway

if [ "${STARTED_PG}" = "1" ]; then
    echo "[06-run-migrations] migrations done — stopping transient Postgres"
else
    echo "[06-run-migrations] migrations done — leaving the existing Postgres up"
fi
if [ "${STARTED_PG}" = "1" ]; then
    /usr/sbin/gosu pulse "${PG_BIN}/pg_ctl" -D "${PG_DATA}" -m fast -w stop
fi
