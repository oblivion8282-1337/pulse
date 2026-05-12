# Claude-Notizen für dieses Projekt

Projekt: **Pulse — Web-First Chat + Voice + Streaming**.
Monorepo (uv-Workspace + pnpm-Workspace).

## Was das Projekt macht

Discord-ähnlicher Chat/Voice-Client, **Web-First** (alle Browser),
Desktop via Electron (Pivot 2026-05-12 von Tauri 2 weg — siehe §17 / "Desktop-Wrapper (Electron — E1a)"),
PWA-installierbar. Backend = mehrere kleine
FastAPI-Services; Voice über LiveKit (WebRTC/Opus); HQ-Screen-Streaming
(Etappe 3) bindet den existierenden GPU Screen Recorder als **Library**
ein (`~/Dokumente/GPU_Screen_Recorder/` bleibt unangetastet außer einer
~20-Zeilen-Factory in `ui/profiles.py`).

Drei Transportpfade, sauber getrennt: HTTPS/WSS → FastAPI-Services ·
WebRTC → LiveKit (Voice + Screen-Tracks) · WHEP/WebRTC → MediaMTX (nur
GSR-HQ-Streams). Details in `PLAN.md` Section 1.

## Status / Worktree

- **Branch `night-team-2026-05-11`** im Worktree `.claude/worktrees/night-team`.
  Alle Commits hier, **nicht** im Haupt-Repo.
- Etappe 1 (Auth + Chat + Web-Shell) + Etappe 1.5 (shadcn-svelte) +
  Etappe 2 (Voice-Frontend mit LiveKit) sind implementiert. Architektur-
  Details in `NIGHT_RUN_REPORT.md` (Etappe 1, Phasen A–E) und
  `ETAPPE_2_REPORT.md` (Etappe 1.5 + 2).
- **Voice-Presence-Backend** (alle Server-Mitglieder sehen wer im Voice-Channel ist):
  LiveKit schickt Webhooks (`webhook:`-Block in `infra/livekit/livekit.yaml`,
  signiert mit `devkey`) an voice-signaling `POST /webhook` (Signatur-Verify via
  `livekit.api.WebhookReceiver`). voice-signaling pflegt Redis-Sets
  `voice:room:channel-<id>` (TTL 6h, Self-Heal) und published den vollen State auf
  `voice:events`. chat-gateway abonniert `voice:events` und broadcastet
  `{"op":"voice_state","channel_id":..,"user_ids":[..]}` an alle WS-Clients; der
  `ready`-Payload trägt `voice_states: [...]`; REST `GET /guilds/{id}/voice-state`
  fürs Re-Sync nach Reconnect. **`docker compose --profile voice up -d` startet
  LiveKit mit `network_mode: host`** — nötig weil die Host-UFW (`INPUT DROP`)
  Container→Host-Traffic über die Bridge blockt; so erreicht LiveKit
  `127.0.0.1:8003`. voice-signaling braucht jetzt `REDIS_URL` (Stack:
  `redis://localhost:6380/0`).
- chat-gateway-Routes sind seit `chore: split chat-gateway routes`
  als APIRouter-Module unter `services/chat-gateway/src/dcc_chat_gateway/routes/`.

## Tech-Stack (verifiziert aus uv.lock / pnpm-lock.yaml / package.json — kein Raten)

### Tooling / Runtimes
- **Python** 3.14.4 (Workspace verlangt `>=3.13,<3.15`)
- **uv** 0.11.11 (Backend-Workspace, `[tool.uv.workspace]` in `pyproject.toml`)
- **Node** v25.9.0 · **pnpm** 10.33.0 (Frontend-Workspace, `pnpm-workspace.yaml` — Members `web`, `desktop`)
- **Rust** 1.93.1 (rustup 1.28.2) — für `desktop/src-tauri/`
- Ruff `line-length=100`, `target-version=py313`, `ignore=["E501"]`

### Desktop (`desktop/`, Electron — E1a; Tauri 2 — T1, wird in E1c entfernt)
| Lib | Version (gepinnt) | Notiz |
|---|---|---|
| electron | 42.0.1 | devDep in `desktop/package.json` (Electron-Shell, ersetzt Tauri). Kein `postinstall` — Binary wird beim ersten `require('electron')` lazy gezogen |
| esbuild | 0.28.0 | devDep in `desktop/package.json` — bundlet `electron/main.ts`+`preload.ts` → `electron/dist/*.cjs` (`build:electron`). In root-`pnpm.onlyBuiltDependencies` |
| @types/node | ^22.7.5 | devDep in `desktop/package.json` (Electron 42 bundlet Node 22.x) |
| @tauri-apps/cli | 2.11.1 | (T1, historisch — raus in E1c) devDep in `desktop/package.json`; Scripts `tauri`/`tauri:dev`/`tauri:build` (war `dev`/`build`, jetzt von der Electron-App belegt) |
| @tauri-apps/api | 2.11.0 | Dep in `web/package.json` — Frontend importiert `@tauri-apps/api/event` für PTT-Events |
| @tauri-apps/plugin-store | 2.4.3 | JS-Seite in `web/package.json` (Settings-/Token-Persistenz) |
| @tauri-apps/plugin-notification | 2.3.3 | JS-Seite in `web/package.json` (Ping-Toasts) |
| @tauri-apps/plugin-global-shortcut | 2.3.1 | JS-Seite in `web/package.json` (PTT — z.Z. nur Rust-seitig genutzt) |
| `tauri` (Rust-Crate) | 2.11.1 | `desktop/src-tauri/Cargo.toml` |
| `tauri-build` | 2.6.1 | build-dep |
| `tauri-plugin-single-instance` | 2.4.2 | target-gated (nicht mobile); MUSS als erstes Plugin registriert sein |
| `tauri-plugin-store` | 2.4.3 | |
| `tauri-plugin-notification` | 2.3.3 | |
| `tauri-plugin-global-shortcut` | 2.3.1 | target-gated; registriert `Alt+Space` → emittet `ptt-down`/`ptt-up` |
| `tauri-plugin-autostart` | 2.5.1 | target-gated; **registriert aber nicht aktiviert** — keine `autostart:*`-Capability in T1 |

### Backend (Python, `services/*` + `shared/`)
| Lib | Version (uv.lock) | Notiz |
|---|---|---|
| FastAPI | 0.136.1 | constraint `>=0.115,<0.137` |
| uvicorn[standard] | 0.46.0 | |
| SQLAlchemy[asyncio] | 2.0.49 | constraint `>=2.0.40,<2.1`, async ORM |
| asyncpg | 0.31.0 | Postgres-Driver (Prod) |
| aiosqlite | 0.22.1 | nur in Tests (SQLite-Backend) |
| Alembic | 1.18.4 | Migrationen pro Service unter `alembic/versions/` |
| pydantic | 2.13.4 · pydantic-settings 2.14.1 | |
| pyjwt[crypto] | 2.12.1 | RS256; **`PyJWKClient.from_jwks` gibt's hier noch nicht** → Eigenbau via `RSAAlgorithm.from_jwk` in `security.py` |
| cryptography | 48.0.0 | (von pyjwt[crypto]) |
| argon2-cffi | 25.1.0 | Passwort-Hashing (auth-svc, Argon2id t=3/m=64MiB/p=4) |
| redis | 7.4.0 | async; ConnectionManager nutzt `psubscribe('chat:channel:*')` + `get_message()`-Poll (kein `listen()`/`subscribe()`-Race) |
| livekit-api | 1.1.0 | Token-Issue im voice-signaling-Service |
| httpx | 0.28.1 · structlog 25.5.0 · websockets 16.0 | |
| slowapi | siehe lockfile | Rate-Limit in auth-svc (in-process!) |
| email-validator | siehe lockfile | blockt special-use-TLDs → Tests nutzen `dcc-test.example.com`, nicht `*.test` |
| pytest | 9.0.3 · pytest-asyncio 1.3.0 | `--import-mode=importlib`, `asyncio_mode=auto` |

### Frontend (`web/`, SvelteKit-SPA, `ssr=false`, `adapter-static`)
| Lib | Version (pnpm-lock.yaml resolved) | Notiz |
|---|---|---|
| @sveltejs/kit | 2.59.1 | |
| svelte | 5.55.5 | Runes-API (`$state`/`$derived`) |
| @sveltejs/adapter-static | 3.0.10 | Tauri-ready Build-Output |
| @sveltejs/vite-plugin-svelte | 7.1.2 | |
| vite | 8.0.11 | Dev-Proxy: `/api/auth`→:8001 · `/api/chat`→:8002 · `/api/ws`→:8002 · `/api/voice`→:8003 |
| typescript | 5.9.3 | strict |
| tailwindcss | 4.3.0 | + `@tailwindcss/vite`; shadcn-Semantik-Tokens im `.dark{}`-Block |
| valibot | 1.4.0 | API-Response-Validation |
| shadcn-svelte | 1.2.7 | Copy-Paste-Components unter `web/src/lib/components/ui/` (Vendor — von der Größen-Policy ausgenommen) |
| bits-ui | 2.18.1 | Headless-Primitives unter shadcn |
| livekit-client | 2.18.9 | Voice-SDK; `lib/voice/livekit.svelte.ts` abonniert rohe `Room`/`Participant`-Events direkt (kein `@livekit/components-core`-Wrapper, obwohl installiert) |
| @livekit/components-core | 0.12.13 | installiert, **ungenutzt** (siehe ETAPPE_2_REPORT) |
| @svelte-put/shortcut | 4.1.0 | PTT-Hotkey "V" |
| svelte-sonner | 1.1.1 | Toasts |
| @lucide/svelte | 1.14.0 | Icons |
| @fontsource-variable/plus-jakarta-sans | 5.2.8 | UI-Font ("Glasshouse"-Redesign); `@fontsource-variable/inter` bleibt als Fallback |
| mode-watcher | 1.1.0 | Light/Dark/System-Theme: `<ModeWatcher disableHeadScriptInjection track>` in `routes/+layout.svelte` setzt die `.dark`-Klasse; `setMode()` aus `settings.svelte.ts` (`settings.appearance.theme`, persistiert in `dcc.settings`); FOUC-Inline-Script in `app.html` liest `dcc.settings` |
| @playwright/test | 1.59.1 | E2E (`web/tests/e2e/`); globalSetup startet auth+chat als child-procs |
| svelte-check | 4.4.8 | `pnpm check` |

### Infra (`docker-compose.yml`, Container-Images)
- **PostgreSQL** `postgres:16-alpine` — Container `dcc_night_postgres`, Schemas `auth` + `chat` (eigenes Schema pro Service)
- **Redis** `redis:7-alpine` — Container `dcc_night_redis`
- **LiveKit** `livekit/livekit-server:latest` — Container `dcc_night_livekit`, hinter `docker compose --profile voice up -d`, Config `infra/livekit/livekit.yaml`. Läuft mit `network_mode: host` (siehe Voice-Presence-Abschnitt) — bindet 7880/7881 + 7882–7892/UDP direkt auf dem Host, keine Port-Mappings.

## Desktop-Wrapper (Electron — E1a)

> **Wrapper-Pivot 2026-05-12 (PLAN.md §17).** Der Desktop-Wrapper wird von Tauri 2
> auf **Electron** umgestellt — Tauri nutzt auf Linux WebKitGTK, dessen WebRTC ist
> für LiveKit-Voice zu unzuverlässig. Electron liefert Chromium auf allen OS,
> WebRTC out-of-the-box. Migration = Etappe **E1** (E1a Electron-Shell · E1b
> Sidecar-Bridge in Node · E1c Persistenz + Tauri-Cleanup). **E1a fügt nur hinzu
> — `desktop/src-tauri/` bleibt vorerst unangetastet** (Tauri wird erst in E1c
> entfernt), damit der Build nie kaputtgeht. Der "Desktop-Wrapper (T1)"-Abschnitt
> unten ist die Tauri-Variante die durch E1 abgelöst wird.

`desktop/` ist (zusätzlich zum noch vorhandenen `src-tauri/`) jetzt eine Electron-App.
`@dcc/desktop` bleibt pnpm-Workspace-Member; `"main": "electron/dist/main.cjs"`,
`package.json` **ohne** `"type": "module"` (Electron-Main als CJS — am unkompliziertesten).

```
desktop/
├── package.json            @dcc/desktop — main: electron/dist/main.cjs;
│                           devDeps: electron 42.0.1 (gepinnt), esbuild 0.28.0, @types/node ^22.7.5;
│                           Scripts: build:electron (esbuild bundlet main+preload → electron/dist/*.cjs),
│                                    dev (= build:electron && PULSE_DEV_URL=:5173 electron .), start (electron .)
├── tsconfig.json           für die Electron-TS-Files (target ES2022, module CommonJS, strict, skipLibCheck, noEmit)
├── .gitignore              dist/, node_modules/
├── electron/
│   ├── main.ts             Main-Process: requestSingleInstanceLock + second-instance→focus, createWindow
│   │                       (BrowserWindow 1280×832, minWidth 940 / minHeight 600, show:false →ready-to-show,
│   │                        Titel "Pulse", webPreferences: preload + contextIsolation:true + nodeIntegration:false + sandbox:true),
│   │                       Dev (!app.isPackaged || PULSE_DEV_URL) → loadURL(:5173) + openDevTools({mode:'detach'}),
│   │                       Prod → loadFile(../../../web/build/index.html) [TODO T6: Pfad beim Packaging verifizieren],
│   │                       window-all-closed (außer darwin → quit), activate → createWindow
│   ├── preload.ts          contextBridge.exposeInMainWorld('pulse', { platform:'electron', appVersion })
│   │                       — mehr braucht E1a nicht; E1b ergänzt pulse.gsr.*, E1c pulse.store.*, später onPttDown/Up
│   └── dist/               esbuild-Output (gitignored): main.cjs, preload.cjs
└── src-tauri/              (unverändert, wird in E1c entfernt — siehe "Desktop-Wrapper (T1)" unten)
```

**Build-Flow:** esbuild (`build:electron` — `--bundle --platform=node --format=cjs --target=node22 --external:electron --outdir=electron/dist --out-extension:.js=.cjs`) bundlet `electron/main.ts`+`electron/preload.ts` → `electron/dist/{main,preload}.cjs`. `__dirname` und JSON-Imports (`../package.json` → `appVersion`) werden von esbuild eingebacken.

**Electron-Binary:** Electron 42 hat **kein** `postinstall` mehr — das Binary wird beim ersten `require('electron')` lazy heruntergeladen (`node_modules/.pnpm/electron@42.0.1/.../dist/electron`). `pnpm install` ist also "clean"; root-`package.json` hat `pnpm.onlyBuiltDependencies: ["esbuild"]` nur damit esbuilds Binary-Fetch-Postinstall ohne Prompt läuft.

**Dev starten (Electron-Fenster):** Vite-Dev-Server muss auf `:5173` laufen
(`pnpm --filter @dcc/web dev`), dann `pnpm --filter @dcc/desktop dev` (= `build:electron`
+ `electron .` mit `PULSE_DEV_URL=http://localhost:5173`). Electron lädt im Dev von `:5173`,
DevTools öffnen detached. Build-only-Check ohne GUI: `cd desktop && pnpm run build:electron`
(esbuild) + `pnpm exec electron --version`.

**Was in E1a bewusst fehlt:** globaler PTT-Shortcut (Electrons `globalShortcut` kann
nur Press, nicht Press+Release → taugt nicht für Hold-to-Talk; braucht ein natives
Key-Listener-Modul wie `uiohook-napi` — eigener Schritt später; **TODO-Kommentar in
main.ts**). Der In-Window-PTT in `VoiceChannelView.svelte` (`@svelte-put/shortcut`)
funktioniert weiter. Notifications (E1c/später — TODO in main.ts). Prod-`loadFile`-Pfad
ist als TODO markiert (Dev ist der getestete Pfad in E1a). `electron-builder` (Packaging =
T6) und `electron-store` (E1c) sind **nicht** als Dep drin.

**Frontend-Glue:** `web/src/lib/platform/runtime.ts` hat jetzt `isElectron()`
(`window.pulse?.platform === 'electron'`) und `isDesktop()` (`isElectron() || isTauri()`).
`isTauri()` bleibt vorerst (raus in E1c). `ptt.ts` ist unverändert (unter Electron ist
`isTauri()` false → der Tauri-PTT-Pfad ist eh ein No-Op). `gsr.ts`/`state.svelte.ts`/
`persistence.ts`/die Stream-Components/`VoiceControlBar.svelte` sind unverändert — sie
gaten auf `isTauri()` und zeigen unter Electron "GSR nicht verfügbar"; die echte
Electron-Sidecar-Bridge kommt in E1b.

## Desktop-Wrapper (T1)

> **Abgelöst durch E1 (Electron-Migration, 2026-05-12).** Siehe "Desktop-Wrapper
> (Electron — E1a)" oben. Dieser Abschnitt beschreibt die Tauri-2-Variante; sie
> bleibt in E1a unangetastet und wird erst in E1c entfernt.

`desktop/` ist ein pnpm-Workspace-Package (`@dcc/desktop`) und enthält die Tauri-2-App:
```
desktop/
├── package.json            @dcc/desktop — devDep @tauri-apps/cli; Scripts (seit E1a) tauri / tauri:dev / tauri:build → tauri / tauri dev / tauri build
└── src-tauri/              Rust-Crate "pulse-desktop" (lib "pulse_desktop_lib")
    ├── Cargo.toml          tauri 2 + die 5 Plugins (single-instance/global-shortcut/autostart target-gated)
    ├── build.rs            tauri_build::build()
    ├── tauri.conf.json     productName "Pulse", identifier com.unicutmedia.pulse, frontendDist ../../web/build,
    │                       devUrl http://localhost:5173, bundle.targets ["appimage","deb"] (Flatpak erst T6)
    ├── src/main.rs · src/lib.rs · src/ptt.rs   Plugin-Registration + PTT-Wiring
    ├── capabilities/default.json   strikt: core:default, notification:default, global-shortcut:default, store:default
    │                               — KEINE shell:/fs:-Permissions, autostart bewusst weggelassen
    └── icons/              aus web/static/favicon.svg via `tauri icon` (nur Desktop-Icons, kein android/ios)
```
Die JS-Seiten der Plugins (`@tauri-apps/api`, `@tauri-apps/plugin-{store,notification,global-shortcut}`) sind Deps von **`web/`** (Frontend importiert sie). `single-instance` und `autostart` haben keine JS-Seite die wir nutzen.

**PTT-Pfad:** `src/ptt.rs::setup()` registriert beim App-Start einen globalen Shortcut (`Alt+Space`, hardcoded in T1 — `default_ptt_shortcut()` + die `register`-Stelle in `setup()` sind der Seam für "konfigurierbar" später). On-Press → `app.emit("ptt-down", ())`, On-Release → `app.emit("ptt-up", ())`. Frontend: `web/src/lib/platform/ptt.ts` (`initDesktopPtt()`, aufgerufen aus `routes/+layout.svelte` onMount) hört unter Tauri via `@tauri-apps/api/event` `listen('ptt-down'/'ptt-up')` und ruft `voice.pttPress()`/`voice.pttRelease()` aus `lib/voice/livekit.svelte.ts`. Im reinen Browser ist `initDesktopPtt()` ein No-Op — der bestehende In-Window-Keyboard-PTT in `VoiceChannelView.svelte` (`@svelte-put/shortcut`, Taste aus `settings.voice.pttKey`) bleibt unverändert. `web/src/lib/platform/runtime.ts`: `isTauri()` (`'__TAURI_INTERNALS__' in window`) + `isLinux()` (UA-basiert, TODO: `@tauri-apps/plugin-os` falls T3 das braucht).

**`beforeDevCommand` ist leer** — Grund: der Vite-Dev-Server läuft im Dev-Setup eh schon auf `:5173` (`/tmp/dcc-vite.log`), ein zweiter Start würde am Port kollidieren. `tauri dev` erwartet also, dass `web` schon läuft (`pnpm --filter @dcc/web dev` separat starten falls nicht). `beforeBuildCommand` = `pnpm --filter @dcc/web build` (baut `web/build/` für den Release-Bundle).

**Testen / Bauen (Tauri — historisch):**
- `cd desktop/src-tauri && cargo build` — kompiliert die Rust-App (erster Build ~10–20 Min, danach inkrementell). Bleibt in E1a grün (`src-tauri/` unangetastet).
- GUI manuell starten (öffnet ein echtes Fenster): Vite-Dev-Server auf `:5173` muss laufen, dann `pnpm --filter @dcc/desktop tauri:dev` (= `tauri dev`). Für einen Release-Bundle: `pnpm --filter @dcc/desktop tauri:build` (= `tauri build`, baut vorher `web/build/`, erzeugt `.AppImage` + `.deb` unter `desktop/src-tauri/target/release/bundle/`).
- Linux-Systemdeps für Tauri (Arch/CachyOS): `webkit2gtk-4.1`, `gtk3`, `libsoup3`, `librsvg`, `base-devel` — sind installiert.

## Streaming-Paket (T2)

`streaming/` ist eine **vendored Kopie** aus `~/Dokumente/GPU_Screen_Recorder/`
(2026-05-11). Das **Original-Repo bleibt unangetastet** — Pulse modifiziert
ausschließlich seine eigene Kopie. uv-Workspace-Member: `streaming` (Paket
`gsr-sidecar`, `[tool.uv] package = false`, **pure-stdlib**, keine Runtime-Deps).

```
streaming/
├── gsr-sidecar/             Python-Sidecar (pure stdlib, kein PySide6)
│   ├── profiles.py          StreamProfile/ServerProfile + ServerProfile.from_channel()
│   ├── stream_controller.py subprocess.Popen-Wrapper (QProcess raus) + stderr-Reader-Thread
│   ├── config.py            Settings-Dataclasses (JSON-I/O nicht aktiv — Persistenz in T3 auf Tauri-store)
│   ├── gsr_binary.py        Binary-Resolver + --info/--list-monitors-Parser
│   └── control.py           stdio-Loop (newline-JSON, ersetzt main.py/stream_window.py)
├── patches/                 GSR-C++-Patches (FLV-Opus-Whitelist + Vulkan-Stub) — verbatim
├── server/                  MediaMTX-Setup (mediamtx.yml.template + docker-compose + player.html)
├── scripts/                 start-stream*.fish — manuelle Test-Skripte als Referenz
├── bootstrap-gsr.fish       Custom-GSR-Build mit Patches (für T6 Flatpak)
└── pyproject.toml
```

**Sidecar-Protokoll (stdio, newline-JSON):**
- Request: `{"op": "...", "id": ...?, ...}` — Response: `{"id": ..., "ok": bool, ...}` (id gespiegelt). Async-Event: `{"ev": "...", ...}` (kein id/ok).
- Ops: `health`, `gpu_info`, `list_monitors`, `list_profiles`, `list_application_audio`, `build_argv`, `start`, `stop`, `state`.
- Events: `state` (`idle|starting|live|error|stopped`), `fps`, `log`, `error`, `stopped`.
- `start`/`build_argv` akzeptieren entweder `server: "<name>"` (mit `stream_key`) oder `channel: {id, token, mediamtx_endpoint?, push_protocol?}` (Pulse-Pfad via `ServerProfile.from_channel()` — MediaMTX-Pfad `channel-<id>`).
- Vollständige Protokoll-Doku: `streaming/README.md`.

**GSR-Binary-Resolver (Reihenfolge):** `$GSR_BINARY` → Flatpak (`/app/bin/gpu-screen-recorder` wenn `/.flatpak-info` oder `$FLATPAK_ID`) → Custom-Build (`/tmp/gsr-analysis/gpu-screen-recorder/build/gpu-screen-recorder`, gebaut von `bootstrap-gsr.fish`) → System-PATH. Fehlt alles → `health.gsr.available=false` (kein Crash).

**Testen (non-invasiv, kein Portal-Dialog, kein realer Stream):**
```bash
# Mehrere Ops auf einmal:
printf '%s\n' \
  '{"op":"health","id":1}' \
  '{"op":"list_monitors","id":2}' \
  '{"op":"build_argv","id":3,"profile":"AV1 Effizient","server":"Hetzner","capture":"portal","audio":{"mode":"Desktop","excluded_apps":[]},"stream_key":"PLACEHOLDER"}' \
  | python3 streaming/gsr-sidecar/control.py
```
`build_argv` baut die `gpu-screen-recorder`-Argumentliste **ohne den Prozess zu starten** — gleiche Argumente wie die `start-stream-server*.fish`-Skripte (nur ohne `-restore-portal-session yes`, exakt wie der Original-`stream_controller.py`). **KEIN `{"op":"start"}` im Test ausführen** — das öffnet den Wayland-Portal-Dialog und streamt tatsächlich an MediaMTX.

**QProcess → subprocess (einzige echte Logik-Änderung):** `stream_controller.StreamController` nutzt `subprocess.Popen(..., start_new_session=True)` + zwei Daemon-Threads (stdout-Reader für FPS-Parse + Wait-Thread). Stop sendet `SIGINT` an die Prozessgruppe (`os.killpg`), mit `SIGTERM`/`SIGKILL`-Escalation falls 5 s nichts passiert. **GSR-Argument-Verhalten unverändert** — die `build_argv()`-Methode produziert dieselbe `-w/-f/-c/-k/-bm/-q/-ac/-a/-s/-o`-Folge wie zuvor.

**Stream-Key / Secrets:**
- `streaming/server/mediamtx.yml.template` enthält nur `STREAM_KEY_PLACEHOLDER` (commit-safe).
- `streaming/server/mediamtx.yml` und `streaming/server/.stream-key` sind in `.gitignore` (Worktree-Root). Die Dateien werden im Pulse-Repo **nie** angelegt — der Stream-Key bleibt im Original-Repo (`~/Dokumente/GPU_Screen_Recorder/server/.stream-key`).
- Sidecar nimmt den Token nur transient als Request-Field entgegen; er wird **nicht** persistiert, **nicht** geloggt.

**Was bewusst NICHT mitkopiert wurde:** Qt-UI (`ui/main.py`, `ui/stream_window.py`), Binär-/Build-Artefakte (`mediamtx`-Binary 52 MB, `*.flatpak` 181 MB, `build/`, `.flatpak-builder/`, `*.log`), die generierte `server/mediamtx.yml`, `server/.stream-key`, `bootstrap.fish` (lädt nur MediaMTX-Binary für Lokal-Tests — brauchen wir hier nicht). `packaging/` (Flatpak-Manifest) folgt in T6 als kombiniertes Manifest.

## Desktop ↔ Sidecar-Bridge (Electron — E1b)

Der Electron-Main-Prozess spawnt den Python-Sidecar (`python3 streaming/gsr-sidecar/control.py`) als Kind-Prozess und brückt das newline-JSON-Protokoll per IPC zum Renderer (= der SvelteKit-App). **Der Sidecar startet nicht beim App-Start** — der erste `gsr:call`-Invoke aus dem Renderer spawnt ihn (lazy). Wer nie streamt, fährt nie Python hoch.

```
desktop/electron/
├── sidecar.ts    SidecarManager (Singleton via getSidecar()): child_process.spawn,
│                 Path-Resolver, readline-Reader auf stdout, Request/Reply-Routing
│                 via numerische IDs (Map id → {resolve,reject,timer}), stderr→console.error
│                 mit Prefix `[gsr-sidecar]`, onEvent(cb), shutdown(). Wird von esbuild
│                 automatisch in main.cjs gebundlet (main.ts importiert es).
├── main.ts       wireSidecar(): getSidecar().onEvent(ev → webContents.send('gsr:event', ev))
│                 + ipcMain.handle('gsr:call', (op, params) → getSidecar().call(op, params))
│                 (catch-all → {ok:false,error}). before-quit → getSidecar().shutdown() (3 s-Backstop).
└── preload.ts    contextBridge.exposeInMainWorld('pulse', { platform, appVersion, gsr: {...} })
```

**Path-Resolver-Reihenfolge** (`sidecar.ts::resolveScriptPath`): `$PULSE_SIDECAR_PY` (absoluter Pfad zu `control.py`, sonst Fehler wenn die Datei fehlt) → Walk-up vom `__dirname` des gebundleten `main.cjs` (`desktop/electron/dist/`) bis ein `<X>/streaming/gsr-sidecar/control.py` existiert (greift im Dev von `dist/` aus über `../../../streaming/...`) → Flatpak-Default `/app/share/pulse/gsr-sidecar/control.py` (T6 — TODO, beim Flatpak-Packaging konkretisieren).

**Protokoll-Bridge:** Jeder Outbound-Request kriegt eine `id` (number, monoton steigend), die `control.py` 1:1 in der Response spiegelt. `readline.createInterface({input: child.stdout})` liest stdout zeilenweise → JSON parsen: hat `"id"` (number) → an die wartende Promise; hat `"ev"` (string, kein `id`) → an den von `main.ts` gesetzten Event-Callback (→ `webContents.send('gsr:event', ev)`). Kaputte Zeile → `console.error`, kein Crash. Stirbt der Sidecar / `error`-Event → alle pending Requests werden rejected. Standard-Timeout 10 s; `start` 60 s (Wayland-Portal-Dialog), `stop` 15 s. `shutdown()`: stdin schließen (Sidecar-Loop endet auf EOF und stoppt einen laufenden GSR) → 1,5 s Grace → `SIGTERM` → 2 s Grace → `SIGKILL`. (stdin-zuerst-schließen vermeidet, dass der Python-Signalhandler ein reentrantes `sys.stdin.close()` macht während er auf stdin blockt.) `pythonBin` = `$PULSE_PYTHON ?? 'python3'`.

**Renderer-API — `window.pulse.gsr.*`** (vom Preload exponiert, alle Methoden async, geben das rohe Response-JSON zurück bzw. werfen bei `ok:false`/Timeout — die `gsr:call`-IPC läuft generisch über `ipcRenderer.invoke('gsr:call', op, params)`):

| Methode | op | Response (JSON, durchgereicht) |
|---|---|---|
| `health()` | `health` | `{ok, gsr: {available, source, path?, version?, vendor?, video_codecs?, ...}}` |
| `gpuInfo()` | `gpu_info` | `{ok, vendor?, video_codecs?, ...}` |
| `listMonitors()` | `list_monitors` | `{ok, monitors: [{name, resolution}]}` |
| `listProfiles()` | `list_profiles` | `{ok, profiles, servers, audio_modes, app_label_prefix}` |
| `listApplicationAudio()` | `list_application_audio` | `{ok, applications}` |
| `buildArgv(args)` | `build_argv` | `{ok, binary, argv}` (kein Start!) |
| `start(args)` | `start` | `{ok, argv}` — danach kommen Events auf `gsr:event` |
| `stop()` | `stop` | `{ok}` |
| `state()` | `state` | `{ok, running, state, fps, uptime_s, argv}` |
| `onEvent(cb)` | — | registriert `ipcRenderer.on('gsr:event', …)`, gibt eine Unsubscribe-Fn zurück. **Callbacks gehen nicht direkt über contextBridge** — der Wrapper läuft im Preload, ruft die vom Renderer übergebene `cb` von dort auf. |

Die `window.pulse`-Shape ist als `Window`-Augmentation in `web/src/lib/platform/pulse.d.ts` deklariert (`PulseApi`/`PulseGsrApi`) — mit `preload.ts` synchron halten.

**Frontend-Bridge** (`web/src/lib/stream/`):

- `gsr.ts` — typed Wrapper um `window.pulse.gsr.*`. `gsr.available()` = `isElectron() && window.pulse?.gsr != null` (war `isTauri()`). Alle Methoden returnen `null` außerhalb von Electron (`!gsr.available()`), nicht throwen — der Import ist im Browser sicher. Die exportierte API (`health/gpuInfo/listMonitors/listProfiles/listApplicationAudio/buildArgv/start/stop/state/onEvent/available`) ist **signatur-identisch** zur Tauri-Variante; nur der Transport (`@tauri-apps/api` → `window.pulse`) hat sich geändert.
- `state.svelte.ts` — `$state`-Object `stream = {available, gsrAvailable, running, state, fps, uptimeS, error, lastLog}`, gefüttert aus `gsr.onEvent`. `initStream()` ist idempotent. Event-Format (`{ev:..,...}`) unverändert.
- `web/src/routes/+layout.svelte` ruft `initStream()` in `onMount`. In Browser → No-Op.
- Streaming-Gating: `HqStreamButton.svelte` zeigt sich nur bei `isElectron() && isLinux() && stream.gsrAvailable`; `StreamPanel.svelte` und die Dev-Route gaten auf `gsr.available()`.

**Dev-Test-Route**: `web/src/routes/app/dev/stream/+page.svelte` (`/app/dev/stream` — nicht im Menü). `<StreamPanel />` + Debug-Block (Raw-Health, `build_argv` ohne Start, Live-State). E2E-Check für die Bridge in der Electron-App.

**`@tauri-apps/api` jetzt ungenutzt:** `gsr.ts`/`state.svelte.ts` importieren `@tauri-apps/api` nicht mehr; `ptt.ts` + `persistence.ts` nutzen es noch (Tauri-Pfad, unter Electron tot — Cleanup in E1c, dann fliegen die `@tauri-apps/*`-Deps aus `web/package.json`). `desktop/src-tauri/` ist in E1b unangetastet.

**Sidecar selbst unverändert:** `control.py` musste **nicht** angepasst werden — Request-IDs (`id`-Echo) + `SIGTERM`/`SIGINT`/stdin-EOF-Shutdown sind seit T2 da. `sidecar.ts` baut nur drauf auf.

**Verifikation E1b:**
- `cd desktop && pnpm run build:electron` — esbuild bundlet `electron/dist/{main,preload}.cjs` (mit `sidecar.ts`) ohne Fehler.
- `cd web && pnpm check && pnpm build` — 0 Errors / 0 Warnings.
- `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q` — 134/134 grün.
- `cd desktop/src-tauri && cargo build` — unverändert grün (nichts angefasst).
- Node-Sidecar-Standalone: `sidecar.ts` via esbuild → temp-`.cjs` gebundlet, `getSidecar()` lädt, `call('health')` + `call('state')` → IDs gespiegelt (1, 2), `ok:true`, GSR-Binary gemeldet; `shutdown()` → Exit-Code 0, kein Traceback.
- **Nicht verifiziert in E1b**: tatsächlicher `start` (würde Portal-Dialog öffnen + an Hetzner pushen) + der visuelle Test der Electron-GUI — macht der User/Parent.

> **Historisch (abgelöst durch E1b):** Vor der Electron-Migration lief diese Bridge in Rust (`desktop/src-tauri/src/streaming/{mod,sidecar,commands}.rs`, neun `#[tauri::command] gsr_*`, Event-Channel `gsr://event`, ACL-allowlisted in `capabilities/default.json`). Gleiche Idee (lazy spawn, numerische Request-IDs, oneshot-Routing, Event-Forwarding) — wird in E1c mit dem Rest von `src-tauri/` entfernt.

## Streaming-UI + Voice-View-Integration (T3b/T3c)

Die Pulse-Streaming-UI lebt unter `web/src/lib/stream/`:

- `gsr.ts` — typed Wrapper um die Sidecar-Bridge (seit E1b `window.pulse.gsr.*`,
  vorher Tauri — siehe "Desktop ↔ Sidecar-Bridge (Electron — E1b)"). `GsrStartArgs`
  trägt seit T3c zusätzlich `custom_server: {…}` für die nutzer-definierten Server-Targets.
- `state.svelte.ts` — Live-Stream-State (`running/fps/uptime/log/error`).
- `settings.svelte.ts` — User-Picker-Selections + Catalog + GPU-Info-Cache,
  alle Mutations rufen `persistSettings()` (debouncede 300ms-Save).
- `persistence.ts` (T3c) — Wrapper über `@tauri-apps/plugin-store`-`LazyStore`
  (`pulse-stream.json` im app-config-dir) mit `localStorage`-Fallback (`pulse.stream`-Key)
  für den Browser-Pfad. Persistiert: `profile_name`, `server_name`, `capture_source`,
  `audio_mode`, `excluded_apps`, `overrides`, `use_overrides`, `custom_servers`.
- `components/` — `StreamPanel` (Composite) + die einzelnen Picker
  (`ProfilePicker`, `ServerPicker`, `CaptureSourcePicker`, `AudioModePicker`,
  `OverridesEditor`), `StreamControls`, `StreamLog`, plus T3c-Add-Ons:
  `AddServerDialog`, `HqStreamButton`, `HqStreamDialog`.

**GPU-Detection-Default (T3c, `defaultProfileForGpu`):** `loadCatalogs()` ruft
`gsr.gpuInfo()` parallel zu den Katalogen ab und cachet das Result in
`streamSettings.gpu_info`. Aus `gpu_info.video_codecs` leiten wir den Default-
Profilnamen ab — AV1-Encoder vorhanden → "AV1 Effizient", sonst "H.264 Standard"
(Fallback: erstes Profil). **Wichtig:** Persistenz wird *vor* den Defaults
geladen — gespeicherte Werte überschreiben die Heuristik, der Default greift
nur beim allerersten Start ohne gespeicherte Wahl. AV1-Warnung in
`ProfilePicker` (`av1Mismatch()` — Profil nutzt AV1, GPU listet kein AV1-Encode).

**Custom-Server (T3c, `AddServerDialog`):** legt einen `CustomServer`
({name, host, port, protocol, path, auth-user, stream_key, is_custom: true})
in `streamSettings.custom_servers` ab, persistiert via Tauri-store + merged in
`available_servers`. `ServerPicker` zeigt Custom-Einträge mit `(custom)`-Tag und
einem Löschen-Knopf. Beim `gsr_start` schickt der Frontend die volle Inline-Spec
als `custom_server: {...}` + `stream_key` — der Sidecar (`control.py::_resolve_server`)
wrappt das zu einem transienten `ServerProfile`. **Stream-Key landet im Klartext
im Tauri-Store** (`chmod 600` via `harden_config_dir()` ist die einzige
Hardening-Maßnahme — auf shared Boxen reicht das, ist aber *kein* Secret-Vault).
**Niemals `console.log(...)` mit Stream-Key oder Token.**

**Voice-View-Integration (T3c):** `VoiceControlBar` rendert `<HqStreamButton />`
zwischen Screenshare-Toggle und Verlassen-Button. Der Button rendert *nur*
wenn `isElectron() && isLinux() && stream.gsrAvailable` (seit E1b — war `isTauri()`)
— im Browser und auf anderen OSs unsichtbar. Click → öffnet `HqStreamDialog` mit dem ganzen `StreamPanel`
drin (shadcn-svelte-`Dialog`, `max-w-2xl`, `closeOnOutsideClick`-Default). Bei
laufendem Stream (`stream.running`) zeigt der Button-Icon einen roten Live-Dot.
Neue `data-testid`s: `voice-hq-stream-btn`, `voice-hq-stream-live-dot`,
`hq-stream-dialog`, `add-server-dialog`, `stream-server-add`, `stream-server-delete`,
`stream-profile-av1-warning`.

**Test-Befehl Dev-Route:** Vite-Dev `:5173` läuft, dann
`http://127.0.0.1:5173/app/dev/stream` öffnen — die Diagnose-Page mit
allen Sidecar-Ops als Buttons. Im *normalen* Pulse-Flow ist die Streaming-UI
nur im Voice-Channel über den Stream-Button erreichbar (und nur unter Electron+Linux mit gefundenem GSR-Binary).

## Test-Datenbank

E2E-Tests (Playwright) laufen gegen `dcc_test` — eine separate DB im selben Postgres-Container.
Die `dcc`-DB ist die Dev-DB und wird von Tests **niemals** angefasst (kein TRUNCATE, kein DROP).
`_globalSetup.ts` legt `dcc_test` automatisch an falls nicht vorhanden, läuft Alembic-Migrationen
dagegen und truncated nur diese DB. Redis-Index `/1` (statt `/0`) für Test-Pub/Sub-Isolation.

## Port-Mapping (lokales Dev)

| Dienst | Port | Notiz |
|---|---|---|
| Postgres | **5434** | nicht 5433/5432 — Standard-Ports waren von einem Schwester-Worktree belegt; `.env` reflektiert das |
| Redis | **6380** | dito; `REDIS_URL=redis://localhost:6380/0` |
| auth-svc | 8001 | `uvicorn dcc_auth.app:app` |
| chat-gateway | 8002 | `uvicorn dcc_chat_gateway.app:app` |
| voice-signaling | 8003 | `uvicorn dcc_voice_signaling.app:app` |
| web (Vite dev) | 5173 | `http://127.0.0.1:5173` |
| LiveKit | 7880 | HTTP/Signalling; 7881 + 7882–7892/UDP für RTC. `network_mode: host`, direkt auf Host-Interfaces |

### Service-Start (Env aus `.env`)
- chat-gateway / auth: `POSTGRES_PASSWORD`, `JWT_PRIVATE_KEY_FILE` + `JWT_PUBLIC_KEY_FILE`
  (absolute Pfade zu `secrets/jwt_*.pem`), `REDIS_URL=redis://localhost:6380/0`,
  `AUTH_JWKS_URL=http://127.0.0.1:8001/.well-known/jwks.json`
- **chat-gateway neu starten** (überlebt Agent-Shutdown):
  ```bash
  pkill -f "uvicorn dcc_chat_gateway"
  cd services/chat-gateway && \
  POSTGRES_PASSWORD=... REDIS_URL=redis://localhost:6380/0 \
  AUTH_JWKS_URL=http://127.0.0.1:8001/.well-known/jwks.json \
  setsid nohup uv run uvicorn dcc_chat_gateway.app:app --host 127.0.0.1 --port 8002 \
    > /tmp/dcc-chat.log 2>&1 < /dev/null & disown
  ```
- **voice-signaling MUSS dieselben LiveKit-Keys wie `infra/livekit/livekit.yaml` / `.env` bekommen**,
  sonst lehnt LiveKit alle Tokens ab ("invalid token: error in cryptographic primitive") und
  die Webhook-Signatur-Verifikation schlägt fehl. Braucht außerdem `REDIS_URL` für den
  Voice-Presence-State:
  ```
  LIVEKIT_API_KEY=devkey
  LIVEKIT_API_SECRET=devsecretdevsecretdevsecretdevsecret
  LIVEKIT_URL=ws://localhost:7880
  REDIS_URL=redis://localhost:6380/0
  AUTH_JWKS_URL=http://127.0.0.1:8001/.well-known/jwks.json
  ```
  Start (detached, überlebt Agent-Shutdown): aus `services/voice-signaling/`
  `setsid nohup uv run uvicorn dcc_voice_signaling.app:app --host 127.0.0.1 --port 8003 > /tmp/dcc-voice.log 2>&1 < /dev/null & disown`.
  `.env` + `livekit.yaml` sind die Single Source of Truth für diese Keys (Dev-Werte, kein Geheimnis).

## Wichtige Konventionen

- **Kein `git push`, keine GitHub-CLI** ohne explizite Freigabe. Remote existiert: `origin` → `github.com/oblivion8282-1337/pulse.git` (seit 2026-05-11; `main` + `night-team-2026-05-11` gepusht).
- **Snowflake-IDs als Strings über die API-Grenze** (REST-Bodies, WS-Messages, Responses).
  JS `Number` kann 64-bit nicht exakt darstellen — IDs > 2^53 verlieren Low-Bits.
  Backend-Schemas haben einen `SnowflakeId`-`BeforeValidator` der int *oder* string akzeptiert;
  Frontend sendet immer string. Format: `[42-bit ms ab 2026-01-01][10-bit worker][12-bit seq]`,
  Worker-IDs: auth=1, chat=2, voice=3.
- **Code-Größen-Policy** (siehe `PLAN.md` Section 12.1): Source-Dateien Ziel ≤ 350 Zeilen
  (hart 500), Svelte-Components ≤ 250. Ausgenommen: Tests, Alembic-Migrationen,
  `web/src/lib/components/ui/`. Im Zweifel splitten statt wachsen lassen — neue Route-Gruppe
  = eigenes Modul unter `routes/`, nicht ein Anhang.
- **Services kommunizieren nur über Redis Pub/Sub oder HTTP** — niemals über shared DB-Tabellen.
- **Refactoring darf das Verhalten nicht ändern** — Endpoint-Pfade, Response-Models, `data-testid`
  bleiben identisch. Bricht ein Test nach einem Refactor → der Code ist kaputt, nicht der Test.
- Tests vor jedem Commit: `uv run pytest` (mit `REDIS_URL=redis://localhost:6380/0` falls Redis
  auf non-default-Port läuft) + `cd web && pnpm exec playwright test` + `pnpm check` + `pnpm build`.
- WS-Auth: Access-Token als Query-Param (`/ws?token=...`) — Browser-WebSocket-API kann keine
  Custom-Header. Expired/ungültig → close mit Code 4001.

## Anti-Patterns (kurz — voll in `PLAN.md` Section 12)

- ❌ Existierende GSR-Files anfassen außer `ui/profiles.py`
- ❌ Shared DB-Tabellen zwischen Services · ❌ HS256 JWT
- ❌ `fastapi-users` / `broadcaster` / `fastapi-socketio` / `fastapi_websocket_pubsub` als Dependency (alle archiviert/Maintenance-Mode → Eigenbau, Source nur als Referenz)
- ❌ State-Library (Redux/Zustand/Pinia) neben Svelte-Runes · ❌ CSS-in-JS (Tailwind reicht)
- ❌ Tauri für den Desktop-Wrapper (Pivot 2026-05-12 → Electron, §17 / E1 — WebKitGTK-WebRTC zu unzuverlässig für LiveKit) · ❌ React-Bridge in SvelteKit für LiveKit-React-Components
- ❌ `@livekit/krisp-noise-filter` (kostenpflichtig seit 2026-05-01) · ❌ `svelte-french-toast` (Sv5-inaktiv) · ❌ `svelte-markdown` blind (kein Sanitizer)
- ❌ Exactly-once-Delivery anstreben · ❌ Re-Publishing MediaMTX→LiveKit (Transcoding zu teuer)
- ❌ Routes-/Service-Dateien über die Größen-Grenze wachsen lassen statt zu splitten
