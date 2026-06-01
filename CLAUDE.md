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

## Tech-Stack — die Stolpersteine

Genaue Versionen stehen in `uv.lock` / `pnpm-lock.yaml` / `package.json` — bei Bedarf dort nachsehen, hier nur das Nicht-Offensichtliche.
Runtimes: **Python** 3.14 (`>=3.13,<3.15`) · **uv** · **Node** 25 · **pnpm** 10. Ruff `line-length=100`, `target-version=py313`, `ignore=["E501"]`.

**Backend** (`services/*` + `shared/`) — FastAPI + uvicorn, SQLAlchemy[asyncio] (async ORM, **eigenes Schema pro Service**: `auth`/`chat`), asyncpg (Prod) / aiosqlite (nur Tests), Alembic (Migrationen pro Service unter `alembic/versions/`), pydantic v2 + pydantic-settings. Nicht-offensichtlich:
- **pyjwt[crypto]**: RS256. `PyJWKClient.from_jwks` gibt's in der Version noch nicht → Eigenbau via `RSAAlgorithm.from_jwk` in `security.py`.
- **argon2-cffi**: Passwort-Hashing Argon2id (t=3/m=64MiB/p=4).
- **redis** async: ConnectionManager nutzt `psubscribe` + `get_message()`-Poll (kein `listen()`-Race).
- **slowapi**: Rate-Limit in auth-svc — **in-process!**
- **email-validator** blockt special-use-TLDs → Tests nutzen `dcc-test.example.com`, nicht `*.test`.
- **py_webauthn**: WebAuthn/Passkeys — CBOR/COSE/Attestation, kein Eigenbau. `pyotp`+`qrcode[pil]` für TOTP.
- **pytest** + pytest-asyncio: `--import-mode=importlib`, `asyncio_mode=auto`.

**Frontend** (`web/`, SvelteKit-SPA, `ssr=false`, `adapter-static`) — Svelte 5 Runes (`$state`/`$derived`), Tailwind 4 (+ `@tailwindcss/vite`, shadcn-Semantik-Tokens im `.dark{}`-Block), valibot (API-Response-Validation), shadcn-svelte / bits-ui (`web/src/lib/components/ui/`, Vendor — von der Größen-Policy ausgenommen). Nicht-offensichtlich:
- Build → `web/build/` → `pulse_web`-nginx-Image. **Die Electron-App lädt die *deployte* Web-App remote**, nicht `web/build/`.
- Vite-Dev-Proxy: `/api/auth`→:8001 · `/api/chat`+`/api/ws`→:8002 · `/api/voice`→:8003.
- **livekit-client**: `lib/voice/livekit.svelte.ts` abonniert rohe `Room`/`Participant`-Events (kein `@livekit/components-core`-Wrapper, obwohl installiert & ungenutzt).
- **@sapphi-red/web-noise-suppressor**: Mic-Filter RNNoise→NoiseGate (`lib/voice/noiseFilter.ts::RnnoiseGatedTrackProcessor`). UI nur Aus/An; bei An dB-Slider für die Gate-Open-Schwelle (close = open−5 dB, hold 200 ms). **`MediaStreamDestinationNode.channelCount = 1` zwingend setzen** — Default ist Stereo + `channelCountMode "explicit"` → mono-Worklet füllt nur output[0], rechter Kanal stumm.
- **mode-watcher**: Light/Dark/System; `setMode()` aus `settings.svelte.ts`, persistiert in `dcc.settings`; FOUC-Inline-Script in `app.html`.
- **@svelte-put/shortcut**: In-Window-PTT-Hotkey (Taste aus `settings.voice.pttKey`).
- Tests: `@playwright/test` E2E (`web/tests/e2e/`, globalSetup startet auth+chat als child-procs) + `svelte-check` (`pnpm check`). Kein Vitest/Unit.

**Desktop** (`desktop/`, Electron — `@dcc/desktop`, pnpm-Workspace-Member):
- electron 42.0.1 (gepinnt) bundlet Node 22.x. **Kein `postinstall`** — Binary wird beim ersten `require('electron')` lazy gezogen.
- esbuild bundlet `electron/{main,preload}.ts` (zieht `sidecar.ts`+`store.ts` via Import mit) → `electron/dist/*.cjs` (`build:electron`).
- `desktop/package.json` ist CJS (**ohne** `"type":"module"`), `"main":"electron/dist/main.cjs"`.
- Scripts: `dev` (= build + `PULSE_DEV_URL=:5173 electron .` gegen Vite) · `prod` (= build + `electron .` ohne Env → lädt `https://howispulse.com`, keine DevTools) · `start` (`electron .` ohne Rebuild). DevTools nur bei `PULSE_DEVTOOLS=1` oder Strg+Shift+I. Build-Check ohne GUI: `cd desktop && pnpm run build:electron`.
- Voice funktioniert im Electron-Fenster (Chromium-WebRTC) — das war der Grund für den Tauri→Electron-Pivot.
- **Windows-Distribution = NSIS-Installer + Auto-Update** (`electron-builder.yml` `win.target: nsis`, `dist:win` = `build:electron && electron-builder --win --publish never`): baut `Pulse-Setup-<v>.exe` + `latest.yml` + `.blockmap` nach `desktop/release/`. **electron-updater** (Runtime-Dep `^6.3.9`, esbuild-`--external`, kommt als Production-Dep automatisch in die asar) pollt beim Start den **generic-Feed** `https://howispulse.com/updates/win/latest.yml`, lädt selbst und installiert beim nächsten Beenden (`autoInstallOnAppQuit`) bzw. sofort per In-App-Banner. Updater-Logik in `electron/updater.ts` (`wireUpdater(()=>mainWindow)` in `whenReady`, gated auf `app.isPackaged && win32` → no-op in dev/Linux); Bridge `window.pulse.updates.{onReady,restartNow,check}` (preload + `pulse.d.ts` synchron); Banner via sonner in `+layout.svelte`. **Unsigniert** (`signAndEditExecutable:false`) → SmartScreen-Warnung nur beim Erst-Download; Auto-Update verifiziert per SHA512 aus `latest.yml`, läuft trotzdem. CI: `.github/workflows/win-build.yml` baut + scpt den Feed nach `~/pulse/updates-win/` (Secrets `VPS_SSH_PRIVATE_KEY`/`VPS_KNOWN_HOSTS`, **kein** `--delete` → Delta-Downloads); legt die .exe zusätzlich unter festem Namen `Pulse-Setup-latest.exe` ab (stabiler Direktdownload zum Weitergeben: `https://howispulse.com/updates/win/Pulse-Setup-latest.exe`; vom Updater ignoriert, der liest nur `latest.yml`); nginx serviert das Verzeichnis unter `/updates/win/` (s. `infra/prod/web-nginx.conf` + compose-Bind-Mount). Gleiches Deploy-Muster wie der Flatpak-OSTree-Push. Plan: `docs/superpowers/plans/2026-05-31-windows-auto-update.md`.

**Infra (Dev):** `docker-compose.yml` — Postgres `postgres:16-alpine`, Redis `redis:7-alpine`, LiveKit (hinter `docker compose --profile voice up -d`, **`network_mode: host`** — s.u.). MediaMTX läuft *separat* über `streaming/server/docker-compose.yml` (`network_mode: host`). Prod siehe „Produktiv-Deployment".

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

**2FA — TOTP + WebAuthn/Passkeys** (2026-05-21): zwei Zweitfaktoren, beide auth-svc.
- TOTP: `routes_totp.py` (`pyotp`+`qrcode`). WebAuthn: `routes_webauthn.py` (Registrierung+Verwaltung, eingeloggt) + `routes_webauthn_login.py` (Login-Ceremony) + `passkeys.py` (Helpers). `py_webauthn` macht CBOR/COSE/Attestation — **kein Eigenbau**.
- **Challenge-State = signiertes JWT** ("challenge ticket", `passkeys.py`), kein State-Table/Redis — exakt das Muster vom `mfa_ticket`. `purpose`-Claim trennt reg/auth, options→verify reicht das Ticket durch. Funktioniert deshalb auch im SQLite-Test.
- `POST /login` ist MFA-gated bei `totp_enabled` **oder** ≥1 Passkey → `LoginMfaPending{mfa_ticket, methods[]}` (`requires_mfa`, **nicht** mehr `requires_totp`). Zweitschritt: `/login/totp` oder `/login/webauthn/verify`.
- **Passwortloser Passkey-Login**: `/login/webauthn/*` ohne `mfa_ticket` → discoverable, `userVerification=required`. Die Assertion ist damit allein schon echte MFA → kein Passwortschritt, umgeht TOTP bewusst. Mit `mfa_ticket` = 2FA-Zweitfaktor (Ticket + Challenge-Ticket müssen denselben User nennen).
- **rpId/Origin** (`WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGIN`, prod in `.env`): rpId muss Domain-Suffix der Origin sein. **Dev: `localhost`, NICHT `127.0.0.1`** — eine IP kann keine rpId sein, ein Passkey von `localhost` validiert nicht auf `127.0.0.1`. Folge: die E2E-Origin ist `127.0.0.1:5173` → echte Ceremony dort nicht lauffähig, `passkeys.spec.ts` mockt die `/webauthn/*`-Routes (Krypto-Pfad deckt `test_webauthn.py` ab, Lib-`verify_*` dort gemockt).
- **Backup-Codes sind MFA-weit**, nicht TOTP-spezifisch: der erste Passkey auf einem Account ohne sonstiges MFA erzeugt 10 Stück; `totp/disable` + Passkey-Delete droppen sie nur, wenn danach **kein** Faktor mehr übrig ist.

**`allow_guild_creation` default = FALSE** (Migration 0010, 2026-05-18): Fresh-Deploys sind locked-down — nur der Bootstrap-Admin kann Server anlegen. Admin öffnet's via `/admin/permissions` für alle Member. Vorher war's `true` (= Public-Discord-Modell), was für Self-Host falsche Default-Annahme war. `allow_member_invites` bleibt `true` — das ist per-guild-scoped via `CREATE_INVITES`-Permission, nicht global. Test-Convenience: `services/chat-gateway/tests/conftest.py` seedet die Singleton mit `allow_guild_creation=true` (sonst müssten 80% der Tests erst durch den admin-Toggle gehen).

**Permissions** (Voll-Discord, 2026-05-18) — Bits + Resolver in `dcc_shared/permissions.py` / `permission_resolver.py` (pure-Python, DB-agnostisch via `PermissionContext`-Protocol); Frontend spiegelt das in `lib/permissions/bitfield.ts` mit BigInt (**synchron halten**). 3 chat-gateway-Tabellen (`roles`/`member_roles`/`permission_overwrites`), Routes (`/guilds/{id}/roles*`, `/channels/{id}/permissions`, `…/transfer-ownership`, `…/permissions/me`) + Stores im Code. Die nicht-offensichtlichen Stücke:
- Discord-Formel `final = (base | allow) & ~deny`; **!VIEW_CHANNEL → revoke_all-Invariante** (kein „darf schreiben aber nicht sehen" → Exploit-Schutz). Reihenfolge: @everyone (implizit via `is_everyone`) → role-overwrites in position-order → user-overwrite.
- `GRANT_ALL_SAFE = (1<<52)-1` — Owner/ADMIN resolven dahin, **NICHT `~0`** (reserved bits müssen Null bleiben, JS-Number-safe; 23 Bits mit bewussten Gaps für Erweiterung).
- `assert_overwrite_within_editor_scope()` (`dcc_chat_gateway/permissions.py`): Anti-Escalation — Editor muss jedes Bit selbst halten, das er grantet/un-deny't.
- POST /guilds **auto-seedet** die `@everyone`-Rolle (sonst broken-state vor erstem Resolver-Call; Migration 0009 seedet Bestands-Guilds).
- `ConnectionManager._filter_by_view_channel` gatet `chat:channel:*`/`voice:events`/`stream:events`/`watch:events`; **DM-Channels passieren ungefiltert** (kein Overlay). Per-Socket `_ws_perms`-Cache, invalidiert auf relevante ops.
- **Server-Delete + Owner-Transfer bleiben Owner-only** (kein MANAGE_GUILD-Bypass; ADMIN-Globalflag bypasst Delete aber NICHT Transfer). MANAGE_GUILD = nur rename/icon/settings.

**Voice-Presence** (wer ist im Voice-Channel): LiveKit-Webhooks → voice-signaling `POST /webhook` (Signatur via
`livekit.api.WebhookReceiver`, Key `devkey` = `webhook:`-Block in `infra/livekit/livekit.yaml`) → pflegt Redis-Sets
`voice:room:channel-<id>` (TTL 6h, Self-Heal) → published auf `voice:events`. chat-gateway abonniert das im
`ConnectionManager` → broadcastet `{"op":"voice_state","channel_id":..,"user_ids":[..]}`; `ready`-Payload trägt
`voice_states` → Re-Sync nach Reconnect läuft über den `ready`-Frame (das Backend bietet auch
`GET /guilds/{id}/voice-state` an, hat aber keinen aktiven Frontend-Consumer).

**HQ-Streaming** (per-User-Pfade — mehrere können in denselben Voice-Channel streamen). Voller Datenfluss, Redis-Key-Schema (TTLs, `stream:token/active/channel`, `stream:events`) + Route-Signaturen → `streaming/README.md`. Die Stolpersteine:
- **media-svc** (8004) vergibt Stream-Tokens (von chat-gateway nach Membership-Check weitergereicht) + pollt `MEDIAMTX_API_URL` (3s) zum Publisher-Self-Heal. **mediamtx-auth-hook** (8005) = MediaMTX `authMethod: http`, nur Redis (kein DB/JWT): Publish prüft Token gegen Pfad, Read/Playback anonym, alles andere 401.
- **Nonce gegen Republish-ICE-Race**: jeder Token-Issue bekommt frische 8-Hex-Nonce → MediaMTX-Pfad `channel-<cid>-<uid>-<nonce>`. Gleicher Pfad < Sekunden später = tote WebRTC-Session (MediaMTX-1.17.1-Bug). `stream:active:*` hält den vollen Live-Pfad **ohne** Nonce für den WHEP-Lookup.
- **Redis-Key-Namen sind in `dcc_media_svc/streamkeys.py` + `dcc_mediamtx_auth_hook/shared.py` dupliziert** (Services teilen keinen Code — synchron halten).
- chat-gateway braucht `MEDIA_SVC_URL` (Dev `http://127.0.0.1:8004`); fehlt media-svc → **502 nur** auf den Stream-Routen, Rest läuft. Re-Sync läuft ausschließlich über den `ready`-Frame (`GET …/stream-state` existiert, kein Frontend-Consumer).
- Push = **RTMPS** (`rtmps://<host>:1936`, MediaMTX `rtmpEncryption: optional` → plain :1935 bleibt, self-signed Cert `/certs/server.{crt,key}`, UFW `1936/tcp`).
- Frontend: WHEP-Client `web/src/lib/stream/whep.ts` (hand-rolled, keine neue Dep — Pattern aus GSR-`player.html`). Gating überall `isElectron() && (isLinux() || isWindows()) && stream.gsrAvailable` (Windows = eigener Rust-Sidecar). HQ-Panel: Codec/Auflösung (downscale-only)/Bitrate/FPS/Audio — App-Audio via `audio_mode="App: <name>"` → GSR `-a app:<name>`.

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
nehmen `channel:{id,token,mediamtx_endpoint?,push_protocol?}` (Pulse-Pfad, MediaMTX-Pfad `channel-<cid>-<uid>-<nonce>`) oder
`server:"<name>"`+`stream_key`. Testen ohne realen Stream:
`printf '{"op":"health","id":1}\n{"op":"build_argv","id":2,...}\n' | python3 streaming/gsr-sidecar/control.py` —
**KEIN `{"op":"start"}` im Test** (öffnet Wayland-Portal-Dialog + streamt wirklich); `build_argv` baut nur die argv ohne zu starten.

**GSR-Binary-Resolver**: `$GSR_BINARY` → Flatpak (`/app/bin/gpu-screen-recorder` wenn `/.flatpak-info`/`$FLATPAK_ID`)
→ Custom-Build (`$XDG_CACHE_HOME/pulse/gsr/gpu-screen-recorder/build/gpu-screen-recorder` von `streaming/bootstrap-gsr.fish`,
Legacy-Fallback `/tmp/gsr-analysis/...` — wandert beim nächsten Bootstrap mit) → PATH. Fehlt alles
→ `health.gsr.available=false` (kein Crash). Persistenter Cache-Pfad überlebt Reboots; `/tmp` war tmpfs, da war HQ nach jedem Reboot weg.

**Windows-HQ-Sidecar** (`streaming/win-hq-sidecar/`): Rust-Bin, spricht dasselbe stdio-JSON-RPC wie der Linux-GSR-Sidecar
(gleiche Ops/Events/Response-Shapes). Capture = `windows-capture` (WGC), Audio = `wasapi`, Encode/Mux = `ffmpeg-next`
gegen vendored BtbN-LGPL-DLLs. Drei Encode-Pfade (Vendor-Dispatch): **NVIDIA D3D11-Zero-Copy** (NVENC) ·
**AMD D3D12VA-Zero-Copy** (nativer `h264_d3d12va`, umgeht die crashende AMF-Runtime — AMD kann kein *D3D11*-Zero-Copy,
`h264_amf`-Treiberbug #455) · **CPU-Fallback** (Intel/QSV + `PULSE_HQ_DISABLE_ZERO_COPY=1`). **Voller Aufbau, Encode-Pfad-Details, AMD-Bug, Env-Overrides, Tests,
TLS/RTMPS-Fußnote → `streaming/win-hq-sidecar/README.md`.** Pfad-Entscheid-Recherche: `WINDOWS_HQ_SIDECAR.md` (Root).

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

## Self-Host-Identität, Registrierung & Mandatory-SSO (Cert-Modell)

Cert-Modell ist **auf main gemergt** (PR #11). Minecraft-Modell: Identität zentral über die Cloud
(howispulse.com), Server sind isolierte Welten. Voll-Konzept: `IDENTITY_CONCEPT.md`. Die nicht-offensichtlichen Stücke:

**Instanz-Rolle (Env, chat-gateway *und* auth-svc):**
- `PULSE_INSTANCE_MODE` = `cloud` | `self-host` (Default `self-host`!). Prod-Cloud-`.env` setzt `cloud`.
- `PULSE_INSTANCE_ID` (0 = Cloud; ≥100 = von der Cloud bei Approval vergeben).
- `PULSE_INSTANCE_OWNER_ID` (chat-gateway) = Cloud-User-ID des Self-Host-Owners. Beim Cert-Login wird der
  User mit `cert.user_id == owner_id` **automatisch Admin** dieser Instanz (Self-Host hat sonst keinen Admin).
- `ALLOW_LOCAL_ACCOUNTS` (auth-svc, Default false) = Escape-Hatch: lässt lokale Passwort-Registrierung auf
  einem Self-Host wieder zu (versiegelte Insel).

**Registrierung** (`auth_settings.registration_mode`: open|invite_only|closed, Admin-Panel „Registrierung"):
- Self-Host (`mode != cloud`) **blockt `POST /register`** by default → Identität kommt per Cert-Login von der
  Cloud. Cloud registriert immer. `invite_only` verlangt einen Einladungscode (Admin erstellt sie unter
  „Registrierung"; Modell `registration_invites`, Migration 0022; atomarer guarded-UPDATE-Konsum, race-sicher;
  Deep-Link `…/register?invite=CODE`).

**Cert-Login** (`chat-gateway/routes/cert_login.py`): Challenge/Verify mit **Geräte-Schlüssel-Proof-of-Possession**
(Ed25519-Signatur über Server-Nonce) → Cert allein (Bearer) reicht NICHT, also schon replay-sicher — keine extra
Server-aud-Bindung nötig. Mintet lokalen Session-Token (`session_tokens.py`, EdDSA, 5 Min). Self-Host nutzt
**pairwise_sub** statt roher user_id (Privacy). `credential_validator.py` prüft Cloud-JWKS + CRL.

**Admin-Status fließt pro Server:** Session-Token trägt `admin`-Claim (Owner-Match) → `ws_ready` liefert
`is_admin` **pro Server** → Frontend `serverAdmin`-Store → Admin-Panel-Gate pro aktivem Server (Cloud:
auth `/me`; Self-Host: ready-Frame, da Cert-Login-User dort kein auth `/me` haben).

**Self-Host-Instanz-Verwaltung ist cloud-only:** `routes_admin_instances` (Approve/Suspend) hinter
`_require_cloud` (`PULSE_INSTANCE_MODE == cloud`); Frontend blendet den `AdminInstances`-Bereich auf Self-Hosts
aus (`activeServer.isCloud`). Nur die Cloud entscheidet, wer self-hosten darf.

**Public well-known-Endpoints** (auth-svc, am Root-Pfad): `/.well-known/{jwks.json, revoked-credentials,
pulse-version-policy.json, pulse-suspended-instances}` — Self-Hosts pollen die von der Cloud. **`web-nginx.conf`
muss sie explizit an auth-svc routen** (Regex-Location), sonst fallen sie auf den SPA-Fallback (index.html) und
die Poller scheitern still mit JSONDecodeError. `acme-challenge` bleibt bewusst ausgespart (Caddy/LE).

**Presence-Status dauerhaft:** der manuell gewählte Status (online/idle/dnd/invisible) wird neben Redis (24h-TTL)
in `chat.user_preferences` (Sektion `presence`) gespiegelt; `ws_ready` stellt ihn beim Login wieder her, wenn der
Redis-Key abgelaufen ist. Automatische idle/online-Sweeper-Übergänge bleiben Redis-only.

**UI-Terminologie:** die Discord-„Guild"-Sache heißt im UI **„Community"** (nicht „Gilde"/„Server"); „Server" =
Pulse-Instanz. Code-Bezeichner bleiben `guild`/`Guild`. Siehe Memory `project_terminology_community`.

## Plugin-System (Stufe A)

Top-Level `plugins/` (Referenz: `hello` + `tamagotchi`). Manifest = `plugin.toml` (Backend) + `manifest.ts`
(Frontend-Spiegel, **manuell synchron halten** — Browser hat kein TOML). Loader: `chat_gateway/plugins/loader.py`
+ `web/src/lib/plugins/loader.ts`. Plugin-Ops **colon-namespaced** (`tamagotchi:feed`, Listener-Validator bypasst
via `:`), outbound `gateway.sendPluginOp(...)`. **Prod-Discovery braucht `plugins/` in ZWEI Images**: (1)
`web/Dockerfile` für den Frontend-Spiegel (Build-Zeit), (2) `Dockerfile.service` → chat-gateway-Image für die
**Backend**-Discovery (`discover_plugins_dir()` walkt vom Loader-Code hoch und sucht `/app/plugins`; ohne den
`COPY plugins/` läuft `discover_manifests()` leer → alle Plugins erscheinen als „verwaist" und werden nie geladen).
Mechanik-Details (Hot-Reload-Interna, UI-Komponenten) + Stufe B (Bot-API)/C (WASM): `docs/PLUGIN_ROADMAP.md`.

**Aktivierung = zwei Ebenen** (keine per-User-Aktivierung mehr): (1) **Instanz-Allowlist** `chat.instance_plugin_allowlist`
(Bootstrap-Admin, `GET/PUT/DELETE /admin/plugins[/{name}]`) — Loader registriert nur Allowlist-Plugins; (2) **Pro-Guild-Toggle**
`chat.guild_plugins` (`MANAGE_GUILD`, `PUT /guilds/{id}/plugins/{name}`). Admin-PUT/DELETE wirken **live** (Single-Pod,
`asyncio.Lock`); Guild-Toggle nach ≤60 s (`ws_op_gate`-Cache). Cross-Pod-Notify ist Publish-Only (kein Subscriber, Stufe-B-Vorbereitung).

Die Stolpersteine:
- **`hello` ist Sonderfall**: immer allowlisted (Self-Heal `plugins/allowlist.py` + Seed Migration 0020), nicht entfernbar/togglebar (409); `hello:*`-Ops bypassen Membership + Guild-Toggle.
- **Plugin-Ops müssen `guild_id: SnowflakeId` im Payload führen** (außer `hello:*`). `ws_op_gate`-Error-Codes: 4040 allowlist · 4041 guild_id fehlt · 4042 non-member · 4043 nicht aktiviert.
- **Plugin-Backend muss die DB-Session über `ctx.manager._session_factory` holen** (nicht `from dcc_chat_gateway.db import SessionLocal`) — sonst sehen ws_app-Tests die ungepatchte Memory-DB.
- State: `scope.type` im Manifest = **State-Scope, nicht Activation**. Per-User → `chat.user_preferences`, per-Guild → `chat.guild_plugin_state` (JSONB, Migration 0021), race-safe via `plugins/state_store.py::apply_atomic_update`. Cross-Pod-Broadcasts auf `plugin:<name>:events` (im Manifest `[plugin.uses].channels` deklarieren). Tamagotchi-Widget in der rechten Channel-Sidebar (`<aside data-testid="guild-plugin-rail">`).
- **DMs/Friends-Kontext = plugin-frei** (`guildId === ''`). **Limitation**: kein Server-Push für Toggle-Änderungen → Client sieht sie erst beim nächsten Guild-Mount/Reload.

## Flatpak-Packaging — `packaging/`

`com.howispulse.Pulse` (`flatpak-builder`-Manifest `packaging/com.howispulse.Pulse.yml`). Bündelt das Electron-42-Binary
+ den Python-GSR-Sidecar + einen custom `gpu-screen-recorder` (FFmpeg-mit-NVENC + GSR-from-source + die zwei
`streaming/patches/`). **Web wird NICHT mitgepackt** — die App lädt `https://howispulse.com` remote, Web-Fixes sind
sofort live; nur native Änderungen (Electron-main/preload, Sidecar, GSR-Binary) brauchen einen Rebuild. Lokal bauen:
`packaging/build.fish`. Auto-Publish ins signierte OSTree-Repo bei `main`-Pushes, die native Flatpak-Inhalte ändern, via
`.github/workflows/flatpak.yml`.
**Häufigster Crash:** das Electron-Binary muss mit `strip-components: 0` entpackt werden — der flatpak-builder-Default `1`
plättet `locales/`+`resources/` → Electron findet `resources/default_app.asar` nicht → Exit 1 vor `main.cjs`.
Voll-Doku (Signing-Key, Distribution, Auto-Update, Troubleshooting) → `packaging/README.md`.

## Produktiv-Deployment (netcup-VPS) — Voll-Doku `infra/prod/DEPLOY.md`

**Hauptserver/Cloud = netcup `michael@159.195.150.54`** (Debian 13), erreichbar **https://howispulse.com**
(Umzug von Hetzner am 2026-05-28). Der **alte Hetzner-VPS `michael@77.42.71.166` lebt weiter** — er wird
als **Self-Host-Test-Instanz** verwendet (um die Self-Hosted-Geschichte / das Cert-Modell auszuprobieren),
ist aber NICHT mehr die Cloud. SSH-Details der Server in den privaten Deployment-Notizen.
Ein Compose-Stack (`name: pulse`) in `~/pulse/infra/prod/`: die 6 Service-Container (GHCR
`ghcr.io/oblivion8282-1337/pulse-*:latest`), `pulse_migrate_{auth,chat}` (`alembic upgrade head`),
`pulse_mediamtx` + `pulse_livekit` (`network_mode: host`, gepinnt), `pulse_watchtower` (`--scope pulse`, 5min).
- **Auto-Update:** push → `main` → `.github/workflows/ci.yml` baut+pusht die Images nach GHCR (`:latest`+`:sha`, nach
  grünen Tests) → `pulse_watchtower` zieht `:latest` ≤5 min später. Struktur-Änderungen (neuer Service / Env-Var /
  Compose-/nginx-/MediaMTX-/LiveKit-Config): `rsync infra/ → ~/pulse/infra/` + `cd ~/pulse/infra/prod && docker compose up -d`.
- **Routing:** Caddy (`~/caddy/Caddyfile`, vhost `howispulse.com` → `pulse_web:80`, LE-Cert) → `pulse_web` nginx
  (`infra/prod/web-nginx.conf`, im Image gebacken) → `/api/{auth,chat,ws,voice}/*` an die Services, `/whep/*`+`/hls/*` an
  MediaMTX, `/livekit/*` an LiveKit. Die nginx-Routen zu den host-Network-Diensten (MediaMTX/LiveKit) nutzen **statisches**
  `proxy_pass http://host.docker.internal:PORT/` (nicht Variable+Resolver — Dockers `127.0.0.11` kennt
  `host.docker.internal` nicht → wäre 502).
- **Gotchas:** Secrets nur server-seitig in `~/pulse/infra/prod/.env` (gitignored, aus `.env.example`) + `secrets/jwt_*.pem`
  — **PEM-Files `chmod 0644`** (Container = uid 10001). Avatar-Volume `pulse_avatars`: bei Fresh-Deploy prüfen dass es
  `app:app` gehört, sonst `docker exec -u root pulse_auth chown -R 10001:10001 /app/services/auth/uploads` (sonst
  Avatar-Upload 500 `PermissionError`). UFW: LiveKit/MediaMTX-Ports öffentlich offen, aber `7880` (LiveKit-Signaling) +
  `9997` (MediaMTX-API) nur vom Docker-Bridge (`ufw allow from 10.0.0.0/8 …`) — sonst blockt `INPUT DROP` den
  Bridge→Host-Weg, den `pulse_web` + `pulse_media_svc` brauchen.

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

Am einfachsten: **`scripts/dev-up.fish`** bringt den ganzen Dev-Stack hoch (Postgres/Redis/LiveKit/MediaMTX + die 5
uvicorns mit `--reload` + Vite + Electron-Dev). Gegenstück: `dev-down.fish`. Manueller Einzelstart, falls nötig — Env
gemeinsam: `REDIS_URL=redis://localhost:6380/0`, `AUTH_JWKS_URL=http://127.0.0.1:8001/.well-known/jwks.json`.
- **auth / chat-gateway**: zusätzlich `POSTGRES_PASSWORD`, `JWT_PRIVATE_KEY_FILE`+`JWT_PUBLIC_KEY_FILE` (absolute Pfade zu `secrets/jwt_*.pem`); chat-gateway zusätzlich `MEDIA_SVC_URL=http://127.0.0.1:8004`. Account-Selbstlöschung (`DELETE /me`) braucht `INTERNAL_SERVICE_SECRET` (identisch in auth+chat) + `CHAT_GATEWAY_URL` — sonst 503.
- **voice-signaling**: dieselben LiveKit-Keys wie `infra/livekit/livekit.yaml` / `.env` (sonst „invalid token: error in cryptographic primitive" + Webhook-Sig-Fail): `LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=devsecretdevsecretdevsecretdevsecret`, `LIVEKIT_URL=ws://localhost:7880`. `.env` + `livekit.yaml` sind die Single Source of Truth (Dev-Werte, kein Geheimnis).
- **media-svc**: zusätzlich `MEDIAMTX_API_URL=http://localhost:9997/v3/paths/list`. Läuft MediaMTX nicht → Poller loggt nur `mediamtx_poll_failed`, kein Crash.

Einzelne Infra-Container ohne `dev-up.fish`: MediaMTX `docker compose -f streaming/server/docker-compose.yml up -d`,
LiveKit `docker compose --profile voice up -d`.

## Tests

- Backend: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q`. Pro-Service-Tests unter `services/*/tests/` (MediaMTX/LiveKit gemockt; Redis-Index `/1`).
- **Flake-Retry (Übergangslösung)**: CI-pytest läuft mit `--reruns 2 --reruns-delay 1 --only-rerun "AssertionError" --only-rerun "RuntimeError"` (nur transiente Logik-Fehler, keine Setup-Bugs). Root-Cause: Cache-Mutation-Races (z.B. `test_send_in_dm_after_unfriend_403`) sollten mit dem `SELECT FOR UPDATE`-Pattern aus `plugins/state_store.py::apply_atomic_update` gefixt werden statt auf Retry zu vertrauen.
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
- ❌ **Tauri** als Desktop-Wrapper (WebKitGTK-WebRTC zu unzuverlässig für LiveKit-Voice → 2026-05-12 auf Electron migriert, `PLAN.md` §17) · ❌ `electron-store` als Dep (ESM-only → CJS-Friktion; hand-rolled `store.ts` reicht) · ❌ React-Bridge in SvelteKit für LiveKit-React-Components
- ❌ `@livekit/krisp-noise-filter` (kostenpflichtig seit 2026-05-01) · ❌ `deepfilternet3-noise-filter` (klingt kratzig/metallisch durch Spektral-Masking + Worklet hatte einen Underrun-Bug der Wörter chopt — 2026-05-16 raus) · ❌ `svelte-french-toast` (Sv5-inaktiv) · ❌ `svelte-markdown` blind (kein Sanitizer)
- ❌ Exactly-once-Delivery anstreben · ❌ Re-Publishing MediaMTX→LiveKit (Transcoding zu teuer)
- ❌ Routes-/Service-Dateien über die Größen-Grenze wachsen lassen statt zu splitten
- ❌ Existierende GSR-Files im Original anfassen (`~/Dokumente/GPU_Screen_Recorder/`) — nur die vendored `streaming/`-Kopie
