#!/bin/bash
# Baut aus /tmp/tb.yuv ein PQ-getaggtes AVIF und zeigt es in einem
# Brave-App-Fenster auf DP-2 -- die Gegenprobe zur Pulse-Kette.
#
# Warum AVIF und kein Canvas: ein 2d-Kontext mit colorSpace 'rec2100-pq' laesst
# sich zwar anlegen, aber `fillStyle = "color(rec2100-pq ...)"` malt nichts --
# das Fenster bleibt schwarz. Ein PQ-getaggtes Bild geht dagegen den normalen
# HDR-Weg von Chromium.
set -euo pipefail
ZIEL="${1:-/tmp/hdr-gegenprobe}"
mkdir -p "$ZIEL"

ffmpeg -v warning -y -f rawvideo -pix_fmt yuv420p10le -s 1920x1080 -i /tmp/tb.yuv -frames:v 1 \
  -c:v libaom-av1 -still-picture 1 -crf 0 -cpu-used 6 \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -color_range tv \
  -f avif "$ZIEL/tb.avif"

cp "$(dirname "$0")/seite.html" "$ZIEL/index.html"

# DP-2 liegt bei 2560,0 (kscreen-doctor -o nachsehen, falls anders).
brave --new-window --window-position=2560,0 --window-size=2560,1440 \
      --app="file://$ZIEL/index.html" &
echo "Fenster auf DP-2; jetzt kms_hdr_nachweis + balken-messen.py"
