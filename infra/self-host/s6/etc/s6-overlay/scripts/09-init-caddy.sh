#!/bin/bash
# 07-init-caddy.sh — Caddyfile für TLS-Modus vorbereiten.
# Wird von s6-overlay als cont-init.d-Script beim Container-Start ausgeführt,
# bevor der Caddy-Service hochfährt.
#
# PULSE_TLS_MODE=auto (Default): Caddy holt Let's Encrypt-Cert automatisch.
#   Voraussetzung: Port 80 + 443 öffentlich erreichbar, DNS-A-Record korrekt.
# PULSE_TLS_MODE=provided: Cert aus /data/certs/{cert.pem,key.pem} —
#   für Hoster ohne Public-Reach (Tailscale, internes Netz, Cloudflare Tunnel).

set -euo pipefail

TEMPLATE="/etc/caddy/Caddyfile.template"
TARGET="/etc/caddy/Caddyfile"
TLS_MODE="${PULSE_TLS_MODE:-auto}"

echo "[07-init-caddy] TLS-Modus: ${TLS_MODE}"

# Caddyfile aus Template erzeugen
cp "$TEMPLATE" "$TARGET"

if [[ "$TLS_MODE" == "provided" ]]; then
    CERT="/data/certs/cert.pem"
    KEY="/data/certs/key.pem"

    if [[ ! -f "$CERT" || ! -f "$KEY" ]]; then
        echo "[07-init-caddy] FEHLER: PULSE_TLS_MODE=provided aber Cert-Dateien fehlen."
        echo "[07-init-caddy] Erwartet: ${CERT} und ${KEY}"
        echo "[07-init-caddy] Lege /data/certs/ als Volume an und kopiere Cert + Key hinein."
        exit 1
    fi

    # TLS-Direktive in den Site-Block einfügen (nach der öffnenden Klammer der Site).
    # Caddy liest `tls /pfad/cert.pem /pfad/key.pem` als explizites Cert.
    TLS_LINE="    tls ${CERT} ${KEY}"
    # Einfügen nach der Zeile '{$PULSE_HOSTNAME} {'
    sed -i "/{\\$PULSE_HOSTNAME} {/a\\\\n${TLS_LINE}" "$TARGET"
    echo "[07-init-caddy] Verwende bereitgestelltes Cert: ${CERT}"
else
    # auto — nichts zu tun, Caddy macht ACME selbst.
    echo "[07-init-caddy] Let's Encrypt Auto-TLS aktiv (ACME via PULSE_ADMIN_EMAIL)."
    echo "[07-init-caddy] DNS-A-Record muss VOR dem ersten Start auf diese IP zeigen."
fi

echo "[07-init-caddy] Caddyfile bereit: ${TARGET}"
