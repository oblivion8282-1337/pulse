#!/bin/bash
# Messreihe ueber Encoder-Einstellungen: Bildqualitaet gegen GPU-Last.
#
# Jede Variante faehrt einen echten Stream mit demselben Bildinhalt und
# derselben Bitrate; verglichen wird gegen den Encoder-EINGANG desselben Laufs.
# Das ist der Punkt: nicht Variante gegen Variante, sondern jede gegen ihr
# eigenes Original.
#
# Die Reihenfolge der Varianten ist bewusst gemischt und wird bei mehreren
# Durchlaeufen wiederholt — die Maschine ist nicht ueber Stunden identisch, und
# eine Reihe, die zufaellig mit der besten Variante endet, sieht besser aus als
# sie ist.
#
#   ./sweep-encoder.sh <inhalt.mp4> <kbps> <fps> [durchlaeufe]
set -u
cd "$(dirname "$0")"
INHALT=${1:?Bildinhalt fehlt}
KBPS=${2:-4000}
FPS=${3:-60}
RUNDEN=${4:-1}

# Name -> PULSE_ENCODER_OPTS. Leer = heutiger Stand.
VARIANTEN=(
  "heute:"
  "p2:preset=p2"
  "p6aq:preset=p6,spatial-aq=1,aq-strength=8"
  "p6aqmp:preset=p6,spatial-aq=1,aq-strength=8,multipass=qres"
)

echo "Inhalt $INHALT, ${KBPS} kbps, ${FPS} fps, $RUNDEN Durchlauf(e)"
printf '%-8s %8s %8s %8s %6s %6s %s\n' Variante VMAF PSNR SSIM enc% sm% Zuordnung

for runde in $(seq 1 "$RUNDEN"); do
  for eintrag in "${VARIANTEN[@]}"; do
    name=${eintrag%%:*}
    opts=${eintrag#*:}
    tag="sw-$name-$runde"
    rm -f "ref-$tag.raw"
    PULSE_ENCODER_OPTS="$opts" PULSE_DUMP_RAW_FRAMES=600 \
      timeout 400 ./real-harness.py --secs 16 --fps "$FPS" --kbps "$KBPS" \
      --quality --content "$INHALT" --label "$tag" > "sweep-$tag.log" 2>&1
    enc=$(grep "GPU enc" "sweep-$tag.log" | awk '{print $7}')
    sm=$(grep "GPU sm" "sweep-$tag.log" | awk '{print $7}')
    q=$(timeout 1800 python3 compare-quality.py --ref "ref-$tag.raw" \
          --rec "rec-$tag.mkv" --frames 100 2>&1)
    zu=$(grep -oE "[0-9]+ Bilder ueber [0-9]+ Referenzbilder" <<< "$q")
    vmaf=$(grep -oE "vmaf +Mittel +[0-9.]+" <<< "$q" | awk '{print $3}')
    psnr=$(grep -oE "psnr_y +Mittel +[0-9.]+" <<< "$q" | awk '{print $3}')
    ssim=$(grep -oE "float_ssim +Mittel +[0-9.]+" <<< "$q" | awk '{print $3}')
    printf '%-8s %8s %8s %8s %6s %6s %s\n' "$name" "${vmaf:-?}" "${psnr:-?}" \
           "${ssim:-?}" "${enc:-?}" "${sm:-?}" "${zu:-KEINE}"
    # Der Rohmitschnitt ist 6,6 GB — sofort weg, sonst ist die Platte nach
    # neun Varianten voll.
    rm -f "ref-$tag.raw"
  done
done
