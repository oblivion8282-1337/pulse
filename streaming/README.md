# streaming/ — HQ-Screen-Streaming für Pulse

Mehrere Plattform-Sidecars, **gleiches stdio-JSON-RPC-Protokoll**. Alle pushen via RTMPS an MediaMTX → Viewer holen
den Stream per WHEP.

| Plattform | Sidecar | liegt in |
|---|---|---|
| **Linux (Standard)** | `pulse-linux-hq-sidecar` (Rust, PipeWire + VAAPI/NVENC) | `linux-hq-sidecar/` (Rust) — seit 2026-07-29 im Baum, Flatpak baut ihn per `type: dir` |
| **Linux (Fallback)** | GPU Screen Recorder | `gsr-sidecar/` (Python) |
| Windows | WGC + WASAPI + ffmpeg-next | `win-hq-sidecar/` (Rust) |
| macOS | ScreenCaptureKit + VideoToolbox | `mac-hq-sidecar/` (Rust) |

Auf Linux wählt `desktop/electron/sidecar.ts::resolveLinuxSpawn()`: Rust zuerst, bei fehlendem Binary **automatisch**
GSR. Der Kompatibilitäts-Tab zeigt, welcher Weg läuft, und erlaubt das erzwungene Zurückschalten
(`useLegacyGsrSidecar`). Bis 2026-07-17 war es umgekehrt — Rust war ein Opt-in-Experiment.

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
│   ├── ffmpeg-dist/         FFmpeg LGPL n8.1.2-shared, selbst gebaut + gepatcht
│   ├── mediamtx-dist/       MediaMTX-Binary für lokale Smoke-Tests
│   └── examples/            cargo-runnable Smoke-Driver
├── linux-hq-sidecar/        Linux: Rust-Sidecar (PipeWire + VAAPI/NVENC), der Standard
├── mac-hq-sidecar/          macOS: Rust-Sidecar (ScreenCaptureKit + VideoToolbox)
├── pulse-player/            nativer HQ-Player — der einzige Weg für AV1 10 bit
├── hq-labor/                Messstand Linux — NICHT ausgeliefert (s.u.)
├── win-hq-labor/            Messstand Windows — NICHT ausgeliefert (s.u.)
├── testbench/               Messwerkzeuge + `profiles/` = die Messakten
├── ffmpeg-bau/              baut das gepinnte FFmpeg fuer Linux-Sidecar + Player
├── patches/                 GSR-C++-Patches (FLV-Opus, Vulkan-Stub) — verbatim
├── server/                  MediaMTX-Setup (Template + docker-compose + Player)
├── bootstrap-gsr.fish       Custom-GSR-Build mit Patches (für T6 Flatpak)
├── pyproject.toml           uv-Workspace-Member "gsr-sidecar" (package=false)
└── README.md                hier
```

## Die zwei Messstände — was sie sind und was sie nicht sind

`hq-labor/` (Linux) und `win-hq-labor/` (Windows) sind **Messstände, keine
Produktteile.** Sie binden den jeweils ausgelieferten Sidecar als Bibliothek ein
und ergänzen, was zum Messen nötig ist: einen eigenen WebRTC-Sender, einen
eigenen Zuschauer, der wirklich dekodiert und zählt, Verlust-Erzeugung,
Ton-Auswertung, Vergleichsarme für verworfene Wege.

**Keine CI baut sie.** `win-build.yml` ist auf `streaming/win-hq-sidecar/**`
begrenzt und baut ausschließlich `pulse-win-hq-sidecar`; für den Linux-Messstand
gilt dasselbe. Ein eigener Crate-Name (`pulse-win-hq-labor`) hält die
Unterscheidung auch dort auf, wo jemand von Hand baut.

**Warum sie trotzdem im Repo liegen:** ohne sie ist eine Nachmessung ein Neubau.
Der Windows-Messstand misst an der GEGENSTELLE, nicht an einer Bildzahl aus dem
Sender — und nur so lässt sich belegen, was beim Zuschauer wirklich ankommt. Er
lag bis 2026-08-04 nur auf einem lokalen Zweig; das war ein Versehen, kein
Entwurf.

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
| `health` | — | `gsr: {available, source, path?, version?, vendor?, is_flatpak, video_codecs?, has_flv_patch?, ten_bit?, hdr?, ...}` — `ten_bit` melden Linux- und Windows-Sidecar, `hdr` **nur Windows**; macOS und der Python-Auffang melden keines davon. **`undefined` heißt „nein"**, nie „unbekannt, probier's mal" |
| `gpu_info` | — | `vendor, card_path, display_server, video_codecs` (re-probe falls noch nicht da) |
| `list_profiles` | — | `profiles, servers (immer `[]`), audio_modes, app_label_prefix` — **nur noch GSR-Sidecar** (Linux-Auffangnetz). Die Rust-Sidecars haben die Op 2026-07-19 verloren: der Katalog hatte nie einen Konsumenten (das HQ-Panel setzt hart `profile_name='Custom'` + `use_overrides=true`) und alle vier Einträge trugen dieselben 4000 kbps / 60 fps. Nicht gesetzte Overrides fallen dort jetzt auf einen einzelnen Sockel (`profiles::BASELINE`, h264/opus/flv, 4000 kbps, 60 fps) zurück — dieselben Werte wie der frühere `Custom`-Eintrag. |
| `list_monitors` | — | `monitors: [{index (1-basiert), name, primary, width, height, refresh_hz, x, y}, ...]` — **Windows- und mac-Sidecar** (Linux nutzt den Portal-Picker und gibt eine leere Liste zurück). `x`/`y` seit 2026-08-24: die Lage des Bildschirms im Desktop-Raum, negativ erlaubt (Monitor links vom Hauptbildschirm). Windows über `GetMonitorInfoW`, macOS über `CGDisplayBounds`; schlägt die Abfrage fehl, wird `0/0` gemeldet **statt das Feld wegzulassen** — ein fehlendes Feld liesse die Bildschirm-Karte raten, `0/0` ist erkennbar falsch. Ältere Sidecars melden die Felder gar nicht; die Karte fällt dann auf die Knopfliste zurück. |
| `list_windows` | — | `windows: [{id (HWND-Zahl), title, app, width, height}, ...]` — **nur Windows-Sidecar**: Quelle für den In-App-Fenster-Picker (Linux nutzt den Portal-Dialog) |
| `list_application_audio` | — | `applications: [name, ...]` (Apps mit Audio-Output) |
| `build_argv` | siehe `start` | `binary, argv` — **baut die Argumentliste ohne GSR zu starten** (Test/Debug) |
| `start` | `profile, channel: {id, token, push_url?, mediamtx_endpoint?, push_protocol?}, capture, audio: {mode, excluded_apps}, overrides? {codec, bitrate_kbps, fps, resolution, bit_depth, hdr}` | `argv` (die gleiche Liste) — danach kommen Events |
| `stop` | — | `ok` |
| `state` | — | `running, state, fps, uptime_s, argv` |
| `keyframe` | — | `ok` — beim nächsten Bild ein Vollbild erzeugen. **Nur Linux- und Windows-Sidecar.** Ohne laufenden Stream folgenlos; mehrere Anforderungen innerhalb eines Bildabstands fallen zu einer zusammen (bei mehreren Zuschauern zahlt der Sender ein Intra-Bild einmal für alle). Der reguläre Weg ist der RTCP-Rückkanal des eigenen WHIP-Sendewegs — diese Operation ist die Gegenstelle von Hand, damit die Wirkung messbar ist, ohne dass ein echter Zuschauer und ein Verlustprofil zusammenkommen müssen. |

**Bis zum 2026-08-21 gab es hier ein `overrides.intra_refresh`** — rollender
Intra-Refresh statt periodischer Vollbilder, samt Fähigkeitsmeldung
`health.gsr.intra_refresh` und einer Startverweigerung, wenn der Encoder die
Betriebsart nicht lieferte. Beides ist entfallen; wer eines der Felder noch
mitschickt, wird ignoriert.

Der Vollbild-Abstand steht auf 60 s (`PULSE_KEYFRAME_SECONDS`). Der Rückkanal
(`keyframe` bzw. RTCP) ist damit **Voraussetzung, nicht Zubehör**: ohne ihn
wartet ein beitretender Zuschauer bis zu eine Minute auf sein erstes Bild.

**Der Zuschauer erfährt die Bittiefe über die WHEP-Antwort** (`ten_bit`), nicht
über `stream:events`: sie reist als `ten_bit` im Token-Record mit
(`POST /channels/{id}/stream-token`), der auth-hook kopiert sie beim
Publish-Auth in `stream:active`, und `GET /channels/{id}/whep` gibt sie
zurück — genau dieselbe Schiene wie `label`. Grund für den Umweg: nur der
native Player kann mehr als 8 bit ausgeben, und die Kachel muss sich für einen
Wiedergabeweg entscheiden, BEVOR sie dekodiert. Fehlt das Feld (älterer Server
oder Streamer), gilt 8 bit und die Kachel bleibt im `<video>`.

`overrides.bit_depth` (8|10) und `health.gsr.ten_bit` sind **Zusatzfelder des
Linux-Rust-Sidecars** (seit 2026-07-26). Python-, Windows- und macOS-Sidecar
melden `ten_bit` nicht und ignorieren `bit_depth` stillschweigend — Konsumenten
müssen `undefined` als „kann kein 10 bit" lesen, nie als „unbekannt, probier's".
10 bit ist dort an **AV1** gebunden: die 10-bit-Variante von H.264 wäre
`High 10`, die kein Browser dekodiert, und der WHEP-Rückfall im Web ist ein
`<video>`. Ein unerfüllbarer Wunsch (kein AV1, WHIP-Ziel, VAAPI-Karte) fällt im
Sidecar mit Log-Zeile auf 8 bit zurück statt den Start zu verweigern; das
Frontend schickt ihn deshalb nur, wenn er erfüllbar ist
(`settings.svelte.ts::tenBitPossible`).

`start`/`build_argv` brauchen den Channel-Block — Pulse streamt immer in einen
Voice-Channel:

- `channel: {id, token, push_url?, mediamtx_endpoint?, push_protocol?}` — Pulse-
  Channel-Pfad (`ServerProfile.from_channel()`). `push_url` (von media-svc, mit
  Token drin) wird wenn gesetzt verbatim an GSR `-o` gereicht; sonst werden
  `mediamtx_endpoint` + `push_protocol` als Fallback genutzt.
- **Push-Protokoll entscheidet der SERVER** (media-svc
  `MEDIAMTX_PUSH_PROTOCOL`): Default `rtmp` → `rtmps://<host>:1936/...`-URL.
  App-gehostete Instanzen minten für Gäste `whip` →
  `https://<host>/whep/<pfad>/whip?token=…` (WebRTC-Ingest, locht NAT wie
  WHEP; Owner bleibt RTMPS). **Alle drei Rust-Sidecars (Linux, Windows, seit
  2026-08-20 auch macOS) fahren `http(s)://` über einen EIGENEN
  WebRTC-Sendeweg** (`src/whip/mod.rs`+`pacer.rs` plattformeigen; der
  AV1/SDP-Teil liegt seit 2026-08-20 gemeinsam in `streaming/pulse-whip`,
  webrtc-rs) statt über ffmpegs Muxer — AV1 geht dort direkt, ein
  H.264-Rückfall entfällt. Eine `TrackLocalStaticRTP` trägt beide Codecs: AV1
  zerlegt ein eigener Paketierer (webrtc-rs' `Av1Payloader` schreibt
  Längenfelder ab 128 falsch), H.264 webrtc-rs' `H264Payloader` — **beide
  stempeln seit 2026-08-14 selbst aus dem Encoder-`pts`** (bis dahin lief
  H.264 als Sample-Spur mit aus fester Bilddauer hochgezählter Zeit, was bei
  jedem ausgelassenen Bild die Video-Uhr verschob). Der Python-GSR-Sidecar
  kann kein WHIP. Plan: `docs/plans/2026-07-12-whip-guest-publish.md`.
  - **Die AV1-Sperre liegt an ffmpegs Muxer, nicht an WHIP** (nachgeprüft
    2026-07-28, damit es niemand aus dem Satz oben falsch schließt): `whip.c`
    trägt `.p.video_codec = AV_CODEC_ID_H264` und genau einen Payload-Typ (106),
    in 8.1 **und** im aktuellen master — es lohnt also nicht, auf ein Update zu
    warten. Ein konkurrierender Muxer mit AV1/HEVC/VP9 (nativewaves, auf Basis
    von libdatachannel) liegt seit November 2023 unangenommen im Patchsystem.
    WHIP selbst trägt AV1 problemlos; unser Player empfängt es über WHEP in
    10 bit, und mit `webrtc-rs` liegt im Baum bereits ein vollständiger
    WebRTC-Baukasten — ein eigener Sendeweg wäre also kein Codec-Verzicht,
    sondern nur Arbeit.

`capture`: Linux `"portal"`/`"monitor"`/`"window"` (Portal-Dialog wählt die
Quelle). Windows-Sidecar zusätzlich `"Monitor: <index>"` (Index aus
`list_monitors`), `"window:<hwnd>"` (HWND-Zahl aus `list_windows` — der
reguläre Fenster-Picker-Token) und `"Window: <title>"` (Titel-Substring als
Komfort-Fallback); `"portal"` → Primärmonitor.

### Events (`{"ev": "..."}`)

- `state` — `state ∈ {"idle","starting","live","error","stopped"}`, `running`, `uptime_s`
- `fps` — `fps`, `uptime_s` (kommt sobald GSR "update fps: N" auf stderr meldet → impliziert "live")
- `log` — `line` (eine Roh-Zeile GSR-stderr; gemerged inklusive stdout)
- `notice` — `line`, `code` — bedeutsame, aber nicht-fehlerhafte Mitteilung; gehört
  vor den Nutzer (das Web zeigt sie als Toast) und zusätzlich ins Log-Fenster. Bisher
  nur der Linux-Rust-Sidecar, bisher ein Code: `fps_begrenzt` (10-bit-Bildrate am
  Start begrenzt, weil die verhandelte Quellgröße die Last-Grenze
  `linux-hq-sidecar/src/lastgrenze.rs` überstieg). Verbraucher müssen das Event
  tolerieren (unbekannte `code`s ignorieren).
- `error` — `message`
- `stopped` — kommt direkt nach dem letzten `state=stopped`-Event

**Fernsteuerung** (nur Windows- und macOS-Sidecar; der Renderer reicht sie als
`remote_signal` an den Steuernden weiter). Hier stand bis zum 2026-08-23 keines
davon — die Ereignisse waren nur in den READMEs der einzelnen Sidecars
beschrieben, und wer diese Liste für vollständig hielt, übersah sie:

- `remote_state` — `state ∈ {"host_active","live","input_error"}`, dazu
  `hold_ms` bzw. `reason`. `host_active` heißt: der Host hat sich selbst an Maus
  oder Tastatur geregt, die Fremdeingabe wird für `hold_ms` verworfen.
- `remote_pointer` — `shape`, optional `bild`. Die Form des Host-Zeigers, damit
  der Steuernde seinen eigenen, verzögerungsfreien Zeiger richtig zeichnet.
  **Auf macOS ist `shape` immer `default`** und die Information steckt im Bild:
  die Plattform hat keine Namenszuordnung, weil `+[NSCursor arrowCursor]` und
  `IBeamCursor` selbst `nil` liefern.
- `remote_pointer_in_frame` — `aktiv` (bool). **Nur macOS, seit 2026-08-23.**
  Der Rückfall: die Zeigerabfrage gab nichts her, der Host-Zeiger wurde zurück
  ins Videobild geschaltet und reitet dort mit — der Steuernde muss seinen
  eigenen ausblenden, sonst sieht er zwei. `aktiv:false` = zurück zum
  Regelfall. Warum es das gibt: `NSCursor.currentSystemCursor` ist abgekündigt,
  der SDK-Kopf sagt wörtlich, sie werde künftig immer `nil` liefern — der
  Rückfall lässt die Funktion **altern statt ausfallen**. Wird beim
  Sitzungsende **nicht** geschickt (die Sitzung ist dann vorbei, der Rahmen
  käme nur durch Zufall an); der Empfänger setzt stattdessen selbst zurück.

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
identisch). Stack: `windows-capture` v2 (WGC; gepatchter Zweig unter
`win-hq-sidecar/vendor/`, s. dortiges README — Cursor-Echo der Fernsteuerung),
`wasapi` (Desktop-Loopback +
Mikrofon), `ffmpeg-next` 8.1 gegen das **unveränderte** LGPL-shared-Fertigpaket
unter `ffmpeg-dist/n8.1-lgpl-shared/` (BtbN-Bau, eingefroren und selbst
gespiegelt — geholt von `win-hq-sidecar/scripts/fetch-ffmpeg.ps1`). Vom
2026-08-05 bis zum 2026-08-21 lag dort ein selbst gebauter, gepatchter Baum;
der Patch trug die Intra-Refresh-Betriebsart, die es nicht mehr gibt.
`build.rs` kopiert die FFmpeg-DLLs neben die exe — Binary ist standalone, kein
Python nötig.

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
# Smoke (kein realer Stream — nur health/gpu_info/state):
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

## Etappe T3 — erledigt, und anders als hier geplant

**Dieser Abschnitt beschrieb bis 2026-08-04 Tauri als nächsten Schritt. Das ist
seit dem 2026-05-12 überholt**: der Desktop-Wrapper ist **Electron** geworden,
weil WebKitGTKs WebRTC unter Tauri unzuverlässig war (`PLAN.md` §17; Tauri steht
in `CLAUDE.md` inzwischen unter den Anti-Patterns). Der Absatz blieb stehen,
während dieselbe Datei weiter unten längst die reale Electron-Anbindung
beschreibt.

Wie es wirklich gebaut ist:

- **Electron-Main** spawnt den Sidecar lazy beim ersten `gsr:call` und reicht
  stdout-Ereignisse an den Renderer durch (`desktop/electron/sidecar.ts`).
- **Svelte** bedient das Protokoll oben über `window.pulse.gsr.*`
  (`web/src/lib/stream/`).
- **Persistenz** liegt in einem hand-gebauten KV-Store
  (`desktop/electron/store.ts`), nicht in einem Tauri-`store` — `electron-store`
  ist ESM-only und passte nicht zum CJS-Build.
