# Windows-HQ-Sidecar

Rust-Bin (Cargo, Edition 2024) — der Windows-Gegenpart zum Linux-GSR-Sidecar
(`streaming/gsr-sidecar/`). Spricht **dasselbe stdio-JSON-RPC-Protokoll** (gleiche
Ops/Events, gleiche Response-Shapes — auch wo's unter Windows keinen GSR gibt:
`health.gsr.source="builtin"` statt Binary-Pfad). Protokoll-Details: `streaming/README.md`.

Electron spawnt ihn lazy beim ersten `gsr:call`; Path-Resolver in
`desktop/electron/sidecar.ts`: `$PULSE_HQ_SIDECAR` → Walk-up auf
`target/release|debug/pulse-win-hq-sidecar.exe` → `%LOCALAPPDATA%\Pulse\hq-sidecar\pulse-win-hq-sidecar.exe`.
Kein Python — die Rust-Bin ist standalone (FFmpeg-DLLs neben der exe).

## Stack

- **Capture:** `windows-capture` v2 (WGC, ID3D11-Texture-Output).
- **Audio:** `wasapi` (Desktop-Loopback + Mikrofon).
- **Encode/Mux:** `ffmpeg-next` 8.1, gelinkt gegen die **vendored** BtbN-LGPL-Shared-
  Distribution unter `ffmpeg-dist/n8.1-lgpl-shared/` (Pfad via `.cargo/config.toml`
  `FFMPEG_DIR`; `build.rs` kopiert die DLLs neben die exe).
- MediaMTX-Build für lokales Testen unter `mediamtx-dist/v1.18.1/mediamtx.exe`.

## Zwei Encode-Pfade

Dispatch in `src/stream_controller.rs::run_pipeline`.

### NVIDIA Zero-Copy
`src/pipeline_hw.rs` + `src/capture/wgc_hw.rs` + `src/encode/encoder_hw.rs` + `src/encode/hwctx.rs`.

WGC liefert `ID3D11Texture2D`-Frames; im Capture-Callback `CopySubresourceRegion`
GPU-intern in einen D3D11VA-Pool (`av_hwframe_get_buffer`), NVENC liest
`AV_PIX_FMT_D3D11` mit `sw_format=BGRA` direkt — Swizzle + NV12-Convert auf der GPU.
Kein PCIe-Roundtrip, kein `Vec<u8>`-Alloc im Hot-Path.

**ffmpeg-next bindet `hwcontext_d3d11va.h` nicht** → das `AVD3D11VADeviceContext`-Layout
ist in `hwctx.rs` hand-gespiegelt + CRITICAL_SECTION als `lock`/`unlock`-Callback
(FFmpeg serialisiert intern darüber den D3D11-Device-Zugriff; der Capture-Callback
hält denselben Lock manuell für `CopySubresourceRegion`). Aktiv **nur** für NVIDIA.

### CPU-Fallback
`src/capture/wgc.rs` + `src/encode/encoder.rs` → `run_cpu_pipeline`.

BGRA via `frame.buffer().as_nopadding_buffer()` → CPU `Vec<u8>` → swscale BGRA→NV12 →
AMF/QSV. Aktiv für AMD/Intel oder bei `PULSE_HQ_DISABLE_ZERO_COPY=1`. Hat zusätzlich
einen **NVIDIA-„BGR-direct"-Fastpath** (BGRA-Bytes 1:1 in den NVENC-Frame ohne swscale).

## AMD kann NICHT zero-copy (2026-05-20, hart verifiziert)

`h264_amf` stürzt auf D3D11-Surface-Input reproduzierbar mit Integer-Divide-by-Zero
in der AMF-Runtime ab (`SubmitInput`, Frame 0) — dokumentierter AMD-Treiber-Bug,
AMF-Issue [#455](https://github.com/GPUOpen-LibrariesAndSDKs/AMF/issues/455).
Bind-Flags, Auflösung und NV12-vs-BGRA als Ursache ausgeschlossen (Probe
`examples/probe_d3d11.rs`); identische Encoder-Config mit Software-NV12-Surface läuft
sauber bei 60 fps. Darum: **AMD/Intel → CPU-Pfad, Punkt.**

**Dispatch-Detail:** `select_adapter()` liefert auf Multi-GPU den `HIGH_PERFORMANCE`-Slot
(dGPU), nicht zwingend die Display-/Capture-GPU. `run_pipeline` schickt `nvidia` an
`pipeline_hw`; `pipeline_hw::run` prüft dann die ECHTE WGC-D3D11-Device-GPU
(`device_vendor`) und delegiert bei `!=nvidia` selbst zurück an `run_cpu_pipeline`.
Auf einer reinen AMD-Box greift schon `run_pipeline` direkt zum CPU-Pfad.

## Env-Overrides (Test/Debug)

- `PULSE_HQ_ADAPTER_VENDOR=nvidia|amd|intel` — Adapter-Filter statt
  DXGI-`HIGH_PERFORMANCE`-Default. Auf Multi-GPU (dGPU+iGPU) der einzige Weg, den
  AMF/QSV-Pfad zu validieren, ohne den Default umzustellen.
- `PULSE_HQ_DISABLE_ZERO_COPY=1` — erzwingt CPU-Pfad auch auf NVIDIA. Für A/B-Debugging.
- `PULSE_HQ_SIDECAR=<pfad>` — Override für den Resolver in `desktop/electron/sidecar.ts`.

## TLS/RTMPS-Fußnote

FFmpegs Schannel-Backend auf Windows ist strict-verify by default — `tls_verify=0`
MUSS gesetzt sein, wenn MediaMTX self-signed nutzt (Pulse-Default, Token in URL ist
die echte Auth). Sonst killt FFmpeg den Push nach dem TLS-Handshake mit „Writing
encrypted data to socket failed" (sieht aus wie ein Network-Bug, ist aber
Cert-Verification — `encoder.rs::create` setzt das automatisch bei `rtmps://`).

## Tests

`cargo build --release` baut + DLL-Copy. Smoke via `examples/test_driver.rs`:

```
cargo run --release --example test_driver -- health|video_only|audio_mux|av1_mux|hevc_mux [rtmp_url]
```

Erwartet MediaMTX auf `rtmp://localhost:1935/<path>` (lokal:
`mediamtx-dist/v1.18.1/mediamtx.exe mediamtx-dist/v1.18.1/mediamtx.yml`). `video_only`
läuft Capture + Encode + Push 10s, validiert `state=live` + ≥1 `fps`-Event;
`audio_mux` zusätzlich Opus-Spur. Logs → `target/test-driver-<scenario>-<unix-ts>.log`.

**Achtung:** DLL-Copy schlägt fehl, wenn ein laufender Sidecar die alten DLLs hält —
der Build kennt die exe-Lock-Datei, gibt aber nur eine Warning auf die DLLs (Build
läuft trotzdem fertig, nur die kopierten DLLs sind dann stale).

> Hintergrund-Recherche zum Pfad-Entscheid (Capture/Audio/Encode-Crate-Wahl,
> Lizenz-Fallen, Aufwandsschätzung): `WINDOWS_HQ_SIDECAR.md` im Repo-Root.
