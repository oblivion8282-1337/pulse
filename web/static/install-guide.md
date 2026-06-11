# Pulse Self-Host — Installation & Troubleshooting Reference

> **Audience:** This document is written for AI assistants (and humans) helping
> a server operator install or debug a self-hosted Pulse instance. It describes
> exactly what the one-command installer does, what the resulting system looks
> like, and how to diagnose the common failure modes. It is served from
> `https://howispulse.com/install/guide` and is versioned together with the
> installer script (`https://howispulse.com/install`).
>
> **Safety rules for assistants:** Never print or log the contents of
> `pulse.env` (it contains `PULSE_CLOUD_CLIENT_SECRET`). Never paste a
> bootstrap token into anything other than the install command. Do not
> disable TLS or expose internal ports publicly.

## 1. What is being installed

Pulse is a web-first chat/voice/screen-streaming platform (think Discord-like).
A self-hosted Pulse server is **one single Docker container**
(`ghcr.io/oblivion8282-1337/pulse-allinone`) that bundles:

- 5 Python (FastAPI) backend services: auth, chat-gateway, voice-signaling,
  media-svc, mediamtx-auth-hook
- embedded PostgreSQL 15 and Redis 7
- LiveKit (voice SFU, WebRTC), MediaMTX (HQ stream relay), coturn (TURN/STUN)
- MinIO (S3-compatible store for message attachments)
- Caddy as the **internal** reverse proxy (and TLS terminator in `auto` mode)
- s6-overlay v3 as PID 1 supervising all of the above

The web app itself is NOT in this container — users connect with the official
client at https://howispulse.com (or the desktop/Android apps). User identity
also stays central: users log in once at the Pulse Cloud and authenticate to
self-host servers with short-lived certificates ("cert-login"). The self-host
server only needs **outbound HTTPS** to `https://howispulse.com` for that; the
Cloud never needs to reach the server.

## 2. The install flow

The operator generates a personalized command in the Pulse app
(Settings → Self-Host → My instances → "Set up server"):

```
curl -fsSL https://howispulse.com/install | PULSE_BOOTSTRAP_TOKEN=<BOOTSTRAP_TOKEN> bash
```

The token is passed as an environment variable on purpose: script arguments
(`bash -s -- <TOKEN>`, still supported as a fallback) are visible to every
local user in `ps` while the script runs; environment variables are not.

To review the script before running it (recommended on shared or
production hosts), download it first:

```
curl -fsSL https://howispulse.com/install -o pulse-install.sh
less pulse-install.sh
PULSE_BOOTSTRAP_TOKEN=<BOOTSTRAP_TOKEN> bash pulse-install.sh
```

Facts about the token (`plse_boot_…`):

- **Single-use** and **expires after 20 minutes.** Redeeming it rotates the
  instance's pairing secret server-side, so re-running the installer always
  needs a *fresh* token from the app ("regenerate"). Re-installing any number
  of times is safe and supported.
- If the script fails *after* "Redeeming bootstrap token…", the token is
  consumed — generate a new one before retrying.
- `--dry-run` (`… | PULSE_BOOTSTRAP_TOKEN=<TOKEN> bash -s -- --dry-run`)
  prints the detection result and the planned `docker run` command
  **without consuming the token** (the token must still be present).

### What the script does, step by step

1. **Checks Docker** (`docker info` must work — root or `docker` group).
2. **Detects the environment** and picks one of four modes:
   - `discovery` — an auto-discovery proxy is running in Docker
     (caddy-docker-proxy, Traefik, or nginx-proxy). Pulse joins the proxy's
     Docker network and sets the right labels/env vars
     (Traefik certresolver is inherited from existing containers;
     nginx-proxy gets `VIRTUAL_HOST`/`VIRTUAL_PORT`, plus
     `LETSENCRYPT_*` if an acme-companion is present). **Zero manual steps.**
     Exception: if the detected proxy only sits on Docker's default bridge
     network (no user network to join), the script warns and falls back to
     `hostproxy` mode.
   - `greenfield` — ports 80+443 are free and no proxy exists. Pulse publishes
     80/443 itself and obtains its own Let's Encrypt certificate
     (`PULSE_TLS_MODE=auto`). **Requires the DNS record to already point at
     this machine.**
   - `static-docker` — a dockerized but non-auto-discovery proxy (plain Caddy
     or nginx container) occupies 80/443. Pulse joins that proxy's network;
     the script prints the **one route** to add (target
     `http://pulse:8080`) and the exact reload command.
   - `hostproxy` — a reverse proxy runs directly on the host (systemd Caddy/
     nginx/Apache). Pulse binds `127.0.0.1:8080`; the script prints the route
     (target `http://127.0.0.1:8080`) and a generic reload hint.
3. **Redeems the token** at `POST https://howispulse.com/api/auth/selfhost/bootstrap`
   → receives `instance_id`, `owner_user_id`, `hostname`, `client_id`,
   `client_secret`, `admin_email`.
4. **Writes the env file** with `chmod 600`:
   - as root: `/opt/pulse/pulse.env`
   - as non-root: `~/.pulse/pulse.env`
5. **Starts the container** `pulse` with volume `pulse-data:/data`,
   `--restart unless-stopped`, and always publishes the voice/streaming ports
   (see §4).
6. **Sets up auto-updates via a host systemd timer** (not a container). The
   installer writes `pulse-update.sh` next to the env file and a
   `pulse-update.service`/`.timer` pair under `/etc/systemd/system/`, then
   enables the timer (checks every 5 min). The script pulls the configured
   image and, only if its digest changed, recreates the `pulse` container with
   the exact same run arguments. **No container holds the Docker socket** —
   deliberately, so a compromised app image cannot reach host root through an
   updater. Skipped if `PULSE_NO_AUTOUPDATE` (alias `PULSE_NO_WATCHTOWER`) is
   set. As root with systemd it installs a `pulse-update.timer`; without root
   it falls back to a **user crontab** (no sudo needed, same 5-min cadence) so
   non-root installs keep auto-updating too; only if neither systemd nor
   crontab exists is the script left unscheduled (run it manually). An older
   `pulse-watchtower` container from a previous install is removed on re-run.
7. **Health-checks** `…/api/chat/health` for up to 5 minutes (first boot runs
   DB migrations and, in greenfield, the ACME handshake — ~1 min is normal).

### Environment overrides (set before the curl command)

| Variable | Effect |
|---|---|
| `PULSE_TLS_MODE=auto\|behind-proxy` | Force greenfield / behind-proxy mode |
| `PULSE_NETWORK=<docker net>` | Force joining a specific Docker network |
| `PULSE_CONTAINER` (default `pulse`) | Container name |
| `PULSE_HTTP_PORT` (default `8080`) | Internal HTTP port in behind-proxy modes |
| `PULSE_DIR` | Config directory (default `/opt/pulse` or `~/.pulse`) |
| `PULSE_VOLUME` (default `pulse-data`) | Data volume name |
| `PULSE_NO_AUTOUPDATE=1` | Skip auto-update setup (alias: `PULSE_NO_WATCHTOWER=1`) |
| `PULSE_IMAGE` | Alternative image/tag |
| `PULSE_BOOTSTRAP_TOKEN` | Token via env instead of as argument (automation) |
| `PULSE_CLOUD_ORIGIN` | Alternative cloud origin (default `https://howispulse.com`) |

## 3. The resulting system

- Container `pulse`, volume `pulse-data` mounted at `/data`
- Env file `/opt/pulse/pulse.env` (root) or `~/.pulse/pulse.env` (chmod 600).
  Required vars: `PULSE_HOSTNAME`, `PULSE_INSTANCE_ID`,
  `PULSE_INSTANCE_OWNER_ID`, `PULSE_INSTANCE_MODE=self-host`,
  `PULSE_CLOUD_ORIGIN`, `PULSE_CLOUD_CLIENT_ID`, `PULSE_CLOUD_CLIENT_SECRET`,
  `PULSE_ADMIN_EMAIL`, `PULSE_TLS_MODE`, `PULSE_HTTP_PORT`.
- Auto-update via host systemd timer `pulse-update.timer` (5-min interval),
  driven by `pulse-update.sh` in the config dir. No updater container, no
  Docker socket mounted anywhere.
- All internal secrets (Postgres password, JWT signing keys, LiveKit keys,
  MinIO credentials, coturn secret) are **generated on first boot** and live
  in the volume under `/data/jwt_keys/` etc.

**Backup-critical paths inside the volume:** `/data/pg/` (database),
`/data/jwt_keys/` (losing this invalidates every session), `/data/minio/`
(attachments), `/data/uploads/` (avatars/icons), `/data/caddy/` (TLS state).

## 4. Network requirements

| Port | Protocol | Purpose | When |
|---|---|---|---|
| 80, 443 | tcp | HTTP/HTTPS (Let's Encrypt + app traffic) | greenfield only — otherwise the existing proxy owns them |
| 7882–7892 | udp | LiveKit WebRTC media (voice) | always published |
| 3478 | tcp+udp | TURN/STUN (voice through strict NATs) | always published |
| 1936 | tcp | RTMPS ingest (HQ screen streaming from the desktop app) | always published |
| 8189 | udp | MediaMTX WebRTC/WHEP ICE (HQ-stream playback) | always published |

Firewall (ufw/cloud security group) must allow these. The DNS A/AAAA record
for the chosen hostname must point at the server **before** install in
greenfield mode (Let's Encrypt validation), and before first use in all modes.

**Note on Docker and host firewalls (ufw/firewalld):** Docker publishes these
ports via its own iptables chains, which take effect *before* ufw/firewalld
rules — a `ufw deny` on a Docker-published port does NOT block it. This is
standard Docker behaviour, not Pulse-specific. The published ports above are
required for voice and HQ streaming to work and every service behind them
requires token authentication (LiveKit access tokens, MediaMTX publish-token
hook, TURN credentials). To restrict them anyway, filter upstream (cloud
security group) or use Docker's own mechanisms (`DOCKER-USER` chain).

### Reverse-proxy route (static-docker / hostproxy modes)

ONE route: the full hostname → `http://<target>` where target is
`pulse:8080` (dockerized proxy on the shared network) or `127.0.0.1:8080`
(host proxy). Requirements:

- **WebSockets must pass through.** Caddy's `reverse_proxy` does this
  automatically. nginx needs:
  ```nginx
  location / {
      proxy_pass http://<target>;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
  }
  ```
- Forward **all paths** for the hostname — no path allow-listing. The
  container's internal Caddy handles routing (`/api/auth|chat|ws|voice/*`,
  `/.well-known/*`, `/whep`, `/hls`, `/livekit`, `/pulse-attachments/*`).
- Do not buffer/limit streaming responses aggressively; keep
  `client_max_body_size` reasonably high (attachments, default uploads
  ~25 MB).

## 5. Verification

```bash
docker ps                                   # pulse running? (no updater container by design)
docker logs -f pulse                        # s6 service startup, migrations
systemctl status pulse-update.timer         # auto-update timer active? (root + systemd)
curl -fsS https://<host>/api/chat/health    # → {"status":"ok"} when up
curl -fsS https://<host>/.well-known/pulse-server-info   # version + instance info
```

Then in the Pulse app: Settings → Self-Host → add the server / it appears in
the left rail. The app's pre-check fetches
`https://<host>/.well-known/pulse-server-info` **from the browser** — if that
fails with a CORS error, traffic is not reaching the container's internal
Caddy (which sets the CORS headers); almost always a proxy-route problem.

## 6. Common failures and fixes

| Symptom | Cause | Fix |
|---|---|---|
| `Token redemption failed` | Token >20 min old or already used (each token is single-use; a failed run after redemption still consumed it) | Generate a fresh command in the app ("regenerate") |
| Script dies silently or `mkdir: permission denied` | Running as non-root without a writable config dir | Run with `sudo`, or set `PULSE_DIR=$HOME/.pulse`; user must be in the `docker` group |
| Health check never green (greenfield) | DNS record not pointing at this server → Let's Encrypt cannot validate | Fix the A/AAAA record, then `docker restart pulse`; watch `docker logs pulse` for ACME messages |
| `port is already allocated` on 80/443 | Another service owns the ports but was not detected as a proxy | Set `PULSE_TLS_MODE=behind-proxy` and add the route manually, or stop the conflicting service |
| App says server unreachable / "cors-blocked" | Proxy route missing, pointing at the wrong target, or only forwarding some paths | Add/fix the single catch-all route for the hostname → `http://pulse:8080` (or `127.0.0.1:8080`), reload the proxy |
| Login works but chat never loads / reconnect loop | WebSocket upgrade not forwarded by the proxy | Add the `Upgrade`/`Connection` headers (nginx, see §4); Caddy handles it automatically |
| Voice connects but no audio, or fails on mobile networks | UDP 7882–7892 and/or 3478 blocked by firewall | Open the ports (ufw/security group), tcp+udp for 3478 |
| Editing a bind-mounted Caddyfile: `sed -i` → "Resource busy" | `sed -i` renames the file; bind mounts forbid that | Overwrite contents instead: `sed … Caddyfile > /tmp/cf && cat /tmp/cf > Caddyfile` |
| Auto-update never happens | Timer not installed (ran as non-root or no systemd), or Docker unreachable from the timer's environment | `systemctl status pulse-update.timer`; if absent, run `pulse-update.sh` manually or add the cron line the installer printed. Check `journalctl -u pulse-update` for pull errors |
| New version not picked up though timer runs | Image tag unchanged or pull failing (rate limit / auth) | `journalctl -u pulse-update --no-pager`; run the script by hand to see the pull error |
| Container halts after repeated crashes | Built-in restart gate: >5 crashes in 60 s stops the container to break corruption loops | `docker logs pulse` to find the failing s6 service; fix cause; `docker start pulse` |
| Everyone logged out after volume loss/recreate | `/data/jwt_keys/` regenerated → all sessions invalid | Expected. Restore the volume from backup if unintended |
| Operator's own account is not admin on the instance | `PULSE_INSTANCE_OWNER_ID` mismatch (the cert-login of the owner's Cloud account grants admin) | Verify the env file matches the values from the bootstrap response; reinstall with a fresh token if unsure |

### Diagnostic cheat sheet

```bash
docker logs --tail 200 pulse        # all s6 services log here, prefixed
docker exec pulse s6-rc -a list     # which internal services are up
docker inspect pulse --format '{{json .NetworkSettings.Networks}}'   # network attachment
ss -ltnp | grep -E ':(80|443|8080)' # who owns the HTTP ports
curl -v https://<host>/.well-known/pulse-server-info                  # end-to-end route test
docker exec pulse curl -fsS http://127.0.0.1:8080/api/chat/health     # bypass the external proxy (behind-proxy modes; greenfield: use https://<host>/… directly)
```

The last two commands bracket the problem: if the in-container check is green
but the external one fails, the issue is DNS/proxy/firewall — not Pulse.

## 7. Updates, reinstall, removal

- **Updates:** automatic via the host systemd timer `pulse-update.timer`
  (≤5 min after a new image is published). Manual: run `pulse-update.sh` (in
  the config dir) — it pulls and, if the digest changed, recreates the
  container with the stored run arguments. Or simply re-run the installer with
  a fresh token — config and data are preserved; the volume is never deleted.
- **Reinstall/secret rotation:** re-running the installer with a new token is
  always safe; it rotates the pairing secret and rewrites `pulse.env`.
- **Removal:** `docker rm -f pulse`, then
  `systemctl disable --now pulse-update.timer` and remove
  `/etc/systemd/system/pulse-update.{service,timer}` (`systemctl daemon-reload`).
  Optionally `docker volume rm pulse-data` (destroys all data) and delete the
  config dir (which also holds `pulse-update.sh`).
