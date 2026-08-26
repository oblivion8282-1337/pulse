#!/usr/bin/env bash
# Entscheidungslogik von `pulse-update.sh` — vier Fälle, ohne echten Docker.
#
# Warum es das gibt: das Skript läuft ausschliesslich auf dem VPS, per Cron,
# und meldet sich nur, wenn es etwas tut. Ein Fehler darin sieht deshalb aus
# wie "es passiert nichts" — nicht wie ein Fehler. Genau das ist beim Bauen
# passiert: eine `[ … ] && echo`-Kurzschreibweise gab in der letzten
# Schleifenrunde 1 zurück, `set -e` beendete den Lauf vor jeder Entscheidung,
# und im Log stand kein Wort. Auf dem Server hätte das bedeutet: gar keine
# Deploys mehr.
#
# Aufruf:  bash infra/prod/tests/pulse-update-faelle.sh
set -euo pipefail

hier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skript="$hier/../pulse-update.sh"
arbeit="$(mktemp -d)"
trap 'rm -rf "$arbeit"' EXIT
mkdir -p "$arbeit/bin" "$arbeit/prod"
cp "$skript" "$arbeit/prod/"

# Docker-Attrappe. Die Antworten kommen aus Umgebungsvariablen, damit ein Fall
# eine Zeile ist statt eines Aufbaus.
cat > "$arbeit/bin/docker" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "compose pull") exit 0 ;;
  "compose ps")   echo "cid-laufend"; exit 0 ;;
  "compose up")   echo "UP-D-AUFGERUFEN"; exit 0 ;;
  "image inspect")
      ref="${!#}"
      case "$ref" in
        *web*)     echo "${REV_WEB-$REV_ALLE}" ;;
        cid-image) echo "$REV_LAUFEND" ;;
        *)         echo "$REV_ALLE" ;;
      esac
      exit 0 ;;
  "image prune")      exit 0 ;;
  "inspect --format") echo "cid-image"; exit 0 ;;
esac
exit 0
STUB
chmod +x "$arbeit/bin/docker"

fehler=0
pruefe() {  # pruefe <name> <erwartet-ausgeliefert: ja|nein> <muster> <env…>
  local name="$1" erwartet="$2" muster="$3"; shift 3
  local ausgabe
  ausgabe="$(env PATH="$arbeit/bin:$PATH" "$@" bash "$arbeit/prod/pulse-update.sh" 2>&1 || true)"
  local geliefert=nein
  grep -q "UP-D-AUFGERUFEN" <<<"$ausgabe" && geliefert=ja
  if [ "$geliefert" != "$erwartet" ]; then
    echo "✗ $name: ausgeliefert=$geliefert, erwartet=$erwartet"; echo "$ausgabe" | sed 's/^/    /'; fehler=1; return
  fi
  if [ -n "$muster" ] && ! grep -q "$muster" <<<"$ausgabe"; then
    echo "✗ $name: Meldung fehlt (erwartet: $muster)"; echo "$ausgabe" | sed 's/^/    /'; fehler=1; return
  fi
  echo "✓ $name"
}

# Der Fall, für den das Tor gebaut wurde: die CI-Matrix pusht die Images
# einzeln, der Cron fährt dazwischen. Am 2026-08-26 waren so sechs Images neu
# und `pulse-web` fünf Stunden alt — Server neu, Klient alt.
pruefe "gemischter Build liefert NICHT aus" nein "unvollstaendiger Build" \
  REV_ALLE=aaa111 REV_WEB=bbb222 REV_LAUFEND=alt
pruefe "schon ausgeliefert bleibt still"    nein "" \
  REV_ALLE=aaa111 REV_LAUFEND=aaa111
pruefe "vollstaendiger neuer Build liefert" ja   "vollstaendiger Build" \
  REV_ALLE=aaa111 REV_LAUFEND=alt999
# Images von vor dem Label-Commit: alte Logik, damit ein Deploy nicht daran
# scheitert, dass die Kennzeichnung neu ist.
pruefe "ohne Label greift der Rueckfall"    nein "Rueckfall" \
  REV_ALLE= REV_LAUFEND=alt

[ "$fehler" = 0 ] && echo "✓ pulse-update: alle Fälle wie erwartet" || exit 1
