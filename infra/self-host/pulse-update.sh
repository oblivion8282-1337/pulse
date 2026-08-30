#!/usr/bin/env bash
# Pulse self-host updater — Compose-Pfad (manuelle Installation).
#
# Liegt neben docker-compose.yml + .env, erledigt einen kompletten
# Update-Lauf: Registry-Login aus der .env, Image pullen, Container nur bei
# geändertem Digest neu anlegen, altes Image erst aufräumen, wenn der neue
# Stand eine Runde gelaufen ist. Gedacht für einen Host-Cron oder systemd-
# Timer (Beispiele unten) — von Hand läuft er genauso.
#
#   cron (täglich 04:17):  17 4 * * *  /opt/pulse/pulse-update.sh >> /opt/pulse/pulse-update.log 2>&1
#   systemd:               Unit wie im Installer (pulse-update.service/.timer)
#
# Das Pendant für den Installer-Pfad baut der Installer selbst ein
# (`web/static/install.sh` — inkl. Rollback-Karussell); dieses Skript hier
# ist die absichtsvoll schlanke Variante für `docker compose`.

set -euo pipefail

# Projektverzeichnis = wo dieses Skript liegt (docker-compose.yml + .env).
cd "$(dirname "$0")"

LOG="${PWD}/pulse-update.log"

# Eigenes Log kappen (trap = auf JEDEM Ausgang). Auf jedem Lauf wachsen sonst
# die frühabbrechenden Pfade (Registry-Login 403 bei gesperrter Instanz …)
# unbegrenzt. In-place gekappt (gleiche Inode) — der Cron hält die Datei mit
# O_APPEND offen; erst ab 4000 Zeilen kappen, dann auf 2000, sonst träfe die
# Grenze bei jedem Lauf erneut zu.
_trim_log() {
  [ -f "$LOG" ] || return 0
  zeilen="$(wc -l < "$LOG" 2>/dev/null || echo 0)"
  [ "${zeilen:-0}" -gt 4000 ] 2>/dev/null || return 0
  tmp="$(mktemp 2>/dev/null)" || return 0
  if tail -n 2000 "$LOG" > "$tmp" 2>/dev/null; then
    cat "$tmp" > "$LOG" 2>/dev/null || true
  fi
  rm -f "$tmp"
}
trap _trim_log EXIT

# Registry-Login aus der .env — gleiche Muster wie in Schritt 3 des Compose-
# Headers. Ohne Secret (z. B. GHCR-Image via PULSE_IMAGE) kein Login nötig.
if [ -f .env ] && grep -q '^PULSE_CLOUD_CLIENT_SECRET=' .env; then
  grep -oP '^PULSE_CLOUD_CLIENT_SECRET=\K.*' .env \
    | docker login registry.howispulse.com \
        -u "$(grep -oP '^PULSE_CLOUD_CLIENT_ID=\K.*' .env)" --password-stdin >/dev/null 2>&1 \
    || { echo "pulse-update: registry login failed, will retry next run" >&2; exit 0; }
fi

# Erster Service des Projekts (das Compose-File hat genau einen: `pulse`).
service="$(docker compose config --services | head -n1)"
image="$(docker compose config --images | head -n1)"
[ -n "$image" ] || { echo "pulse-update: kein Image in compose config" >&2; exit 1; }

# aktuell laufendes Image des Containers (vor dem Pull)
container="$(docker compose ps -q "$service" | head -n1)"
old_id=""
[ -n "$container" ] && old_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null || true)"

docker compose pull >/dev/null 2>&1 \
  || { echo "pulse-update: pull failed (network/registry?), will retry next run" >&2; exit 0; }
new_id="$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || true)"
[ -n "$new_id" ] || { echo "pulse-update: cannot read image id, skipping" >&2; exit 0; }

#Aufräumen des VORLETZTEN Laufs: das beim letzten Update verdrängte Image
# wird erst entfernt, wenn der neue Stand einen Lauf lang lief (hier: der
# vorherige Lauf ist beendet und der Container nutzt es nicht mehr). Im
# state-File steht die Id des Images VOR dem jeweiligen Pull.
state="${PWD}/.pulse-update.state"
if [ -f "$state" ]; then
  prev_id="$(cat "$state" 2>/dev/null || true)"
  cur_container_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null || true)"
  if [ -n "$prev_id" ] && [ "$prev_id" != "$cur_container_id" ]; then
    docker image rm "$prev_id" >/dev/null 2>&1 || true
  fi
fi

if [ "$new_id" = "$old_id" ]; then
  echo "pulse-update: bereits aktuell"
  exit 0
fi

echo "pulse-update: updating $service -> $new_id"
printf '%s\n' "$old_id" > "$state"
# `up -d` legt den Container nur neu an, wenn Image oder Config sich ändern —
# ein Lauf ohne neues Image ist oben schon kurzgeschlossen.
docker compose up -d
echo "pulse-update: done"
