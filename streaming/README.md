# streaming/ — HQ-Screen-Streaming für Pulse

Zwei Plattform-Sidecars, **gleiches stdio-JSON-RPC-Protokoll**: Linux nutzt GPU Screen Recorder (`gsr-sidecar/`,
Python), Windows nutzt einen eigenen Rust-Sidecar (`win-hq-sidecar/`, WGC + WASAPI + ffmpeg-next). Beide pushen via
RTMPS an MediaMTX → Viewer holen den Stream per WHEP.

GSR-Teil ist vendored aus `~/Dokumente/GPU_Screen_Recorder/` (2026-05-11). Das **Original-Repo bleibt unangetastet** —
es ist das bewährte Standalone-GSR-Setup mit Qt-UI und eigenem Flatpak; hier liegt nur die für Pulse gebrauchte
Teilmenge plus ein stdio-Sidecar statt der Qt-UI.

## Layout

```
streaming/
├── gsr-sidecar/             Linux: pure-stdlib Python-Sidecar
│   ├── profiles.py          Stream-/ServerProfile (+ ServerProfile.from_channel)
│   ├── stream_controller.py subprocess.Popen-Wrapper für GSR (statt QProcess)
│   ├── gsr_binary.py        Binary-Resolver + --info-Parser
│   ├── control.py           stdio-Loop, JSON-RPC-Protokoll
│   └── __init__.py
├── win-hq-sidecar/          Windows: Rust-Sidecar — s. unten
│   ├── src/                 WGC-Capture + WASAPI + ffmpeg-next-Encode
│   ├── ffmpeg-dist/         vendored FFmpeg LGPL n8.1-shared (BtbN)
│   ├── mediamtx-dist/       MediaMTX-Binary für lokale Smoke-Tests
│   └── examples/            cargo-runnable Smoke-Driver
├── patches/                 GSR-C++-Patches (FLV-Opus, Vulkan-Stub) — verbatim
├── server/                  MediaMTX-Setup (Template + docker-compose + Player)
├── bootstrap-gsr.fish       Custom-GSR-Build mit Patches (für T6 Flatpak)
├── pyproject.toml           uv-Workspace-Member "gsr-sidecar" (package=false)
└── README.md                hier
```

## Was vom Original-Repo NICHT mitkopiert wurde

- Qt-UI: `ui/main.py`, `ui/stream_window.py` — Funktionalität wird in T3
  als Svelte neu gebaut.
- Build-/Binär-Artefakte: `mediamtx`-Binary (~50 MB), `*.flatpak`, `build/`,
  `.flatpak-builder/`, `*.log`.
- **`server/.stream-key` und das generierte `server/mediamtx.yml`** — die
  enthalten den echten Stream-Key. Beide Pfade sind in der Worktree-
  `.gitignore` blockiert.
- `bootstrap.fish` (lädt nur MediaMTX-Binary für Standalone-Lokal-Tests;
  wir brauchen das hier nicht — der Server läuft auf dem VPS).
- `packaging/` (Flatpak-Manifest) — wird in T6 zu einem kombinierten Manifest
  (Tauri + Sidecar + GSR-Build) zusammengeführt.

## GSR-Original bleibt unangetastet

`~/Dokumente/GPU_Screen_Recorder/` wird ausschließlich gelesen. Das
Original-Repo ist die Heimat des Standalone-GSR-Streamers (eigene
Flatpak, Qt-UI). Änderungen an Streaming-Logik werden **nur** hier in
`streaming/` gemacht.

## Sidecar — Protokoll

Der Sidecar (`gsr-sidecar/control.py`) liest pro **stdin-Zeile** einen
JSON-Request und schreibt pro Antwort/Event eine JSON-Zeile auf stdout:

- **Response** hat `"id"` (gespiegelt vom Request, kann `null` sein) und
  `"ok"` (bool). Bei `ok=false` liegt `"error"` dabei.
- **Event** hat `"ev"`, kein `"id"`/`"ok"`.

### Operationen (Request `{"op": "...", "id": ...?}`)

| op | Request-Felder | Response (zusätzlich zu `ok`+`id`) |
|---|---|---|
| `health` | — | `gsr: {available, source, path?, version?, vendor?, is_flatpak, video_codecs?, has_flv_patch?, ...}` |
| `gpu_info` | — | `vendor, card_path, display_server, video_codecs` (re-probe falls noch nicht da) |
| `list_profiles` | — | `profiles, servers (immer `[]`), audio_modes, app_label_prefix` |
| `list_monitors` | — | `monitors: [{index (1-basiert), name, primary, width, height, refresh_hz}, ...]` — **nur Windows-Sidecar** (Linux nutzt den Portal-Picker) |
| `list_application_audio` | — | `applications: [name, ...]` (Apps mit Audio-Output) |
| `build_argv` | siehe `start` | `binary, argv` — **baut die Argumentliste ohne GSR zu starten** (Test/Debug) |
| `start` | `profile, channel: {id, token, push_url?, mediamtx_endpoint?, push_protocol?}, capture, audio: {mode, excluded_apps}, overrides? {codec, bitrate_kbps, fps, resolution}` | `argv` (die gleiche Liste) — danach kommen Events |
| `stop` | — | `ok` |
| `state` | — | `running, state, fps, uptime_s, argv` |

`start`/`build_argv` brauchen den Channel-Block — Pulse streamt immer in einen
Voice-Channel:

- `channel: {id, token, push_url?, mediamtx_endpoint?, push_protocol?}` — Pulse-
  Channel-Pfad (`ServerProfile.from_channel()`). `push_url` (von media-svc, mit
  Token drin) wird wenn gesetzt verbatim an GSR `-o` gereicht; sonst werden
  `mediamtx_endpoint` + `push_protocol` als Fallback genutzt.

`capture`: Linux `"portal"`/`"monitor"`/`"window"` (Portal-Dialog wählt die
Quelle). Windows-Sidecar zusätzlich `"Monitor: <index>"` (Index aus
`list_monitors`) und `"Window: <title>"`; `"portal"` → Primärmonitor.

### Events (`{"ev": "..."}`)

- `state` — `state ∈ {"idle","starting","live","error","stopped"}`, `running`, `uptime_s`
- `fps` — `fps`, `uptime_s` (kommt sobald GSR "update fps: N" auf stderr meldet → impliziert "live")
- `log` — `line` (eine Roh-Zeile GSR-stderr; gemerged inklusive stdout)
- `error` — `message`
- `stopped` — kommt direkt nach dem letzten `state=stopped`-Event

### Beispiel

```jsonc
// → stdin
{"op": "health", "id": 1}
// ← stdout
{"id":1,"ok":true,"gsr":{"available":true,"source":"system","path":"/usr/bin/gpu-screen-recorder","is_flatpak":false,"version":"5.13.4","vendor":"nvidia",...}}

// → stdin
{"op": "build_argv", "id": 2,
 "profile": "AV1 Effizient",
 "channel": {"id": "123", "token": "TOKEN",
             "push_url": "rtmps://stream.example.com:1936/channel-123-9?user=pulse&pass=TOKEN"},
 "capture": "portal",
 "audio": {"mode": "Desktop", "excluded_apps": []},
 "overrides": {"codec": "av1", "resolution": "1080p", "bitrate_kbps": 4000, "fps": 60}}
// ← stdout
{"id":2,"ok":true,"binary":"/usr/bin/gpu-screen-recorder","argv":["/usr/bin/gpu-screen-recorder","-w","portal","-f","60","-c","flv","-k","av1","-bm","cbr","-q","4000","-ac","opus","-a","default_output","-s","1920x1080","-o","rtmps://stream.example.com:1936/channel-123-9?user=pulse&pass=TOKEN"]}
```

## Sidecar standalone testen

```bash
# Im Worktree-Root:
python streaming/gsr-sidecar/control.py < <(printf '%s\n' \
  '{"op":"health","id":1}' \
  '{"op":"gpu_info","id":2}' \
  '{"op":"list_profiles","id":3}' \
  '{"op":"build_argv","id":4,"profile":"AV1 Effizient","channel":{"id":"123","token":"TESTKEY","push_url":"rtmps://stream.example.com:1936/channel-123-9?user=pulse&pass=TESTKEY"},"capture":"portal","audio":{"mode":"Desktop","excluded_apps":[]},"overrides":{"codec":"av1","resolution":"1080p","bitrate_kbps":4000,"fps":60}}')
```

Antworten kommen als JSON-Lines auf stdout. **Kein `start` im Test** —
das würde den Wayland-Portal-Capture-Dialog öffnen und tatsächlich an
MediaMTX pushen. Das macht der User selbst.

## GSR-Binary-Resolver

Reihenfolge: `$GSR_BINARY` → Flatpak (`/app/bin/gpu-screen-recorder` wenn
`/.flatpak-info` oder `$FLATPAK_ID`) → Custom-Build
(`$XDG_CACHE_HOME/pulse/gsr/gpu-screen-recorder/build/gpu-screen-recorder`,
gebaut von `bootstrap-gsr.fish`; Legacy-Fallback `/tmp/gsr-analysis/...` für
alte, noch nicht migrierte Builds) → System-PATH (`gpu-screen-recorder`).

Wenn nichts gefunden wird, antwortet `health` mit `gsr.available=false`
und `start` schlägt sauber fehl statt zu crashen.

## Stream-Key / Secrets

`streaming/server/mediamtx.yml.template` enthält nur den
`STREAM_KEY_PLACEHOLDER`. Die generierte `streaming/server/mediamtx.yml`
und `streaming/server/.stream-key` sind **gitignored** (im Worktree-
Root-`.gitignore`). Sidecar-RPC sieht den Stream-Key/Token nur transient
als Request-Field — er wird **nicht** persistiert, **nicht** geloggt und
landet ausschließlich in der Push-URL (GSR auf Linux, ffmpeg-next auf Windows).

## Windows-Sidecar (`win-hq-sidecar/`)

Rust-Binary, gleiches stdio-JSON-RPC wie der Linux-GSR-Sidecar (alle Ops/Events
identisch). Stack: `windows-capture` v2 (WGC), `wasapi` (Desktop-Loopback +
Mikrofon), `ffmpeg-next` 8.1 gegen die **vendored** BtbN-LGPL-Shared-Distribution
unter `ffmpeg-dist/n8.1-lgpl-shared/`. `build.rs` kopiert die FFmpeg-DLLs neben
die exe — Binary ist standalone, kein Python nötig.

**Zwei Encode-Pfade**, dispatch in `src/stream_controller.rs::run_pipeline`:
- **NVIDIA Zero-Copy** (`src/pipeline_hw.rs` + `capture/wgc_hw.rs` + `encode/encoder_hw.rs` + `encode/hwctx.rs`):
  WGC liefert `ID3D11Texture2D`-Frames; im Capture-Callback `CopySubresourceRegion` GPU-intern in einen D3D11VA-Pool
  (`av_hwframe_get_buffer`), NVENC liest `AV_PIX_FMT_D3D11` mit `sw_format=BGRA` direkt — Swizzle + NV12-Convert auf
  der GPU. Kein PCIe-Roundtrip. **ffmpeg-next bindet `hwcontext_d3d11va.h` nicht** → `AVD3D11VADeviceContext` in
  `hwctx.rs` hand-gespiegelt, CRITICAL_SECTION als FFmpeg-Lock-Callback (Capture-Thread hält denselben Lock manuell
  für CopySubresourceRegion). Aktiv für `adapter.vendor() == "nvidia"`.
- **CPU-Pfad** (`capture/wgc.rs` + `encode/encoder.rs`): BGRA via `frame.buffer()` → CPU-Vec → swscale BGRA→NV12 →
  AMF/QSV. Aktiv für AMD/Intel oder mit `PULSE_HQ_DISABLE_ZERO_COPY=1`. Hat zusätzlich einen NVIDIA-„BGR-direct"-
  Fastpath (NVENC schluckt BGRA-Bytes 1:1 ohne swscale wenn keine Downscale-Differenz). AMD/Intel Zero-Copy bräuchten
  einen GPU-Color-Convert vor dem Encoder (D3D11-Compute-Shader oder `scale_d3d11`-Filter) — nicht implementiert.

**Env-Overrides**:
- `PULSE_HQ_ADAPTER_VENDOR=nvidia|amd|intel` — Adapter-Filter statt DXGI-`HIGH_PERFORMANCE`-Default. Auf Multi-GPU
  (dGPU+iGPU) der einzige Weg den AMF/QSV-Pfad zu validieren.
- `PULSE_HQ_DISABLE_ZERO_COPY=1` — erzwingt CPU-Pfad auch auf NVIDIA. A/B-Debugging.
- `PULSE_HQ_SIDECAR=<pfad>` — Override für den Resolver in `desktop/electron/sidecar.ts`.

**Build + Test**:
```powershell
cd streaming/win-hq-sidecar
cargo build --release
# Smoke (kein realer Stream — nur health/gpu_info/list_profiles/state):
'{"op":"health","id":1}' | .\target\release\pulse-win-hq-sidecar.exe

# Echter Smoke gegen lokales MediaMTX:
Start-Process .\mediamtx-dist\v1.18.1\mediamtx.exe .\mediamtx-dist\v1.18.1\mediamtx.yml
cargo run --release --example test_driver -- video_only rtmp://localhost:1935/smoke
cargo run --release --example test_driver -- audio_mux  rtmp://localhost:1935/smoke
```
Test-Driver-Logs landen unter `target/test-driver-<scenario>-<unix-ts>.log`. Build-Caveat: bei laufendem Sidecar
schlägt der DLL-Copy fehl (nur Warning, Build läuft trotzdem fertig — aber die DLLs neben der frischen exe sind dann
stale). Sidecar-Prozess vorher stoppen.

**TLS/RTMPS-Fußnote**: FFmpegs Schannel-Backend ist strict-verify by default → `tls_verify=0` MUSS für `rtmps://`
gesetzt sein wenn MediaMTX self-signed nutzt (Pulse-Default; Token in URL ist die echte Auth). Sonst killt FFmpeg den
Push nach dem TLS-Handshake mit „Writing encrypted data to socket failed". `encoder.rs::create` +
`encoder_hw.rs::create` setzen das automatisch bei `rtmps://`.

## Nächste Etappe (T3)

- Tauri (Rust): spawnt den Sidecar als Subprocess, liest stdout-Events,
  forwarded sie als Tauri-Events ins Frontend.
- Svelte: baut die GSR-UI (Profil-/Server-/Capture-Picker, Audio-Mode,
  Overrides, Start/Stop, Live-FPS+Uptime, Log) gegen das RPC-Protokoll
  oben. Persistenz wandert auf den Tauri-`store` (statt
  `~/.config/gsr-stream-ui/`).
