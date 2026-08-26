# Packaging — Pulse Flatpak (T6)

`com.howispulse.Pulse` — a Flatpak of the Electron desktop app.

## What's in it
- Electron 43 (bundled binary), launched via `zypak-wrapper` (sandbox shim from `org.electronjs.Electron2.BaseApp`).
- `electron/dist/{main,preload}.cjs` (esbuild bundle) → `/app/pulse/`.
- The Rust Linux HQ sidecar (`streaming/linux-hq-sidecar/`, capture+encode+push) and the native HQ player
  (`streaming/pulse-player/`, playback) — both `type: dir` sources, both linked against the same bundled `ffmpeg`
  module.

**Until 2026-08-27** there were two more building blocks here: a vendored Python sidecar and a self-built
`gpu-screen-recorder` — the older Linux capture path. The Rust sidecar replaced it as the default on 2026-07-17 and
it stopped being reachable at all on 2026-08-16; both it and the `gpu-screen-recorder` module are now gone. The
**`ffmpeg` module stays** — it was pulled in for that older path, but the Rust sidecar and the player link against
it now. Its decoder/codec-list build args must not be trimmed on the assumption they served only the old path —
without them the player never shows a picture (reasoning lives on the module itself in the manifest).

**Not** in it: the web frontend. The packaged app loads `https://howispulse.com` remotely (`electron/main.ts` → `PROD_URL`, no `PULSE_DEV_URL`). So web fixes are live without a new Flatpak; only native changes (Electron main/preload, the sidecar, the player) need a rebuild.

## Build & install locally
```fish
packaging/build.fish        # build:electron, then flatpak-builder --user --install
flatpak run com.howispulse.Pulse
```

> **`build.fish` REPLACES the installed app.** It ends in `--user --install`, so it
> overwrites whatever is installed and repoints the installation's origin at
> `.flatpak-builder/cache` — a local directory. From then on `flatpak update`
> pulls from that cache instead of the published repo, which looks exactly like a
> real update but isn't. Happened on 2026-07-29: a verification build silently
> replaced the working install, the next `flatpak update` picked up the
> intermediate state, and the app came up with a white screen.
>
> **To only verify that the manifest builds, do not install:**
> ```fish
> pnpm --filter @dcc/desktop build:electron
> flatpak-builder --force-clean --repo=/tmp/pulse-verify-repo \
>     build/flatpak packaging/com.howispulse.Pulse.yml
> ```
> Inspect the result under `build/flatpak/files/` — the sidecar binary lands in
> `bin/`, the Electron bundle in `pulse/`. Throw the repo away afterwards.
>
> Getting a botched install back on the published channel:
> ```fish
> flatpak uninstall --user com.howispulse.Pulse    # WITHOUT --delete-data
> flatpak install --user https://howispulse.com/flatpak/com.howispulse.Pulse.flatpakref
> ```
> App data under `~/.var/app/com.howispulse.Pulse/` survives that (it holds
> `pulse-stream.json` with the streaming settings). Check afterwards where the
> remote POINTS, not what it is called: `flatpak remotes --columns=name,url` must
> show `https://howispulse.com/flatpak/` for the Pulse remote. **The name proves
> nothing** — Flatpak appends a digit when the preferred name is already taken, so
> an install straight off the published channel legitimately shows up as
> `pulse1-origin`. A local `build.fish` install is recognisable by its
> `file:///…/.flatpak-builder/cache` URL.
First run pulls runtimes (`org.freedesktop.{Platform,Sdk}//24.08`, `org.electronjs.Electron2.BaseApp//24.08`) and
builds FFmpeg from source. That used to also build GSR from source; that build step is gone since 2026-08-27, so
the first run is now shorter than the ~15-30 min this used to say — not re-measured since, so no new number here.

## Distribution — self-updating Flatpak repo

The packaged app is published to a signed OSTree repo served at
`https://howispulse.com/flatpak/` (on the netcup VPS that serves the cloud —
since the move on 2026-05-28; behind the existing Caddy → `pulse_web` nginx). A
friend installs once from there and gets new builds via `flatpak update` (GNOME
Software / KDE Discover also auto-update Flatpaks in the background).

Remember: **web-only changes need no new Flatpak** — the app loads
`howispulse.com` remotely. Only what is actually bundled needs a rebuild +
republish, and the authoritative list is the `paths:` filter in
`.github/workflows/flatpak.yml` — do not reproduce it from memory, read it:

- `desktop/electron/**`, `desktop/package.json` — the Electron bundle
- `streaming/linux-hq-sidecar/**` — the **Rust** sidecar, the only Linux
  capture path since 2026-08-27 (default since 2026-07-17)
- `streaming/pulse-player/**` — the player
- `packaging/*-cargo-sources.json` — the offline Cargo manifests for both Rust
  crates; a `Cargo.lock` change means regenerating these, or the Flatpak build
  fails offline
- the manifest and its assets (`com.howispulse.Pulse.yml`, `launcher.sh`,
  `.desktop`, `.metainfo.xml`, `.svg`)

Until 2026-08-21 this list also had `streaming/ffmpeg-patches/**` — Pulse patches
applied to the bundled FFmpeg to expose rolling intra refresh. That encoder mode
was dropped, and with it the patch directory: the manifest now builds unmodified
upstream FFmpeg (`com.howispulse.Pulse.yml`, the `ffmpeg` module).

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
   ssh michael@159.195.150.54 'mkdir -p ~/pulse/flatpak-repo'
   # rsync infra/ → ~/pulse/infra/  (if you haven't already), then on the VPS:
   #   cd ~/pulse/infra/prod && docker compose up -d
   ```

### Each release
```fish
packaging/publish.fish
```
→ `flatpak-builder --repo=build/repo` (FFmpeg comes from the `.flatpak-builder`
cache — fast after the first time) → `flatpak build-update-repo --generate-static-deltas
--prune` (small incremental updates) → regenerates `com.howispulse.Pulse.flatpakref`
→ `rsync build/repo/ → VPS:~/pulse/flatpak-repo/`.

**Automatic on push:** the `.githooks/pre-push` hook runs `publish.fish` for you
whenever a push touches anything bundled into the Flatpak (`desktop/electron/`,
`desktop/package.json`, `streaming/linux-hq-sidecar/`, `streaming/pulse-player/`, the
`packaging/` manifest/launcher/desktop files). Web/backend/docs-only pushes skip
it. Needs the signing key + `fish`; non-blocking (a failure warns, push proceeds);
`git push --no-verify` skips it. Enable once per clone: `git config core.hooksPath .githooks`.

### The friend
```fish
flatpak install --user https://howispulse.com/flatpak/com.howispulse.Pulse.flatpakref
flatpak run com.howispulse.Pulse
# later:
flatpak update                       # or GNOME Software / KDE Discover, automatically
```
(`RuntimeRepo=…flathub…` in the `.flatpakref` makes Flatpak auto-add Flathub if
needed, to pull the freedesktop runtime + the Electron BaseApp.)

### CI (the normal path)
`.github/workflows/flatpak.yml` runs the build → sign → `build-update-repo` → rsync
flow in the cloud whenever a push to `main` touches a path that's bundled into the
Flatpak (mirrors the legacy `.githooks/pre-push` trigger filter). First run ~30 min,
cached runs ~5 min (the workflow caches `~/.local/share/flatpak` + `.flatpak-builder/`).

**Required repo secrets** (Settings → Secrets and variables → Actions):
- `FLATPAK_GPG_PRIVATE_KEY` — the **same** passwordless key the friends already
  pinned. Export with:
  ```fish
  gpg --homedir packaging/.gpg --armor --export-secret-keys $KEYID
  ```
  (Lose it and existing installs stop updating. Don't regenerate "to be safe.")
- `VPS_SSH_PRIVATE_KEY` — a CI-only key. Generate fresh, don't reuse a personal one:
  ```fish
  ssh-keygen -t ed25519 -f /tmp/pulse-ci-deploy -N ""
  ssh-copy-id -i /tmp/pulse-ci-deploy.pub michael@159.195.150.54
  cat /tmp/pulse-ci-deploy                     # → paste into the secret
  shred -u /tmp/pulse-ci-deploy /tmp/pulse-ci-deploy.pub
  ```
- `VPS_KNOWN_HOSTS` — output of `ssh-keyscan 159.195.150.54` (pins the host key).

The legacy pre-push hook still works as an emergency fallback (CI down, hotfix
without pushing to GitHub) — opt in with `PULSE_FORCE_LOCAL_PUBLISH=1 git push …`.

## Troubleshooting

**App won't start (Exit 1, almost no output).** First check whether the Electron
tree is intact:
```fish
flatpak run --command=sh com.howispulse.Pulse -c 'ls /app/electron/resources /app/electron/locales'
```
If those are missing, it's the `strip-components` bug (see below). Otherwise it's
usually GPU/Wayland on NVIDIA → try `PULSE_OZONE=x11 flatpak run …`, or add
`--disable-gpu` / `--disable-gpu-sandbox` to the `zypak-wrapper` line in `launcher.sh`.

**The `strip-components` trap.** The Electron-42 binary is pulled from the GitHub
release as a flat tree with `locales/` + `resources/` at the top level. The
flatpak-builder default `strip-components: 1` flattens those two directories →
Electron can't find `resources/default_app.asar` → Exit 1 *before `main.cjs` even
runs*. The manifest therefore pins **`strip-components: 0`** for that source. If you
ever touch the `pulse` module's `archive` source, keep it at `0`.

## Files
- `com.howispulse.Pulse.yml` — the manifest
- `launcher.sh` — `/app/bin/pulse`: passes `--ozone-platform-hint=auto` (override: `PULSE_OZONE=x11`/`wayland`), then `exec zypak-wrapper /app/electron/electron --class=com.howispulse.Pulse /app/pulse`
- `com.howispulse.Pulse.desktop` / `.metainfo.xml` / `.svg` — desktop integration (the `.svg` is `web/static/pulse-mark.svg`)
- `build.fish` — local build + `--user --install` (dev box). **Replaces the installed app and repoints its origin at the local cache** — see the warning above; for a build-only check use `--repo=` into a throwaway directory.
- `gen-signing-key.fish` — one-time: create the repo signing key in `packaging/.gpg/`
- `publish.fish` — build into the signed OSTree repo + push it to the VPS (release flow)
