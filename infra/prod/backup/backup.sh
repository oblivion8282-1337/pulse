#!/bin/bash
# Pulse backup runner — invoked by busybox-crond (see crontab) with one of:
#
#   pg          pg_dump → restic --stdin     (tag: pg)
#   minio       mc mirror bucket → restic    (tag: minio)
#   avatars     restic /snapshot/avatars     (tag: avatars)
#   icons       restic /snapshot/guild_icons (tag: guild_icons)
#   config      restic /snapshot/config      (tag: config)
#   maintenance restic forget --prune + check
#
# All snapshots use --host=pulse so the repo is portable across host renames.
# First invocation auto-runs `restic init`; subsequent invocations skip it.
#
# Restores happen by hand from a shell inside the container — see restore.md.

set -euo pipefail

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY required}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD required}"

LOG_TS() { date -u +%FT%TZ; }
log() { echo "[$(LOG_TS)] $*"; }

ensure_repo() {
    if restic cat config >/dev/null 2>&1; then
        return 0
    fi
    log "initialising restic repo at $RESTIC_REPOSITORY"
    restic init
}

snapshot_pg() {
    : "${PGHOST:?}" "${PGUSER:?}" "${PGPASSWORD:?}" "${PGDATABASE:?}"
    log "pg_dump $PGDATABASE@$PGHOST → restic (tag=pg)"
    # -Fc = custom format (compressed, restorable via pg_restore).
    # Pipe straight into restic --stdin so the dump never lands on disk.
    pg_dump --format=custom --compress=6 --no-owner --no-privileges \
        | restic backup --stdin \
            --stdin-filename "pg-${PGDATABASE}.dump" \
            --tag pg --host pulse
}

snapshot_minio() {
    : "${MINIO_ENDPOINT:?}" "${MINIO_ACCESS_KEY:?}" "${MINIO_SECRET_KEY:?}"
    # Use a temporary directory so the mirror is not persisted between runs.
    # This avoids permanently holding three copies of attachment data on disk
    # (MinIO data volume + stage mirror + restic repo).
    local stage
    stage=$(mktemp -d /tmp/pulse-minio-stage.XXXXXX)
    trap 'rm -rf "$stage"' RETURN
    mc alias set local "$MINIO_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" >/dev/null
    log "mc mirror local/pulse-attachments → $stage (ephemeral)"
    mc mirror --overwrite --remove --quiet local/pulse-attachments "$stage"
    log "restic backup $stage (tag=minio)"
    restic backup "$stage" --tag minio --host pulse
}

snapshot_avatars() {
    test -d /snapshot/avatars || { log "ERROR: /snapshot/avatars not mounted"; exit 1; }
    log "restic backup /snapshot/avatars (tag=avatars)"
    restic backup /snapshot/avatars --tag avatars --host pulse
}

snapshot_icons() {
    test -d /snapshot/guild_icons || { log "ERROR: /snapshot/guild_icons not mounted"; exit 1; }
    log "restic backup /snapshot/guild_icons (tag=guild_icons)"
    restic backup /snapshot/guild_icons --tag guild_icons --host pulse
}

# Konfiguration und Geheimnisse — .env, secrets/ (JWT-Schluessel), certs/.
#
# **Warum es das seit 2026-08-07 gibt.** Bis dahin sicherte dieses Skript
# ausschliesslich NUTZERDATEN. Am 2026-08-07 hat ein `rsync --delete` gegen
# `infra/prod/` genau die Dateien geloescht, die dort NICHT im Git liegen —
# `.env`, `secrets/`, `certs/`. Das restic-Repo war intakt, die Datenbank
# vollstaendig, und der private JWT-Schluessel trotzdem unrettbar verloren:
# er stand in keinem Snapshot. Alle Sitzungen und alle Geraete-Zertifikate
# mussten neu ausgestellt werden.
#
# Die Lehre ist nicht "kein rsync --delete" (das auch), sondern: was nicht im
# Git liegt UND nicht im Backup, existiert genau einmal.
#
# Der Mount ist ABSICHTLICH nur lesbar (`:ro` in der compose-Datei) — ein
# Backup-Container hat keinen Grund, Geheimnisse zu veraendern.
snapshot_config() {
    test -d /snapshot/config || { log "ERROR: /snapshot/config not mounted"; exit 1; }
    test -e /snapshot/config/.env || log "WARN: /snapshot/config/.env fehlt — sichere trotzdem, was da ist"
    log "restic backup /snapshot/config (tag=config)"
    restic backup /snapshot/config --tag config --host pulse
}

run_maintenance() {
    log "restic forget --prune (retention: 7 daily / 4 weekly / 6 monthly per tag-group)"
    restic forget --prune \
        --group-by host,tags \
        --keep-daily 7 \
        --keep-weekly 4 \
        --keep-monthly 6
    log "restic check (integrity)"
    restic check
}

# Health marker — read by the compose healthcheck (file age < 36h ⇒ healthy).
# Lives at /repo/.pulse/last-backup-ok inside the pulse_backups volume so it
# survives container restarts. restic ignores files outside its managed
# subdirs (data/index/keys/locks/snapshots/config), so this is safe to keep
# co-located with the repo.
mark_ok() {
    mkdir -p /repo/.pulse
    date -u +%FT%TZ > /repo/.pulse/last-backup-ok
}

ensure_repo

case "${1:-}" in
    pg)          snapshot_pg ;;
    minio)       snapshot_minio ;;
    avatars)     snapshot_avatars ;;
    icons)       snapshot_icons ;;
    config)      snapshot_config ;;
    maintenance) run_maintenance ;;
    "")          echo "usage: backup.sh <pg|minio|avatars|icons|config|maintenance>" >&2; exit 64 ;;
    *)           echo "unknown subcommand: $1" >&2; exit 64 ;;
esac

mark_ok
log "$1 done"
