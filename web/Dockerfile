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

# web source → build
COPY web/ web/
RUN pnpm --filter @dcc/web build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY infra/prod/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/web/build /usr/share/nginx/html
EXPOSE 80
