# Claude-Notizen für dieses Projekt

Projekt: **Pulse — Web-First Discord-artiger Chat + Voice + HQ-Screen-Streaming**.
Monorepo: uv-Workspace (Backend) + pnpm-Workspace (`web`, `desktop`).
Vollständige Architektur + History: `PLAN.md`, `infra/prod/DEPLOY.md`, `streaming/README.md` und `git log`.
**Hier nur die nicht-offensichtlichen Dinge.**
Alle Stages (Etappe 1/1.5/2, HQ-Streaming, Electron-Pivot, Flatpak) sind auf `main` — kein Worktree mehr.

## Was das Projekt macht

Chat/Voice-Client, **Web-First** (alle Browser), PWA-installierbar, Desktop via **Electron** (`desktop/`).
Backend = mehrere kleine FastAPI-Services: `services/{auth,chat-gateway,voice-signaling,media-svc,mediamtx-auth-hook}`.
Voice über LiveKit (WebRTC/Opus). HQ-Screen-Streaming bindet den vendored GPU Screen Recorder
(`streaming/`) als Python-Sidecar ein, pusht über RTMPS an MediaMTX → Viewer holen den Stream per WHEP.

Drei Transportpfade, getrennt: HTTPS/WSS → FastAPI-Services · WebRTC → LiveKit (Voice + Browser-Screenshare)
· WHEP/WebRTC → MediaMTX (GSR-HQ-Streams). Details `PLAN.md` §1.

`~/Dokumente/GPU_Screen_Recorder/` ist **READ-ONLY** (Original) — `streaming/` ist eine vendored Kopie (2026-05-11), nur die wird modifiziert.

## Tech-Stack (verifiziert aus uv.lock / pnpm-lock.yaml / package.json — kein Raten)

### Tooling / Runtimes
- **Python** 3.14.4 (`>=3.13,<3.15`) · **uv** 0.11.11 · **Node** v25.9.0 · **pnpm** 10.33.0
- Ruff `line-length=100`, `target-version=py313`, `ignore=["E501"]`

### Backend (`services/*` + `shared/`)
| Lib | Version | Notiz |
|---|---|---|
| FastAPI | 0.136.1 (`>=0.115,<0.137`) | |
| uvicorn[standard] | 0.46.0 | |
| SQLAlchemy[asyncio] | 2.0.49 (`>=2.0.40,<2.1`) | async ORM, **eigenes Schema pro Service** (`auth`/`chat`) |
| asyncpg 0.31.0 / aiosqlite 0.22.1 | | Postgres (Prod) / SQLite (nur Tests) |
| Alembic | 1.18.4 | Migrationen pro Service unter `alembic/versions/` |
| pydantic 2.13.4 / pydantic-settings 2.14.1 | | |
| pyjwt[crypto] | 2.12.1 | RS256. **`PyJWKClient.from_jwks` gibt's hier noch nicht** → Eigenbau via `RSAAlgorithm.from_jwk` in `security.py` |
| cryptography 48.0.0 · argon2-cffi 25.1.0 | | argon2 = Passwort-Hashing (Argon2id t=3/m=64MiB/p=4) |
| redis | 7.4.0 | async; ConnectionManager nutzt `psubscribe` + `get_message()`-Poll (kein `listen()`-Race) |
| livekit-api | 1.1.0 | Token-Issue im voice-signaling |
| httpx 0.28.1 · structlog 25.5.0 · websockets 16.0 | | |
| slowapi | lockfile | Rate-Limit in auth-svc (**in-process!**) |
| email-validator | lockfile | blockt special-use-TLDs → Tests nutzen `dcc-test.example.com`, nicht `*.test` |
| pytest 9.0.3 · pytest-asyncio 1.3.0 | | `--import-mode=importlib`, `asyncio_mode=auto` |

### Frontend (`web/`, SvelteKit-SPA, `ssr=false`, `adapter-static`)
| Lib | Version | Notiz |
|---|---|---|
| @sveltejs/kit 2.59.1 · svelte 5.55.5 | | Runes-API (`$state`/`$derived`) |
| @sveltejs/adapter-static 3.0.10 | | Build → `web/build/` → `pulse_web`-nginx-Image. Die Electron-App lädt die *deployte* Web-App remote, nicht `web/build/` |
| @sveltejs/vite-plugin-svelte 7.1.2 · vite 8.0.11 | | Vite-Dev-Proxy: `/api/auth`→:8001 · `/api/chat`+`/api/ws`→:8002 · `/api/voice`→:8003 |
| typescript 5.9.3 (strict) | | |
| tailwindcss 4.3.0 | | + `@tailwindcss/vite`; shadcn-Semantik-Tokens im `.dark{}`-Block |
| valibot 1.4.0 | | API-Response-Validation |
| shadcn-svelte 1.2.7 / bits-ui 2.18.1 | | Components unter `web/src/lib/components/ui/` (Vendor — von der Größen-Policy ausgenommen) |
| livekit-client 2.18.9 | | `lib/voice/livekit.svelte.ts` abonniert rohe `Room`/`Participant`-Events (kein `@livekit/components-core`-Wrapper, obwohl installiert & ungenutzt) |
| @sapphi-red/web-noise-suppressor 0.3.5 | | Mic-Filter = RNNoise → NoiseGate (`lib/voice/noiseFilter.ts::RnnoiseGatedTrackProcessor`). UI bietet nur Aus/An; bei An: dB-Slider für die Gate-Open-Schwelle (close = open − 5 dB, hold 200 ms). **`MediaStreamDestinationNode.channelCount = 1` zwingend setzen** — Default ist Stereo + `channelCountMode "explicit"` → mono-Worklet füllt nur output[0], rechter Kanal stumm. |
| @svelte-put/shortcut 4.1.0 | | In-Window-PTT-Hotkey (Taste aus `settings.voice.pttKey`) |
| svelte-sonner 1.1.1 · @lucide/svelte 1.14.0 | | Toasts / Icons |
| @fontsource-variable/plus-jakarta-sans 5.2.8 | | UI-Font; `@fontsource-variable/inter` als Fallback |
| mode-watcher 1.1.0 | | Light/Dark/System; `setMode()` aus `settings.svelte.ts`, persistiert in `dcc.settings`; FOUC-Inline-Script in `app.html` |
| @playwright/test 1.59.1 · svelte-check 4.4.8 | | E2E (`web/tests/e2e/`, globalSetup startet auth+chat als child-procs) / `pnpm check` |

### Desktop (`desktop/`, Electron — `@dcc/desktop`, pnpm-Workspace-Member)
| Lib | Version | Notiz |
|---|---|---|
| electron | 42.0.1 (gepinnt) | bundlet Node 22.x. **Kein `postinstall`** — Binary wird beim ersten `require('electron')` lazy gezogen |
| esbuild | 0.28.0 | bundlet `electron/{main,preload}.ts` (zieht `sidecar.ts`+`store.ts` via Import mit) → `electron/dist/*.cjs` (`build:electron`). In root-`pnpm.onlyBuiltDependencies` |
| @types/node | ^22.7.5 | |

`desktop/package.json` ist CJS (**ohne** `"type":"module"`), `"main":"electron/dist/main.cjs"`.
Scripts: `build:electron` (esbuild) · `dev` (= build + `PULSE_DEV_URL=:5173 electron .` gegen Vite) ·
`prod` (= build + `electron .` ohne Env → lädt `https://pulse.unicutmedia.com`, keine DevTools) · `start` (`electron .` ohne Rebuild).
DevTools nur bei `PULSE_DEVTOOLS=1` oder Strg+Shift+I. Build-Check ohne GUI: `cd desktop && pnpm run build:electron`.
Voice funktioniert im Electron-Fenster (Chromium-WebRTC) — das war der Grund für den Tauri→Electron-Pivot.

### Infra
- Dev: `docker-compose.yml` — Postgres `postgres:16-alpine`, Redis `redis:7-alpine`, LiveKit `livekit/livekit-server:latest`
  (hinter `docker compose --profile voice up -d`, **`network_mode: host`** — s.u.). MediaMTX läuft *separat* über
  `streaming/server/docker-compose.yml` (`network_mode: host`).
- Prod: siehe „Produktiv-Deployment".

## Architektur — die nicht-offensichtlichen Stücke

**Snowflake-IDs als Strings über die API-Grenze** (REST-Bodies, WS-Messages, Responses). JS `Number` kann 64-bit
nicht exakt darstellen. Backend-Schemas haben einen `SnowflakeId`-`BeforeValidator` (int *oder* string); Frontend
sendet immer string. Format `[42-bit ms ab 2026-01-01][10-bit worker][12-bit seq]`, Worker-IDs auth=1/chat=2/voice=3.

**Services kommunizieren nur über Redis Pub/Sub oder HTTP** — niemals shared DB-Tabellen.
chat-gateway-Routes = APIRouter-Module unter `services/chat-gateway/src/dcc_chat_gateway/routes/`.

**WS-Auth**: Access-Token als Query-Param (`/ws?token=…`) — Browser-WebSocket-API kann keine Custom-Header.
Expired/ungültig → close Code 4001.

**LiveKit/MediaMTX `network_mode: host`**: die Host-UFW (`INPUT DROP`) blockt Container→Host-Traffic über die
Bridge; nur mit host-Networking erreichen LiveKit `127.0.0.1:8003` (Webhooks) bzw. MediaMTX den auth-hook
(`localhost:8005`) und media-svc die MediaMTX-API (`localhost:9997`).

**Bootstrap-Admin** (2026-05-18): `POST /register` setzt `is_admin=true` automatisch wenn der grad erstellte User der einzige in `auth.users` ist (`COUNT(*) == 1` nach flush). Pattern wie Mastodon/Gitea/Forgejo — Self-Hoster registriert sich zuerst, hat sofort Zugriff auf `/app/admin`, weitere Admins kommen über das Admin-Panel. Race-Mode (zwei parallele Registrierungen) akzeptiert, kostet selten echte Probleme. Vor dem Patch musste man via `docker exec ... psql -c "UPDATE auth.users SET is_admin=true WHERE username='…'"` bootstrappen.

**`allow_guild_creation` default = FALSE** (Migration 0010, 2026-05-18): Fresh-Deploys sind locked-down — nur der Bootstrap-Admin kann Server anlegen. Admin öffnet's via `/admin/permissions` für alle Member. Vorher war's `true` (= Public-Discord-Modell), was für Self-Host falsche Default-Annahme war. `allow_member_invites` bleibt `true` — das ist per-guild-scoped via `CREATE_INVITES`-Permission, nicht global. Test-Convenience: `services/chat-gateway/tests/conftest.py` seedet die Singleton mit `allow_guild_creation=true` (sonst müssten 80% der Tests erst durch den admin-Toggle gehen).

**Permissions** (Voll-Discord, 2026-05-18):
- Bitfield in `dcc_shared/permissions.py` — `Permissions(IntFlag)` mit 23 Bits in 52-Bit-Budget (JS-Number-safe), bewusst Gaps zwischen Gruppen (Server-Admin 0-4, Member 8-12, Channel 20-27, Voice 30-36, ADMIN 51) für spätere Erweiterung. `GRANT_ALL_SAFE = (1<<52)-1` — Owner/ADMIN resolven dahin (NICHT `~0`), damit reserved bits Null bleiben.
- Resolver in `dcc_shared/permission_resolver.py` ist pure-Python + DB-agnostisch via `PermissionContext`-Protocol. Discord-Formel `final = (base | allow) & ~deny`, !VIEW_CHANNEL→revoke_all-Invariante (kann nicht "darf schreiben aber nicht sehen" geben → Exploit-Schutz). @everyone wird über `is_everyone`-Flag implizit als erstes appliziert, dann role-overwrites in position-order, zuletzt user-overwrite.
- 3 DB-Tabellen (chat-gateway): `roles` (mit `is_everyone` partial unique index), `member_roles` (M:N + composite-FK auf guild_members für CASCADE), `permission_overwrites` (target_type 0=role/1=user). Migration 0009 seedet `@everyone` per existierender Guild mit `DEFAULT_EVERYONE_PERMISSIONS`. POST /guilds auto-seedet die @everyone-Rolle bei neuen Guilds (sonst broken-state vor erstem Resolver-Call).
- Adapter `dcc_chat_gateway/permissions.py`: `check_permission()`, `resolve_permissions()`, `assert_overwrite_within_editor_scope()` (Anti-Escalation — Editor muss jedes Bit selbst halten, das er grantet oder un-deny't).
- Routes: `/guilds/{id}/roles` (CRUD), `/guilds/{id}/roles-positions` (bulk reorder), `/guilds/{id}/members/{uid}/roles/{rid}` (assign/unassign), `/guilds/{id}/member-roles` (bulk `{uid: [rid]}` für die MemberList — vermeidet N+1), `/channels/{id}/permissions[/{type}/{tid}]` (overwrites), `/guilds/{id}/transfer-ownership` (Owner-only, `confirm_name`-Gate, no-undo), `/guilds/{id}/permissions/me` (resolved bitfield).
- WS: `ready.guilds[].{roles[], my_role_ids[], my_permissions, owner_id}` eager-geladen; lazy-load der Channel-Overwrites pro Channel beim Öffnen. Events: `role_created/updated/deleted`, `member_roles_updated` (hint ohne payload — receiver re-fetched), `channel_permissions_updated`. `ConnectionManager` filtert `chat:channel:*`/`voice:events`/`stream:events`/`watch:events` durch `_filter_by_view_channel` (DM-Channels passieren ungehindert — kein Permission-Overlay). Per-Socket `_ws_perms`-Cache lazy-fill, invalidiert auf relevant ops.
- Frontend: `lib/permissions/bitfield.ts` mirrored den Python-Resolver mit BigInt. Stores `roles.svelte.ts`/`channelPermissions.svelte.ts`/`memberRoles.svelte.ts` mit `seedAll`/`ensure`/`recomputeGuild`. UI-Gates: `roles.hasGuildPermission(gid, Perm.X)`. Settings-Modal `GuildSettingsDialog.svelte` (Rollen + Member-Assignment + Owner-Transfer), Channel-Permissions auf `/channels/{cid}/permissions/+page.svelte`. Drag-Drop + Chevron-Up/Down Buttons (Touch/A11y) für Position-Reorder. MemberList gruppiert nach Top-Hoist-Role, Username-Farbe = Top-Color-Role.
- **Server-Delete + Owner-Transfer bleiben Owner-only** (kein MANAGE_GUILD-Bypass; ADMIN-Globalflag bypasst Delete aber NICHT Transfer). MANAGE_GUILD ist nur rename/icon/settings.

**Voice-Presence** (wer ist im Voice-Channel): LiveKit-Webhooks → voice-signaling `POST /webhook` (Signatur via
`livekit.api.WebhookReceiver`, Key `devkey` = `webhook:`-Block in `infra/livekit/livekit.yaml`) → pflegt Redis-Sets
`voice:room:channel-<id>` (TTL 6h, Self-Heal) → published auf `voice:events`. chat-gateway abonniert das im
`ConnectionManager` → broadcastet `{"op":"voice_state","channel_id":..,"user_ids":[..]}`; `ready`-Payload trägt
`voice_states` → Re-Sync nach Reconnect läuft über den `ready`-Frame (das Backend bietet auch
`GET /guilds/{id}/voice-state` an, hat aber keinen aktiven Frontend-Consumer).

**HQ-Streaming** (per-User-Pfade — mehrere können in denselben Voice-Channel streamen):
- `media-svc` (8004): vergibt Stream-Tokens (`POST /channels/{cid}/stream-token`, Auth = Pulse-Access-JWT, von
  chat-gateway nach Membership-Check weitergereicht; Token = `secrets.token_urlsafe(32)`, EX 4h), hält den
  Stream-State in Redis, published auf `stream:events`, hat einen Poller gegen `MEDIAMTX_API_URL`
  (default `localhost:9997/v3/paths/list`, 3s) der Publisher erkennt + den State self-healt. `GET /channels/{cid}/whep?user_id=<uid>` → `{whep_url}` (anonymer Read).
- `mediamtx-auth-hook` (8005): MediaMTX' `authMethod: http`-Delegation (kein DB/JWT, nur Redis). Publish: Pfad
  `^channel-(\d+)-(\d+)$`, `password`/`token` muss `stream:token:<token>` matchen (`scope=="publish"`, `channel_id`+`user_id` müssen zum Pfad passen) → 200 + schreibt `stream:active:channel-<cid>-<uid>`. Read/playback: anonym, nur Pfad-Check. Alles andere → 401.
- Redis: `stream:token:<token>` (von media-svc, EX 4h), `stream:active:channel-<cid>-<uid>` (vom auth-hook beim
  publish-OK, EX 6h), `stream:channel:<cid>` → `{user_ids:[...], since}` (vom Poller, EX 6h Self-Heal).
  `stream:events` Pub/Sub: `{channel_id, user_ids:[...]}` pro State-Change. Key-Namen sind in
  `dcc_media_svc/streamkeys.py` + `dcc_mediamtx_auth_hook/shared.py` **dupliziert** (die Services teilen keinen Code — synchron halten).
- chat-gateway: abonniert `stream:events` (neben `voice:events`) → broadcastet `{"op":"stream_state","channel_id":..,"user_ids":[..]}`;
  `ready.stream_states` liest `stream:channel:*` direkt aus Redis (analog `GET /guilds/{id}/stream-state`, das Backend
  bietet den Endpoint an, aber das Frontend re-synced ausschließlich über `ready`). Zwei
  Membership-gateete media-svc-Proxies: `POST /channels/{id}/stream-token` (Channel existiert + User=Member + Channel
  ist Voice-Channel) und `GET /channels/{id}/whep?user_id=<uid>`. Braucht `MEDIA_SVC_URL` (Dev `http://127.0.0.1:8004`;
  fehlt media-svc → 502 nur auf diesen Routen, Rest läuft).
- Push geht über **RTMPS** (`rtmps://<host>:1936/...`, Token nicht im Klartext) — MediaMTX `rtmpEncryption: optional`
  (plain :1935 bleibt funktionsfähig), self-signed Cert als Host-Volume (`/certs/server.{crt,key}`), UFW `1936/tcp`.
- Frontend: `web/src/lib/stores/streamPresence.svelte.ts` (`byChannel: channelId→string[]`, `streamersIn()/isStreaming()`,
  gefüttert aus `ready.stream_states` + WS-`stream_state`), `web/src/lib/stream/whep.ts`
  (hand-rolled WHEP-Client, ~120 Z., keine neue Dep — Pattern aus dem GSR-`player.html`), `stream/components/WhepPlayer.svelte`
  (Props `userId`+`name`, Retry-Backoff, „Ton aktivieren"-Overlay bei Autoplay-Block, Stats-Overlay),
  `components/VoiceChannelView.svelte` (HQ-Streams + Browser-Screenshares in einem responsiven Grid; ein `WhepPlayer`
  pro fremdem Streamer; eigener Stream → kein Self-Echo, nur Indikator + „Stream beenden"). `gsr.ts`/`state.svelte.ts`/
  `HqStreamButton`/`StreamPanel` gaten auf `isElectron() && (isLinux() || isWindows()) && stream.gsrAvailable`
  (Windows hat einen eigenen Rust-Sidecar — s.u. **Windows-HQ-Sidecar**).
- HQ-Panel ist abgespeckt: nur Codec(H.264/AV1)/Auflösung (Native/1080p/720p/480p, downscale-only)/Bitrate/FPS + Audio
  (inkl. „Bestimmte App" → `audio_mode="App: <name>"` → GSR `-a app:<name>`) + Start/Stop + Log. Pfad/Modus immer Channel/Portal.

**Desktop ↔ Sidecar-Bridge**: Electron-Main spawnt den Plattform-Sidecar **lazy** beim ersten `gsr:call` aus dem
Renderer — Linux = Python (`streaming/gsr-sidecar/control.py`), Windows = Rust-Binary
(`streaming/win-hq-sidecar/target/release/pulse-win-hq-sidecar.exe`); beide sprechen das **gleiche stdio-JSON-RPC-
Protokoll** (s. **Sidecar-Protokoll**). `desktop/electron/sidecar.ts` (`SidecarManager`, Singleton via
`getSidecar()`): `child_process.spawn`, readline auf stdout, Request/Reply via numerische `id`, Events
(`{"ev":..}`, kein id) → `webContents.send('gsr:event', ev)`. Path-Resolver pro Plattform:
- Linux: `$PULSE_SIDECAR_PY` → Walk-up von `dist/` bis `streaming/gsr-sidecar/control.py` → Flatpak-Default
  `/app/share/pulse/gsr-sidecar/control.py`. `pythonBin = $PULSE_PYTHON ?? 'python3'`.
- Windows: `$PULSE_HQ_SIDECAR` → Walk-up auf `streaming/win-hq-sidecar/target/release|debug/pulse-win-hq-sidecar.exe`
  → `%LOCALAPPDATA%\Pulse\hq-sidecar\pulse-win-hq-sidecar.exe`. Kein Python — Rust-Bin ist standalone (FFmpeg-DLLs
  neben der exe).

`shutdown()`: stdin schließen (Sidecar-Loop endet auf EOF, stoppt laufenden GSR/WGC) → 1.5s → SIGTERM → 2s → SIGKILL.
Renderer-API = `window.pulse.gsr.*` (`health/gpuInfo/listMonitors/listProfiles/listApplicationAudio/buildArgv/start/stop/state/onEvent/available`,
alle async, geben das rohe Response-JSON zurück bzw. werfen bei `ok:false`/Timeout — `start` 60s, `stop` 15s, sonst 10s).
Shape in `web/src/lib/platform/pulse.d.ts` deklariert — **mit `preload.ts` synchron halten**. `control.py` selbst ist
seit T2 unverändert (Request-ID-Echo + SIGTERM/SIGINT/stdin-EOF-Shutdown waren schon da).

**Sidecar-Protokoll** (stdio, newline-JSON, voll in `streaming/README.md`): Request `{"op":..,"id":..?,..}` → Response
`{"id":..,"ok":bool,..}`; Async-Event `{"ev":..,..}`. Ops: `health gpu_info list_monitors list_profiles list_application_audio
build_argv start stop state`. Events: `state`(`idle|starting|live|error|stopped`) `fps log error stopped`. `start`/`build_argv`
nehmen `channel:{id,token,mediamtx_endpoint?,push_protocol?}` (Pulse-Pfad, MediaMTX-Pfad `channel-<cid>-<uid>`) oder
`server:"<name>"`+`stream_key`. Testen ohne realen Stream:
`printf '{"op":"health","id":1}\n{"op":"build_argv","id":2,...}\n' | python3 streaming/gsr-sidecar/control.py` —
**KEIN `{"op":"start"}` im Test** (öffnet Wayland-Portal-Dialog + streamt wirklich); `build_argv` baut nur die argv ohne zu starten.

**GSR-Binary-Resolver**: `$GSR_BINARY` → Flatpak (`/app/bin/gpu-screen-recorder` wenn `/.flatpak-info`/`$FLATPAK_ID`)
→ Custom-Build (`$XDG_CACHE_HOME/pulse/gsr/gpu-screen-recorder/build/gpu-screen-recorder` von `streaming/bootstrap-gsr.fish`,
Legacy-Fallback `/tmp/gsr-analysis/...` — wandert beim nächsten Bootstrap mit) → PATH. Fehlt alles
→ `health.gsr.available=false` (kein Crash). Persistenter Cache-Pfad überlebt Reboots; `/tmp` war tmpfs, da war HQ nach jedem Reboot weg.

**Windows-HQ-Sidecar** (`streaming/win-hq-sidecar/`): Rust-Bin (Cargo, Edition 2024), spricht dasselbe stdio-JSON-RPC
wie der Linux-GSR-Sidecar — gleiche Ops/Events, gleiche Response-Shapes (auch wo's unter Windows keinen GSR gibt:
`health.gsr.source="builtin"` statt Binary-Pfad). Capture = `windows-capture` v2 (WGC, ID3D11-Texture-Output), Audio =
`wasapi` (Desktop-Loopback + Mikrofon), Encode/Mux = `ffmpeg-next` 8.1 gelinkt gegen die **vendored** BtbN-LGPL-Shared-
Distribution unter `ffmpeg-dist/n8.1-lgpl-shared/` (Pfad via `.cargo/config.toml` `FFMPEG_DIR`; `build.rs` kopiert die
DLLs neben die exe). MediaMTX-Build für lokales Testen unter `mediamtx-dist/v1.18.1/mediamtx.exe`.

**Zwei Encode-Pfade**, dispatch in `src/stream_controller.rs::run_pipeline`:
- **NVIDIA Zero-Copy** (`src/pipeline_hw.rs` + `src/capture/wgc_hw.rs` + `src/encode/encoder_hw.rs` + `src/encode/hwctx.rs`):
  WGC liefert `ID3D11Texture2D`-Frames; im Capture-Callback `CopySubresourceRegion` GPU-intern in einen D3D11VA-Pool
  (`av_hwframe_get_buffer`), NVENC liest `AV_PIX_FMT_D3D11` mit `sw_format=BGRA` direkt — Swizzle + NV12-Convert auf
  der GPU. Kein PCIe-Roundtrip, kein `Vec<u8>`-Alloc im Hot-Path. **ffmpeg-next bindet `hwcontext_d3d11va.h` nicht** →
  `AVD3D11VADeviceContext`-Layout in `hwctx.rs` hand-gespiegelt + CRITICAL_SECTION als `lock`/`unlock`-Callback (FFmpeg
  serialisiert intern darüber den D3D11-Device-Zugriff; Capture-Callback hält denselben Lock manuell für
  CopySubresourceRegion). Aktiv **nur** für NVIDIA.
- **CPU-Fallback** (`src/capture/wgc.rs` + `src/encode/encoder.rs` → `run_cpu_pipeline`): BGRA via
  `frame.buffer().as_nopadding_buffer()` → CPU `Vec<u8>` → swscale BGRA→NV12 → AMF/QSV. Aktiv für AMD/Intel oder bei
  `PULSE_HQ_DISABLE_ZERO_COPY=1`. Hat zusätzlich einen **NVIDIA-„BGR-direct"-Fastpath** (BGRA-Bytes 1:1 in
  NVENC-Frame ohne swscale).

**AMD kann NICHT zero-copy** (2026-05-20, hart verifiziert): `h264_amf` stürzt auf D3D11-Surface-Input reproduzierbar
mit Integer-Divide-by-Zero in der AMF-Runtime ab (`SubmitInput`, Frame 0) — dokumentierter AMD-Treiber-Bug, AMF-Issue
[#455](https://github.com/GPUOpen-LibrariesAndSDKs/AMF/issues/455). Bind-Flags, Auflösung und NV12-vs-BGRA als Ursache
ausgeschlossen (Probe `examples/probe_d3d11.rs`); identische Encoder-Config mit Software-NV12-Surface läuft sauber bei
60 fps. Darum: AMD/Intel → CPU-Pfad, Punkt. **Dispatch-Detail:** `select_adapter()` liefert auf Multi-GPU den
`HIGH_PERFORMANCE`-Slot (dGPU), nicht zwingend die Display-/Capture-GPU. `run_pipeline` schickt `nvidia` an
`pipeline_hw`; `pipeline_hw::run` prüft dann die ECHTE WGC-D3D11-Device-GPU (`device_vendor`) und delegiert bei
!=nvidia selbst zurück an `run_cpu_pipeline`. Auf einer reinen AMD-Box greift schon `run_pipeline` direkt zum CPU-Pfad.

Env-Overrides (Test/Debug):
- `PULSE_HQ_ADAPTER_VENDOR=nvidia|amd|intel` — Adapter-Filter statt DXGI-`HIGH_PERFORMANCE`-Default. Auf Multi-GPU
  (dGPU+iGPU) der einzige Weg den AMF/QSV-Pfad zu validieren ohne den Default umzustellen.
- `PULSE_HQ_DISABLE_ZERO_COPY=1` — erzwingt CPU-Pfad auch auf NVIDIA. Für A/B-Debugging.
- `PULSE_HQ_SIDECAR=<pfad>` — Override für den Resolver in `desktop/electron/sidecar.ts`.

Tests: `cargo build --release` baut + DLL-Copy; Smoke via `examples/test_driver.rs` —
`cargo run --release --example test_driver -- health|video_only|audio_mux|av1_mux|hevc_mux [rtmp_url]`. Erwartet
MediaMTX auf `rtmp://localhost:1935/<path>` (lokal: `mediamtx-dist/v1.18.1/mediamtx.exe mediamtx-dist/v1.18.1/mediamtx.yml`).
`video_only` läuft Capture + Encode + Push 10s, validiert `state=live` + ≥1 `fps`-Event; `audio_mux` zusätzlich Opus-
Spur. Logs landen in `target/test-driver-<scenario>-<unix-ts>.log`. **Achtung**: DLL-Copy schlägt fehl wenn ein
laufender Sidecar die alten DLLs hält — Build kennt die exe-Lock-Datei, gibt aber nur Warning auf die DLLs (Build
selbst läuft trotzdem fertig, nur die kopierten DLLs sind dann stale).

**TLS/RTMPS-Fußnote**: FFmpegs Schannel-Backend auf Windows ist strict-verify by default — `tls_verify=0` MUSS gesetzt
sein wenn MediaMTX self-signed nutzt (Pulse-Default, Token in URL ist die echte Auth). Sonst killt FFmpeg den Push
nach dem TLS-Handshake mit „Writing encrypted data to socket failed" (sieht aus wie ein Network-Bug, ist aber
Cert-Verification — `encoder.rs::create` setzt das automatisch bei `rtmps://`).

**Settings-Persistenz (Electron)**: `desktop/electron/store.ts` = hand-rolled Key-Value-Store (**bewusst kein `electron-store`**
— ESM-only in neueren Versionen, gibt CJS/ESM-Friktion mit dem esbuild-Bundle). `<userData>/pulse-stream.json`, beim Start
einmal `readFileSync`, jeder `set` schreibt synchron zurück. Linux-Hardening: `chmod 700` aufs `userData`-Dir + `chmod 600`
aufs JSON (kann Custom-Server-Stream-Keys im Klartext enthalten). IPC `store:get|getAll|set` → `window.pulse.store`.
Renderer: `web/src/lib/stream/persistence.ts` (`loadAll/loadKey/saveAll`) → `window.pulse.store.*` unter Electron,
`localStorage`-Fallback (`pulse.stream`) im Browser. Persistiert: `profile_name server_name capture_source audio_mode
excluded_apps overrides use_overrides custom_servers`.

**Globaler PTT-Shortcut fehlt noch**: Electrons `globalShortcut` kann nur Press, nicht Press+Release → kein Hold-to-Talk;
braucht ein natives Key-Listener-Modul (z.B. `uiohook-napi`). `web/src/lib/platform/ptt.ts::initDesktopPtt()` ist ein
No-op-Stub. Der In-Window-PTT in `VoiceChannelView.svelte` (`@svelte-put/shortcut`, Taste aus `settings.voice.pttKey`)
ist der aktive Pfad. Ebenfalls TODO: Notifications-IPC in `main.ts`.

**Frontend-Plattform-Detection**: `web/src/lib/platform/runtime.ts` — `isElectron()` (`window.pulse?.platform === 'electron'`),
`isDesktop()` (Alias), `isLinux()` (UA-basiert). Dev-Test-Route `/app/dev/stream` (nicht im Menü) = Diagnose-Page mit allen
Sidecar-Ops als Buttons.

## Flatpak-Packaging — `packaging/`

`com.unicutmedia.Pulse`, `flatpak-builder`-Manifest `packaging/com.unicutmedia.Pulse.yml` (basiert aufs GSR-Streamer-Manifest, Qt raus / Electron + Python-Sidecar rein).
- Runtime `org.freedesktop.Platform//24.08` + `base: org.electronjs.Electron2.BaseApp//24.08` (liefert `zypak-wrapper` — Chromiums setuid-Sandbox geht im Flatpak nicht).
- Module: (1) `ffmpeg` n8.1.1 mit NVENC/ffnvcodec/vaapi/vulkan/libx264/libopus (verbatim aus dem GSR-Manifest — die
  Runtime-FFmpeg hat kein NVENC); (2) `gpu-screen-recorder` aus `repo.dec05eba.com` (HEAD — für Distribution pinnen) +
  die zwei `streaming/patches/` (FLV-Opus-Whitelist, Vulkan-Encoder-Stub); (3) `pulse`: Electron-42-Binary aus dem
  GitHub-Release **mit `strip-components: 0`** — das Release-Zip ist ein flacher Baum mit `locales/`+`resources/`; der
  flatpak-builder-Default `strip-components: 1` plättet die zwei Verzeichnisse → Electron findet `resources/default_app.asar`
  nicht → Exit 1 *bevor `main.cjs` läuft* (das war der „startet nicht"-Bug). Sidecar-`.py` → `/app/share/pulse/gsr-sidecar/`,
  `desktop/electron/dist/{main,preload}.cjs` → `/app/pulse/`, `icon.png` → `/app/icon.png`.
- **Web wird NICHT mitgepackt** — die App lädt `https://pulse.unicutmedia.com` remote. Web-Fixes sofort live; nur native
  Änderungen (Electron-main/preload, Sidecar, GSR-Binary) brauchen einen Rebuild.
- Launcher `/app/bin/pulse`: setzt `GSR_BINARY`/`PULSE_SIDECAR_PY`/`PULSE_PYTHON`, hängt `--ozone-platform-hint=auto`
  an (Manifest mountet `--socket=wayland` *und* `--socket=x11` — Electron wählt selbst), `exec zypak-wrapper /app/electron/electron /app/pulse/main.cjs`. Override `PULSE_OZONE=x11|wayland`.
- Bauen (User-Scope, kein sudo): `packaging/build.fish`. Erster Build ~15–30 min (FFmpeg + GSR aus Source). Danach `flatpak run com.unicutmedia.Pulse`.
- Distribution / Auto-Update: signiertes OSTree-Repo (archive-z2, `build-update-repo --generate-static-deltas --prune
  --prune-depth=3`) → rsync → VPS `~/pulse/flatpak-repo/` → `pulse_web`-nginx served `https://pulse.unicutmedia.com/flatpak/`.
  Empfänger: einmal `flatpak install --user …/com.unicutmedia.Pulse.flatpakref`, danach `flatpak update`. Signing-Key
  passwortlos, derselbe Key auf Empfänger-Seite via `.flatpakref` gepinned — Verlust = Empfänger lehnt künftige Updates ab.
- **Automatik:** `.github/workflows/flatpak.yml` baut + signiert + rsynct bei Pushes auf `main` die native Flatpak-Inhalte
  ändern (gleicher Pfad-Filter wie der alte pre-push-Hook). Erstinvest ~30 min (FFmpeg+GSR-from-source), gecached ~5 min.
  Braucht 3 Repo-Secrets: `FLATPAK_GPG_PRIVATE_KEY` (ASCII-armored Export des Signing-Keys), `VPS_SSH_PRIVATE_KEY`
  (CI-dedizierter SSH-Key auf der VPS in `authorized_keys`), `VPS_KNOWN_HOSTS` (`ssh-keyscan 77.42.71.166`). Setup-Details
  `packaging/README.md`. `.githooks/pre-push` ist als Notfall-Fallback umgestellt: nur noch aktiv mit `PULSE_FORCE_LOCAL_PUBLISH=1`,
  sonst hint-und-skip (sonst racen Hook + CI auf den gleichen rsync-Pfad). `packaging/publish.fish` läuft unverändert und ist
  was der CI-Workflow nachbildet — zum lokalen Bauen weiterhin nutzbar wenn der Key vorhanden ist.
- **App startet nicht (Exit 1, kaum Output):** erst `flatpak run --command=sh com.unicutmedia.Pulse -c 'ls /app/electron/resources /app/electron/locales'`
  — fehlen die, ist's wieder `strip-components`. Sonst meist GPU/Wayland auf NVIDIA → `PULSE_OZONE=x11 flatpak run …`, oder `--disable-gpu`/`--disable-gpu-sandbox` an die `zypak-wrapper`-Zeile.

## Produktiv-Deployment (Hetzner-VPS) — Details `infra/prod/DEPLOY.md`

Läuft auf `michael@77.42.71.166` (neben Caddy + anderen Apps), erreichbar **https://pulse.unicutmedia.com**.
Ein Compose-Stack (`name: pulse`) in `~/pulse/infra/prod/`: `pulse_postgres` + `pulse_redis` (eigene DB/Cache/Volumes),
`pulse_auth`/`pulse_chat_gateway`/`pulse_voice_signaling`/`pulse_media_svc`/`pulse_mediamtx_auth_hook`/`pulse_web`
(GHCR `ghcr.io/oblivion8282-1337/pulse-*:latest`), `pulse_migrate_auth`/`pulse_migrate_chat` (`alembic upgrade head`),
`pulse_mediamtx` + `pulse_livekit` (`network_mode: host`, gepinnt), `pulse_watchtower` (`--scope pulse`, 5min).
- **Routing:** Caddy (`~/caddy/Caddyfile`, `pulse.unicutmedia.com { reverse_proxy host.docker.internal:8100 }`, LE-Cert)
  → `pulse_web` nginx (`infra/prod/web-nginx.conf`, im Image gebacken) → `/api/{auth,chat,ws,voice}/*` an die Services,
  `/whep/*`+`/hls/*` an MediaMTX, `/livekit/*` an LiveKit. **Diese host-Routen nutzen statisches `proxy_pass
  http://host.docker.internal:PORT/`** (nicht Variable+Resolver — Dockers `127.0.0.11` kennt `host.docker.internal` nicht → wäre 502).
- **Auto-Update:** push → `main` → `.github/workflows/ci.yml` baut+pusht die 6 Images nach GHCR (`:latest`+`:sha`, nach
  grünen Tests) → `pulse_watchtower` zieht `:latest` ≤5 min später. Struktur-Änderungen (neuer Service / Env-Var /
  Compose-/nginx-/MediaMTX-/LiveKit-Config): `rsync infra/ → ~/pulse/infra/` + `cd ~/pulse/infra/prod && docker compose up -d`.
- **Secrets:** nur auf dem Server in `~/pulse/infra/prod/.env` (gitignored, aus `.env.example`) + `secrets/jwt_*.pem`.
  **PEM-Files müssen `chmod 0644`** sein (Container = uid 10001). LiveKit-Keys: Name `pulse-prod` (in `livekit.yaml` +
  `LIVEKIT_API_KEY`), Secret via `LIVEKIT_KEYS` env.
- **Avatar-Volume:** `pulse_avatars` → `pulse_auth:/app/services/auth/uploads`. `services/*/uploads` ist in `.dockerignore`
  (nicht im Image); `Dockerfile.service` legt `uploads/avatars` *nach* `USER app` an, damit ein frisches leeres Named-Volume
  beim Seed `app`-Ownership erbt (sonst `root:root` → uid 10001 kann nicht schreiben → Avatar-Upload 500 `PermissionError`).
  Fresh-Deploy: prüfen Volume = `app:app`, sonst `docker exec -u root pulse_auth chown -R 10001:10001 /app/services/auth/uploads`.
- **UFW:** öffentlich offen `1935/tcp` (RTMP), `1936/tcp` (RTMPS), `8890/udp` (SRT), `8189/udp` (MediaMTX-ICE), `7881/tcp`+`7882:7892/udp`
  (LiveKit-RTC); 80/443/8888/8889 schon offen. Nur vom Docker-Bridge (`ufw allow from 10.0.0.0/8 to any port <p> proto tcp`):
  `7880` (LiveKit-Signaling), `9997` (MediaMTX-API) — sonst blockt `INPUT DROP` den Bridge→Host-Weg den `pulse_web` + `pulse_media_svc` brauchen.
- Electron-App lädt `https://pulse.unicutmedia.com` (Web-Fixes sofort sichtbar); GSR-Sidecar läuft lokal.

## Port-Mapping (lokales Dev)

| Dienst | Port | |
|---|---|---|
| Postgres | **5434** | nicht 5433/5432 (Standard-Ports von Schwester-Worktree belegt); `.env` reflektiert das |
| Redis | **6380** | `REDIS_URL=redis://localhost:6380/0` |
| auth-svc | 8001 | `uvicorn dcc_auth.app:app` |
| chat-gateway | 8002 | `uvicorn dcc_chat_gateway.app:app` |
| voice-signaling | 8003 | `uvicorn dcc_voice_signaling.app:app` |
| media-svc | 8004 | `uvicorn dcc_media_svc.app:app` (Stream-Tokens + State + Poller) |
| mediamtx-auth-hook | 8005 | `uvicorn dcc_mediamtx_auth_hook.app:app` (MediaMTX `authHTTP`) |
| web (Vite dev) | 5173 | `http://127.0.0.1:5173` |
| LiveKit | 7880 (+7881, 7882–7892/udp) | `network_mode: host` |
| MediaMTX | 1935/1936/8888/8889/8890/8189/9997 | RTMP/RTMPS/HLS/WHEP/SRT/ICE/API — `streaming/server/docker-compose.yml`, `network_mode: host`. API (9997) nur localhost. Auth → `authHTTP` → :8005 |

### Service-Start (Env aus `.env`; detached, überlebt Agent-Shutdown)
Gemeinsam: `REDIS_URL=redis://localhost:6380/0`, `AUTH_JWKS_URL=http://127.0.0.1:8001/.well-known/jwks.json`.
- **auth / chat-gateway**: zusätzlich `POSTGRES_PASSWORD`, `JWT_PRIVATE_KEY_FILE`+`JWT_PUBLIC_KEY_FILE` (absolute Pfade zu `secrets/jwt_*.pem`); chat-gateway zusätzlich `MEDIA_SVC_URL=http://127.0.0.1:8004`.
- **voice-signaling**: dieselben LiveKit-Keys wie `infra/livekit/livekit.yaml` / `.env` (sonst „invalid token: error in
  cryptographic primitive" + Webhook-Sig-Fail): `LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=devsecretdevsecretdevsecretdevsecret`,
  `LIVEKIT_URL=ws://localhost:7880`. `.env` + `livekit.yaml` sind die Single Source of Truth (Dev-Werte, kein Geheimnis).
- **media-svc**: zusätzlich `MEDIAMTX_API_URL=http://localhost:9997/v3/paths/list`. Läuft MediaMTX nicht → Poller loggt nur `mediamtx_poll_failed`, kein Crash.

Muster (Beispiel chat-gateway):
```bash
pkill -f "uvicorn dcc_chat_gateway"
cd services/chat-gateway && \
POSTGRES_PASSWORD=... REDIS_URL=redis://localhost:6380/0 \
AUTH_JWKS_URL=http://127.0.0.1:8001/.well-known/jwks.json MEDIA_SVC_URL=http://127.0.0.1:8004 \
setsid nohup uv run uvicorn dcc_chat_gateway.app:app --host 127.0.0.1 --port 8002 \
  > /tmp/dcc-chat.log 2>&1 < /dev/null & disown
```
MediaMTX lokal: `docker compose -f streaming/server/docker-compose.yml up -d` (sonst kein live `authHTTP`-Flow). LiveKit: `docker compose --profile voice up -d`.

## Tests

- Backend: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q`. Pro-Service-Tests unter `services/*/tests/` (MediaMTX/LiveKit gemockt; Redis-Index `/1`).
- Frontend: `cd web && pnpm check && pnpm build` (0 Errors / 0 Warnings) + `pnpm exec playwright test`. Kein Vitest/Unit — nur Playwright-E2E.
- E2E-DB = `dcc_test` (separat im selben Postgres-Container; `_globalSetup.ts` legt sie an + migriert + truncated **nur sie**). Die Dev-DB `dcc` wird **nie** angefasst. Test-Redis-Index `/1`. `email-validator` blockt `*.test`-TLDs → Tests nutzen `dcc-test.example.com`.
- **Manuell, nicht automatisiert**: echter GSR-`start` (Portal-Dialog + realer Push), Electron-GUI-Sichttest (Voice + Settings-Round-Trip), HQ-Stream-E2E (2 Clients, einer sieht den WHEP-Player).
- Vor jedem Commit: pytest + `pnpm check` + `pnpm build` + Playwright.

## Konventionen

- **Kein `git push` / keine GitHub-CLI** ohne explizite Freigabe. Remote: `origin` → `github.com/oblivion8282-1337/pulse.git`.
- **Refactoring darf das Verhalten nicht ändern** — Endpoint-Pfade, Response-Models, `data-testid` bleiben identisch. Bricht ein Test nach einem Refactor → der Code ist kaputt, nicht der Test.
- **Code-Größen-Policy** (`PLAN.md` §12.1): Source-Dateien ≤ 350 Z. (hart 500), Svelte-Components ≤ 250. Ausgenommen: Tests, Alembic-Migrationen, `web/src/lib/components/ui/`. Im Zweifel splitten statt wachsen lassen.
- **Lies zuerst, ändere danach. Keine neuen Dependencies ohne Rückfrage. Tests proaktiv laufen lassen.** (auch globale CLAUDE.md)
- **Niemals Stream-Keys/Tokens loggen** (`console.log`, structlog…). Der Sidecar nimmt sie nur transient als Request-Field, persistiert sie nicht.
- `~/Dokumente/GPU_Screen_Recorder/` ist READ-ONLY — Pulse modifiziert nur seine vendored `streaming/`-Kopie.

## Anti-Patterns (voll in `PLAN.md` §12)

- ❌ Shared DB-Tabellen zwischen Services · ❌ HS256 JWT (nur RS256)
- ❌ `fastapi-users` / `broadcaster` / `fastapi-socketio` / `fastapi_websocket_pubsub` als Dep (alle archiviert/Maintenance → Eigenbau, Source nur als Referenz)
- ❌ State-Library (Redux/Zustand/Pinia) neben Svelte-Runes · ❌ CSS-in-JS (Tailwind reicht)
- ❌ **Tauri** als Desktop-Wrapper (WebKitGTK-WebRTC zu unzuverlässig für LiveKit-Voice → 2026-05-12 auf Electron migriert, `PLAN.md` §17) · ❌ `electron-store` als Dep (ESM-only → CJS-Friktion; hand-rolled `store.ts` reicht) · ❌ `electron-builder` als Dep (Flatpak-Manifest bündelt das Electron-Binary direkt) · ❌ React-Bridge in SvelteKit für LiveKit-React-Components
- ❌ `@livekit/krisp-noise-filter` (kostenpflichtig seit 2026-05-01) · ❌ `deepfilternet3-noise-filter` (klingt kratzig/metallisch durch Spektral-Masking + Worklet hatte einen Underrun-Bug der Wörter chopt — 2026-05-16 raus) · ❌ `svelte-french-toast` (Sv5-inaktiv) · ❌ `svelte-markdown` blind (kein Sanitizer)
- ❌ Exactly-once-Delivery anstreben · ❌ Re-Publishing MediaMTX→LiveKit (Transcoding zu teuer)
- ❌ Routes-/Service-Dateien über die Größen-Grenze wachsen lassen statt zu splitten
- ❌ Existierende GSR-Files im Original anfassen (`~/Dokumente/GPU_Screen_Recorder/`) — nur die vendored `streaming/`-Kopie
