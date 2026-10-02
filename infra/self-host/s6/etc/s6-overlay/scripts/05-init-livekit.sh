#!/bin/sh
# Render /etc/livekit/livekit.yaml from the template + the generated key-pair.
set -eu
DATA="${PULSE_DATA_PATH:-/data}"
KEYS="${DATA}/jwt_keys"
TEMPLATE=/opt/pulse/templates/livekit.yaml.template

if [ ! -f "${TEMPLATE}" ]; then
    echo "[05-init-livekit] WARN: ${TEMPLATE} missing (Phase 6.B not applied)"
    # Fall back to a minimal config so the longrun unit doesn't crash on
    # missing config — health gating will catch the real misconfig.
    cat > /etc/livekit/livekit.yaml <<EOF
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 7882
  port_range_end: 7892
log_level: info
keys:
  $(cat "${KEYS}/livekit.key"): "$(cat "${KEYS}/livekit.secret")"
webhook:
  api_key: $(cat "${KEYS}/livekit.key")
  urls:
    - http://127.0.0.1:8003/webhook
EOF
else
    LIVEKIT_KEY=$(cat "${KEYS}/livekit.key")
    LIVEKIT_SECRET=$(cat "${KEYS}/livekit.secret")
    sed \
        -e "s|@@LIVEKIT_KEY@@|${LIVEKIT_KEY}|g" \
        -e "s|@@LIVEKIT_SECRET@@|${LIVEKIT_SECRET}|g" \
        -e "s|@@PULSE_HOSTNAME@@|${PULSE_HOSTNAME}|g" \
        "${TEMPLATE}" > /etc/livekit/livekit.yaml
fi

# VM-App-Host (Windows/podman-machine): der Container läuft mit --network host
# IN der VM — LiveKit sieht nur die VM-interne Adresse (172.x) und per STUN
# höchstens die WAN-Adresse hinter WSL-Doppel-NAT. Kein LAN-/Internet-Gerät
# kommt an einen der beiden durch (Windows-Voice-Fall 2026-10-01). Deshalb:
# STUN aus, und die vom Server-App-Host ermittelte Host-LAN-IP als node_ip
# ankündigen — pion schreibt damit die Kandidaten-IP um, die Ports bleiben.
# Der Medienweg läuft über die Host-UDP-Relays (7900/7882-7892/8189), die an
# genau dieser Adresse lauschen. Linux-App-Hosts setzen die Variable nicht
# (dort deckt use_external_ip den Internetweg, live bewiesen) → kein Patch.
if [ -n "${PULSE_VM_ANNOUNCE_IP:-}" ]; then
    sed -i \
        -e 's|^  use_external_ip: true$|  use_external_ip: false|' \
        -e "s|^  skip_external_ip_validation: true\$|  node_ip: ${PULSE_VM_ANNOUNCE_IP}|" \
        /etc/livekit/livekit.yaml
    echo "[05-init-livekit] VM-Betrieb: node_ip=${PULSE_VM_ANNOUNCE_IP}, use_external_ip aus"
fi

chown pulse:pulse /etc/livekit/livekit.yaml
chmod 0640 /etc/livekit/livekit.yaml

echo "[05-init-livekit] /etc/livekit/livekit.yaml rendered"
