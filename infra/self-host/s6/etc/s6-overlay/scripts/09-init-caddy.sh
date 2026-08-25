#!/bin/bash
# 07-init-caddy.sh — Caddyfile für TLS-Modus vorbereiten.
# Wird von s6-overlay als cont-init.d-Script beim Container-Start ausgeführt,
# bevor der Caddy-Service hochfährt.
#
# PULSE_TLS_MODE=auto (Default): Caddy holt Let's Encrypt-Cert automatisch.
#   Voraussetzung: Port 80 + 443 öffentlich erreichbar, DNS-A-Record korrekt.
# PULSE_TLS_MODE=provided: Cert aus /data/certs/{cert.pem,key.pem} —
#   für Hoster ohne Public-Reach (Tailscale, internes Netz, Cloudflare Tunnel).
# PULSE_TLS_MODE=behind-proxy: KEIN TLS im Container. Der interne Caddy macht nur
#   HTTP-Routing auf PULSE_HTTP_PORT (Default 8080). TLS terminiert ein vorhandener
#   externer Reverse-Proxy (Caddy/nginx/Traefik/Cloudflare-Tunnel). Für geteilte
#   Hosts, auf denen 80/443 schon belegt sind. Der Admin braucht nur EINE Proxy-
#   Regel: pulse.domain → http://<container>:PULSE_HTTP_PORT (WS inklusive).

set -euo pipefail

TEMPLATE="/etc/caddy/Caddyfile.template"
TARGET="/etc/caddy/Caddyfile"
TLS_MODE="${PULSE_TLS_MODE:-auto}"
HTTP_PORT="${PULSE_HTTP_PORT:-8080}"

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
    # Escaping als Zeichenklasse [\$] (wie im behind-proxy-Zweig unten) — ein
    # einzelner Backslash vor $PULSE_HOSTNAME wurde von bash zum WERT expandiert,
    # der Treffer schlug dadurch still fehl (sed-Exit 0, Datei unverändert).
    sed -i "/{[\$]PULSE_HOSTNAME} {/a\\
${TLS_LINE}" "$TARGET"
    if ! grep -qF "$CERT" "$TARGET"; then
        echo "[07-init-caddy] FEHLER: TLS-Zeile konnte nicht eingefügt werden." >&2
        exit 1
    fi
    echo "[07-init-caddy] Verwende bereitgestelltes Cert: ${CERT}"
elif [[ "$TLS_MODE" == "behind-proxy" ]]; then
    # Site-Adresse Hostname → ":PORT" umschreiben. Eine reine Port-Site ist in
    # Caddy immer HTTP-only (kein ACME, kein 443). Das Routing (alle handle-Blöcke)
    # bleibt unverändert — nur die TLS-Terminierung entfällt.
    sed -i "s|{[\$]PULSE_HOSTNAME} {|:${HTTP_PORT} {|" "$TARGET"
    if ! grep -q "^:${HTTP_PORT} {" "$TARGET"; then
        echo "[07-init-caddy] FEHLER: Site-Adresse konnte nicht auf :${HTTP_PORT} umgeschrieben werden." >&2
        exit 1
    fi
    echo "[07-init-caddy] HTTP-only auf :${HTTP_PORT} — TLS macht der externe Reverse-Proxy."
    echo "[07-init-caddy] Proxy-Regel beim Admin: pulse.domain → http://<container>:${HTTP_PORT}"
elif [[ "$TLS_MODE" == "auto" ]]; then
    # auto — nichts zu tun, Caddy macht ACME selbst.
    echo "[07-init-caddy] Let's Encrypt Auto-TLS aktiv (ACME via PULSE_ADMIN_EMAIL)."
    echo "[07-init-caddy] DNS-A-Record muss VOR dem ersten Start auf diese IP zeigen."
else
    echo "[07-init-caddy] FEHLER: unbekannter PULSE_TLS_MODE='${TLS_MODE}'." >&2
    echo "[07-init-caddy] Erlaubt: auto | provided | behind-proxy" >&2
    exit 1
fi

echo "[07-init-caddy] Caddyfile bereit: ${TARGET}"
