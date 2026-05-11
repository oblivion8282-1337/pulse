# streaming/ — GSR-Streaming-Paket für Pulse (T2)

Vendored aus `~/Dokumente/GPU_Screen_Recorder/` (2026-05-11). Das
**Original-Repo bleibt unangetastet** — es ist das bewährte Standalone-
GSR-Setup mit Qt-UI und eigenem Flatpak; hier liegt nur die für Pulse
gebrauchte Teilmenge plus ein stdio-Sidecar statt der Qt-UI.

## Layout

```
streaming/
├── gsr-sidecar/             pure-stdlib Python-Sidecar
│   ├── profiles.py          Stream-/ServerProfile (+ ServerProfile.from_channel)
│   ├── stream_controller.py subprocess.Popen-Wrapper für GSR (statt QProcess)
│   ├── config.py            Settings-Dataclasses (JSON-I/O nicht aktiv genutzt)
│   ├── gsr_binary.py        Binary-Resolver + --info-/--list-monitors-Parser
│   ├── control.py           stdio-Loop, JSON-RPC-Protokoll
│   └── __init__.py
├── patches/                 GSR-C++-Patches (FLV-Opus, Vulkan-Stub) — verbatim
├── server/                  MediaMTX-Setup (Template + docker-compose + Player)
├── scripts/                 manuelle Test-Skripte (start-stream*.fish) — Referenz
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
| `list_monitors` | — | `monitors: [{name, resolution}, ...]` |
| `list_profiles` | — | `profiles, servers, audio_modes, app_label_prefix` |
| `list_application_audio` | — | `applications: [name, ...]` (Apps mit Audio-Output) |
| `build_argv` | siehe `start` | `binary, argv` — **baut die Argumentliste ohne GSR zu starten** (Test/Debug) |
| `start` | `profile, server?\|channel?\|custom_server?, capture, audio: {mode, excluded_apps}, overrides? {codec, bitrate_kbps, fps, resolution}, stream_key?` | `argv` (die gleiche Liste) — danach kommen Events |
| `stop` | — | `ok` |
| `state` | — | `running, state, fps, uptime_s, argv` |

`start`/`build_argv` akzeptieren genau einen von drei Server-Pfaden:

1. `server: "<name>"` — benannter Eintrag aus `list_profiles().servers`.
2. `channel: {id, token, mediamtx_endpoint?, push_protocol?}` — Pulse-Channel-Pfad
   (`ServerProfile.from_channel()`).
3. `custom_server: {name, push_protocol, push_host, push_port, push_path?, needs_auth?, auth_user?}`
   — Inline-Spec für nutzer-definierte Server (T3c). Wird im Sidecar zu einem
   transienten `ServerProfile` gewrappt; `stream_key` separat im Top-Level.

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
 "server": "Hetzner",
 "capture": "portal",
 "audio": {"mode": "Desktop", "excluded_apps": []},
 "stream_key": "PLACEHOLDER"}
// ← stdout
{"id":2,"ok":true,"binary":"/usr/bin/gpu-screen-recorder","argv":["/usr/bin/gpu-screen-recorder","-w","portal","-f","60","-c","flv","-k","av1","-bm","cbr","-q","4000","-ac","opus","-a","default_output","-o","rtmp://77.42.71.166:1935/test?user=michael&pass=PLACEHOLDER"]}
```

## Sidecar standalone testen (ohne Tauri)

```bash
# Im Worktree-Root:
python streaming/gsr-sidecar/control.py < <(printf '%s\n' \
  '{"op":"health","id":1}' \
  '{"op":"gpu_info","id":2}' \
  '{"op":"list_monitors","id":3}' \
  '{"op":"list_profiles","id":4}' \
  '{"op":"build_argv","id":5,"profile":"AV1 Effizient","server":"Hetzner","capture":"portal","audio":{"mode":"Desktop","excluded_apps":[]},"stream_key":"TESTKEY"}')
```

Antworten kommen als JSON-Lines auf stdout. **Kein `start` im Test** —
das würde den Wayland-Portal-Capture-Dialog öffnen und tatsächlich an
den Hetzner-Server pushen. Das macht der User selbst.

## GSR-Binary-Resolver

Reihenfolge: `$GSR_BINARY` → Flatpak (`/app/bin/gpu-screen-recorder` wenn
`/.flatpak-info` oder `$FLATPAK_ID`) → Custom-Build
(`/tmp/gsr-analysis/gpu-screen-recorder/build/gpu-screen-recorder`,
gebaut von `bootstrap-gsr.fish`) → System-PATH (`gpu-screen-recorder`).

Wenn nichts gefunden wird, antwortet `health` mit `gsr.available=false`
und `start` schlägt sauber fehl statt zu crashen.

## Stream-Key / Secrets

`streaming/server/mediamtx.yml.template` enthält nur den
`STREAM_KEY_PLACEHOLDER`. Die generierte `streaming/server/mediamtx.yml`
und `streaming/server/.stream-key` sind **gitignored** (im Worktree-
Root-`.gitignore`). Sidecar-RPC sieht den Stream-Key/Token nur transient
als Request-Field — er wird **nicht** persistiert, **nicht** geloggt und
landet ausschließlich in der GSR-Push-URL.

## Nächste Etappe (T3)

- Tauri (Rust): spawnt den Sidecar als Subprocess, liest stdout-Events,
  forwarded sie als Tauri-Events ins Frontend.
- Svelte: baut die GSR-UI (Profil-/Server-/Capture-Picker, Audio-Mode,
  Overrides, Start/Stop, Live-FPS+Uptime, Log) gegen das RPC-Protokoll
  oben. Persistenz wandert auf den Tauri-`store` (statt
  `~/.config/gsr-stream-ui/`).
