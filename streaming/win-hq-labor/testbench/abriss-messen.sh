#!/bin/bash
# Endet eine Zuschauer-Sitzung von selbst -- und wenn ja, warum?
#
# WARUM ES DAS GIBT, UND WARUM ALS BASH STATT ALS .ps1: Der Fehler vom
# 2026-08-06 ("der Zuschauer fliegt nach zwei bis drei Minuten aus dem Stream")
# war ohne ZEITSTEMPEL an jeder Zeile nicht zu lesen. Beide Programme schreiben
# nach stderr, die Ursache und ihre Wirkung liegen 0,3 Sekunden auseinander, und
# `hdr-ansehen.ps1` liest stderr erst am Ende in einem Stueck -- danach ist die
# Reihenfolge zwischen den beiden Stroemen nicht mehr rekonstruierbar. Genau
# daran ist die Suche zuerst gescheitert: die einzige sichtbare Zeile war
# `Track video/AV1 beendet: DataChannel is not opened`, also die WIRKUNG des
# eigenen `close()` -- und die sieht wie ein Fehler in webrtc-rs aus.
# Messakte: streaming/testbench/profiles/player-2026-08-06-zuschauer-fliegt-nach-zwei-minuten.json
#
# ZWEI DINGE, OHNE DIE DER LAUF NICHTS ZEIGT:
#
#  1. BEWEGUNG AUF DEM SCHIRM. Bei ruhendem Bild liefert die WGC-Aufnahme kaum
#     Bilder, der Encoder erzeugt fast nichts, und die Kette laeuft im Leerlauf.
#     Zwei 300-Sekunden-Laeufe mit ruhendem Schirm -- einer davon mit exakt der
#     Einstellung, unter der es sonst abbricht -- liefen ohne jeden Vorfall
#     durch. Also vorher eine Vollbildseite mit animierten Flaechen oeffnen.
#  2. DAUER UEBER 180 SEKUNDEN. Die Vorgabe von `hdr-ansehen.ps1` sind 90
#     Sekunden; alle beobachteten Abbrueche lagen darueber (134 bis 178 s).
#     Deshalb hat der Fehler wochenlang niemand gesehen.
#
# Die Sitzungszeiten des Servers sind die unabhaengige zweite Quelle -- wer
# behauptet, "die Verbindung ist abgerissen", muss dort nachsehen:
#   ssh pulse-test 'docker logs --since 20m mediamtx-labor' | grep session
#
# AUFRUF (aus einer Git-Bash):
#   bash abriss-messen.sh [sekunden] [pfad] [codec] [bits] [fps] [kbps] [aufloesung] [hdr]
#   bash abriss-messen.sh 420                          # Vorgabe: 10 bit HDR, 12000 kbps
#   bash abriss-messen.sh 300 hdr-ansehen-sdr av1 8 60 8000 1080p false
#
# Die beiden Protokolle landen in $OUT (Vorgabe: neben diesem Skript).
set -u
SEK=${1:-420}
PFAD=${2:-hdr-ansehen-hdr}
CODEC=${3:-av1}
BITS=${4:-10}
FPS=${5:-60}
BR=${6:-12000}
RES=${7:-1080p}
HDR=${8:-true}

SP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABOR="$(dirname "$SP")"
WURZEL="$(cd "$LABOR/../.." && pwd)"
FFBIN="$LABOR/ffmpeg-patched/bin"
SIDE="$WURZEL/streaming/win-hq-sidecar/target/release/pulse-win-hq-sidecar.exe"
PLAYER="$WURZEL/streaming/pulse-player/target/release/pulse-player.exe"
OUT=${OUT:-$SP}

for p in "$SIDE" "$PLAYER"; do
  [ -x "$p" ] || { echo "fehlt: $p  (cargo build --release)" >&2; exit 1; }
done
TOKDATEI="$SP/fern_token.txt"
[ -r "$TOKDATEI" ] || { echo "Messstand-Token fehlt: $TOKDATEI" >&2; exit 1; }
TOK=$(tr -d '\r\n' < "$TOKDATEI")
BASIS="https://pulse.unicutmedia.com/whep/$PFAD"

# Zur LAUFZEIT noetig, sonst bricht Windows mit 0xC0000135 ab, bevor eine Zeile
# Code laeuft (s. streaming/win-hq-labor/CLAUDE.md).
export PATH="$FFBIN:$PATH"
# Ohne die Statistikzeile steht im Protokoll nichts darueber, ob der Lauf bis
# zum Abbruch gesund war -- und genau das ist die Frage.
export PULSE_PLAYER_STATS_LOG=1

T0=$(date +%s.%N)
# Perl statt awk: `Time::HiRes` gibt Bruchteile einer Sekunde ohne einen
# Unterprozess je Zeile, und `$|=1` haelt die Reihenfolge der beiden Stroeme.
stempel() { PULSE_T0="$T0" perl -MTime::HiRes=time -ne 'BEGIN{$|=1} printf "%8.2f %s", time-$ENV{PULSE_T0}, $_'; }

echo "T0=$(date +%H:%M:%S)  $PFAD  $CODEC ${BITS}bit ${RES}@${FPS} ${BR}kbps hdr=$HDR  ${SEK}s"

# stdin OFFEN halten (`sleep` dahinter): kaeme die Anfrage aus einer Datei,
# saehe der Sidecar nach der letzten Zeile EOF und faehrt korrekt herunter --
# mitten im Verbindungsaufbau. Von aussen sieht das wie ein Netzproblem aus.
SREQ="{\"op\":\"start\",\"id\":1,\"channel\":{\"id\":\"1\",\"token\":\"\",\"push_url\":\"$BASIS/whip?token=$TOK\"},\"capture\":\"monitor\",\"audio\":{\"mode\":\"Aus\"},\"overrides\":{\"codec\":\"$CODEC\",\"bit_depth\":$BITS,\"bitrate_kbps\":$BR,\"fps\":$FPS,\"resolution\":\"$RES\"$( [ "$HDR" = true ] && echo ',"hdr":true')}}"
{ printf '%s\n' "$SREQ"; sleep $((SEK+30)); } | "$SIDE" 2> >(stempel > "$OUT/abriss-sender.log") > /dev/null &
sleep 7

PREQ="{\"op\":\"open\",\"id\":1,\"url\":\"$BASIS/whep?token=$TOK\",\"title\":\"Abriss-Messung\"}"
{ printf '%s\n' "$PREQ"; sleep $((SEK+30)); } | "$PLAYER" 2> >(stempel > "$OUT/abriss-player.log") > /dev/null &

sleep "$SEK"
taskkill //F //IM pulse-player.exe > /dev/null 2>&1
sleep 1
taskkill //F //IM pulse-win-hq-sidecar.exe > /dev/null 2>&1
sleep 2

echo "=== Was die Sitzung beendet hat (leer = sie lief durch) ==="
# `Sitzung endet` steht seit dem 2026-08-06 VOR dem `close()` und nennt den
# Grund; alles danach ist Folge. Token koennen in Fehlertexten stehen.
grep -E "Sitzung endet|Neuaufbau|wird aufgegeben|Zustand nach|Track .* beendet|abgerissen" \
  "$OUT/abriss-player.log" | sed -E 's/token=[^ &"]+/token=WEG/g'
echo "=== Protokolle: $OUT/abriss-player.log  $OUT/abriss-sender.log ==="
