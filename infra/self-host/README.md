# Pulse Self-Host — Single-Container Image (Phase 6.A)

`ghcr.io/oblivion8282-1337/pulse-allinone:stable` — one container that bundles every
Pulse-Backend-Service, an embedded Postgres + Redis, LiveKit (voice SFU),
MediaMTX (HQ-stream relay), coturn (TURN/STUN), and Caddy (reverse proxy +
auto-TLS), supervised by [s6-overlay](https://github.com/just-containers/s6-overlay)
v3 as PID 1.

This file documents the **build + run** flow for the image. End-user setup
docs (Cloud-approval, DNS, port-forwarding) land in `docs/SELF_HOST.md` —
written in Phase 6.B.

## Build

From the repo root:

```bash
docker build \
    -f infra/self-host/Dockerfile \
    --build-arg PULSE_VERSION=$(git rev-parse --short HEAD) \
    -t pulse-allinone:dev \
    .
```

Build takes a few minutes — multi-stage builds the uv workspace (Python),
the SvelteKit SPA (Node) and downloads four pinned upstream binaries.

## Run

```bash
docker run -d --name pulse \
    -v pulse-data:/data \
    -p 443:443 -p 80:80 \
    -p 7882-7892:7882-7892/udp \
    -p 3478:3478 -p 3478:3478/udp \
    -e PULSE_HOSTNAME=chat.firma.de \
    -e PULSE_CLOUD_CLIENT_ID=... \
    -e PULSE_CLOUD_CLIENT_SECRET=... \
    -e PULSE_ADMIN_EMAIL=admin@firma.de \
    ghcr.io/oblivion8282-1337/pulse-allinone:stable
```

The four `-e` vars are mandatory; cont-init aborts with a clear error otherwise.
All internal secrets (Postgres password, JWT keys, coturn shared-secret,
LiveKit API key pair) are **generated on first boot** in `/data/jwt_keys/`
and persisted across container restarts.

## What's inside

| Component | Version | Source | Checksum |
|---|---|---|---|
| s6-overlay | v3.2.0.2 | github.com/just-containers/s6-overlay | SHA-256 pinned per artifact |
| Caddy | v2.8.4 | github.com/caddyserver/caddy | SHA-256 pinned per artifact |
| LiveKit | v1.8.4 | github.com/livekit/livekit | SHA-256 pinned per artifact |
| MediaMTX | v1.17.1 | github.com/bluenviron/mediamtx | SHA-256 pinned per artifact |
| Postgres | 15 (Debian Bookworm) | apt | — (Debian-signed package) |
| Redis | 7 (Debian Bookworm) | apt | — (Debian-signed package) |
| coturn | (Debian Bookworm) | apt | — (Debian-signed package) |
| Python | 3.13 | python:3.13-slim base layer | — (Docker Hub) |
| pulse services | from this repo | uv workspace | — |

Every third-party tarball is downloaded with `curl` and verified against a
pinned `SHA256_*` ARG inside the Dockerfile (`sha256sum -c`). The build
aborts on mismatch — a tampered, swapped or silently rebuilt upstream
artifact cannot reach the runtime stage.

### Refreshing or bumping pinned versions

`infra/self-host/scripts/refresh-checksums.sh` automates the hash maintenance:

```bash
# Re-verify all pins against current upstream (read-only, exit 1 on mismatch)
infra/self-host/scripts/refresh-checksums.sh

# Bump a single component — rewrites both the ARG <NAME>_VERSION and the
# matching SHA256_<NAME>_<ARCH> pins in the Dockerfile
infra/self-host/scripts/refresh-checksums.sh --set CADDY_VERSION=2.9.0

# Force-update pins under existing versions (only after auditing why upstream
# republished the artifact)
infra/self-host/scripts/refresh-checksums.sh --write
```

## Watchtower

Watchtower **is not in the container** (deliberately — a Watchtower running
inside its own update target can't actually restart itself cleanly). Self-hosters
run it separately:

```bash
docker run -d --name pulse-watchtower \
    -v /var/run/docker.sock:/var/run/docker.sock \
    containrrr/watchtower --label-enable --scope pulse --interval 300
```

The all-in-one container ships with the right labels so Watchtower picks it up.

## Architecture

s6-overlay v3 (s6-rc.d):

```
cont-init  (oneshot — runs cont-init-main.sh, blocks until all secrets/configs ready)
  ├── postgres            (waits for cont-init)
  ├── redis               (waits for cont-init)
  ├── chat-gateway        (waits for postgres + redis)
  ├── voice-signaling     (waits for redis)
  ├── media-svc           (waits for redis)
  ├── mediamtx-auth-hook  (waits for redis)
  ├── livekit             (waits for voice-signaling)
  ├── mediamtx            (waits for media-svc + mediamtx-auth-hook)
  ├── coturn              (waits for cont-init; sleeps forever if PULSE_TURN_DISABLED=true)
  └── caddy               (waits for chat-gateway/voice-signaling/media-svc)
```

Each longrun unit has a `./finish` script that gates restarts: more than
5 crashes in 60s → halt the container (Docker's `restart: unless-stopped`
performs a clean restart, breaking any data-corruption-induced loop).

## File layout

```
infra/self-host/
├── Dockerfile                      # multi-stage build
├── README.md                       # (this file)
├── scripts/
│   └── refresh-checksums.sh        # SHA-256-pin maintenance for the bundled binaries
├── s6/                             # → / inside the image
│   └── etc/s6-overlay/
│       ├── s6-rc.d/                # service definitions
│       │   ├── user/contents.d/    # which units belong to "default user bundle"
│       │   ├── cont-init/          # oneshot bootstrap entry
│       │   ├── postgres/           # data layer
│       │   ├── redis/
│       │   ├── chat-gateway/       # python services
│       │   ├── voice-signaling/
│       │   ├── media-svc/
│       │   ├── mediamtx-auth-hook/
│       │   ├── livekit/            # go binaries
│       │   ├── mediamtx/
│       │   ├── coturn/             # turn server
│       │   └── caddy/              # reverse proxy
│       └── scripts/                # cont-init steps
│           ├── cont-init-main.sh
│           ├── 01-init-data-dirs.sh
│           ├── 02-init-postgres.sh
│           ├── 03-init-secrets.sh
│           ├── 04-init-coturn.sh
│           ├── 05-init-livekit.sh
│           ├── 06-run-migrations.sh
│           ├── 07-render-env.sh
│           ├── 08-init-mediamtx.sh
│           ├── 10-check-cloud-creds.sh
│           └── restart-gate.sh
└── templates/                      # Phase 6.B
    └── README.md
```

## Volumes

| Path | Purpose | Backup-critical |
|---|---|---|
| `/data/pg/` | Postgres data directory (PG 15 initdb) | YES |
| `/data/redis/` | Redis AOF | yes (session state, presence) |
| `/data/jwt_keys/` | Generated RS256/Ed25519 keys + secrets | **YES — losing this invalidates every session** |
| `/data/coturn/secret` | static-auth-secret for TURN | yes |
| `/data/caddy/` | TLS certs + ACME state | yes |
| `/data/uploads/avatars` | user avatars | yes |
| `/data/uploads/guild-icons` | guild icons | yes |
| `/data/backups/` | pg_dump snapshots (Phase 6 plan DE 10b) | yes |
| `/data/certs/` | user-provided TLS cert when `PULSE_TLS_MODE=provided` | yes |

The recommended mount is `-v pulse-data:/data` — Docker named-volume so the
host doesn't need a specific UID/GID setup.

## Known limitations (Phase 6.A)

- **Caddy + healthcheck not wired** — `/etc/caddy/Caddyfile` ships empty;
  the `pulse-health` HEALTHCHECK script is a no-op. Both land in Phase 6.B.
- **Restart-gate granularity** — counts only crash, not restart-loop-success;
  a service that restarts cleanly every 11 s indefinitely won't trip the gate.
  Acceptable for now (the failure modes we worry about are tight crash loops).
- **No Flatpak interaction** — the Flatpak desktop client talks to a self-host
  the same way it talks to Cloud (via HTTPS to PULSE_HOSTNAME). No extra
  wiring needed inside this image.

## Phase 6.B will add

- `infra/self-host/templates/Caddyfile.template`
- `infra/self-host/templates/livekit.yaml.template`
- `infra/self-host/templates/mediamtx.yml.template`
- `/usr/local/bin/pulse-health` (real HEALTHCHECK script — checks each s6 unit + Caddy listening)
- `docs/SELF_HOST.md` — end-user-facing operator manual
