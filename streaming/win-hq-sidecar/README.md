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

## Drei Encode-Pfade

Vendor-Dispatch in `src/stream_controller.rs::run_pipeline`: `nvidia` → `pipeline_hw`
(D3D11-Zero-Copy), `amd` → `pipeline_d3d12` (D3D12VA-Zero-Copy), sonst (Intel) →
`run_cpu_pipeline`. **Beide GPU-Pfade sind by default aktiv** — `PULSE_HQ_DISABLE_ZERO_COPY=1`
zwingt jeden Vendor auf den CPU-Pfad (für AMD = Fallback auf das funktionierende `h264_amf`).

### NVIDIA Zero-Copy (D3D11 → NVENC)
`src/pipeline_hw.rs` + `src/capture/wgc_hw.rs` + `src/encode/encoder_hw.rs` + `src/encode/hwctx.rs`.

WGC liefert `ID3D11Texture2D`-Frames; im Capture-Callback `CopySubresourceRegion`
GPU-intern in einen D3D11VA-Pool (`av_hwframe_get_buffer`), NVENC liest
`AV_PIX_FMT_D3D11` mit `sw_format=BGRA` direkt — Swizzle + NV12-Convert auf der GPU.
Kein PCIe-Roundtrip, kein `Vec<u8>`-Alloc im Hot-Path.

**ffmpeg-next bindet `hwcontext_d3d11va.h` nicht** → das `AVD3D11VADeviceContext`-Layout
ist in `hwctx.rs` hand-gespiegelt + CRITICAL_SECTION als `lock`/`unlock`-Callback
(FFmpeg serialisiert intern darüber den D3D11-Device-Zugriff; der Capture-Callback
hält denselben Lock manuell für `CopySubresourceRegion`). Aktiv **nur** für NVIDIA.

### AMD Zero-Copy (D3D12VA) — 2026-05-21
`src/pipeline_d3d12.rs` + `src/capture/wgc_d3d12.rs` + `src/encode/d3d12_convert.rs` +
`src/encode/encoder_d3d12.rs` (+ `extradata.rs`).

AMD kann **kein** D3D11-Zero-Copy (s.u., AMF #455), aber FFmpeg 8.1 hat native
**`*_d3d12va`-Encoder** über Microsofts D3D12 Video Encode API — die umgehen die
crashende AMF-Runtime komplett. Pfad nach der Capture komplett D3D12-only:
- WGC liefert weiterhin `ID3D11Texture2D`/BGRA (Windows hat keine D3D12-Capture) →
  `wgc_d3d12.rs` bridged jede Textur per **Shared-NT-Handle** D3D11→D3D12 (BGRA cross-API).
- `d3d12_convert.rs`: **D3D12-Compute-Shader** BGRA→NV12 (BT.709), schreibt direkt in den
  UAV-fähigen Encoder-Pool-Frame — kein CPU-swscale.
- `encoder_d3d12.rs`: `h264_d3d12va` / `hevc_d3d12va` / `av1_d3d12va` (Map `d3d12va_name()`).
  **Sonderfall:** der d3d12va-Encoder liefert keine `extradata` → `write_header` ist bis
  zum ersten Keyframe verzögert, avcC/SPS/PPS kommt aus dem Bitstream (`extradata.rs`).
- `AVD3D12VA*`-Structs sind wie bei NVIDIA in `encoder_d3d12.rs` hand-gespiegelt
  (ffmpeg-sys bindet die D3D12VA-Header nicht).

Kein PCIe-Roundtrip, kein CPU-swscale: conv-Zeit 17 ms → 2,9 ms, stabile 60 fps.

### CPU-Fallback (Intel/QSV + Kill-Switch)
`src/capture/wgc.rs` + `src/encode/encoder.rs` → `run_cpu_pipeline`.

BGRA via `frame.buffer().as_nopadding_buffer()` → CPU `Vec<u8>` → swscale BGRA→NV12 →
QSV/AMF. Aktiv für **Intel** sowie für jeden Vendor unter `PULSE_HQ_DISABLE_ZERO_COPY=1`.
Hat zusätzlich einen **NVIDIA-„BGR-direct"-Fastpath** (BGRA-Bytes 1:1 in den NVENC-Frame
ohne swscale).

## Warum AMD einen eigenen Pfad braucht (AMF #455)

`h264_amf` stürzt auf **D3D11**-Surface-Input reproduzierbar mit Integer-Divide-by-Zero
in der AMF-Runtime ab (`SubmitInput`, Frame 0) — dokumentierter AMD-Treiber-Bug,
AMF-Issue [#455](https://github.com/GPUOpen-LibrariesAndSDKs/AMF/issues/455).
Bind-Flags, Auflösung und NV12-vs-BGRA als Ursache ausgeschlossen (Probe
`examples/probe_d3d11.rs`); identische Encoder-Config mit Software-NV12-Surface läuft
sauber bei 60 fps. Darum **nicht** der NVIDIA-D3D11-Pfad, sondern der eigene D3D12VA-Pfad
(`pipeline_d3d12`), der die AMF-Library umgeht. `h264_amf` läuft nur noch im CPU-Fallback
(Software-NV12-Input), wohin `PULSE_HQ_DISABLE_ZERO_COPY=1` AMD zurückschaltet.

**Dispatch-Detail:** `select_adapter()` liefert auf Multi-GPU den `HIGH_PERFORMANCE`-Slot
(dGPU), nicht zwingend die Display-/Capture-GPU. `run_pipeline` schickt `nvidia` an
`pipeline_hw`; `pipeline_hw::run` prüft dann die ECHTE WGC-D3D11-Device-GPU
(`device_vendor`) und delegiert bei `amd` selbst an `pipeline_d3d12` bzw. sonst an
`run_cpu_pipeline`. Auf einer reinen AMD-Box greift schon `run_pipeline` direkt zu
`pipeline_d3d12`.

## Env-Overrides (Test/Debug)

- `PULSE_HQ_ADAPTER_VENDOR=nvidia|amd|intel` — Adapter-Filter statt
  DXGI-`HIGH_PERFORMANCE`-Default. Auf Multi-GPU (dGPU+iGPU) der einzige Weg, einen
  bestimmten Vendor-Pfad zu validieren, ohne den Default umzustellen.
- `PULSE_HQ_DISABLE_ZERO_COPY=1` — erzwingt den CPU-Pfad für **jeden** Vendor (NVIDIA wie
  AMD). Für A/B-Debugging; auf AMD = Fallback auf `h264_amf` (Software-NV12-Input).
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
