#!/usr/bin/env bash
# Legt die Netzwerte der Fernsteuerungs-Teststrecke auf `lo` und faehrt den
# Puffer-Lauf darueber. Werte aus `docs/2026-07-21-remote-control-latenz-messung.md`:
# one-way 30 ms, Jitter-p95 ~11 ms, Verlust 0,14-0,29 %.
#
# NUR UDP wird getroffen (Filter auf ip protocol 17). Ohne den Filter laege
# alles ueber die Loopback-Schnittstelle in der Verzoegerung — Postgres, Redis
# und Vite eingeschlossen.
#
# Die Regel wird IMMER zurueckgenommen (trap), auch bei Strg-C.
#
#   ./remote-jitter-sim.sh 30ms 11ms 0.2% -- --secs 40 --label mit-stoerung
set -u

VERZUG="${1:-30ms}"; JITTER="${2:-11ms}"; VERLUST="${3:-0.2%}"
shift 3 2>/dev/null || true
[ "${1:-}" = "--" ] && shift

aufraeumen() { sudo tc qdisc del dev lo root 2>/dev/null; }
trap aufraeumen EXIT INT TERM
aufraeumen

sudo tc qdisc add dev lo root handle 1: prio || exit 1
# `rate` ist NICHT Kosmetik: ohne sie sortiert netem mit Jitter die Pakete um
# (ein spaeter gesendetes ueberholt ein frueheres). WebRTC liest Reordering als
# schwere Stoerung, die Bitrate kollabiert, und der Puffer-Wert schwankt dann
# zwischen zwei identischen Laeufen um den Faktor 7 (gemessen 2026-08-02).
# 10 Mbit ist zugleich der reale Uplink dieser Leitung.
sudo tc qdisc add dev lo parent 1:3 handle 30: netem \
  delay "$VERZUG" "$JITTER" distribution normal loss "$VERLUST" rate 10mbit || exit 1
sudo tc filter add dev lo protocol ip parent 1: prio 3 u32 \
  match ip protocol 17 0xff flowid 1:3 || exit 1
# IPv6 MUSS mit. Chromium nimmt ueber Loopback `::1`, nicht 127.0.0.1 — ohne
# diese Zeile sah netem 196 Pakete waehrend 3482 ankamen, und der Lauf zeigte
# unter "Stoerung" exakt die ungestoerten Werte (erster Prueflauf 2026-08-02).
sudo tc filter add dev lo protocol ipv6 parent 1: prio 4 u32 \
  match ip6 protocol 17 0xff flowid 1:3 || exit 1

echo "netem auf lo (nur UDP): delay $VERZUG +/- $JITTER, loss $VERLUST"
node "$(dirname "$0")/remote-jitter-sim.mjs" "$@"
RC=$?

# Nachweis, dass die Regel wirklich gegriffen hat — eine Messung ohne diesen
# Beleg misst moeglicherweise den Leerlauf (Lehre aus `verluststrecke.py`).
echo "--- tc -s (Nachweis) ---"
sudo tc -s qdisc show dev lo | sed -n '/netem/,+3p'
exit $RC
