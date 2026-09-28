# Self-Host Templates

This directory holds exactly one template:

- `livekit.yaml.template` — LiveKit SFU config, rendered by
  `s6/etc/s6-overlay/scripts/05-init-livekit.sh`. Placeholders:
  `@@LIVEKIT_KEY@@` / `@@LIVEKIT_SECRET@@` (substituted at container start).

The configs this directory once promised live elsewhere or don't exist as
files:

- `Caddyfile.template` — lives at `s6/etc/caddy/Caddyfile.template`, rendered
  by `09-init-caddy.sh` (TLS modes auto / provided / behind-proxy).
- MediaMTX config — no external template; `08-init-mediamtx.sh` writes it
  inline (see "Known limitations" in `infra/self-host/README.md`).
- `pulse-health` — lives at `s6/usr/local/bin/pulse-health`
  (Docker `HEALTHCHECK` script).
