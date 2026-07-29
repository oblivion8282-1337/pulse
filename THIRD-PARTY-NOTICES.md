# Third-Party Notices

Pulse's own client code is licensed under `LICENSE-CLIENT.md` (Pulse Client
License 1.0), the server code under `LICENSE-SERVER.md` (Pulse Server License
1.0) — see `LICENSE` for which parts fall under which license. Both permit use
and reading the source, but not modification, redistribution or reuse. The
HQ-screen-streaming path additionally bundles or dynamically links a small
number of third-party open-source components. This file is the developer/
distributor-facing counterpart to the user-facing page at
`web/src/lib/legal/drittanbieter.md` (served at `/drittanbieter`); both list
the same facts, this one adds repo-internal pointers for maintainers.

This is not a full Software Bill of Materials (SBOM) of every transitive Rust
crate — it covers the components that are separately bundled/dynamically
linked or that carry their own copyleft obligations distinct from Pulse's own
client license. A full `cargo license`/`pnpm licenses` sweep of every
transitive dependency has not been run as part of compiling this file.

## Windows (`streaming/win-hq-sidecar/`)

| Component | Version / pin | License | Declared in |
|---|---|---|---|
| FFmpeg (BtbN `n8.1-lgpl-shared` distribution) | Self-hosted mirror dated 2026-06-16, SHA256-pinned | LGPL (build excludes libx264/libx265) | `streaming/win-hq-sidecar/scripts/fetch-ffmpeg.ps1:9-45`, `.cargo/config.toml:9` (`FFMPEG_DIR`), `Cargo.toml:56-68` (`ffmpeg-next` binding), `.github/workflows/win-build.yml:42-58` (CI fetch step) |
| nv-codec-headers | `n13.0.19.0` (build-time only, not redistributed as a file) | MIT | Referenced alongside the Linux FFmpeg module, `packaging/com.howispulse.Pulse.yml:169-179` |

FFmpeg is BtbN's unmodified prebuilt distribution — Pulse does not patch its
source for this platform. The DLLs are copied next to
`pulse-win-hq-sidecar.exe` as separate, exchangeable files (dynamic linking,
LGPL-compliant). The exact LGPL sub-version and configure flags used by
BtbN's own build process are external to this repository and were not
independently re-verified in this pass.

## macOS (`streaming/mac-hq-sidecar/`)

| Component | Version / pin | License | Declared in |
|---|---|---|---|
| FFmpeg (self-built) | `8.0.1` (`FFMPEG_VERSION` default) | LGPL (no `--enable-gpl`/libx264/libx265) | `streaming/mac-hq-sidecar/scripts/build-ffmpeg.sh:9-42`, `Cargo.toml:46-53`, `.cargo/config.toml`, `.github/workflows/mac-build.yml:14-22,58-81` |

Built from the unmodified official `ffmpeg.org` source tarball with
`--enable-openssl --disable-securetransport --enable-videotoolbox
--enable-audiotoolbox --enable-libopus` and no GPL-triggering flags. The
resulting dylibs are bundled next to the app via `scripts/bundle-dylibs.sh`
(dynamic linking). Note: unlike the Linux Flatpak FFmpeg module, this
configure line does not pass `--enable-version3` — which LGPL minor version
(2.1-or-later vs. 3) that produces was not independently confirmed from
within this repository and is flagged here as an open question rather than
asserted.

## Linux (Flatpak, `packaging/com.howispulse.Pulse.yml`)

| Component | Version / pin | License | Declared in |
|---|---|---|---|
| Electron | `43.0.0` | MIT | `com.howispulse.Pulse.yml:267` (official release zip), bundled unmodified into `/app/electron/` |
| FFmpeg | git tag `n8.1.1`, commit `239f2c733de417201d7ad3b3b8b0d9b63285b2b1` | LGPLv3 (`--enable-version3`, no `--enable-gpl`/libx264) | `com.howispulse.Pulse.yml:101-167` |
| nv-codec-headers | git tag `n13.0.19.0`, commit `e844e5b26f46bb77479f063029595293aa8f812d` | MIT (headers only, build-time) | `com.howispulse.Pulse.yml:169-179` |
| gpu-screen-recorder | commit `0349083cfe4578dbc8bc600e31187e8e09318add` + 3 Pulse patches | GPL-3.0-or-later | `com.howispulse.Pulse.yml:187-200`, `streaming/patches/LICENSE` |
| pulse-linux-hq-sidecar (Rust) | separate repo `github.com/oblivion8282-1337/pulse-linux-hq-sidecar`, commit `1afe5f115e4f28d63ff074a0c466bc771f35661a` | Pulse's own client code (not third-party) | `com.howispulse.Pulse.yml:212-229` |

Electron's own bundled third-party notices (Chromium, Node.js, etc.) ship
inside the official Electron release archive and are not reproduced here.

FFmpeg for this target is built from an unmodified pinned upstream commit; the
`--enable-version3` flag is an explicit LGPLv3 opt-in (documented at
`com.howispulse.Pulse.yml:103-105`), and `x264`/`--enable-gpl` are deliberately
left out (`com.howispulse.Pulse.yml:147-160`, verified 2026-07-24 to produce
bit-identical `libav*` symbols with or without it) so the resulting build
stays LGPL rather than GPL.

`gpu-screen-recorder` is fetched and built at Flatpak build time, then bundled
as a **separate program** in the Linux package — it is not linked against
Pulse's own binary. The three patches Pulse applies to it
(`streaming/patches/0001-opus-flv-whitelist.patch`,
`0002-stub-vulkan-encoder.patch`, `0003-portal-cursor-embedded.patch`) modify
only `gpu-screen-recorder`'s own source and are themselves licensed
GPL-3.0-or-later as derivative works — see `streaming/patches/LICENSE`, which
is explicitly carved out from the Pulse licenses covering the rest of this
repository.

`pulse-linux-hq-sidecar` lives in its own repository and is Pulse's own
client-side code (falls under the Pulse Client License, not this notice
file); its own transitive Cargo dependency tree was not audited as part of
this pass.

## Native HQ player (`streaming/pulse-player/`)

New in this branch. Unlike the capture sidecars, this component links its Rust
dependencies statically into its own binary; they are listed here because their
permissive licenses still require attribution.

| Component | Version | License |
|---|---|---|
| [webrtc-rs](https://github.com/webrtc-rs/webrtc) | 0.17.2 | MIT OR Apache-2.0 |
| [wgpu](https://github.com/gfx-rs/wgpu) | 29.0.4 | MIT OR Apache-2.0 |
| [winit](https://github.com/rust-windowing/winit) | 0.30.13 | Apache-2.0 |
| [egui](https://github.com/emilk/egui) (+ `egui-wgpu`, `egui-winit`) | 0.35.0 | MIT OR Apache-2.0 |
| [cpal](https://github.com/RustAudio/cpal) | 0.17.3 | Apache-2.0 |
| [ffmpeg-next](https://github.com/zmwangx/rust-ffmpeg) (binding only) | 8.1.0 | WTFPL |
| [rustls](https://github.com/rustls/rustls) | 0.23.42 | Apache-2.0 OR ISC OR MIT |
| [aws-lc-rs](https://github.com/aws/aws-lc-rs) / aws-lc-sys | 1.17.3 / 0.43.0 | ISC, Apache-2.0, MIT, BSD-3-Clause |
| [tokio](https://tokio.rs/) | 1.53.1 | MIT |
| [reqwest](https://github.com/seanmonstar/reqwest) | 0.13.4 | MIT OR Apache-2.0 |

`rustls` and `aws-lc-rs` are not optional: `webrtc-rs` requires them for DTLS.

**FFmpeg applies here too.** `ffmpeg-next` is only the binding (WTFPL); the
FFmpeg libraries themselves must be an LGPL build, dynamically linked and
shipped as separate files, exactly as the Windows and macOS sidecars already do
it. The system FFmpeg of many distributions is built with `--enable-gpl` (the
Arch package on the development machine reports GPL-3.0-only) and is therefore
suitable for local development only. This is enforced by convention, not by the
build — see `streaming/pulse-player/Cargo.toml` and `README.md`.

The AV1 RTP depacketizer in `src/depacket/av1.rs` is Pulse's own code, written
because the `rtp` crate ships only an AV1 payloader.

## Not covered here

Rust crates statically compiled into Pulse's own sidecar binaries (e.g.
`windows-capture`, `wasapi`, `sysinfo`, `windows-rs`, `ffmpeg-next` itself,
`objc2` and its framework crates, `serde`/`serde_json`/`anyhow`) are not
separately redistributed files in the LGPL sense — they become part of
Pulse's own compiled client binary. Their licenses (mostly MIT/Apache-2.0/
WTFPL by upstream convention) were not individually re-verified file-by-file
in this pass; a full dependency-license sweep (`cargo license` per sidecar
crate, plus the separate `pulse-linux-hq-sidecar` repo) is still open if a
stricter audit is ever required.

---

Stand / last updated: 26. Juli 2026
