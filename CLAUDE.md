# Claude-Notizen für dieses Projekt

Projekt: **Pulse — Web-First Discord-artiger Chat + Voice + HQ-Screen-Streaming**.
Monorepo: uv-Workspace (Backend) + pnpm-Workspace (`web`, `desktop`).
Vollständige Architektur + History: `PLAN.md`, `infra/prod/DEPLOY.md`, `streaming/README.md`, `git log`.
**Hier nur nicht-offensichtliche Dinge** — Mechanik-Details stehen in den verlinkten Docs.

## Was das Projekt macht

Chat/Voice-Client, **Web-First** (alle Browser), PWA-installierbar, Desktop via **Electron** (`desktop/`), Mobile (Android) via Capacitor/TWA (`packaging/android/`).
Backend = mehrere kleine FastAPI-Services: `services/{auth,chat-gateway,voice-signaling,media-svc,mediamtx-auth-hook,relay-frps-plugin}`.
Voice über LiveKit (WebRTC/Opus). HQ-Screen-Streaming über vendored GPU Screen Recorder (`streaming/`) als Sidecar, pusht an MediaMTX → Viewer per WHEP.
Drei Transportpfade getrennt: HTTPS/WSS → FastAPI · WebRTC → LiveKit · WHEP → MediaMTX (Details `PLAN.md` §1).
`~/Dokumente/GPU_Screen_Recorder/` ist **READ-ONLY**. `streaming/` enthält Pulse-eigene Sidecars + Patches (`streaming/patches/`); GSR wird zur Build-Zeit vom Upstream geklont.

## Lizenz — source-available, zwei Bereiche

Pulse ist **nicht Open Source**. Verbindlich ist `LICENSE` im Root.
- **Server** (`services/`, `shared/`, `infra/`) = **Pulse Server License 1.0** — Quelle einsehbar, 32 Tage Evaluierung, danach kommerzielle Lizenz (Hebel für bezahltes Self-Hosting).
- **Client** (`web/`, `desktop/`, `mobile/`, `streaming/`, `plugins/`, `packaging/`, `Logo/`, `scripts/`) = **Pulse Client License 1.0** — **Nutzung frei**, Quelle einsehbar, aber Ändern/Weitergabe/Wiederverwendung untersagt. Eigene Texte statt PolyForm (PolyForm erlaubt ausdrücklich „Changes/New Works" — genau das soll hier verboten sein). **Anwaltlich nicht geprüft** — bei echtem Umsatz nachholen.
- **`streaming/patches/` bleibt GPL-3.0** (von GSR abgeleitet, gehört uns nicht).
- Bei neuen Lizenz-Aussagen **alle** Stellen synchron halten: `LICENSE*`, Verzeichnis-`LICENSE`s, `README.md`, `CLA.md`, beide `packaging/*.metainfo.xml`, OCI-Label in `allinone.yml`, `web/src/lib/legal/impressum.md`.
- **Keine AGPL/GPL-Dependencies aufnehmen** (kollidiert hart, z. B. die Cap-Encoder-Crates in `WINDOWS_HQ_SIDECAR.md`). FFmpeg überall LGPL und **dynamisch** gelinkt — so lassen.

## Tech-Stack — die Stolpersteine

Versionen in `uv.lock` / `pnpm-lock.yaml`. Runtimes: **Python** 3.13 (`>=3.13,<3.15`) · **uv** · **Node** ≥20 (CI `ci.yml`+`flatpak.yml` auf **25**, App-Builds `win`/`mac`/`android` auf **22** — beide Gruppen prüfen) · **pnpm** 10. Ruff `line-length=100`, `target-version=py313`, `ignore=["E501"]`.

**Backend** (`services/*` + `shared/`) — FastAPI + uvicorn, SQLAlchemy[asyncio] (**eigenes Schema pro Service**: `auth`/`chat`), asyncpg (Prod) / aiosqlite (Tests), Alembic (pro Service `alembic/versions/`), pydantic v2.
- **pyjwt[crypto]**: RS256; `PyJWKClient.from_jwks` fehlt in der Version → Eigenbau via `RSAAlgorithm.from_jwk` in `security.py`.
- **argon2-cffi**: Argon2id (t=3/m=64MiB/p=4). **slowapi**-Rate-Limit in auth-svc ist **in-process**.
- **redis** async: ConnectionManager nutzt `psubscribe` + `get_message()`-Poll (kein `listen()`-Race).
- **email-validator** blockt special-use-TLDs → Tests nutzen `dcc-test.example.com`, nicht `*.test`.
- **py_webauthn** (Passkeys) + `pyotp`/`qrcode[pil]` (TOTP) — kein Eigenbau.
- **pytest** + pytest-asyncio: `--import-mode=importlib`, `asyncio_mode=auto`.

**Frontend** (`web/`, SvelteKit-SPA `ssr=false` `adapter-static`) — Svelte 5 Runes, Tailwind 4 (shadcn-Tokens im `.dark{}`), shadcn-svelte/bits-ui (`web/src/lib/components/ui/`, Vendor — Größen-Policy ausgenommen).
- Build → `web/build/` → `pulse_web`-nginx-Image. **Electron lädt die *deployte* Web-App remote**, nicht `web/build/`.
- Vite-Dev-Proxy: `/api/auth`→:8001 · `/api/chat`+`/api/ws`→:8002 · `/api/voice`→:8003.
- **livekit-client**: `lib/voice/livekit.svelte.ts` abonniert rohe `Room`/`Participant`-Events (kein `@livekit/components-core`-Wrapper, obwohl installiert).
- **@sapphi-red/web-noise-suppressor**: RNNoise→NoiseGate (`lib/voice/noiseFilter.ts`). **`MediaStreamDestinationNode.channelCount = 1` zwingend** (Default Stereo + `explicit` → mono-Worklet füllt nur output[0], rechter Kanal stumm).
- **mode-watcher** via `setMode()` (`settings.svelte.ts`), persistiert `dcc.settings`; FOUC-Inline-Script in `app.html`.
- **@svelte-put/shortcut**: In-Window-PTT (Taste aus `settings.voice.pttKey`).
- Tests: `@playwright/test` E2E + `svelte-check` (`pnpm check`). Kein Vitest im Web (Desktop hat Node-Unit-Tests `desktop/test/`).

**Desktop** (`desktop/`, Electron `@dcc/desktop`):
- electron **43.0.0** gepinnt (Chromium 150 + Opus-DTX-Fix webrtc #42233214; ohne knackst der Wiedereinstieg nach Stille → Untergrenze). **DTX fest an** (`dtx:true` in `#audioPublishDefaults`, `livekit.svelte.ts`). Bundlet Node 24.x. **Kein `postinstall`** — Binary lazy beim ersten `require('electron')`.
- esbuild → `electron/dist/*.cjs`. `desktop/package.json` ist CJS (ohne `"type":"module"`), `"main":"electron/dist/main.cjs"`.
- Scripts: `dev` (gegen Vite) · `prod` (lädt howispulse.com) · `start` (ohne Rebuild). DevTools nur `PULSE_DEVTOOLS=1`/Strg+Shift+I. Build-Check ohne GUI: `cd desktop && pnpm run build:electron`.
- Voice im Electron-Fenster via Chromium-WebRTC (Grund für den Tauri→Electron-Pivot).
- **Windows-Release braucht IMMER einen Version-Bump**: über den Installer ausgelieferte Änderungen (`streaming/win-hq-sidecar/**`, **`streaming/pulse-player/**` — wird seit 2026-08-05 mitgeliefert**, `desktop/electron/**`, `desktop/package.json`-Deps) erreichen Bestandsclients nur, wenn `version` gebumpt wird — electron-updater ignoriert gleiche Version stillschweigend. Linux (Flatpak) hat das Problem nicht.
- **Windows-Auto-Update** = NSIS + electron-updater (pollt `updates/win/latest.yml`, SHA512, unsigniert, **Hintergrund-Updater, kein Boot-Splash**). Voll-Doku `docs/plans/2026-05-31-windows-auto-update.md`. Wichtigste Gotchas: `allowDowngrade=false` (Fake-High-Version-Build beim Testen danach deinstallieren); `quit`-Hook (nicht `before-quit`) → kompatibel mit Sidecar-Shutdown; lokaler E2E ohne Image-Push via `PULSE_DEV_UPDATE=1` + `desktop/dev-app-update.yml` + `desktop/scripts/local-update-feed.mjs`.
- **Globaler Hold-to-Talk fehlt** (Electron `globalShortcut` kann nur Press); In-Window-PTT via `lib/shortcuts/` + `desktop/electron/shortcuts.ts`. Notifications-IPC: `desktop/electron/notify.ts::wireNotify()` → `window.pulse.notify.*`.

**Infra (Dev):** `docker-compose.yml` — Postgres `postgres:16-alpine`, Redis `redis:7-alpine`, LiveKit (`--profile voice`, **`network_mode: host`**). MediaMTX separat `streaming/server/docker-compose.yml` (`network_mode: host`).

## Architektur — die nicht-offensichtlichen Stücke

**Snowflake-IDs als Strings** über die API (REST, WS, Responses) — JS `Number` kann 64-bit nicht exakt. Backend `SnowflakeId`-`BeforeValidator` (int *oder* string); Frontend sendet immer string. Format `[42-bit ms ab 2026-01-01][10-bit worker][12-bit seq]`, auth=1/chat=2. **voice-signaling vergibt keine IDs** (konsumiert nur fremde Snowflakes).

**Services kommunizieren nur über Redis Pub/Sub oder HTTP** — niemals shared DB-Tabellen. chat-gateway-Routes = APIRouter-Module unter `services/chat-gateway/src/dcc_chat_gateway/routes/`.

**WS-Auth**: Access-Token als Query-Param (`/ws?token=…`) — Browser-WebSocket kann keine Custom-Header. Expired/ungültig → close 4001.

**LiveKit/MediaMTX `network_mode: host`**: Host-UFW (`INPUT DROP`) blockt Container→Host über die Bridge; nur host-Networking erreichen LiveKit `127.0.0.1:8003` (Webhooks), MediaMTX den auth-hook (`:8005`), media-svc die MediaMTX-API (`:9997`).

**Bootstrap-Admin**: `POST /register` setzt `is_admin=true`, wenn der neue User der einzige in `auth.users` ist (`COUNT(*) == 1` nach flush). Race bei Parallel-Registrierung akzeptiert.

**2FA — TOTP + WebAuthn/Passkeys** (auth-svc; `routes_totp.py`/`routes_webauthn*.py`/`passkeys.py`):
- **Challenge-State = signiertes JWT** („challenge ticket"), kein State-Table/Redis — wie `mfa_ticket`, `purpose`-Claim trennt reg/auth. Funktioniert deshalb im SQLite-Test.
- `POST /login` MFA-gated bei `totp_enabled` **oder** ≥1 Passkey → `LoginMfaPending{mfa_ticket, methods[]}`. **Passwortloser Passkey-Login** discoverable, `userVerification=required` → echte MFA, umgeht TOTP. Mit ticket = 2FA-Zweitfaktor.
- **rpId/Origin** (`WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGIN`): rpId = Domain-Suffix der Origin. **Dev: `localhost`, NICHT `127.0.0.1`** (IP kann keine rpId) → E2E-Origin `127.0.0.1:5173` mockt `/webauthn/*` (Krypto-Pfad deckt `test_webauthn.py`).
- **Backup-Codes sind MFA-weit** (nicht TOTP-spezifisch; erster Passkey ohne sonstiges MFA erzeugt 10).

**`allow_guild_creation` default = FALSE** (Migration 0010): Fresh-Deploys locked-down — nur Bootstrap-Admin legt Server an, öffnet via `/admin/permissions`. `allow_member_invites` bleibt `true`. conftest seedet die Singleton mit `true`.

**Permissions** (Voll-Discord) — Bits + Resolver in `dcc_shared/permissions.py` / `permission_resolver.py` (pure-Python via `PermissionContext`-Protocol); Frontend spiegelt in `lib/permissions/bitfield.ts` mit BigInt (**synchron halten**). 3 Tabellen (`roles`/`member_roles`/`permission_overwrites`).
- Formel `final = (base | allow) & ~deny`; **!VIEW_CHANNEL → revoke_all-Invariante** (Exploit-Schutz). Reihenfolge @everyone → role-overwrites (position) → user-overwrite.
- `GRANT_ALL_SAFE = (1<<52)-1` — Owner/ADMIN resolven dahin, **NICHT `~0`** (reserved bits = Null, JS-Number-safe).
- `assert_overwrite_within_editor_scope()` — Anti-Escalation: Editor muss jedes Bit selbst halten, das er grantet/un-deny't.
- POST /guilds **auto-seedet** `@everyone`.
- `ConnectionManager._filter_by_view_channel` gatet `chat:channel:*`/`voice:events`/`stream:events`/`watch:events`; **DM-Channels ungefiltert**. Per-Socket `_ws_perms`-Cache.
- **Server-Delete + Owner-Transfer bleiben Owner-only** (ADMIN bypasst Delete, NICHT Transfer). MANAGE_GUILD = nur rename/icon/settings.

**Voice-Presence**: LiveKit-Webhooks → voice-signaling `POST /webhook` (Sig via `WebhookReceiver`, Key `webhook:`-Block in `livekit.yaml`) → pflegt Redis-Sets `voice:room:channel-<id>` → published `voice:events`. chat-gateway broadcastet `voice_state`; Re-Sync über `ready`-Frame.
- **Reconcile-Loop** (`voice-signaling/reconcile.py`): Webhook-Pfad driftet (verlorene Webhooks bei Deploy + NX-TTL-Trap in dauerbesetzten Channels). Background-Task pollt LiveKit alle `voice_reconcile_interval_seconds` (default 30) und **überschreibt** die Sets via `_set_exact` (non-NX TTL) — ist die Autorität. `voice_reconcile_enabled=false` → Webhook-only.
- **`LIVEKIT_API_URL`** (prod `.env` `=http://host.docker.internal:7880`): server-seitige Calls gehen sonst über die öffentliche `LIVEKIT_URL` → crasht 502 während eines Deploys. Braucht `extra_hosts: host.docker.internal:host-gateway`. Unset → Fallback `LIVEKIT_URL` (dev ok). Browser kriegen weiter `LIVEKIT_URL`.

**HQ-Streaming** (per-User-Pfade, mehrere pro Channel möglich). Voller Datenfluss + Redis-Keys + Routen → `streaming/README.md`.
- **media-svc** (8004) vergibt Stream-Tokens (chat-gateway reicht nach Membership-Check weiter) + pollt MediaMTX (3s) Self-Heal. **mediamtx-auth-hook** (8005) = MediaMTX `authMethod: http`, nur Redis: Publish prüft `scope:publish`-Token gegen Pfad, Read prüft `scope:read`-Token (channel+user-gebunden, **nicht** konsumiert — Multi-Use; `read_token_required=false` abschaltbar). media-svc mintet das Read-Token in `GET /whep` und hängt es als `?token=` an die WHEP-URL.
- **Nonce gegen Republish-ICE-Race**: jeder Token-Issue → frische 32-Hex-Nonce → Pfad `channel-<cid>-<uid>[-s<slot>]-<nonce>` (Slot = gleichzeitige Streams desselben Users; Slot 0 = Legacy-Pfad ohne `-s0`). `stream:active:*` hält den Live-Pfad **ohne** Nonce für WHEP-Lookup.
- **Redis-Key-Namen dupliziert** in `dcc_media_svc/streamkeys.py` + `dcc_mediamtx_auth_hook/shared.py` (**synchron halten**) — der auth-hook hat bewusst keine `dcc-shared`-Abhängigkeit. **Ausnahme seit 2026-08-13:** `stream:token:*` und `stream:read-cache:*` stehen kanonisch in `dcc_shared/streaming.py` (`TOKEN_KEY`/`token_key`, `READ_CACHE_KEY`/`read_cache_key`/`read_cache_channel`), weil chat-gateway sie beim Bann löschen muss (`stream_revoke.py`); `streamkeys.py` reicht `TOKEN_KEY` nur durch, die Kopie im auth-hook bleibt.
- chat-gateway braucht `MEDIA_SVC_URL`; fehlt media-svc → **502 nur** auf Stream-Routen.
- **Push-Weg entscheidet der Client** (`web/src/lib/stream/settings.svelte.ts::pushProtokoll` → `protocol` im Stream-Token-Request; media-svc erzwingt, der Wunsch hebt nur **nach oben** Richtung WHIP). **WHIP** (`https://<host>/whep/<pfad>/whip?token=…`) bei Intra-Refresh **und bei JEDEM H.264-Stream** — nur WHIP hat den RTCP-Rückkanal, und `h264_amf` fährt Intra-Refresh wegen `usage=ultralowlatency` ungefragt mit (über RTMPS sähe ein Zuschauer gar nichts). **RTMPS** (`rtmps://<host>:1936`, self-signed, UFW `1936/tcp`, `rtmpEncryption: strict`; plain :1935 entfernt) nur noch für AV1 ohne Intra-Refresh. FlexFEC-Parität nur über WHIP.
- Frontend: WHEP-Client `web/src/lib/stream/whep.ts`. Gating: `isElectron() && (isLinux()||isWindows()||isMac()) && stream.gsrAvailable`.

**Watch-Party Host-sticky**: Host **behält** die Party bis explizit `watch_handoff`, **kein Auto-Handoff**. Channel-Wechsel/Unmount (`watch_leave`) beendet sofort; WS-Disconnect startet `WATCH_HOST_GRACE_S` (default 30, E2E=1) Schonfrist. Watcher-Menge **in-process** im ConnectionManager (`watch_registry`, Socket-Refcount → Multi-Tab-korrekt, kein Redis). Client-Sync `web/src/lib/watch/partyController.svelte.ts`. **WS-Tests lokal brauchen `PULSE_INSTANCE_MODE=cloud`** (sonst self-host-Guard-Crash im Lifespan).

**Fernsteuerung (im Bau, Serverweg)** — Bild + Eingabe sind **getrennte Wege**: das Bild läuft unverändert über HQ-Streaming in den `pulse-player`, neu ist nur der **Rückweg für Eingaben**. Spezifikation `docs/plans/2026-08-12-input-wire-protokoll-v2.md` (selbsttragend, ersetzt v1 auf `feat/remote-control-windows`).
- **Kein P2P.** Die Zahl, mit der der Serverweg 2026-07 verworfen wurde („300 ms+"), war nie gemessen; nachgemessen 55–85 ms. Eingaben gehen über das WS-Op `remote_input` (`{session_id, slot, frames:[base64]}`). **`remote_signal` bleibt trotzdem stehen** — billige Rückfahrkarte; das *teure* P2P-Stück (Sidecar-Abgriff, TURN, coturn, `pulse-remote-webrtc`) liegt weiter auf `feat/remote-control-windows`.
- **Der Gateway parst Frames NICHT** (prüft nur Sitzung/Rolle/Größe: ≤32 Frames, ≤1024 dekodierte Byte). Ablehnung verwirft nur *diese* Nachricht — eine Grenzüberschreitung kostet eine Mausbewegung, nicht die Sitzung.
- **`slot` sitzt in der Hülle, nicht im Frame** → Frame-Format bleibt zwischen Serverweg und P2P wortgleich. Unbekannter Slot = still verwerfen (Rennen beim Stream-Ende, kein Angriff) — die **einzige** Ausnahme von fail-closed.
- **Koordinaten sind Anteile (0..65535), keine Pixel.** Über vier 4K-Monitore noch 4,3 Stufen/Pixel. Pixel verlangten, dass beide Seiten die Host-Geometrie kennen und einig sind.
- **`REMOTE_CONTROL` = Bit 37, NICHT in `DEFAULT_EVERYONE_PERMISSIONS`** — wirkt damit als Gate: ohne Admin-Zuteilung sieht kein Nutzer etwas. Deshalb (noch) kein Changelog-Eintrag.
- **Vorrang des Hosts** (2026-08-14): regt sich der Host körperlich an Maus/Tastatur, verwirft sein Sidecar die Fremdeingabe für 5 s (gleitend, `PULSE_FERN_VORRANG_MS`, geklemmt 100 ms–60 s) — Stummschalten über den bestehenden Verwerf-Pfad (`state: "host_active"`, samt Freigabe + Zeigerlage entwerten), **kein** Sitzungsabbruch. Erkennung = systemweiter LL-Hook (`remote_input/wache.rs`), **nicht** Zeigervergleich (`SendInput` wirkt verzögert, und ein Klick bewegt den Zeiger nicht). **Die eigene Injektion trägt `PULSE_MARKE` in `dwExtraInfo`** — ohne die Marke sperrt sich die Fernsteuerung mit ihrer ersten Mausbewegung selbst aus; **fremde** Injektion gilt bewusst als Host (`LLMHF_INJECTED` ungenutzt: Fehlalarm kostet 5 s, verpasster Alarm die Zusage). Hook nicht anmeldbar → **Handschlag verweigert die Sitzung** (Linie wie Intra-Refresh/HDR). Hook-Rückruf und Übergangs-Wecker liegen auf **getrennten Fäden** (ein beschäftigter Hook-Faden wird von Windows stillschweigend abgehängt). Meldung an den Steuernden über `remote_signal` `kind:"vorrang"` (Gateway-Whitelist `_SIGNAL_KINDS` ↔ `RemoteSignalKind` synchron halten); der zieht beim Ende alles noch Gehaltene als Drück-Ereignisse nach (`web/src/lib/remote/{vorrang,buchfuehrung}.ts`) — **ohne Hello** (das gäbe frei, was gerade hergestellt wird), und eine **Zeigerlage geht immer voran** (der Host entwertet sie beim Übernehmen; ohne sie schluckt das Orts-Tor Knopf *und* Rad). Derselbe Baustein hängt am Rückfall Kanal→Serverweg, wo das Hello ebenfalls alles freigibt.
  - **Drei Dinge, die beim Fünf-Jäger-Bughunt 2026-08-14 gefunden wurden und leicht wieder hineinfallen:** (1) **Der Vorrang gilt maschinenweit, nicht je Platz** — die Wache sitzt je Sidecar-PROZESS und stellt sich erst beim ersten Hello auf, ein Steuernder konnte also auf einen ungewachten Platz ausweichen; der Renderer des Hosts führt alle Plätze zusammen und hängt `host_active` an jede `remote_input`-Nachricht (weiterreichen statt verwerfen, sonst verschwände ein Hello und die Sitzung stürbe fail-closed). (2) **Der Hook muss die eigene Injektion in die Vergleichslage eintragen, ohne sie zu zählen** — `MSLLHOOKSTRUCT.pt` ist absolut, sonst misst die Bewegungsschwelle den Abstand zwischen den Zeigern beider Seiten und jeder Tischstoß löst aus. (3) **Der Sidecar wiederholt einen geltenden Vorrang je Sekunde** — der Gateway-Deckel verwirft still, und ein verlorenes „beginnt" macht das spätere „endet" beim Steuernden wirkungslos; die Wiederholung gehört in den Sidecar, weil Chromium Zeitgeber in verdeckten Fenstern auf 1/min drosselt.
- **Prüfen ohne zweiten Rechner**: `streaming/win-hq-labor/testbench/fern-eingabe-nachweis.ps1` fährt echte Frames durch den echten Sidecar (`PULSE_LABOR_EINGABE_OHNE_STREAM=1`), aufgefangen vom Vollbild-**Prüfziel** `eingabe-pruefziel.ps1`. Belegt 2026-08-12: 0 px auf 8 Zielen, Scancodes identisch. **Ein Windows-Systemdialog (`Shell_SystemDim`/`PickerHost`) legt sich über ALLES und schluckt jede Injektion** — der Treiber prüft deshalb *positiv*, ob das Prüfziel obenauf liegt, und bricht sonst als ungültig ab. Ohne diese Wache sieht ein Lauf wie „Injektor tot" aus.
- **Fern-Modus senkt Latenzposten selbsttätig** (2026-08-13, alle mit Merk-und-Zurück): Player — Vorhalt 30→5, Jitter-Geduld RTT-gekoppelt `max(40, RTT+30)` (**nie unter die NACK-Umlaufzeit** — blindes Absenken machte jeden Verlust zur Lücke; ein set_option — Lautstärkeregler sitzt im Fern-Menü! — darf die Absenkung nicht aufheben, `fern_geduld` in `session.rs`). **Swapchain-Tiefe bleibt bei 2**: mit 1 entartet Mailbox auf DX12 zu Fifo und `get_current_texture` blockiert den winit-Thread, der auch die Eingabe trägt (Bughunt 2026-08-13, Messgrundlage in `render/setup.rs`); Sidecar — Senden bei Ankunft statt Tick-Raster (**nur der D3D11-Zero-Copy-Weg** NVENC/AMF; D3D12- und CPU-Pipeline takten weiter starr — Cursor-Echo wirkt dort trotzdem. PTS-Platz-Bremse hält die Encoderate auf fps, ein Gehalten-Merker bricht dabei die „unverändert"-Annahme der Vorstufe — ohne ihn verschluckte der Stream das letzte Bild jeder Interaktion; A/B-Notausgang `PULSE_HQ_FERN_TICKRASTER=1`). **Cursor-Echo**: absolute Maus-Frames nehmen den Host-Cursor aus der WGC-Aufnahme (der lokale Zeiger des Steuernden ist dann der einzige — gefühlter Null-Lag), relative Frames und jedes Sitzungsende legen ihn zurück; andere Zuschauer sehen währenddessen keinen Zeiger. Dafür ist **windows-capture gepatcht** (`win-hq-sidecar/vendor/`, `scripts/bootstrap-windows-capture.sh`, gleiches Muster wie webrtc-rs — Gotcha: `git apply` überspringt gitignorierte Pfade wortlos, deshalb Wegwerf-Repo im Skript). **P2P-Eingabeweg Stufe 1 gebaut** (`web/src/lib/remote/p2p.ts`): DataChannel **zwischen den Renderern** (nur der Träger wechselt, Erfassung/Injektion unangetastet), Signaling über `remote_signal`, Serverweg als wortloser Rückfall; **Transportwechsel nur wenn nichts gedrückt ist** (sonst überholt ein WS-Drücken das freigebende Hello → klemmende Taste). Kein TURN in Stufe 1; Bild-P2P = Stufe 2, gehärtete Bausteine auf `feat/remote-control-windows` (`docs/plans/2026-08-13-fernsteuerung-p2p-eingabeweg.md`). **Statistik-Feld zeigt dem Steuernden den Eingabeweg** (Direktverbindung/Serverweg samt Grund + Frames/s): Zustandsmaschine und Texte leben in `p2p.ts`, der Player zeigt nur an (`remote_transport`-RPC über die generische `player:call`-Whitelist).
- **Zeigerform als Gegenrichtung zum Cursor-Echo** (2026-08-15): das Echo nimmt den Host-Zeiger aus dem Bild und damit auch dessen Formensprache (I-Balken, Größenpfeile, Hand, Wartekringel) — der Steuernde behielte sonst immer den Standardpfeil und rät, wo er greifen kann. Übertragen wird der **Name** aus der CSS-Zeigerliste, **nicht das Bild**: winit benennt seine Formen ebenso und setzt sie plattformeigen um (Linux steuert Windows sieht damit seinen eigenen I-Balken aus seinem Thema), es bleibt der lokale, verzögerungsfreie Zeiger, und es kostet ein paar Byte je Wechsel. Preis: App-eigene Zeiger (Spiele, Bildbearbeitung) fallen auf `default` — dafür bräuchte es die Pixel (`GetIconInfo`+`GetDIBits`, eigene Stufe). Weg: `remote_input/zeigerform.rs` (Poll am **Wecker der Wache**, kein eigener Faden; `GetCursorInfo`-Handle gegen `LoadCursorW(IDC_*)`, **nicht zwischengespeichert** — ein Zeigerschema-Wechsel macht gemerkte Handles ungültig) → `remote_signal` `kind:"zeiger"` → `web/src/lib/remote/zeigerform.ts` → `remote_pointer`-RPC → `pulse-player/src/app/eingabe.rs` (Namenstabelle daneben in `app/zeigerform.rs`). **Die Formenliste steht an drei Stellen** (Sidecar, Renderer, Player) und muss synchron bleiben; die beiden Rust-Enden hält je ein Test fest, der Renderer nur der Typ `Zeigerform` (kein Vitest im Web). Wie beim Vorrang wiederholt der Sidecar **je Sekunde** (Gateway-Deckel verwirft still), und der Renderer frischt trotz Wechselfilter auf — ohne das bliebe ein verlorener Wechsel für den Rest der Sitzung falsch. Bei Vorrang des Hosts wird `default` gemeldet. **`CURSOR_SHOWING` bleibt bewusst unausgewertet**: Windows blendet den Zeiger beim Tippen aus, das nachzuvollziehen nähme dem Steuernden ständig die Orientierung — den einen echten Fall (Spiel) deckt der Zeigerfang des Players ab.

**Standplatz-Geräte (Fernsteuerung ohne Aufsicht, seit 2026-08-16)** — ein Rechner, der in einem **Sprachkanal steht, ohne Teilnehmer zu sein**. Entwurf + Begründungen: `docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md`, Einrichtung und harte Grenzen: `docs/2026-08-16-standplatz-geraet-einrichten.md`.
- **Zwei Hälften, die zusammengehören:** die **Dauerfreigabe** (`web/src/lib/remote/standplatz.svelte.ts`) gibt den Rechner frei, die **Eintragung** (`chat.devices`, `routes/devices.py`) gibt ihm einen Ort. Beides im Reiter „Standplatz".
- **Die Freigabe liegt am GERÄT, nie auf dem Server** (`pulse-stream.json`): ein serverseitiger Schalter wäre von einem Admin fernaktivierbar — genau das soll die Zustimmung verhindern. Kein Protokoll-Eingriff: der Gateway sieht eine gewöhnliche Zustimmung, nur nach 20 ms.
- **Der Kanal ist der Rechteanker**, deshalb Pflichtfeld und deshalb ein Sprachkanal (dort läuft die Übertragung). Sehen folgt `VIEW_CHANNEL` — **zweifach geprüft**, in der Route UND im Ereignisweg (`pubsub_channel_guild.py`); nur in der Route wäre die Liste kosmetisch, DevTools sieht den rohen Rahmen.
- **Der Zustand (bereit/belegt/offline) kommt NICHT aus der Datenbank**, sondern aus lebenden Verbindungen: `_DeviceRegistryMixin` am ConnectionManager (`device_registry.py`), Muster wie `watch_registry`. Eine Spalte löge nach jedem Absturz, und zwar Richtung „bereit".
- **Das Gerät meldet sich selbst** (`device_announce`) — der Server sieht Nutzer, nicht Rechner; die Kennung liegt lokal (`web/src/lib/devices/anmeldung.svelte.ts`). Ein Erraten („erster Socket des Nutzers") machte den Laptop des Besitzers zum übernehmbaren Gerät.
- **Wecken ist getrennt von `remote_request`** (`device_wake`): sonst hinge eine Sitzungszusage an einer Encoder-Initialisierung, und deren Scheitern (kein Monitor, HDR-/Intra-Refresh-Verweigerung) hinterliesse eine aktive Sitzung ohne Bild. Verlangt `REMOTE_CONTROL` am Standplatz.
- **Beim Verbindungsabbau wird das Gerät VOR der Fernsteuerung vergessen** (`ws_ops.py`) — andernfalls meldet der Sitzungsabbau erst „wieder bereit" und Millisekunden später „offline", und dazwischen steht es als frei übernehmbar in der Liste.
- **Das Chat-Leck (§4) schliesst ein Sichtschutz am Schirm**, nicht der Server: der Verlauf kommt über REST, und eine REST-Anfrage trägt keine Verbindung — ein Server-Riegel verfehlte genau den Weg, über den ein Steuernder liest. Gilt nur, solange jemand steuert.
- **Mehrere Bildschirme**: der Weckruf trägt eine Bildschirm-NUMMER (nie eine Aufnahmequelle — der Gateway soll nicht bestimmen, was ein fremder Rechner aufnimmt); je Schirm ein eigener Stream, **erst auf Anforderung**. Angefordert wird an zwei Stellen mit derselben Logik (`devices/schirme.svelte.ts`): Geräteansicht und Menü am Griff im Player (`overlay/fernbedienung.rs` → `player:remoteScreen`). **Der Ton hängt am ERSTEN Schirm** (`Desktop`), alle weiteren `Aus` — sonst käme er mehrfach versetzt an. Eine Sitzung bedient alle Schirme: die Platznummer steht in jeder Eingabe-Nachricht, erfasst wird in JEDEM offenen Player-Fenster, und `zuordnung.rs` rechnet die Anteile ins Rechteck des gemeinten Schirms. **„Alle Schirme in EINER Aufnahme" (Entwurf §5) geht auf Windows nicht** — WGC nimmt immer genau einen auf.
- **Was fehlt:** Ausweisbezug im Cloud-Token (Self-Hosts haben ihn über `SessionClaims.cert_id`), Rollen in der Freigabeliste, eigenes Geräte-Konto.

**Desktop ↔ Sidecar-Bridge**: Electron-Main spawnt den Plattform-Sidecar **lazy** beim ersten `gsr:call`. Alle sprechen dasselbe **stdio-JSON-RPC** (voll in `streaming/README.md`). `desktop/electron/sidecar.ts` (`SidecarManager`-Singleton). Path-Resolver via `$PULSE_SIDECAR_PY`/`$PULSE_HQ_SIDECAR`/`$PULSE_LINUX_HQ_SIDECAR` → Walk-up → Flatpak/`%LOCALAPPDATA%`. Renderer `window.pulse.gsr.*` (Shape `web/src/lib/platform/pulse.d.ts` — **mit `preload.ts` synchron halten**).
- **Linux hat ZWEI Sidecars**: **Rust = Standard**, Python/GSR = Auffangnetz. `resolveLinuxSpawn()` nimmt Rust; fehlt das Binary, **automatisch** GSR-Rückfall (sonst verschwände HQ wortlos). Notbremse `useLegacyGsrSidecar` (default false) im Kompatibilitäts-Tab (`window.pulse.gsr.backend()` → `{kind, reason}`). Wirft nur, wenn BEIDE fehlen.
- **Rust-Linux-Sidecar liegt im Repo** (`streaming/linux-hq-sidecar/`); Flatpak baut ihn per `type: dir` → Änderung löst Flatpak-Build aus. Dev braucht `$PULSE_LINUX_HQ_SIDECAR` (setzt `dev-up.fish` wenn gebaut). Bei `Cargo.lock`-Änderung `packaging/linux-hq-sidecar-cargo-sources.json` neu generieren (Flatpak baut Cargo offline). Messbegründungen zu Encoder-/Puffer-Werten: `docs/2026-07-30-linux-hq-sidecar-messbegruendungen.md`.
- **Bild-Zeitbasis = 1/90000, nicht 1/fps** (seit 2026-08-14, `src/zeitbasis.rs` in **beiden** Rust-Sidecars — Datei **synchron halten**, sie ist bewusst wortgleich): ein Bildplatz-Raster rundet die echte Ungleichmäßigkeit der Abtastung weg (auf 143 Hz bei 60 fps entstehen Bilder im Muster 2-2-3 Schirmtakte = 13,9/13,9/20,8 ms, nicht dreimal 16,7) — sichtbar als Rest-Unruhe trotz gesunder Zahlen. 90 kHz ist die RTP-Uhr, damit wird die Umrechnung im WHIP-Weg zur Identität. **Zwei Fallen, beide gemessen:** Duplikate müssen am ZÄHLER hängen (`last_pts + takte_je_bild`) — an der stehenden Aufnahme-Uhr verankert lägen sie 11 µs auseinander und eine Sekunde Standbild schrumpfte auf Millisekunden; und die Lücken-Diagnose braucht `lueckenschwelle` = **zwei** Bildabstände (die echte Abtast-Schwankung reicht bis 2,0, wenn Zielrate und Schirm-Wiederholrate dicht beieinanderliegen — anderthalb meldeten Phantome). Messprotokoll beider Plattformen: `docs/2026-08-14-hq-60fps-glaettung-messanleitung.md`.
- **Diagnose-Log-Upload** (`experimental-log-upload.ts`): **eigenes** Opt-in `uploadDiagnosticLogs` (default false).
- **Testen ohne realen Stream**: `printf '{"op":"health","id":1}\n...' | python3 streaming/gsr-sidecar/control.py` — **KEIN `{"op":"start"}`** (öffnet Wayland-Portal + streamt wirklich); `build_argv` baut nur argv.
- **GSR-Binary-Resolver**: `$GSR_BINARY` → Flatpak → Custom-Build (`$XDG_CACHE_HOME/pulse/gsr/...` via `bootstrap-gsr.fish`) → PATH. Fehlt alles → `health.gsr.available=false`. Persistenter Cache-Pfad (nicht `/tmp` — war tmpfs → HQ nach Reboot weg).
- **Windows-HQ-Sidecar** (`streaming/win-hq-sidecar/`, Rust): WGC-Capture + wasapi, 3 Encode-Pfade (NVENC / AMD-D3D12VA / CPU-Fallback). Voll: `streaming/win-hq-sidecar/README.md` + `WINDOWS_HQ_SIDECAR.md`. Nicht-offensichtliche **Entscheidungen**: **Intra-Refresh** — `encode/auffrischung.rs` entscheidet an einer Messwerttabelle je Encoder und **verweigert den Start**, statt still Keyframes unter dem Etikett zu fahren (`h264_d3d12va` nimmt die Option an und tut nichts damit). AMD trägt es über **AV1/`av1_amf`**. **HDR** (AV1 10 bit, PQ/BT.2020) nur Windows — `encode/hdr.rs` nach gleichem Muster: **unerfüllbar = Startverweigerung**; Aufnahme in `Rgba16F`/scRGB, eigener HLSL-Shader `encode/hdr_zeichner.rs` (AMD-Video-Prozessor kann kein PQ). **Getragen wird HDR von AV1 auf AMD *und* NVIDIA** (`av1_amf` seit 2026-08-06, `av1_nvenc` seit 2026-08-11 — bis dahin stand hier nur AMD). **Die Mastering-Metadaten sind auf beiden mangelhaft, verschieden:** AMD schreibt sie mit falschen Zahlen (AMF-Festkomma-Fehler, bewusst nicht vorkompensiert), NVENCs AV1-Encoder schreibt sie gar nicht (Treiber 610.47, belegt gegen `hevc_nvenc`, das es über dieselbe FFmpeg-Stelle tut) — der Start sagt das an. Die **Signalisierung** ist überall vollständig, und nur an ihr hängt die Bilddeutung. Details `docs/2026-08-06-hdr-windows-amd.md` + `docs/2026-08-11-hdr-windows-nvidia.md`. **10-bit-SDR muss BT.709 ausdrücklich setzen** (sonst gibt sich AMF als PQ aus; `encoder_hw.rs`). **Eigener WebRTC-Sendeweg** (`src/whip/`) für `http(s)://`-Ziele + AV1 (RTCP-Rückkanal; ffmpegs Muxer trägt kein AV1); RTMPS + CPU/Intel-Weg bleiben beim Muxer.

**Settings-Persistenz (Electron)**: `desktop/electron/store.ts` = hand-rolled KV-Store (**bewusst kein `electron-store`** — ESM-only → CJS-Friktion). `<userData>/pulse-stream.json`, sync read/write. Linux `chmod 700`/`600` (Custom-Server-Stream-Keys im Klartext). Renderer: `web/src/lib/stream/persistence.ts` → `window.pulse.store.*`, `localStorage`-Fallback im Browser.

**Frontend-Plattform-Detection**: `web/src/lib/platform/runtime.ts` — `isElectron()`/`isDesktop()`/`isLinux()`/`isWindows()`/`isMac()`/`isCapacitorAndroid()`/`isMobile()`. Dev-Test-Route `/app/dev/stream` (nicht im Menü) = Sidecar-Op-Diagnose.

## Self-Host-Identität & Cert-Modell

Minecraft-Modell: Identität zentral über die Cloud (howispulse.com), Server sind isolierte Welten. **Voll-Konzept: `IDENTITY_CONCEPT.md`**.
- **Instanz-Rolle** (Env, chat-gateway *und* auth-svc): `PULSE_INSTANCE_MODE` = `cloud`|`self-host` (**Default `self-host`!**, prod-Cloud `.env` setzt `cloud`); `PULSE_INSTANCE_ID` (0 = Cloud; ≥100 = von Cloud vergeben); `PULSE_INSTANCE_OWNER_ID` (chat-gateway) = Cloud-User-ID des Owners → beim Cert-Login wird `cert.user_id == owner_id` **automatisch Admin**; `ALLOW_LOCAL_ACCOUNTS` (auth-svc, default false) = lokaler Passwort-Escape.
- **Registrierung** (`auth_settings.registration_mode`: open|invite_only|closed): Self-Host (`mode != cloud`) **blockt `POST /register`** by default → Identität per Cert-Login. `invite_only` verlangt Code (`registration_invites`, Migration 0022, atomar guarded-UPDATE; Deep-Link `…/register?invite=CODE`).
- **Cert-Login** (`routes/cert_login.py`): Challenge/Verify mit **Ed25519-Proof-of-Possession** über Server-Nonce (Cert allein reicht NICHT, replay-sicher). Mintet lokalen Session-Token (`session_tokens.py`, EdDSA, 5 Min). Self-Host nutzt **pairwise_sub** (Privacy). `credential_validator.py` prüft Cloud-JWKS + CRL.
- **Admin-Status pro Server**: Session-Token `admin`-Claim → `ws_ready` liefert `is_admin` → Frontend `serverAdmin`-Store (Cloud: auth `/me`; Self-Host: ready-Frame, da Cert-User dort kein auth `/me`).
- **Instanz-Verwaltung ist cloud-only**: `routes_admin_instances` hinter `_require_cloud`; Frontend blendet `AdminInstances` auf Self-Hosts aus.
- **Approval = Single-Bootstrap pro Antrag**: approved → User mintet **genau einmal** einen Bootstrap-Token (`POST /selfhost/bootstrap`; danach `consumed_at IS NOT NULL` blockt weitere → neuer Antrag pro Server). Container-Crash-Recovery nutzt persistierte `client_id`/`client_secret` direkt, ohne Re-Redeem.
- **well-known-Endpoints** (auth-svc, Root): `/.well-known/{jwks.json, revoked-credentials, pulse-version-policy.json, pulse-suspended-instances}` — Self-Hosts pollen: `crl_poller.py` (revoked-credentials + jwks, 10 s), `cloud_policy_poller.py` (version-policy, 6 h), `suspend_poller.py` (suspended-instances, 60 s). Sperre verweigert Cert-Login (403 `instance_suspended`/`instance_deleted`) + trennt WS (4003). **Fail-open ist Absicht** (Cloud/Redis nicht erreichbar = „nicht gesperrt", sonst legt ein Cloud-Ausfall alle Self-Hosts lahm); Daten unangetastet, Container nicht gestoppt (Sperre umkehrbar, sonst Neustartschleife). **`web-nginx.conf` muss sie per Regex-Location an auth-svc routen** (sonst SPA-Fallback → Poller scheitern still mit JSONDecodeError). `acme-challenge` ausgespart.
- **Presence-Status dauerhaft**: manueller Status (online/idle/dnd/invisible) zusätzlich in `chat.user_preferences` gespiegelt; `ws_ready` restored ihn, wenn der Redis-Key (24 h) abgelaufen ist. Auto-Sweeper-Übergänge bleiben Redis-only.
- **UI-Terminologie**: Discord-„Guild" = **„Community"** im UI, „Server" = Pulse-Instanz (Kollision vermeiden). Code bleibt `guild`/`Guild`.
- **Account-basierte Server-Liste** in `auth.user_instance_memberships` (Cloud-DB, Migration 0037); beim Bootstrap-Redeem automatisch eingetragen, `GET /me/instances` liest sie. Inhalts-Privacy unverändert (isolierte DB-Welten); der frühere E2E-Vault ist **komplett entfernt**. Nicht-Owner-Erweiterung für Phase 4-6 (`role`-Feld vorbereitet).

## Plugin-System (Stufe A)

Top-Level `plugins/` (Referenz `hello` + `tamagotchi`). Manifest `plugin.toml` (Backend) + `manifest.ts` (Frontend-Spiegel, **manuell synchron halten**). Loader `chat_gateway/plugins/loader.py` + `web/src/lib/plugins/loader.ts`. Ops colon-namespaced (`tamagotchi:feed`). Stufe B/C → `docs/PLUGIN_ROADMAP.md`.
- **Prod-Discovery braucht `plugins/` in ZWEI Images**: `web/Dockerfile` (Frontend) + `Dockerfile.service` (chat-gateway, `discover_plugins_dir()` sucht `/app/plugins`). Ohne `COPY plugins/` → alle verwaist.
- **Aktivierung zwei Ebenen**: Instanz-Allowlist `chat.instance_plugin_allowlist` (`/admin/plugins`, live) + Pro-Guild-Toggle `chat.guild_plugins` (`MANAGE_GUILD`, ≤60 s via `ws_op_gate`-Cache).
- **`hello` Sonderfall**: immer allowlisted (Seed Migration 0020), nicht entfernbar (409); `hello:*` bypassen Membership + Toggle.
- **Plugin-Ops brauchen `guild_id: SnowflakeId`** (außer `hello:*`). `ws_op_gate`-Codes: 4040 allowlist · 4041 guild_id fehlt · 4042 non-member · 4043 nicht aktiviert.
- **DB-Session über `ctx.manager._session_factory`** (nicht `from …db import SessionLocal`) — sonst sehen ws_app-Tests die ungepatchte Memory-DB.
- State-Scope: per-User → `chat.user_preferences`, per-Guild → `chat.guild_plugin_state` (Migration 0021, race-safe `state_store.py::apply_atomic_update`). **DMs/Friends = plugin-frei** (`guildId === ''`); Toggle-Änderung erst beim nächsten Guild-Mount sichtbar (kein Server-Push).

## Flatpak-Packaging — `packaging/`

`com.howispulse.Pulse` (`flatpak-builder`). Bündelt Electron-43 + Python-GSR-Sidecar + custom `gpu-screen-recorder`. **Web wird nicht mitgepackt** (lädt remote) → nur native Änderungen brauchen Rebuild. Lokal `packaging/build.fish`. Auto-Publish bei nativen `main`-Pushes (`.github/workflows/flatpak.yml`).
- **`build.fish` ERSETZT die installierte App** (endet auf `--user --install`) und hängt die Installation an `.flatpak-builder/cache` → `flatpak update` zieht aus dem lokalen Verzeichnis statt vom veröffentlichten Repo, sieht aus wie echtes Update. **Nur prüfen:** `flatpak-builder --repo=/tmp/... build/flatpak packaging/com.howispulse.Pulse.yml`, Ergebnis unter `build/flatpak/files/`. Zurück auf den Auslieferkanal: deinstallieren **ohne** `--delete-data`, neu von `https://howispulse.com/flatpak/com.howispulse.Pulse.flatpakref`; danach muss `flatpak list --columns=application,origin` `pulse-origin` zeigen (nicht `pulse1-origin`).
- **Häufigster Crash**: Electron-Binary mit `strip-components: 0` entpacken — Default `1` plättet `locales/`+`resources/` → `default_app.asar` fehlt → Exit 1 vor `main.cjs`. Voll: `packaging/README.md`.

## Produktiv-Deployment (netcup-VPS) — Voll-Doku `infra/prod/DEPLOY.md`

**Cloud = netcup `michael@159.195.150.54`** (Debian 13), **https://howispulse.com**. **Hetzner `michael@77.42.71.166` (`pulse-test` in `~/.ssh/config`) trägt seit 2026-08-12 die Fernsteuer-Testinstanz** `https://pulse.unicutmedia.com` — Compose-Projekt `~/pulse-test/` (Container `pulsetest_*`), Quellcode als Git-Checkout in `~/pulse-test/repo` auf `feat/windows-bruecke`, Images lokal gebaut (`pulsetest-*:local`), `PULSE_INSTANCE_MODE=cloud`. **Aufbau + Testablauf: `docs/plans/2026-08-12-zwei-geraete-test-aufbau.md`.** Zwei Stolpersteine beim Aktualisieren: das **Web-Bundle muss von einer Entwicklermaschine kommen** (Server-Node ist v18, zu alt) und wird als Volume `./web-build` eingehängt — deshalb den **Inhalt** ersetzen, nicht das Verzeichnis tauschen (Bind-Mount hängt am Inode); Dienst-Images gehen über `docker build -f Dockerfile.service --build-arg SVC_DIR=<dir> --build-arg SVC_PKG=<pkg> -t pulsetest-<x>:local .` im `repo/`. **`PULSE_KEYFRAME_INTERVAL: "0"` beim `mediamtx`-Dienst ist Pflicht** (dev/prod setzen es, die Testinstanz hatte es nicht): sonst fordert MediaMTX über seinen fest verdrahteten 2-s-Takt dauernd Vollbilder an, `forced-idr` macht echte IDR daraus, und CBR zeichnet das Bild danach 1–2 s weich — **sichtbares Pumpen im 2-s-Takt, das Intra-Refresh gerade aushebelt** (2026-08-12 live beobachtet, Schalter gesetzt, weg). Vorher prüfen, dass `hls: no` gilt, sonst stirbt der HLS-Muxer an den fehlenden Vollbildern (Begründung in `infra/prod/mediamtx.yml`). Der **MediaMTX-Messstand** lag auf derselben Adresse und ist dafür **gestoppt** (Rückholanleitung auf dem Server: `~/messstand-gestoppt-2026-08-12.txt`; solange laufen die Werkzeuge in `streaming/win-hq-labor/testbench/` nicht). Ebenfalls dort: nächtliche **verschlüsselte Sicherungen der Prod-Config** (`~/pulse-prod-notfall`) — und **fremde Projekte des Users** (supabase, cs-trading, crewconnect, wohnung, skinvestment) hinter einem gemeinsamen Caddy. **Die Kiste ist eng**: 4 CPUs, 7,5 GB RAM (~4 frei), 38 GB Platte zu 77 % voll. Wer dort etwas hinstellt, gefährdet fremde Dienste — vorher Platz prüfen, nicht danach. Compose-Stack (`name: pulse`) in `~/pulse/infra/prod/`: die 6 FastAPI-Dienste (GHCR `ghcr.io/oblivion8282-1337/pulse-*:latest`), `migrate-{auth,chat}`, `mediamtx`+`livekit` (host-net) **sowie (oft übersehen)** `postgres`, `redis`, `web` (nginx), `minio`+`minio-init`, `backup`, `registry`, `frps`. **Kein Watchtower** — Auto-Update über User-Crontab (`infra/prod/pulse-update.sh`, `compose pull && up -d`).
- **Auto-Update**: push → main → `ci.yml` baut+pusht GHCR → Cron zieht `:latest` ≤5 min (inkl. migrate → Migrationen auto). Struktur-Änderung (Service/Env/Config): `rsync infra/ → ~/pulse/infra/` + `docker compose up -d`.
- **Deploy vom Test-Gate entkoppelt**: `images`-Job hängt nur am `changelog`-Job (der **warnt nur**) → kein blockierendes CI-Gate. **Verbindliches Test-Gate ist LOKAL vor dem Push** (pytest + `pnpm check` + build grün, BEVOR gepusht).
- **Routing**: Caddy → `pulse_web` nginx → `/api/{auth,chat,ws,voice}/*`, `/wheph`+`/hls` MediaMTX, `/livekit` LiveKit. host-net-Ziele **statisch** `proxy_pass http://host.docker.internal:PORT/` (Variable+Resolver → 502, da Dockers `127.0.0.11` `host.docker.internal` nicht kennt).
- **Gotchas**: Secrets server-seitig in `.env` + `secrets/jwt_*.pem` (**PEM `chmod 0644`**, uid 10001). Avatar-Volume Fresh-Deploy `chown 10001:10001` (sonst Upload-500). UFW `7880`/`9997` nur vom Docker-Bridge (`ufw allow from 10.0.0.0/8`) — sonst blockt `INPUT DROP`. MediaMTX = **1.19.1-pulse4**-Fork (`infra/mediamtx-fork/`, TempDelim-Patch für AMD-VAAPI AV1, Image `ghcr.io/oblivion8282-1337/pulse-mediamtx:1.19.1-pulse4`); `:9997`-API-Schutz hängt **nur an der UFW** (`apiAllowAddresses` in 1.19 entfernt). Dev-compose läuft ebenfalls 1.19.1-pulse4. Migrate-Container laufen automatisch beim Deploy mit.

## CI-Workflows (`.github/workflows/`)

- **Pflicht-Check auf `main`: nur `CLAAssistant`** (`cla.yml`). `backend`/`frontend` sind **keine Pflicht** — Test-Gate ist LOKAL (`scripts/ship.sh` erzwingt pytest+`pnpm check`+build bei Code-Änderung, **rot = kein Push**; Doku-only übersprungen; Notausgang `SKIP_TESTS=1`).
- Build-Workflows mit `on.push.paths` (`win`/`mac`/`flatpak`/`allinone`). **`ci.yml`** hat `paths-ignore` (`**.md`/`docs/**`/`.claude/**`) auf **beiden** Triggern → reine Doku löst keinen Check/Deploy aus.
- **`allinone.yml` = Self-Host-Image, Multi-Arch NATIV** (nicht QEMU): amd64 `ubuntu-24.04` / arm64 `ubuntu-24.04-arm`, 3 Jobs (`prepare`→`build`-Matrix→`merge` mit `imagetools` + `registry.howispulse.com`-Mirror), Kaltbau ~8 min. **Nicht auf QEMU zurückbauen** (war ~90 min).
- **CI nur auf `main` real testbar** (kein PR-Check; triggern auf `main`-Push/Tag) — erster Lauf nach Merge beobachten.
- CI-only (`.github/**`) = NON_USER_FACING → kein Changelog-Eintrag.

## Port-Mapping (lokales Dev)

| Dienst | Port | |
|---|---|---|
| Postgres | **5434** | nicht 5433/5432 (Schwester-Worktree); `.env` reflektiert das |
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

**Docker:** Claude hat **root** (`sudo systemctl start docker`). Daemon down (Symptom `failed to connect to the docker API` / `no such file or directory`) → **selbst starten**, nicht den User fragen.
**`scripts/dev-up.fish`** = ganzer Stack (Infra + 5 uvicorns `--reload` + Vite + Electron-Dev; `dev-down.fish`). Manueller Einzelstart — gemeinsam `REDIS_URL=redis://localhost:6380/0`, `AUTH_JWKS_URL=http://127.0.0.1:8001/.well-known/jwks.json`:
- **auth/chat-gateway**: `POSTGRES_PASSWORD`, `JWT_PRIVATE_KEY_FILE`+`JWT_PUBLIC_KEY_FILE` (absolut); chat-gateway zusätzlich `MEDIA_SVC_URL=http://127.0.0.1:8004`. `DELETE /me` braucht `INTERNAL_SERVICE_SECRET` (auth+chat identisch) + `CHAT_GATEWAY_URL`.
- **voice-signaling**: LiveKit-Keys aus `livekit.yaml`/`.env` (`LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=devsecret…`, `LIVEKIT_URL=ws://localhost:7880`).
- **media-svc**: `MEDIAMTX_API_URL=http://localhost:9997/v3/paths/list`. MediaMTX down → nur `mediamtx_poll_failed`-Log.
Einzel-Infra: MediaMTX `docker compose -f streaming/server/docker-compose.yml up -d`, LiveKit `docker compose --profile voice up -d`.

## Tests

- Backend: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q`. Pro-Service `services/*/tests/` (MediaMTX/LiveKit gemockt; Redis `/1`).
- **Flake-Retry**: CI-pytest `--reruns 2 --only-rerun AssertionError --only-rerun RuntimeError`. Root-Cause = Cache-Mutation-Races (Fix `SELECT FOR UPDATE` aus `state_store.py`).
- **Den Volllauf NICHT neben schwere Builds legen.** Läuft parallel `cargo build`/`pnpm build`, **hängt** ein WS-Test bis ins Zeitlimit statt nur langsamer zu werden (2026-08-12 zweimal, jeweils in `test_remote_handlers.py`; `--reruns` greift nicht, weil ein Timeout kein `AssertionError` ist). Auf ruhiger Maschine: **1961 grün in 9 min**. Wer einen Hänger sieht, prüft zuerst die Maschinenlast, nicht den Test.
- **Playwright-Grundlinie (2026-08-14, lokal Windows): 98 grün, 4 rot** — `attachments`, `dropbox`, `watch-party/detach handover`, `report` (Bestätigung nach dem Absenden). Alle vier fallen **auf `main` genauso** (A/B gefahren), sind also Bestand; `report` kam 2026-08-14 dazu (vorher standen hier 3). Ohne diese Grundlinie hält man sie für eigene Regressionen. Ein rot gemeldeter Test in einer Datei nimmt deren Rest als „did not run" mit — die Gesamtzahl schwankt deshalb. **`admin.spec` flakt unter Volllast**, und zwar an wechselnden Stellen (über drei Volllläufe: einmal „register both users", einmal gar nicht, einmal „abuse report appears in the complaints section") — allein ist die Datei jedes Mal vollständig grün. Wandert der Fehlschlag zwischen Läufen, ist es keine Regression: erst einzeln nachfahren, dann urteilen.
- Frontend: `cd web && pnpm check && pnpm build` + `pnpm exec playwright test`. Kein Vitest im Web.
- E2E-DB = `dcc_test` (separat; Dev-DB `dcc` unangetastet). Test-Redis `/1`. Playwright lokal braucht `PULSE_INSTANCE_MODE=cloud`.
- **Manuell, nicht automatisiert**: echter GSR-`start` (Portal + realer Push), Electron-GUI-Sichttest, HQ-Stream-E2E (2 Clients).
- **Vor jedem Commit**: pytest + `pnpm check` + `pnpm build` + Playwright.

## Konventionen

- **Kein `git push` / keine GitHub-CLI** ohne Freigabe. Remote `origin` → `github.com/oblivion8282-1337/pulse.git`.
- **Branch-Workflow** (mehrere Rechner parallel — Mac + Linux): jede Code-Änderung auf einem **Feature-Branch** (`feat/`/`fix/`/`docs/`), **immer von frisch gepulltem `main`** — **nie direkt auf `main`**. Landen **nur über GitHub-PR** (nie lokal `git merge` + manuell löschen — ff-Merge fällt um, Cleanup verwaist): **`bash scripts/ship.sh`** (rebased server-seitig, wartet auf Pflicht-Checks, löscht den Branch atomar erst nach Merge). Merge nach main = **Prod-Deploy → nur auf Freigabe**. Notfall lokal (strikt guarded): `git fetch && git rebase origin/main && git checkout main && git merge --ff-only <branch> && git push && git branch -d <branch>` (Cleanup nie ohne `&&`). Changelog-Konflikt paralleler Branches: Top-Eintrag auflösen (neueres Datum / `.N`-Suffix oben).
- **`git tidy`** nach gemergtem PR laufen lassen (löscht lokal die server-seitig bereits gelöschten Head-Branches). Einmalig pro Maschine setzen: `git config --global fetch.prune true` + den Alias.

  ```
  git config --global alias.tidy '!f() {
    git fetch --prune -q
    LC_ALL=C git for-each-ref --format="%(refname:short) %(upstream:track)" refs/heads |
      awk "\$2==\"[gone]\" {print \$1}" |
      while read -r b; do
        if [ -n "$(git cherry main "$b" 2>/dev/null | grep "^+")" ]; then
          echo "BEHALTEN - $b hat Commits, die nicht in main sind"
        elif ! git branch -D "$b" 2>/dev/null; then
          echo "BEHALTEN - $b ist in einem Worktree ausgecheckt (erst: git worktree remove)"
        fi
      done
  }; f'
  ```

  Drei nicht-offensichtliche Stücke (beim Kürzen nicht wegfallen):

  **`for-each-ref` statt `branch -vv`.** Bis zum 2026-08-17 stand hier `git branch -vv` samt `awk`-Griff „nimm Spalte 2, wenn Spalte 1 ein `*` ist". Das übersieht **`+`**, mit dem `git branch` einen in einem **Worktree** ausgecheckten Branch markiert — der Alias las dann `+` als Branchnamen und meldete je Worktree ein `Fehler: Branch '+' nicht gefunden`, während die eigentlichen Branches liegenblieben. `for-each-ref` gibt gar keine Markierung aus; damit ist die Fallunterscheidung überflüssig statt nur repariert.

  **`LC_ALL=C`** Pflicht (sonst schreibt git auf deutscher Maschine `[entfernt]` statt `[gone]` → Muster greift nie, räumt still gar nichts).

  **`git cherry`** statt `--merged`/`-d`: bei Rebase-Merges haben gleiche Änderungen andere Prüfsummen, `--merged`/`-d` halten den Branch fälschlich für ungemergt — mit `-D` wäre er wortlos weg. **Diese Prüfung fehlte am 2026-08-17 in der real installierten Fassung**, obwohl sie hier dokumentiert war; wer den Alias auf einer Maschine schon hat, gleicht ihn mit `git config --global --get alias.tidy` gegen den Block oben ab.

  Ein Branch in einem Worktree lässt sich nicht löschen, solange dieser besteht — der Alias sagt das jetzt, statt mit einer Fehlermeldung abzubrechen. Aufräumen: `git worktree list`, dann `git worktree remove <pfad>`, dann erneut `git tidy`.

- **git-Identität pro Maschine** (gegen CLA-Block): `CLAAssistant` ordnet Commits über die Autor-**E-Mail** dem GitHub-Konto zu. `git config user.email` muss `249562202+oblivion8282-1337@users.noreply.github.com` sein (leer/frei erfundene `*.local`-Adresse → GitHub kann nicht zuordnen → Bot blockt jeden PR). Beim ersten Mal auf einer neuen Maschine prüfen/setzen. Falsche Mail an gepushten Commits: `git commit --amend --reset-author` + force-push + `recheck` als PR-Kommentar.
- **Memory-Hygiene:** `~/.claude/...`-Memory ist **per-Maschine, nicht zwischen Rechnern geteilt** und veraltet leicht → dort **keine transienten Git-Stati** (Branch-Namen, „unpushed", „N offen"). Dauerhaftes gehört ins `CLAUDE.md`. Beim Merge nach main zugehörige Memory mit aktualisieren/löschen.
- **Code-Simplifier nach jeder Code-Änderung (Disziplinregel, nicht per Hook erzwungen):** `code-simplifier`-Agent über die geänderten Dateien → Tests/Checks erneut grün → `bash .claude/hooks/simplify-stamp.sh` → committen. Hooks wurden entfernt; Skripte unter `.claude/hooks/` funktionieren, Mechanik in `.claude/hooks/README.md`.
- **Eine Behauptung wird nie an nur EINER Stelle korrigiert — vorher greppen.** Wer einen Wert/Pfad/Optionsnamen/Version/eine Verhaltensaussage ändert, sucht erst alle Fundstellen (`grep -rn "<alter Wert>"`) und zieht sie mit. Anfällig: IPs/Hostnamen, Versionsnummern (Electron/MediaMTX/FFmpeg), Env-Variablennamen, Encoder-/Optionsnamen, Ops-Listen, Lizenzbezeichnungen — alles, was gleichzeitig in `CLAUDE.md`, einer `README.md` und einem Code-Kommentar steht.
- **Refactoring darf Verhalten nicht ändern** — Endpoint-Pfade, Response-Models, `data-testid` bleiben identisch. Bricht ein Test nach Refactor → Code kaputt, nicht Test.
- **Code-Größen-Policy** (`PLAN.md` §12.1): Source ≤ 350 Z. (hart 500), Svelte-Components ≤ 250. Ausgenommen Tests/Migrationen/`lib/components/ui/`. Im Zweifel splitten.
- **Lies zuerst, ändere danach. Keine neuen Dependencies ohne Rückfrage. Tests proaktiv laufen lassen.**
- **Niemals Stream-Keys/Tokens loggen.** `~/Dokumente/GPU_Screen_Recorder/` READ-ONLY — nur vendored `streaming/`-Kopie modifizieren.

## Changelog — „Was ist neu?"-Toast nach dem Update-Reload

User-facing Changelog, **einmalig nach einem Deploy-Reload** als **nicht-blockierender Toast unten rechts** (sobald der User **eingeloggt** ist; wegklickbar). Quelle **`web/static/changelog.json`** (neuester Eintrag zuerst; Felder `id`/`date`/`style`/`title`/`intro?`/`items[]`/`outro?`). `ChangelogGate.svelte` vergleicht `entries[0].id` mit `localStorage['pulse.changelog.lastSeen']` und feuert via sonner `toast.custom`, sobald `auth.user` gesetzt (nie auf Login-Screen); beim Anzeigen wird `lastSeen` hochgesetzt → genau EINMAL pro Update. nginx serviert `/changelog.json` **no-cache**.

**Redaktionelle Regel, kein Gate**: `scripts/check-changelog.sh` **warnt nur** (`exit 0`) → Deploy läuft auch ohne Eintrag. Eintrag sinnvoll, wenn ein Nutzer die Änderung **bemerken** würde; Verfeinerung desselben Themas am selben Tag gehört in **denselben** Eintrag (kein zweiter Toast).

**Workflow vor Push:**
1. **User-verständlichen** Eintrag ableiten (kein Tech-Jargon).
2. **Stil vom User wählen lassen** (mehrere Vorschläge; zuletzt „Sachlich"). **KEINE Emojis — nirgends** (Titel, Intro, Items, Outro; gilt auch für Assistenten-Antworten). **Echte Umlaute (ä/ö/ü/ß)** für neue Changelog-Einträge **und** Commit-Messages — nicht ae/oe/ue/ss (früher nur Gewohnheit). Vorsicht bei ss→ß (mehrdeutig: „dass" bleibt, „Straße" wird „ß") — Wort für Wort. Ältere Changelog-Einträge stehen weiter in ae/oe/ue (Archiv; jeder wird nur einmal bei seiner ID gezeigt — Voll-Konvertierung nur auf Wunsch).
3. Neuen Eintrag oben in `entries`, `id` eindeutig (Datum; mehrere/Tag → `2026-06-05.2`).
4. Nur **user-facing** Code verlangt einen Eintrag — **maßgeblich `NON_USER_FACING` in `scripts/check-changelog.sh`**: `*.md`, `LICENSE*`, `docs/`, `.github/`, `infra/`, `packaging/`, `scripts/`, `Dockerfile*`, `*.toml`, `*.yaml`/`*.yml`, `build-resources/`, `package.json`, `*/tests/`, `conftest.py`, `*/alembic/`, `web/static/install.sh`, `.*ignore`, `changelog.json` selbst.

## Anti-Patterns (voll in `PLAN.md` §12)

- ❌ Shared DB-Tabellen zwischen Services · ❌ HS256 JWT (nur RS256)
- ❌ `fastapi-users` / `broadcaster` / `fastapi-socketio` / `fastapi_websocket_pubsub` (archiviert → Eigenbau)
- ❌ State-Library (Redux/Zustand/Pinia) neben Svelte-Runes · ❌ CSS-in-JS (Tailwind reicht)
- ❌ **Tauri** als Desktop-Wrapper (WebKitGTK-WebRTC unzuverlässig → Electron) · ❌ `electron-store` (ESM-only) · ❌ React-Bridge für LiveKit-Components
- ❌ `@livekit/krisp-noise-filter` (kostenpflichtig) · ❌ `deepfilternet3-noise-filter` (kratzig + Worklet-Underrun) · ❌ `svelte-french-toast` (Sv5-inaktiv) · ❌ `svelte-markdown` blind (kein Sanitizer)
- ❌ Exactly-once-Delivery · ❌ Re-Publishing MediaMTX→LiveKit (Transcoding zu teuer)
- ❌ Routes-/Service-Dateien über die Größen-Grenze wachsen lassen statt splitten

## graphify

Knowledge graph in `graphify-out/` (god nodes, community structure, cross-file relationships).
- Bei Codebase-Fragen zuerst `graphify query "<Frage>"` (oder `graphify path "<A>" "<B>"` / `graphify explain "<Konzept>"`) — liefert ein scoped Subgraph, viel kleiner als `GRAPH_REPORT.md` oder grep.
- Breite Navigation über `graphify-out/wiki/index.md` (falls vorhanden) statt rohem Source-Browsing.
- `GRAPH_REPORT.md` nur für breiten Architektur-Review.
- Nach Code-Änderung `graphify update .` (AST-only, kein API-Kosten).
