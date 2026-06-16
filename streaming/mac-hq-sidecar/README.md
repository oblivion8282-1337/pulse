# Pulse macOS HQ-streaming sidecar

Rust sidecar that drives **ScreenCaptureKit** (capture) + **VideoToolbox** (encode,
via FFmpeg) + **RTMPS** push to MediaMTX, speaking the exact same
newline-delimited stdio JSON-RPC protocol as the Linux (`streaming/gsr-sidecar/`)
and Windows (`streaming/win-hq-sidecar/`) sidecars. Because the protocol is
identical, `desktop/electron/sidecar.ts` only needs a platform branch on which
binary to spawn (already added — `resolveMacBinaryPath()`).

> **Status (2026-06-15): video+audio pipeline working, locally verified.** The
> full pipeline runs: ScreenCaptureKit capture (display, BGRA + system audio) →
> VideoToolbox `h264_videotoolbox` + libopus → FLV mux → RTMPS push. `start`/
> `stop`/`state` drive it via the StreamController with `state`/`fps`/`stopped`
> events; `health`/`gpu_info`/`list_profiles`/`list_monitors` answer (real
> display enumeration). Verified at runtime: capture smoke = 60 frames/2s @30fps;
> stdio `start→live→fps→stop` produces a valid **h264 + opus** file (ffprobe).
> Built with Rust 1.96 against Homebrew FFmpeg 8.0.
>
> **Still open:** live RTMPS verification against MediaMTX (needs a real
> stream-token), A/V-sync tuning, AV1/HEVC profile gating (Metal-family probe),
> and **distribution bundling** (LGPL-FFmpeg dylibs + rpath fixups; Homebrew's
> FFmpeg is GPL). Real capture needs Screen-Recording TCC permission. Full plan:
> `docs/plans/2026-06-15-macos-client.md`.

## Build

```fish
# One-time: Rust toolchain (edition 2024 → needs Rust ≥ 1.85).
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

cd streaming/mac-hq-sidecar
cargo build --release        # → target/release/pulse-mac-hq-sidecar
```

The Electron resolver (`desktop/electron/sidecar.ts::resolveMacBinaryPath()`)
finds the binary via, in order: `$PULSE_HQ_SIDECAR` (dev override) →
`<resourcesPath>/hq-sidecar/` (packaged) → walk-up to `target/{release,debug}/`
→ `~/Library/Application Support/Pulse/hq-sidecar/`.

### FFmpeg (NOT Homebrew's)

The crate links a **custom FFmpeg 8.0.1** built by `scripts/build-ffmpeg.sh`,
not Homebrew's. Homebrew's links Apple **SecureTransport**, which blocks on
RTMPS bulk writes after the TLS handshake → MediaMTX drops the publish on a 10s
i/o timeout (the original "macOS HQ stream never starts" bug). Our build uses
`--enable-openssl --disable-securetransport`. It is also **LGPL** (no x264/x265;
VideoToolbox covers H.264/HEVC), so the same build is what we redistribute with
bundled dylibs. `.cargo/config.toml` points `PKG_CONFIG_PATH` at the build's
`lib/pkgconfig` (default `~/src/ffmpeg-openssl`). Run `scripts/build-ffmpeg.sh`
once before `cargo build`.

### First-publish reliability (constant frame rate)

The worker loop ([`stream_controller.rs`]) emits a frame every `1/fps`
**regardless** of ScreenCaptureKit's delivery — the latest captured frame, a
duplicate when the screen is static (SCK throttles on no-change), or a black
pre-roll before the first frame on a cold start. Raw passthrough lets the
stream's media-time crawl behind the wall clock, and MediaMTX then waits out its
~10s readTimeout before registering the publish (intermittent "i/o timeout").
Steady realtime output makes it register in ~2s and keeps video in sync with the
always-realtime audio. The mux thread also `avio_flush`es after every packet.

### Codec capability (`caps.rs`)

`list_profiles` / `health` advertise only codecs this machine can actually
hardware-encode. h264/hevc are the Apple-Silicon baseline; **av1** appears only
when the linked FFmpeg ships an `av1_videotoolbox` encoder *and* a trial session
opens on the silicon (M3+). FFmpeg 8.0.1 has none, so AV1 is hidden today — by
capability, not by hardcoding. The renderer gates the codec choice the same way
(`gpuHasAv1(gpu_info.video_codecs)`), matching how Linux (GSR) and Windows report
their GPU's codec set.

## Protocol (parity with the other two sidecars)

One JSON object per stdin line = a request; one per stdout line = a response
(mirrors the request `id`) or an async event (`{"ev": ...}`, no `id`). Full
contract: `streaming/README.md`.

| Op                       | Day-1 status | Real-impl unlocks                                  |
|--------------------------|--------------|----------------------------------------------------|
| `health`                 | real         | hardware codec probe (`caps.rs`)                   |
| `gpu_info`               | stub         | Metal device query (`MTLCreateSystemDefaultDevice`)|
| `list_profiles`          | real         | ported from `profiles.py` (identical strings)      |
| `list_monitors`          | stub (`[]`)  | `SCShareableContent.displays` (or CoreGraphics)    |
| `list_application_audio` | stub (`[]`)  | `SCShareableContent.applications`                  |
| `build_argv`             | real         | diagnostic argv (token-redacted)                   |
| `start`                  | stub (error) | capture + encode + RTMPS (below)                   |
| `stop`                   | idempotent   | signal the StreamController                         |
| `state`                  | idle         | StreamController snapshot                           |

**Platform difference vs Windows:** the mac sidecar does **not** exit after a
successful `stop`. The Windows sidecar self-exits (a driver threadpool-timer AV)
and `sidecar.ts` respawns it (win32-only). On macOS the process stays warm —
`sidecar.ts` keeps the child alive across streams — so `dispatch` never sets an
`exit_after` flag. If VideoToolbox/ScreenCaptureKit turn out to misbehave on a
second in-process capture session, add `'darwin'` to the respawn gate in
`sidecar.ts` (line ~305) instead of self-exiting here.

## Planned pipeline (capture → encode → mux → push)

```
ScreenCaptureKit (SCStream, async SCStreamOutput callbacks)
  ├─ video: CMSampleBuffer → CVPixelBuffer (BGRA/NV12, IOSurface-backed)
  └─ audio: system audio direct from SCK (SCStreamConfiguration.capturesAudio,
            macOS 13+)  +  optional microphone via AVCaptureSession → mixed
        │
        ▼
VideoToolbox VTCompressionSession  (h264_videotoolbox / hevc_videotoolbox;
   AV1 only on Apple-Silicon M3+) — CVPixelBuffer in (IOSurface zero-copy),
   CMSampleBuffer out.  Reached through FFmpeg's videotoolbox encoder.
        │
   audio: libopus (FFmpeg) — 20 ms frames, A/V-offset trim (CMTime anchor)
        │
        ▼
MuxWriter thread (FFmpeg FLV, interleaved A/V) — ports ~verbatim from
   streaming/win-hq-sidecar/src/encode/mux_writer.rs
        │
        ▼
RTMPS → rtmps://<host>:1936/channel-<cid>-<uid>-<nonce>?…token…
   (FFmpeg native TLS, tls_verify=0 for the self-signed MediaMTX cert —
    ports verbatim from the Windows push path)
```

### Module map (to add, mirroring `win-hq-sidecar/src/`)

- `capture/sck.rs` — `SCStream` setup from an `SCContentFilter`
  (display/window/region), `SCStreamOutput` delegate pushing `CMSampleBuffer`s
  onto an `mpsc` channel. Analogue of `capture/wgc.rs`.
- `capture/source.rs` — parse the `capture` request string
  (`"display:<id>"` / `"window:<id>"` / `"region"` / `"portal"`) into an
  `SCContentFilter`.
- `encode/videotoolbox.rs` — `VTCompressionSession` (or the FFmpeg
  `*_videotoolbox` encoder) fed `CVPixelBuffer`s. Analogue of `encode/encoder.rs`.
- `encode/audio.rs`, `encode/mux_writer.rs` — port verbatim from Windows.
- `stream_controller.rs` — the singleton worker + `StreamSnapshot`; emits the
  `state`/`fps`/`log`/`error`/`stopped` events. Port from Windows.
- `system/metal.rs` — Metal device name/family for `gpu_info` + AV1 capability.

## macOS gotchas (see the plan doc for the full list)

- **TCC / Screen-Recording permission** — `SCStream` returns *black frames*, not
  an error, without permission. Preflight with `CGPreflightScreenCaptureAccess()`
  and emit an `error` event the renderer can turn into a "grant Screen Recording
  in System Settings" hint. The usage strings live in the app's Info.plist
  (`NSScreenCaptureUsageDescription`, set via `electron-builder.yml` →
  `mac.extendInfo`).
- **Signing** — unsigned dev builds lose the TCC grant on every rebuild, and
  electron-updater can't self-update on macOS without a valid signature (Stufe A
  vs Stufe B in the plan doc).
- **FFmpeg** — no BtbN macOS build exists; produce/obtain an LGPL-shared FFmpeg
  for macOS arm64, bundle the dylibs next to the binary (analogue of
  `win-hq-sidecar/build.rs` copying the DLLs), and add them to
  `mac.extraResources` in `electron-builder.yml`.
- **AV1 encode** — Apple-Silicon M3+ only; `list_profiles` already carries
  `needs_custom_build`, gate the AV1 profile on the Metal family probe.

## Testing without a real stream

Same trick as the other sidecars — pipe a request and read the response, but
never send `{"op":"start"}` (that opens the capture + pushes for real):

```fish
printf '{"op":"health","id":1}\n{"op":"list_profiles","id":2}\n' \
  | ./target/release/pulse-mac-hq-sidecar
```
