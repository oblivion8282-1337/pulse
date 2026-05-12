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
# the app containers run as uid 10001 → the mounted pem files must be world-readable
chmod 0644 secrets/jwt_private.pem secrets/jwt_public.pem

# 3. firewall — RTMP/SRT/ICE for HQ streaming, UDP range + TCP fallback for LiveKit
sudo ufw allow 1935/tcp        # RTMP ingest (GSR push)
sudo ufw allow 8890/udp        # SRT ingest (GSR push, Opus audio)
sudo ufw allow 8189/udp        # MediaMTX WebRTC ICE
sudo ufw allow 7881/tcp        # LiveKit TCP fallback
sudo ufw allow 7882:7892/udp   # LiveKit RTC

# 4. pull + start (must run from infra/prod/ so docker compose finds .env)
cd ~/pulse/infra/prod
docker compose pull
docker compose up -d

# 5. Caddy: add the pulse vhost (see Caddyfile.pulse.snippet), then reload
cp ~/caddy/Caddyfile ~/caddy/Caddyfile.bak.$(date +%s)
printf '\npulse.unicutmedia.com {\n\treverse_proxy host.docker.internal:8100\n}\n' >> ~/caddy/Caddyfile
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

Backups: `pulse_pg` (Postgres data), `pulse_redis` (AOF), `pulse_avatars`
(uploaded avatars) are Docker named volumes — back them up with the rest of the
VPS volume backups.
