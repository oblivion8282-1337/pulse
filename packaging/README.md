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

## Distribution (later)
Build into an OSTree repo instead of `--install`:
```fish
flatpak-builder --repo=build/repo --force-clean build/flatpak packaging/com.unicutmedia.Pulse.yml
```
Host `build/repo/` over HTTPS (e.g. `flatpak.unicutmedia.com` behind the existing Caddy on the Hetzner VPS), hand out a `.flatpakref`. Then `flatpak update` (manual or the desktop's background updater) picks up new builds. Can be wired into CI (build → `build-export` → `rsync` to the VPS) like the Docker images.

## Files
- `com.unicutmedia.Pulse.yml` — the manifest
- `launcher.sh` — `/app/bin/pulse`: sets `GSR_BINARY`/`PULSE_SIDECAR_PY`, passes `--ozone-platform-hint=auto` (override: `PULSE_OZONE=x11`/`wayland`), then `exec zypak-wrapper /app/electron/electron /app/pulse/main.cjs`
- `com.unicutmedia.Pulse.desktop` / `.metainfo.xml` / `.svg` — desktop integration (the `.svg` is `web/static/pulse-mark.svg`)
- `build.fish` — the local build helper
