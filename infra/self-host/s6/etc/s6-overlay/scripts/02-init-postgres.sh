#!/bin/sh
# Postgres data directory + database bootstrap.
# Runs initdb on first start; creates dcc database + pulse role.
set -eu
DATA="${PULSE_DATA_PATH:-/data}"
PG_DATA="${DATA}/pg"
PG_BIN=/usr/lib/postgresql/15/bin

# Trust the data dir if it already has PG_VERSION → idempotent.
if [ -f "${PG_DATA}/PG_VERSION" ]; then
    echo "[02-init-postgres] data dir already initialized (PG_VERSION=$(cat ${PG_DATA}/PG_VERSION))"
else
    echo "[02-init-postgres] running initdb on ${PG_DATA}"
    chown -R pulse:pulse "${PG_DATA}"
    chmod 0700 "${PG_DATA}"
    /usr/sbin/gosu pulse "${PG_BIN}/initdb" \
        --pgdata="${PG_DATA}" \
        --username=pulse \
        --encoding=UTF8 \
        --locale=C.UTF-8 \
        --auth-local=trust \
        --auth-host=scram-sha-256
fi

# Boot Postgres long enough to create the database + auth schema role.
# We run it on a private socket dir so it doesn't collide with the longrun
# unit later. Wait until pg_isready before issuing SQL.
PG_SOCKET=/var/run/pulse/pg-bootstrap
mkdir -p "${PG_SOCKET}"
chown pulse:pulse "${PG_SOCKET}"

echo "[02-init-postgres] starting Postgres for one-shot DB setup"
/usr/sbin/gosu pulse "${PG_BIN}/pg_ctl" \
    -D "${PG_DATA}" \
    -o "-k ${PG_SOCKET} -h '' -p 5432" \
    -l "/var/log/pulse/pg-bootstrap.log" \
    -w start

# Wait for ready (pg_ctl -w should already block, but be paranoid)
for i in 1 2 3 4 5 6 7 8 9 10; do
    if /usr/sbin/gosu pulse "${PG_BIN}/pg_isready" -h "${PG_SOCKET}" -U pulse -q; then
        break
    fi
    sleep 1
done

# Idempotent CREATE DATABASE (test before create — CREATE DATABASE has no IF NOT EXISTS)
DB_EXISTS=$(/usr/sbin/gosu pulse "${PG_BIN}/psql" -h "${PG_SOCKET}" -U pulse -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='dcc'" || echo "")
if [ -z "${DB_EXISTS}" ]; then
    echo "[02-init-postgres] creating database 'dcc'"
    /usr/sbin/gosu pulse "${PG_BIN}/psql" -h "${PG_SOCKET}" -U pulse -d postgres -c \
        "CREATE DATABASE dcc OWNER pulse;"
else
    echo "[02-init-postgres] database 'dcc' already exists"
fi

# Set the pulse role's password from the generated secret. Idempotent.
PG_PASS=$(cat "${DATA}/jwt_keys/postgres.password")
/usr/sbin/gosu pulse "${PG_BIN}/psql" -h "${PG_SOCKET}" -U pulse -d postgres -c \
    "ALTER ROLE pulse WITH PASSWORD '${PG_PASS}';" >/dev/null

# Pulse keeps each service in its own Postgres schema (`auth` / `chat`).
# Alembic writes its `alembic_version` table into `version_table_schema`, but
# pg refuses to create it if the schema doesn't exist yet — and the first
# migration's `CREATE SCHEMA IF NOT EXISTS` runs AFTER alembic's bookkeeping.
# Pre-creating both schemas here breaks that chicken-and-egg.
/usr/sbin/gosu pulse "${PG_BIN}/psql" -h "${PG_SOCKET}" -U pulse -d dcc -c \
    "CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION pulse; CREATE SCHEMA IF NOT EXISTS chat AUTHORIZATION pulse;" >/dev/null

# Stop the bootstrap instance — the longrun will pick up from the same data dir
/usr/sbin/gosu pulse "${PG_BIN}/pg_ctl" -D "${PG_DATA}" -m fast -w stop

echo "[02-init-postgres] one-shot DB setup complete"
