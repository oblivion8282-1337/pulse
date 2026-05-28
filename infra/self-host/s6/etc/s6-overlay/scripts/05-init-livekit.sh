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

chown pulse:pulse /etc/livekit/livekit.yaml
chmod 0640 /etc/livekit/livekit.yaml

echo "[05-init-livekit] /etc/livekit/livekit.yaml rendered"
