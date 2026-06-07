#!/bin/sh
# /data/ skeleton. /data is bind-mounted (or named-volume) → idempotent.
# All subdirs are pulse:pulse, 700 except pg (700 — postgres refuses else).
set -eu
DATA="${PULSE_DATA_PATH:-/data}"

mkdir -p \
    "${DATA}" \
    "${DATA}/pg" \
    "${DATA}/redis" \
    "${DATA}/backups" \
    "${DATA}/certs" \
    "${DATA}/jwt_keys" \
    "${DATA}/coturn" \
    "${DATA}/caddy" \
    "${DATA}/livekit" \
    "${DATA}/mediamtx" \
    "${DATA}/minio" \
    "${DATA}/uploads" \
    "${DATA}/uploads/avatars" \
    "${DATA}/uploads/guild-icons"

chown -R pulse:pulse "${DATA}"
chmod 0700 "${DATA}"
chmod 0700 "${DATA}/pg" "${DATA}/redis" "${DATA}/jwt_keys" "${DATA}/coturn" "${DATA}/minio"
chmod 0750 "${DATA}/uploads"

# Also chown runtime state dirs (recreated empty on container restart)
mkdir -p /var/run/pulse /var/log/pulse
chown -R pulse:pulse /var/run/pulse /var/log/pulse
chmod 0750 /var/run/pulse /var/log/pulse

echo "[01-init-data-dirs] /data tree ready"
