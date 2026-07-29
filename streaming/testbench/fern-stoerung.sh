#!/bin/bash
# Stoerung auf den EMPFANGSWEG einer echten Strecke — lokal, nicht am Server.
#
# Warum lokal: die Pakete Server->Zuschauer sind bei uns EINGEHEND, und
# eingehender Verkehr laesst sich nur ueber eine Umleitung auf ein `ifb`-Geraet
# verzoegern oder verwerfen. Der Effekt ist derselbe wie ein Verlust unterwegs,
# aber der Eingriff bleibt auf dieser Maschine. Auf dem Testserver laufen
# fremde Dienste; dort `tc` aufzulegen traefe sie mit.
#
# Warum gefiltert: ohne Filter auf die Quelladresse traefe die Stoerung JEDEN
# eingehenden Verkehr — auch die SSH-Sitzung, ueber die man gerade arbeitet.
# Der RTMPS-Push zum Server bleibt ohnehin unberuehrt, der ist ausgehend.
#
#   ./fern-stoerung.sh an  buendel     # Gilbert-Elliott, Klumpen
#   ./fern-stoerung.sh an  gleich      # gleichmaessiger Verlust, Vergleichsfall
#   ./fern-stoerung.sh aus
#   ./fern-stoerung.sh zeigen          # wirkte sie? Zaehler ablesen
#
# Die Wirkung IMMER nachlesen (`zeigen`), bevor ein Ergebnis gedeutet wird:
# `netem loss 5% 50%` etwa wird anstandslos gesetzt und verwirft NICHTS.
set -u

SERVER_IP="${PULSE_FERN_IP:-77.42.71.166}"
IFACE="${PULSE_FERN_IFACE:-$(ip route get "$SERVER_IP" | grep -oP 'dev \K\S+' | head -1)}"

case "${2:-buendel}" in
  # p, r, 1-h, 1-k: Uebergang gut->schlecht, zurueck, Verlust im schlechten,
  # Verlust im guten Zustand. Mittlere Klumpenlaenge 1/r = 2,5 Pakete.
  buendel) NETEM=(loss gemodel 2% 40% 100% 0%) ;;
  gleich)  NETEM=(loss 5%) ;;
  *) echo "unbekanntes Profil: $2" >&2; exit 1 ;;
esac

aufraeumen() {
  sudo tc qdisc del dev "$IFACE" ingress 2>/dev/null
  sudo tc qdisc del dev ifb0 root 2>/dev/null
  sudo ip link set ifb0 down 2>/dev/null
}

case "${1:-}" in
  an)
    aufraeumen
    sudo modprobe ifb numifbs=1 || exit 1
    sudo ip link set ifb0 up || exit 1
    sudo tc qdisc add dev "$IFACE" handle ffff: ingress || exit 1
    sudo tc filter add dev "$IFACE" parent ffff: protocol ip prio 1 u32 \
      match ip src "$SERVER_IP"/32 \
      action mirred egress redirect dev ifb0 || exit 1
    sudo tc qdisc add dev ifb0 root netem "${NETEM[@]}" || exit 1
    echo "Stoerung '$2' liegt auf eingehendem Verkehr von $SERVER_IP ueber $IFACE"
    ;;
  aus)
    aufraeumen
    echo "Stoerung entfernt"
    ;;
  zeigen)
    sudo tc -s qdisc show dev ifb0 | grep -A1 netem
    ;;
  *)
    echo "Aufruf: $0 {an|aus|zeigen} [buendel|gleich]" >&2
    exit 1
    ;;
esac
