#!/bin/sh
# Render MediaMTX config from template. Phase 6.A ships a minimal config —
# 6.B will overwrite with the full proxy + TLS-cert paths.
set -eu
TEMPLATE=/opt/pulse/templates/mediamtx.yml.template

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
