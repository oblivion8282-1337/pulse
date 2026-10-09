#!/bin/sh
# pulse-livekit-node-ip — die öffentliche IPv4 als LiveKit-node_ip setzen.
#
#   pulse-livekit-node-ip <ipv4>             livekit.yaml umschreiben
#   pulse-livekit-node-ip <ipv4> --neustart  … und nur den LiveKit-Dienst neu starten
#   pulse-livekit-node-ip --zeige            gesetzte node_ip ausgeben (leer = keine)
#
# Warum es das gibt (Linux-Test 2026-10-08): Mit `use_external_ip: true`
# ermittelt LiveKit die öffentliche Adresse selbst per STUN — und schaltet
# dann für Browser, die laut LiveKit kein „prflx over relay" können (Firefox),
# fest auf „nur die öffentliche Adresse" um (pkg/rtc/transport.go, 1.13.3).
# Ein Firefox-Gast im selben Heimnetz wie der Server braucht damit Hairpin-NAT,
# das die Fritz!Box nicht kann → ICE scheitert. Mit fest vorgegebener
# `node_ip` bleibt NAT1To1IPs leer, die Sonderbehandlung greift nicht, und
# `advertise_internal_ip` kündigt LAN- UND öffentliche Adresse an.
#
# Preis: LiveKit folgt einem IP-Wechsel nicht mehr selbst — das tat es mit
# STUN aber auch nur beim Start. Die Server-App prüft die Adresse deshalb
# regelmäßig und ruft dieses Skript mit --neustart, wenn sie sich ändert.
#
# LIVEKIT_YAML überschreibt den Pfad (nur für Tests).
set -eu
DATEI="${LIVEKIT_YAML:-/etc/livekit/livekit.yaml}"

if [ "${1:-}" = "--zeige" ]; then
    sed -n 's|^  node_ip: \([0-9.]*\)$|\1|p' "$DATEI" | head -n1
    exit 0
fi

IP="${1:-}"
# Nur eine nackte IPv4 — der Wert landet per sed in einer YAML-Datei.
# Zwei Riegel: `case` weist jedes fremde Zeichen ab (auch Zeilenumbrüche —
# grep allein prüft zeilenweise und liesse „1.2.3.4⏎node_ip: …" durch).
case "$IP" in
    ''|*[!0-9.]*) IP_OK=0 ;;
    *) IP_OK=1 ;;
esac
if [ "$IP_OK" != 1 ] || ! printf '%s' "$IP" | grep -Eqx '([0-9]{1,3}\.){3}[0-9]{1,3}'; then
    echo "[livekit-node-ip] ungültige IPv4: '$IP'" >&2
    exit 2
fi

# Idempotent: alte node_ip und den STUN-Validierungsschalter entfernen,
# use_external_ip ausschalten, node_ip direkt dahinter neu setzen.
TMP="$(mktemp)"
sed \
    -e '/^  node_ip: /d' \
    -e '/^  skip_external_ip_validation: /d' \
    -e 's|^  use_external_ip: true$|  use_external_ip: false|' \
    "$DATEI" \
  | sed -e "s|^  use_external_ip: false\$|  use_external_ip: false\n  node_ip: ${IP}|" > "$TMP"
grep -q "^  node_ip: ${IP}\$" "$TMP" || {
    echo "[livekit-node-ip] 'use_external_ip' nicht gefunden — Datei unverändert" >&2
    rm -f "$TMP"
    exit 3
}
cat "$TMP" > "$DATEI"   # Inhalt ersetzen: Besitzer und Rechte der Datei bleiben
rm -f "$TMP"
echo "[livekit-node-ip] node_ip=${IP}"

if [ "${2:-}" = "--neustart" ]; then
    # s6-overlay legt seine Werkzeuge nach /command, nicht in den PATH von
    # `podman exec` — deshalb absolut.
    /command/s6-svc -r /run/service/livekit
    echo "[livekit-node-ip] LiveKit neu gestartet"
fi
