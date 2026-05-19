#!/bin/sh
# Pulse backup container entrypoint.
#
# Modes:
#   cron   — install the baked-in crontab and exec busybox-crond in the
#            foreground. Default; this is what `docker compose up -d` runs.
#   idle   — keep PID 1 alive without doing any work. Useful for poking the
#            container interactively (`docker compose run --rm backup idle`
#            then `docker exec ... restic snapshots`).
#   <cmd>  — run an arbitrary command. Used by restore.md for one-off
#            `restic restore` invocations.

set -eu

case "${1:-cron}" in
    cron)
        mkdir -p /var/spool/cron/crontabs
        cp /etc/pulse-crontab /var/spool/cron/crontabs/root
        chmod 0600 /var/spool/cron/crontabs/root
        echo "pulse_backup: schedule installed, starting busybox-crond" >&2
        cat /etc/pulse-crontab >&2
        # -f foreground, -L /dev/stdout cron's own log → docker logs,
        # -l 0 = log level "warn" (busybox crond is noisy at higher levels;
        # actual job output comes from each line's >/proc/1/fd/1 redirect).
        exec crond -f -L /dev/stdout -l 0
        ;;
    idle)
        echo "pulse_backup: idle (no schedule running)" >&2
        exec sleep infinity
        ;;
    *)
        exec "$@"
        ;;
esac
