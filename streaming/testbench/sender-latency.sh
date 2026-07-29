#!/bin/bash
# Misst den Weg vom Encoder-EINGANG bis auf die LEITUNG — den letzten Abschnitt
# der Kette, der bisher nur als Rest einer Subtraktion bekannt war.
#
# Verfahren: dem Sender mitten im Lauf eine kurze Pause aufzwingen
# (SIGSTOP/SIGCONT). Die Pause hinterlaesst zwei Spuren:
#
#   * in der `.pts`-Liste (Wanduhr je Bild am Encoder-Eingang) eine Luecke,
#   * im Paketmitschnitt auf der Leitung (TCP 1936) ebenfalls eine.
#
# Die zweite beginnt spaeter als die erste — genau um das, was zwischen
# Encoder-Eingang und Socket liegt (Encode + Muxen + Verschachteln + TLS).
# Beide Uhren sind dieselbe Wanduhr, es braucht also keine Zuordnung ueber
# Inhalte.
#
# Der Zeitpunkt der Pause muss INNERHALB des Rohmitschnitts liegen (180 Bilder,
# rund 3 s) — deshalb wird auf das Erscheinen der .raw-Datei gewartet und dann
# eine Sekunde zugegeben, statt blind zu schlafen.
#
# EINSCHRAENKUNG (methodisch untauglich fuer den urspruenglichen Zweck):
# SIGSTOP friert den GANZEN Sender-Prozess ein, also Aufnahme UND Muxer/
# Schreiber gleichzeitig. Beide Luecken beginnen deshalb zwangslaeufig
# zusammen, unabhaengig davon, wie tief ein Puffer dazwischen ist — die
# Differenz zwischen ihnen sagt darum NICHTS ueber Encoder->Leitung aus.
# Brauchbar bleibt das Skript fuer den Vergleich MediaMTX-intern: Luecke am
# TCP-Eingang (Sender-Push) gegen Luecke am UDP-Ausgang (WHEP-Empfang).
set -u
cd "$(dirname "$0")"
SP=/tmp/claude-1000/-home-michael-Dokumente-Pulse/2ca954ad-bc22-4d0b-9c02-777d529cd328/scratchpad
TAG=${1:-senderlat}

rm -f "ref-$TAG.raw" "ref-$TAG.pts"
sudo -n tcpdump -i lo -n -s 96 -B 16384 -w "$SP/cap-$TAG.pcap" 'tcp port 1936 or udp port 8189' >/dev/null 2>&1 &
sleep 1.2

# `--e2e` MUSS mitlaufen: nur dann zeigt das Zeitmuster, und nur dann liefert
# derselbe Lauf ALLE Posten der Kette — Anzeige->Encoder (dump-latency.py aus
# dem Rohmitschnitt), Encoder->Leitung (die Luecke hier) und Ende zu Ende.
# Aus verschiedenen Laeufen zusammengesetzte Posten haben sich als Falle
# erwiesen: die Werte schwanken je Lauf genug, um eine Luecke vorzutaeuschen.
PULSE_MUX_LATENCY_LOG=1 timeout 300 ./real-harness.py --secs 16 --fps 60 --kbps 4000 \
    --quality --e2e --label "$TAG" >/dev/null 2>&1 &
HARNESS=$!

# Auf den Beginn des Rohmitschnitts warten, dann in seine Mitte zielen.
for _ in $(seq 1 120); do
    [ -s "ref-$TAG.raw" ] && break
    sleep 0.5
done
sleep 1.0
SC=$(pgrep -n -f pulse-linux-hq-sidecar)
if [ -n "$SC" ]; then
    kill -STOP "$SC"; sleep 0.15; kill -CONT "$SC"
    echo "Pause gesetzt"
else
    echo "Sender nicht gefunden — Pause ausgefallen" >&2
fi

wait $HARNESS
sleep 1
sudo -n pkill -INT tcpdump
sleep 2
sudo -n chown michael:michael "$SP/cap-$TAG.pcap"
echo "fertig: $SP/cap-$TAG.pcap + ref-$TAG.pts"
