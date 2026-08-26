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

# Der Commit, aus dem ein Image gebaut wurde — als OCI-Label, gesetzt in
# `.github/workflows/ci.yml`. Leer bei Images, die vor dem 2026-08-26 gebaut
# wurden (dann greift der Rueckfall weiter unten).
revision_of() {
  docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "$1" 2>/dev/null || true
}
image_ids() { for i in "${APP_IMAGES[@]}"; do docker image inspect --format '{{.Id}}' "$i" 2>/dev/null || echo missing; done; }

before="$(image_ids)"
if ! docker compose pull "${APP_SERVICES[@]}" >/dev/null 2>&1; then
  echo "$(ts) pulse-update: pull failed (network/registry?), will retry next run"
  exit 0
fi

# ── Nur ein VOLLSTAENDIGER Build wird ausgeliefert ──────────────────────────
#
# `ci.yml` baut die sieben Images als Matrix und pusht jedes einzeln, sobald es
# fertig ist. Dieser Cron laeuft alle 5 Minuten und kann deshalb MITTEN in die
# Matrix fahren. Am 2026-08-26 genau so passiert: die sechs Backend-Images
# waren neu, `pulse-web` noch fuenf Stunden alt — Server neu, Klient alt. Bei
# einer Aenderung, deren beide Haelften zusammengehoeren (dort: der
# Token-Austausch am offenen Socket), ist das Ergebnis "nichts passiert", und
# nichts im Log sagt es.
#
# Deshalb: alle sieben Images muessen denselben Commit tragen. Tun sie es
# nicht, ist der Build noch am Laufen — dann wird NICHT ausgeliefert, sondern
# auf den naechsten Lauf gewartet (5 Minuten).
# ACHTUNG beim Umbauen: `set -e` und `[ … ] && echo` vertragen sich nicht.
# Ist die Bedingung in der LETZTEN Schleifenrunde falsch, endet der ganze
# Ausdruck mit 1, die Zuweisung erbt das, und das Skript bricht ab — ohne eine
# Zeile im Log, also als "es passiert einfach nichts mehr". Deshalb hier eine
# gewöhnliche Schleife mit `if`, nicht die kürzere Kurzschluss-Schreibweise.
revisions="$(for i in "${APP_IMAGES[@]}"; do revision_of "$i"; done | sort -u)"
rev_count="$(printf '%s\n' "$revisions" | grep -c . || true)"
hat_leere=""
for i in "${APP_IMAGES[@]}"; do
  if [ -z "$(revision_of "$i")" ]; then hat_leere=ja; break; fi
done

if [ -n "$hat_leere" ]; then
  # Rueckfall fuer Images ohne Label (vor 2026-08-26 gebaut, oder ein Image
  # fehlt lokal noch ganz). Alte Logik: liefern, sobald sich beim Pull etwas
  # geaendert hat. Schlechter, aber besser als gar nicht auszuliefern.
  echo "$(ts) pulse-update: mindestens ein Image ohne revision-Label — Rueckfall auf den Digest-Vergleich"
  [ "$before" = "$(image_ids)" ] && exit 0
  echo "$(ts) pulse-update: image change detected — deploying"
  docker compose up -d "${APP_SERVICES[@]}"
  docker image prune -f >/dev/null 2>&1 || true
  echo "$(ts) pulse-update: done"
  exit 0
fi

if [ "$rev_count" -ne 1 ]; then
  echo "$(ts) pulse-update: unvollstaendiger Build ($rev_count verschiedene Commits in den Images) — warte auf den naechsten Lauf"
  exit 0
fi
gezogen="$revisions"

# ── Ausgeliefert wird, was LAEUFT, nicht was sich beim Pull geaendert hat ────
#
# Der frühere Vergleich (Image-IDs vor/nach dem Pull) hatte eine stille Falle:
# wer zur Diagnose selbst einmal `docker compose pull` fuhr, nahm dem naechsten
# Cron-Lauf die Aenderung weg — der sah dann "nichts neu" und startete NIE neu.
# Am 2026-08-26 genau daran vorbeigeschrammt. Der Vergleich gegen den laufenden
# Container kennt diesen Zustand nicht: er fragt, ob das Ausgelieferte dem
# Gezogenen entspricht, und das ist die Frage, um die es geht.
laufend="$(docker compose ps -q chat-gateway 2>/dev/null | head -1)"
if [ -n "$laufend" ]; then
  laeuft_rev="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
                 "$(docker inspect --format '{{.Image}}' "$laufend")" 2>/dev/null || true)"
  if [ "$laeuft_rev" = "$gezogen" ]; then
    exit 0   # schon ausgeliefert — still bleiben
  fi
fi

echo "$(ts) pulse-update: vollstaendiger Build ${gezogen:0:8} — deploying"
# compose runs the migrate one-shots first (service_completed_successfully),
# then recreates the changed app services. Unchanged ones are left untouched.
docker compose up -d "${APP_SERVICES[@]}"
docker image prune -f >/dev/null 2>&1 || true   # mirror of Watchtower --cleanup
echo "$(ts) pulse-update: done"
