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
        -subj   "/CN=${PULSE_HOSTNAME}" \
        -addext "subjectAltName=DNS:${PULSE_HOSTNAME}" >/dev/null 2>&1
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

# Schreibpuffer je Leser, in Paketen — wie infra/prod/mediamtx.yml (dort steht
# die Begruendung: der 512er-Default riss bei 60-fps-Streams mit FlexFEC schon
# bei halbsekuendigen Zuschauer-Stockern, "reader is too slow" → Ruckler).
writeQueueSize: 2048

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
# WebRTC/WHEP media plane: advertise a reachable ICE candidate. Without an
# explicit UDP port + host, MediaMTX offers only the container's internal
# bridge IPs and the WHEP connection never negotiates ("deadline exceeded").
webrtcLocalUDPAddress: :8189
webrtcIPsFromInterfaces: no

# HLS laeuft hier, ist aber von aussen fuer niemanden erreichbar: es gibt
# keine Caddy-Route auf :8888 (nur /whep → :8889), und der Port wird weder
# per EXPOSE noch von `build_run_args` veroeffentlicht. `hlsAlwaysRemux: yes`
# laesst den Muxer zusaetzlich auch ohne Zuschauer durchlaufen.
#
# Die Cloud hat HLS abgeschaltet (`hls: no` in `infra/prod/mediamtx.yml`, mit
# Begruendung). **Dieser Grund traegt hier NICHT**, und der Unterschied ist
# leicht zu uebersehen: die Cloud faehrt den Pulse-eigenen MediaMTX-FORK und
# setzt dort `PULSE_KEYFRAME_INTERVAL=0`, was den fest verdrahteten 2-s-Takt
# abschaltet — erst dadurch fehlen dem HLS-Muxer die Vollbilder. Diese
# Umgebungsvariable kennt nur der Fork (`infra/mediamtx-fork/patches/
# 0002-forward-viewer-keyframe-requests.patch`). Der Self-Host-Container laedt
# dagegen das UNGEPATCHTE Upstream-Binary von GitHub (Dockerfile, MEDIAMTX_
# VERSION) — der 2-s-Takt bleibt hier also an, und die Absturzursache der Cloud
# kann gar nicht eintreten.
#
# Was hier stattdessen zutrifft, ist UNGEMESSEN. Naheliegend waere das andere
# in der Wurzel-`CLAUDE.md` beschriebene Problem (sichtbares Pumpen im
# 2-s-Takt, weil der Takt dauernd Vollbilder anfordert), aber das ist auf
# einem Self-Host niemand nachgefahren.
#
# Bewusst NICHT geaendert: HLS abzuschalten waere eine Verhaltensaenderung am
# ausgelieferten Container und braucht einen eigenen Durchgang mit eigener
# Messung. Wer hier vorbeikommt, entscheidet es — mit Zahlen, nicht mit dieser
# Notiz.
hls: yes
hlsAddress: :8888
hlsAlwaysRemux: yes

authMethod: http
authHTTPAddress: http://127.0.0.1:8005
authHTTPExclude:
  - action: api
  - action: metrics
  - action: pprof

# Pulse HQ channel streams use DYNAMIC paths (channel-<id>-<uid>-<nonce>).
# MediaMTX rejects any path not listed here as "not configured" → without this
# catch-all EVERY publish is refused and the HQ push dies silently (no error).
# The auth hook (authMethod: http) still allows/denies each connection per
# path + token; this only lets MediaMTX accept the dynamic path names at all.
# Mirrors infra/prod/mediamtx.yml.
paths:
  all_others:
EOF
    # ICE-Kandidaten: hier trennen sich VPS-Self-Host und App-Hosting.
    # Angehängt nach dem Heredoc, weil der Block gequotet ist (keine Expansion).
    #
    # App-Hosting-Erkennung: explizit via PULSE_HOST_ORIGIN (app_host | vps,
    # von der Desktop-Server-App in container.env gesetzt) mit Vorrang; die
    # alte Token-Heuristik bleibt nur als Fallback für Bestands-Container —
    # ohne Relay-Provisioning (PULSE_RELAY_PROVISION_ENABLED=false) gibt es
    # keinen Token mehr, App-Host bleibt App-Host.
    _is_app_host=false
    case "${PULSE_HOST_ORIGIN:-}" in
        app_host) _is_app_host=true ;;
        vps) _is_app_host=false ;;
        *) [ -n "${PULSE_RELAY_TUNNEL_TOKEN:-}" ] && _is_app_host=true ;;
    esac
    if [ "$_is_app_host" = true ]; then
        # ---- App-Hosting (Server-App auf dem Gerät des Users, hinter Heim-NAT) ----
        # Der Hostname zeigt hier auf den Relay (= die Cloud), NICHT auf dieses
        # Gerät: ein Zuschauer schickte seine Videopakete an den falschen
        # Rechner. Es gibt auch keine öffentliche Adresse, die man eintragen
        # könnte — die Heim-IP wechselt. Also lässt MediaMTX sie sich per STUN
        # selbst sagen (srflx-Kandidat) und locht damit durch das NAT, genau
        # wie LiveKit (use_external_ip) und der direct-adapter.
        #
        # 0.0.0.0 statt :8189 bindet den ICE-Port auf IPv4. Mit Dual-Stack
        # funkte MediaMTX an die IPv6-Adresse des Zuschauers, die kein Heim-
        # Router von außen hereinlässt — 312 Pakete raus, 0 zurück (gemessen
        # 2026-07-10). Derselbe IPv6-Fallstrick wie beim WHEP-Reconnect der Cloud.
        #
        # webrtcIPsFromInterfaces MUSS an bleiben: MediaMTX bricht sonst mit
        # "at least one between 'webrtcIPsFromInterfaces' or
        # 'webrtcAdditionalHosts' must be filled" ab — STUN allein zählt ihm
        # nicht als Kandidatenquelle. Liefert zusätzlich den LAN-Kandidaten
        # für Zuschauer im selben Netz.
        sed -i -e 's|^webrtcLocalUDPAddress: :8189$|webrtcLocalUDPAddress: 0.0.0.0:8189|' \
               -e 's|^webrtcIPsFromInterfaces: no$|webrtcIPsFromInterfaces: yes|' \
            /etc/mediamtx/mediamtx.yml
        {
            printf 'webrtcICEServers2:\n'
            for stun in ${PULSE_DIRECT_STUN_SERVERS:-stun.l.google.com:19302}; do
                printf '  - url: stun:%s\n' "${stun}"
            done
        } >> /etc/mediamtx/mediamtx.yml
    else
        # ---- VPS-Self-Host: öffentlich erreichbar, der Hostname IST der Server ----
        # Der einzige brauchbare Host-Kandidat ist der öffentliche Hostname —
        # die Interface-IPs des Containers sind interne Bridge-Adressen.
        printf 'webrtcAdditionalHosts: [%s]\n' "${PULSE_HOSTNAME}" >> /etc/mediamtx/mediamtx.yml
    fi
fi

chown pulse:pulse /etc/mediamtx/mediamtx.yml
chmod 0640 /etc/mediamtx/mediamtx.yml

echo "[08-init-mediamtx] /etc/mediamtx/mediamtx.yml rendered"
