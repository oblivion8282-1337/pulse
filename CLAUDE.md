# Claude-Notizen für dieses Projekt

Projekt: **Pulse — Web-First Discord-artiger Chat + Voice + HQ-Screen-Streaming**.
Monorepo: uv-Workspace (Backend) + pnpm-Workspace (`web`, `desktop`).
Vollständige Architektur + History: `PLAN.md`, `infra/prod/DEPLOY.md`, `streaming/README.md` und `git log`.
**Hier nur die nicht-offensichtlichen Dinge** — Mechanik-Details stehen in den verlinkten Docs, nicht hier.
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

Genaue Versionen in `uv.lock` / `pnpm-lock.yaml` / `package.json`. Runtimes: **Python** 3.14 (`>=3.13,<3.15`) · **uv** · **Node** 25 · **pnpm** 10. Ruff `line-length=100`, `target-version=py313`, `ignore=["E501"]`.

**Backend** (`services/*` + `shared/`) — FastAPI + uvicorn, SQLAlchemy[asyncio] (**eigenes Schema pro Service**: `auth`/`chat`), asyncpg (Prod) / aiosqlite (Tests), Alembic (pro Service unter `alembic/versions/`), pydantic v2. Nicht-offensichtlich:
- **pyjwt[crypto]**: RS256. `PyJWKClient.from_jwks` fehlt in der Version → Eigenbau via `RSAAlgorithm.from_jwk` in `security.py`.
- **argon2-cffi**: Argon2id (t=3/m=64MiB/p=4). **slowapi**-Rate-Limit in auth-svc ist **in-process**.
- **redis** async: ConnectionManager nutzt `psubscribe` + `get_message()`-Poll (kein `listen()`-Race).
- **email-validator** blockt special-use-TLDs → Tests nutzen `dcc-test.example.com`, nicht `*.test`.
- **py_webauthn** (Passkeys, CBOR/COSE/Attestation) + `pyotp`/`qrcode[pil]` (TOTP) — kein Eigenbau.
- **pytest** + pytest-asyncio: `--import-mode=importlib`, `asyncio_mode=auto`.

**Frontend** (`web/`, SvelteKit-SPA, `ssr=false`, `adapter-static`) — Svelte 5 Runes, Tailwind 4 (shadcn-Tokens im `.dark{}`-Block), valibot (Response-Validation), shadcn-svelte / bits-ui (`web/src/lib/components/ui/`, Vendor — Größen-Policy ausgenommen). Nicht-offensichtlich:
- Build → `web/build/` → `pulse_web`-nginx-Image. **Die Electron-App lädt die *deployte* Web-App remote**, nicht `web/build/`.
- Vite-Dev-Proxy: `/api/auth`→:8001 · `/api/chat`+`/api/ws`→:8002 · `/api/voice`→:8003.
- **livekit-client**: `lib/voice/livekit.svelte.ts` abonniert rohe `Room`/`Participant`-Events (kein `@livekit/components-core`-Wrapper, obwohl installiert).
- **@sapphi-red/web-noise-suppressor**: Mic-Filter RNNoise→NoiseGate (`lib/voice/noiseFilter.ts`). **`MediaStreamDestinationNode.channelCount = 1` zwingend setzen** — Default ist Stereo + `channelCountMode "explicit"` → mono-Worklet füllt nur output[0], rechter Kanal stumm.
- **mode-watcher**: Light/Dark/System via `setMode()` (`settings.svelte.ts`), persistiert in `dcc.settings`; FOUC-Inline-Script in `app.html`.
- **@svelte-put/shortcut**: In-Window-PTT-Hotkey (Taste aus `settings.voice.pttKey`).
- Tests: `@playwright/test` E2E (`web/tests/e2e/`) + `svelte-check` (`pnpm check`). Kein Vitest/Unit.

**Desktop** (`desktop/`, Electron — `@dcc/desktop`, pnpm-Member):
- electron 42.0.1 (gepinnt) bundlet Node 22.x. **Kein `postinstall`** — Binary wird beim ersten `require('electron')` lazy gezogen.
- esbuild bundlet `electron/{main,preload}.ts` (zieht `sidecar.ts`+`store.ts` mit) → `electron/dist/*.cjs` (`build:electron`).
- `desktop/package.json` ist CJS (**ohne** `"type":"module"`), `"main":"electron/dist/main.cjs"`.
- Scripts: `dev` (build + `PULSE_DEV_URL=:5173 electron .` gegen Vite) · `prod` (lädt `https://howispulse.com`) · `start` (ohne Rebuild). DevTools nur bei `PULSE_DEVTOOLS=1`/Strg+Shift+I. Build-Check ohne GUI: `cd desktop && pnpm run build:electron`.
- Voice funktioniert im Electron-Fenster (Chromium-WebRTC) — Grund für den Tauri→Electron-Pivot.
- **Windows-Distribution = NSIS-Installer + electron-updater-Auto-Update** (`dist:win`): pollt `https://howispulse.com/updates/win/latest.yml`, verifiziert per SHA512, unsigniert (SmartScreen nur beim Erst-Download). Logik `electron/updater.ts` (gated `app.isPackaged && win32`), Bridge `window.pulse.updates.*`, Banner via sonner. CI `.github/workflows/win-build.yml` scpt den Feed (kein `--delete` → Delta). Voll-Doku: `docs/plans/2026-05-31-windows-auto-update.md`. **Globaler PTT-Shortcut fehlt** (Electrons `globalShortcut` kann nur Press, kein Hold) — `lib/platform/ptt.ts::initDesktopPtt()` ist No-op-Stub; In-Window-PTT ist der aktive Pfad. TODO auch: Notifications-IPC in `main.ts`.

**Infra (Dev):** `docker-compose.yml` — Postgres `postgres:16-alpine`, Redis `redis:7-alpine`, LiveKit (`--profile voice`, **`network_mode: host`**). MediaMTX *separat* via `streaming/server/docker-compose.yml` (`network_mode: host`).

## Architektur — die nicht-offensichtlichen Stücke

**Snowflake-IDs als Strings über die API-Grenze** (REST, WS, Responses) — JS `Number` kann 64-bit nicht exakt. Backend-Schemas: `SnowflakeId`-`BeforeValidator` (int *oder* string); Frontend sendet immer string. Format `[42-bit ms ab 2026-01-01][10-bit worker][12-bit seq]`, Worker auth=1/chat=2/voice=3.

**Services kommunizieren nur über Redis Pub/Sub oder HTTP** — niemals shared DB-Tabellen. chat-gateway-Routes = APIRouter-Module unter `services/chat-gateway/src/dcc_chat_gateway/routes/`.

**WS-Auth**: Access-Token als Query-Param (`/ws?token=…`) — Browser-WebSocket kann keine Custom-Header. Expired/ungültig → close 4001.

**LiveKit/MediaMTX `network_mode: host`**: Host-UFW (`INPUT DROP`) blockt Container→Host über die Bridge; nur mit host-Networking erreichen LiveKit `127.0.0.1:8003` (Webhooks), MediaMTX den auth-hook (`:8005`), media-svc die MediaMTX-API (`:9997`).

**Bootstrap-Admin** (2026-05-18): `POST /register` setzt `is_admin=true` automatisch, wenn der neue User der einzige in `auth.users` ist (`COUNT(*) == 1` nach flush; Mastodon/Gitea-Pattern). Race bei Parallel-Registrierung bewusst akzeptiert.

**2FA — TOTP + WebAuthn/Passkeys** (2026-05-21, beide auth-svc; Routes `routes_totp.py`/`routes_webauthn*.py`/`passkeys.py`):
- **Challenge-State = signiertes JWT** ("challenge ticket"), kein State-Table/Redis — wie `mfa_ticket`, `purpose`-Claim trennt reg/auth. Funktioniert deshalb im SQLite-Test.
- `POST /login` ist MFA-gated bei `totp_enabled` **oder** ≥1 Passkey → `LoginMfaPending{mfa_ticket, methods[]}`. **Passwortloser Passkey-Login** (`/login/webauthn/*` ohne ticket): discoverable, `userVerification=required` → allein echte MFA, umgeht TOTP bewusst. Mit ticket = 2FA-Zweitfaktor.
- **rpId/Origin** (`WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGIN`): rpId muss Domain-Suffix der Origin sein. **Dev: `localhost`, NICHT `127.0.0.1`** — IP kann keine rpId sein. Folge: E2E-Origin `127.0.0.1:5173` → echte Ceremony dort nicht lauffähig, `passkeys.spec.ts` mockt `/webauthn/*` (Krypto-Pfad deckt `test_webauthn.py` ab).
- **Backup-Codes sind MFA-weit**, nicht TOTP-spezifisch (erster Passkey ohne sonstiges MFA erzeugt 10; werden nur gedroppt, wenn danach kein Faktor übrig).

**`allow_guild_creation` default = FALSE** (Migration 0010): Fresh-Deploys locked-down — nur Bootstrap-Admin legt Server an, öffnet's via `/admin/permissions`. `allow_member_invites` bleibt `true` (per-guild via `CREATE_INVITES`). conftest seedet die Singleton mit `true` (sonst müssten 80% der Tests durch den Toggle).

**Permissions** (Voll-Discord, 2026-05-18) — Bits + Resolver in `dcc_shared/permissions.py` / `permission_resolver.py` (pure-Python via `PermissionContext`-Protocol); Frontend spiegelt in `lib/permissions/bitfield.ts` mit BigInt (**synchron halten**). 3 Tabellen (`roles`/`member_roles`/`permission_overwrites`). Stolpersteine:
- Formel `final = (base | allow) & ~deny`; **!VIEW_CHANNEL → revoke_all-Invariante** (Exploit-Schutz). Reihenfolge: @everyone → role-overwrites (position-order) → user-overwrite.
- `GRANT_ALL_SAFE = (1<<52)-1` — Owner/ADMIN resolven dahin, **NICHT `~0`** (reserved bits = Null, JS-Number-safe).
- `assert_overwrite_within_editor_scope()` — Anti-Escalation: Editor muss jedes Bit selbst halten, das er grantet/un-deny't.
- POST /guilds **auto-seedet** `@everyone` (Migration 0009 für Bestand).
- `ConnectionManager._filter_by_view_channel` gatet `chat:channel:*`/`voice:events`/`stream:events`/`watch:events`; **DM-Channels passieren ungefiltert**. Per-Socket `_ws_perms`-Cache.
- **Server-Delete + Owner-Transfer bleiben Owner-only** (ADMIN bypasst Delete, NICHT Transfer). MANAGE_GUILD = nur rename/icon/settings.

**Voice-Presence**: LiveKit-Webhooks → voice-signaling `POST /webhook` (Sig via `WebhookReceiver`, Key `webhook:`-Block in `livekit.yaml`) → pflegt Redis-Sets `voice:room:channel-<id>` → published `voice:events`. chat-gateway broadcastet `voice_state`; Re-Sync über den `ready`-Frame. `GET /guilds/{id}/voice-state` existiert ohne Frontend-Consumer.
- **Reconcile-Loop** (`voice-signaling/reconcile.py`, 2026-06-03): Webhook-Pfad driftet (verlorene Webhooks bei Deploy + NX-TTL-Trap in dauerbesetzten Channels). Fix: Background-Task pollt LiveKit alle `voice_reconcile_interval_seconds` (default 30, einmal beim Start) und **überschreibt** die Sets via `_set_exact` (non-NX TTL); ist jetzt die Autorität. `voice_reconcile_enabled=false` → Webhook-only. Details im Modul-Docstring.
- **`LIVEKIT_API_URL`** (prod `.env` `=http://host.docker.internal:7880`): server-seitige LiveKit-Calls (Reconcile/Admin-Mute) gehen sonst über die **öffentliche** `LIVEKIT_URL` → crasht 502 genau während eines Deploys (wenn die Web-Schicht weg ist). Direkt-am-Host umgeht das. Braucht `extra_hosts: host.docker.internal:host-gateway`. **Unset → Fallback auf `LIVEKIT_URL`** (dev ok). Browser kriegen weiter `LIVEKIT_URL`.

**HQ-Streaming** (per-User-Pfade, mehrere pro Channel möglich). Voller Datenfluss + Redis-Key-Schema + Route-Signaturen → `streaming/README.md`. Stolpersteine:
- **media-svc** (8004) vergibt Stream-Tokens (chat-gateway reicht nach Membership-Check weiter) + pollt MediaMTX (3s) zum Self-Heal. **mediamtx-auth-hook** (8005) = MediaMTX `authMethod: http`, nur Redis: Publish prüft Token gegen Pfad, Read anonym, Rest 401.
- **Nonce gegen Republish-ICE-Race**: jeder Token-Issue → frische 8-Hex-Nonce → Pfad `channel-<cid>-<uid>-<nonce>` (gleicher Pfad < Sek. später = tote Session, MediaMTX-1.17.1-Bug). `stream:active:*` hält den Live-Pfad **ohne** Nonce für WHEP-Lookup.
- **Redis-Key-Namen dupliziert in `dcc_media_svc/streamkeys.py` + `dcc_mediamtx_auth_hook/shared.py`** (synchron halten).
- chat-gateway braucht `MEDIA_SVC_URL`; fehlt media-svc → **502 nur** auf Stream-Routen.
- Push = **RTMPS** (`rtmps://<host>:1936`, self-signed Cert, UFW `1936/tcp`; plain :1935 bleibt via `rtmpEncryption: optional`).
- Frontend: WHEP-Client `web/src/lib/stream/whep.ts` (hand-rolled). Gating: `isElectron() && (isLinux() || isWindows()) && stream.gsrAvailable`.

**Watch-Party Host-sticky** (2026-06-02): Host **behält** die Party bis explizit `watch_handoff`, **kein Auto-Handoff** mehr. Channel-Wechsel/Unmount (`watch_leave`) beendet sofort; WS-Disconnect startet `WATCH_HOST_GRACE_S` (default 30, E2E=1) Schonfrist gegen Blips. Watcher-Menge ist **in-process** im ConnectionManager (`watch_registry`, Socket-Refcount → Multi-Tab-korrekt, kein Redis, Cross-Pod bewusst nicht). Client-Sync in `web/src/lib/watch/partyController.svelte.ts`. Ops/Codes + UX-Details im Modul. **WS-Tests lokal brauchen `PULSE_INSTANCE_MODE=cloud`** (sonst self-host-Guard-Crash im Lifespan).

**Desktop ↔ Sidecar-Bridge**: Electron-Main spawnt den Plattform-Sidecar **lazy** beim ersten `gsr:call` — Linux = Python (`streaming/gsr-sidecar/control.py`), Windows = Rust (`streaming/win-hq-sidecar/...exe`); beide sprechen dasselbe **stdio-JSON-RPC** (Request `{"op",..,"id"?}` → Response `{"id","ok",..}`; Event `{"ev",..}`; voll in `streaming/README.md`). `desktop/electron/sidecar.ts` (`SidecarManager`-Singleton). Path-Resolver pro Plattform via `$PULSE_SIDECAR_PY`/`$PULSE_HQ_SIDECAR` → Walk-up → Flatpak/`%LOCALAPPDATA%`-Default. Renderer-API `window.pulse.gsr.*` (Shape in `web/src/lib/platform/pulse.d.ts` — **mit `preload.ts` synchron halten**).
- **Testen ohne realen Stream**: `printf '{"op":"health","id":1}\n...' | python3 streaming/gsr-sidecar/control.py` — **KEIN `{"op":"start"}`** (öffnet Wayland-Portal + streamt wirklich); `build_argv` baut nur die argv.
- **GSR-Binary-Resolver**: `$GSR_BINARY` → Flatpak → Custom-Build (`$XDG_CACHE_HOME/pulse/gsr/...` von `bootstrap-gsr.fish`) → PATH. Fehlt alles → `health.gsr.available=false`. Persistenter Cache-Pfad überlebt Reboots (`/tmp` war tmpfs → HQ nach Reboot weg).
- **Windows-HQ-Sidecar** (`streaming/win-hq-sidecar/`, Rust): WGC-Capture, wasapi, ffmpeg-next gegen vendored BtbN-LGPL-DLLs. Drei Encode-Pfade (NVENC D3D11-Zero-Copy · AMD D3D12VA nativ — umgeht crashende AMF · CPU-Fallback). Voll: `streaming/win-hq-sidecar/README.md`, Pfad-Recherche `WINDOWS_HQ_SIDECAR.md`.

**Settings-Persistenz (Electron)**: `desktop/electron/store.ts` = hand-rolled KV-Store (**bewusst kein `electron-store`** — ESM-only → CJS-Friktion). `<userData>/pulse-stream.json`, sync read/write. Linux-Hardening: `chmod 700`/`600` (kann Custom-Server-Stream-Keys im Klartext halten). Renderer: `web/src/lib/stream/persistence.ts` → `window.pulse.store.*`, `localStorage`-Fallback im Browser.

**Frontend-Plattform-Detection**: `web/src/lib/platform/runtime.ts` — `isElectron()`/`isDesktop()`/`isLinux()`. Dev-Test-Route `/app/dev/stream` (nicht im Menü) = Sidecar-Op-Diagnose.

## Self-Host-Identität, Registrierung & Mandatory-SSO (Cert-Modell)

Cert-Modell **auf main gemergt** (PR #11). Minecraft-Modell: Identität zentral über die Cloud (howispulse.com), Server sind isolierte Welten. **Voll-Konzept: `IDENTITY_CONCEPT.md`** + Memory `cert-modell-block-status`. Die nicht-offensichtlichen Stücke:

**Instanz-Rolle (Env, chat-gateway *und* auth-svc):**
- `PULSE_INSTANCE_MODE` = `cloud` | `self-host` (**Default `self-host`!**). Prod-Cloud-`.env` setzt `cloud`.
- `PULSE_INSTANCE_ID` (0 = Cloud; ≥100 = von Cloud bei Approval vergeben).
- `PULSE_INSTANCE_OWNER_ID` (chat-gateway) = Cloud-User-ID des Self-Host-Owners → beim Cert-Login wird `cert.user_id == owner_id` **automatisch Admin** (sonst hat Self-Host keinen Admin).
- `ALLOW_LOCAL_ACCOUNTS` (auth-svc, Default false) = Escape-Hatch für lokale Passwort-Registrierung.

**Registrierung** (`auth_settings.registration_mode`: open|invite_only|closed): Self-Host (`mode != cloud`) **blockt `POST /register`** by default → Identität per Cert-Login von der Cloud. `invite_only` verlangt Code (Modell `registration_invites`, Migration 0022, atomarer guarded-UPDATE; Deep-Link `…/register?invite=CODE`).

**Cert-Login** (`routes/cert_login.py`): Challenge/Verify mit **Geräte-Schlüssel-Proof-of-Possession** (Ed25519 über Server-Nonce) → Cert allein reicht NICHT, replay-sicher. Mintet lokalen Session-Token (`session_tokens.py`, EdDSA, 5 Min). Self-Host nutzt **pairwise_sub** (Privacy). `credential_validator.py` prüft Cloud-JWKS + CRL.

**Admin-Status fließt pro Server**: Session-Token trägt `admin`-Claim → `ws_ready` liefert `is_admin` pro Server → Frontend `serverAdmin`-Store gated das Admin-Panel (Cloud: auth `/me`; Self-Host: ready-Frame, da Cert-User dort kein auth `/me` haben).

**Self-Host-Instanz-Verwaltung ist cloud-only**: `routes_admin_instances` hinter `_require_cloud`; Frontend blendet `AdminInstances` auf Self-Hosts aus. Nur die Cloud entscheidet, wer self-hosten darf.

**Public well-known-Endpoints** (auth-svc, Root): `/.well-known/{jwks.json, revoked-credentials, pulse-version-policy.json, pulse-suspended-instances}` — Self-Hosts pollen die. **`web-nginx.conf` muss sie explizit an auth-svc routen** (Regex-Location), sonst SPA-Fallback → Poller scheitern still mit JSONDecodeError. `acme-challenge` bewusst ausgespart.

**Presence-Status dauerhaft**: manueller Status (online/idle/dnd/invisible) wird neben Redis (24h-TTL) in `chat.user_preferences` gespiegelt; `ws_ready` restored ihn, wenn der Redis-Key abgelaufen ist. Auto-Sweeper-Übergänge bleiben Redis-only.

**UI-Terminologie**: Discord-„Guild" heißt im UI **„Community"**, „Server" = Pulse-Instanz. Code-Bezeichner bleiben `guild`/`Guild`. Memory `pulse-terminology`.

**E2E-Server-Vault** (2026-06-03): Zero-Knowledge-Sync der Self-Host-Server-Liste. `pulse.servers` ist gerätelokal → neues Gerät = Server weg (Privacy-Design). Vault verschlüsselt die Nicht-Cloud-Liste clientseitig (Argon2id→AES-256-GCM, **gleicher Master-Passwort-Key wie das Cloud-Key-Backup**) → opaker Blob in `encrypted_server_vaults` (auth-svc, Migration 0026). **Voraussetzung: User hat ein Cloud-Backup-Passwort.** Voll-Details (Krypto-Helfer, zwei Entsperr-Pfade `unlockForSetup`/`unlockForRestore`, IDB-Key, debounced Push, v1-Limits) → Memory `e2e-server-vault`. Code: `lib/identity/vault-crypto.ts` + `server-vault.svelte.ts`. Tests: `test_server_vault.py` (13) + `server-vault.spec.ts` (2).

## Plugin-System (Stufe A)

Top-Level `plugins/` (Referenz: `hello` + `tamagotchi`). Manifest = `plugin.toml` (Backend) + `manifest.ts` (Frontend-Spiegel, **manuell synchron halten**). Loader: `chat_gateway/plugins/loader.py` + `web/src/lib/plugins/loader.ts`. Ops **colon-namespaced** (`tamagotchi:feed`). Mechanik + Stufe B/C → `docs/PLUGIN_ROADMAP.md` + Memory `plugin-sandbox-future`.
- **Prod-Discovery braucht `plugins/` in ZWEI Images**: `web/Dockerfile` (Frontend-Spiegel) + `Dockerfile.service` (chat-gateway, `discover_plugins_dir()` sucht `/app/plugins`). Ohne `COPY plugins/` → alle Plugins „verwaist", nie geladen.
- **Aktivierung zwei Ebenen**: Instanz-Allowlist `chat.instance_plugin_allowlist` (`/admin/plugins`, live) + Pro-Guild-Toggle `chat.guild_plugins` (`MANAGE_GUILD`, ≤60 s via `ws_op_gate`-Cache).
- **`hello` ist Sonderfall**: immer allowlisted (Seed Migration 0020), nicht entfernbar (409); `hello:*` bypassen Membership + Toggle.
- **Plugin-Ops müssen `guild_id: SnowflakeId` führen** (außer `hello:*`). `ws_op_gate`-Codes: 4040 allowlist · 4041 guild_id fehlt · 4042 non-member · 4043 nicht aktiviert.
- **Plugin-Backend holt die DB-Session über `ctx.manager._session_factory`** (nicht `from …db import SessionLocal`) — sonst sehen ws_app-Tests die ungepatchte Memory-DB.
- State-Scope (≠ Activation): per-User → `chat.user_preferences`, per-Guild → `chat.guild_plugin_state` (Migration 0021, race-safe via `state_store.py::apply_atomic_update`). **DMs/Friends-Kontext = plugin-frei** (`guildId === ''`); Toggle-Änderungen erst beim nächsten Guild-Mount sichtbar (kein Server-Push).

## Flatpak-Packaging — `packaging/`

`com.howispulse.Pulse` (`flatpak-builder`-Manifest). Bündelt Electron-42 + Python-GSR-Sidecar + custom `gpu-screen-recorder`. **Web wird NICHT mitgepackt** (lädt remote) → nur native Änderungen brauchen Rebuild. Lokal: `packaging/build.fish`. Auto-Publish ins OSTree-Repo bei nativen `main`-Pushes (`.github/workflows/flatpak.yml`).
**Häufigster Crash**: Electron-Binary muss mit `strip-components: 0` entpackt werden — Default `1` plättet `locales/`+`resources/` → `default_app.asar` fehlt → Exit 1 vor `main.cjs`. Voll-Doku + Memory `flatpak-electron-startup-failures` → `packaging/README.md`.

## Produktiv-Deployment (netcup-VPS) — Voll-Doku `infra/prod/DEPLOY.md`

**Hauptserver/Cloud = netcup `michael@159.195.150.54`** (Debian 13), **https://howispulse.com** (Umzug von Hetzner 2026-05-28). Der **alte Hetzner-VPS `michael@77.42.71.166` lebt weiter** als **Self-Host-Test-Instanz** (NICHT mehr Cloud). Ein Compose-Stack (`name: pulse`) in `~/pulse/infra/prod/`: 6 Service-Container (GHCR `ghcr.io/oblivion8282-1337/pulse-*:latest`), `pulse_migrate_{auth,chat}`, `pulse_mediamtx`+`pulse_livekit` (host-net), `pulse_watchtower` (5min).
- **Auto-Update**: push → `main` → `ci.yml` baut+pusht GHCR (nach grünen Tests) → watchtower zieht `:latest` ≤5 min. Struktur-Änderungen (neuer Service/Env/Config): `rsync infra/ → ~/pulse/infra/` + `docker compose up -d`.
- **Routing**: Caddy → `pulse_web` nginx → `/api/{auth,chat,ws,voice}/*` Services, `/whep`+`/hls` MediaMTX, `/livekit` LiveKit. Routen zu host-net-Diensten nutzen **statisches** `proxy_pass http://host.docker.internal:PORT/` (nicht Variable+Resolver — Dockers `127.0.0.11` kennt `host.docker.internal` nicht → 502).
- **Gotchas**: Secrets nur server-seitig in `.env` + `secrets/jwt_*.pem` — **PEM `chmod 0644`** (Container uid 10001). Avatar-Volume bei Fresh-Deploy `chown 10001:10001` (sonst Upload-500). UFW: `7880`/`9997` nur vom Docker-Bridge (`ufw allow from 10.0.0.0/8`) — sonst blockt `INPUT DROP` den Bridge→Host-Weg. Migrate-Container nach Schema-Änderung: Memory `watchtower-skips-migrate-containers`.

## Port-Mapping (lokales Dev)

| Dienst | Port | |
|---|---|---|
| Postgres | **5434** | nicht 5433/5432 (Schwester-Worktree belegt); `.env` reflektiert das |
| Redis | **6380** | `REDIS_URL=redis://localhost:6380/0` |
| auth-svc | 8001 | `uvicorn dcc_auth.app:app` |
| chat-gateway | 8002 | `uvicorn dcc_chat_gateway.app:app` |
| voice-signaling | 8003 | `uvicorn dcc_voice_signaling.app:app` |
| media-svc | 8004 | Stream-Tokens + State + Poller |
| mediamtx-auth-hook | 8005 | MediaMTX `authHTTP` |
| web (Vite dev) | 5173 | `http://127.0.0.1:5173` |
| LiveKit | 7880 (+7881, 7882–7892/udp) | `network_mode: host` |
| MediaMTX | 1935/1936/8888/8889/8890/8189/9997 | RTMP/RTMPS/HLS/WHEP/SRT/ICE/API — host-net, API (9997) nur localhost, Auth → :8005 |

### Service-Start

Am einfachsten **`scripts/dev-up.fish`** (ganzer Dev-Stack: Infra + 5 uvicorns `--reload` + Vite + Electron-Dev; Gegenstück `dev-down.fish`; Stolpersteine in Memory `pulse-local-dev-setup`). Manueller Einzelstart — gemeinsam `REDIS_URL=redis://localhost:6380/0`, `AUTH_JWKS_URL=http://127.0.0.1:8001/.well-known/jwks.json`:
- **auth / chat-gateway**: `POSTGRES_PASSWORD`, `JWT_PRIVATE_KEY_FILE`+`JWT_PUBLIC_KEY_FILE` (absolut); chat-gateway zusätzlich `MEDIA_SVC_URL=http://127.0.0.1:8004`. `DELETE /me` braucht `INTERNAL_SERVICE_SECRET` (identisch auth+chat) + `CHAT_GATEWAY_URL`.
- **voice-signaling**: LiveKit-Keys = `livekit.yaml`/`.env` (`LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=devsecret…`, `LIVEKIT_URL=ws://localhost:7880`).
- **media-svc**: `MEDIAMTX_API_URL=http://localhost:9997/v3/paths/list`. MediaMTX down → nur `mediamtx_poll_failed`-Log.

Einzel-Infra: MediaMTX `docker compose -f streaming/server/docker-compose.yml up -d`, LiveKit `docker compose --profile voice up -d`.

## Tests

- Backend: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q`. Pro-Service unter `services/*/tests/` (MediaMTX/LiveKit gemockt; Redis-Index `/1`).
- **Flake-Retry (Übergangslösung)**: CI-pytest `--reruns 2 --only-rerun "AssertionError" --only-rerun "RuntimeError"`. Root-Cause = Cache-Mutation-Races (Fix: `SELECT FOR UPDATE`-Pattern aus `state_store.py`).
- Frontend: `cd web && pnpm check && pnpm build` (0/0) + `pnpm exec playwright test`. Kein Vitest/Unit.
- E2E-DB = `dcc_test` (separat, `_globalSetup.ts` migriert + truncated nur sie; Dev-DB `dcc` nie angefasst). Test-Redis `/1`. Playwright lokal braucht `PULSE_INSTANCE_MODE=cloud` (Memory `e2e-pulse-instance-mode-cloud`).
- **Manuell, nicht automatisiert**: echter GSR-`start` (Portal + realer Push), Electron-GUI-Sichttest, HQ-Stream-E2E (2 Clients).
- **Vor jedem Commit**: pytest + `pnpm check` + `pnpm build` + Playwright.

## Konventionen

- **Kein `git push` / keine GitHub-CLI** ohne explizite Freigabe. Remote: `origin` → `github.com/oblivion8282-1337/pulse.git`.
- **Refactoring darf das Verhalten nicht ändern** — Endpoint-Pfade, Response-Models, `data-testid` bleiben identisch. Bricht ein Test nach Refactor → der Code ist kaputt, nicht der Test.
- **Code-Größen-Policy** (`PLAN.md` §12.1): Source ≤ 350 Z. (hart 500), Svelte-Components ≤ 250. Ausgenommen: Tests, Migrationen, `lib/components/ui/`. Im Zweifel splitten.
- **Lies zuerst, ändere danach. Keine neuen Dependencies ohne Rückfrage. Tests proaktiv laufen lassen.**
- **Niemals Stream-Keys/Tokens loggen.** `~/Dokumente/GPU_Screen_Recorder/` ist READ-ONLY — nur vendored `streaming/`-Kopie modifizieren.

## Anti-Patterns (voll in `PLAN.md` §12)

- ❌ Shared DB-Tabellen zwischen Services · ❌ HS256 JWT (nur RS256)
- ❌ `fastapi-users` / `broadcaster` / `fastapi-socketio` / `fastapi_websocket_pubsub` (archiviert → Eigenbau)
- ❌ State-Library (Redux/Zustand/Pinia) neben Svelte-Runes · ❌ CSS-in-JS (Tailwind reicht)
- ❌ **Tauri** als Desktop-Wrapper (WebKitGTK-WebRTC unzuverlässig → 2026-05-12 auf Electron, `PLAN.md` §17) · ❌ `electron-store` (ESM-only) · ❌ React-Bridge für LiveKit-Components
- ❌ `@livekit/krisp-noise-filter` (kostenpflichtig) · ❌ `deepfilternet3-noise-filter` (kratzig + Worklet-Underrun) · ❌ `svelte-french-toast` (Sv5-inaktiv) · ❌ `svelte-markdown` blind (kein Sanitizer)
- ❌ Exactly-once-Delivery · ❌ Re-Publishing MediaMTX→LiveKit (Transcoding zu teuer)
- ❌ Routes-/Service-Dateien über die Größen-Grenze wachsen lassen statt splitten
