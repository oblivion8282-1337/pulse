# Packaging — Pulse Flatpak (T6)

`com.unicutmedia.Pulse` — a Flatpak of the Electron desktop app.

## What's in it
- Electron 42 (bundled binary), launched via `zypak-wrapper` (sandbox shim from `org.electronjs.Electron2.BaseApp`).
- `electron/dist/{main,preload}.cjs` (esbuild bundle) → `/app/pulse/`.
- The pure-stdlib Python GSR sidecar (`streaming/gsr-sidecar/*.py`) → `/app/share/pulse/gsr-sidecar/` (matches `sidecar.ts`'s Flatpak default path).
- A custom `gpu-screen-recorder` (`/app/bin/gpu-screen-recorder`): FFmpeg-with-NVENC + GSR-from-source + the `streaming/patches/` (FLV-Opus whitelist, Vulkan-encoder stub). The FFmpeg/GSR module stack is lifted verbatim from the proven gsr-streamer manifest.

**Not** in it: the web frontend. The packaged app loads `https://pulse.unicutmedia.com` remotely (`electron/main.ts` → `PROD_URL`, no `PULSE_DEV_URL`). So web fixes are live without a new Flatpak; only native changes (Electron main/preload, the sidecar, the GSR binary) need a rebuild.

## Build & install locally
```fish
packaging/build.fish        # build:electron, then flatpak-builder --user --install
flatpak run com.unicutmedia.Pulse
```
First run pulls runtimes (`org.freedesktop.{Platform,Sdk}//24.08`, `org.electronjs.Electron2.BaseApp//24.08`) and builds FFmpeg + GSR from source — ~15-30 min.

## Distribution — self-updating Flatpak repo

The packaged app is published to a signed OSTree repo served at
`https://pulse.unicutmedia.com/flatpak/` (on the Hetzner VPS, behind the existing
Caddy → `pulse_web` nginx). A friend installs once from there and gets new builds
via `flatpak update` (GNOME Software / KDE Discover also auto-update Flatpaks in the
background). Remember: **web-only changes need no new Flatpak** — the app loads
`pulse.unicutmedia.com` remotely; only native changes (electron `main`/`preload`,
the Python sidecar, the GSR binary) need a rebuild + republish.

### One-time setup
1. **Signing key** (so the friend doesn't need `--no-gpg-verify`):
   ```fish
   packaging/gen-signing-key.fish      # creates packaging/.gpg/ (gitignored)
   ```
   ⚠ Back up `packaging/.gpg/`. If you lose it, the friend's app rejects future updates.
2. **VPS — serve the repo dir.** `infra/prod/docker-compose.yml` already bind-mounts
   `/home/michael/pulse/flatpak-repo` into `pulse_web` at `/srv/flatpak-repo`, and
   `infra/prod/web-nginx.conf` serves it under `/flatpak/`. So after pushing the
   updated `infra/`:
   ```fish
   ssh michael@77.42.71.166 'mkdir -p ~/pulse/flatpak-repo'
   # rsync infra/ → ~/pulse/infra/  (if you haven't already), then on the VPS:
   #   cd ~/pulse/infra/prod && docker compose up -d
   ```

### Each release
```fish
packaging/publish.fish
```
→ `flatpak-builder --repo=build/repo` (FFmpeg/GSR come from the `.flatpak-builder`
cache — fast after the first time) → `flatpak build-update-repo --generate-static-deltas
--prune` (small incremental updates) → regenerates `com.unicutmedia.Pulse.flatpakref`
→ `rsync build/repo/ → VPS:~/pulse/flatpak-repo/`.

**Automatic on push:** the `.githooks/pre-push` hook runs `publish.fish` for you
whenever a push touches anything bundled into the Flatpak (`desktop/electron/`,
`desktop/package.json`, `streaming/gsr-sidecar/`, `streaming/patches/`, the
`packaging/` manifest/launcher/desktop files). Web/backend/docs-only pushes skip
it. Needs the signing key + `fish`; non-blocking (a failure warns, push proceeds);
`git push --no-verify` skips it. Enable once per clone: `git config core.hooksPath .githooks`.

### The friend
```fish
flatpak install --user https://pulse.unicutmedia.com/flatpak/com.unicutmedia.Pulse.flatpakref
flatpak run com.unicutmedia.Pulse
# later:
flatpak update                       # or GNOME Software / KDE Discover, automatically
```
(`RuntimeRepo=…flathub…` in the `.flatpakref` makes Flatpak auto-add Flathub if
needed, to pull the freedesktop runtime + the Electron BaseApp.)

### Later: CI
The build → `--repo` → `build-update-repo` → `rsync` flow can move into a GitHub
Action (like the Docker images) — the slow part is FFmpeg+GSR-from-source (~15-30 min,
but cacheable). Not needed to start.

## Files
- `com.unicutmedia.Pulse.yml` — the manifest
- `launcher.sh` — `/app/bin/pulse`: sets `GSR_BINARY`/`PULSE_SIDECAR_PY`, passes `--ozone-platform-hint=auto` (override: `PULSE_OZONE=x11`/`wayland`), then `exec zypak-wrapper /app/electron/electron /app/pulse/main.cjs`
- `com.unicutmedia.Pulse.desktop` / `.metainfo.xml` / `.svg` — desktop integration (the `.svg` is `web/static/pulse-mark.svg`)
- `build.fish` — local build + `--user --install` (dev box)
- `gen-signing-key.fish` — one-time: create the repo signing key in `packaging/.gpg/`
- `publish.fish` — build into the signed OSTree repo + push it to the VPS (release flow)
