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
client license.

A full sweep **has** been run on 2026-08-05 — this paragraph used to say it
had not been. `cargo metadata` over all three shipped Rust trees (native
player, Windows sidecar, Linux sidecar; the 44 crates unique to the Linux tree
were looked up individually on crates.io because that tree does not resolve on
a Windows host), plus `pnpm licenses list --prod` over the pnpm workspace.
Result: **no AGPL, no GPL-only, no MPL-only anywhere.** The only copyleft that
ships is FFmpeg (LGPL, dynamically linked everywhere) and gpu-screen-recorder
(GPL-3.0, shipped as a separate program in the Flatpak, not linked against
Pulse). Three dual licences resolve to their permissive side and are recorded
where they occur: `self_cell` (`Apache-2.0 OR GPL-2.0-only` → Apache-2.0),
`r-efi` (`MIT OR Apache-2.0 OR LGPL-2.1-or-later` → MIT) and `dompurify`
(`MPL-2.0 OR Apache-2.0` → Apache-2.0). Re-run the sweep when a dependency
tree changes; it is the only way this file stays true.

## Windows (`streaming/win-hq-sidecar/`)

| Component | Version / pin | License | Declared in |
|---|---|---|---|
| FFmpeg — BtbN prebuilt, **unmodified** | frozen self-hosted mirror of BtbN's `n8.1` LGPL-shared build, dated 2026-06-16 | LGPL (that distribution's own licence text is **v3**, shipped as `LICENSE.txt` at the package root) | `scripts/fetch-ffmpeg.ps1` (`$Url`/`$ExpectedSha`, SHA256-pinned), `.cargo/config.toml` (`FFMPEG_DIR`), `Cargo.toml` (`ffmpeg-next` binding), `.github/workflows/win-build.yml` (CI fetch step) |
| pulse-player (native HQ player) | shipped in the Windows installer since app version `0.1.42` | Pulse's own client code; its third-party tree is listed in its own section below | `desktop/electron-builder.yml` (`win.extraResources` → `resources/hq-sidecar/pulse-player.exe`), `.github/workflows/win-build.yml` (build steps) |
| nv-codec-headers | `n13.0.19.0` (build-time only, not redistributed as a file) | MIT | Referenced alongside the Linux FFmpeg module, `packaging/com.howispulse.Pulse.yml:169-179` |

**Windows ships an unmodified FFmpeg.** From 2026-08-05 to 2026-08-21 it did
not: Pulse built its own `n8.1.2` with one patch that exposed rolling intra
refresh on `av1_amf`. That operating mode has been removed from Pulse, and with
it the patch, the self-build script and the change notice that had to travel
inside the distribution. What ships now is the frozen mirror of BtbN's
LGPL-shared package, byte-identical to what BtbN published.

How the LGPL obligations are met: the DLLs sit next to
`pulse-win-hq-sidecar.exe` as separate, exchangeable files (dynamic linking);
the source is the unmodified upstream release; and the package's own
`LICENSE.txt` is shipped into `resources/hq-sidecar/FFMPEG-LICENSE.txt` by
`desktop/electron-builder.yml`. Until 2026-08-05 the installer carried only
Electron's and Chromium's licence texts, although seven LGPL DLLs shipped
beside them — that gap is closed and stays closed.

### The libraries that ship next to the sidecar

BtbN's package carries eight files: the seven `av*`/`sw*` libraries plus its
own licence text. Nothing else is bundled — unlike a self-built MinGW tree,
which drags its whole runtime along.

| File | Component | License |
|---|---|---|
| `avcodec-62`, `avformat-62`, `avfilter-11`, `avutil-60`, `swresample-6`, `swscale-9`, `avdevice-62` | FFmpeg (unmodified) | LGPL |

Whoever swaps the FFmpeg package changes this table: re-read
`ffmpeg-dist/n8.1-lgpl-shared/bin/*.dll` afterwards rather than assuming the
set is stable. A self-built tree in particular pulls in a dozen further DLLs
(GCC runtime, libsrt, OpenSSL, dav1d …), each with a licence that asks to be
named.

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
| FFmpeg — **unmodified** | git tag `n8.1.1`, commit `239f2c733de417201d7ad3b3b8b0d9b63285b2b1` | LGPLv3 (`--enable-version3`, no `--enable-gpl`/libx264) | `com.howispulse.Pulse.yml` (ffmpeg module) |
| nv-codec-headers | git tag `n13.0.19.0`, commit `e844e5b26f46bb77479f063029595293aa8f812d` | MIT (headers only, build-time) | `com.howispulse.Pulse.yml:169-179` |
| gpu-screen-recorder | commit `0349083cfe4578dbc8bc600e31187e8e09318add` + 3 Pulse patches | GPL-3.0-or-later | `com.howispulse.Pulse.yml:187-200`, `streaming/patches/LICENSE` |
| pulse-linux-hq-sidecar (Rust) | in-tree at `streaming/linux-hq-sidecar/`, built via `type: dir` | Pulse's own client code (not third-party) | `com.howispulse.Pulse.yml` (linux-hq-sidecar module) |
| pulse-player (native HQ player, Rust) | in-tree at `streaming/pulse-player/`, built to `/app/bin/pulse-player` | Pulse's own client code; third-party tree in its own section below | `com.howispulse.Pulse.yml` (pulse-player module) |

The sidecar row used to point at a **separate repository** and a pinned commit
(`1afe5f11…`). That repo moved in-tree on 2026-07-29 and was **deleted** on
2026-07-30 — the reference had been dangling since. Nothing about the licence
changes; it is Pulse's own code either way.

Electron's own bundled third-party notices (Chromium, Node.js, etc.) ship
inside the official Electron release archive and are not reproduced here.

## Native HQ player (`streaming/pulse-player/`)

Ships on **Linux** (Flatpak, `/app/bin/pulse-player`) and, since app version
`0.1.42`, on **Windows** (`resources/hq-sidecar/pulse-player.exe`, next to the
FFmpeg DLLs it links against). macOS does not ship it. It is additive: without
the binary the renderer stays on the built-in `<video>` WHEP path.

Everything below is **statically linked into that binary**, so the notices
travel with the shipped file even though there are no separate library files.
The user-facing counterpart is the "Nativer HQ-Player" section of
`web/src/lib/legal/drittanbieter.md`; keep both in step.

| Component | Version | License | Note |
|---|---|---|---|
| webrtc-rs | 0.17.2 | MIT OR Apache-2.0 | **Modified by Pulse** — two patches, see below |
| wgpu / winit / egui (+ `egui-wgpu`, `egui-winit`, `egui_extras`) | 29.0.4 / 0.30.13 / 0.35.0 | MIT OR Apache-2.0 (winit: Apache-2.0) | |
| resvg / usvg | 0.45.1 | Apache-2.0 OR MIT | SVG icon rasteriser pulled in by `egui_extras`'s `svg` feature |
| tiny-skia | 0.11.4 | BSD-3-Clause | |
| cpal | 0.17.3 | Apache-2.0 | audio output |
| ffmpeg-next / ffmpeg-sys-next | 8.1.0 | WTFPL | bindings only — FFmpeg itself is the LGPL library above |
| rustls | 0.23.42 | Apache-2.0 OR ISC OR MIT | |
| aws-lc-rs | 1.17.3 | ISC AND (Apache-2.0 OR ISC) AND … | crypto provider chosen in `main.rs` |
| webpki-root-certs | 1.0.9 | CDLA-Permissive-2.0 | Mozilla root store |
| self_cell | 1.3.0 | Apache-2.0 OR GPL-2.0-only | **Pulse takes Apache-2.0.** The only GPL text anywhere in the shipped trees, and it is an either/or |
| ICU4X (`icu_*`, `zerovec`, `tinystr`, `writeable`, `yoke`, …) | 2.2.0 | Unicode-3.0 | |
| epaint_default_fonts | 0.35.0 | (MIT OR Apache-2.0) AND **OFL-1.1** AND **Ubuntu-font-1.0** | egui's default fonts, embedded because `theme.rs` starts from `FontDefinitions::default()` |
| Plus Jakarta Sans (Regular, SemiBold) | — | **SIL OFL 1.1** | `assets/fonts/`, `include_bytes!` in `theme.rs`; origin + notice in `assets/fonts/LICENSE.md` |
| Lucide icons | — | **ISC** (parts from Feather, MIT) | `assets/icons/`, notice in `assets/icons/LICENSE.md` |

**Modification notice for webrtc-rs (Apache-2.0 §4(b)):** Pulse changes
`webrtc/src/dtls_transport/mod.rs` (read access to streams whose SSRC matches no
declared track — where the FlexFEC parity packets sit) and the NACK generator
under `interceptor/src/nack/generator/`. The patches live in
`streaming/pulse-player/patches/` with their own `LICENSE` file; that file was
missing until 2026-08-05, which left MIT/Apache-derived material looking as if
it fell under the Pulse Client License.

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
