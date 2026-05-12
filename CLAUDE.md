# Claude-Notizen für dieses Projekt

Projekt: **Pulse — Web-First Chat + Voice + Streaming**.
Monorepo (uv-Workspace + pnpm-Workspace).

## Was das Projekt macht

Discord-ähnlicher Chat/Voice-Client, **Web-First** (alle Browser),
Desktop via Electron (Pivot 2026-05-12 von Tauri 2 weg — siehe §17 / "Desktop-App (Electron)"),
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
- **HQ-Streaming-Backend (T5a)**: zwei neue Services — `media-svc` (8004) gibt
  per-Channel-Stream-Tokens aus + hält den Stream-State, `mediamtx-auth-hook`
  (8005) ist MediaMTX' `authHTTP`-Delegation. MediaMTX läuft im Dev über
  `streaming/server/docker-compose.yml` (separat, `network_mode: host`), jetzt
  mit `authMethod: http` → `http://localhost:8005/`. Details siehe Abschnitt
  "HQ-Streaming-Backend (T5a)" unten.
- **HQ-Stream-Presence (T5b)** — chat-gateway-Integration, exakt nach dem
  Voice-Presence-Muster: chat-gateway abonniert `stream:events` (im
  `ConnectionManager` neben `voice:events`) und broadcastet
  `{"op":"stream_state","channel_id":..,"user_id":..|null,"active":bool}` an alle
  WS-Clients; der `ready`-Payload trägt zusätzlich `stream_states: [{channel_id,
  user_id}, ...]` (aktive HQ-Streams in den Guilds des Users, direkt aus den
  `stream:channel:*`-Redis-Keys gelesen — wie Voice-Presence aus `voice:room:*`);
  REST `GET /guilds/{id}/stream-state` fürs Re-Sync. Plus zwei Membership-gateete
  media-svc-Proxies: `POST /channels/{id}/stream-token` (prüft: Channel existiert,
  User ist Member der Guild, Channel ist ein Voice-Channel → leitet das
  Pulse-Access-JWT an `media-svc POST /channels/{id}/stream-token` weiter) und
  `GET /channels/{id}/whep` (gleicher Check → `media-svc GET /channels/{id}/whep`).
  Braucht `MEDIA_SVC_URL` (Dev `http://127.0.0.1:8004`). (T5c = VPS-Deploy — noch offen.)

## Tech-Stack (verifiziert aus uv.lock / pnpm-lock.yaml / package.json — kein Raten)

### Tooling / Runtimes
- **Python** 3.14.4 (Workspace verlangt `>=3.13,<3.15`)
- **uv** 0.11.11 (Backend-Workspace, `[tool.uv.workspace]` in `pyproject.toml`)
- **Node** v25.9.0 · **pnpm** 10.33.0 (Frontend-Workspace, `pnpm-workspace.yaml` — Members `web`, `desktop`)
- Ruff `line-length=100`, `target-version=py313`, `ignore=["E501"]`

### Desktop (`desktop/`, Electron)
| Lib | Version (gepinnt) | Notiz |
|---|---|---|
| electron | 42.0.1 | devDep in `desktop/package.json` (Electron-Shell). Kein `postinstall` — Binary wird beim ersten `require('electron')` lazy gezogen |
| esbuild | 0.28.0 | devDep in `desktop/package.json` — bundlet `electron/{main,preload}.ts` (+ `sidecar.ts` + `store.ts`, beide via Import gezogen) → `electron/dist/*.cjs` (`build:electron`). In root-`pnpm.onlyBuiltDependencies` |
| @types/node | ^22.7.5 | devDep in `desktop/package.json` (Electron 42 bundlet Node 22.x) |

> Tauri 2 (T1/T3a) war der ursprüngliche Desktop-Wrapper; am 2026-05-12 auf Electron migriert (E1) — siehe PLAN.md §17. `desktop/src-tauri/` + alle `@tauri-apps/*`-Deps wurden in E1c entfernt; es wird **kein** Rust mehr gebraucht.

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
| @sveltejs/adapter-static | 3.0.10 | statischer Build-Output (`web/build/`) — vom Electron-Main in Prod via `loadFile` geladen |
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

## Desktop-App (Electron)

> **Wrapper-Pivot 2026-05-12 (PLAN.md §17).** Der Desktop-Wrapper war ursprünglich
> Tauri 2 (T1/T3a). Tauri nutzt auf Linux WebKitGTK, dessen WebRTC ist für
> LiveKit-Voice zu unzuverlässig (Voice lief im Tauri-Fenster nicht). → Migration
> auf **Electron** (Chromium auf allen OS, WebRTC out-of-the-box) = Etappe **E1**:
> E1a Electron-Shell · E1b Sidecar-Bridge in Node · E1c Settings-Persistenz +
> Tauri-Cleanup + Docs. `desktop/src-tauri/` + alle `@tauri-apps/*`-Deps sind seit
> E1c **entfernt**; kein Rust mehr.

`desktop/` ist eine Electron-App (`@dcc/desktop`, pnpm-Workspace-Member).
`"main": "electron/dist/main.cjs"`, `package.json` **ohne** `"type": "module"`
(Electron-Main als CJS — am unkompliziertesten mit unserem esbuild-CJS-Bundle).

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
│   │                       window-all-closed (außer darwin → quit), activate → createWindow.
│   │                       whenReady: initStore() → wireStore() (store:* IPC) → wireSidecar() (gsr:* IPC) → createWindow.
│   │                       before-quit → getSidecar().shutdown() (3 s-Backstop).
│   ├── preload.ts          contextBridge.exposeInMainWorld('pulse', { platform:'electron', appVersion, store:{get,getAll,set}, gsr:{...} })
│   ├── sidecar.ts          SidecarManager — Python-GSR-Sidecar (siehe "Desktop ↔ Sidecar-Bridge (E1b)")
│   ├── store.ts            Hand-rolled Key-Value-Store (Settings-Persistenz, E1c — siehe unten)
│   └── dist/               esbuild-Output (gitignored): main.cjs, preload.cjs (sidecar.ts + store.ts werden mitgebundlet)
```

**Build-Flow:** esbuild (`build:electron` — `--bundle --platform=node --format=cjs --target=node22 --external:electron --outdir=electron/dist --out-extension:.js=.cjs`) bundlet `electron/main.ts`+`electron/preload.ts` → `electron/dist/{main,preload}.cjs`. `sidecar.ts` und `store.ts` werden automatisch reingezogen (von `main.ts` importiert). `__dirname` und JSON-Imports (`../package.json` → `appVersion`) werden von esbuild eingebacken.

**Electron-Binary:** Electron 42 hat **kein** `postinstall` mehr — das Binary wird beim ersten `require('electron')` lazy heruntergeladen (`node_modules/.pnpm/electron@42.0.1/.../dist/electron`). `pnpm install` ist also "clean"; root-`package.json` hat `pnpm.onlyBuiltDependencies: ["esbuild"]` nur damit esbuilds Binary-Fetch-Postinstall ohne Prompt läuft.

**Dev starten (Electron-Fenster):** Vite-Dev-Server muss auf `:5173` laufen
(`pnpm --filter @dcc/web dev`), dann `pnpm --filter @dcc/desktop dev` (= `build:electron`
+ `electron .` mit `PULSE_DEV_URL=http://localhost:5173`). Electron lädt im Dev von `:5173`,
DevTools öffnen detached. Build-only-Check ohne GUI: `cd desktop && pnpm run build:electron`
(esbuild) + `pnpm exec electron --version`. Voice funktioniert im Electron-Fenster
(Chromium-WebRTC) — das war der Grund für den Pivot.

**Settings-Persistenz (E1c) — `electron/store.ts` + `web/src/lib/stream/persistence.ts`:**
Hand-rolled (bewusst **kein** `electron-store` — das ist in neueren Versionen ESM-only
und gibt CJS/ESM-Friktion mit unserem esbuild-CJS-Bundle; wir brauchen nur get/set/getAll).
Main-Seite (`store.ts`): `<userData>/pulse-stream.json` — beim App-Start (`initStore()` in
`app.whenReady()`) einmal `fs.readFileSync` in ein in-memory-Objekt; jeder `set` schreibt das
Objekt synchron als JSON zurück (`fs.writeFileSync(..., { mode: 0o600 })`). **Linux-Hardening**
(übernimmt die alte Tauri-`harden_config_dir()`-Posture): `chmod 700` aufs `userData`-Dir +
`chmod 600` aufs JSON-File (Settings können Custom-Server-Stream-Keys im Klartext enthalten).
IPC: `ipcMain.handle('store:get'|'store:getAll'|'store:set')` — Errors werden geloggt, nicht
gecrasht. Preload: `window.pulse.store = { get, getAll, set }`. Renderer (`persistence.ts`):
`loadAll`/`loadKey`/`saveAll` → `window.pulse.store.*` wenn `isElectron() && window.pulse?.store`,
sonst `localStorage`-Fallback (`pulse.stream`-Key — für die Dev-Route `/app/dev/stream` /
SvelteKit-App ohne Electron). Die `persistence.ts`-API ist signatur-identisch zu vorher;
nur der Transport hat sich geändert (`@tauri-apps/plugin-store` → `window.pulse.store`).
Persistiert: `profile_name`, `server_name`, `capture_source`, `audio_mode`, `excluded_apps`,
`overrides`, `use_overrides`, `custom_servers`. **Niemals Stream-Keys/Tokens loggen.**

**Was bewusst (noch) fehlt:** globaler PTT-Shortcut — Electrons `globalShortcut` kann nur
Press, nicht Press+Release → taugt nicht für Hold-to-Talk; braucht ein natives Key-Listener-
Modul (z.B. `uiohook-napi`) → eigener Schritt später. `web/src/lib/platform/ptt.ts`
(`initDesktopPtt()`, aus `routes/+layout.svelte` onMount aufgerufen) ist daher aktuell ein
**No-op-Stub** (`// TODO: global PTT for Electron needs a native key-listener (uiohook-napi)`).
Der In-Window-PTT in `VoiceChannelView.svelte` (`@svelte-put/shortcut`, Taste aus
`settings.voice.pttKey`) ist der aktive PTT-Pfad und funktioniert unverändert. Notifications
(TODO in main.ts — kleiner `notify(title, body)`-IPC-Handler später). Prod-`loadFile`-Pfad
ist als TODO markiert (Dev ist der getestete Pfad). `electron-builder` (Packaging = T6) ist
**nicht** als Dep drin.

**Frontend-Glue:** `web/src/lib/platform/runtime.ts` hat `isElectron()`
(`window.pulse?.platform === 'electron'`), `isDesktop()` (= `isElectron()`, Alias) und
`isLinux()` (UA-basiert). Kein `isTauri()` mehr. `gsr.ts`/`state.svelte.ts`/`persistence.ts`/
die Stream-Components/`VoiceControlBar.svelte` gaten alle auf `isElectron()` (+ ggf.
`isLinux()` + Sidecar-Health). Die `window.pulse`-Shape ist als `Window`-Augmentation in
`web/src/lib/platform/pulse.d.ts` deklariert (`PulseApi`/`PulseStoreApi`/`PulseGsrApi`) —
mit `preload.ts` synchron halten.

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
│   ├── config.py            Settings-Dataclasses (JSON-I/O nicht aktiv — Persistenz im Frontend, siehe persistence.ts)
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
- `streaming/server/mediamtx.yml.template` ist seit **T5a** auf `authMethod: http`
  umgestellt (kein fester Stream-Key mehr, kein `STREAM_KEY_PLACEHOLDER`) — siehe
  "HQ-Streaming-Backend (T5a)". Commit-safe.
- `streaming/server/mediamtx.yml` und `streaming/server/.stream-key` sind in `.gitignore` (Worktree-Root). Im Dev wird die `mediamtx.yml` aus dem Template generiert (bzw. fürs lokale Testen das Template selbst gemountet); der alte feste Stream-Key entfällt.
- Sidecar nimmt den Stream-Token nur transient als Request-Field entgegen; er wird **nicht** persistiert, **nicht** geloggt.

**Was bewusst NICHT mitkopiert wurde:** Qt-UI (`ui/main.py`, `ui/stream_window.py`), Binär-/Build-Artefakte (`mediamtx`-Binary 52 MB, `*.flatpak` 181 MB, `build/`, `.flatpak-builder/`, `*.log`), die generierte `server/mediamtx.yml`, `server/.stream-key`, `bootstrap.fish` (lädt nur MediaMTX-Binary für Lokal-Tests — brauchen wir hier nicht). `packaging/` (Flatpak-Manifest) folgt in T6 als kombiniertes Manifest.

## HQ-Streaming-Backend (T5a)

Per-Channel-HQ-Streaming via MediaMTX. Zwei neue FastAPI-Services (Struktur wie
`voice-signaling`), beide laufen im Dev lokal via `uvicorn` (**nicht** in Docker;
MediaMTX selbst läuft im Dev über `streaming/server/docker-compose.yml`, separat,
`network_mode: host`):

- **`services/media-svc/`** (`dcc-media-svc`, Port **8004**) — vergibt Stream-Tokens,
  hält das Channel↔MediaMTX-Pfad-Mapping (`channel-<channel_id>`, gleiche Konvention
  wie LiveKit-Rooms), pflegt den per-Channel-Stream-State in Redis, published Änderungen
  auf `stream:events`. Hat einen Background-Task (Poller).
  - `POST /channels/{channel_id}/stream-token` — Auth: **Pulse-Access-JWT** (RS256, JWKS
    via `AUTH_JWKS_URL` — wie voice-signaling/chat-gateway). Aufrufer = chat-gateway
    (Service-zu-Service: chat-gateway prüft die Channel-Membership, leitet den User-
    Access-Token weiter; media-svc verifiziert ihn und nimmt `sub` als `user_id`). Body
    optional `{protocol: "rtmp"|"srt"}` (Default rtmp). Response:
    `{token, mediamtx_path: "channel-<id>", push_protocol, push_url, expires_in_s}`.
    `push_url` ist die volle Push-URL inkl. Token:
    RTMP `rtmp://<host>:1935/channel-<id>?user=pulse&pass=<token>`,
    SRT `srt://<host>:8890?streamid=publish:channel-<id>:pulse:<token>`.
    Token = `secrets.token_urlsafe(32)`, TTL `TOKEN_TTL_S` (Default 4 h).
  - `GET /channels/{channel_id}/stream` — `{channel_id, active, user_id?, since?}` aus
    `stream:channel:<id>`.
  - `GET /channels/{channel_id}/whep` — `{whep_url: "<MEDIAMTX_PUBLIC_BASE>/channel-<id>/whep"}`
    (Read ist aktuell anonym, kein Token in der URL).
  - **Poller** (`POLL_INTERVAL_S`, Default 3 s): GET `MEDIAMTX_API_URL`
    (Default `http://localhost:9997/v3/paths/list` — localhost-only, in Dev+Prod
    erreichbar weil media-svc + MediaMTX co-located). Filtert Pfade `channel-<id>` mit
    aktivem Publisher (`source != null` **und** eines von `ready`/`available`/`online`
    True — MediaMTX 1.18 hat `ready` deprecated zugunsten `available`/`online`, wir
    akzeptieren alle). Reconciliation: neuer/laufender Stream → `stream:channel:<id>`
    setzen (`active:true`, `user_id` aus `stream:active:channel-<id>`, `since` ISO8601),
    bei Änderung Event auf `stream:events`; verschwundener Stream → `stream:channel:<id>`
    + `stream:active:channel-<id>` löschen, `active:false`-Event (Self-Heal). Robust
    gegen unerreichbare MediaMTX-API (loggt `mediamtx_poll_failed`, kein Crash).

- **`services/mediamtx-auth-hook/`** (`dcc-mediamtx-auth-hook`, Port **8005**) —
  MediaMTX' `authMethod: http` ruft bei *jeder* Connection `POST /` (auch `POST /auth`)
  hier auf. Body (MediaMTX-1.18-`authHTTP`-Format):
  `{user, password, token, ip, action, path, protocol, id, query}`. Kein DB, kein JWT
  (der Stream-Token ist opak) — nur Redis. Logik:
  - `action in ("api","metrics","pprof")` → 200 (zusätzlich via `authHTTPExclude`
    ausgeschlossen, hier defensiv erlaubt).
  - `action == "publish"`: `path` muss `^channel-\d+$` sein; `password` (fallback `token`)
    = Stream-Token → `stream:token:<token>` in Redis muss existieren, `scope == "publish"`,
    `channel_id` muss zum Pfad passen → 200 (bare 200, kein JSON-Body nötig) **und**
    schreibt `stream:active:channel-<id>` → `{user_id, started_at}` (TTL `PUBLISHER_TTL_SECONDS`,
    Default 6 h, vom Poller gepflegt) damit der Poller den Stream einem User zuordnen kann.
    Sonst → 401.
  - `action in ("read","playback")`: `path` muss `^channel-\d+$` sein → 200 (anonymer Read,
    wie bisher). `# TODO(T5b/later)`: Pulse-Member-Token verlangen + Channel-Membership via
    chat-gateway prüfen.
  - Alles andere / Nicht-`channel-*`-Pfade → 401.

**Redis-Schema (für T5b relevant):**
- `stream:token:<token>` → JSON `{channel_id, user_id, scope:"publish", protocol, created_at}` —
  von media-svc geschrieben (`EX TOKEN_TTL_S`), vom auth-hook gelesen.
- `stream:active:channel-<channel_id>` → JSON `{user_id, started_at}` — vom auth-hook beim
  erfolgreichen publish-OK geschrieben (`EX PUBLISHER_TTL_SECONDS`), vom Poller gelesen/geräumt.
- `stream:channel:<channel_id>` → JSON `{active: bool, user_id?: str, since?: iso8601}` —
  vom Poller gepflegt (`EX CHANNEL_STATE_TTL_S`, Default 6 h Self-Heal). Das ist der
  öffentliche Stream-State (`GET /channels/{id}/stream`).
- **`stream:events`** Pub/Sub → ein Event pro State-Change:
  `{"channel_id": "<id>", "active": true|false, "user_id": "<id>"|null}` —
  analog zu `voice:events`. **T5b** (umgesetzt): chat-gateway abonniert das (wie
  `voice:events` in `ConnectionManager._listen`) und broadcastet
  `{"op":"stream_state", channel_id, user_id, active}` an alle WS-Clients;
  `ready.stream_states` + `GET /guilds/{id}/stream-state` lesen `stream:channel:*`
  direkt aus Redis (media-svc kennt keine Guild→Channel-Map; chat-gateway schon).
  Siehe Abschnitt "HQ-Stream-Presence (T5b)" oben.

Die Redis-Key-Namen sind in `dcc_media_svc/streamkeys.py` und `dcc_mediamtx_auth_hook/shared.py`
**dupliziert** (die zwei Services teilen keinen Code/keine DB — nur diese Namen; synchron halten).

**MediaMTX-Config (`streaming/server/mediamtx.yml.template`):** seit T5a `authMethod: http`,
`authHTTPAddress: http://localhost:8005/`, `authHTTPExclude: [{action: api},{action: metrics},{action: pprof}]`,
`paths: { all_others: }` (auth-hook lehnt Nicht-`channel-*` ab). Keine internen User mehr,
kein fester Stream-Key. Funktioniert dank MediaMTX `network_mode: host` (localhost:8005 vom
Container = Host-localhost, wo der auth-hook via uvicorn lauscht). Die T2-`streaming/server/`-
Doku gilt sonst unverändert — nur die Auth hat sich geändert.

**Service-Start (Dev, Env aus `.env`):**
```bash
# media-svc (8004)
cd services/media-svc && \
REDIS_URL=redis://localhost:6380/0 \
AUTH_JWKS_URL=http://127.0.0.1:8001/.well-known/jwks.json \
MEDIAMTX_API_URL=http://localhost:9997/v3/paths/list \
setsid nohup uv run uvicorn dcc_media_svc.app:app --host 127.0.0.1 --port 8004 \
  > /tmp/dcc-media.log 2>&1 < /dev/null & disown

# mediamtx-auth-hook (8005)
cd services/mediamtx-auth-hook && \
REDIS_URL=redis://localhost:6380/0 \
setsid nohup uv run uvicorn dcc_mediamtx_auth_hook.app:app --host 127.0.0.1 --port 8005 \
  > /tmp/dcc-authhook.log 2>&1 < /dev/null & disown
```
Wenn MediaMTX nicht läuft, loggt der media-svc-Poller nur `mediamtx_poll_failed` und macht
weiter (kein Crash). Den `authHTTP`-Flow live sieht man nur mit laufender lokaler MediaMTX
(`docker compose -f streaming/server/docker-compose.yml up -d`).

**Tests:** `services/media-svc/tests/` (Routes + Poller — MediaMTX wird gemockt, **kein** echter
MediaMTX nötig; Redis-Index `/1`), `services/mediamtx-auth-hook/tests/` (Redis-Index `/1`).

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

- `gsr.ts` — typed Wrapper um `window.pulse.gsr.*`. `gsr.available()` = `isElectron() && window.pulse?.gsr != null`. Alle Methoden returnen `null` außerhalb von Electron (`!gsr.available()`), nicht throwen — der Import ist im Browser sicher. Die exportierte API: `health/gpuInfo/listMonitors/listProfiles/listApplicationAudio/buildArgv/start/stop/state/onEvent/available`.
- `state.svelte.ts` — `$state`-Object `stream = {available, gsrAvailable, running, state, fps, uptimeS, error, lastLog}`, gefüttert aus `gsr.onEvent`. `initStream()` ist idempotent. Event-Format (`{ev:..,...}`) unverändert.
- `web/src/routes/+layout.svelte` ruft `initStream()` in `onMount`. In Browser → No-Op.
- Streaming-Gating: `HqStreamButton.svelte` zeigt sich nur bei `isElectron() && isLinux() && stream.gsrAvailable`; `StreamPanel.svelte` und die Dev-Route gaten auf `gsr.available()`.

**Dev-Test-Route**: `web/src/routes/app/dev/stream/+page.svelte` (`/app/dev/stream` — nicht im Menü). `<StreamPanel />` + Debug-Block (Raw-Health, `build_argv` ohne Start, Live-State). E2E-Check für die Bridge in der Electron-App.

**Sidecar selbst unverändert:** `control.py` musste **nicht** angepasst werden — Request-IDs (`id`-Echo) + `SIGTERM`/`SIGINT`/stdin-EOF-Shutdown sind seit T2 da. `sidecar.ts` baut nur drauf auf.

**Verifikation (E1b/E1c):**
- `cd desktop && pnpm run build:electron` — esbuild bundlet `electron/dist/{main,preload}.cjs` (mit `sidecar.ts` + `store.ts`) ohne Fehler.
- `cd web && pnpm check && pnpm build` — 0 Errors / 0 Warnings (kein `@tauri-apps/*`-Import mehr).
- `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q` — 134/134 grün.
- Node-Sidecar-Standalone: `sidecar.ts` via esbuild → temp-`.cjs` gebundlet, `getSidecar()` lädt, `call('health')` + `call('state')` → IDs gespiegelt, `ok:true`, GSR-Binary gemeldet; `shutdown()` → Exit-Code 0, kein Traceback.
- **Nicht automatisiert verifiziert**: tatsächlicher `start` (würde Portal-Dialog öffnen + an Hetzner pushen), der visuelle Test der Electron-GUI (inkl. Voice + Settings-Persistenz round-trip) — macht der User/Parent.

> **Historisch (abgelöst durch E1b):** Vor der Electron-Migration lief diese Bridge in Rust (`desktop/src-tauri/src/streaming/{mod,sidecar,commands}.rs`, neun `#[tauri::command] gsr_*`, Event-Channel `gsr://event`, ACL-allowlisted in `capabilities/default.json`). Gleiche Idee (lazy spawn, numerische Request-IDs, oneshot-Routing, Event-Forwarding) — wurde in E1c mit dem Rest von `src-tauri/` entfernt.

## Streaming-UI + Voice-View-Integration (T3b/T3c)

Die Pulse-Streaming-UI lebt unter `web/src/lib/stream/`:

- `gsr.ts` — typed Wrapper um die Sidecar-Bridge (`window.pulse.gsr.*` — siehe
  "Desktop ↔ Sidecar-Bridge (Electron — E1b)"). `GsrStartArgs` trägt seit T3c
  zusätzlich `custom_server: {…}` für die nutzer-definierten Server-Targets.
- `state.svelte.ts` — Live-Stream-State (`running/fps/uptime/log/error`).
- `settings.svelte.ts` — User-Picker-Selections + Catalog + GPU-Info-Cache,
  alle Mutations rufen `persistSettings()` (debouncede 300ms-Save).
- `persistence.ts` (T3c; Electron-Pfad seit E1c) — `window.pulse.store.{get,getAll,set}`
  unter Electron (Main-Seite: hand-rolled JSON-Store `<userData>/pulse-stream.json`,
  Linux chmod 700/600 — siehe `desktop/electron/store.ts`) mit `localStorage`-Fallback
  (`pulse.stream`-Key) für den Browser-Pfad. Persistiert: `profile_name`, `server_name`,
  `capture_source`, `audio_mode`, `excluded_apps`, `overrides`, `use_overrides`, `custom_servers`.
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
in `streamSettings.custom_servers` ab, persistiert via die Persistenz-Schicht
(`window.pulse.store.*` unter Electron, `localStorage`-Fallback) + merged in
`available_servers`. `ServerPicker` zeigt Custom-Einträge mit `(custom)`-Tag und
einem Löschen-Knopf. Beim `gsr_start` schickt der Frontend die volle Inline-Spec
als `custom_server: {...}` + `stream_key` — der Sidecar (`control.py::_resolve_server`)
wrappt das zu einem transienten `ServerProfile`. **Stream-Key landet im Klartext
im Store** (`chmod 600` der Store-Datei auf Linux — `desktop/electron/store.ts` —
ist die einzige Hardening-Maßnahme; auf shared Boxen reicht das, ist aber *kein*
Secret-Vault). **Niemals `console.log(...)` mit Stream-Key oder Token.**

**Voice-View-Integration (T3c):** `VoiceControlBar` rendert `<HqStreamButton />`
zwischen Screenshare-Toggle und Verlassen-Button. Der Button rendert *nur*
wenn `isElectron() && isLinux() && stream.gsrAvailable`
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

## HQ-Stream im Frontend (T4)

Die Frontend-Seite des per-Channel-HQ-Streamings (Backend = T5a media-svc/auth-hook,
T5b chat-gateway — fertig; T4 *konsumiert* deren API):

- **`web/src/lib/stores/streamPresence.svelte.ts`** — analog zum Voice-Presence-Store,
  `$state`-Map `channelId → { active, userId }` (nur aktive Streams). Methoden:
  `streamingUser(channelId)` (Snowflake des Publishers oder null),
  `isStreaming(channelId)`. Gefüttert aus: dem `ready`-Payload-Feld
  `stream_states: [{channel_id, user_id}, ...]` → `seed()` (ersetzt die ganze Map;
  kommt bei *jedem* (Re)connect, deckt also den Reconnect-Re-Sync ab), dem WS-Push
  `{op:"stream_state", channel_id, user_id, active}` → `apply()`, und optional
  `GET /api/chat/guilds/{id}/stream-state` (`chatApi.getGuildStreamState`) für einen
  expliziten Re-Sync. Distinkt von `voicePresence.streamingByChannel` (das ist der
  LiveKit-*Screenshare*-Track im Call, nicht der GSR/WHEP-Stream). `ws/connection.ts`
  seedet im `ready`-Handler + dispatcht `stream_state` an den Store (genau wie
  `voice_state`).
- **`web/src/lib/api/chat.ts`** — drei neue Calls (`fetch`-Wrapper mit Auth-Header,
  wie der Rest): `getStreamToken(channelId, protocol='rtmp')` →
  `{token, mediamtx_path, push_protocol, push_url, expires_in_s}` (chat-gateway
  `POST /channels/{id}/stream-token`, membership-gated → media-svc), `getWhepUrl(channelId)`
  → `{whep_url}` (anonymer Read), `getGuildStreamState(guildId)` → `StreamChannelState[]`.
- **`web/src/lib/stream/whep.ts`** — hand-rolled WHEP-Client (~120 Z., keine neue Dep):
  `RTCPeerConnection` + `addTransceiver('video'|'audio', recvonly)` → `createOffer` →
  `setLocalDescription` → ICE-Gathering abwarten (non-trickle, 2 s-Timeout-Fallback) →
  `POST <whepUrl>` mit `Content-Type: application/sdp` (Body = Offer-SDP) → Response-Body
  = Answer-SDP, `Location`-Header = Resource-URL → `setRemoteDescription`. `close()` →
  `pc.close()` + best-effort `DELETE <resourceUrl>`. Public-STUN als Default (harmlos bei
  MediaMTX-host-Networking). Pattern aus `~/Dokumente/GPU_Screen_Recorder/server/player.html`
  (READ-ONLY, funktioniert gegen genau diese MediaMTX 1.18) — übernommen, nicht kopiert.
- **`web/src/lib/stream/components/WhepPlayer.svelte`** (≤250 Z.) — Props `{ channelId }`,
  holt die WHEP-URL selbst (`chatApi.getWhepUrl`), spielt sie ab. `<video autoplay playsinline>`
  *nicht* gemuted (Stream-Viewer will Ton) → bei Autoplay-Block ein "Ton aktivieren"-Overlay
  (wie das LiveKit-`audioBlocked`-Overlay). Retry mit Backoff bei 404 (Publisher noch nicht da)
  / Netzfehler / `connectionState === 'failed'`. Cleanup bei Unmount/Channel-Wechsel
  (`teardown()` + `runChannelId`-Guard gegen stale async). Kleines Stats-Overlay
  (Auflösung/FPS/Bitrate via `getStats()`).
- **`web/src/lib/components/VoiceChannelView.svelte`** — wenn `streamPresence.isStreaming(channel.id)`
  und man im Channel verbunden ist: bekommt der HQ-Block den großen Content-Bereich (wo sonst
  die Participant-Tiles / `ScreenShareTile` sind), Tiles rutschen als schmaler Streifen nach unten.
  Streamer ist **jemand anderes** → `<WhepPlayer channelId={channel.id} />` + Label
  "🔴 {Username} streamt (HQ)". Streamer bin **ich selbst** → kein WHEP-Playback (kein Selbst-Echo),
  nur ein Indikator "🔴 Du streamst (HQ)" + ein "Stream beenden"-Button (`gsr.stop()`). `data-testid`s:
  `hq-stream-area`, `hq-stream-label`, `hq-stream-player`, `hq-stream-self-indicator`, `hq-stream-stop-btn`,
  `hq-stream-unblock-audio`, `hq-stream-stats`. `HqStreamButton`-Live-Dot geht auch an wenn der
  WS-Broadcast einen aktiven Stream im aktuellen Channel meldet (nicht nur bei `stream.running`).
- **Channel-Modus im StreamPanel:** `streamSettings.target: 'channel' | 'server'` (neu, *nicht*
  persistiert — kontextabhängig; `StreamPanel` setzt's beim Mount auf `'channel'` wenn ein
  `channelId` durchgereicht wurde, sonst `'server'`). `StreamPanel` kriegt `channelId` als Prop
  (`VoiceControlBar` → `HqStreamButton` (= `voice.channelId`) → `HqStreamDialog` → `StreamPanel`).
  Neue `StreamTargetPicker.svelte`: Segment "Stream-Ziel: [Dieser Channel] | [Eigener Server]" —
  "Dieser Channel" nur sichtbar wenn `channelId` da ist. Im Channel-Modus ist der `ServerPicker`
  ausgeblendet (kein Server-Picker nötig). `buildStartArgs(streamKey?, channelArg?)` hat einen
  `channel`-Branch: bei `target==='channel'` + `channelArg` → `channel: {id, token,
  mediamtx_endpoint?, push_protocol?}` (statt `server`/`custom_server`). `StreamControls`
  (Prop `channelId`): im Channel-Modus holt der Start-Klick erst `chatApi.getStreamToken(channelId)`,
  extrahiert das `host[:port]` aus `push_url` (`mediamtxEndpointFromPushUrl`) als
  `channel.mediamtx_endpoint`, dann `gsr.start(buildStartArgs(undefined, {channelId, token,
  mediamtxEndpoint, pushProtocol}))`. Fehler (403 nicht-Member, 400 kein Voice-Channel, 502/503
  media-svc down …) → `toast.error` (svelte-sonner). Der Streamer meldet chat-gateway **nichts** —
  media-svc's Poller erkennt den Publisher und broadcastet `stream_state`; der Stream-Indikator
  (auch beim Streamer selbst) kommt über den WS. Der Sidecar (`streaming/gsr-sidecar`) versteht
  den `channel`-Modus seit T2; `gsr.ts::GsrStartArgs.channel` + `pulse.d.ts`/preload reichen ihn
  generisch durch — keine Electron-Änderung nötig.
- **Tests:** Backend unverändert (`pytest -q` 177/177). Frontend hat keine Vitest-/Unit-Tests
  (nur Playwright-E2E) → `pnpm check` (0/0) + `pnpm build` + Code-Review. **Der E2E-Test
  (echter Stream → anderer User sieht den WHEP-Player) muss manuell gemacht werden** — braucht
  laufende media-svc + mediamtx-auth-hook + lokale/Prod-MediaMTX + zwei eingeloggte Clients +
  einen echten GSR-Push (Portal-Dialog).

## Produktiv-Deployment (Hetzner-VPS)

Läuft seit 2026-05-12 auf `michael@77.42.71.166` (neben Caddy + den anderen Apps), erreichbar
unter **https://pulse.unicutmedia.com**. Ein einziger Compose-Stack (`name: pulse`) in
`~/pulse/infra/prod/` auf dem Server: `pulse_postgres` + `pulse_redis` (eigene DB/Cache, eigene
Volumes — nichts geteilt), `pulse_auth`/`pulse_chat_gateway`/`pulse_voice_signaling`/
`pulse_media_svc`/`pulse_mediamtx_auth_hook`/`pulse_web` (GHCR-Images `ghcr.io/oblivion8282-1337/pulse-*:latest`),
`pulse_migrate_auth`/`pulse_migrate_chat` (Init-Container `alembic upgrade head`), `pulse_mediamtx` +
`pulse_livekit` (`network_mode: host`, gepinnt), `pulse_watchtower` (`--scope pulse`, 5-Min-Intervall).
- **Routing:** Caddy (`~/caddy/Caddyfile`, Block `pulse.unicutmedia.com { reverse_proxy host.docker.internal:8100 }`,
  LE-Cert) → `pulse_web` nginx (`infra/prod/web-nginx.conf`, im Image gebacken) → `/api/auth|chat|ws|voice/*`
  an die Services, `/whep/*`+`/hls/*` an MediaMTX (`host.docker.internal:8889/8888`), `/livekit/*` an LiveKit
  (`:7880`, WS), sonst die SvelteKit-SPA.
- **Auto-Update:** push → `main` → `.github/workflows/ci.yml` baut+pusht die 6 Images nach GHCR (`:latest`+`:sha`,
  nach grünen Tests) → `pulse_watchtower` zieht `:latest` ≤5 min später. Struktur-Änderungen (neuer Service, neue
  Env-Var, Compose-/nginx-/MediaMTX-/LiveKit-Config): `rsync infra/ → ~/pulse/infra/` + `cd ~/pulse/infra/prod && docker compose up -d`.
- **Secrets:** nur auf dem Server in `~/pulse/infra/prod/.env` (gitignored, aus `.env.example`) + `~/pulse/infra/prod/secrets/jwt_*.pem`.
  Die PEM-Files **müssen `chmod 0644`** sein (Container laufen als uid 10001). LiveKit-Keys: Name `pulse-prod`
  (fix in `livekit.yaml` + `LIVEKIT_API_KEY`), Secret via `LIVEKIT_KEYS` env aus `.env`.
- **Firewall:** offen sein müssen `1935/tcp` (RTMP), `8890/udp` (SRT), `8189/udp` (MediaMTX-ICE), `7881/tcp` +
  `7882:7892/udp` (LiveKit-RTC). 80/443 sind schon offen (Caddy). `sudo ufw allow ...` braucht das User-Passwort.
- **Electron-App:** der gepackte Build lädt `https://pulse.unicutmedia.com` (remote — Web-Fixes sofort sichtbar);
  der GSR-Sidecar läuft lokal über die `window.pulse`-Bridge.
- Vollständige Schritte + Operating-Befehle: `infra/prod/DEPLOY.md`. Caddyfile auf dem Server wurde angepasst (Backup `~/caddy/Caddyfile.bak.*`).

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
| media-svc | 8004 | `uvicorn dcc_media_svc.app:app` (T5a — Stream-Tokens + Stream-State + Poller) |
| mediamtx-auth-hook | 8005 | `uvicorn dcc_mediamtx_auth_hook.app:app` (T5a — MediaMTX `authHTTP`-Delegation) |
| web (Vite dev) | 5173 | `http://127.0.0.1:5173` |
| LiveKit | 7880 | HTTP/Signalling; 7881 + 7882–7892/UDP für RTC. `network_mode: host`, direkt auf Host-Interfaces |
| MediaMTX | 1935/8888/8889/8890/8189/9997 | RTMP/HLS/WebRTC-WHEP/SRT/WebRTC-ICE/API — `streaming/server/docker-compose.yml`, `network_mode: host`. API (9997) nur localhost. Auth → `authHTTP` → mediamtx-auth-hook (8005) |

### Service-Start (Env aus `.env`)
- chat-gateway / auth: `POSTGRES_PASSWORD`, `JWT_PRIVATE_KEY_FILE` + `JWT_PUBLIC_KEY_FILE`
  (absolute Pfade zu `secrets/jwt_*.pem`), `REDIS_URL=redis://localhost:6380/0`,
  `AUTH_JWKS_URL=http://127.0.0.1:8001/.well-known/jwks.json`. chat-gateway zusätzlich
  `MEDIA_SVC_URL=http://127.0.0.1:8004` (T5b — der media-svc-Proxy für Stream-Tokens/WHEP;
  fehlt der, defaultet's eh auf genau das; läuft media-svc nicht, gibt `POST /channels/{id}/stream-token`
  ein 502, der Rest läuft normal weiter).
- **chat-gateway neu starten** (überlebt Agent-Shutdown):
  ```bash
  pkill -f "uvicorn dcc_chat_gateway"
  cd services/chat-gateway && \
  POSTGRES_PASSWORD=... REDIS_URL=redis://localhost:6380/0 \
  AUTH_JWKS_URL=http://127.0.0.1:8001/.well-known/jwks.json \
  MEDIA_SVC_URL=http://127.0.0.1:8004 \
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
- ❌ Tauri für den Desktop-Wrapper (Pivot 2026-05-12 → Electron, §17 / E1 — WebKitGTK-WebRTC zu unzuverlässig für LiveKit) · ❌ `electron-store` als Dep (ESM-only in neueren Versionen → CJS/ESM-Friktion mit dem esbuild-Bundle; der hand-rolled Store in `desktop/electron/store.ts` reicht) · ❌ React-Bridge in SvelteKit für LiveKit-React-Components
- ❌ `@livekit/krisp-noise-filter` (kostenpflichtig seit 2026-05-01) · ❌ `svelte-french-toast` (Sv5-inaktiv) · ❌ `svelte-markdown` blind (kein Sanitizer)
- ❌ Exactly-once-Delivery anstreben · ❌ Re-Publishing MediaMTX→LiveKit (Transcoding zu teuer)
- ❌ Routes-/Service-Dateien über die Größen-Grenze wachsen lassen statt zu splitten
