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
(`registry.howispulse.com/pulse-allinone`) that bundles:

- 5 Python (FastAPI) backend services: auth, chat-gateway, voice-signaling,
  media-svc, mediamtx-auth-hook
- embedded PostgreSQL 15 and Redis 7
- LiveKit (voice SFU, WebRTC), MediaMTX (HQ stream relay), coturn (TURN/STUN)
- MinIO (S3-compatible store for message attachments)
- Caddy as the **internal** reverse proxy (and TLS terminator in `auto` mode)
- s6-overlay v3 as PID 1 supervising all of the above

The image is built once and mirrored to two registries; **pull from
`registry.howispulse.com`, never from `ghcr.io`** — the `ghcr.io/oblivion8282-1337/pulse-*`
packages are private and reject anonymous pulls, while `registry.howispulse.com`
authenticates per-instance with the `client_id`/`client_secret` from the
bootstrap response (the installer logs in automatically). The installer
defaults to the rolling `:edge` tag (override with `PULSE_IMAGE`, see below);
in the current early/security phase every `main` push tags `:edge` and
`:stable` identically, so pinning `:stable` does not yet buy you a slower
channel.

The web app itself is NOT in this container — users connect with the official
client at https://howispulse.com (or the desktop/Android apps). User identity
also stays central: users log in once at the Pulse Cloud and authenticate to
self-host servers with short-lived certificates ("cert-login"). The self-host
server only needs **outbound HTTPS** to `https://howispulse.com` for that —
the Cloud never needs to reach the server for normal operation. The one
exception is the optional reachability diagnosis (`POST
/selfhost/diagnose/{id}`, run automatically once at the end of the installer
and on demand via "Check connection" in the app): it has the Cloud actively
probe the server from outside to find which link in the chain is broken. See
§5 and §6.

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

- **Single-use** and **expires after 2 hours.** Redeeming it rotates the
  instance's pairing secret server-side. Before the first successful redeem
  you can mint as many fresh tokens as you like via "regenerate" in the app.
  After a successful redeem, minting another token for the *same* instance
  needs an explicit "Reset" (not plain "regenerate") — it is the deliberate
  recovery path after losing a device or credentials, and it revokes the
  previous server's access immediately. Re-installing any number of times is
  safe and supported either way.
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
     Exception: if the detected proxy runs with `--network host` (no
     dedicated Docker network of its own), the script falls back to
     `hostproxy` mode automatically. If it instead sits only on Docker's
     **default bridge** network (not host-networked, no user network to
     join), the script **aborts** and asks you to set `PULSE_NETWORK`
     explicitly — a 127.0.0.1 target in that case would be the *proxy
     container's own* loopback, unreachable from Pulse, and guessing a
     network once put Pulse into a different project's network on a real
     machine.
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
5. **Starts the container** (name `pulse` unless `PULSE_CONTAINER` overrides
   it) with volume `pulse-data:/data` (or `PULSE_VOLUME`),
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
7. **Tracks first-boot progress** by polling `docker exec <container> cat
   /data/setup-status` for up to 5 minutes (not an HTTP health check — the
   container may not even be reachable yet, e.g. in `greenfield` mode before
   Caddy has a certificate). Each line is one boot phase (config check,
   secrets, DB init, coturn, LiveKit config, env render, MediaMTX config,
   Caddy config, migrations); the script prints a live checklist as phases
   complete. This does **not** cover the Let's Encrypt handshake itself —
   Caddy fetches the certificate as a separate longrun service after these
   phases finish; see §5 for how certificate status is checked.
8. **If a proxy route is still needed** (`static-docker`/`hostproxy` modes),
   prints the exact route + reload command (see §4) and waits for Enter
   (up to 10 minutes) before continuing — the external check in the next
   step would otherwise just fail on a route that doesn't exist yet.
9. **Runs the same reachability diagnosis as "Check connection" in the app**
   (`POST /selfhost/diagnose/{id}`, Cloud-side) and prints the resulting
   checklist right in the terminal — DNS, TCP, TLS, proxy routing, CORS,
   WebSocket upgrade, UDP media ports, in that order, stopping at and
   explaining the first broken link. If the check itself cannot run (no
   outbound reach to the Cloud), the script says so and points at
   `docker exec <container> pulse-doctor` instead. See §5 and §6.

### Environment overrides (set before the curl command)

| Variable | Effect |
|---|---|
| `PULSE_TLS_MODE=auto\|provided\|behind-proxy` | Force greenfield / own-cert / behind-proxy mode |
| `PULSE_NETWORK=<docker net>` | Force joining a specific Docker network |
| `PULSE_CONTAINER` (default `pulse`) | Container name |
| `PULSE_HTTP_PORT` (default `8080`) | Internal HTTP port in behind-proxy modes |
| `PULSE_DIR` | Config directory (default `/opt/pulse` or `~/.pulse`) |
| `PULSE_VOLUME` (default `pulse-data`) | Data volume name |
| `PULSE_NO_AUTOUPDATE=1` | Skip auto-update setup (alias: `PULSE_NO_WATCHTOWER=1`) |
| `PULSE_IMAGE` (default `registry.howispulse.com/pulse-allinone:edge`) | Alternative image/tag/registry |
| `PULSE_BOOTSTRAP_TOKEN` | Token via env instead of as argument (automation) |
| `PULSE_CLOUD_ORIGIN` (default `https://howispulse.com`) | Alternative cloud origin |

This table covers switches read *before* `docker run` — i.e. while the curl
command itself is executing. It does **not** include
`PULSE_UPDATE_STABIL_VERSUCHE`/`PULSE_UPDATE_STABIL_INTERVALL`: those tune
the *generated updater* (`pulse-update.sh`, see §7), not the installer, and
setting them before the curl command has no effect on later update runs —
they must be exported in the environment that actually invokes
`pulse-update.sh` (the systemd unit's `Environment=` line, or the crontab
entry). They exist mainly so tests don't have to wait out the real ~15 s
default window; the default is fine for normal operation.

## 3. The resulting system

All commands in this document assume the default names below. If
`PULSE_CONTAINER`/`PULSE_VOLUME` were set at install time (§2), substitute
those names everywhere a command says `pulse` / `pulse-data`.

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
  container's internal Caddy handles routing (`/health`, `/api/auth|chat|voice/*`,
  `/ws`, specific `/.well-known/*` names — jwks.json, revoked-credentials,
  pulse-version-policy.json, pulse-suspended-instances, pulse-server-info,
  deliberately not a wildcard so `/.well-known/acme-challenge/*` stays free
  for its own Let's Encrypt use — `/whep`, `/livekit`, `/pulse-attachments/*`).
  There is no route for HLS (`/hls`) — self-host playback goes over WHEP.
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
fails with a CORS error, the request is not reaching chat-gateway inside the
container (which sets the CORS headers itself via its own middleware — the
internal Caddy deliberately does **not** set them, to avoid duplicate
`Access-Control-Allow-Origin` headers); almost always a proxy-route problem.

### The automatic reachability checklist

The installer's own last step (§2, step 9) already ran this same check and
printed a checklist — DNS, TCP reachability, TLS/certificate, proxy routing,
CORS, WebSocket upgrade, UDP media ports — stopping at and explaining the
first broken link, with the remaining links marked "not checked, the chain
stopped before them" rather than looking complete. Re-run it any time from
the app ("Settings → Self-Host → My instances → Check connection") or, if the
server cannot reach the Cloud right now, from inside the container:

```bash
docker exec pulse pulse-doctor
```

`pulse-doctor` separates three directions — internal (are the services up?),
outbound (does the container reach the Cloud?), inbound (is the server
reachable under its own name?) — and prints nothing secret. `curl
https://<host>/health/setup` shows the same first-boot phase list step 7 (§2)
prints live, plus a `zertifikat` field for whether Caddy has obtained a
certificate yet (only meaningful in `auto` mode).

## 6. Common failures and fixes

Commands below use the default container name `pulse` — substitute your
`PULSE_CONTAINER` value if you set one at install time (§2, §3).

| Symptom | Cause | Fix |
|---|---|---|
| `Token redemption failed` | Token >2 h old or already used (each token is single-use; a failed run after redemption still consumed it) | Generate a fresh command in the app ("regenerate", or "Reset" if this instance was already redeemed once — see §2) |
| Script dies silently or `mkdir: permission denied` | Running as non-root without a writable config dir | Run with `sudo`, or set `PULSE_DIR=$HOME/.pulse`; user must be in the `docker` group |
| `A container named 'pulse' already exists, but its image doesn't look like a Pulse installation` | An unrelated container happens to use the same name; the installer refuses to touch anything it can't identify as Pulse | Rename/remove that container yourself, or set `PULSE_CONTAINER=<a different name>` and run the command again (nothing was consumed yet) |
| Startup checklist (step 7) never reaches "startup complete" (greenfield) | Usually DNS not pointing at this server yet — though the checklist itself doesn't cover the certificate step (see §5); check `curl https://<host>/health/setup` for the `zertifikat` field | Fix the A/AAAA record, then `docker restart pulse`; watch `docker logs pulse` for ACME messages |
| `port is already allocated` on 80/443 | Another service owns the ports but was not detected as a proxy | Set `PULSE_TLS_MODE=behind-proxy` and add the route manually, or stop the conflicting service |
| App says server unreachable / "cors-blocked" | Proxy route missing, pointing at the wrong target, or only forwarding some paths | Add/fix the single catch-all route for the hostname → `http://pulse:8080` (or `127.0.0.1:8080`), reload the proxy |
| Login works but chat never loads / reconnect loop | WebSocket upgrade not forwarded by the proxy | Add the `Upgrade`/`Connection` headers (nginx, see §4); Caddy handles it automatically |
| Voice connects but no audio, or fails on mobile networks | UDP 7882–7892 and/or 3478 blocked by firewall | Open the ports (ufw/security group), tcp+udp for 3478 |
| Editing a bind-mounted Caddyfile: `sed -i` → "Resource busy" | `sed -i` renames the file; bind mounts forbid that | Overwrite contents instead: `sed … Caddyfile > /tmp/cf && cat /tmp/cf > Caddyfile` |
| Auto-update never happens | Timer not installed (ran as non-root or no systemd), or Docker unreachable from the timer's environment | `systemctl status pulse-update.timer`; if absent, run `pulse-update.sh` manually or add the cron line the installer printed. Check `journalctl -u pulse-update` for pull errors |
| New version not picked up though timer runs | Image tag unchanged or pull failing (rate limit / auth) | `journalctl -u pulse-update --no-pager`; run the script by hand to see the pull error |
| Update ran but the container went back to the old version | The new container failed to stay running (crash within ~15 s) — the updater rolled back automatically, this is by design, not a bug | `journalctl -u pulse-update` shows "new container failed to start — rolling back"; check `docker logs pulse` after the *next* attempt for the actual crash reason |
| Container halts after repeated crashes | Built-in restart gate: 5 or more crashes within 60 s stops the container to break corruption loops | `docker logs pulse` to find the failing s6 service; fix cause; `docker start pulse` |
| Everyone logged out after volume loss/recreate | `/data/jwt_keys/` regenerated → all sessions invalid | Expected. Restore the volume from backup if unintended |
| Operator's own account is not admin on the instance | `PULSE_INSTANCE_OWNER_ID` mismatch (the cert-login of the owner's Cloud account grants admin) | Verify the env file matches the values from the bootstrap response; reinstall with a fresh token if unsure |

### Diagnostic cheat sheet

```bash
curl -fsS https://<host>/health/setup                                 # how far did first boot get (phases + cert)
docker exec pulse pulse-doctor                                        # full internal + outbound + inbound diagnosis, no secrets printed
docker logs --tail 200 pulse        # all s6 services log here, prefixed
docker exec pulse s6-rc -a list     # which internal services are up
docker inspect pulse --format '{{json .NetworkSettings.Networks}}'   # network attachment
ss -ltnp | grep -E ':(80|443|8080)' # who owns the HTTP ports
curl -v https://<host>/.well-known/pulse-server-info                  # end-to-end route test
docker exec pulse curl -fsS http://127.0.0.1:8080/health              # bypass the external proxy (behind-proxy modes; greenfield: use https://<host>/… directly)
```

The last two commands bracket the problem: if the in-container check is green
but the external one fails, the issue is DNS/proxy/firewall — not Pulse.
`pulse-doctor` already does this bracketing for you, with an explanation of
which direction failed.

## 7. Updates, reinstall, removal

- **Updates:** automatic via the host systemd timer `pulse-update.timer`
  (≤5 min after a new image is published). Manual: run `pulse-update.sh` (in
  the config dir) — it pulls and, if the digest changed, renames the current
  container to `<name>-old`, stops it, and starts the new one. It then waits
  (75 tries × 0.2 s ≈ 15 s by default) to confirm the new container is
  actually *running*, not just created, before declaring success; if it
  isn't, it rolls back automatically — removes the failed container, restarts
  the renamed old one. The `<name>-old` backup (and its image) is only
  cleaned up on the *next* update run, once it has confirmed the current
  container survived a full 5-minute timer interval — so seeing a stopped
  `<name>-old` container briefly after an update is expected, not a leak.
  Tunable via `PULSE_UPDATE_STABIL_VERSUCHE`/`PULSE_UPDATE_STABIL_INTERVALL`
  in the environment that *runs* `pulse-update.sh` (the systemd unit's
  `Environment=` line, or the crontab entry) — not via the installer's own
  environment overrides (§2); the defaults are fine for normal operation.
  Or simply re-run the installer with a fresh token — config and data are
  preserved; the volume is never deleted.
- **Reinstall/secret rotation:** re-running the installer with a new token is
  always safe; it rotates the pairing secret and rewrites `pulse.env`.
- **Removal:** `docker rm -f pulse` (substitute `PULSE_CONTAINER` if you set
  one), then `systemctl disable --now pulse-update.timer` and remove
  `/etc/systemd/system/pulse-update.{service,timer}` (`systemctl daemon-reload`).
  Optionally `docker volume rm pulse-data` (destroys all data — substitute
  `PULSE_VOLUME` if you set one) and delete the config dir (which also holds
  `pulse-update.sh`).
