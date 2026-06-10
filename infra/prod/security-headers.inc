# Security-Headers für die Cloud-Instanz (howispulse.com) — Gegenstück zum
# header{}-Block im Self-Host-Caddyfile (infra/self-host/.../Caddyfile.template);
# beide synchron halten. Caddy vor uns setzt nur HSTS nicht automatisch für
# eigene Header-Policies, daher kommt alles aus dem Origin (diesem nginx).
#
# nginx-Falle: `add_header` wird NUR vererbt, wenn die Location selbst KEINE
# add_header-Direktive hat. Jede Location in web-nginx.conf, die eigene Header
# setzt (Cache-Control etc.), muss dieses Snippet deshalb explizit includen —
# sonst verliert genau sie die Security-Header (ausgerechnet index.html).
#
# Keine Content-Security-Policy hier: die CSP der App lebt als <meta>-Tag in
# web/src/app.html (deckt das Dokument ab); frame-ancestors — das einzige, was
# eine Meta-CSP nicht kann — übernimmt X-Frame-Options DENY.

add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
add_header X-Frame-Options DENY always;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy strict-origin-when-cross-origin always;
add_header Permissions-Policy "camera=(self), microphone=(self), display-capture=(self), geolocation=()" always;
