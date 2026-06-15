# Plan: macOS-Client für Pulse mit ScreenCaptureKit-Sidecar

Status: **Phase 0 umgesetzt + verifiziert; lauffähiger Client (dmg/.app) gebaut + gestartet;
Phase 1 (Sidecar) als Gerüst kompiliert** (2026-06-15). Offen: realer SCK/VideoToolbox-Stream.
Verwandt: `WINDOWS_HQ_SIDECAR.md`, `docs/plans/2026-05-31-windows-auto-update.md`,
`streaming/win-hq-sidecar/README.md`, `streaming/mac-hq-sidecar/README.md`, `streaming/README.md`.

## Umgesetzt am 2026-06-15

**Phase 0 (verifiziert: `pnpm check` 0/0, `pnpm build` grün, `tsc -p desktop` exit 0, esbuild grün):**
- `isMac()` in `web/src/lib/platform/runtime.ts` (Form wie `isWindows()`).
- HQ-Gating an 3 Stellen auf `isLinux() || isWindows() || isMac()` erweitert
  (`HqStreamButton.svelte`, `ScreenShareModeButton.svelte`, `ShortcutHost.svelte`).
  Safe: `gsrAvailable` bleibt false, solange kein Mac-Sidecar `health` mit
  `available:true` beantwortet → Button bleibt verborgen.
- `desktop/electron/sidecar.ts`: `darwin`-Zweig + `resolveMacBinaryPath()`
  (Override → resourcesPath → Walk-up → `~/Library/Application Support/Pulse/hq-sidecar/`).
- `desktop/electron/updater.ts`: macOS bewusst noch nicht freigeschaltet (Stufe B), dokumentiert.
- `desktop/electron-builder.yml`: `mac:`-Target (dmg+zip), `build-resources/icon.icns`
  (aus `electron/icon.png` via `iconutil` erzeugt), TCC-Usage-Strings (`extendInfo`),
  Windows-Sidecar nach `win.extraResources` verschoben (leakt nicht in den Mac-Build).
- `desktop/package.json`: `dist:mac`-Script.

**Lauffähiger Client gebaut (Stufe A, unsigniert):** `pnpm run dist:mac`
(`CSC_IDENTITY_AUTO_DISCOVERY=false`) erzeugt `desktop/release/Pulse-0.1.5-arm64.dmg`
+ `…-mac.zip` + `release/mac-arm64/Pulse.app`. Getestet: App startet, lädt
`https://howispulse.com` remote und rendert den Login („Bleib im Takt."). Chat +
Voice sind damit auf macOS nutzbar; HQ-Button verborgen (kein Sidecar gebündelt).
Gatekeeper: Erststart per Rechtsklick→Öffnen bzw. `xattr -dr com.apple.quarantine`.

**Phase 1 (Gerüst — kompiliert + Protokoll verifiziert):**
- `streaming/mac-hq-sidecar/` als Rust-Crate angelegt: Protokoll/Dispatch/Events/Profiles
  + `build_argv` faithful aus `win-hq-sidecar` portiert; `health`/`gpu_info`/`list_profiles`
  antworten; `list_monitors`/`list_application_audio` kompilierbare Stubs; `start` gibt
  klaren „noch nicht implementiert"-Fehler. Capture (ScreenCaptureKit) + Encode
  (VideoToolbox) sind im Crate-README spezifiziert, aber noch nicht geschrieben.
- Mit Rust 1.96 gebaut (`cargo build --release`, arm64 Mach-O); stdio-Smoke-Test
  läuft alle Ops durch (inkl. Token-Redaction in `build_argv`). Bewusst NICHT in
  den Client gebündelt, solange `start` stubt (sonst sichtbar-aber-kaputter Button).
- Plattform-Unterschied eingebaut: Mac-Sidecar beendet sich NICHT nach `stop`
  (bleibt warm; `sidecar.ts`-Respawn ist win32-only).

**Noch offen:** SCK/VideoToolbox-Capture+Encode, FFmpeg-arm64-LGPL-Build, CI-Workflow
`mac-build.yml`, Signing/Notarization (Stufe B → Auto-Update + breite Distribution),
nginx `/updates/mac/`. Reihenfolge s. Phasen-Roadmap unten.

## Entscheidungen (Stand 2026-06-15)

- **Sidecar-Sprache: Rust** — maximaler Reuse des Windows-Sidecars.
- **Signing/Notarization: noch offen** → Plan beschreibt einen unsignierten Dev-Pfad;
  Signing ist ein klar markiertes Gate, das Distribution + Auto-Update erst freischaltet.
- **Minimum-macOS: 13.0** (Ventura) — ScreenCaptureKit ab 12.3, aber System-Audio-Capture
  via SCK erst ab 13.0. Default, bis jemand 12.x explizit braucht.
- **Architektur: arm64-only zuerst** (Apple Silicon), Universal später optional.

## 1. Ausgangslage (im Code verifiziert)

Der Code ist multi-plattform-vorbereitet; macOS ist überall der fehlende dritte Fall:

- `desktop/electron/sidecar.ts:84` — `resolveSidecarSpawn()` wirft für alles außer
  Linux/Windows ("no implementation for ${process.platform}").
- `desktop/electron/updater.ts:24` — Auto-Update hart auf `win32` gegated.
- Frontend-Stream-Gating an 3 Stellen, jeweils `isElectron() && (isLinux() || isWindows()) && stream.gsrAvailable`:
  - `web/src/lib/stream/components/HqStreamButton.svelte:44`
  - `web/src/lib/components/ScreenShareModeButton.svelte:48`
  - `web/src/lib/components/ShortcutHost.svelte:89`
- `web/src/lib/platform/runtime.ts` — hat `isLinux()`/`isWindows()`, **kein `isMac()`** (TODO bei Z. 52).
- `desktop/electron-builder.yml` — nur `win:`-Target + generic-Feed `…/updates/win/`.

Bereits korrekt (nicht anfassen): Electron-Main behandelt `darwin` für Close-to-Tray und
Cmd-Modifier; `store.ts`-Linux-`chmod`-Hardening ist auf macOS no-op; `window.pulse.gsr.*`-Bridge
ist plattform-agnostisch.

**Kernprinzip bleibt:** Electron lädt die Web-Oberfläche **remote** von `howispulse.com`.
Der Mac-Build packt nur Electron-Runtime + esbuild-Bundle + nativen Sidecar — Web-Änderungen
brauchen keinen Mac-Rebuild (wie Flatpak/Windows).

## 2. Sidecar-Architektur (Rust)

### 2.1 Reuse aus `streaming/win-hq-sidecar/`

Neues Crate `streaming/mac-hq-sidecar/`. Der Windows-Sidecar trennt bereits plattform-agnostische
von plattform-spezifischen Schichten:

- **1:1 wiederverwendbar:** `proto.rs` (Wire-Typen), `dispatch.rs` (Op-Routing), `events.rs`
  (Event-Emitter), `main.rs` (stdio-Loop), `encode/mux_writer.rs` (async FLV-Mux), die gesamte
  **RTMPS-Push-Pipeline** (FFmpeg FLV + Opus-in-FLV-Patch + self-signed-TLS `tls_verify=0`),
  `ops/{list_profiles,build_argv,state,stop}.rs`, `encode/audio.rs` (libopus).
- **Neu (3 Module):** `capture/sck.rs`, `encode/videotoolbox.rs`, `system/metal.rs`.
- **Entfällt ggü. Windows:** GPU-Vendor-Verzweigung (Apple-GPU = ein Pfad); die gesamte
  WASAPI-Per-App-Loopback-Komplexität (SCK liefert System-Audio direkt, macOS 13+).

ObjC-Interop via `objc2`-Familie (`objc2-screen-capture-kit`, `objc2-video-toolbox`,
`objc2-core-media`, `objc2-core-video`). FFmpeg wie unter Windows über `ffmpeg-next` gegen
vendored LGPL-Builds (für macOS arm64; BtbN liefert kein macOS → ggf. eigener LGPL-Build oder
Homebrew-ffmpeg als Build-Referenz, Dylibs neben die Binary kopieren analog `win-hq-sidecar/build.rs`).

### 2.2 Datenfluss

```
ScreenCaptureKit (SCStream, async callbacks)
  ├─ Video: CMSampleBuffer -> CVPixelBuffer (BGRA/NV12, IOSurface-backed)
  └─ Audio: System-Audio direkt aus SCK (CMSampleBuffer, 48 kHz)   [macOS 13+]
        + optional Mikrofon via AVCaptureSession -> gemischt
        v
VideoToolbox VTCompressionSession (h264_videotoolbox / hevc_videotoolbox; AV1 nur M3+)
  CVPixelBuffer rein (IOSurface zero-copy) -> CMSampleBuffer raus
        v
Audio: libopus (FFmpeg, identisch zu Windows) -- 20ms Frames, A/V-Offset-Trim
        v
MuxWriter-Thread (FFmpeg FLV, interleaved A/V) -- Reuse 1:1 von win-hq-sidecar
        v
RTMPS -> rtmps://howispulse.com:1936/channel-<cid>-<uid>-<nonce>?...token...
  (FFmpeg native TLS, tls_verify=0 fuer self-signed MediaMTX-Cert -- Reuse 1:1)
```

Vorteile gegenüber Windows: `list_monitors` nativ über `SCShareableContent` (ab macOS 14 zusätzlich
`SCContentSharingPicker`); kein Vendor-Branch (`health.gsr.vendor="apple"`, `source="builtin"`);
System-Audio nativ in SCK.

### 2.3 Protokoll-Parität (Pflicht)

stdio-JSON-RPC exakt wie bestehend (newline-delimited, `id`-Korrelation), damit `SidecarManager`
ihn ohne Sonderbehandlung treibt:

- Ops: `health`, `gpu_info`, `list_profiles`, `list_monitors`, `list_application_audio`,
  `build_argv`, `start`, `stop`, `state`.
- Events: `state`, `fps`, `log`, `error`, `stopped`.
- `health` muss `gsr.available` setzen (Start-Gate) + `source/vendor/video_codecs/capture_options`.
- Token-Redaction in jeder `argv`-Antwort (CLAUDE.md: nie Stream-Keys ins JSON zum Renderer).

## 3. Touch-Points im bestehenden Code

### Electron-Main (`desktop/electron/`)
1. `sidecar.ts` — `resolveSidecarSpawn()` (Z. 76–88): `darwin`-Zweig, der `pulse-mac-hq-sidecar`
   auflöst (analog Windows `resolveBinaryPath()`: `$PULSE_HQ_SIDECAR`-Override →
   `process.resourcesPath/hq-sidecar/` → Walk-up `streaming/mac-hq-sidecar/target/{release,debug}/`).
   Kommentar Z. 60 entfernen.
2. `sidecar.ts:305` — Respawn-after-`stop` ggf. auf `darwin` ausweiten, falls VTCompressionSession
   den gleichen Re-Start-Bug wie WGC zeigt (erst empirisch prüfen, nicht spekulativ).
3. `updater.ts:24` — Gate auf `!== 'win32' && !== 'darwin'`. **Nur wirksam mit Signing** (s. §5).

### Frontend (`web/src/lib/`)
4. `platform/runtime.ts` — `isMac()` (gleiche Form wie `isWindows()`).
5. 3 Gating-Stellen auf `(isLinux() || isWindows() || isMac())`. **Empfehlung:** Helper
   `hqStreamSupported()` statt den Ausdruck dreimal zu pflegen.
6. `stream/settings.svelte.ts` — `isWindows()`-Zweige für `listMonitors()` (~Z. 292/309) und
   `av_offset_ms` (~Z. 417) auf `isWindows() || isMac()` erweitern, sobald der Sidecar die
   Capabilities meldet.
7. `components/AppDownloadLinks.svelte` (niedrige Prio) — macOS-DMG-Link (nur Browser-Login).

### Build & Distribution
8. `desktop/electron-builder.yml` — `mac:`-Target (`dmg`+`zip`), `icon: build-resources/icon.icns`,
   `category: public.app-category.social-networking`. Mit Signing zusätzlich `hardenedRuntime: true`
   + Entitlements + Notarize. `extraResources` um Mac-Sidecar erweitern (eigener `from`-Pfad).
9. `desktop/package.json:13` — `dist:mac` analog `dist:win`.
10. `.github/workflows/mac-build.yml` (neu) — `macos-latest`-Runner: Rust-Sidecar bauen, FFmpeg-
    Dylibs vendoren, electron-builder `--mac`. Mit Signing: Codesign + `notarytool` + Stapling,
    danach scp `latest-mac.yml`/`.zip`/`.dmg` nach `howispulse.com/updates/mac/`.

### Infra
11. `infra/prod/web-nginx.conf` — `location ^~ /updates/mac/` (analog `/updates/win/`).
12. docker-compose/Caddy — Bind-Mount fürs Mac-Update-Verzeichnis.

## 4. macOS-Stolpersteine

- **TCC / Screen-Recording-Permission:** SCK triggert beim ersten `start` den System-Dialog. Ohne
  Berechtigung liefert SCK **schwarze Frames statt Fehler** — Sidecar muss `CGPreflightScreenCaptureAccess`
  / SCK-Fehlercode prüfen und als `error`-Event melden. Frontend braucht einen Hinweis-Zustand
  ("Bildschirmaufnahme in Systemeinstellungen erlauben"). Permission ist an die Signatur gebunden →
  **unsignierte Dev-Builds verlieren sie bei jedem Rebuild**.
- **`hardenedRuntime` + Electron** (nur mit Signing): Entitlements `com.apple.security.cs.allow-jit`,
  `…allow-unsigned-executable-memory`, `…device.audio-input` + Info.plist
  `NSScreenCaptureUsageDescription`/`NSMicrophoneUsageDescription`.
- **Sidecar mitsignieren/notarisieren** (separate Binary neben asar), sonst Gatekeeper-Block beim Spawn.
- **AV1-Encode** nur Apple Silicon M3+; sonst h264/hevc. `list_profiles` muss capability-abhängig
  filtern (`needs_custom_build` existiert im Schema).
- **FFmpeg-Dylibs für macOS arm64** selbst bereitstellen (kein BtbN). LGPL-Compliance wie Windows.

## 5. Signing-Gate: zwei Distributionsstufen

Da Signing offen ist, zerfällt der Plan in zwei Stufen:

### Stufe A — unsigniert (sofort, Dev / Self-Use Apple Silicon)
- `dist:mac` erzeugt unsignierten DMG/.app.
- Installation: Nutzer muss Gatekeeper umgehen (Rechtsklick → Öffnen, bzw.
  `xattr -dr com.apple.quarantine /Applications/Pulse.app`).
- **Kein Auto-Update** (electron-updater verlangt auf macOS gültige Signatur — anders als Windows,
  das nur SHA512 prüft). Updater-Gate `darwin` bleibt deaktiviert.
- Screen-Recording-Permission funktioniert, geht aber bei jedem Rebuild verloren.
- Tauglich für Entwicklung + technische Tester, **nicht** für breite Distribution.

### Stufe B — signiert + notarisiert (Distribution, braucht Apple Developer Program)
- Schaltet frei: sauberer Gatekeeper-Erststart, stabile TCC-Permission über Updates hinweg,
  macOS-Auto-Update via electron-updater (`latest-mac.yml` + `.zip`).
- Erfordert: Apple-Account ($99/Jahr), Developer-ID-Zertifikat in CI (als Secret),
  `notarytool`-Credentials, Stapling im CI-Step.
- Erst dann: Updater-Gate (`updater.ts:24`) auf `darwin` aktivieren + Feed/nginx scharf schalten.

## 6. Phasen-Roadmap

0. **Shell ohne Streaming:** `mac:`-Target, `dist:mac`, `isMac()`-Helper. Liefert installierbaren
   Mac-Client mit Chat + Voice (LiveKit-WebRTC läuft in Chromium). HQ-Button bleibt versteckt.
   Stufe A (unsigniert) reicht. Auto-Update aus.
1. **Sidecar-Gerüst:** Crate `streaming/mac-hq-sidecar/` mit Reuse der Protokoll/Event/Mux-Schichten;
   `health`/`gpu_info`/`list_profiles`/`list_monitors` über SCK `SCShareableContent`.
   `gsr.available=true`, noch kein echter Stream. Resolver-Zweig + Frontend-Gating frei.
2. **Capture + Encode:** `capture/sck.rs` -> `encode/videotoolbox.rs` -> MuxWriter -> RTMPS.
   Erst Display-, dann Window-Capture.
3. **Audio:** SCK-System-Audio + optional Mikrofon, A/V-Sync (CMTime statt QPC, gleiches Offset-Modell).
4. **Polish:** TCC-Permission-UX, Multi-Monitor, `av_offset_ms`-Slider, manueller 2-Client-E2E-Test.
5. **Signing/Auto-Update (Stufe B):** sobald Apple-Account vorhanden — Notarization-Pipeline,
   `updater.ts`-Gate + Feed/nginx aktivieren.

## 7. Offene Punkte

- Apple Developer Program: ja/nein/wann? (blockt Stufe B + Auto-Update + breite Distribution)
- FFmpeg-LGPL-Build für macOS arm64: eigener Build oder gepinnte Bezugsquelle.
- VTCompressionSession Re-Start-Verhalten: Respawn-nach-`stop` nötig (wie Windows) oder nicht?
- Universal-Binary (x86_64) überhaupt nötig? (Intel-Macs ohne SCK-HW-Vorteil)
