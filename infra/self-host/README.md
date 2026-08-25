# Pulse Self-Host — Single-Container Image (Phase 6.A)

`registry.howispulse.com/pulse-allinone:stable` — one container that bundles every
Pulse-Backend-Service, an embedded Postgres + Redis, LiveKit (voice SFU),
MediaMTX (HQ-stream relay), MinIO (S3 object store for message attachments),
coturn (TURN/STUN), and Caddy (reverse proxy + auto-TLS), supervised by
[s6-overlay](https://github.com/just-containers/s6-overlay) v3 as PID 1.

This file documents the **build + run** flow for the image. End-user setup
docs (Cloud-approval, DNS, port-forwarding) land in `docs/SELF_HOST.md` —
written in Phase 6.B.

**Two registries, one image.** `.github/workflows/allinone.yml` builds and
pushes to `ghcr.io/oblivion8282-1337/pulse-allinone` first, then its `merge`
job mirrors every tag (`imagetools create`) to `registry.howispulse.com/pulse-allinone`
under the identical tag name. **Operators pull from `registry.howispulse.com`,
never from GHCR** — the `pulse-*` GHCR packages are private, while
`registry.howispulse.com` gates access per-instance via the `PULSE_CLOUD_CLIENT_ID`/
`PULSE_CLOUD_CLIENT_SECRET` from the Cloud approval (`docker login
registry.howispulse.com -u <client_id> -p <client_secret>`). Both `:edge`
(every `main` push) and `:stable` (tagged releases) exist on both registries;
during the current early/security phase every `main` push tags **both**
identically (see the `PHASEN-POLICY` comment in `allinone.yml`) — they diverge
once real tagged releases start. The installer (`web/static/install.sh`)
defaults to `:edge`, overridable via `PULSE_IMAGE`; this file's Compose/`docker
run` examples below pin `:stable`.

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

Zwei fertige Compose-Varianten (auch ohne Repo-Clone beziehbar — URLs in
`docs/SELF_HOST.md` → „Manuelle Installation"):

- **`docker-compose.yml`** — Standardfall: Auto-TLS, der eingebettete Caddy
  holt das Let's-Encrypt-Cert selbst (Port 80 + 443 öffentlich + DNS gesetzt).
- **`docker-compose.behind-proxy.yml`** — für Hosts, auf denen schon ein
  Reverse-Proxy läuft: TLS terminiert der vorhandene Proxy, der Container
  exponiert nur `127.0.0.1:8080` (setzt `PULSE_TLS_MODE=behind-proxy` selbst).

```bash
cp .env.example .env      # 6 Pflicht-Vars eintragen (.env-Download via "Meine Instanzen")
docker compose up -d      # bzw. docker compose -f docker-compose.behind-proxy.yml up -d
```

Updates verwaltet der Compose-Pfad bewusst selbst — kein Auto-Updater-Container
(siehe [Auto-update](#auto-update)).

## Run (manuell, ohne Compose)

```bash
docker login registry.howispulse.com -u <client_id> -p <client_secret>  # aus dem .env-Download
docker run -d --name pulse \
    -v pulse-data:/data \
    -p 443:443 -p 80:80 \
    -p 7882-7892:7882-7892/udp \
    -p 3478:3478 -p 3478:3478/udp \
    -p 1936:1936 -p 8189:8189/udp \
    -e PULSE_HOSTNAME=chat.firma.de \
    -e PULSE_INSTANCE_ID=... \
    -e PULSE_INSTANCE_OWNER_ID=... \
    -e PULSE_CLOUD_CLIENT_ID=... \
    -e PULSE_CLOUD_CLIENT_SECRET=... \
    -e PULSE_ADMIN_EMAIL=admin@firma.de \
    registry.howispulse.com/pulse-allinone:stable
```

Updates richtest du auf dem manuellen Pfad (Compose wie `docker run`) selbst
ein — siehe [Auto-update](#auto-update).

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
| LiveKit | v1.13.3 | github.com/livekit/livekit | SHA-256 pinned per artifact |
| MediaMTX | v1.19.1 | github.com/bluenviron/mediamtx | SHA-256 pinned per artifact |
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

> **No Watchtower — anywhere.** An updater container with the Docker socket
> mounted is root-equivalent on the host; we removed that pattern across the
> project (installer, cloud, compose). **No container holds the socket.**

The recommended one-command installer (`web/static/install.sh`) installs a host
**systemd timer** (`pulse-update.timer` → `pulse-update.sh`) that pulls the
image and recreates the container only when the digest changed.

The compose / manual paths manage updates themselves:

```bash
docker compose pull && docker compose up -d
```

run manually, or wrapped in a host cron/systemd timer (replicating the
installer's approach: `docker pull` → digest diff → recreate). End-user docs:
`docs/SELF_HOST.md` → "Was passiert bei Updates".

## Diagnose

Drei Auskünfte, absichtlich getrennt — sie beantworten verschiedene Fragen:

| Werkzeug | Frage | Auth |
|---|---|---|
| `GET /health` | Läuft der Dienst? (Docker-Healthcheck) | keine |
| `GET /health/setup` | Wie weit ist der **Erststart** gekommen? | keine |
| `docker exec pulse pulse-doctor` | Was ist von **innen** sichtbar? | Shell-Zugriff |
| „Verbindung prüfen" in der App | Kommt jemand von **aussen** an? | Besitzer |

`/health/setup` liest `/data/setup-status`, das `cont-init-main.sh` zeilenweise
mitschreibt (`<epoche>\t<name>\t<ok|fehler>`). Die Instrumentierung sitzt in
der **einen** Datei, die die Startskripte der Reihe nach ruft — nicht in den
Skripten selbst; neue Schritte sind damit von allein erfasst. Zeilenformat statt
JSON, weil JSON aus der Shell heisst, jedes Anführungszeichen von Hand zu
behandeln, und ein kaputter Status wäre schlimmer als gar keiner.

Ob Caddy sein Zertifikat hat, wird am **Zertifikatsvorrat** abgelesen
(`/data/caddy/caddy/certificates/*/<host>/<host>.crt`), nicht am Log: ein
Log-Scraper müsste Caddys Ausgabeformat kennen und bräche bei jedem
Versionswechsel still.

`pulse-doctor` trennt drei Richtungen — innen, hinaus (erreicht der Container
die Cloud?), herein (ist der eigene Name ansprechbar?). Innen grün und aussen
rot heisst DNS, Firewall oder Proxy. Der Selbstaufruf über den eigenen Namen
wird ausdrücklich als **unklar** gemeldet und nicht als Fehler: etliche Router
können den eigenen öffentlichen Namen von innen nicht auflösen (fehlendes
Hairpin-NAT), und das als Fehler zu verkaufen schickte den Betreiber auf die
Suche nach einem Problem, das es womöglich gar nicht gibt.

Die Prüfung von **aussen** (`POST /selfhost/diagnose/{id}` in der Cloud,
`services/auth/src/dcc_auth/selfhost_probe*.py`) ist das Einzige, was ein
Server über sich selbst nicht sagen kann. Sie sieht insbesondere den
Reverse-Proxy, der WebSockets nicht durchreicht — dabei funktionieren
`/health`, das Hinzufügen des Servers und das Anmelden alle, und erst der Chat
bleibt leer.

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

## Host-Tuning (VPS-Betrieb)

WebRTC (MediaMTX + LiveKit im Container) profitiert von größeren
Kernel-UDP-Puffer-Obergrenzen auf dem **Wirt** — `net.core.rmem_max`/`wmem_max`
sind nicht namespaced, kein Container kann sie selbst setzen. Mit dem
Debian-Default (~212 KB) kann der Server bei mehreren Zuschauern selbst Pakete
verlieren, sichtbar als Ruckeln trotz sauberer Leitung. Einmalig auf dem Wirt
einspielen: `infra/prod/sysctl-pulse.conf` (Begründung steht als Kommentar in
der Datei) nach `/etc/sysctl.d/99-pulse.conf`, dann `sysctl --system`.

**Optional, nicht Voraussetzung** — ohne die Einstellung läuft alles wie
bisher; sie zahlt sich erst bei vielen gleichzeitigen Zuschauern aus. Der
Installer (`web/static/install.sh`) gibt am Ende dieselbe Zeile aus, damit
niemand sie hier suchen muss; er **setzt sie nicht selbst** (läuft nicht
zwingend als root, und die Grenze gilt für jeden Dienst auf der Maschine).
Beim Ändern also beide Stellen mitziehen.

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
