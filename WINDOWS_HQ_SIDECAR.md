# Windows-HQ-Streaming — Pfad-Analyse & Rust-Sidecar-Recherche

> **Status:** Recherche-Dokument, kein Implementations-Greenlight.
> Recherche-Stand 2026-05-19, basiert auf drei parallelen Tiefenrecherche-Agents (Capture / Audio / Encode+RTMPS).
> **Linux-Realität:** Der Sidecar kann auf Linux nur **gebaut** (Cross-Compile) werden, nicht ausgeführt — WGC/WASAPI/NVENC existieren auf Linux nicht.

Komplementär zur LiveKit-Browser-Screenshare-Recherche (siehe Code in `web/src/lib/voice/windowAudioCapture.ts`). Dieses Dokument ist über den **HQ-Pfad-Ersatz** auf Windows — also das Pendant zum Linux-GSR-Sidecar (RTMPS → MediaMTX → WHEP), nicht über LiveKit-Voice.

## Die Drei-Optionen-Hierarchie

| Option | Status | Aufwand | Was es löst |
|---|---|---|---|
| **Browser-LiveKit** (`getDisplayMedia` + `windowAudio:"window"`) | ✅ **geshippt 2026-05-17 (`dc4f040`)** | ~1 PT | 80%-Lösung, kein HQ aber Per-App-Audio im LiveKit-Share auf Win11+Chrome141+ |
| **OBS-Bootstrapper** | offen | ~1 Woche | echter HQ-Pfad, aber 2-3 User-Installs (OBS + `win-capture-audio`-Plugin + Provisioning), OBS-Fenster sichtbar |
| **Rust-Sidecar** (Detail-Recherche unten) | offen | **~11-12 PT production** | identische UX zu Linux, ein Binary, eigene Roadmap (AV1/HDR), volle Kontrolle |

**Aktueller Stand:** Option 1 ist live in `web/src/lib/voice/windowAudioCapture.ts` + `livekit.svelte.ts::setScreenShare()` (Bypass-Branch wenn `canUseWindowAudioCapture()`). Echo von Pulse-Voice auf Win11/Chrome141+ ist damit erschlagen. Für *echtes* HQ (RTMPS→MediaMTX→WHEP wie auf Linux) bleiben Optionen 2 und 3 offen.

## Browser-LiveKit (Option 1) — was geliefert wurde

Chrome 141 (Sept 2025) hat das Per-Process-Audio-Problem nativ gelöst:

1. `getDisplayMedia({ windowAudio: "window", systemAudio: "exclude" })` → Chromium ruft selbst die WASAPI Application-Loopback-API (`ActivateAudioInterfaceAsync` mit `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`) auf
2. Gate ist `kApplicationAudioCaptureWin` + `base::win::GetVersion() >= Version::WIN11`
3. Echo von Pulse-Voice gelöst weil `systemAudio:"exclude"` Pulse-Chrome-Audio ausschließt + `windowAudio:"window"` nur die Game-Process-Tree-Audio captured

Plattform-Matrix:

| OS | Browser-Pfad | Status |
|---|---|---|
| **Win11 + Chrome/Edge 141+** | `windowAudio:"window"` + `systemAudio:"exclude"` | ✅ Echo gelöst, 0 Code von uns |
| **Win10** | gleich, aber API-Gate false → Audio-Track gedroppt | ⚠️ video-only; Workaround: Voicemeeter oder „bitte Win11" |
| **Linux** | GSR-Sidecar (Electron-Pfad) | ✅ schon da |
| **macOS 14.2+** | gleicher Call, aber per-App-Glue unklar | wahrscheinlich ✅, ungetestet |
| **macOS <14.2** | kein Audio-Capture | ⚠️ video-only |

LiveKit-Integration: LiveKits `ScreenShareCaptureOptions` hat **kein** `windowAudio`-Feld + interner `screenCaptureToDisplayMediaStreamOptions`-Helper whitelistet Felder → `setScreenShareEnabled({...})` funktioniert nicht. Bypass: `getDisplayMedia` selbst callen, Track via `room.localParticipant.publishTrack(...)` publishen. Genau das macht der Code in `livekit.svelte.ts:418`.

## OBS-Bootstrapper (Option 2) — kurz

User installiert OBS getrennt, Pulse spricht obs-websocket-Plugin an. Lizenz-sauber (kein Linking → kein GPL-Trigger, siehe Memory `reference_obs_gpl_licensing.md`). Echte HQ-Qualität via OBS' eigene Encoder, aber:
- 2-3 separate User-Installs (OBS + `win-capture-audio` + Pulse-Provisioning-Setup)
- OBS-Fenster bleibt sichtbar (Recording-Indicator, Stream-Status)
- ~1 Woche Provisioning-/Setup-/Glue-Code

Nicht weiter verfolgt in dieser Recherche.

## Rust-Sidecar (Option 3) — die Detail-Analyse

### Stack (verifiziert per Recherche 2026-05-19, alles MIT/LGPL — Pulse-Lizenz unverändert)

- **Capture:** `windows-capture` 2.0 (NiiightmareXD, MIT, 478★, frisch Apr 2026) — WGC + DXGI-DDA-Fallback in **einer** Crate, kein separates `windows-record` nötig. ⚠️ Adapter-Selector fehlt (Issue #191) → für Optimus selbst per `IDXGIFactory6::EnumAdapterByGpuPreference` vorgeschaltet. Eingebauter `MediaTranscoder`-Encoder ignorieren (kein NVENC-Adapter-Wahl, kein AV1).
- **Per-App-Audio:** `wasapi` 0.23 (HEnquist, MIT, v0.23 Apr 2026, 83★) — hat `AudioClient::new_application_loopback_client(pid, include_tree)` direkt im API plus `record_application.rs`-Beispiel (113 LOC) und `processes.rs`-Beispiel (20 LOC) für anti-cheat-sichere App-Enum via `IAudioSessionManager2`. **Korrigiert die alte „~500 Z. selber schreiben"-Annahme** — 80% geschenkt. Risiko: niedriger Bus-Faktor (83★, eventuell selber patchen+upstreamen müssen = ~1-2 PT Puffer).
- **Encode:** `ffmpeg-next` 8.1 (WTFPL Wrapper, 1.9k★, maintenance-only aber stabil) + BtbN `ffmpeg-n8.x-latest-win64-lgpl-shared` DLLs (~50 MB). Encoder per Name (`h264_nvenc`/`h264_amf`/`h264_qsv` + AV1-Varianten). RustDesk-`hwcodec` ist Existenzbeweis dass der Weg trägt. Alternative `rsmpeg` (MIT, 870★, FFmpeg 8) wenn Zero-Copy-GPU-Pipelines wichtiger werden — beide gleichwertig produktionsreif.
- **Mux+Push:** FFmpeg FLV-Mux + RTMPS frei Haus (`format::output("rtmps://…")` → FFmpeg macht TLS via SChannel selbst). ⚠️ **Opus-in-FLV-Patch aus `streaming/patches/` muss auf den BtbN-Build mit drauf** — alternativ Audio in AAC (FFmpegs eingebauter AAC-Encoder ist LGPL-OK).
- **Protokoll:** `serde_json` + Tokio, port von `streaming/gsr-sidecar/control.py` 1:1. Selbe 8 Ops (`health`/`gpu_info`/`list_profiles`/`list_application_audio`/`build_argv`/`start`/`stop`/`state`) + Events (`state`/`fps`/`log`/`error`/`stopped`). `desktop/electron/sidecar.ts` braucht nur Plattform-Branch (PYTHON_BIN + scriptPath → BINARY_PATH).

### Cargo.toml-Skelett

```toml
windows-capture  = "2.0"   # MIT — WGC + DDA
wasapi           = "0.23"  # MIT — Per-App-Audio (Process-Loopback)
ffmpeg-next      = "8.1"   # WTFPL Wrapper, LGPL bundled FFmpeg-DLLs (BtbN)
windows          = "0.62"  # MIT — Adapter-Enum, Process-Loopback-Edge-Cases
sysinfo          = "0.32"  # MIT — PID-Resolver (process_by_name)
serde_json       = "1"     # Sidecar-Plumbing
anyhow           = "1"
tokio            = "1"
```

### Was wir NICHT übernehmen können (Lizenz-Fallen)

| Projekt | Warum |
|---|---|
| **Cap** (CapSoftware) Encoder-Crates (`cap-enc-mediafoundation`, `cap-enc-ffmpeg`, `cap-muxer`, …) | **AGPLv3** — würde Pulse infizieren. Nur `scap-direct3d` ist MIT (alternative Capture-Crate). Architektur lesen OK, Code-Copy nein. |
| **`libobs-rs` / `libobs-wrapper`** | GPL-3.0 Wrapper auf GPL-2.0 libobs — Linking infiziert. Bootstrapper-Pattern (separater Prozess, obs-websocket) bleibt der einzige saubere Weg → das ist Option 2 (OBS-Bootstrapper), nicht Option 3. |
| **`win-capture-audio`** (bozbez) | GPL-2.0 + seit 2022-07-29 tot. Ideen lesen OK, Code-Copy nein. `wasapi`-Crate ersetzt das eh. |
| **`rml_rtmp` + eigenem TLS-Wrap** | Funktioniert, aber 4-8 Wochen für Bugs die FFmpeg gelöst hat (Opus-FLV-Tag, MediaMTX-RTMPS-Auth, Reconnect). Skip. |
| **Direkt-NVENC** (`nvidia-video-codec-sdk` etc.) | Spart 30 MB DLL, kostet AMD+Intel-Support (keine produktionsreifen Rust-Bindings) und RGBA→NV12-CUDA-Kernel-Eigenbau. Schlechter Trade. |

### Aufwand-Matrix

| Stage | Alt (2026-05-18, ohne Recherche) | Neu (2026-05-19, post-Recherche) |
|---|---|---|
| Capture | 2 PT | 1.5 PT (`windows-capture` ergonomisch) |
| Per-App-Audio | 2 PT (selber bauen) | **0.5-1 PT** (`wasapi`-Crate-Glue) |
| Encode (D3D11→NVENC) | 5 PT | 5 PT (Hardware-Frame-Pipeline bleibt Risiko-Ecke) |
| RTMPS/FLV-Mux | 0.5 PT | 0.5 PT + Opus-FLV-Patch-Port (1 PT) |
| stdio-Protokoll-Parität mit `control.py` | 1.5 PT | 1.5 PT |
| Glue/Testing | 2 PT | 2 PT |
| **Total Production** | **~13 PT** | **~11-12 PT** |
| MVP NVIDIA-only Win11 | ~7 PT | ~6 PT |

Bus-Faktor verbessert sich deutlich: 4 von 6 Komponenten auf gewartete Upstream-Crates statt Eigencode.

### Die zwei realen Risiko-Ecken

1. **D3D11-Texture → NVENC ohne CPU-Roundtrip.** `ffmpeg-next` exposed `AV_PIX_FMT_D3D11` aber HW-Frames-Context-Verkabelung erfordert `unsafe`-Sprünge in `ffmpeg-sys-next`. RustDesk-`hwcodec` als Vorbild. Fallback: System-RAM-NV12 (-20-30% Encode-Perf, läuft aber).
2. **Opus-in-FLV.** Pulse's FLV-Whitelist-Patch (`streaming/patches/`) muss auf BtbN-Build mit (entweder selber FFmpeg-LGPL bauen wie's der Flatpak-CI tut, oder Audio→AAC encoden).

### Weitere Edge-Cases die garantiert wehtun werden

| Problem | Häufigkeit | Mitigation |
|---|---|---|
| NVENC-Session-Limit (Consumer-Treiber 2-3 parallel) — User hat OBS/ShadowPlay offen | sehr hoch | klare Error-Message |
| WGC + NVENC auf verschiedenen GPUs (Optimus-Laptops) | hoch | DXGI-Adapter-Enum, beide auf gleichem Adapter |
| Anti-Cheat blockt PID-Enum für Spiele | hoch | App-Audio-Filter geht für Spiel nicht, Desktop-Audio bleibt |
| WASAPI-Sample-Rate-Mismatch (44.1k Games, 48k Browser) | sehr hoch | `swresample` pre-Encoder Pflicht |
| HDR-Display: BGRA10A2/Float16 | mittel | erstes Release: zu SDR tonemappen, FLV/RTMP standardisiert kein HDR |
| Sleep/Lid-Close mid-Stream | hoch | `RegisterPowerSettingNotification` → stop vor Sleep |

### Packaging

CLAUDE.md's `❌ electron-builder` ist **Linux-Kontext-spezifisch** (Flatpak-Manifest bündelt Electron-Binary direkt → Builder redundant). Auf Windows existiert kein Pulse-Packaging → `electron-builder` oder `electron-forge` sind dort die naheliegenden Tools: NSIS/MSI, Squirrel.Windows-Auto-Updates, Code-Signing-Workflow. Würde sich nicht mit `.github/workflows/flatpak.yml` beißen (eigener Workflow). Code-Signing-Cert ab Beta sinnvoll (~150€/Jahr Sectigo).

**Distribution-Pfad für ersten Wurf** (vor electron-builder-Integration): Zip + PowerShell-Bootstrap analog `streaming/bootstrap-gsr.fish`, entpackt nach `%LOCALAPPDATA%\Pulse\hq-sidecar\`. Minimaler Aufwand, gleiche mentale Map wie Linux.

**Lizenz-Modell:** Pulse bleibt closed (kein LICENSE-File), FFmpeg-DLLs werden **getrennt** ausgeliefert (= LGPL-konform: User kann sie austauschen), Source-Mirror der gepinnten FFmpeg-Version irgendwo auf `pulse.unicutmedia.com/legal/`. Binary-Größe: ~50 MB DLL-Overhead — relativ zu Electron (150 MB) egal.

## Linux-Build-vs-Test-Realität

Auf Linux:

- ✅ Cargo-Skelett anlegen, plattform-unabhängige Sidecar-Logik schreiben (stdio-JSON-Protokoll-Parität mit `control.py`), Cross-Compile-Setup via `cross` (Docker) für `x86_64-pc-windows-gnu` einrichten — Cross-Build-Erfolg validiert die Crate-Wahl
- ❌ NVENC/WGC/WASAPI **ausführen** — die APIs existieren auf Linux nicht. Wines WGC-Support ist Stub-only (WGC ist UWP-only), Wines WASAPI-Loopback ist ein Fake-Layer
- ⚠️ Windows-VM ohne GPU-Passthrough läuft Capture+Audio, aber **kein NVENC** — also kein Test der Hauptrisiko-Ecke
- ⚠️ GitHub-Actions Windows-Runner kann bauen aber nicht GPU-testen

Realistisch: echter End-to-End-Test braucht Windows-Hardware oder VM mit GPU-Passthrough.

## Einstiegspunkt für den Spike-Tag

Wenn an einem Windows-Rechner gesessen wird:

1. `streaming/win-hq-sidecar/` anlegen, Cargo-Projekt mit obigem Skelett
2. `streaming/gsr-sidecar/control.py` als 1:1-Spezifikation öffnen — das ist die Ziel-API
3. `desktop/electron/sidecar.ts` lesen — das sind die Bridge-Erwartungen (Request-/Response-Format, Timeouts)
4. Reihenfolge: stdio-Protokoll-Skelett (Tag 1, plattform-unabhängig) → `health`/`list_application_audio` mit `wasapi` (Tag 2) → `windows-capture`-Frames in NVENC pipen (Tag 3-5, Risiko-Ecke) → FLV+RTMPS gegen MediaMTX (Tag 6) → Edge-Cases (Tag 7-10) → Glue+Testing (Tag 11-12)

## Quellen-Stichproben (Recherche-Belege)

- [windows-capture (NiiightmareXD)](https://github.com/NiiightmareXD/windows-capture) — Crate-Doku auf [lib.rs](https://lib.rs/crates/windows-capture)
- [wasapi-rs (HEnquist)](https://github.com/HEnquist/wasapi-rs) — [docs.rs](https://docs.rs/wasapi/latest/wasapi/struct.AudioClient.html), Examples `record_application.rs` + `processes.rs`
- [ffmpeg-next (zmwangx)](https://github.com/zmwangx/rust-ffmpeg) · [rsmpeg (larksuite)](https://github.com/larksuite/rsmpeg)
- [Cap (CapSoftware)](https://github.com/CapSoftware/Cap) + [Lizenz](https://github.com/CapSoftware/Cap/blob/main/LICENSE) (AGPLv3 für Encoder-Crates, MIT nur für `scap-direct3d`)
- [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) · [rustdesk-org/hwcodec](https://github.com/rustdesk-org/hwcodec) (Existenzbeweis NVENC/AMF/QSV via FFmpeg in Rust)
- [Microsoft `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS`](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_activation_params)
- [win-capture-audio (bozbez)](https://github.com/bozbez/win-capture-audio) (GPL-2.0, nur Architektur-Lektüre — `wasapi`-Crate ist die produktive Wahl)
