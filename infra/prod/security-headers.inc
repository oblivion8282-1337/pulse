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
# Content-Security-Policy als HEADER statt Meta-Tag (Security-Audit
# 2026-09-16): das Meta-Tag in app.html trug 'unsafe-inline'+'unsafe-eval'
# für script-src — und eine Meta-Policy kann durch keinen Header wieder
# gelockert werden; die unsicheren Einträge waren also auch in Produktion
# wirksam. Der Header hier ist die EINZIGE CSP der App (das Meta-Tag ist
# entfernt; der Dev-Server setzt seine eigene, grosszuegigere CSP via
# vite.config server.headers).
#
# 'unsafe-eval' ist GESTRICHEN (Svelte-Kompilat und der FOUC-Inline-Script
# brauchen es nicht — nur Vite-HMR tat es). 'wasm-unsafe-eval' ist dafür neu
# nötig: pulse-krypto läuft als WebAssembly, und CSP bindet WASM-Kompilierung
# an script-src (das schlanke CSP3-Schlüsselwort dafür, nicht eval).
# 'unsafe-inline' ist NUR in dieser Repo-Fassung drin: der Docker-Build
# (web/Dockerfile, Stage builder) ersetzt es per web/scripts/csp-hash.mjs
# gegen die sha256-Hashes der Inline-Scripts (FOUC-Guard + SvelteKit-
# Bootstrap) aus dem jeweils frischen index.html — der Hash wandert also
# mit jedem Build automatisch in den Header. Image-Fassung = ohne
# 'unsafe-inline'. Wer diese Datei ohne den Templating-Schritt deployed,
# fällt auf die Repo-Fassung zurück (Stand vor dem Security-Scan 2026-09-18).
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://www.youtube.com https://www.youtube-nocookie.com https://embed.twitch.tv; frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://player.twitch.tv https://embed.twitch.tv; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' ws: wss: https: stun: turn:; font-src 'self' data:; media-src 'self' blob: https:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" always;

add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
add_header X-Frame-Options DENY always;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy strict-origin-when-cross-origin always;
add_header Permissions-Policy "camera=(self), microphone=(self), display-capture=(self), geolocation=()" always;
