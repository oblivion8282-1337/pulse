# Pulse backup sidecar — restic-encrypted snapshots of Postgres, MinIO,
# avatars, and guild_icons into the `pulse_backups` named volume.
#
# Built locally by docker compose (no GHCR image). Watchtower-excluded — the
# image only changes when this Dockerfile or the bundled script does, and a
# surprise restart while a snapshot is mid-flight would corrupt nothing
# (restic is crash-safe) but masks intent. Bump deliberately with
# `docker compose build backup && docker compose up -d backup`.
#
# Runs as root: the avatars/guild_icons volumes are owned by uid 10001 inside
# pulse_auth/pulse_chat_gateway and we only need read access. A dedicated
# non-root user would need shared gids on those volumes, which is more
# coordination for zero security gain in a read-only sidecar.

FROM alpine:3.21

RUN apk add --no-cache \
        restic \
        postgresql16-client \
        minio-client \
        tini \
        bash \
        tzdata \
    && ln -s /usr/bin/mcli /usr/local/bin/mc \
    && restic version \
    && mc --version | head -1

ENV RESTIC_REPOSITORY=/repo \
    TZ=UTC

WORKDIR /backup

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["idle"]
