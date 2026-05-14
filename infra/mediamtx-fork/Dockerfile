# Pulse-forked MediaMTX image.
#
# Pulls the upstream v1.17.1 source, applies the patches/ in alphabetical
# order, and statically builds a stripped binary. The result is published
# as ghcr.io/oblivion8282-1337/pulse-mediamtx:<tag> and used in place of
# `bluenviron/mediamtx:1.17.1` in both the dev (streaming/server/) and
# prod (infra/prod/) compose files.
#
# Why we maintain this fork: AMD-VAAPI-encoded AV1 streams freeze in WHEP
# after a few seconds because the AV1 bitstream lacks OBU_TEMPORAL_DELIMITER
# OBUs (spec-permitted, but libwebrtc relies on them for frame boundaries).
# The 0001-rtmp-inject-temporal-delimiter.patch injects one in the
# RTMP→stream path. See the patch header for the full rationale and the
# conditions for removing this fork.
#
# Bumping MediaMTX: change `MEDIAMTX_VERSION` below + `patch -p1 --dry-run`
# every patch against the new tag first.

ARG MEDIAMTX_VERSION=1.17.1
ARG GO_VERSION=1.25

# ── Stage 1: build the patched binary ──────────────────────────────────────
FROM golang:${GO_VERSION}-alpine AS build
ARG MEDIAMTX_VERSION

WORKDIR /src
RUN apk add --no-cache git patch

# Shallow clone the exact upstream tag. `--depth=1` keeps the build
# context small; we don't need history because the patches are line-
# anchored against this single revision.
RUN git clone --depth=1 -b v${MEDIAMTX_VERSION} \
      https://github.com/bluenviron/mediamtx.git .

# Apply every patch under patches/ in alphabetical order. Fail loudly if
# any of them doesn't apply cleanly — we'd rather the build break here
# than ship an unpatched image to prod.
COPY patches/*.patch /tmp/pulse-patches/
RUN set -e; \
    for p in /tmp/pulse-patches/*.patch; do \
      echo "→ applying $(basename "$p")"; \
      patch -p1 < "$p"; \
    done

# Two generators have to run before `go build`:
#   * internal/servers/hls/hlsjsdownloader  — fetches hls.min.js (embedded into the binary)
#   * internal/core/versiongetter           — writes internal/core/VERSION (embedded too)
# Both are referenced via `//go:embed` directives, so a missing file is
# a hard compile error. The third generator (rpicamera/mtxrpicamdownloader)
# pulls ARM-only binaries we don't need — skip it explicitly by listing
# the two we want instead of running `go generate ./...`.
RUN go generate ./internal/servers/hls/... \
                ./internal/core/...

# Standard MediaMTX build settings — matches what their `binaries.mk`
# uses for the official linux/amd64 binary, minus the cross-compile bits.
RUN CGO_ENABLED=0 \
    go build \
      -tags=osusergo,netgo \
      -ldflags="-s -w" \
      -trimpath \
      -o /out/mediamtx \
      .

# ── Stage 2: minimal runtime ──────────────────────────────────────────────
# Match upstream's `docker/standard.Dockerfile` shape — `FROM scratch`
# with just the binary and the CA bundle so that `authHTTPAddress=https://…`
# works without surprises.
FROM scratch

COPY --from=build /out/mediamtx /mediamtx
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

ENTRYPOINT ["/mediamtx"]
