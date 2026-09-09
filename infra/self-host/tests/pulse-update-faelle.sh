#!/usr/bin/env bash
# Entscheidungslogik von `infra/self-host/pulse-update.sh` (Compose-Weg) —
# ohne echten Docker. Schwester von `infra/prod/tests/pulse-update-faelle.sh`.
#
# Warum es das gibt: am 2026-09-09 stellte sich heraus, dass das Skript einen
# absichtlich angehaltenen Container (docker compose stop) fünf Minuten später
# wieder startete — `docker compose ps -q` zählt gestoppte nicht mit, "kein
# Container" galt als "veraltet", und `up -d` fuhr ihn hoch. Ein Fehler, der
# im Log wie Arbeit aussieht ("updating … done"), nicht wie ein Fehler.
#
# Aufruf:  bash infra/self-host/tests/pulse-update-faelle.sh
set -euo pipefail

hier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skript="$hier/../pulse-update.sh"
arbeit="$(mktemp -d)"
trap 'rm -rf "$arbeit"' EXIT
mkdir -p "$arbeit/bin" "$arbeit/proj"
cp "$skript" "$arbeit/proj/"
: > "$arbeit/proj/docker-compose.yml"

# Docker-Attrappe. CONTAINER_STATUS="" = es gibt keinen Container.
cat > "$arbeit/bin/docker" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "compose config")
      # Ohne Standarddatei findet Compose nur über COMPOSE_FILE etwas.
      if [ ! -f docker-compose.yml ] && [ "${COMPOSE_FILE:-}" != docker-compose.behind-proxy.yml ]; then
        echo "no configuration file provided" >&2; exit 1
      fi
      case "$3" in
        --services) echo pulse ;;
        --images)   echo reg/probe:t ;;
      esac; exit 0 ;;
  "compose pull") exit 0 ;;
  "compose ps")
      # -aq muss dabei sein — ohne -a zählt ein gestoppter Container nicht.
      [[ " $* " == *" -aq "* ]] || { [ "${CONTAINER_STATUS}" = running ] && echo cid; exit 0; }
      [ -n "${CONTAINER_STATUS}" ] && echo cid; exit 0 ;;
  "compose up")   echo "UP-D-AUFGERUFEN"; exit 0 ;;
  "image inspect") echo "${REV_NEU}"; exit 0 ;;
  "image rm")      exit 0 ;;
  "inspect --format")
      case "$3" in
        *Status*) echo "${CONTAINER_STATUS}" ;;
        *Image*)  echo "${REV_LAUFEND}" ;;
      esac; exit 0 ;;
esac
exit 0
STUB
chmod +x "$arbeit/bin/docker"

fehler=0
pruefe() {  # pruefe <name> <erwartet-up: ja|nein> <muster> <env…>
  local name="$1" erwartet="$2" muster="$3"; shift 3
  local ausgabe
  ausgabe="$(cd "$arbeit/proj" && env PATH="$arbeit/bin:$PATH" "$@" bash ./pulse-update.sh 2>&1 || true)"
  local up=nein
  grep -q "UP-D-AUFGERUFEN" <<<"$ausgabe" && up=ja
  if [ "$up" != "$erwartet" ]; then
    echo "✗ $name: up=$up, erwartet=$erwartet"; echo "$ausgabe" | sed 's/^/    /'; fehler=1; return
  fi
  if [ -n "$muster" ] && ! grep -q "$muster" <<<"$ausgabe"; then
    echo "✗ $name: Meldung fehlt (erwartet: $muster)"; echo "$ausgabe" | sed 's/^/    /'; fehler=1; return
  fi
  echo "✓ $name"
}

pruefe "kein Container → anlegen"                 ja   "updating" \
  CONTAINER_STATUS= REV_NEU=aaa REV_LAUFEND=
pruefe "läuft, gleiches Image → still"           nein "bereits aktuell" \
  CONTAINER_STATUS=running REV_NEU=aaa REV_LAUFEND=aaa
pruefe "läuft, neues Image → ausliefern"         ja   "updating" \
  CONTAINER_STATUS=running REV_NEU=bbb REV_LAUFEND=aaa
pruefe "angehalten, gleiches Image → nicht anfassen" nein "angehalten" \
  CONTAINER_STATUS=exited REV_NEU=aaa REV_LAUFEND=aaa
pruefe "angehalten, NEUES Image → nicht anfassen" nein "angehalten" \
  CONTAINER_STATUS=exited REV_NEU=bbb REV_LAUFEND=aaa
pruefe "pausiert → nicht anfassen"               nein "angehalten" \
  CONTAINER_STATUS=paused REV_NEU=bbb REV_LAUFEND=aaa
# Absturzkarussell ist KEIN Handstopp: ein neues Image darf dort heilen.
pruefe "restarting, neues Image → ausliefern"    ja   "updating" \
  CONTAINER_STATUS=restarting REV_NEU=bbb REV_LAUFEND=aaa

# Hinter einem Proxy liegt nur docker-compose.behind-proxy.yml im Verzeichnis.
mv "$arbeit/proj/docker-compose.yml" "$arbeit/proj/docker-compose.behind-proxy.yml"
pruefe "nur behind-proxy-Datei → Weiche greift" ja "updating" \
  CONTAINER_STATUS= REV_NEU=aaa REV_LAUFEND=

[ "$fehler" = 0 ] && echo "✓ self-host pulse-update: alle Fälle wie erwartet" || exit 1
