# syntax=docker/dockerfile:1
#
# Pulse web image: builds the SvelteKit SPA (adapter-static → web/build/) and
# serves it with nginx, which also reverse-proxies /api/*, /whep/*, /hls/* and
# /livekit/* to the backend (see infra/prod/web-nginx.conf).
#
# Build from the repo root:  docker build -f web/Dockerfile -t pulse-web .

# ── wasm-builder ─────────────────────────────────────────────────────────────
# Krypto-Kern (`krypto/pulse-krypto/`) als WASM-Paket — `pkg/` ist ein
# Bauergebnis und gitignored (krypto/pulse-krypto/.gitignore), landet also nie
# im Build-Kontext. web/src/lib/krypto/{account.svelte,sitzungen,empfangen,
# veroeffentlichen}.ts importieren es STATISCH und obenauf, und veroeffent-
# lichen.ts wiederum aus identity/issue-flow.ts + cert-rotation.svelte.ts —
# dem normalen Login-/Zertifikatspfad, nicht hinter einem Feature-Flag. Ohne
# diese Stage bricht `pnpm --filter @dcc/web build` mit UNRESOLVED_IMPORT.
# Eigene, schlanke Stage statt eines Rust-Toolchains im Node-Builder — die
# Laufzeit-Stage (nginx) bekommt dadurch keinen Rust-Toolchain zu Gesicht.
FROM rust:1-slim-bookworm AS wasm-builder
# Version gepinnt wie ueberall sonst im Baum (pnpm@10.33.0 drei Zeilen
# weiter, electron 43.0.0, mediamtx 1.19.1-pulse7): ohne `--version` holt
# `cargo install` zur BAUZEIT, was crates.io gerade als neuestes fuehrt —
# und dessen Ausgabe landet im ausgelieferten Buendel. 0.15.0 ist die
# Fassung, gegen die lokal geprueft wurde.
RUN cargo install wasm-pack --locked --version 0.15.0
WORKDIR /build
COPY krypto/ krypto/
RUN cd krypto/pulse-krypto && wasm-pack build --target web --out-dir pkg

# ── builder ──────────────────────────────────────────────────────────────────
FROM node:25-slim AS builder
RUN npm install -g pnpm@10.33.0
WORKDIR /app

# pnpm workspace metadata (cache layer)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/package.json
COPY desktop/package.json desktop/package.json
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# web source + plugin manifests → build
# plugins/ wird via `import.meta.glob('/../plugins/*/manifest.ts')` aus
# web/src/lib/plugins/loader.ts beim Vite-Build aufgelöst. Ohne plugins/
# im Build-Kontext ist der Plugin-Manager im UI leer.
COPY web/ web/
COPY plugins/ plugins/
# WASM-Paket an die Stelle, die die vier krypto/*.ts-Importe erwarten
# (relativ zu web/src/lib/krypto/: ../../../../krypto/pulse-krypto/pkg/).
COPY --from=wasm-builder /build/krypto/pulse-krypto/pkg krypto/pulse-krypto/pkg
RUN pnpm --filter @dcc/web build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY infra/prod/web-nginx.conf /etc/nginx/conf.d/default.conf
# Security-Header-Snippet — bewusst NICHT nach conf.d/ (würde dort als
# http-Level-Config doppelt greifen); web-nginx.conf includet es explizit.
COPY infra/prod/security-headers.inc /etc/nginx/security-headers.inc
COPY --from=builder /app/web/build /usr/share/nginx/html
# Self-Host-Compose-Dateien für den manuellen Installationspfad — Source of
# Truth bleibt infra/self-host/, serviert unter /self-host/* (web-nginx.conf).
COPY infra/self-host/docker-compose.yml \
     infra/self-host/docker-compose.behind-proxy.yml \
     /usr/share/nginx/html/self-host/
COPY infra/self-host/.env.example /usr/share/nginx/html/self-host/env.example
# Update-Skript für den Compose-Pfad — Vorlage für den eigenen Host-Cron/Timer
# (kein Auto-Updater-Container: kein Container hält den Docker-Socket).
COPY infra/self-host/pulse-update.sh /usr/share/nginx/html/self-host/pulse-update.sh
# Die Self-Host-Anleitung selbst — verlinkt aus dem InstanceSetupDialog,
# erreichbar als https://howispulse.com/self-host/guide (text/html; die
# nginx-Regel dafuer ist eine EXAKTE location, sonst faengt sie der
# text/plain-Block fuer /self-host/ ab und der Leser sieht Quelltext).
COPY docs/self-host-guide.html /usr/share/nginx/html/self-host/guide
EXPOSE 80
