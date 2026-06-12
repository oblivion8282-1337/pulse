# syntax=docker/dockerfile:1
#
# Pulse web image: builds the SvelteKit SPA (adapter-static → web/build/) and
# serves it with nginx, which also reverse-proxies /api/*, /whep/*, /hls/* and
# /livekit/* to the backend (see infra/prod/web-nginx.conf).
#
# Build from the repo root:  docker build -f web/Dockerfile -t pulse-web .

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
EXPOSE 80
