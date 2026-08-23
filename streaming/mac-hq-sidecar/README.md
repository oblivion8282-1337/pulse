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
> events; `health`/`gpu_info`/`list_monitors` answer (real
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

`health` advertises only the codecs this machine can actually
hardware-encode. h264/hevc are the Apple-Silicon baseline; **av1** appears only
when the linked FFmpeg ships an `av1_videotoolbox` encoder *and* a trial session
opens on the silicon (M3+). FFmpeg 8.0.1 has none, so AV1 is hidden today — by
capability, not by hardcoding. The renderer gates the codec choice the same way
(`gpuHasAv1(gpu_info.video_codecs)`), matching how Linux (GSR) and Windows report
their GPU's codec set.

### Own WHIP sender + back channel (since 2026-08-20)

Like Linux and Windows, this sidecar has its own WebRTC send path
(`src/whip/`) for `http(s)://` targets instead of ffmpeg's WHIP muxer — the
muxer carries neither an inbound PLI/FIR nor AV1. With the own sender comes a
real RTCP back channel: a joining viewer's keyframe request reaches the
encoder (`crate::keyframe`, `pict_type = I`). Measured on 2026-08-20 with two
Pulse instances: sender at `PULSE_KEYFRAME_SECONDS=30`, a viewer joins late,
the sidecar logs `[whip] Vollbild angefordert (insgesamt 1)`, and the picture
arrives immediately instead of after up to 30 s.

That proof is what retired the earlier special case:

- **Keyframe distance now defaults to 60 s here too** (`encode::wahl::
  KEYFRAME_SEKUNDEN_VORGABE`), matching Linux/Windows — no longer the 2 s this
  sidecar used while it had no back channel. `PULSE_KEYFRAME_SECONDS` still
  overrides, with a warning if a target *without* a back channel (RTMPS) ends
  up with a long distance.
- **AV1 is offered by the UI again where the hardware supports it**
  (`web/src/lib/stream/settings.svelte.ts::av1Nutzbar`, plain `gpuHasAv1`
  now). On today's Mac hardware that stays `false` regardless: FFmpeg 8.0.1
  has no `av1_videotoolbox` encoder, and no Apple chip encodes AV1 (M3+ only
  decodes it) — s. `caps.rs`. The muxer reason is gone; the hardware reason
  isn't.

`videotoolbox_encoder`'s h264 fallback (`encode/wahl.rs`) is unrelated and
stays: it's a hardware-capability guard, not a WHIP workaround, and
`ops::start::resolve_codec` already resolves the codec against `caps::
supports_codec` before the encoder ever opens.

## Protocol (parity with the other two sidecars)

One JSON object per stdin line = a request; one per stdout line = a response
(mirrors the request `id`) or an async event (`{"ev": ...}`, no `id`). Full
contract: `streaming/README.md`.

**This table went stale and was corrected on 2026-08-23** — it still described
day one, listing `start` as a stub while it is 269 lines of working code, and
omitting `list_windows` entirely. The twin table in `src/ops/mod.rs` says the
same; **change both or neither.** A status table nobody can trust is worse than
none.

| Op                       | Status | Backed by                                        |
|--------------------------|--------|--------------------------------------------------|
| `health`                 | real   | codec probe (`caps.rs`) + TCC grants (`berechtigung.rs`) |
| `gpu_info`               | stub   | awaiting `MTLCreateSystemDefaultDevice`          |
| `list_monitors`          | real   | `capture::list_displays`                         |
| `list_windows`           | real   | `capture::list_capture_windows`                  |
| `list_application_audio` | real   | `capture::list_audio_applications`               |
| `build_argv`             | real   | diagnostic argv (token-redacted)                 |
| `start`                  | real   | ScreenCaptureKit + VideoToolbox + WHIP/RTMPS     |
| `stop`                   | real   | `StreamController`, idempotent                   |
| `state`                  | real   | `StreamController` snapshot                      |
| `keyframe`               | real   | keyframe on request                              |
| `remote_input`           | real   | remote control: feed input frames                |
| `remote_input_end`       | real   | remote control: close the session                |

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
- **AV1 encode** — Apple-Silicon M3+ only; gate the offered AV1 codec on the
  Metal family probe (`caps.rs`).

## Testing without a real stream

Same trick as the other sidecars — pipe a request and read the response, but
never send `{"op":"start"}` (that opens the capture + pushes for real):

```fish
printf '{"op":"health","id":1}\n{"op":"gpu_info","id":2}\n' \
  | ./target/release/pulse-mac-hq-sidecar
```
