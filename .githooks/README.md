# Git hooks (`.githooks/`)

Checked-in hooks. Enable them once per clone:

```fish
git config core.hooksPath .githooks
```

(This repo already has it set. If `git config --get core.hooksPath` ever points
somewhere stale, re-run the line above.)

## Hooks

- **`pre-push`** — when a push includes changes to anything bundled into the Pulse
  Flatpak (`desktop/electron/`, `desktop/package.json`, `streaming/gsr-sidecar/`,
  `streaming/patches/`, `packaging/com.unicutmedia.Pulse.yml`, `packaging/launcher.sh`,
  the `.desktop`/`.metainfo.xml`/`.svg`), it runs `packaging/publish.fish` →
  rebuilds the signed OSTree repo and rsyncs it to the VPS, so installed clients
  pick it up via `flatpak update`. Web/backend/docs-only pushes are skipped
  instantly (the packaged app loads `pulse.unicutmedia.com` remotely). Non-blocking:
  a republish failure warns but doesn't abort the push. Skip for one push:
  `git push --no-verify`. Needs the signing key at `packaging/.gpg/` and `fish`;
  without either it skips with a warning.
