# Pulse Self-Host — Single-Container Image (Phase 6.A)

`ghcr.io/oblivion8282-1337/pulse-allinone:stable` — one container that bundles every
Pulse-Backend-Service, an embedded Postgres + Redis, LiveKit (voice SFU),
MediaMTX (HQ-stream relay), MinIO (S3 object store for message attachments),
coturn (TURN/STUN), and Caddy (reverse proxy + auto-TLS), supervised by
[s6-overlay](https://github.com/just-containers/s6-overlay) v3 as PID 1.

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

## Run (advanced: Docker Compose)

> For most operators the one-command installer (`curl … | … bash`, see
> `docs/SELF_HOST.md`) is the recommended path — it auto-detects the
> environment and sets up updates via a host systemd timer (no Docker socket
> in any container). The compose flow below is for operators who want to manage
> the stack themselves.

Die mitgelieferte `docker-compose.yml` startet den Pulse-Server **und** den
Watchtower-Auto-Updater zusammen — so ist das Auto-Update von Anfang an dabei
(sonst ein leicht zu übersehender Extra-Schritt, siehe [Auto-update](#auto-update);
**Achtung Socket-Trade-off**, dort beschrieben):

```bash
cp .env.example .env      # 6 Pflicht-Vars eintragen (.env-Download via "Meine Instanzen")
docker compose up -d
```

Das deckt den Standardfall (Auto-TLS auf 80/443) ab; die `behind-proxy`-Variante
ist in der `docker-compose.yml` auskommentiert beschrieben.

## Run (manuell, ohne Compose)

```bash
docker run -d --name pulse \
    -v pulse-data:/data \
    -p 443:443 -p 80:80 \
    -p 7882-7892:7882-7892/udp \
    -p 3478:3478 -p 3478:3478/udp \
    -e PULSE_HOSTNAME=chat.firma.de \
    -e PULSE_INSTANCE_ID=... \
    -e PULSE_INSTANCE_OWNER_ID=... \
    -e PULSE_CLOUD_CLIENT_ID=... \
    -e PULSE_CLOUD_CLIENT_SECRET=... \
    -e PULSE_ADMIN_EMAIL=admin@firma.de \
    ghcr.io/oblivion8282-1337/pulse-allinone:stable
```

Beim manuellen `docker run` musst du das Auto-Update separat einrichten
(siehe [Auto-update](#auto-update)) — Compose nimmt dir das ab.

The six `-e` vars are mandatory; cont-init aborts with a clear error otherwise.
`PULSE_INSTANCE_ID`, `PULSE_INSTANCE_OWNER_ID`, `PULSE_CLOUD_CLIENT_ID` and the
secret come from the Cloud approval — the ready-made `.env` under "Meine
Instanzen" on howispulse.com carries all but the secret.
All internal secrets (Postgres password, JWT keys, coturn shared-secret,
LiveKit API key pair, MinIO root credentials) are **generated on first boot**
in `/data/jwt_keys/` and persisted across container restarts.

## What's inside

| Component | Version | Source | Checksum |
|---|---|---|---|
| s6-overlay | v3.2.0.2 | github.com/just-containers/s6-overlay | SHA-256 pinned per artifact |
| Caddy | v2.8.4 | github.com/caddyserver/caddy | SHA-256 pinned per artifact |
| LiveKit | v1.11.0 | github.com/livekit/livekit | SHA-256 pinned per artifact |
| MediaMTX | v1.17.1 | github.com/bluenviron/mediamtx | SHA-256 pinned per artifact |
| MinIO | RELEASE.2025-09-07T16-13-09Z | dl.min.io | SHA-256 pinned (upstream .sha256sum) |
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

## Auto-update

> **The recommended one-command installer (`web/static/install.sh`) does NOT
> use Watchtower.** It installs a host **systemd timer** (`pulse-update.timer`
> → `pulse-update.sh`) that pulls the image and recreates the container if the
> digest changed. Rationale: Watchtower mounts the Docker socket, which is
> root-equivalent on the host — anyone who can run code in that container can
> take over the machine. The timer keeps the updater as a small, auditable
> host script and **no container holds the socket**. Prefer the installer.

The compose / manual paths below can't write host systemd units, so they fall
back to Watchtower. **Be aware of the socket trade-off above** before using it.
Watchtower is **not baked into the image** (a Watchtower inside its own update
target can't restart itself cleanly):

```bash
docker run -d --name pulse-watchtower \
    --restart unless-stopped \
    -v /var/run/docker.sock:/var/run/docker.sock \
    ghcr.io/nicholas-fedor/watchtower:latest --label-enable --scope pulse --interval 300 --cleanup
```

The all-in-one container ships with the right labels (`com.centurylinklabs.watchtower.enable=true`
+ `…scope=pulse`) so Watchtower picks it up. Alternatively, replicate the
installer's approach: drop a host cron/systemd timer that runs
`docker pull … && docker inspect`-diff → recreate, and skip the socket entirely.

> **Note:** the original `containrrr/watchtower` image is effectively
> unmaintained and uses a Docker API client (v1.25) too old for modern daemons
> (min v1.40) — it crash-loops with a "client version too old" error. Use the
> actively-maintained `ghcr.io/nicholas-fedor/watchtower` fork instead.

## Architecture

s6-overlay v3 (s6-rc.d):

```
cont-init  (oneshot — runs cont-init-main.sh, blocks until all secrets/configs ready)
  ├── postgres            (waits for cont-init)
  ├── redis               (waits for cont-init)
  ├── auth                (waits for postgres + redis)
  ├── chat-gateway        (waits for postgres + redis)
  ├── voice-signaling     (waits for redis)
  ├── media-svc           (waits for redis)
  ├── mediamtx-auth-hook  (waits for redis)
  ├── livekit             (waits for voice-signaling)
  ├── mediamtx            (waits for media-svc + mediamtx-auth-hook)
  ├── minio               (waits for cont-init; embedded S3 store for attachments)
  ├── minio-init          (oneshot — waits for minio; creates the attachments bucket, best-effort)
  ├── coturn              (waits for cont-init; sleeps forever if PULSE_TURN_DISABLED=true)
  └── caddy               (waits for chat-gateway/voice-signaling/media-svc/auth)
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
│       │   ├── auth/               # python services
│       │   ├── chat-gateway/
│       │   ├── voice-signaling/
│       │   ├── media-svc/
│       │   ├── mediamtx-auth-hook/
│       │   ├── livekit/            # go binaries
│       │   ├── mediamtx/
│       │   ├── minio/              # embedded S3 object store (message attachments)
│       │   ├── minio-init/         # oneshot — creates the attachments bucket
│       │   ├── coturn/             # turn server
│       │   └── caddy/              # reverse proxy (Caddyfile aus etc/caddy/Caddyfile.template)
│       ├── etc/caddy/
│       │   └── Caddyfile.template  # auto-TLS, security headers, /api/* + WHEP + /pulse-attachments/* routing
│       └── scripts/                # cont-init steps — Ausführungsreihenfolge regelt cont-init-main.sh, nicht die Dateinummer
│           ├── cont-init-main.sh
│           ├── 10-check-cloud-creds.sh  # FIRST (fail-fast bei fehlenden Env-Vars)
│           ├── 01-init-data-dirs.sh
│           ├── 03-init-secrets.sh
│           ├── 02-init-postgres.sh
│           ├── 04-init-coturn.sh
│           ├── 05-init-livekit.sh
│           ├── 07-render-env.sh
│           ├── 08-init-mediamtx.sh
│           ├── 09-init-caddy.sh    # Caddyfile aus Template; auto + provided TLS-Modus
│           ├── 06-run-migrations.sh # LAST (Postgres muss erst hoch sein)
│           ├── init-minio-bucket.py # minio-init oneshot: SigV4 PUT /pulse-attachments (botocore+httpx)
│           └── restart-gate.sh
└── usr/local/bin/
    └── pulse-health                # Container HEALTHCHECK (bash /dev/tcp Probes)
```

## Volumes

| Path | Purpose | Backup-critical |
|---|---|---|
| `/data/pg/` | Postgres data directory (PG 15 initdb) | YES |
| `/data/redis/` | Redis AOF | yes (session state, presence) |
| `/data/jwt_keys/` | Generated RS256/Ed25519 keys + secrets | **YES — losing this invalidates every session** |
| `/data/coturn/{secret,turndb}` | static-auth-secret + nonce DB for TURN | yes |
| `/data/caddy/` | TLS certs + ACME state | yes |
| `/data/livekit/` | LiveKit ephemeral state | no (regeneriert) |
| `/data/mediamtx/` | MediaMTX state + self-signed RTMPS cert | no (regeneriert beim First-Start) |
| `/data/minio/` | MinIO object store — message attachments | **YES — verlieren = alle Anhänge weg** |
| `/data/uploads/avatars` | user avatars | yes |
| `/data/uploads/guild-icons` | guild icons | yes |
| `/data/backups/` | pg_dump snapshots (Phase 6 plan DE 10b) | yes |
| `/data/certs/` | user-provided TLS cert when `PULSE_TLS_MODE=provided` | yes |

The recommended mount is `-v pulse-data:/data` — Docker named-volume so the
host doesn't need a specific UID/GID setup.

## Known limitations

- **Restart-gate granularity** — counts only crash, not restart-loop-success;
  a service that restarts cleanly every 11 s indefinitely won't trip the gate.
  Acceptable for now (the failure modes we worry about are tight crash loops).
- **No Flatpak interaction** — the Flatpak desktop client talks to a self-host
  the same way it talks to Cloud (via HTTPS to PULSE_HOSTNAME). No extra
  wiring needed inside this image.
- **`livekit.yaml.template` + `mediamtx.yml.template` noch nicht abstrahiert** —
  beide werden derzeit inline in `05-init-livekit.sh` / `08-init-mediamtx.sh`
  geschrieben (kein externes Template). Für Operatoren mit eigenen Configs
  als Folge-Arbeit.
