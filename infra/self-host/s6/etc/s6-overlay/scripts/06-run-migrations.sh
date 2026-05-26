#!/bin/sh
# Postgres-Alembic migrations. We need a running Postgres → spin up a private
# instance the same way 02-init-postgres did (since the longrun unit hasn't
# started yet — cont-init runs *before* services).
set -eu
DATA="${PULSE_DATA_PATH:-/data}"
PG_DATA="${DATA}/pg"
PG_BIN=/usr/lib/postgresql/15/bin
PG_SOCKET=/var/run/pulse/pg-bootstrap
mkdir -p "${PG_SOCKET}"
chown pulse:pulse "${PG_SOCKET}"

echo "[06-run-migrations] starting transient Postgres for migrations"
/usr/sbin/gosu pulse "${PG_BIN}/pg_ctl" \
    -D "${PG_DATA}" \
    -o "-k ${PG_SOCKET} -h '' -p 5432" \
    -l "/var/log/pulse/pg-migrations.log" \
    -w start

# Wait for ready
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if /usr/sbin/gosu pulse "${PG_BIN}/pg_isready" -h "${PG_SOCKET}" -U pulse -q; then
        break
    fi
    sleep 1
done

# Source the rendered env so Alembic sees DATABASE_URL etc.
. /etc/pulse/env.sh

# Override DATABASE_URL to use the unix socket (it's faster + can't be
# blocked by an early-start listen failure).
export POSTGRES_HOST="${PG_SOCKET}"
export POSTGRES_PORT=5432

run_alembic() {
    svc_dir="$1"
    echo "[06-run-migrations] alembic upgrade head — ${svc_dir}"
    cd "/opt/pulse/services/${svc_dir}"
    /usr/sbin/gosu pulse /opt/pulse/venv/bin/alembic upgrade head
}

run_alembic auth
run_alembic chat-gateway

echo "[06-run-migrations] migrations done — stopping transient Postgres"
/usr/sbin/gosu pulse "${PG_BIN}/pg_ctl" -D "${PG_DATA}" -m fast -w stop
