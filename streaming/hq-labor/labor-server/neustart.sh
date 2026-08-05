#!/bin/bash
# Labor-MediaMTX mit den uebergebenen Schaltern neu anlegen.
#   ./neustart.sh                        Vorgabe: FlexFEC 10+2, nicht adaptiv
#   ./neustart.sh PULSE_FLEXFEC_ADAPTIV=1
#   ./neustart.sh PULSE_FLEXFEC=0        ohne Paritaet
#
# SEIT 2026-08-04 laeuft hier DAS AUSGELIEFERTE IMAGE, nicht mehr ein von Hand
# hierher kopiertes Binary.
#
# Warum das der Unterschied ist, auf den es ankommt: vorher lag unter
# ~/mediamtx-labor/ ein Binary (`mediamtx`, daneben `mediamtx.fecfix`,
# `mediamtx.adaptiv`, `mediamtx.diag`, `mediamtx.vor-*`), das jemand einmal
# gebaut und hochgeladen hatte. Was genau darin steckte, stand nirgends —
# der Dateiname war die ganze Dokumentation. Gemessen wurde also an einem
# Stand, von dem niemand belegen konnte, dass er dem entspricht, was spaeter
# in die Produktion geht.
#
# Jetzt laeuft exakt das Image aus `infra/mediamtx-fork/` (Patches 0001-0005),
# dasselbe, das der Dev-Stack faehrt und das `infra/prod/docker-compose.yml`
# pinnt. Neu einspielen von der Entwicklungsmaschine:
#
#   docker save pulse-mediamtx:1.19.1-pulse2 | gzip | ssh pulse-test 'gunzip | docker load'
#   ssh pulse-test 'docker tag localhost/pulse-mediamtx:1.19.1-pulse2 pulse-mediamtx:1.19.1-pulse2'
#
# Das `localhost/`-Praefix entsteht, weil die Entwicklungsmaschine podman
# fahrt und dessen `save` den Namen voll qualifiziert. Ohne das Nachtaggen
# sucht Docker hier eine Registry und scheitert mit "pull access denied".
#
# Der Rueckweg auf das alte Binary liegt als `neustart.sh.binary-alt` daneben.
set -e
cd ~/mediamtx-labor

IMAGE="${PULSE_MEDIAMTX_IMAGE:-pulse-mediamtx:1.19.1-pulse2}"

ENV_ARGS=(-e PULSE_KEYFRAME_INTERVAL=0 -e PULSE_FLEXFEC=1 -e PULSE_FLEXFEC_MEDIA=10 -e PULSE_FLEXFEC_FEC=2)
for kv in "$@"; do ENV_ARGS+=(-e "$kv"); done
docker rm -f mediamtx-labor >/dev/null 2>&1 || true
docker run -d --name mediamtx-labor --restart unless-stopped \
  -p 1935:1935 -p 1936:1936 -p 8888:8888 -p 8889:8889 -p 8189:8189/udp -p 7890:7890/udp -p 127.0.0.1:9997:9997 \
  "${ENV_ARGS[@]}" \
  -v ~/mediamtx-labor/mediamtx.yml:/mediamtx.yml:ro \
  -v ~/mediamtx-labor/certs:/certs:ro \
  "$IMAGE" /mediamtx.yml >/dev/null
sleep 3
echo "laeuft mit: ${ENV_ARGS[*]}"
echo "Image:      $IMAGE"
docker logs mediamtx-labor 2>&1 | head -1
