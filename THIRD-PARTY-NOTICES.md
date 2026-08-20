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
| FFmpeg — self-built, **MODIFIED by Pulse** | `n8.1.2` + `streaming/ffmpeg-patches/0002-amfenc_av1-rollender-intra-refresh.patch`, package dated 2026-08-05 | LGPL 2.1-or-later (no `--enable-gpl`/`--enable-nonfree`/`--enable-version3`, no libx264/libx265); the patch itself is LGPL-2.1-or-later per `streaming/ffmpeg-patches/LICENSE` | `scripts/build-ffmpeg-patched.ps1` (the build), `scripts/fetch-ffmpeg.ps1` (`$PatchedUrl`/`$PatchedSha`, SHA256-pinned), `.cargo/config.toml` (`FFMPEG_DIR`), `Cargo.toml` (`ffmpeg-next` binding), `.github/workflows/win-build.yml` (CI fetch step) |
| FFmpeg — BtbN prebuilt, unmodified (**fallback only**) | frozen self-hosted mirror of BtbN's `n8.1` LGPL-shared build, dated 2026-06-16 | LGPL (that distribution's own licence text is **v3**) | `scripts/fetch-ffmpeg.ps1` (`$FallbackUrl`/`$FallbackSha`) — used only if `$PatchedUrl`/`$PatchedSha` are cleared |
| pulse-player (native HQ player) | shipped in the Windows installer since app version `0.1.42`, in the macOS DMG since `0.1.69` | Pulse's own client code; its third-party tree is listed in its own section below | `desktop/electron-builder.yml` (`win.extraResources` → `resources/hq-sidecar/pulse-player.exe`; `mac.extraResources` for the macOS bundle), `.github/workflows/win-build.yml` / `mac-build.yml` (build steps) |
| nv-codec-headers | `n13.0.19.0` (build-time only, not redistributed as a file) | MIT | Referenced alongside the Linux FFmpeg module, `packaging/com.howispulse.Pulse.yml:169-179` |

**Since 2026-08-05 Windows ships a Pulse-MODIFIED FFmpeg.** Built from the
official `n8.1.2` source with **one** Pulse patch
(`streaming/ffmpeg-patches/0002-amfenc_av1-rollender-intra-refresh.patch`) — it
exposes rolling intra refresh on `av1_amf`, which no FFmpeg release offers.
Without it, AMD cards get no intra refresh on Windows at all: the AV1 path is
`av1_amf`, and the regular H.264 path on AMD is `h264_d3d12va`, which accepts
the option and does nothing with it. Measured on the shipped BtbN package
before the switch: `av1_amf` present, `intra_refresh_mode` and
`intra_refresh_stripes` **both absent**; on the new build both present.

That patch is **LGPL-2.1-or-later**, as a derivative of FFmpeg's own LGPL
source. This file claimed GPL-3.0 until 2026-08-05, which contradicted both
`streaming/ffmpeg-patches/LICENSE` and the Flatpak manifest and was wrong (the
GPL-3.0 belongs to `streaming/patches/`, the gpu-screen-recorder patches).

How the LGPL obligations are met: the configure line carries no
`--enable-gpl`, no `--enable-nonfree`, no libx264/libx265 and no
`--enable-version3` (`build-ffmpeg-patched.ps1` refuses to install a build that
does); the DLLs sit next to `pulse-win-hq-sidecar.exe` as separate,
exchangeable files (dynamic linking); the modified source is in this
repository; and since 2026-08-05 the built package itself carries **two** files
at its root, which the build script stages and `desktop/electron-builder.yml`
ships into `resources/hq-sidecar/`:

* `LICENSE.txt` — FFmpeg's `COPYING.LGPLv2.1`, matching the configure line.
  (BtbN's package carried LGPL **v3**; a self-built tree carries none at all
  unless staged, which is why this step exists.)
* `PULSE-AENDERUNGEN.txt` — states that the library is modified, names the
  patch and links to it. The change notice travels inside the distribution, not
  only in this repository.

**Rolling back** is clearing `$PatchedUrl`/`$PatchedSha` in
`scripts/fetch-ffmpeg.ps1`: the script then takes the BtbN fallback, warns, and
raises a GitHub annotation. AMD loses intra refresh on Windows again, and the
licence statements above and on `/drittanbieter` must be reverted with it.

### The libraries that now ship next to the sidecar

**This list changed on 2026-08-05 and the change is easy to miss.** BtbN's
package shipped eight files (the seven `av*`/`sw*` libraries plus its own
licence text). A self-built MinGW tree additionally needs its runtime — without
it no binary starts at all, silently (`0xC0000135`, before a line of code runs)
— so `build-ffmpeg-patched.ps1` walks `objdump -p` transitively and stages
whatever it finds. Twelve further DLLs come along that way, and three of them
carry licences worth stating precisely.

| File | Component | License |
|---|---|---|
| `avcodec-62`, `avformat-62`, `avfilter-11`, `avutil-60`, `swresample-6`, `swscale-9`, `avdevice-62` | FFmpeg (modified, see above) | LGPL-2.1-or-later |
| `libgcc_s_seh-1`, `libstdc++-6` | GCC runtime (pulled in by libsrt, which is C++) | **GPL-3.0-or-later WITH GCC-exception-3.1** — the Runtime Library Exception explicitly permits distribution alongside programs under any licence; this is *not* a GPL obligation on Pulse |
| `libiconv-2` | GNU libiconv | **LGPL-2.1** — unmodified, separate exchangeable file, same posture as FFmpeg |
| `libsrt` | Haivision SRT | **MPL-2.0** — file-level copyleft, unmodified, shipped as its own file; source at `github.com/Haivision/srt` |
| `libcrypto-3-x64` | OpenSSL 3 | Apache-2.0 |
| `libdav1d-7` | dav1d | BSD-2-Clause |
| `libopus-0` | libopus | BSD-3-Clause |
| `libvpl-2` | Intel VPL | MIT |
| `libwinpthread-1` | mingw-w64 winpthreads | MIT/permissive |
| `zlib1` | zlib | Zlib |
| `liblzma-5` | xz/liblzma | 0BSD/public domain |
| `libbz2-1` | bzip2 | BSD-style |

None of these forces anything on Pulse's own code. They are listed because they
are **shipped as files** and every one of those licences asks to be named.
Whoever changes the configure line in `build-ffmpeg-patched.ps1` changes this
table: re-read `ffmpeg-dist/n8.1-lgpl-shared/bin/*.dll` afterwards rather than
assuming the set is stable.

## macOS (`streaming/mac-hq-sidecar/`)

| Component | Version / pin | License | Declared in |
|---|---|---|---|
| FFmpeg (self-built) | `8.0.1` (`FFMPEG_VERSION` default) | LGPL (no `--enable-gpl`/libx264/libx265) | `streaming/mac-hq-sidecar/scripts/build-ffmpeg.sh:9-42`, `Cargo.toml:46-53`, `.cargo/config.toml`, `.github/workflows/mac-build.yml:14-22,58-81` |
| dav1d | since 2026-08-20 | BSD-2-Clause | `streaming/mac-hq-sidecar/scripts/build-ffmpeg.sh` (`--enable-libdav1d`) |
| pulse-player (native HQ player) | shipped in the macOS DMG since app version `0.1.69` | Pulse's own client code; its third-party tree is listed in its own section below | `desktop/electron-builder.yml` (`mac.extraResources` → `Resources/hq-sidecar/`), `.github/workflows/mac-build.yml` (build steps) |

Built from the unmodified official `ffmpeg.org` source tarball with
`--enable-openssl --disable-securetransport --enable-videotoolbox
--enable-audiotoolbox --enable-libopus` and no GPL-triggering flags. The
resulting dylibs are bundled next to the app via `scripts/bundle-dylibs.sh`
(dynamic linking). Note: unlike the Linux Flatpak FFmpeg module, this
configure line does not pass `--enable-version3` — which LGPL minor version
(2.1-or-later vs. 3) that produces was not independently confirmed from
within this repository and is flagged here as an open question rather than
asserted.

**Since 2026-08-20 this FFmpeg additionally embeds `libdav1d`** (BSD-2-Clause,
`--enable-libdav1d`). Reason: FFmpeg's own `av1` decoder is a pure hardware
stub, and VideoToolbox cannot decode AV1 before the M3 generation — without
dav1d, `pulse-player` had no way to show AV1 at all on M1/M2 Macs. dav1d does
not touch the LGPL bookkeeping above; it is a separate BSD-2-Clause dylib
bundled the same way (dynamic, exchangeable file next to the app).

**`streaming/pulse-player/` links against this same dylib set as of app
version `0.1.69`** — `scripts/bundle-dylibs.sh` builds one shared bundle
directory for both the sidecar and the player (`<outdir> <binary...>`), so
everything said above about dynamic linking, exchangeability and source
availability applies equally to the player binary, not just the sidecar.

## Linux (Flatpak, `packaging/com.howispulse.Pulse.yml`)

| Component | Version / pin | License | Declared in |
|---|---|---|---|
| Electron | `43.0.0` | MIT | `com.howispulse.Pulse.yml:267` (official release zip), bundled unmodified into `/app/electron/` |
| FFmpeg — **modified by Pulse** | git tag `n8.1.1`, commit `239f2c733de417201d7ad3b3b8b0d9b63285b2b1`, plus `streaming/ffmpeg-patches/0001-vaapi_encode-rollender-intra-refresh.patch` | LGPLv3 (`--enable-version3`, no `--enable-gpl`/libx264); the patch itself is LGPL-2.1-or-later per `streaming/ffmpeg-patches/LICENSE` | `com.howispulse.Pulse.yml` (ffmpeg module + `type: patch` source) |
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

Ships on **Linux** (Flatpak, `/app/bin/pulse-player`), since app version
`0.1.42` on **Windows** (`resources/hq-sidecar/pulse-player.exe`, next to the
FFmpeg DLLs it links against), and since app version `0.1.69` on **macOS**
(`Resources/hq-sidecar/`, `desktop/electron-builder.yml` → `mac.extraResources`,
sharing the same dylib set `scripts/bundle-dylibs.sh` builds for the sidecar —
see the macOS section above). It is additive: without the binary the renderer
stays on the built-in `<video>` WHEP path.

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

Stand / last updated: 20. August 2026
