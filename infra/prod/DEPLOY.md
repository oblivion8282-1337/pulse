# Deploying Pulse to the VPS

Production runs on the Hetzner VPS (`michael@77.42.71.166`, alongside Caddy and
the other apps). Public URL: **https://pulse.unicutmedia.com**. The whole stack
is one Docker Compose project (`name: pulse`) in `~/pulse/infra/prod/`.

App images (`ghcr.io/oblivion8282-1337/pulse-*`) are built by
`.github/workflows/ci.yml` on every push to `main` and auto-pulled on the server
by `pulse_watchtower` (scope `pulse`, 5-min interval). postgres / redis /
mediamtx / livekit are pinned and excluded from Watchtower.

## First-time setup (already done — kept for reference / disaster recovery)

```sh
# 1. copy infra/ to the server (no git on the server — rsync the configs)
rsync -av --exclude .env --exclude secrets infra/ michael@77.42.71.166:~/pulse/infra/

# 2. on the server: secrets
ssh michael@77.42.71.166
mkdir -p ~/pulse/infra/prod/secrets && cd ~/pulse/infra/prod
PGPW=$(openssl rand -hex 32); RPW=$(openssl rand -hex 32); LKS=$(openssl rand -hex 32)
sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$PGPW|" \
    -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$RPW|" \
    -e "s|^LIVEKIT_API_SECRET=.*|LIVEKIT_API_SECRET=$LKS|" \
    -e "s|^REDIS_URL=.*|REDIS_URL=redis://:$RPW@redis:6379/0|" \
    .env.example > .env && chmod 600 .env
openssl genrsa -out secrets/jwt_private.pem 2048
openssl rsa -in secrets/jwt_private.pem -pubout -out secrets/jwt_public.pem
# Auth/chat containers run as uid 10001 — chown so we don't need world-readable
# permissions on the private key (any other host user could otherwise read it
# and forge JWTs).
sudo chown 10001:10001 secrets/jwt_private.pem secrets/jwt_public.pem
chmod 0600 secrets/jwt_private.pem
chmod 0644 secrets/jwt_public.pem   # public key is fine readable
# self-signed cert for MediaMTX RTMPS (port 1936) — FFmpeg's rtmps client
# doesn't verify the cert, so self-signed is fine; long validity to avoid churn
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -subj "/CN=pulse.unicutmedia.com" \
  -keyout certs/server.key -out certs/server.crt
# MediaMTX (containerised from scratch) runs as root → root-owned + 0600 is
# enough to keep the TLS private key away from other host users.
sudo chown root:root certs/server.key certs/server.crt
chmod 0600 certs/server.key
chmod 0644 certs/server.crt

# 3. firewall
#    public ingest/egress + LiveKit RTC:
#    (no 1935/tcp — mediamtx.yml sets rtmpEncryption: strict, plain-RTMP is refused)
sudo ufw allow 1936/tcp        # RTMPS ingest (GSR push — TLS, token not in cleartext)
sudo ufw allow 8890/udp        # SRT ingest (GSR push, Opus audio)
sudo ufw allow 8189/udp        # MediaMTX WebRTC ICE
sudo ufw allow 7881/tcp        # LiveKit TCP fallback
sudo ufw allow 7882:7892/udp   # LiveKit RTC
#    docker-bridge → host (the pulse_web nginx + pulse_media_svc reach the
#    host-network MediaMTX/LiveKit; UFW's INPUT DROP blocks bridge→host
#    otherwise; 8888/8889 are already open to Anywhere from the old streaming
#    setup, so only these two need a rule):
sudo ufw allow from 10.0.0.0/8 to any port 7880 proto tcp   # LiveKit signaling
sudo ufw allow from 10.0.0.0/8 to any port 9997 proto tcp   # MediaMTX API

# 4. pull + start (must run from infra/prod/ so docker compose finds .env)
cd ~/pulse/infra/prod
docker compose pull
docker compose up -d

# 5. Caddy: add the pulse vhost (see Caddyfile.pulse.snippet), then reload.
#    pulse_web binds 8100 on loopback only (Docker's DNAT bypasses UFW, so
#    `0.0.0.0:8100` would be publicly reachable). Two ways to let Caddy in:
#
#      a) Caddy as a Docker container → join it to pulse-net and proxy to
#         the service name. This is the recommended setup:
#           docker network connect pulse-net caddy
#           upstream:  reverse_proxy pulse_web:80
#
#      b) Caddy as a host process → it can reach 127.0.0.1:8100 directly:
#           upstream:  reverse_proxy 127.0.0.1:8100
cp ~/caddy/Caddyfile ~/caddy/Caddyfile.bak.$(date +%s)
printf '\npulse.unicutmedia.com {\n\treverse_proxy pulse_web:80\n}\n' >> ~/caddy/Caddyfile
docker network connect pulse-net caddy 2>/dev/null || true   # idempotent
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

## Updating

- **Code / bug fixes** → just `git push` to `main`. CI builds & pushes the
  images; `pulse_watchtower` recreates the affected containers within ≤5 min.
  Nothing to do on the server.
- **Compose / config changes** (new service, new env var, MediaMTX/LiveKit
  version bump, nginx routing) → `rsync` the changed `infra/` files to
  `~/pulse/infra/`, then on the server `cd ~/pulse/infra/prod && docker compose
  up -d` (and for new env vars: edit `~/pulse/infra/prod/.env` first).
- **Migrations** run automatically — `pulse_migrate_auth` / `pulse_migrate_chat`
  (the auth/chat images with `alembic upgrade head`) run before the services on
  every `up`.

## Operating

```sh
cd ~/pulse/infra/prod
docker compose ps                       # status
docker compose logs -f auth chat-gateway   # tail logs
docker compose restart <service>
docker compose pull && docker compose up -d   # force-pull latest (Watchtower does this automatically)
docker logs pulse_watchtower            # see what Watchtower is doing
```

## Backups

**Opt-in.** Pulse runs fine without the backup sidecar — `docker compose
up -d` skips the `backup` service unless you opt in via `COMPOSE_PROFILES=
backup` in `.env`. The `/app/admin` panel surfaces a "Backup nicht
eingerichtet" card while the profile is off, so you don't silently forget.

When enabled, the `backup` sidecar (built locally from `infra/prod/backup/
Dockerfile`) runs restic-encrypted snapshots of Postgres + MinIO + avatars
+ guild_icons into the `pulse_backups` Docker volume. Schedule (UTC):

- `pg`        — daily 04:00 (pg_dump | restic --stdin)
- `minio`     — every 6h    (mc mirror → restic)
- `avatars`   — daily 04:30
- `icons`     — daily 04:35
- `maintenance` — Sunday 05:00 (`forget --prune` 7d/4w/6m per tag + `check`)

Schedule + script live in `infra/prod/backup/{crontab,backup.sh}`.

### Setup (one-time, when ready to enable backups)

```sh
# 1. Generate the repo passphrase. **Save it in a password manager AND on
#    paper** — restic uses scrypt+AES-256; a lost passphrase = unrecoverable
#    repo, full stop.
openssl rand -base64 32

# 2. Enable the profile + add the passphrase in ~/pulse/infra/prod/.env:
cat >> ~/pulse/infra/prod/.env <<EOF
COMPOSE_PROFILES=backup
RESTIC_PASSWORD=<paste here>
EOF

# 3. Build + start the sidecar.
cd ~/pulse/infra/prod
docker compose build backup
docker compose up -d backup
docker compose ps backup       # should be Up (health: starting) for 5 min, then healthy
```

### Updating the backup image

The `backup` image is **not** in CI — it's locally-built and Watchtower-
excluded. If `backup.sh` / `crontab` / `Dockerfile` change after a `git pull`
on the VPS:

```sh
cd ~/pulse/infra/prod
docker compose build backup
docker compose up -d backup     # picks up the new image
```

### Recovery

Step-by-step runbook: `infra/prod/backup/restore.md`. Every command in there
was end-to-end validated on a laptop drill — single-file cherry-pick, full
Postgres, full MinIO bucket, and avatars/icons all confirmed byte-identical
after a destroy+restore cycle.

### What is NOT in restic

Restic captures the data layer only. These must be kept off-host separately
(password manager, encrypted USB, second VPS):

- `~/pulse/infra/prod/.env`               — passwords + `RESTIC_PASSWORD`
- `~/pulse/infra/prod/secrets/jwt_*.pem`  — JWT signing keys (rotating these
                                            invalidates every issued token)
- `~/pulse/infra/prod/certs/server.{crt,key}` — MediaMTX self-signed TLS
- `~/.docker/config.json`                 — GHCR pull token

### TODO: off-host replica

A local-only restic repo dies with the disk. Add a second repository (B2 /
Hetzner Storage Box / S3) and run `restic copy` from a new cron line in
`backup.sh::run_maintenance` (or a dedicated `mirror` subcommand). Sketch
in `restore.md` §8.
