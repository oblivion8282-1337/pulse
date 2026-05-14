# Pulse fork of MediaMTX

A minimal patched MediaMTX image that works around a Chromium-side WebRTC-AV1
receive bug for AMD-VAAPI publishers. Built as a multi-stage Dockerfile,
published to `ghcr.io/oblivion8282-1337/pulse-mediamtx:<tag>`, consumed by
both `streaming/server/docker-compose.yml` (dev) and `infra/prod/docker-compose.yml`
(prod).

## What it does

`patches/0001-rtmp-inject-temporal-delimiter.patch` adds three lines to
`internal/protocols/rtmp/to_stream.go` that prepend an `OBU_TEMPORAL_DELIMITER`
to every AV1 temporal unit coming in over RTMP, if one isn't already present.
The patch header explains the AV1-spec context and why this is necessary —
short version: AMD VAAPI doesn't emit them, NVENC does, and libwebrtc's
RTP-AV1 receiver relies on them to find frame boundaries.

## How it gets built and shipped

`.github/workflows/mediamtx-fork.yml` rebuilds the image when anything under
`infra/mediamtx-fork/` changes on `main`. It pushes two tags to GHCR:

- `ghcr.io/oblivion8282-1337/pulse-mediamtx:1.17.1-pulse`  — version pin
- `ghcr.io/oblivion8282-1337/pulse-mediamtx:latest`        — rolling

Both compose files reference the version-pinned tag. The labels include
`com.centurylinklabs.watchtower.enable=false` so Watchtower never silently
swaps it out — every bump is a deliberate compose edit.

## When to remove this fork

Drop the patch + revert the compose files to upstream `bluenviron/mediamtx:<v>`
as soon as **one** of these is true:

1. MediaMTX upstream applies the same workaround (the patch is 3 lines, the
   bug is well-localized — when filed upstream it should land quickly).
2. AMD's Mesa VAAPI AV1 encoder starts emitting Temporal Delimiter OBUs by
   default.
3. Chromium's libwebrtc RTP-AV1 receiver stops relying on them for frame-
   boundary detection.

Verify the cause of the original symptom is gone by running the
"Diagnose-Aufnahme senden" workflow from an AMD-GPU machine, then watching
the WHEP receiver's RTCInboundRtpStreamStats — if `framesDecoded` keeps
pace with `framesReceived`, the fork is no longer needed.

## Bumping MediaMTX

```sh
cd infra/mediamtx-fork
# Edit Dockerfile: MEDIAMTX_VERSION=<new>
# Verify the patch still applies cleanly against the new tag:
git clone --depth=1 -b v<new> https://github.com/bluenviron/mediamtx.git /tmp/mediamtx-check
( cd /tmp/mediamtx-check && patch -p1 --dry-run < ../patches/0001-*.patch )
# If it fails to apply, rebase the patch against the new line numbers.
```

Then commit; the workflow rebuilds and pushes the new image, and you update
the `image:` tag in both compose files to match.
