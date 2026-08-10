#!/bin/bash
# Ein Durchgang: Player mit gegebenen Angaben starten, Scanout messen, Balken
# auswerten. Der ganze Aufbau davor (auth-hook, Marken, Schieben) steht in
# BEFUND.md, Abschnitt "Messung wiederholen".
#
# Aufruf:  WHEP="http://localhost:8889/<pfad>/whep?token=<read-token>" \
#          ./durchgang.sh <name> PULSE_PLAYER_HDR_BEZUGSWEISS=203 PULSE_PLAYER_HDR_OHNE_MEISTER=1
#
# Die WHEP-Adresse kommt bewusst aus der Umgebung und steht NICHT hier drin:
# sie traegt eine Marke, und Marken gehoeren nicht ins Repo.
set -u
: "${WHEP:?WHEP=<whep-url mit ?token=> setzen -- s. BEFUND.md}"
AUS="${AUS:-/tmp/hdr-messung}"
HIER="$(cd "$(dirname "$0")" && pwd)"
WURZEL="$(cd "$HIER/../../.." && pwd)"
PLAYER="${PULSE_PLAYER:-$WURZEL/streaming/pulse-player/target/release/pulse-player}"
NACHWEIS="${KMS_NACHWEIS:-$WURZEL/streaming/linux-hq-sidecar/target/release/examples/kms_hdr_nachweis}"
SCHIRM="${SCHIRM:-DP-2}"

NAME="$1"; shift
mkdir -p "$AUS"

# Muster in Klammern, damit pgrep nicht die eigene Kommandozeile trifft und
# sich selbst umbringt (kostete beim Messen zwei Anlaeufe).
pgrep -f 'player-treibe[r].py' | xargs -r kill 2>/dev/null
sleep 1

nohup env "$@" WAYLAND_DISPLAY=wayland-0 DISPLAY=:0 \
  python3 "$HIER/player-treiber.py" "$PLAYER" "$WHEP" "$AUS/$NAME.log" >/dev/null 2>&1 &
sleep 10

sudo "$NACHWEIS" "$SCHIRM" "$AUS/$NAME.ivf" 8 >/dev/null 2>&1
ffmpeg -v error -y -i "$AUS/$NAME.ivf" -frames:v 1 -pix_fmt yuv420p10le -f rawvideo "$AUS/$NAME.yuv"
echo "===== $NAME : $* ====="
# Steht in der Ausgabe "Balken y=0..", lag das Fenster zu hoch und die Tabelle
# ist um eine Zeile verschoben -- Lauf verwerfen, Fenster verschieben.
python3 "$HIER/balken-messen.py" "$AUS/$NAME.yuv"
