# Claude-Notizen für dieses Projekt

Projekt: **Pulse — Web-First Discord-artiger Chat + Voice + HQ-Screen-Streaming**.
Monorepo: uv-Workspace (Backend) + pnpm-Workspace (`web`, `desktop`).
Vollständige Architektur + History: `PLAN.md`, `infra/prod/DEPLOY.md`, `streaming/README.md` und `git log`.
**Hier nur die nicht-offensichtlichen Dinge** — Mechanik-Details stehen in den verlinkten Docs, nicht hier.
Alle Stages (Etappe 1/1.5/2, HQ-Streaming, Electron-Pivot, Flatpak) sind auf `main` — kein Worktree mehr.

## Was das Projekt macht

Chat/Voice-Client, **Web-First** (alle Browser), PWA-installierbar, Desktop via **Electron** (`desktop/`), Mobile (Android) via Capacitor/TWA-Wrapper (`packaging/android/`).
Backend = mehrere kleine FastAPI-Services: `services/{auth,chat-gateway,voice-signaling,media-svc,mediamtx-auth-hook,relay-frps-plugin}`.
Voice über LiveKit (WebRTC/Opus). HQ-Screen-Streaming bindet den vendored GPU Screen Recorder
(`streaming/`) als Python-Sidecar ein, pusht über RTMPS an MediaMTX → Viewer holen den Stream per WHEP.

Drei Transportpfade, getrennt: HTTPS/WSS → FastAPI-Services · WebRTC → LiveKit (Voice + Browser-Screenshare)
· WHEP/WebRTC → MediaMTX (GSR-HQ-Streams). Details `PLAN.md` §1.

`~/Dokumente/GPU_Screen_Recorder/` ist **READ-ONLY** (Original) — `streaming/` ist eine vendored Kopie (2026-05-11), nur die wird modifiziert.

## Tech-Stack — die Stolpersteine

Genaue Versionen in `uv.lock` / `pnpm-lock.yaml` / `package.json`. Runtimes: **Python** 3.13 (`>=3.13,<3.15`) · **uv** · **Node** ≥20 (CI 22) · **pnpm** 10. Ruff `line-length=100`, `target-version=py313`, `ignore=["E501"]`.

**Backend** (`services/*` + `shared/`) — FastAPI + uvicorn, SQLAlchemy[asyncio] (**eigenes Schema pro Service**: `auth`/`chat`), asyncpg (Prod) / aiosqlite (Tests), Alembic (pro Service unter `alembic/versions/`), pydantic v2. Nicht-offensichtlich:
- **pyjwt[crypto]**: RS256. `PyJWKClient.from_jwks` fehlt in der Version → Eigenbau via `RSAAlgorithm.from_jwk` in `security.py`.
- **argon2-cffi**: Argon2id (t=3/m=64MiB/p=4). **slowapi**-Rate-Limit in auth-svc ist **in-process**.
- **redis** async: ConnectionManager nutzt `psubscribe` + `get_message()`-Poll (kein `listen()`-Race).
- **email-validator** blockt special-use-TLDs → Tests nutzen `dcc-test.example.com`, nicht `*.test`.
- **py_webauthn** (Passkeys, CBOR/COSE/Attestation) + `pyotp`/`qrcode[pil]` (TOTP) — kein Eigenbau.
- **pytest** + pytest-asyncio: `--import-mode=importlib`, `asyncio_mode=auto`.

**Frontend** (`web/`, SvelteKit-SPA, `ssr=false`, `adapter-static`) — Svelte 5 Runes, Tailwind 4 (shadcn-Tokens im `.dark{}`-Block), shadcn-svelte / bits-ui (`web/src/lib/components/ui/`, Vendor — Größen-Policy ausgenommen). Nicht-offensichtlich:
- Build → `web/build/` → `pulse_web`-nginx-Image. **Die Electron-App lädt die *deployte* Web-App remote**, nicht `web/build/`.
- Vite-Dev-Proxy: `/api/auth`→:8001 · `/api/chat`+`/api/ws`→:8002 · `/api/voice`→:8003.
- **livekit-client**: `lib/voice/livekit.svelte.ts` abonniert rohe `Room`/`Participant`-Events (kein `@livekit/components-core`-Wrapper, obwohl installiert).
- **@sapphi-red/web-noise-suppressor**: Mic-Filter RNNoise→NoiseGate (`lib/voice/noiseFilter.ts`). **`MediaStreamDestinationNode.channelCount = 1` zwingend setzen** — Default ist Stereo + `channelCountMode "explicit"` → mono-Worklet füllt nur output[0], rechter Kanal stumm.
- **mode-watcher**: Light/Dark/System via `setMode()` (`settings.svelte.ts`), persistiert in `dcc.settings`; FOUC-Inline-Script in `app.html`.
- **@svelte-put/shortcut**: In-Window-PTT-Hotkey (Taste aus `settings.voice.pttKey`).
- Tests (web): `@playwright/test` E2E (`web/tests/e2e/`) + `svelte-check` (`pnpm check`). Kein Vitest/Unit im Web. Desktop (`desktop/`) hat Node-Unit-Tests (`pnpm test:unit`, `desktop/test/`).

**Desktop** (`desktop/`, Electron — `@dcc/desktop`, pnpm-Member):
- electron 43.0.0 (gepinnt; Upgrade 2026-07-03 von 42.0.1 — bringt Chromium 150 + den Opus-DTX-Fix webrtc #42233214) bundlet Node 24.x. **DTX ist fest an** (`dtx: true` in `#audioPublishDefaults`, `livekit.svelte.ts`) — kein User-Schalter mehr (2026-07-17 entfernt, vorher `settings.audio.dtxEnabled`). Das setzt den Opus-DTX-Fix voraus — ohne knackst der Wiedereinstieg nach Stille, weshalb Electron 43 die Untergrenze ist. **Kein `postinstall`** — Binary wird beim ersten `require('electron')` lazy gezogen.
- esbuild bundlet `electron/{main,preload}.ts` (zieht `sidecar.ts`+`store.ts` mit) → `electron/dist/*.cjs` (`build:electron`).
- `desktop/package.json` ist CJS (**ohne** `"type":"module"`), `"main":"electron/dist/main.cjs"`.
- Scripts: `dev` (build + `PULSE_DEV_URL=:5173 electron .` gegen Vite) · `prod` (lädt `https://howispulse.com`) · `start` (ohne Rebuild). DevTools nur bei `PULSE_DEVTOOLS=1`/Strg+Shift+I. Build-Check ohne GUI: `cd desktop && pnpm run build:electron`.
- Voice funktioniert im Electron-Fenster (Chromium-WebRTC) — Grund für den Tauri→Electron-Pivot.
- **Windows-Release braucht IMMER einen Version-Bump**: Änderungen, die über den Windows-Installer ausgeliefert werden (`streaming/win-hq-sidecar/**`, `desktop/electron/**`, `desktop/package.json`-Deps), erreichen Bestandsclients NUR, wenn `desktop/package.json` `version` gebumpt wird — electron-updater ignoriert eine erneut publizierte gleiche Version stillschweigend (kein CI-Fehler, das Update kommt einfach nie an; passiert 2026-07-12 fast beim WHIP-Sidecar). Linux (Flatpak/OSTree) hat das Problem nicht — dort publiziert jeder Build ohne Versionsfeld.
- **Windows-Distribution = NSIS-Installer + electron-updater-Auto-Update** (`dist:win`, pollt `.../updates/win/latest.yml`, SHA512, unsigniert): **reiner Hintergrund-Updater, KEIN Boot-Splash mehr** (2026-07-17 umgebaut — der Splash war ein Boot-blockierendes Extra-Fenster, das bei manchen gar nicht erschien und den ganzen Start dahinter aufhängte). `startUpdater()` (`electron/updater.ts`, EIN Aufruf, wired Events + IPC + Boot-/Periodik-Check) lädt im Hintergrund und zeigt den „Update bereit"-Prompt im Renderer (`updates:*`-Events → Banner in `+layout.svelte`). „Neu starten" = `quitAndInstall(false,true)` = **SICHTBARER** Installer (User-Feedback statt stillem Hänger) + `runAfterFinish`-Checkbox-Neustart. Wer nicht klickt: `autoInstallOnAppQuit` beim nächsten echten Beenden — electron-updater hookt `quit` (NICHT `before-quit`), also kompatibel mit dem Sidecar-Shutdown-`before-quit`-Handler (Exit-Code 0). Re-Check Default 60 Min (`PULSE_UPDATE_INTERVAL_MS`), Boot-Check verzögert (`PULSE_UPDATE_INITIAL_DELAY_MS`, 4 s). **`allowDowngrade=false`** → kaputte Live-Version NICHT per `latest.yml`-Rückstellung zurückziehbar; **Folge fürs Testen**: ein lokal installierter Fake-High-Version-Build (z.B. 0.1.99) setzt die Maschine fest, bis real > diese Version → nach dem Test deinstallieren + offiziellen Installer neu ziehen. **Lokaler E2E-Test OHNE Image-Push**: `PULSE_DEV_UPDATE=1` (hebt `app.isPackaged`-Sperre auf, setzt `forceDevUpdateConfig`) + `desktop/dev-app-update.yml` + `desktop/scripts/local-update-feed.mjs` fahren den echten Fluss unter Dev gegen `localhost:8888`. Voll-Doku: `docs/plans/2026-05-31-windows-auto-update.md`.
- **Globaler Hold-to-Talk fehlt** (Electron `globalShortcut` kann nur Press, kein Hold); In-Window-PTT via `lib/shortcuts/` + `desktop/electron/shortcuts.ts`. Native Notifications-IPC gebaut: `desktop/electron/notify.ts::wireNotify()` (in `main.ts` gebootet, Renderer via `window.pulse.notify.*`).

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
- **media-svc** (8004) vergibt Stream-Tokens (chat-gateway reicht nach Membership-Check weiter) + pollt MediaMTX (3s) zum Self-Heal. **mediamtx-auth-hook** (8005) = MediaMTX `authMethod: http`, nur Redis: Publish prüft `scope:publish`-Token gegen Pfad, Read prüft `scope:read`-Token (channel+user-gebunden, NICHT konsumiert — Multi-Use; via `read_token_required=false` abschaltbar), Rest 401. media-svc mintet das Read-Token in `GET /whep` nach dem Membership-Check und hängt es als `?token=` an die WHEP-URL.
- **Nonce gegen Republish-ICE-Race**: jeder Token-Issue → frische 32-Hex-Nonce (`secrets.token_hex(16)`) → Pfad `channel-<cid>-<uid>[-s<slot>]-<nonce>` (Slot = gleichzeitig laufende Streams desselben Users; Slot 0 = Legacy-Pfad ohne `-s0`; gleicher Pfad < Sek. später = tote Session; ursprünglich MediaMTX-1.17.1-Bug #913, upstream in 1.18+ via pion/ice v4.2.5 gefixt — Nonce bleibt als Defense-in-Depth). `stream:active:*` hält den Live-Pfad **ohne** Nonce für WHEP-Lookup.
- **Redis-Key-Namen dupliziert in `dcc_media_svc/streamkeys.py` + `dcc_mediamtx_auth_hook/shared.py`** (synchron halten).
- chat-gateway braucht `MEDIA_SVC_URL`; fehlt media-svc → **502 nur** auf Stream-Routen.
- Push = **RTMPS-only** (`rtmps://<host>:1936`, self-signed Cert, UFW `1936/tcp`; `rtmpEncryption: strict` — plain :1935 ist entfernt).
- Frontend: WHEP-Client `web/src/lib/stream/whep.ts` (hand-rolled). Gating: `isElectron() && (isLinux() || isWindows() || isMac()) && stream.gsrAvailable`.

**Watch-Party Host-sticky** (2026-06-02): Host **behält** die Party bis explizit `watch_handoff`, **kein Auto-Handoff** mehr. Channel-Wechsel/Unmount (`watch_leave`) beendet sofort; WS-Disconnect startet `WATCH_HOST_GRACE_S` (default 30, E2E=1) Schonfrist gegen Blips. Watcher-Menge ist **in-process** im ConnectionManager (`watch_registry`, Socket-Refcount → Multi-Tab-korrekt, kein Redis, Cross-Pod bewusst nicht). Client-Sync in `web/src/lib/watch/partyController.svelte.ts`. Ops/Codes + UX-Details im Modul. **WS-Tests lokal brauchen `PULSE_INSTANCE_MODE=cloud`** (sonst self-host-Guard-Crash im Lifespan).

**Desktop ↔ Sidecar-Bridge**: Electron-Main spawnt den Plattform-Sidecar **lazy** beim ersten `gsr:call` — Linux = Rust (Standard) mit Python-GSR als Fallback (s.u.), Windows = Rust (`streaming/win-hq-sidecar/...exe`), macOS = Rust (`streaming/mac-hq-sidecar/`); alle sprechen dasselbe **stdio-JSON-RPC** (Request `{"op",..,"id"?}` → Response `{"id","ok",..}`; Event `{"ev",..}`; voll in `streaming/README.md`). `desktop/electron/sidecar.ts` (`SidecarManager`-Singleton). Path-Resolver pro Plattform via `$PULSE_SIDECAR_PY`/`$PULSE_HQ_SIDECAR`/`$PULSE_LINUX_HQ_SIDECAR` → Walk-up → Flatpak/`%LOCALAPPDATA%`-Default. Renderer-API `window.pulse.gsr.*` (Shape in `web/src/lib/platform/pulse.d.ts` — **mit `preload.ts` synchron halten**).
- **Linux hat ZWEI Sidecars** (2026-07-17 getauscht, vorher war Rust das Opt-in-Experiment): **Rust = Standard**, Python/GSR = Auffangnetz. `resolveLinuxSpawn()` nimmt Rust; fehlt das Binary, fällt es **automatisch** auf GSR zurück (ohne diesen Rückfall verschwände HQ wortlos bei alter Flatpak-Version / Dev ohne gebauten Crate). Store-Key `useLegacyGsrSidecar` (default false) = Notbremse im **Kompatibilitäts-Tab**, der zusätzlich anzeigt, was läuft (`window.pulse.gsr.backend()` → `{kind, reason}`; `reason: 'fallback'` = ungewollter Rückfall). Wirft nur, wenn BEIDE fehlen.
- **Der Rust-Linux-Sidecar liegt NICHT in diesem Repo**: eigenes Repo `github.com/oblivion8282-1337/pulse-linux-hq-sidecar`, per **Commit im Flatpak-Manifest gepinnt** (`packaging/com.howispulse.Pulse.yml`) → nach `/app/bin/pulse-linux-hq-sidecar` gebaut. Folgen: kein Walk-up-Resolver (Dev braucht `$PULSE_LINUX_HQ_SIDECAR`, `dev-up.fish` setzt sie, wenn `../Linux_Rust_Sidecar/target/release/...` existiert); **ein Commit dort löst KEINEN Flatpak-Build aus** — Pin-Bump + `linux-hq-sidecar-cargo-sources.json` neu generieren ist Handarbeit.
- **Diagnose-Log-Upload** (`experimental-log-upload.ts`) hat einen **eigenen** Opt-in `uploadDiagnosticLogs` (default false). Hing bis 2026-07-17 am Rust-Toggle — als Standard trüge der keine Einwilligung mehr (stille Telemetrie für jeden Linux-Nutzer).
- **Testen ohne realen Stream**: `printf '{"op":"health","id":1}\n...' | python3 streaming/gsr-sidecar/control.py` — **KEIN `{"op":"start"}`** (öffnet Wayland-Portal + streamt wirklich); `build_argv` baut nur die argv.
- **GSR-Binary-Resolver**: `$GSR_BINARY` → Flatpak → Custom-Build (`$XDG_CACHE_HOME/pulse/gsr/...` von `bootstrap-gsr.fish`) → PATH. Fehlt alles → `health.gsr.available=false`. Persistenter Cache-Pfad überlebt Reboots (`/tmp` war tmpfs → HQ nach Reboot weg).
- **Windows-HQ-Sidecar** (`streaming/win-hq-sidecar/`, Rust): WGC-Capture + wasapi, drei Encode-Pfade (NVENC / AMD-D3D12VA / CPU-Fallback). Voll: `streaming/win-hq-sidecar/README.md` + `WINDOWS_HQ_SIDECAR.md`.

**Settings-Persistenz (Electron)**: `desktop/electron/store.ts` = hand-rolled KV-Store (**bewusst kein `electron-store`** — ESM-only → CJS-Friktion). `<userData>/pulse-stream.json`, sync read/write. Linux-Hardening: `chmod 700`/`600` (kann Custom-Server-Stream-Keys im Klartext halten). Renderer: `web/src/lib/stream/persistence.ts` → `window.pulse.store.*`, `localStorage`-Fallback im Browser.

**Frontend-Plattform-Detection**: `web/src/lib/platform/runtime.ts` — `isElectron()`/`isDesktop()`/`isLinux()`/`isWindows()`/`isMac()`/`isCapacitorAndroid()`/`isMobile()`. Dev-Test-Route `/app/dev/stream` (nicht im Menü) = Sidecar-Op-Diagnose.

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

**Self-Host-Approval = Single-Bootstrap pro Antrag**: Antrag → Super-Admin approved (`.../instance-applications/{id}/approve`) → User mintet **genau einmal** einen Bootstrap-Token und löst ihn ein (`POST /selfhost/bootstrap`). Nach Redeem (`consumed_at IS NOT NULL`) sind weitere Mints geblockt (neuer Antrag pro weiterem Server nötig). Container-Crash-Recovery geht trotzdem: der Container nutzt seine persistierten `client_id`/`client_secret` direkt, ohne Re-Redeem. Details `IDENTITY_CONCEPT.md`.

**Public well-known-Endpoints** (auth-svc, Root): `/.well-known/{jwks.json, revoked-credentials, pulse-version-policy.json, pulse-suspended-instances}` — Self-Hosts pollen die. **`web-nginx.conf` muss sie explizit an auth-svc routen** (Regex-Location), sonst SPA-Fallback → Poller scheitern still mit JSONDecodeError. `acme-challenge` bewusst ausgespart.

**Presence-Status dauerhaft**: manueller Status (online/idle/dnd/invisible) wird neben Redis (24h-TTL) in `chat.user_preferences` gespiegelt; `ws_ready` restored ihn, wenn der Redis-Key abgelaufen ist. Auto-Sweeper-Übergänge bleiben Redis-only.

**UI-Terminologie**: Discord-„Guild" heißt im UI **„Community"**, „Server" = Pulse-Instanz. Code-Bezeichner bleiben `guild`/`Guild`. Memory `pulse-terminology`.

**Account-basierte Server-Liste** (seit 2026-06-28): Die Self-Host-Server-Liste lebt in `auth.user_instance_memberships` (Cloud-DB, Migration 0037); beim Bootstrap-Token-Redeem (`routes_selfhost_bootstrap.py`) automatisch eingetragen, `GET /me/instances` liest sie. Inhalts-Privacy unverändert (Cert-Modell: isolierte DB-Welten); nur die Server-Liste selbst ist keine Zero-Knowledge-Garantie mehr — der frühere E2E-Vault ist **komplett entfernt** (Memory `project_server_vault_drop.md`). Erweiterung um eingeladene Nicht-Owner ist für Phase 4-6 vorgesehen (`role`-Feld vorbereitet).

## Plugin-System (Stufe A)

Top-Level `plugins/` (Referenz: `hello` + `tamagotchi`). Manifest = `plugin.toml` (Backend) + `manifest.ts` (Frontend-Spiegel, **manuell synchron halten**). Loader: `chat_gateway/plugins/loader.py` + `web/src/lib/plugins/loader.ts`. Ops **colon-namespaced** (`tamagotchi:feed`). Mechanik + Stufe B/C → `docs/PLUGIN_ROADMAP.md` + Memory `plugin-sandbox-future`.
- **Prod-Discovery braucht `plugins/` in ZWEI Images**: `web/Dockerfile` (Frontend-Spiegel) + `Dockerfile.service` (chat-gateway, `discover_plugins_dir()` sucht `/app/plugins`). Ohne `COPY plugins/` → alle Plugins „verwaist", nie geladen.
- **Aktivierung zwei Ebenen**: Instanz-Allowlist `chat.instance_plugin_allowlist` (`/admin/plugins`, live) + Pro-Guild-Toggle `chat.guild_plugins` (`MANAGE_GUILD`, ≤60 s via `ws_op_gate`-Cache).
- **`hello` ist Sonderfall**: immer allowlisted (Seed Migration 0020), nicht entfernbar (409); `hello:*` bypassen Membership + Toggle.
- **Plugin-Ops müssen `guild_id: SnowflakeId` führen** (außer `hello:*`). `ws_op_gate`-Codes: 4040 allowlist · 4041 guild_id fehlt · 4042 non-member · 4043 nicht aktiviert.
- **Plugin-Backend holt die DB-Session über `ctx.manager._session_factory`** (nicht `from …db import SessionLocal`) — sonst sehen ws_app-Tests die ungepatchte Memory-DB.
- State-Scope (≠ Activation): per-User → `chat.user_preferences`, per-Guild → `chat.guild_plugin_state` (Migration 0021, race-safe via `state_store.py::apply_atomic_update`). **DMs/Friends-Kontext = plugin-frei** (`guildId === ''`); Toggle-Änderungen erst beim nächsten Guild-Mount sichtbar (kein Server-Push).

## Flatpak-Packaging — `packaging/`

`com.howispulse.Pulse` (`flatpak-builder`-Manifest). Bündelt Electron-43 + Python-GSR-Sidecar + custom `gpu-screen-recorder`. **Web wird NICHT mitgepackt** (lädt remote) → nur native Änderungen brauchen Rebuild. Lokal: `packaging/build.fish`. Auto-Publish ins OSTree-Repo bei nativen `main`-Pushes (`.github/workflows/flatpak.yml`).
**Häufigster Crash**: Electron-Binary muss mit `strip-components: 0` entpackt werden — Default `1` plättet `locales/`+`resources/` → `default_app.asar` fehlt → Exit 1 vor `main.cjs`. Voll-Doku + Memory `flatpak-electron-startup-failures` → `packaging/README.md`.

## Produktiv-Deployment (netcup-VPS) — Voll-Doku `infra/prod/DEPLOY.md`

**Hauptserver/Cloud = netcup `michael@159.195.150.54`** (Debian 13), **https://howispulse.com** (Umzug von Hetzner 2026-05-28). Der **alte Hetzner-VPS `michael@77.42.71.166` lebt weiter** als **Self-Host-Test-Instanz** (NICHT mehr Cloud). Ein Compose-Stack (`name: pulse`) in `~/pulse/infra/prod/`: 6 Service-Container (GHCR `ghcr.io/oblivion8282-1337/pulse-*:latest`), `pulse_migrate_{auth,chat}`, `pulse_mediamtx`+`pulse_livekit` (host-net). **Kein Watchtower mehr** (2026-06-11) — Auto-Update läuft über eine **User-Crontab** (`infra/prod/pulse-update.sh`, scoped `compose pull && up -d`); Watchtower mountete den Docker-Socket (= root am Host). Memory `self-host-host-updater`.
- **Auto-Update**: push → `main` → `ci.yml` baut+pusht GHCR → Cron (`pulse-update.sh`) zieht `:latest` ≤5 min (inkl. migrate-Container → Migrationen laufen auto). Struktur-Änderungen (neuer Service/Env/Config): `rsync infra/ → ~/pulse/infra/` + `docker compose up -d`.
- **Deploy ist vom Test-Gate ENTKOPPELT** (2026-06-05): der `images`-Job hängt NUR am `changelog`-Gate, nicht an backend/frontend. Grund: seltene pub/sub-Subscribe-Race-Flakes (thread-Timeout, vom `--only-rerun` nicht gefangen) blockten sonst legitime Deploys. backend+frontend bleiben sichtbare Info-Checks. **Konsequenz: das verbindliche Test-Gate ist LOKAL vor dem Push** — pytest + `pnpm check` + build müssen grün sein, BEVOR gepusht wird (kein CI-Netz mehr danach).
- **Routing**: Caddy → `pulse_web` nginx → `/api/{auth,chat,ws,voice}/*` Services, `/whep`+`/hls` MediaMTX, `/livekit` LiveKit. Routen zu host-net-Diensten nutzen **statisches** `proxy_pass http://host.docker.internal:PORT/` (nicht Variable+Resolver — Dockers `127.0.0.11` kennt `host.docker.internal` nicht → 502).
- **Gotchas**: Secrets nur server-seitig in `.env` + `secrets/jwt_*.pem` — **PEM `chmod 0644`** (Container uid 10001). Avatar-Volume bei Fresh-Deploy `chown 10001:10001` (sonst Upload-500). UFW: `7880`/`9997` nur vom Docker-Bridge (`ufw allow from 10.0.0.0/8`) — sonst blockt `INPUT DROP` den Bridge→Host-Weg. MediaMTX = **1.19.1-pulse**-Fork (seit 2026-06-16; `infra/mediamtx-fork/`, TempDelim-Patch für AMD-VAAPI AV1, Image `ghcr.io/oblivion8282-1337/pulse-mediamtx:1.19.1-pulse`) — #5728 ist geschlossen, Bump vollzogen. **1.19 entfernte `apiAllowAddresses`** → der `:9997`-API-Schutz hängt jetzt **NUR noch an der UFW** (vorher doppelt). Dev-compose (`streaming/server/`) läuft noch 1.17.1-pulse. Migrate-Container laufen seit dem Cron-Updater (2026-06-11) automatisch beim Deploy mit (der frühere manuelle `up -d migrate-*`-Schritt entfällt; Memory `watchtower-skips-migrate-containers` für die Historie/Diagnose).

## CI-Workflows (`.github/workflows/`)

- **Pflicht-Checks (Branch Protection auf `main`):** nur **`CLAAssistant`** (via `cla.yml`). **`backend`/`frontend` sind seit 2026-07-15 KEINE Pflicht mehr** — Entscheidung nach Datencheck (in ~6 Wo. blockten sie 3× während Feature-Dev, sonst nur Flake-Rauschen): das verbindliche Test-Gate ist **LOKAL vor dem Push**; die CI-Tests laufen weiter als Info, blockieren aber keinen Merge. **`scripts/ship.sh` erzwingt das hart:** vor dem Push laufen bei Code-Änderungen automatisch `pytest` + `pnpm check` + `build` — **rot = kein Push** (Doku-only wird übersprungen; Notausgang `SKIP_TESTS=1`). Damit ist das Netz wieder erzwungen statt nur aufgeschrieben.
- **Pfad-Filter-Konvention:** Build-Workflows bekommen `on.push.paths` (`win-build`/`mac-build`/`flatpak`/`allinone`). **`ci.yml`** läuft für Code breit (Tests + 7 Cloud-Images + Deploy), hat aber ein `paths-ignore` (`**.md`/`docs/**`/`.claude/**`) auf **beiden** Triggern → reine Doku-Änderungen lösen weder PR-Check noch Deploy-Build aus (safe, weil `backend`/`frontend` nicht mehr Pflicht sind).
- **`allinone.yml` = Self-Host-Image, Multi-Arch NATIV** (nicht QEMU): 3 Jobs `prepare` → `build`-Matrix (amd64 `ubuntu-24.04` / arm64 `ubuntu-24.04-arm`, Push per Digest) → `merge` (`imagetools`-Manifest + `registry.howispulse.com`-Mirror). Kaltbau ~8 min. **NICHT auf einen einzelnen QEMU-Multi-Arch-Job zurückbauen** (das war der ~90-min-Zustand). Analyse: `docs/plans/2026-07-15-ci-build-time-analyse.md`.
- **CI-Workflows sind nur auf `main` real testbar** (kein PR-Check; triggern auf `main`-Push/Tag) — erster Lauf nach Merge beobachten. Gilt für `win`/`mac`/`flatpak`/`allinone`.
- CI-only-Änderungen (`.github/**`) sind NON_USER_FACING → kein `changelog.json`-Eintrag.

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

**Docker-Setup (Dev-Machine):** Docker ist installiert, Claude hat **root** (`sudo systemctl start docker`). Falls der Daemon down ist (Symptom: `failed to connect to the docker API at unix:///var/run/docker.sock` / `no such file or directory`), **selbst starten**, nicht den User fragen — `sudo systemctl start docker`, dann `docker compose up -d redis postgres` (pytest-Infra) bzw. `scripts/dev-up.fish` (voller Stack).

Am einfachsten **`scripts/dev-up.fish`** (ganzer Dev-Stack: Infra + 5 uvicorns `--reload` + Vite + Electron-Dev; Gegenstück `dev-down.fish`; Stolpersteine in Memory `pulse-local-dev-setup`). Manueller Einzelstart — gemeinsam `REDIS_URL=redis://localhost:6380/0`, `AUTH_JWKS_URL=http://127.0.0.1:8001/.well-known/jwks.json`:
- **auth / chat-gateway**: `POSTGRES_PASSWORD`, `JWT_PRIVATE_KEY_FILE`+`JWT_PUBLIC_KEY_FILE` (absolut); chat-gateway zusätzlich `MEDIA_SVC_URL=http://127.0.0.1:8004`. `DELETE /me` braucht `INTERNAL_SERVICE_SECRET` (identisch auth+chat) + `CHAT_GATEWAY_URL`.
- **voice-signaling**: LiveKit-Keys = `livekit.yaml`/`.env` (`LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=devsecret…`, `LIVEKIT_URL=ws://localhost:7880`).
- **media-svc**: `MEDIAMTX_API_URL=http://localhost:9997/v3/paths/list`. MediaMTX down → nur `mediamtx_poll_failed`-Log.

Einzel-Infra: MediaMTX `docker compose -f streaming/server/docker-compose.yml up -d`, LiveKit `docker compose --profile voice up -d`.

## Tests

- Backend: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q`. Pro-Service unter `services/*/tests/` (MediaMTX/LiveKit gemockt; Redis-Index `/1`).
- **Flake-Retry (Übergangslösung)**: CI-pytest `--reruns 2 --only-rerun "AssertionError" --only-rerun "RuntimeError"`. Root-Cause = Cache-Mutation-Races (Fix: `SELECT FOR UPDATE`-Pattern aus `state_store.py`).
- Frontend (web): `cd web && pnpm check && pnpm build` (0/0) + `pnpm exec playwright test`. Kein Vitest/Unit im Web (Desktop hat Node-Unit-Tests unter `desktop/test/`).
- E2E-DB = `dcc_test` (separat, `_globalSetup.ts` migriert + truncated nur sie; Dev-DB `dcc` nie angefasst). Test-Redis `/1`. Playwright lokal braucht `PULSE_INSTANCE_MODE=cloud` (Memory `e2e-pulse-instance-mode-cloud`).
- **Manuell, nicht automatisiert**: echter GSR-`start` (Portal + realer Push), Electron-GUI-Sichttest, HQ-Stream-E2E (2 Clients).
- **Vor jedem Commit**: pytest + `pnpm check` + `pnpm build` + Playwright.

## Konventionen

- **Kein `git push` / keine GitHub-CLI** ohne explizite Freigabe. Remote: `origin` → `github.com/oblivion8282-1337/pulse.git`.
- **Branch-Workflow (mehrere Rechner parallel — Mac + Linux am selben Repo):** Jede Code-Änderung auf einem **Feature-Branch** (`feat/<name>` / `fix/<name>` / `docs/<name>`), **immer von frisch gepulltem `main`** — **nie direkt auf `main`** committen/pushen. **Landen ausschließlich über GitHub-PR** (nie lokal `git merge` + manuell löschen — wenn `main` zwischenzeitlich gewandert ist, fällt der ff-Merge um und ein ungeschützter Cleanup verwaist den Branch): `gh pr create --base main --head <branch> --fill`, dann `gh pr merge <branch> --rebase --delete-branch --auto` — oder kurz **`bash scripts/ship.sh`**. Das rebased server-seitig auf `main` (Divergenz sauber), **wartet auf die Pflicht-Checks** (mergt nie was Rotes) und löscht den Branch **atomar erst nach** erfolgreichem Merge. Merge nach `main` (= **Prod-Deploy!**) nur auf **explizite Freigabe** des Users. (Nur im Notfall lokal, dann strikt guarded: `git fetch && git rebase origin/main && git checkout main && git merge --ff-only <branch> && git push && git branch -d <branch>` — Cleanup nie ohne `&&`-Kette.) Changelog-Konflikt bei parallelen Branches: `web/static/changelog.json`-Top-Eintrag auflösen (neueres Datum / `.N`-Suffix oben).
- **Branch-Aufräumen (gegen liegengebliebene Branches):** GitHub-Repo hat `delete_branch_on_merge=true` → der Head-Branch wird beim PR-Merge **server-seitig automatisch** gelöscht (gilt für alle Rechner), **lokal aber NICHT** — der bleibt stehen und muss weg. **Per-Maschine** einmalig setzen (Claude soll das beim ersten Mal auf einer neuen Maschine tun, falls nicht vorhanden): `git config --global fetch.prune true` + den Alias `git tidy`. Nach gemergtem PR `git tidy` laufen lassen.

  ```
  git config --global alias.tidy '!f() {
    git fetch --prune -q
    LC_ALL=C git branch -vv | awk "/: gone]/ {print (\$1==\"*\")?\$2:\$1}" | while read -r b; do
      if [ -n "$(git cherry main "$b" 2>/dev/null | grep "^+")" ]; then
        echo "BEHALTEN — $b hat Commits, die nicht in main sind"
      else
        git branch -D "$b"
      fi
    done
  }; f'
  ```

  Zwei Dinge daran sind nicht offensichtlich und dürfen beim Kürzen nicht wegfallen:
  - **`LC_ALL=C`** ist Pflicht. Ohne das schreibt git auf einer deutschen Maschine `: entfernt]` statt `: gone]`, das Muster greift nie, und der Alias räumt still gar nichts auf. Dieselbe Falle beim Suchen von Hand: `git branch -vv | grep 'gone]'` liefert dort ein falsches „nichts verwaist".
  - **Die `git cherry`-Prüfung** schützt vor Datenverlust. Der Alias löscht mit `-D`, also mit Gewalt — ohne die Prüfung wäre ein Branch mit nirgends gesicherten Commits wortlos weg, sobald jemand seinen Remote-Branch löscht. `git cherry` vergleicht die Änderungen statt der Prüfsummen und ist damit das einzig taugliche Werkzeug bei **Rebase**-Merges: nach einem Rebase haben dieselben Änderungen andere Prüfsummen, `git branch --merged` und `git branch -d` halten den Branch deshalb fälschlich für ungemergt.
- **git-Identität pro Maschine prüfen (gegen CLA-Block):** PRs durchlaufen den `CLAAssistant`-Check; der ordnet Commits über die Autor-**E-Mail** dem GitHub-Konto zu (Allowlist `oblivion8282-1337,*[bot]`). Ist `git config user.email` leer oder eine erfundene `user@hostname`-Adresse (z.B. `*.local`, `*.fritz.box`), kann GitHub den Commit dem Konto **nicht** zuordnen → der Bot blockt **jeden** PR. **Beim ersten Mal auf einer neuen Maschine** prüfen (Claude soll das tun): `git config user.email` muss die GitHub-**Noreply**-Adresse sein — `249562202+oblivion8282-1337@users.noreply.github.com`. Falls nicht: `git config --global user.email '249562202+oblivion8282-1337@users.noreply.github.com'` + `git config --global user.name 'Michael de Meyer'`. (Bereits gepushte Commits mit falscher Mail: `git commit --amend --reset-author` + force-push, dann `recheck` als PR-Kommentar.)
- **Memory-Hygiene:** Die `~/.claude/...`-Memory ist **per-Maschine, nicht zwischen Rechnern geteilt** und veraltet leicht → dort **keine transienten Git-Stati** ablegen (Branch-Namen, „unpushed", „N Commits offen" — das ist git's Job). Geteilte/dauerhafte Konventionen gehören hierher in `CLAUDE.md`. Landet ein Feature auf `main`, gehört das Aktualisieren/Löschen zugehöriger Memory zum Merge-Schritt.
- **Code-Simplifier vor jedem Commit (Regel + erzwingender Hook):** Nach jeder abgeschlossenen Code-Änderung, **vor dem Commit**, den `code-simplifier`-Agent über die geänderten Dateien laufen lassen (vereinfacht ohne Verhaltensänderung). Danach die relevanten **Tests/Checks erneut grün ziehen** (pytest / `pnpm check` + build / ggf. Playwright) — **das** ist die Kontrolle, ob die Vereinfachung etwas gebrochen hat (kein zweiter Review-Agent nötig, Tests sind die Wahrheit). Dann `bash .claude/hooks/simplify-stamp.sh` und committen. **Zweifach erzwungen** (beide in `.claude/settings.json`): (1) PreToolUse-Hook `.claude/hooks/require-simplifier.sh` blockt `git commit`, solange **gestageter** App-Code nicht simplifiziert + gestempelt ist; (2) Stop-Hook `.claude/hooks/stop-require-simplifier.sh` blockt das **Turn-Ende**, solange App-Code seit dem letzten Commit geändert/neu ist und nicht simplifiziert + gestempelt — so läuft der Simplifier am Ende JEDER Änderung, nicht erst vor dem Commit. Beide teilen die Filter-/Ausnahmeliste (Tests, Migrationen, `components/ui/`, reine Docs/Config/Changelog). `simplify-stamp.sh` schreibt **zwei** Stempel in `.git/` (nie getrackt, pro Klon lokal): `.simplify-stamp` (Index-Tree → Commit-Gate) + `.simplify-stamp-stop` (Inhalts-Hash der geänderten Dateien via `simplify-changed-hash.sh` → Stop-Gate). Schleifenfrei über den Hash-Abgleich; fail-open bei Infra-Fehlern. Betrifft nur Claude-Turns/-Commits über das Tool, nicht manuelle Commits. (Stop-Hooks werden erst nach einem Turn aktiv — greift der Gate auf einer frischen Maschine nicht sofort, einmal `/hooks` öffnen oder Session neu starten.)
- **Refactoring darf das Verhalten nicht ändern** — Endpoint-Pfade, Response-Models, `data-testid` bleiben identisch. Bricht ein Test nach Refactor → der Code ist kaputt, nicht der Test.
- **Code-Größen-Policy** (`PLAN.md` §12.1): Source ≤ 350 Z. (hart 500), Svelte-Components ≤ 250. Ausgenommen: Tests, Migrationen, `lib/components/ui/`. Im Zweifel splitten.
- **Lies zuerst, ändere danach. Keine neuen Dependencies ohne Rückfrage. Tests proaktiv laufen lassen.**
- **Niemals Stream-Keys/Tokens loggen.** `~/Dokumente/GPU_Screen_Recorder/` ist READ-ONLY — nur vendored `streaming/`-Kopie modifizieren.

## Changelog — „Was ist neu?"-Toast nach dem Update-Reload

User-facing Changelog, der **einmalig nach einem Deploy-Reload** als **nicht-blockierender Toast unten rechts** erscheint (sobald der User **eingeloggt** ist; wegklickbar, dann bis zum nächsten Update weg) — **kein modaler Dialog** mehr (2026-06-08), damit man nebenher weiterarbeiten kann (z.B. in einen Voice-Channel joinen). Quelle: **`web/static/changelog.json`** (neuester Eintrag zuerst; Felder `id`/`date`/`style`/`title`/`intro?`/`items[]`/`outro?`). Mechanik: `ChangelogGate.svelte` (im `+layout.svelte`) lädt `/changelog.json`, vergleicht `entries[0].id` mit `localStorage['pulse.changelog.lastSeen']` und feuert via `toast.custom(ChangelogToast, …)` (sonner, `duration: Infinity`), **sobald `auth.user` gesetzt ist** (nie auf dem Login-Screen); beim Anzeigen wird `lastSeen` hochgesetzt → genau EINMAL pro Update. `ChangelogToast.svelte` rendert den **vollen** Inhalt (Titel + alle Punkte, Plain-Text, kein Markdown — Content ist repo-eigen). nginx serviert `/changelog.json` **no-cache** (`web-nginx.conf`, analog `version.json`).

**Pflicht-Workflow vor JEDEM Push auf main** (sonst blockt das CI-Gate `scripts/check-changelog.sh` → Job `changelog` in `ci.yml` → `images` hängt davon ab):
1. Aus den zu pushenden Commits einen **user-verständlichen** Eintrag ableiten (kein Tech-Jargon — „Play/Pause kommt zuverlässig an", nicht „pubsub-Listener int64-Hardening").
2. **Stil NICHT selbst wählen** — dem User **mehrere Stil-Vorschläge** machen, er entscheidet (zuletzt durchgehend „Sachlich"). **KEINE Emojis — nirgends** (nicht im Titel, Intro, Items oder Outro; gilt auch für Assistenten-Antworten). User-Wunsch 2026-06-08, harte Regel.
3. Neuen Eintrag oben in `entries` einfügen, `id` eindeutig (Datum; mehrere/Tag → `2026-06-05.2`).
4. Nur **user-facing** Code verlangt einen Eintrag. Nicht-user-facing Pfade sind ausgenommen (Liste `NON_USER_FACING` in `check-changelog.sh`): `*.md`, `docs/`, `.github/`, `infra/`, `packaging/`, `scripts/`, `Dockerfile*`, `*.toml`, `*/tests/`, `conftest.py`, die `changelog.json` selbst.

## Anti-Patterns (voll in `PLAN.md` §12)

- ❌ Shared DB-Tabellen zwischen Services · ❌ HS256 JWT (nur RS256)
- ❌ `fastapi-users` / `broadcaster` / `fastapi-socketio` / `fastapi_websocket_pubsub` (archiviert → Eigenbau)
- ❌ State-Library (Redux/Zustand/Pinia) neben Svelte-Runes · ❌ CSS-in-JS (Tailwind reicht)
- ❌ **Tauri** als Desktop-Wrapper (WebKitGTK-WebRTC unzuverlässig → 2026-05-12 auf Electron, `PLAN.md` §17) · ❌ `electron-store` (ESM-only) · ❌ React-Bridge für LiveKit-Components
- ❌ `@livekit/krisp-noise-filter` (kostenpflichtig) · ❌ `deepfilternet3-noise-filter` (kratzig + Worklet-Underrun) · ❌ `svelte-french-toast` (Sv5-inaktiv) · ❌ `svelte-markdown` blind (kein Sanitizer)
- ❌ Exactly-once-Delivery · ❌ Re-Publishing MediaMTX→LiveKit (Transcoding zu teuer)
- ❌ Routes-/Service-Dateien über die Größen-Grenze wachsen lassen statt splitten

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
