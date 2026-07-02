# Deploying Pulse to the VPS

Production runs on the Hetzner VPS (`michael@77.42.71.166`, alongside Caddy and
the other apps). Public URL: **https://howispulse.com**. The whole stack
is one Docker Compose project (`name: pulse`) in `~/pulse/infra/prod/`.

App images (`ghcr.io/oblivion8282-1337/pulse-*`) are built by
`.github/workflows/ci.yml` on every push to `main` and auto-pulled on the server
by a **user crontab** running `infra/prod/pulse-update.sh` every 5 min (scoped
pull+`up -d` of the app services + migrate one-shots). postgres / redis / minio /
mediamtx / livekit are pinned in the compose file and deliberately NOT
auto-updated. **No Watchtower** — it mounted the Docker socket (= root on the
host); the cron script keeps the updater as a small host script with no socket
container. Unlike the old Watchtower, the migrate one-shots are included, so
schema migrations apply automatically on deploy (no more manual
`up -d migrate-*`).

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
  -subj "/CN=howispulse.com" \
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
printf '\nhowispulse.com {\n\treverse_proxy pulse_web:80\n}\n' >> ~/caddy/Caddyfile
docker network connect pulse-net caddy 2>/dev/null || true   # idempotent
docker exec caddy caddy reload --config /etc/caddy/Caddyfile

# 6. auto-update via user crontab (no Watchtower, no sudo, no socket container).
#    pulse-update.sh does a scoped `compose pull && up -d` of the app images.
chmod +x ~/pulse/infra/prod/pulse-update.sh
( crontab -l 2>/dev/null | grep -v 'pulse-update.sh'   # drop any old entry
  echo '*/5 * * * * /home/michael/pulse/infra/prod/pulse-update.sh >> /home/michael/pulse/infra/prod/pulse-update.log 2>&1'
) | crontab -
crontab -l            # verify
```

## Volume ownership gotcha (fresh deploys)

The auth service stores uploaded avatars in the named volume `pulse_avatars`
(`pulse_auth:/app/services/auth/uploads`). `services/*/uploads` is in
`.dockerignore`, so it's not baked into the image — `Dockerfile.service` creates
`uploads/avatars` *after* `USER app`, so a fresh empty named volume inherits `app`
ownership on first seed. If the volume somehow ends up `root:root` (uid 10001 in
the container then can't write → avatar upload fails with `500 PermissionError`),
fix it once:

```sh
docker exec -u root pulse_auth chown -R 10001:10001 /app/services/auth/uploads
```

The JWT PEM keys have the same uid-10001 constraint — see step 2 above
(`jwt_private.pem` `0600` + chowned, `jwt_public.pem` `0644`).

## Updating

- **Code / bug fixes** → just `git push` to `main`. CI builds & pushes the
  images; the cron updater (`pulse-update.sh`) pulls & recreates the affected
  containers within ≤5 min. Nothing to do on the server.
- **Compose / config changes** (new service, new env var, MediaMTX/LiveKit
  version bump, nginx routing) → `rsync` the changed `infra/` files to
  `~/pulse/infra/`, then on the server `cd ~/pulse/infra/prod && docker compose
  up -d` (and for new env vars: edit `~/pulse/infra/prod/.env` first).
- **Migrations** run automatically — `pulse_migrate_auth` / `pulse_migrate_chat`
  (the auth/chat images with `alembic upgrade head`) run before the services on
  every `up`.

## Steuerungs-Relay (②a) aktivieren

Manuelle Checkliste — einmalig ausführen, wenn das Relay erstmals in Prod geht.
Voraussetzung: Tasks 1–3 (auth-Endpoint, frps-Container, CI-Env) sind bereits auf `main` deployed.

1. **DNS:** `*.relay.howispulse.com` A-Record auf die Server-IP setzen (beim DNS-Provider). Propagation abwarten bevor Caddy on-demand-TLS ausgelöst wird.

2. **UFW:** `sudo ufw allow 7000/tcp` — frpc-Clients verbinden sich auf Port 7000 (frps-Bind-Port).

3. **`.env`:** auf dem Server `~/pulse/infra/prod/.env` öffnen und eintragen:
   ```
   PULSE_RELAY_SERVER_ADDR=howispulse.com:7000
   PULSE_RELAY_BASE_DOMAIN=relay.howispulse.com
   ```
   `INTERNAL_SERVICE_SECRET` ist bereits gesetzt (wird vom Relay-Plugin mitgenutzt).

4. **Deploy:** Compose-Struktur hat sich geändert (neuer `frps`-Service) → manuell übertragen und hochfahren:
   ```sh
   rsync -av --exclude .env --exclude secrets infra/ michael@159.195.150.54:~/pulse/infra/
   cd ~/pulse/infra/prod && docker compose up -d
   ```
   Der Cron-Updater zieht nur App-`:latest`-Images — Struktur-Änderungen (neuer Service, neue Env-Vars) brauchen diesen manuellen Schritt.

5. **Caddy:** globalen `on_demand_tls`-Block + `*.relay`-Site-Block einfügen (Vorlage: `Caddyfile.pulse.snippet`). Der globale Options-Block muss **ganz oben** in der Live-Caddyfile stehen und darf **nur einmal** vorkommen — keinen zweiten `{ … }`-Block anlegen.
   ```sh
   cp ~/caddy/Caddyfile ~/caddy/Caddyfile.bak.$(date +%s)
   $EDITOR ~/caddy/Caddyfile   # globalen Block oben einfügen, *.relay-Block ans Ende
   docker network connect pulse-net caddy 2>/dev/null || true   # idempotent
   docker exec caddy caddy reload --config /etc/caddy/Caddyfile
   ```
   Caddy muss im `pulse-net` sein, damit er `frps` per Container-Name auflösen kann.

6. **Smoke-Test:** Ein Heim-Host (frpc konfiguriert) verbindet sich mit `howispulse.com:7000`. Ein entferntes Mitglied öffnet `https://<slug>.relay.howispulse.com` — Caddy holt das Cert on-demand (nur wenn `/selfhost/relay/tls-check` 200 antwortet) und der Tunnel ist aktiv.

## Self-Host-Registry (registry.howispulse.com) aktivieren

Verteilt das `pulse-allinone`-Image an Self-Host-User hinter per-Instance-Credentials
(`client_id`/`client_secret`, Argon2id) — nötig geworden, weil das Repo auf **private**
gestellt wurde und GHCR die Sichtbarkeit erbt (ein verlinktes Package kann bei
private Repo nicht public sein). GHCR bleibt Source-of-Truth für die Cloud-Service-
Images; nur das All-in-one (Self-Host) läuft über die eigene Registry. Architektur +
Token-Auth-Spec: `infra/prod/registry-config.yml` + `services/auth/src/dcc_auth/routes_registry_auth.py`.

Manuelle Checkliste — einmalig, wenn die Registry erstmals in Prod geht.
**Erledigt 2026-07-02** (alle Schritte live verifiziert); bleibt als Referenz für
Re-Provisionierung und JWT-Key-Rotation.
Voraussetzung: Branch `feat/registry-token-auth` ist auf `main` deployed (auth-svc
hat die `/registry/token`-Route, compose kennt den `registry`-Service).

1. **Signier-Cert:** im Prod-Dir (neben `secrets/jwt_private.pem`) ein self-signed-
   x509-Cert erzeugen, das **dasselbe RSA-Keypair** wrapt:
   ```sh
   cd ~/pulse/infra/prod
   openssl req -x509 -new -key secrets/jwt_private.pem -days 3650 \
     -subj "/CN=pulse-registry-auth" -out secrets/jwt_public.crt
   ```
   Die Registry braucht es als `rootcertbundle` (parst nur CERTIFICATE-PEM — ein
   roher PUBLIC KEY wird still ignoriert → Registry startet nicht); die Tokens
   tragen es als `x5c`-Header. **Bei JWT-Key-Rotation Cert neu erzeugen + Registry
   redeployen**, sonst schlägt die Token-Verifikation still fehl.
   Zusätzlich in `~/pulse/infra/prod/.env`: `JWT_CERT_FILE=/secrets/jwt_public.crt` —
   der auth-svc-Default ist ein **relativer** Pfad und zeigt im Container ins Leere
   → Realm-Endpoint wirft 500 (`jwt_cert_file fehlt/unlesbar`).
   Hinweis: `jwt_private.pem` gehört uid 10001 (0600) — wenn der SSH-User es nicht
   lesen darf, openssl in einem Container laufen lassen
   (`docker run --rm -v ~/pulse/infra/prod/secrets:/s alpine/openssl req …`).

2. **DNS:** A-Record `registry.howispulse.com → 159.195.150.54` (beim DNS-Provider).
   Propagation abwarten bevor Caddy ACME auslöst.

3. **`REGISTRY_PUSH_TOKEN`** (für CI-Push als `pulse-ci`): generieren und **identisch**
   an zwei Stellen setzen:
   ```sh
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   ```
   - GitHub → Repo Settings → Secrets → `REGISTRY_PUSH_TOKEN`
   - Server `~/pulse/infra/prod/.env` → `REGISTRY_PUSH_TOKEN=<selber Wert>`
   Ohne Secret skippt der CI-Mirror (GHCR bleibt aktuell); die Registry läuft, bekommt
   aber keine neuen Images.

4. **Deploy:** neuer `registry`-Service → infra übertragen + hochfahren:
   ```sh
   rsync -av --exclude .env --exclude secrets infra/ michael@159.195.150.54:~/pulse/infra/
   cd ~/pulse/infra/prod && docker compose up -d registry auth
   ```
   Der Cron-Updater zieht nur App-`:latest`-Images — neue Services brauchen diesen
   manuellen Schritt. `auth` muss mit recreatet werden, damit es die neuen Env-Vars
   (`REGISTRY_PUSH_TOKEN`, `JWT_CERT_FILE`) aufnimmt.

5. **Caddy:** `registry.howispulse.com`-Site-Block einfügen (Vorlage
   `Caddyfile.pulse.snippet`), Caddy im `pulse-net`, reload:
   ```sh
   cp ~/caddy/Caddyfile ~/caddy/Caddyfile.bak.$(date +%s)
   $EDITOR ~/caddy/Caddyfile   # registry.howispulse.com-Block ans Ende
   docker network connect pulse-net caddy 2>/dev/null || true
   docker exec caddy caddy reload --config /etc/caddy/Caddyfile
   ```

6. **Smoke-Test** (von einer Test-Maschine mit einer aktiven Instanz):
   ```sh
   docker login registry.howispulse.com -u <client_id> -p <client_secret>   # Login OK
   docker pull registry.howispulse.com/pulse-allinone:edge                  # klappt
   ```
   - Anonymer Pull → **401** (Token-Auth wirkt).
   - Instanz suspendieren (`/admin/instances/{id}`) → nach 5 min (Token-TTL) schlägt
     der Pull fehl → **403/401**; un-suspenden → Pull wieder ok.

7. **CI-Mirror:** sobald das GitHub-Secret steht, mirrort der nächste `allinone`-Build
   das Image per `imagetools create` nach `registry.howispulse.com` (Workflow-Log →
   „Mirror to registry.howispulse.com"). GHCR bleibt Source-of-Truth — schlägt der
   Mirror fehl, laufen die GHCR-Tags trotzdem.

8. **GC-Cron** (wöchentlich, Host-Crontab): `registry:2` GC't nicht selbst; alte
   ungetaggte Blobs aufräumen (kurze Downtime, ok für `:edge`/`:stable`):
   ```sh
   17 4 * * 0  docker stop pulse_registry; docker run --rm \
     -v pulse_pulse_registry:/var/lib/registry \
     -v ~/pulse/infra/prod/registry-config.yml:/etc/docker/registry/config.yml:ro \
     registry:2.8.3 garbage-collect --delete-untagged /etc/docker/registry/config.yml; \
     docker start pulse_registry
   ```
   Das Volume heißt `pulse_pulse_registry`, nicht `pulse_registry` — Compose prefixt
   mit dem Projektnamen (`name: pulse`); der falsche Name GC't ein leeres Frisch-Volume.

9. **Hetzner-Test umstellen** (`pulse.unicutmedia.com`, einzelner allinone hinter
   Host-Caddy): mit den vorhandenen Instanz-Creds einloggen + Container auf die neue
   Image-Source umstellen (gleiche Run-Args wie bisher, nur Image anders):
   ```sh
   docker login registry.howispulse.com -u <hetzner_client_id> -p <client_secret>
   docker stop pulse && docker rm pulse
   docker run -d --name pulse --restart unless-stopped --env-file …/pulse.env \
     -v pulse-data:/data <…restliche Ports/Args…> registry.howispulse.com/pulse-allinone:edge
   ```
   Creds vergessen? Bootstrap-Token minten (`/me/instances/{id}/bootstrap-token`) +
   redeemen → rotiert das `client_secret`. Danach Health-Check
   (`https://pulse.unicutmedia.com/api/chat/health`).

> **Phase 3 (aufgeschoben):** Stripe-Billing + ein cloud-seitiger Lizenzcheck über
> den bestehenden cert/phone-home-Kanal werden später an den `status=="active"`-Check
> im Realm-Endpoint gekoppelt (Stelle im Code markiert). Diese Registry ist Verteilung
> + Honest-User-Gate, **kein** Kopierschutz — Image/Code bleiben extrahierbar (AGPL).

## Operating

```sh
cd ~/pulse/infra/prod
docker compose ps                       # status
docker compose logs -f auth chat-gateway   # tail logs
docker compose restart <service>
./pulse-update.sh                       # force an update now (what the cron runs)
crontab -l                              # confirm the 5-min auto-update is scheduled
tail -f ~/pulse/infra/prod/pulse-update.log   # see what the updater is doing
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
