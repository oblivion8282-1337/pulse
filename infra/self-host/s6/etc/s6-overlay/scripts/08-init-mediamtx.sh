#!/bin/sh
# Render MediaMTX config from template. Phase 6.A ships a minimal config —
# 6.B will overwrite with the full proxy + TLS-cert paths.
set -eu
DATA="${PULSE_DATA_PATH:-/data}"
CERT_DIR="${DATA}/certs"
TEMPLATE=/opt/pulse/templates/mediamtx.yml.template

# Self-signed cert for MediaMTX RTMPS (rtmpsAddress :1936). Idempotent —
# only generated on first start. Self-host operators that want a real cert
# can drop their own ${CERT_DIR}/mediamtx.{crt,key} into the data volume.
mkdir -p "${CERT_DIR}"
chown pulse:pulse "${CERT_DIR}"
if [ ! -f "${CERT_DIR}/mediamtx.crt" ] || [ ! -f "${CERT_DIR}/mediamtx.key" ]; then
    echo "[08-init-mediamtx] generating self-signed RTMPS cert (10y)"
    openssl req -x509 -nodes -newkey rsa:2048 \
        -keyout "${CERT_DIR}/mediamtx.key" \
        -out    "${CERT_DIR}/mediamtx.crt" \
        -days   3650 \
        -subj   "/CN=${PULSE_HOSTNAME}" >/dev/null 2>&1
    chown pulse:pulse "${CERT_DIR}/mediamtx.crt" "${CERT_DIR}/mediamtx.key"
    chmod 0640 "${CERT_DIR}/mediamtx.crt" "${CERT_DIR}/mediamtx.key"
fi

if [ -f "${TEMPLATE}" ]; then
    sed -e "s|@@PULSE_HOSTNAME@@|${PULSE_HOSTNAME}|g" \
        "${TEMPLATE}" > /etc/mediamtx/mediamtx.yml
else
    # MVP fallback — RTMPS + WHEP + auth via the local hook
    cat > /etc/mediamtx/mediamtx.yml <<'EOF'
logLevel: info
logDestinations: [stdout]

api: yes
apiAddress: 127.0.0.1:9997

rtmp: yes
rtmpEncryption: optional
rtmpAddress: :1935
rtmpsAddress: :1936
rtmpServerCert: /data/certs/mediamtx.crt
rtmpServerKey: /data/certs/mediamtx.key

webrtc: yes
webrtcAddress: :8889
webrtcEncryption: no

hls: yes
hlsAddress: :8888
hlsAlwaysRemux: yes

authMethod: http
authHTTPAddress: http://127.0.0.1:8005
authHTTPExclude:
  - path: ^api/.*
  - path: ^metrics/.*
EOF
fi

chown pulse:pulse /etc/mediamtx/mediamtx.yml
chmod 0640 /etc/mediamtx/mediamtx.yml

echo "[08-init-mediamtx] /etc/mediamtx/mediamtx.yml rendered"
