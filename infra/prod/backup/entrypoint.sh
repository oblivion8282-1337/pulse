#!/bin/sh
# Pulse backup container entrypoint.
#
# Modes:
#   idle   — keep PID 1 alive without doing any work (Commit A scaffold).
#   cron   — install crontab and exec busybox-crond (Commit B; not wired up yet).
#   <cmd>  — run an arbitrary command (used for `docker compose exec` restores
#            and one-off manual snapshots).
#
# The repo at $RESTIC_REPOSITORY is initialised on first need, not here — the
# password is required and we don't want the container to crash-loop before
# the operator has set RESTIC_PASSWORD in .env.

set -eu

case "${1:-idle}" in
    idle)
        echo "pulse_backup: idle (no schedule installed; backup.sh + crontab land in Commit B)" >&2
        exec sleep infinity
        ;;
    cron)
        echo "pulse_backup: cron mode not implemented in Commit A" >&2
        exit 64
        ;;
    *)
        exec "$@"
        ;;
esac
