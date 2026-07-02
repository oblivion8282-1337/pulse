#!/usr/bin/env bash
#
# Pulse Cloud auto-update — replaces Watchtower.
# ==============================================
# Watchtower mounted the Docker socket (= root on the host): anyone able to run
# code in that container could take over the machine. This script runs from a
# user crontab instead — no container holds the socket, the update logic is a
# small, auditable, version-controlled host script.
#
# Scope mirrors the old Watchtower exactly (`--label-enable --scope pulse`):
# only the CI-built GHCR app images are pulled+recreated. The pinned infra
# (postgres / redis / minio / mediamtx / livekit) is deliberately NOT
# auto-updated — bump those by hand in docker-compose.yml.
#
# Difference from Watchtower (an improvement): the migrate-* one-shots ARE
# included, so Alembic migrations apply automatically on deploy. Watchtower
# skipped them, which forced a manual `docker compose up -d migrate-{auth,chat}`
# after every schema change (a known footgun). compose's
# `service_completed_successfully` dependency sequences migration-before-app.
#
# Install (user crontab, no sudo needed — see infra/prod/DEPLOY.md):
#   */5 * * * * /home/michael/pulse/infra/prod/pulse-update.sh >> /home/michael/pulse/infra/prod/pulse-update.log 2>&1
set -euo pipefail

cd "$(dirname "$0")"   # ~/pulse/infra/prod (where docker-compose.yml + .env live)

# Services tracking ghcr.io/oblivion8282-1337/pulse-*:latest — the Watchtower
# scope, plus the two migrate one-shots. Keep in sync with docker-compose.yml:
# every service WITHOUT `labels: *pinned-labels` belongs here.
APP_SERVICES=(
  migrate-auth migrate-chat
  auth chat-gateway voice-signaling media-svc mediamtx-auth-hook relay-frps-plugin web
)

# The distinct image refs behind those services (migrate-* reuse the auth/chat
# images, so this is 6 refs, not 8). Used to gate on real changes.
APP_IMAGES=(
  ghcr.io/oblivion8282-1337/pulse-auth:latest
  ghcr.io/oblivion8282-1337/pulse-chat-gateway:latest
  ghcr.io/oblivion8282-1337/pulse-voice-signaling:latest
  ghcr.io/oblivion8282-1337/pulse-media-svc:latest
  ghcr.io/oblivion8282-1337/pulse-mediamtx-auth-hook:latest
  ghcr.io/oblivion8282-1337/pulse-relay-frps-plugin:latest
  ghcr.io/oblivion8282-1337/pulse-web:latest
)

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
image_ids() { for i in "${APP_IMAGES[@]}"; do docker image inspect --format '{{.Id}}' "$i" 2>/dev/null || echo missing; done; }

# Digest-gate (mirrors the self-host updater): pull, and only deploy if an image
# actually changed. Without this gate, `up -d` would re-run the migrate one-shots
# on every single tick (compose re-executes completed dependencies), spamming the
# DB and the log every 5 min for nothing.
before="$(image_ids)"
if ! docker compose pull "${APP_SERVICES[@]}" >/dev/null 2>&1; then
  echo "$(ts) pulse-update: pull failed (network/registry?), will retry next run"
  exit 0
fi
after="$(image_ids)"

if [ "$before" = "$after" ]; then
  exit 0   # nothing changed — stay quiet
fi

echo "$(ts) pulse-update: image change detected — deploying"
# compose runs the migrate one-shots first (service_completed_successfully),
# then recreates the changed app services. Unchanged ones are left untouched.
docker compose up -d "${APP_SERVICES[@]}"
docker image prune -f >/dev/null 2>&1 || true   # mirror of Watchtower --cleanup
echo "$(ts) pulse-update: done"
