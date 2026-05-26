# Self-Host Templates

This directory is populated by **Phase 6.B**:

- `Caddyfile.template` — reverse proxy with auto-TLS
- `livekit.yaml.template` — LiveKit SFU config (`@@LIVEKIT_KEY@@`, `@@LIVEKIT_SECRET@@`, `@@PULSE_HOSTNAME@@`)
- `mediamtx.yml.template` — RTMPS + WHEP/HLS + authHTTP wiring
- `pulse-health` — Docker `HEALTHCHECK` script

Phase 6.A renders fallback configs inline in the cont-init scripts when the
template is missing — so the container boots and individual services have a
chance to surface real errors, but **production deployment requires 6.B's
templates** for full functionality (TLS, hostname-aware certs, etc.).
