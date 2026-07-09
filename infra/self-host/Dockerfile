# syntax=docker/dockerfile:1
#
# Pulse — Self-Host All-in-One Image (Phase 6.A).
#
# Single container that runs every Pulse-Backend-Service + embedded
# Postgres/Redis + LiveKit + MediaMTX + coturn + Caddy under s6-overlay as
# process supervisor. Distribution target:
#   ghcr.io/oblivion8282-1337/pulse-allinone:stable
#
# Build (from repo root):
#   docker build -f infra/self-host/Dockerfile \
#     --build-arg PULSE_VERSION=$(git rev-parse --short HEAD) \
#     -t pulse-allinone:dev .
#
# Run (Self-Hoster):  see infra/self-host/README.md.

ARG PULSE_VERSION=dev
ARG PYTHON_VERSION=3.13

# Versions of bundled third-party binaries — pinned, verified by SHA-256
# below where upstream publishes checksums (see TODOs for the few that don't).
ARG S6_OVERLAY_VERSION=3.2.0.2
ARG CADDY_VERSION=2.8.4
# v1.11.0 = protocol 16 (Cloud-Parität, prod nutzt livekit-server:v1.11). 1.8.4
# war protocol 15 → der neuere livekit-client (2.18.9, protocol 16) brach die
# WebRTC-Negotiation ab (/rtc/v1 404, "unsupported datachannel _data_track",
# negotiation timeout) trotz erfolgreichem Signaling + UDP-ICE (F17).
ARG LIVEKIT_VERSION=1.11.0
ARG MEDIAMTX_VERSION=1.17.1
# MinIO — S3-compatible object store for message attachments. Pinned to the
# SAME release the prod stack runs (infra/prod/docker-compose.yml) for parity.
# Format is the upstream RELEASE.<timestamp> tag, used verbatim in the URL.
ARG MINIO_VERSION=RELEASE.2025-09-07T16-13-09Z
# frp-Client für den Steuerungs-Relay-Tunnel (App-Hosting). Version passend
# zum frps auf dem Cloud-Server (infra/prod: snowdreamtech/frps:0.69.1).
ARG FRP_VERSION=0.69.1
ARG TARGETARCH=amd64

# SHA-256 checksums for all bundled binaries. Pinned to a specific upstream
# release; a tampered or swapped artifact fails the build instead of silently
# installing. Update together with the *_VERSION arg above and run
# `infra/self-host/scripts/refresh-checksums.sh` (or manually re-hash from
# upstream releases).
#
# Sources:
#   - s6-overlay: official .sha256 next to each release artifact.
#   - LiveKit: official checksums.txt in the GitHub release.
#   - Caddy + MediaMTX: re-hashed from the upstream release tarballs (Caddy
#     publishes SHA-512 only; MediaMTX publishes no checksums file at all).
#   - MinIO: official .sha256sum sidecar next to each release binary.
ARG SHA256_S6_NOARCH=6dbcde158a3e78b9bb141d7bcb5ccb421e563523babbe2c64470e76f4fd02dae
ARG SHA256_S6_X86_64=59289456ab1761e277bd456a95e737c06b03ede99158beb24f12b165a904f478
ARG SHA256_S6_AARCH64=8b22a2eaca4bf0b27a43d36e65c89d2701738f628d1abd0cea5569619f66f785
ARG SHA256_CADDY_AMD64=a7e8306c54138cf88e371c5ec0caf7baf142ecc1d60a30897dfb67d65d3748c8
ARG SHA256_CADDY_ARM64=93a3eb31883d678c6590c6d823eb6bb9f7a3af66dcd9d53df3eb2c7528b2af05
ARG SHA256_LIVEKIT_AMD64=3e76ed51ecdfefc3005e4257095dccd1ccc8f8b77517d9f2353de7906650b68b
ARG SHA256_LIVEKIT_ARM64=6741466bc12e75544338292ab2c1c02c02f3c626568230b5548fffc53e5a87ff
ARG SHA256_MEDIAMTX_AMD64=ee1cbcf8108dcb5fccf4c4e5a746846ea1c2055c099dd2fdb03391c519508829
ARG SHA256_MEDIAMTX_ARM64=389e5bd330eb93d6a96e329a3cf567a41c8d2e7cc187bfad9db04c7ad905a97b
ARG SHA256_MINIO_AMD64=7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f
ARG SHA256_MINIO_ARM64=5c83cd2cf151717ba0243f73e1c7802ff36e272b67144bdd7f1f7d684fd6f03d
# frp: upstream publiziert keine Checksums-Datei — re-hashed vom offiziellen Tarball.
ARG SHA256_FRP_AMD64=7be257b72dbbc60bcb3e0e25a5afd1dfac7b63f897084864d3c956dd3d5674e1
ARG SHA256_FRP_ARM64=bbc0c75e896af3f292fb46ba09c844a04fa9b5ea3530c039c7af20637f836355

# ── Stage 1 ────────────────────────────────────────────────────────────────
# Python-Services: build the uv workspace, produce a self-contained .venv
# directly at /opt/pulse so no path-rewrite is needed in the runtime stage.
#
# IMPORTANT: pin to `-slim-bookworm`, NOT plain `-slim`. The default `-slim`
# tag wanders with Debian-stable — since early 2025 it points at Trixie
# (glibc 2.38), while our runtime stage is still Bookworm (glibc 2.36). The
# COPY of /usr/local/lib/python3.13/ across stages would otherwise trigger
# `GLIBC_2.38 not found` at runtime when libpython looks for libm/libc.
# ──────────────────────────────────────────────────────────────────────────
FROM python:${PYTHON_VERSION}-slim-bookworm AS python-build
COPY --from=ghcr.io/astral-sh/uv:0.11.11 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/pulse/venv
WORKDIR /opt/pulse

# Dependency-only layer: cache wins when only source changes
COPY pyproject.toml uv.lock ./
COPY shared/pyproject.toml shared/pyproject.toml
COPY services/auth/pyproject.toml services/auth/pyproject.toml
COPY services/chat-gateway/pyproject.toml services/chat-gateway/pyproject.toml
COPY services/voice-signaling/pyproject.toml services/voice-signaling/pyproject.toml
COPY services/media-svc/pyproject.toml services/media-svc/pyproject.toml
COPY services/mediamtx-auth-hook/pyproject.toml services/mediamtx-auth-hook/pyproject.toml
COPY streaming/pyproject.toml streaming/pyproject.toml
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-workspace --all-packages

# Source + install all workspace members editable
COPY shared/ shared/
COPY services/ services/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --all-packages

# Drop the alembic configs into each service's package dir (uv editable
# install resolves the package, but alembic ini lives at the service root).
# Already covered by the COPY services/ above — verify the files exist so a
# refactor breaks the build, not the runtime.
RUN test -f /opt/pulse/services/auth/alembic.ini \
    && test -f /opt/pulse/services/chat-gateway/alembic.ini

# ── Stage 2 ────────────────────────────────────────────────────────────────
# Frontend SPA (SvelteKit, adapter-static) — served by Caddy in runtime
# ──────────────────────────────────────────────────────────────────────────
FROM node:25-slim AS web-build
RUN npm install -g pnpm@10.33.0
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/package.json
COPY desktop/package.json desktop/package.json
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY web/ web/
COPY plugins/ plugins/
RUN pnpm --filter @dcc/web build

# ── Stage 2b ───────────────────────────────────────────────────────────────
# direct-adapter (Rust): Direktpfad der Server-App — STUN-Discovery +
# Telefonbuch-Heartbeat, später WebRTC-DataChannel⇄HTTP-Brücke.
# Plan: docs/plans/2026-07-09-direct-path-webrtc.md.
# build-essential/cmake/perl: aws-lc-sys (rustls-Krypto) kompiliert C.
# ──────────────────────────────────────────────────────────────────────────
FROM rust:1-slim-bookworm AS rust-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake perl pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY infra/self-host/direct-adapter/ .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked \
    && cp target/release/direct-adapter /opt/pulse-direct-adapter

# ── Stage 3 ────────────────────────────────────────────────────────────────
# Binaries: s6-overlay, Caddy, LiveKit, MediaMTX (download + verify here so
# the runtime stage stays free of build-tooling). Every tarball is verified
# against a pinned SHA-256 from the top-level ARGs — a tampered, swapped or
# silently re-built upstream artifact fails the build instead of installing.
# ──────────────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS binaries
ARG S6_OVERLAY_VERSION
ARG CADDY_VERSION
ARG LIVEKIT_VERSION
ARG MEDIAMTX_VERSION
ARG FRP_VERSION
ARG TARGETARCH
ARG SHA256_S6_NOARCH
ARG SHA256_S6_X86_64
ARG SHA256_S6_AARCH64
ARG SHA256_CADDY_AMD64
ARG SHA256_CADDY_ARM64
ARG SHA256_LIVEKIT_AMD64
ARG SHA256_LIVEKIT_ARM64
ARG SHA256_MEDIAMTX_AMD64
ARG SHA256_MEDIAMTX_ARM64
ARG MINIO_VERSION
ARG SHA256_MINIO_AMD64
ARG SHA256_MINIO_ARM64
ARG SHA256_FRP_AMD64
ARG SHA256_FRP_ARM64
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /downloads

# s6-overlay v3 — two-part install: noarch + arch-specific. Pulls tarballs
# from github.com/just-containers/s6-overlay, verifies both against the
# pinned SHA-256. arch translation amd64→x86_64, arm64→aarch64.
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) S6_ARCH=x86_64; SHA256_S6_ARCH="${SHA256_S6_X86_64}" ;; \
        arm64) S6_ARCH=aarch64; SHA256_S6_ARCH="${SHA256_S6_AARCH64}" ;; \
        *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o s6-noarch.tar.xz \
        "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz"; \
    echo "${SHA256_S6_NOARCH}  s6-noarch.tar.xz" | sha256sum -c -; \
    curl -fsSL -o s6-arch.tar.xz \
        "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz"; \
    echo "${SHA256_S6_ARCH}  s6-arch.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/s6; \
    tar -C /opt/s6 -Jxpf s6-noarch.tar.xz; \
    tar -C /opt/s6 -Jxpf s6-arch.tar.xz

# Caddy — static linux binary. Upstream publishes SHA-512 only; we pin SHA-256
# re-hashed from the official tarball.
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) CADDY_ARCH=amd64; SHA256_CADDY="${SHA256_CADDY_AMD64}" ;; \
        arm64) CADDY_ARCH=arm64; SHA256_CADDY="${SHA256_CADDY_ARM64}" ;; \
        *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o caddy.tar.gz \
        "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${CADDY_ARCH}.tar.gz"; \
    echo "${SHA256_CADDY}  caddy.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/caddy; \
    tar -C /opt/caddy -xzf caddy.tar.gz caddy

# LiveKit server — static linux binary, upstream tarball contains the bin.
# SHA-256 from the official checksums.txt in the same release.
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) LK_ARCH=linux_amd64; SHA256_LIVEKIT="${SHA256_LIVEKIT_AMD64}" ;; \
        arm64) LK_ARCH=linux_arm64; SHA256_LIVEKIT="${SHA256_LIVEKIT_ARM64}" ;; \
        *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o livekit.tar.gz \
        "https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_${LK_ARCH}.tar.gz"; \
    echo "${SHA256_LIVEKIT}  livekit.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/livekit; \
    tar -C /opt/livekit -xzf livekit.tar.gz livekit-server

# MediaMTX — static linux binary. Upstream publishes no checksums file at all,
# so we pin SHA-256 re-hashed from the official tarball.
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) MTX_ARCH=linux_amd64; SHA256_MEDIAMTX="${SHA256_MEDIAMTX_AMD64}" ;; \
        arm64) MTX_ARCH=linux_arm64; SHA256_MEDIAMTX="${SHA256_MEDIAMTX_ARM64}" ;; \
        *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o mediamtx.tar.gz \
        "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_${MTX_ARCH}.tar.gz"; \
    echo "${SHA256_MEDIAMTX}  mediamtx.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/mediamtx; \
    tar -C /opt/mediamtx -xzf mediamtx.tar.gz mediamtx

# frpc — Tunnel-Client für den Steuerungs-Relay (App-Hosting). Upstream
# publiziert keine Checksums-Datei; SHA-256 re-hashed vom offiziellen Tarball.
# Nur frpc wird installiert (frps aus dem Tarball wird verworfen).
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) FRP_ARCH=linux_amd64; SHA256_FRP="${SHA256_FRP_AMD64}" ;; \
        arm64) FRP_ARCH=linux_arm64; SHA256_FRP="${SHA256_FRP_ARM64}" ;; \
        *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o frp.tar.gz \
        "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_${FRP_ARCH}.tar.gz"; \
    echo "${SHA256_FRP}  frp.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/frp; \
    tar -C /opt/frp --strip-components=1 -xzf frp.tar.gz "frp_${FRP_VERSION}_${FRP_ARCH}/frpc"

# MinIO — single static binary (not a tarball). Upstream ships a .sha256sum
# sidecar per release; we pin the hash via the top-level ARGs. The "archive"
# path keeps versioned copies of the binary (the file IS the binary).
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) MINIO_ARCH=amd64; SHA256_MINIO="${SHA256_MINIO_AMD64}" ;; \
        arm64) MINIO_ARCH=arm64; SHA256_MINIO="${SHA256_MINIO_ARM64}" ;; \
        *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o minio \
        "https://dl.min.io/server/minio/release/linux-${MINIO_ARCH}/archive/minio.${MINIO_VERSION}"; \
    echo "${SHA256_MINIO}  minio" | sha256sum -c -; \
    mkdir -p /opt/minio; \
    mv minio /opt/minio/minio; \
    chmod +x /opt/minio/minio

# ── Stage 4 — runtime ─────────────────────────────────────────────────────
# Debian Bookworm (NOT Alpine — coturn + Postgres + Python+uv expect glibc;
# also keeps the door open for NVIDIA-compat down the line).
# ──────────────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime
ARG PULSE_VERSION
ARG PYTHON_VERSION

LABEL org.opencontainers.image.source="https://github.com/oblivion8282-1337/pulse" \
      org.opencontainers.image.title="Pulse Self-Host All-in-One" \
      org.opencontainers.image.description="Single-container Pulse Self-Host (all services + Postgres + Redis + LiveKit + MediaMTX + MinIO + coturn + Caddy)" \
      org.opencontainers.image.version="${PULSE_VERSION}"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PULSE_DATA_PATH=/data \
    PULSE_INSTANCE_MODE=self-host \
    PULSE_CLOUD_ORIGIN=https://howispulse.com \
    PULSE_LOG_LEVEL=info \
    PATH="/opt/pulse/venv/bin:${PATH}" \
    S6_KEEP_ENV=1 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_VERBOSITY=1 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=60000

# System packages:
#   - postgresql 15: Debian Bookworm ships 15 (we don't need 16 — schema
#     features used are PG 12+). initdb runs in cont-init.d on first boot.
#   - redis-server: same Debian-packaged binary as the prod stack.
#   - coturn: NAT-traversal helper for voice (Phase 6 plan, Fallstrick #6).
#   - ca-certificates + curl: TLS roots + healthcheck helpers.
#   - tini: not used as PID 1 (s6 owns that), but kept for `tini -s` wrapper
#     when called by the migrations cont-init script.
#   - openssl: cont-init generates Ed25519 + JWT RS256 keypairs.
#   - python deps: psycopg2-runtime libs + libffi (argon2 / cryptography).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl tini openssl xz-utils \
        postgresql-15 postgresql-client-15 \
        redis-server \
        coturn \
        libpq5 libffi8 libssl3 \
        gosu procps \
        netbase \
    && rm -rf /var/lib/apt/lists/*

# Python runtime — Debian Bookworm ships 3.11; we need 3.13 for the uv-built
# venv. Copy the interpreter from the python-build stage (same Debian Bookworm
# base via `python:3.13-slim`), so glibc/openssl ABI is consistent.
COPY --from=python-build /usr/local/bin/python3.13          /usr/local/bin/python3.13
COPY --from=python-build /usr/local/lib/python3.13          /usr/local/lib/python3.13
COPY --from=python-build /usr/local/lib/libpython3.13.so.1.0 /usr/local/lib/libpython3.13.so.1.0
RUN ldconfig && ln -sf /usr/local/bin/python3.13 /usr/local/bin/python3

# Bundled binaries from stage 3
COPY --from=binaries /opt/s6/      /
COPY --from=binaries /opt/caddy/caddy            /usr/local/bin/caddy
COPY --from=binaries /opt/livekit/livekit-server /usr/local/bin/livekit-server
COPY --from=binaries /opt/mediamtx/mediamtx      /usr/local/bin/mediamtx
COPY --from=binaries /opt/minio/minio            /usr/local/bin/minio
COPY --from=binaries /opt/frp/frpc               /usr/local/bin/frpc
COPY --from=rust-build /opt/pulse-direct-adapter /usr/local/bin/pulse-direct-adapter
RUN chmod +x /usr/local/bin/caddy /usr/local/bin/livekit-server /usr/local/bin/mediamtx /usr/local/bin/minio /usr/local/bin/frpc /usr/local/bin/pulse-direct-adapter

# Python venv + service source from stage 1 — already at /opt/pulse, no path
# rewrite needed (UV_PROJECT_ENVIRONMENT made the venv live at /opt/pulse/venv
# directly during the build).
COPY --from=python-build /opt/pulse /opt/pulse

# Web SPA → /var/www/pulse (Caddy serves it as the SPA root, Phase 6.B)
COPY --from=web-build /build/web/build /var/www/pulse

# Pulse plugins (Backend-Loader discovers from here)
COPY plugins/ /opt/pulse/plugins/

# s6-overlay service definitions + cont-init scripts
COPY infra/self-host/s6/ /
# Phase 6.B-Marker: Caddyfile + livekit.yaml templates + healthcheck script
# will be populated by phase 6.B. For now we ship placeholder paths the s6
# longrun-units reference (cont-init guards against missing config).
COPY infra/self-host/templates/ /opt/pulse/templates/

# Filesystem prep — pulse:pulse (uid 10001) owns /data + service state dirs.
# /data is a volume mount-point: docker creates it from this skeleton.
RUN groupadd -g 10001 pulse \
    && useradd -u 10001 -g pulse -d /var/lib/pulse -s /usr/sbin/nologin -M pulse \
    && mkdir -p /data /var/log/pulse /var/run/pulse /etc/pulse \
                /etc/caddy /etc/livekit /etc/mediamtx /etc/coturn \
    && chown -R pulse:pulse /data /var/log/pulse /var/run/pulse /etc/pulse \
    && chmod 0750 /var/log/pulse /var/run/pulse \
    # coturn's default unit user (`turnserver`) is unused — we run as pulse.
    && chmod +x /etc/s6-overlay/scripts/*.sh \
    # Permission everything in the s6-rc.d tree (the chmod above misses subdirs)
    && find /etc/s6-overlay/s6-rc.d -type f \( -name run -o -name up -o -name finish \) -exec chmod +x {} +

# Ports:
#   80, 443           — Caddy (HTTP/3 over UDP/443 also; phase 6.B may add 443/udp)
#                       — bei PULSE_TLS_MODE=auto/provided. Bei behind-proxy ungenutzt.
#   8080              — Caddy HTTP-only (nur bei PULSE_TLS_MODE=behind-proxy;
#                       Port via PULSE_HTTP_PORT änderbar). Externer Proxy zeigt hierauf.
#   3478, 3478/udp    — coturn STUN/TURN
#   7882-7892/udp     — LiveKit ICE
#   1936              — MediaMTX RTMPS ingest (HQ-stream push; raw TCP, can't go via Caddy)
#   8189/udp          — MediaMTX WebRTC/WHEP ICE (HQ-stream playback media plane)
# Internal-only (NOT exposed): 5432 (pg), 6379 (redis), 7880 (livekit ws),
#   8002–8005 (python services), 8888/8889 (mediamtx hls/whep, proxied via Caddy),
#   9000 (minio S3 API, proxied via Caddy /pulse-attachments/*), 9997 (mediamtx api).
EXPOSE 80 443 8080 1936 3478 3478/udp 7882-7892/udp 8189/udp

VOLUME ["/data"]

# Healthcheck: pulse-health probes chat-gateway /health + TCP-reachability
# of all 11 in-container services. start-period covers Postgres initdb +
# alembic + Caddy ACME + JWKS cold-start; --retries=3 + JWKS now answering
# 200 "warming_up" instead of 503 mean a cold JWKS no longer flaps.
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD pulse-health

# s6-overlay v3 owns PID 1 — it handles signals + service supervision.
ENTRYPOINT ["/init"]
