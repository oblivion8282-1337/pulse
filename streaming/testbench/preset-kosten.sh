#!/bin/bash
# Was ein Encoder-Preset an GPU kostet — ueber die Aufloesung hinweg.
#
# Die Qualitaetsfrage ist offline beantwortet (die Presets liegen bei AV1
# innerhalb eines VMAF-Punktes). Offen ist die KOSTENSEITE: `preset=p2` braucht
# bei 1440p60 rund 40 Prozent weniger Encoder-Block als der ffmpeg-Default p4.
# Ob das mit der Pixelzahl mitwaechst, entscheidet, ob es sich lohnt.
#
# Warum nicht aus dem Rohmitschnitt: der liegt als unkomprimiertes 1440p auf der
# Platte (660 MB/s) und bremst den Encoder aus — gemessen wuerde dann die SSD.
# Hier laeuft alles auf der GPU: NVDEC dekodiert die Quelle, `scale_cuda`
# skaliert, NVENC kodiert. Der Decode-Anteil ist ueber alle Presets gleich und
# kuerzt sich beim Vergleich heraus.
#
# Ein echter 4K-Stream ist auf dieser Maschine uebrigens NICHT moeglich: der
# Sender skaliert nie hoch (ResolutionRequest::target_for, `.min(1.0)`), und der
# Bildschirm laeuft auf 1440p. Deshalb hier offline.
set -u
QUELLE=${1:?Quellvideo fehlt}
SEKUNDEN=${2:-20}
CODEC=${3:-av1_nvenc}

TMP=$(mktemp -d)
DMON_PID=""
aufraeumen() {
  [ -n "$DMON_PID" ] && kill "$DMON_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap aufraeumen EXIT

printf '%-10s %-10s %8s %10s %10s\n' Aufloesung Preset fps "enc %" "sm %"
for groesse in 2560:1440 3840:2160; do
  for preset in p1 p2 p4 p6; do
    dmon_log="$TMP/dmon.log"
    nvidia-smi dmon -s u -d 1 > "$dmon_log" 2>/dev/null &
    DMON_PID=$!
    sleep 1
    fps=$(ffmpeg -hide_banner -loglevel error -stats -hwaccel cuda \
          -hwaccel_output_format cuda -stream_loop -1 -i "$QUELLE" -t "$SEKUNDEN" \
          -vf "scale_cuda=$groesse" -c:v "$CODEC" -preset "$preset" -tune ll -rc cbr \
          -b:v 10000k -maxrate 10000k -g 120 -zerolatency 1 -delay 0 \
          -f null - 2>&1 | grep -oE 'fps=[ ]*[0-9.]+' | tail -1 | grep -oE '[0-9.]+')
    kill "$DMON_PID" 2>/dev/null
    DMON_PID=""
    # Die ersten zwei Zeilen sind Kopfzeilen, die erste Probe ist Aufbau.
    read -r enc sm <<< "$(awk 'NR>3 {e+=$4; s+=$2; n++} END {if(n) printf "%.1f %.1f", e/n, s/n}' "$dmon_log")"
    printf '%-10s %-10s %8s %10s %10s\n' "${groesse/:/x}" "$preset" "${fps:-?}" "${enc:-?}" "${sm:-?}"
  done
done
