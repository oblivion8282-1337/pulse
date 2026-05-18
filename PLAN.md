# Pulse — Implementierungsplan

**Stand:** 2026-05-11 (revidiert nach Web-First-Entscheidung)
**Arbeitsname:** `discord-clone` (Platzhalter, am Ende von Etappe 1 finalisieren)
**Ziel-Plattformen:** Web (alle Browser), Desktop via Tauri 2 (Linux/Windows/Mac), PWA-installierbar
**Beziehung zum Streamer:** `~/Dokumente/GPU_Screen_Recorder/` bleibt **unverändert**. Linux-Power-User bekommen einen kleinen GSR-Helper-Daemon, der die existierende `stream_controller.py` als Library importiert.

---

## 1. Architektur-Grundsatz

**Drei Transportpfade** — sauber getrennt, jedes nur das, was es gut kann:

```
                                ┌─────────────────────────────────────────┐
                                │             Hetzner-vServer              │
                                │                                          │
  Web-App ─────HTTPS/WSS───────▶│  Caddy ─▶ auth-svc                       │
  (Browser oder Tauri-Bundle)   │         ├▶ chat-gateway (WebSocket)      │
                                │         ├▶ voice-signaling               │
                                │         ├▶ media-svc                     │
                                │         └▶ mediamtx-auth-hook            │
                                │                                          │
  Web-App ───WebRTC/Opus───────▶│  LiveKit (Voice + Screen-Share-Tracks)   │
                                │                                          │
  Web-App ◀──WHEP/WebRTC───────▶│  MediaMTX (nur für GSR-HQ-Streams)       │
                                │                                          │
  GSR-Helper ──RTMP/SRT────────▶│  MediaMTX                                │
  (nur Linux, optional)         │                                          │
                                │  Postgres │ Redis │ MinIO                │
                                └─────────────────────────────────────────┘

  Web-App ──HTTP/WS auf 127.0.0.1──▶ GSR-Helper-Daemon (nur Linux)
                                         │
                                         └─QProcess─▶ GSR (existierend)
```

**Modularitäts-Regel:** Services kommunizieren nur über Redis Pub/Sub oder HTTP, niemals über shared DB-Tabellen. Jeder Service hat eigenes Postgres-Schema. Web-App spricht nur die offiziellen APIs.

---

## 2. Tech-Stack (Floor-Versionen — beim Setup auf aktuelle Stable pinnen)

### Server
| Komponente | Min-Version | Begründung |
|---|---|---|
| PostgreSQL | 16 | JSON-Felder, Snowflake-IDs als `bigint` |
| Redis | 7 | Streams + Pub/Sub |
| MinIO | aktuell | S3-API, Presigned URLs |
| LiveKit | aktuell | Apache 2.0, Voice + Screen-Tracks via WebRTC |
| MediaMTX | 1.18.1 (existierend) | nicht updaten — Stream-Pfad ist verifiziert |
| Caddy | 2.x | TLS-Auto + Reverse-Proxy |

### Backend-Services (Python)
| Lib | Min-Version | Wofür |
|---|---|---|
| FastAPI | 0.115 | HTTP + WebSocket |
| SQLAlchemy | 2.x async | ORM |
| asyncpg | aktuell | Postgres-Driver |
| Alembic | aktuell | Migrations |
| `redis` (async) | aktuell | Pub/Sub + Presence |
| `pyjwt[crypto]` | aktuell | RS256 JWT-Sign + JWKS |
| `argon2-cffi` | aktuell | Passwort-Hashing |
| `snowflake-id-toolkit` | 0.6+ | Snowflake-IDs (drop-in, spart Edge-Case-Debugging) |
| `livekit-api` | aktuell | Token-Issue (Server-Side) |
| `minio` | aktuell | S3-Client |
| `slowapi` | aktuell | Rate-Limiting auf auth-svc |
| `structlog` | aktuell | strukturiertes Logging (JSON in Prod) |

**Boilerplate-Basis:** [`full-stack-fastapi-template`](https://github.com/fastapi/full-stack-fastapi-template) clonen, **nur Skeleton-Files** übernehmen (Alembic-Setup, Docker-Compose, GH-Actions, Settings-Pattern). SQLModel rauswerfen, eigene Models in SA 2.x async.

**Auth NICHT als Library:** `fastapi-users` ist 2026 in Maintenance-Mode → nur Source als Referenz lesen (besonders Password-Reset-Token-Flow), Auth-Endpoints selbst mit pyjwt direkt schreiben.

**WebSocket-Pub/Sub NICHT als Library:** `broadcaster`/`fastapi-socketio`/`fastapi_websocket_pubsub` alle archiviert/inaktiv → eigener `ConnectionManager` mit `redis.asyncio` (~300 LOC, null Lock-in).

### Web-App (Frontend)
| Lib | Min-Version | Wofür |
|---|---|---|
| **SvelteKit 5** | 5.x | Framework mit Runes-API |
| TypeScript | 5.x | Type-Safety |
| Vite | 5.x | Bundler (von SvelteKit mitgebracht) |
| TailwindCSS | 4.x | Styling, Utility-First |
| `pnpm` | 9.x | Package-Manager |
| **`shadcn-svelte`** | aktuell | UI-Components (Copy-Paste, volle Kontrolle): Dialog, ContextMenu, DropdownMenu, ScrollArea, Resizable, Command, Sheet, Tooltip, Popover |
| **`bits-ui`** | aktuell | Headless-Primitives unter shadcn-svelte (direkt nutzen für Exoten) |
| **`livekit-client`** | aktuell | LiveKit JS SDK (Voice + Screen) |
| **`@livekit/components-core`** | aktuell | Framework-agnostische RxJS-Observables — Brücke zu Svelte 5 Runes |
| **`@humanspeak/svelte-virtual-list`** | aktuell | Chat-Virtualisierung mit `mode="bottomToTop"` |
| **`@ricky0123/vad-web`** | aktuell | Silero-VAD für Voice-Activation |
| **`@jitsi/rnnoise-wasm`** | aktuell | Noise-Suppression (Free-Alternative zu Krisp, das seit 2026-05-01 kostet) |
| **`@svelte-put/shortcut`** | aktuell | Keyboard-Shortcuts (Sv5-kompatibel) |
| **`svelte-sonner`** | aktuell | Toast-Notifications (nicht `svelte-french-toast` — inaktiv für Sv5) |
| **`marked`** + **`DOMPurify`** | aktuell | Markdown im Chat (XSS-sicher manuell verdrahtet — nicht `svelte-markdown` blind!) |
| **`emoji-mart`** | aktuell | Emoji-Picker (vanilla Web-Component, framework-agnostisch) |
| **`@vite-pwa/sveltekit`** | 0.3+ | PWA + Service-Worker mit `injectManifest`-Strategie |
| `valibot` ODER `zod` | aktuell | Schema-Validation für API-Responses |
| `whep-client` | aktuell | WHEP-Player für MediaMTX-Streams |
| `lucide-svelte` | aktuell | Icon-Library (MIT, schön + leicht) |
| `@floating-ui/dom` | aktuell | Tooltip-/Mention-Positioning |

**Starter-Template:** ursprünglich war ein Tauri-Starter geplant — entfällt (Desktop-Wrapper ist Electron, §17). Die SvelteKit-App wurde manuell aufgesetzt (Tailwind v4, shadcn-svelte).

**LiveKit-Svelte-Wrapper:** Offizielles Paket existiert nicht. Dünner Eigenbau (~200-300 LOC) über `@livekit/components-core`-Observables in `lib/voice/livekit.svelte.ts` — Observables direkt in `$state`/`$derived`-Runes wrappen.

### Desktop-Wrapper
> **Hinweis:** Ursprünglich war hier Tauri 2 vorgesehen; seit dem Wrapper-Pivot
> (2026-05-12, siehe §17 / E1) ist der Desktop-Wrapper **Electron**. Aktueller
> Stand siehe §17.

| Lib | Min-Version | Wofür |
|---|---|---|
| **Electron** | 42.x (gepinnt) | Chromium-WebView + Node-Main-Process (WebRTC out-of-the-box → LiveKit-Voice) |
| esbuild | aktuell | bundlet `electron/{main,preload}.ts` (+ `sidecar.ts`, `store.ts`) → `electron/dist/*.cjs` |
| electron-builder | (T6) | Packaging — Electron-Flatpak |
| — Settings-Persistenz | hand-rolled | kleiner JSON-Store in `desktop/electron/store.ts` (kein `electron-store`-Dep — ESM-only-Friktion) |
| — globaler PTT | (später) | braucht ein natives Key-Listener-Modul (z.B. `uiohook-napi`) — Electrons `globalShortcut` kann kein Press+Release |

### GSR-Helper-Daemon (Linux-only)
| Lib | Min-Version | Wofür |
|---|---|---|
| FastAPI | 0.115 | HTTP+WS auf 127.0.0.1 |
| `pyjwt[crypto]` | aktuell | JWT-Validierung gegen auth-svc-JWKS |
| `httpx` | aktuell | JWKS-Fetch |
| `PySide6` | 6.11 | Nur für QProcess (von `stream_controller.py` benötigt) |

**Aktion Tag 1:** Mit `pip index versions` / `npm view <pkg> version` / `cargo info tauri` aktuelle Stable ermitteln und pinnen. In projekt-lokale `CLAUDE.md` schreiben.

---

## 3. Verzeichnis-Layout (Monorepo)

```
~/Dokumente/discord-clone/
├── CLAUDE.md                    # Tech-Stack mit verifizierten Versionen
├── README.md
├── PLAN.md                      # dieses Dokument
├── docker-compose.yml           # Backend-Dev-Setup
├── docker-compose.prod.yml      # Hetzner-Overlay
├── .env.example
├── pyproject.toml               # Backend-Workspace (uv)
├── package.json                 # Frontend-Workspace (pnpm)
├── pnpm-workspace.yaml
│
├── services/                    # Backend, Python
│   ├── auth/
│   ├── chat-gateway/
│   ├── voice-signaling/         # Etappe 2
│   ├── media-svc/               # Etappe 4
│   └── mediamtx-auth-hook/      # Etappe 3
│       └── (wie in Vorgänger-Plan)
│
├── web/                         # SvelteKit 5 App
│   ├── package.json
│   ├── svelte.config.js
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── tsconfig.json
│   ├── src/
│   │   ├── app.html
│   │   ├── app.css
│   │   ├── lib/
│   │   │   ├── api/             # HTTP-Client (typed)
│   │   │   │   ├── auth.ts
│   │   │   │   ├── chat.ts
│   │   │   │   └── client.ts    # fetch-Wrapper mit JWT-Refresh
│   │   │   ├── ws/              # WebSocket-Client
│   │   │   │   ├── connection.ts
│   │   │   │   └── protocol.ts  # typed WS-Messages
│   │   │   ├── voice/           # Etappe 2
│   │   │   │   └── livekit.ts
│   │   │   ├── stream/          # Etappe 3
│   │   │   │   ├── whep.ts      # MediaMTX-Receive
│   │   │   │   └── gsr.ts       # localhost-Helper-Client
│   │   │   ├── stores/          # Svelte stores (Guilds, Channels, Messages)
│   │   │   ├── components/
│   │   │   │   ├── ChatView.svelte
│   │   │   │   ├── ChannelList.svelte
│   │   │   │   ├── GuildList.svelte
│   │   │   │   ├── MessageItem.svelte
│   │   │   │   └── MessageInput.svelte
│   │   │   └── platform/        # Tauri vs Browser detect
│   │   │       └── runtime.ts
│   │   └── routes/
│   │       ├── +layout.svelte
│   │       ├── +page.svelte             # Landing/Login
│   │       ├── login/+page.svelte
│   │       ├── register/+page.svelte
│   │       └── app/
│   │           ├── +layout.svelte       # Logged-in Shell
│   │           ├── +page.svelte         # Default Guild/Channel
│   │           └── guilds/[guildId]/channels/[channelId]/+page.svelte
│   ├── static/
│   └── tests/                   # Playwright E2E
│
├── desktop/                     # Electron-Wrapper (war Tauri — §17/E1)
│   ├── package.json             # @dcc/desktop — main: electron/dist/main.cjs; devDeps: electron, esbuild, @types/node
│   ├── tsconfig.json
│   └── electron/
│       ├── main.ts              # Main-Process: BrowserWindow, single-instance, store:* + gsr:* IPC
│       ├── preload.ts           # contextBridge → window.pulse.{platform,appVersion,store,gsr}
│       ├── sidecar.ts           # Python-GSR-Sidecar-Manager (child_process, newline-JSON)
│       ├── store.ts             # hand-rolled Settings-Store (<userData>/pulse-stream.json, chmod 600 auf Linux)
│       └── dist/                # esbuild-Output (gitignored): main.cjs, preload.cjs
│   # Prod: web/build/ wird via loadFile geladen (statischer SvelteKit-Build)
│
├── gsr-helper/                  # Python-Daemon, Linux-only
│   ├── pyproject.toml
│   ├── src/gsr_helper/
│   │   ├── main.py              # FastAPI-App auf 127.0.0.1:7878
│   │   ├── jwt_verify.py        # JWKS-Cache (gleicher Code wie chat-gateway)
│   │   ├── stream_runner.py     # importiert StreamController aus GSR-Repo
│   │   └── config.py            # ~/.config/discord-clone/gsr-helper.json
│   ├── tests/
│   └── packaging/
│       ├── systemd/gsr-helper.service.example
│       └── flatpak/             # optional, später
│
├── infra/
│   ├── caddy/Caddyfile
│   ├── postgres/init.sql
│   └── livekit/livekit.yaml     # Etappe 2
│
└── docs/
    ├── protocol.md              # WS-Message-Format
    ├── gsr-helper.md            # Helper-API + Sicherheits-Modell
    └── threat-model.md          # später
```

**GSR-Repo-Bindung:** `gsr-helper/pyproject.toml` enthält `gsr-streamer = { path = "../../GPU_Screen_Recorder", develop = true }` (editable install). So bleibt das GSR-Repo komplett unangetastet, wir importieren nur Klassen.

---

## 4. Datenmodell — Postgres-Schemas

Unverändert gegenüber Vorgänger-Plan (Web-Client braucht das gleiche Datenmodell wie ein nativer Client wäre):

### Schema `auth`
```sql
CREATE TABLE auth.users (
    id              BIGINT PRIMARY KEY,
    username        VARCHAR(32) NOT NULL UNIQUE,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    display_name    VARCHAR(64),
    avatar_url      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth.refresh_tokens (
    jti             UUID PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    user_agent      TEXT
);
CREATE INDEX ON auth.refresh_tokens(user_id) WHERE revoked_at IS NULL;
```

### Schema `chat`
```sql
CREATE TABLE chat.guilds (
    id              BIGINT PRIMARY KEY,
    name            VARCHAR(64) NOT NULL,
    icon_url        TEXT,
    owner_id        BIGINT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chat.channels (
    id              BIGINT PRIMARY KEY,
    guild_id        BIGINT NOT NULL REFERENCES chat.guilds(id) ON DELETE CASCADE,
    name            VARCHAR(64) NOT NULL,
    type            SMALLINT NOT NULL,            -- 0=text, 1=voice
    position        INT NOT NULL DEFAULT 0,
    topic           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON chat.channels(guild_id, position);

CREATE TABLE chat.guild_members (
    guild_id        BIGINT NOT NULL REFERENCES chat.guilds(id) ON DELETE CASCADE,
    user_id         BIGINT NOT NULL,
    nickname        VARCHAR(64),
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX ON chat.guild_members(user_id);

CREATE TABLE chat.messages (
    id              BIGINT PRIMARY KEY,
    channel_id      BIGINT NOT NULL REFERENCES chat.channels(id) ON DELETE CASCADE,
    author_id       BIGINT NOT NULL,
    content         TEXT NOT NULL,
    nonce           VARCHAR(64),
    edited_at       TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ
);
CREATE INDEX ON chat.messages(channel_id, id DESC);
```

**Snowflake-IDs:** 64-bit, Format `[ms-since-epoch:42][worker-id:10][seq:12]`. Mini-Library im Repo (`shared/snowflake.py` für Backend, `web/src/lib/snowflake.ts` für Client wenn nötig).

---

## 5. Service-Specs (Etappe 1)

### 5.1 auth-svc
Unverändert. Routes: `/register`, `/login`, `/refresh`, `/logout`, `/me`, `/.well-known/jwks.json`. JWT RS256, Access 15 min, Refresh 30d mit Rotation. Argon2id für Passwörter.

### 5.2 chat-gateway
Unverändert. REST: Guilds/Channels-CRUD + Message-History. WebSocket-Protokoll bleibt:

```jsonc
// Client → Server
{"op": "subscribe", "channel_id": "..."}
{"op": "unsubscribe", "channel_id": "..."}
{"op": "send", "channel_id": "...", "content": "hi", "nonce": "abc"}

// Server → Client
{"op": "ready", "user_id": "...", "guilds": [...]}
{"op": "message", "data": {message-dto}}
{"op": "message_ack", "nonce": "abc", "id": "..."}
{"op": "error", "code": ..., "msg": "..."}
```

WS-Auth: Access-Token als Query-Param (Browser-WebSocket-API kann keine Custom-Header). Token-Signatur sofort nach Accept geprüft, expired Tokens → close mit Code 4001.

Skalierung: mehrere Instanzen + Redis Pub/Sub für Fan-out. Sticky-by-Hash via Caddy.

---

## 6. Web-App — Etappe 1 (Detail-Spec)

### 6.1 Routes (SvelteKit)
| Route | Beschreibung |
|---|---|
| `/` | Landing, redirect zu `/app` wenn eingeloggt sonst `/login` |
| `/login` | Email + Password |
| `/register` | Username + Email + Password + Display-Name |
| `/app` | Logged-in Shell mit 3-Spalten-Layout |
| `/app/guilds/[guildId]/channels/[channelId]` | Aktiver Channel |

### 6.2 State-Management (Svelte 5 Runes)
- `$state` für lokalen Component-State
- `$derived` für berechnete Werte
- Globale Stores in `lib/stores/` als `.svelte.ts`-Module mit Runes
- Keine externe State-Library (Zustand, Pinia) nötig — Runes reichen

```ts
// lib/stores/messages.svelte.ts (Beispiel)
class MessageStore {
  byChannel = $state<Record<string, Message[]>>({});
  
  add(channelId: string, msg: Message) {
    if (!this.byChannel[channelId]) this.byChannel[channelId] = [];
    if (this.byChannel[channelId].some(m => m.id === msg.id)) return; // dedup
    this.byChannel[channelId].push(msg);
  }
}
export const messages = new MessageStore();
```

### 6.3 WebSocket-Client
- Single Singleton, lebt im `+layout.svelte` der `/app`-Route
- Auto-Reconnect mit exponentiellem Backoff (1s, 2s, 5s, 10s, 30s max)
- Token-Refresh: vor Connect immer prüfen ob Access expired → silent refresh via `/refresh`
- Schreibt Empfangenes in die Stores
- Sendet `subscribe`/`unsubscribe` bei Channel-Wechsel

### 6.4 UI-Layout
- Mobile-First-Tailwind, aber primär Desktop:
- **Sidebar links:** Guild-Icons (vertikale Spalte), 72px breit
- **Sidebar mitte:** Channel-Liste des aktiven Guilds, 240px
- **Main:** Chat-View mit Message-List (virtualisiert via `svelte-virtual` falls > 1000 Messages) + Input-Bar unten
- Dark-Mode Default (Discord-Konvention), Tailwind `dark:`-Klassen

### 6.5 Virtualisierung
Wenn Channel mehr als ~100 Messages: `svelte-virtual` für scrollable Liste. Sonst native Scroll. Performance-Test mit 10k Messages als Verify-Step.

### 6.6 Token-Storage
- **Im Browser:** `localStorage` für Access (kurzlebig, OK), `httpOnly`-Cookie wäre besser für Refresh, aber dann braucht's Server-rendered Auth-Routes — pragmatisch: Refresh auch in `localStorage` + CSRF-Schutz nicht relevant für API mit Bearer-Auth
- **In der Electron-App:** aktuell ebenfalls `localStorage` (funktioniert im Renderer); könnte später auf `window.pulse.store.*` (Settings-Store, `<userData>/pulse-stream.json`, chmod 600 auf Linux) umgestellt werden — siehe `web/src/lib/api/storage.ts` + §17/E1c
- `web/src/lib/api/storage.ts` + `platform/runtime.ts` abstrahieren das

---

## 7. Desktop-Wrapper — ursprünglicher Tauri-Entwurf (obsolet)

> **→ Obsolet (2026-05-12).** Der Desktop-Wrapper ist **Electron**, nicht Tauri —
> siehe §17 ("Wrapper-Pivot"). Tauris Linux-WebKitGTK-WebRTC war zu unzuverlässig
> für LiveKit-Voice. `desktop/src-tauri/` + alle `@tauri-apps/*`-Deps wurden in E1c
> entfernt. Der Abschnitt unten bleibt nur als historischer Entwurf stehen.

### Build-Flow
1. `pnpm build` in `/web` erzeugt `web/build/` (statisches Asset-Verzeichnis)
2. `tauri.conf.json` zeigt `frontendDist` auf `../web/build`
3. `cargo tauri build` erzeugt:
   - Linux: `.AppImage`, `.deb`, `.rpm`
   - Windows: `.msi`, `.exe` (NSIS)
   - macOS: `.dmg`, `.app`

### Tauri-Plugins (alle aus `@tauri-apps/plugin-*`)
| Plugin | Wofür |
|---|---|
| `global-shortcut` | Push-to-Talk: register `Alt+Space` (default), löst Event aus, Web-Code hört zu |
| `notification` | "Du wurdest in #channel gepingt" |
| `autostart` | Optional, Start-with-OS in Settings |
| `store` | Settings-Persistenz (Servers, Theme, PTT-Key) |
| `single-instance` | Doppelklick öffnet nicht zwei Fenster |

### PTT-Pattern
1. Rust-Side registriert globalen Shortcut beim Start
2. On-Press: `app.emit("ptt-down", ())`, on-Release: `app.emit("ptt-up", ())`
3. Web-Code (Svelte) hört auf diese Events via `@tauri-apps/api/event`
4. LiveKit `localParticipant.setMicrophoneEnabled(true/false)`

### Browser-Fallback
- In reinem Browser (kein Tauri): PTT via Browser-Keyboard-Event, nur wenn Tab fokussiert
- Erkennung via `platform/runtime.ts`: `if ('__TAURI_INTERNALS__' in window) ...`

### Capabilities (Tauri 2 Security)
Striktes Permission-Model. Standard-Capability erlaubt nur was wir brauchen:
- `core:default`, `notification:default`, `global-shortcut:default`, `store:default`
- Keine FS-Permissions außer im Settings-Pfad
- Keine Shell-Permissions

---

## 8. GSR-Helper-Daemon (Etappe 3)

> **Überholt durch §17 (2026-05-11, Wrapper-Pivot 2026-05-12).** Statt eines eigenständigen Localhost-FastAPI-Daemons (der für den *reinen-Browser*-Fall gedacht war) wird die GSR-Funktionalität direkt in die Desktop-App integriert: der Electron-Main spawnt einen Python-Sidecar (`gsr-sidecar`, reused `profiles.py`/`stream_controller.py`), Kommunikation per stdio (newline-JSON). Das ganze GSR-Build-Paket (Custom-FFmpeg mit NVENC+VAAPI+QSV, gepatchter GSR) wird in *eine* Electron-Flatpak gebundled. Details: §17. Der Abschnitt unten bleibt als Referenz für die Daemon-Variante, falls reiner-Browser-Support später doch gewünscht ist.

**Zweck:** Linux-User mit installiertem GSR + diesem Helper bekommen einen "Stream in HQ via GPU"-Button in der Web-App, der einen NVENC/VAAPI-Stream startet. Alle anderen User nutzen `getDisplayMedia` via Browser.

### API (FastAPI auf 127.0.0.1:7878)

| Method | Path | Beschreibung |
|---|---|---|
| GET | `/health` | `{version, gsr_available: bool, codecs: [...]}` — kein Auth |
| POST | `/stream/start` | `{channel_id, token, profile_id}` → startet GSR-QProcess |
| POST | `/stream/stop` | Stoppt aktiven Stream |
| GET | `/stream/state` | Aktueller Zustand (running, fps, bitrate) |
| WS | `/stream/events` | Live-Events (state_changed, fps_changed, error) |

### Sicherheit (kritisch!)
**Problem:** Ein Daemon auf localhost ist von **jeder Webseite** im selben Browser erreichbar. Schutz auf mehreren Ebenen:

1. **CORS strikt:** Nur die Origin des Discord-Backends erlaubt (`https://chat.example.com`). Default-Browser-CORS verhindert dann Requests von anderen Seiten.
2. **JWT-Pflicht:** Jeder Request braucht `Authorization: Bearer <jwt>` vom Discord-auth-svc. Helper holt JWKS beim Start und cached. Ungültige Tokens → 401.
3. **User-Binding:** Helper merkt sich beim ersten Start die `user_id` aus dem ersten gültigen JWT in `~/.config/discord-clone/gsr-helper.json`. Spätere Tokens müssen die **gleiche** `user_id` haben — verhindert dass ein anderer User auf dem gleichen System den Helper missbraucht.
4. **Reset-Button:** Helper hat einen CLI-Befehl `gsr-helper reset` der die gebundene `user_id` löscht.

### Detection im Web-Client
```ts
// web/src/lib/stream/gsr.ts
export async function detectGsrHelper(): Promise<boolean> {
  try {
    const r = await fetch('http://127.0.0.1:7878/health', { 
      signal: AbortSignal.timeout(500) 
    });
    return r.ok;
  } catch { return false; }
}
```
Wenn `true` → "HQ-Stream via GSR" als Option anbieten neben "Browser-Stream".

### Integration mit existierendem Code
`gsr-helper/src/gsr_helper/stream_runner.py`:
```python
# pseudocode
import sys
sys.path.insert(0, '/path/to/GPU_Screen_Recorder/ui')
from stream_controller import StreamController
from profiles import ServerProfile

profile = ServerProfile.from_channel(channel_id, stream_token, mediamtx_endpoint)
controller = StreamController(profile)
controller.start()
```

**Adapter-Aufwand in GSR-Repo:** Nur die Factory `ServerProfile.from_channel()` in `ui/profiles.py` neu (~20 Zeilen). Alles andere bleibt unangetastet.

### Distribution
- Eigenständiges Python-Paket
- Installation: `pipx install gsr-helper` oder Flatpak später
- Systemd-User-Service-Beispiel im `packaging/`-Ordner
- Optional: Tauri-Bundle könnte den Helper mitliefern wenn auf Linux (Etappe 4+)

---

## 9. Docker-Compose (Etappe 1)

```yaml
# docker-compose.yml — Dev
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: dcc
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: dcc
    volumes: ["pgdata:/var/lib/postgresql/data"]
    ports: ["5432:5432"]

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  auth:
    build: ./services/auth
    environment:
      DATABASE_URL: postgresql+asyncpg://dcc:${POSTGRES_PASSWORD}@postgres/dcc
      JWT_PRIVATE_KEY_FILE: /run/secrets/jwt_private
      JWT_PUBLIC_KEY_FILE: /run/secrets/jwt_public
    secrets: [jwt_private, jwt_public]
    depends_on: [postgres]
    ports: ["8001:8000"]

  chat-gateway:
    build: ./services/chat-gateway
    environment:
      DATABASE_URL: postgresql+asyncpg://dcc:${POSTGRES_PASSWORD}@postgres/dcc
      REDIS_URL: redis://redis:6379/0
      AUTH_JWKS_URL: http://auth:8000/.well-known/jwks.json
    depends_on: [postgres, redis, auth]
    ports: ["8002:8000"]

  caddy:
    image: caddy:2-alpine
    volumes:
      - ./infra/caddy/Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
    ports: ["80:80", "443:443"]
    depends_on: [auth, chat-gateway]

secrets:
  jwt_private: { file: ./secrets/jwt_private.pem }
  jwt_public:  { file: ./secrets/jwt_public.pem }

volumes:
  pgdata:
  caddy_data:
```

**Web-Dev läuft separat:** `cd web && pnpm dev` startet Vite auf `:5173`, spricht via CORS gegen das Backend auf `:80`.

**Prod-Overlay** fügt LiveKit, MinIO, voice-signaling, media-svc, mediamtx-auth-hook hinzu (Etappen 2-4). Web-App wird als statisches Asset von Caddy gesserviert.

---

## 10. Etappen-Plan (konkrete Tickets)

### Etappe 1 — Fundament (Tag 1-4)
1. Repo-Skelett mit Monorepo-Setup: `pyproject.toml` (uv-Workspace), `package.json` + `pnpm-workspace.yaml`, `.gitignore`, `secrets/`
2. JWT-Keypair generieren (`openssl genpkey -algorithm RSA ...`), `secrets/` chmod 700
3. `docker-compose.yml` mit Postgres + Redis bauen, lokal hochfahren, manuell verifizieren
4. `shared/snowflake.py` schreiben + Unit-Tests
5. **auth-svc:** Models, Alembic-Migration, Register/Login/Refresh, JWKS-Endpoint, Tests
6. **chat-gateway:** Models, Migration, REST-Routes (Guilds/Channels), JWKS-Verify-Middleware, Tests
7. **chat-gateway:** WS-Handler, Pub/Sub, Protocol-Tests mit 2 Test-Clients (pytest)
8. Caddy-Config + lokales Hostsfile-Setup (`dcc.local`)
9. **Web:** SvelteKit-Skelett, TailwindCSS, TypeScript-Strict
10. **Web:** Auth-Pages (Login/Register), Token-Storage-Abstraktion, fetch-Wrapper mit Auto-Refresh
11. **Web:** Main-Shell-Layout (3 Spalten leer), Routing
12. **Web:** Guild/Channel-Listen laden + rendern
13. **Web:** WS-Client (auto-reconnect), Chat-View, Send-Roundtrip, Message-Store mit Dedup
14. **E2E-Smoke-Test:** zwei Browser-Tabs, zwei User, gleicher Channel, Roundtrip
15. **Playwright-E2E-Test:** Register → Login → Channel-Create → Message-Send → in zweitem Browser sichtbar

**Verify-Schritt am Ende:** Agent spawnen, der den End-to-End-Flow durchspielt und Bugs/Edge-Cases meldet.

### Etappe 2 — Voice (Tag 5-7)
- LiveKit-Container in Compose (`livekit/livekit-server`, `livekit.yaml`)
- **voice-signaling-svc:** Token-Issue mit `livekit-api`, Webhook-Receiver für Join/Leave, State in Redis
- **Web:** `livekit-client` integrieren, Voice-Channel-Join-Flow, Mic-Capture-Permission
- **Web:** Voice-Channel-UI (Teilnehmerliste mit Speaking-Indicator)
- AEC/NS: LiveKit-Defaults nutzen (libwebrtc unter der Haube)
- PTT (vorerst Browser-Hotkey via `document.addEventListener('keydown')`)
- Verify: 3 Browser-Tabs in einem Voice-Channel, alle hören sich

### Etappe 3 — Streaming (Tag 8-10)
- **Web:** Browser-Screen-Share via `getDisplayMedia` + LiveKit-Screen-Track publish
- **Web:** Screen-Receive via LiveKit-Subscription-API (kein WHEP nötig wenn LiveKit-internal)
- **mediamtx-auth-hook-svc:** HTTP-Endpoint, prüft Stream-Tokens + Channel-Membership
- MediaMTX-Config-Template anpassen (eigenes Template, nicht das im GSR-Repo)
- **gsr-helper:** FastAPI-App auf 127.0.0.1:7878, JWT-Verify, User-Binding, GSR-Start via Library-Import
- **GSR-Repo:** Factory `ServerProfile.from_channel()` in `ui/profiles.py` (einziger Eingriff!)
- **Web:** `lib/stream/gsr.ts` — Helper-Detection + UI für "HQ-Stream"-Button (nur Linux + Helper installiert)
- **Web:** WHEP-Player für MediaMTX-Streams (zum Empfangen von GSR-Streams)
- Verify: Linux-User mit GSR-Helper streamt HQ, Windows-User streamt Browser, beide werden von einem dritten User in gleichem Voice-Channel gesehen

### Etappe 4 — Polish + Desktop-Bundle (Tag 11-13)
> Desktop-Wrapper-Details siehe §17 (E1 = Electron-Migration, T6 = Electron-Flatpak).
- **Desktop-Wrapper:** `desktop/` als Electron-App (`electron/{main,preload,sidecar,store}.ts`) — siehe §17/E1
- Globaler PTT (system-weiter Hotkey) — braucht ein natives Key-Listener-Modul (z.B. `uiohook-napi`); Electrons `globalShortcut` kann kein Press+Release. In-Window-PTT ist da.
- Notifications + Tray-Icon
- **Bundle-Build:** primär Linux-Flatpak (`electron-builder`, §17/T6); Windows/macOS-Bundles sind Kür
- **media-svc + MinIO:** Presigned-URLs, File-Upload im Web-Client (Drag&Drop)
- Reactions, Mentions, Edits/Deletes
- Presence (online/offline/idle/speaking/streaming) — Redis-basiert
- E2E-Tests mit Playwright durch alle drei Bundle-Plattformen (via CI)

### Etappe 5 — Optional / Später
- E2EE für DMs (Signal-Protocol via WASM-Bindings, `libsignal-protocol-typescript`)
- ✅ **Roles + Permissions** (2026-05-18, voll-Discord-Scope) — Bitfield (`dcc_shared/permissions.py`, 23 Bits in 52-Bit-Budget mit reservierten Lücken), Resolver mit Discord-Formel + `!VIEW_CHANNEL→revoke_all`-Invariante, Anti-Escalation (Stoatchat-Pattern), Channel-Overwrites (Allow/Deny pro Bit), Per-WS-Permission-Cache mit Event-Invalidation, Visibility-Filter im Broadcast (Private Channels), Owner-Transfer-Endpoint, TS-Resolver-Port + Settings-Modal mit Rollen-/Members-/Eigentümerschaft-Tabs, Channel-Permissions-Page, Drag-Drop + Touch-Reorder, Member-List Role-Color + Hoist-Gruppierung. Stoatchat `crates/permissions/` als Vorlage gelesen. Migration 0009 + bulk `GET /guilds/{id}/member-roles` Endpoint.
- Push-Notifications via Web-Push + Service-Worker (für mobile PWA)
- AppStore-Distribution (Snap, Flathub, Microsoft Store, optional)
- Mobile-PWA-Polish + Touch-UI

---

## 11. Sicherheit

- **Passwort-Hashing:** Argon2id, t=3, m=64MB, p=4
- **JWT:** RS256, JWKS für Service-zu-Service-Validation
- **WS-Auth:** Token in Query-Param (Browser-Limit), HTTPS-only
- **Rate-Limiting:** `slowapi` in auth-svc, pro-WS-Connection in chat-gateway
- **CORS:** Strikt — nur Discord-Backend-Origin in Production, `localhost:5173` zusätzlich in Dev
- **Stream-Keys:** kurzlebige JWTs pro Channel, NIE im Repo
- **GSR-Helper-Sicherheit:** entfällt (kein Localhost-Daemon — der Electron-Main spawnt den Sidecar direkt, stdio; siehe §17)
- **Electron-Hardening:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; Renderer↔Main nur über das Preload-`contextBridge` (`window.pulse.*`); Settings-Store-Datei auf Linux `chmod 600`
- **Content Security Policy:** strikt im Web (Caddy-Header); in der Electron-App lädt der Renderer nur unsere eigenen Assets (`web/build/` bzw. Vite-Dev)
- **Secrets:** `secrets/`-Verzeichnis in `.gitignore`, `.env.example` als Template

---

## 12. Anti-Patterns (bewusst NICHT machen)

- ❌ Matrix/Revolt-als-Backend (Datenmodell-Mismatch). **Revolt heißt seit Okt 2025 Stoatchat** — als Mining-Quelle ja, als Dependency nein.
- ❌ Spacebar/Fosscord (lockt an Discord-API-Wire-Format)
- ❌ Supabase/Pocketbase als Backend-Ersatz (Stack-Bruch, kein Python)
- ❌ **Zurück zu Tauri** für den Desktop-Wrapper (WebKitGTK-WebRTC auf Linux zu unzuverlässig für LiveKit-Voice — Pivot 2026-05-12 → Electron, §17). Größeres Bundle ist der akzeptierte Trade-off.
- ❌ `electron-store` als Dep (ESM-only in neueren Versionen → CJS/ESM-Friktion mit dem esbuild-CJS-Bundle; der hand-rolled Store in `desktop/electron/store.ts` reicht)
- ❌ React Native für Mobile (Web-PWA reicht)
- ❌ Existierende GSR-Files anfassen außer `ui/profiles.py`
- ❌ Shared DB-Tabellen zwischen Services
- ❌ HS256 JWT
- ❌ GSR-Helper ohne Auth/CORS auf localhost
- ❌ Mumble-Voice (`pymumble` tot)
- ❌ Re-Publishing MediaMTX→LiveKit (Transcoding-Stage zu teuer)
- ❌ Exactly-once-Delivery anstreben
- ❌ State-Library wie Redux/Zustand neben Svelte-Runes
- ❌ CSS-in-JS (Tailwind ist genug)
- ❌ Service-Worker im MVP (komplex, später für PWA)
- ❌ **`fastapi-users` als Dependency** (Maintenance-Mode 2026, nur Source als Referenz)
- ❌ **`broadcaster` / `fastapi-socketio` / `fastapi_websocket_pubsub`** (alle archiviert/inaktiv → Eigenbau)
- ❌ **`casbin` / `oso`** für Permissions (Overkill für Bitfield → IntFlag-Eigenbau hat seit 2026-05-18 ~600 LOC mit Resolver + Anti-Escalation; siehe §10 Etappe 5)
- ❌ **`@livekit/krisp-noise-filter`** (kostet seit 2026-05-01 → `@jitsi/rnnoise-wasm` als Free-Ersatz)
- ❌ **`svelte-french-toast`** (Sv5-inaktiv → `svelte-sonner`)
- ❌ **`svelte-markdown`** blind nutzen (kein eingebauter Sanitizer → `marked` + `DOMPurify` manuell)
- ❌ **React-Bridge in SvelteKit** für LiveKit-React-Components (Reactivity-Mismatch, Bundle-Bloat)

---

## 12.1 Code-Größen-Policy

Damit Module review-freundlich, modular und für autonome Agent-Läufe effizient
editierbar bleiben:

| Datei-Typ | Ziel | Harte Grenze | Bei Überschreitung |
|---|---|---|---|
| Source-Dateien (Routes, Services, Stores, Lib-Module) | ≤ 350 Zeilen | 500 Zeilen | In APIRouter-Module / Sub-Module aufteilen |
| Svelte-Components (`.svelte`) | ≤ 250 Zeilen | — | Sub-Component rausziehen |

**Ausgenommen** (keine Grenze):
- Tests (`tests/`, `*.spec.ts`, `test_*.py`)
- Alembic-Migrationen (`alembic/versions/`)
- Generierter / Vendor-Code (`web/src/lib/components/ui/` — shadcn-svelte-Copy-Paste)
- Lockfiles, generierte Schemas

**Regeln:**
- Bei autonomen Agent-Läufen ist die Policy einzuhalten — im Zweifel **splitten statt wachsen lassen**.
- Eine neue Route-Gruppe bekommt ein eigenes Modul unter `routes/`, nicht einen Anhang an ein bestehendes.
- Geteilte Helper kommen in ein `_deps.py` / `_helpers.ts`, nicht dupliziert.

**Grund:** Modularität, Review-Freundlichkeit, effizientes Agent-Editing (kleine Dateien =
weniger Kontext pro Edit, weniger Merge-Konflikte).

Referenz-Umsetzung: `services/chat-gateway/src/dcc_chat_gateway/routes/` ist in
`guilds.py` / `channels.py` / `messages.py` / `ws.py` / `_deps.py` aufgeteilt
(vorher eine 373-Zeilen-`routes.py`).

---

## 13. Offene Punkte vor Implementierungsstart

1. **Projektname final?** `discord-clone` ist Platzhalter. Vorschläge: `comlink`, `voxhub`, `kanal`, `zwiegespraech`, `kollektiv`.
2. **Backend-Workspace:** uv (empfohlen, 2026 sehr ausgereift, Workspaces stabil) — Bestätigung erwünscht.
3. **Frontend-Workspace:** pnpm (de-facto Standard für Monorepos) — Bestätigung erwünscht.
4. **Logging:** structlog + JSON für Backend, im Dev Pretty-Print. Frontend: nichts Extra, `console.*` reicht initial.
5. **CI:** GitHub Actions oder schon Eigenes? Vorerst lokal-only, CI in Etappe 4+.
6. **Domain:** Hetzner-Server hat schon eine? Brauchen wir ein TLS-Zertifikat via Caddy + Let's Encrypt — DNS-Record vor Etappe 1 nötig.

---

## 14. Tag-1-Checkliste (morgen früh)

### Tooling installieren
- [ ] `node` (≥20) + `pnpm 9` (`sudo pacman -S nodejs pnpm` auf CachyOS)
- [ ] `uv` installieren (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
- [ ] Rust + Tauri-CLI (`rustup-init`, dann `cargo install create-tauri-app tauri-cli@^2`) — für Etappe 4, aber Setup gleich mit

### Repo-Skelett aus Templates
- [ ] **`alysonhower/tauri2-svelte5-shadcn` forken** (eigener GitHub-Account) ODER `git clone` + `git remote remove origin` für lokales Spielen — bringt Tauri 2 + Svelte 5 + shadcn-svelte + CI fertig konfiguriert
- [ ] Im geforkten Repo: `web/` und `desktop/` so umstrukturieren wie in Section 3 — falls Template anders strukturiert, anpassen
- [ ] `full-stack-fastapi-template` **separat** clonen unter `/tmp/ref-fastapi-template`, nur Tooling-Files referenzieren (Alembic-Setup, Docker-Compose-Patterns, CI-Workflows) — **nicht direkt mergen**
- [ ] Hinzufügen zum Web-Setup: Tailwind v4, `@vite-pwa/sveltekit` (im Template fehlend)
- [ ] `services/`-Verzeichnis manuell aufbauen (Template ist nur Frontend)
- [ ] `gsr-helper/`-Verzeichnis-Skelett anlegen (Etappe 3, aber Struktur jetzt)

### Versionen pinnen
- [ ] Aktuelle Versionen ermitteln:
  - Backend: `pip index versions fastapi sqlalchemy asyncpg pyjwt argon2-cffi redis livekit-api snowflake-id-toolkit minio slowapi structlog`
  - Web: `pnpm view <pkg> version` für alle Libs aus Section 2 Web-App-Tabelle
  - Rust: `cargo info tauri tauri-plugin-global-shortcut tauri-plugin-notification`
- [ ] Alle gepinneten Versionen in projektlokale `CLAUDE.md` schreiben (Pattern wie im GSR-Repo)

### Initial-Setup
- [ ] `git init` als **separates Repo** (NICHT in GSR-Repo) — neuer GitHub-Remote (privat empfohlen)
- [ ] JWT-Keypair generieren (`openssl genpkey -algorithm RSA -out secrets/jwt_private.pem -pkeyopt rsa_keygen_bits:2048` + `openssl rsa -in secrets/jwt_private.pem -pubout -out secrets/jwt_public.pem`)
- [ ] `secrets/` chmod 700, in `.gitignore`
- [ ] `.env.example` mit allen ENV-Variablen schreiben (POSTGRES_PASSWORD, JWT_*, REDIS_URL etc.)
- [ ] Compose-Skelett bauen, Postgres + Redis hochfahren, mit `psql` und `redis-cli` testen
- [ ] auth-svc Hello-World-Endpoint laufen lassen, mit `curl` testen

### Mining-Lektüre (parallel, ~30 Min)
- [ ] `git clone https://github.com/stoatchat/stoatchat /tmp/stoatchat-ref` — vor Etappe 1 das `crates/permissions/`-Modul lesen, vor Etappe 2 die LiveKit-Integration in `crates/api/src/routes/voice/`
- [ ] Discord-API-Docs Bookmark: `https://docs.discord.com/developers/topics/voice-connections` (für Etappe 2)
- [ ] Mattermost Permission-Doc Bookmark: `https://docs.mattermost.com/administration-guide/onboard/advanced-permissions-backend-infrastructure.html` (Pattern für `check_permission()`)

### Stop & Verify
- [ ] **Pause** bevor wir weiter bauen — Plan-Agent + Verify-Agent fürs Repo-Skelett spawnen, dann erst zu Etappe 1, Schritt 1

---

## 15. Verifikations-Regel (für jede Implementierungs-Session)

Nach jedem Etappen-Schritt:
1. Tests laufen lassen
   - Backend: `pytest` pro Service
   - Web: `pnpm test` (Vitest für Units) + `pnpm test:e2e` (Playwright) wo sinnvoll
2. Verify-Agent spawnen (Sonnet), der:
   - das gerade Gebaute manuell durchspielt
   - Edge-Cases prüft (leere Inputs, große Payloads, Reconnect, Token-Expiry)
   - Bugs/Inkonsistenzen meldet
3. Bei Bugs: fixen, dann nochmal verifizieren
4. Erst dann nächster Schritt

**Team-Regel aus globaler CLAUDE.md:** Bei jedem Code-Schritt ein Team starten (Plan-Agent + Verify-Agent).

---

## 16. Inspirations-Quellen (mining, nicht kopieren)

Drei Open-Source-Projekte, die wir vor den jeweiligen Etappen lesen:

### 16.1 Stoatchat (ehemals Revolt) — Haupt-Mining-Quelle
- **Repo:** [`stoatchat/stoatchat`](https://github.com/stoatchat/stoatchat)
- **Was es ist:** Discord-Klon in Rust, Frontend SolidJS, Backend MongoDB + Redis + MinIO + RabbitMQ. **Voice via LiveKit seit Feb 2026** — quasi unser Stack-Zwilling.
- **Wichtig:** Wurde **am 1. Oktober 2025 rebrandet** von Revolt nach Cease-and-Desist. Alte `revoltchat`-Org liegt jetzt unter `stoatchat`.
- **Vor Etappe 1 lesen:** `crates/database/src/models/` — Datenmodell Servers/Channels/Members/Roles (1:1-Discord-Semantik)
- **Vor Etappe 1 lesen:** `crates/permissions/` — Bitfield-Permissions mit Channel-Overwrites (Issue #291 dort offen, wo sie selbst Verbesserungen diskutieren — auch lehrreich)
- **Vor Etappe 2 lesen:** `crates/api/src/routes/voice/` — LiveKit-Integration, ganz frisch und direkt portierbar nach Python
- **Architektur-Pattern mitnehmen:** Redis-Pub/Sub für WebSocket-Fanout (deren Pattern → FastAPI übersetzen)

### 16.2 Discord API Docs — Voice-Spezifikation
- **URL:** [docs.discord.com/developers/topics/voice-connections](https://docs.discord.com/developers/topics/voice-connections)
- **Mirror-URL (oft besser dokumentiert):** [docs.discord.food/topics/voice-connections](https://docs.discord.food/topics/voice-connections)
- **Wofür:** Voice-Opcodes (0-5), IP-Discovery-Algorithmus für UDP-Hole-Punching, Speaking-Indicator-SSRC-Protocol (Opcode 5 mit grünem Ring um Avatar)
- **Wann lesen:** Vor Etappe 2 (Voice-Implementation). Wir nutzen LiveKit für die Wire-Implementation, aber Discord's Semantik für die UI-Patterns (Speaking-Indicator, Voice-State-Synchronisation).

### 16.3 Mattermost — Permission-Architektur
- **URL:** [docs.mattermost.com/administration-guide/onboard/advanced-permissions-backend-infrastructure.html](https://docs.mattermost.com/administration-guide/onboard/advanced-permissions-backend-infrastructure.html)
- **Wofür:** 3-Scope-Permission-Modell (System → Team → Channel) mit Kaskadierung. State-of-the-Art-RBAC-Pattern, ABAC seit 2025.
- **Mining:** Pseudocode-Vorlage für unseren `check_permission(user, channel, action)`-Helper. Discord's Formel `final = (base & ~deny) | allow` aus `discord.py` ist die Berechnungs-Basis, Mattermost's Scope-Kaskadierung die Strukturvorlage.

### 16.4 fastapi-users Source — Auth-Flow-Referenz (nicht als Dependency!)
- **Repo:** [`fastapi-users/fastapi-users`](https://github.com/fastapi-users/fastapi-users)
- **Achtung:** 2026 in Maintenance-Mode — nicht als Dependency, nur Source als Referenz lesen
- **Wofür:** Password-Reset-Token-Flow (kurzlebiges JWT mit limitiertem Scope), JWT-Strategy (siehe PR #943 für RS256), OAuth-Social-Patterns (für später)

### 16.5 UI-Layout-Vorlagen
- [`issam-seghir/discord-clone`](https://github.com/issam-seghir/discord-clone) — Next.js + Socket.io + **LiveKit** + Prisma. **Identischer Voice-Stack wie unserer.** Layout-Hierarchie und LiveKit-React-Hooks-Patterns nach Svelte-Runes übersetzen.
- [`SashenJayathilaka/Discord-Clone`](https://github.com/SashenJayathilaka/Discord-Clone) — bestes Server/Channel/Sidebar-Layout, Tailwind, TypeScript. Reine Component-Hierarchie-Vorlage.
- [`rcb123/sveltcord`](https://github.com/rcb123/sveltcord) — einziger SvelteKit-Discord-Klon. Klein, aber Stack-Match.
- [`ItsMeBrianD/LiveKit-Svelte-Exploration`](https://github.com/ItsMeBrianD/LiveKit-Svelte-Exploration) — SvelteKit + LiveKit + Tailwind VOIP-Demo, Pattern für Track-Subscription via Svelte 5 Runes (`$state` statt React-Hooks).

### 16.6 Lese-Reihenfolge
| Wann | Was | Dauer |
|---|---|---|
| Vor Etappe 1 | Stoatchat `crates/database/src/models/` + `crates/permissions/` | ~45 Min |
| Vor Etappe 1 | `full-stack-fastapi-template` Skeleton scannen | ~15 Min |
| Vor Etappe 2 | Discord-API-Doku Voice-Section | ~30 Min |
| Vor Etappe 2 | Stoatchat `crates/api/src/routes/voice/` | ~30 Min |
| Vor Etappe 2 | `issam-seghir/discord-clone` UI-Patterns | ~30 Min |
| Vor Etappe 4 (Roles) | Mattermost-Permission-Doc | ~20 Min |

---

## 17. GSR↔Desktop-Integration — Etappenplan (beschlossen 2026-05-11, Desktop-Wrapper auf Electron 2026-05-12)

Kontext: der GSR-Streamer (`~/Dokumente/GPU_Screen_Recorder/`) existiert und funktioniert end-to-end. Statt ihn als externen Daemon anzusprechen, ziehen wir die Funktionalität in die Pulse-Desktop-App und liefern am Ende **eine Flatpak** aus, die das komplette GSR-Build-Paket mitbringt.

**Desktop-Wrapper = Electron** (entschieden 2026-05-12). Das Projekt wird ein kommerzielles Produkt; Voice ist Kern-Feature. Tauri nutzt auf Linux WebKitGTK, dessen WebRTC ist zu unzuverlässig für LiveKit — Voice lief im Tauri-Fenster nicht. Electron liefert Chromium auf allen OS, WebRTC out-of-the-box. Die ursprünglich geplanten Etappen **T1** (Tauri-Shell) und **T3a** (Tauri↔Sidecar-Bridge in Rust) wurden durch **E1** ersetzt; **T2** (Python-Sidecar), **T3b** (Streaming-UI-Components in Svelte), **T4/T5** und **T6** (jetzt Electron-Flatpak statt Tauri-Bundle) bleiben gültig. Die alten T1/T3a-Beschreibungen sind gestrichen.

### E1 — Electron-Migration (kanonischer Stand)
- **E1a — Electron-Shell:** `desktop/` ist eine Electron-App: `electron/main.ts` (BrowserWindow lädt den SvelteKit-Build via `loadFile` bzw. `:5173` in Dev via `loadURL`; `requestSingleInstanceLock` + `second-instance`→focus; `whenReady`: `initStore()`→`wireStore()`→`wireSidecar()`→`createWindow()`; `before-quit`→Sidecar-Shutdown; `webPreferences`: `preload` + `contextIsolation:true` + `nodeIntegration:false` + `sandbox:true`), `electron/preload.ts` (`contextBridge.exposeInMainWorld('pulse', { platform:'electron', appVersion, store:{get,getAll,set}, gsr:{...} })`), Build via **esbuild** (`build:electron` — `--bundle --platform=node --format=cjs --target=node22 --external:electron`; zieht `sidecar.ts` + `store.ts` automatisch mit rein) → `electron/dist/{main,preload}.cjs`. `package.json` ohne `"type":"module"` (Main als CJS). Packaging = T6 (`electron-builder`). Frontend: `web/src/lib/platform/runtime.ts` → `isElectron()` (`window.pulse?.platform === 'electron'`).
- **E1b — Sidecar-Bridge in Node:** `desktop/electron/sidecar.ts` — `SidecarManager` (Singleton): `child_process.spawn('python3', ['streaming/gsr-sidecar/control.py'])` **lazy** beim ersten `call()`, Path-Resolver (`$PULSE_SIDECAR_PY` → walk-up nach `streaming/gsr-sidecar/control.py` → Flatpak-Default), zeilenweises `readline` auf stdout, `{"id":..}`-Responses an wartende Promises routen (numerische IDs, Map id→{resolve,reject,timer}), `{"ev":..}`-Events an den von `main.ts` registrierten Callback (→ `webContents.send('gsr:event', ev)`), stderr→`console.error` mit `[gsr-sidecar]`-Prefix, `shutdown()` (stdin schließen → 1,5 s Grace → SIGTERM → 2 s → SIGKILL). `main.ts` registriert `ipcMain.handle('gsr:call', (op, params) → getSidecar().call(op, params))` (catch-all → `{ok:false,error}`). Preload exponiert `window.pulse.gsr.{health,gpuInfo,listMonitors,listProfiles,listApplicationAudio,buildArgv,start,stop,state,onEvent}` (jedes ein dünner `ipcRenderer.invoke('gsr:call', op, params)`; `onEvent` registriert `ipcRenderer.on('gsr:event', …)` und gibt eine Unsubscribe-Fn zurück). Frontend `web/src/lib/stream/gsr.ts` + `state.svelte.ts` reden über `window.pulse.gsr.*` (signatur-identisch zu früher, nur anderer Transport). Dev-Route `/app/dev/stream` ist der E2E-Check. Der Python-Sidecar selbst ist **unverändert** — er spricht nur newline-JSON auf stdio, egal wer ihn spawnt.
- **E1c — Settings-Persistenz + Tauri-Cleanup + Docs (erledigt):**
  - **Persistenz:** `desktop/electron/store.ts` — hand-rolled Key-Value-Store (bewusst **kein** `electron-store`-Dep: das ist in neueren Versionen ESM-only und gibt CJS/ESM-Friktion mit unserem esbuild-CJS-Bundle; wir brauchen nur get/set/getAll). Datei: `<userData>/pulse-stream.json`. `initStore()` in `app.whenReady()` liest sie einmal in ein in-memory-Objekt; jeder `set` schreibt synchron als JSON zurück (`fs.writeFileSync(..., { mode: 0o600 })`). **Linux-Hardening** (übernimmt die alte Tauri-`harden_config_dir()`-Posture): `chmod 700` aufs `userData`-Dir + `chmod 600` aufs JSON-File (Settings können Custom-Server-Stream-Keys im Klartext enthalten). IPC: `ipcMain.handle('store:get'|'store:getAll'|'store:set')` — Errors werden geloggt, nicht gecrasht. Preload: `window.pulse.store = { get, getAll, set }`. Renderer `web/src/lib/stream/persistence.ts`: `loadAll`/`loadKey`/`saveAll` → `window.pulse.store.*` wenn `isElectron() && window.pulse?.store`, sonst `localStorage`-Fallback (`pulse.stream`-Key — für die Dev-Route / SvelteKit-App ohne Electron). Signatur unverändert; Persistiert: `profile_name`, `server_name`, `capture_source`, `audio_mode`, `excluded_apps`, `overrides`, `use_overrides`, `custom_servers`.
  - **Cleanup:** `desktop/src-tauri/` gelöscht; `@tauri-apps/cli` + die `tauri`/`tauri:dev`/`tauri:build`-Scripts aus `desktop/package.json` raus; `@tauri-apps/api`, `@tauri-apps/plugin-{store,notification,global-shortcut}` aus `web/package.json` raus; `pnpm-lock.yaml` aktualisiert. `web/src/lib/platform/runtime.ts`: `isTauri()` entfernt, `isDesktop()` = `isElectron()`-Alias. `web/src/lib/platform/ptt.ts`: der Tauri-PTT-Branch (`@tauri-apps/api/event`, `listen('ptt-down'/'ptt-up')`) raus → `initDesktopPtt()` ist ein **No-op-Stub** (`// TODO: global PTT for Electron needs a native key-listener (uiohook-napi); the in-window PTT in VoiceChannelView still works`); der Aufruf in `routes/+layout.svelte` bleibt (no-op). **Der In-Window-PTT in `VoiceChannelView.svelte` (`@svelte-put/shortcut`, Taste aus `settings.voice.pttKey`) ist der aktive PTT-Pfad und blieb unangetastet.** CLAUDE.md + diese §17 bereinigt.
  - **Verifikation:** `pnpm install` sauber · `cd desktop && pnpm run build:electron` Exit 0 (`electron/dist/{main,preload}.cjs` mit Store-Code) · `cd web && pnpm check` 0/0 · `cd web && pnpm build` Exit 0 · `pytest -q` 134/134 grün · `grep -rn '@tauri-apps\|__TAURI\|isTauri\|src-tauri' web/src/ desktop/` leer (nur harmlose "war mal Tauri"-Kommentare).
- *Was unangetastet bleibt:* `streaming/gsr-sidecar/*`, `streaming/{patches,server,scripts,bootstrap-gsr.fish}`, die T3b-UI-Components, `web/src/lib/stream/settings.svelte.ts` (nur die Persistenz-Calls darin), das ganze Backend, die SvelteKit-App, `VoiceChannelView.svelte`.

### Beschlossene Entscheidungen
- **Q1 — GSR-Binary:** komplett ins Flatpak gebundled (Custom-FFmpeg n8.1.1 mit NVENC/CUDA + VAAPI/QSV → NVIDIA, AMD, Intel; gepatchter GSR ≥5.13.5; GL.nvidia + GL.default-Extensions). **Keine** Detection-Kette, **kein** System-GSR-Voraussetzen. Bundle-Größe ~300 MB ist explizit ok. (Variante "d" aus der Diskussion — funktioniert weil Flatpak, nicht AppImage.)
- **Q2 — Sidecar:** long-running **Python**-Prozess (`gsr-sidecar`), wiederverwendet `profiles.py` + `stream_controller.py` + `config.py` aus dem GSR-`ui/`-Ordner ~verbatim. Einzige echte Logik-Änderung: `QProcess` → `subprocess.Popen` + stderr-Reader-Thread. Der Electron-Main spawnt+managed den Sidecar (`sidecar.ts`), Kommunikation per stdio (newline-JSON: Requests rein, Events raus). In der Flatpak schlicht als `.py` + python3 — kein PyInstaller nötig.
- **Q3 — Code-Übernahme:** **Vendored Copy** nach `discord-clone/streaming/`. `~/Dokumente/GPU_Screen_Recorder/` bleibt **komplett am Leben und unangetastet** — bewährte Referenz + Zuhause des Standalone-GSR-Flatpaks. Kein Submodule/Subtree (Wrapper ändert sich nicht, wir divergieren eh). Stream-Key (`server/.stream-key`, generierte `server/mediamtx.yml`) wird **nicht** mitkopiert; Pulse-`.gitignore` deckt `streaming/server/{mediamtx.yml,.stream-key}` ab.

### Leitplanken
1. GSR-Original-Repo unangetastet — wird kopiert, nicht modifiziert/gelöscht.
2. Qt-UI (`stream_window.py`, `main.py`) fällt weg; Funktionalität wird in Svelte neu gebaut, läuft in der Electron-App.
3. GSR-Streaming = Linux-only + optional: nur sichtbar wenn `isElectron() && isLinux() && gsrAvailable()` (Sidecar-`health`). Sonst (Win/Mac, reiner Browser) → `getDisplayMedia` → LiveKit-Screen-Track.
4. Kein Localhost-Daemon mit CORS/JWT — der Electron-Main spawnt den Sidecar direkt, stdio.
5. Primäres Auslieferungs-Artefakt = die Electron-Flatpak. Win/Mac/non-Flatpak-Linux-Bundles (ohne Streaming, nur Chat/Voice) sind Kür, nicht Teil des Hauptziels.

### Architektur
```
Svelte-Streaming-UI (in Pulse, im Electron-Renderer/Chromium)
   │  ipcRenderer.invoke('gsr:call', op, params)  /  ipcRenderer.on('gsr:event')
Electron-Main (electron/{main,sidecar,store}.ts): spawnt+managed Sidecar, store:* IPC
   │  stdin/stdout, newline-JSON
gsr-sidecar (Python — profiles.py/stream_controller.py, Qt gestrippt)
   │  subprocess
gpu-screen-recorder (aus /app/bin der Flatpak) ──RTMP/SRT──▶ MediaMTX (Hetzner, existiert) ──WHEP──▶ andere Pulse-User (whep-Player im Voice-View)
```
Globaler PTT (system-weiter Hotkey) ist noch nicht da — braucht ein natives Key-Listener-Modul (z.B. `uiohook-napi`), Electrons `globalShortcut` kann kein Press+Release. Der In-Window-PTT in `VoiceChannelView.svelte` deckt den aktiven Bedarf ab.

### Monorepo-Layout (Ergänzung zu §3)
```
discord-clone/
├── web/                       (exists) — src/lib/stream/ NEU: whep.ts · gsr.ts · persistence.ts · components/
├── desktop/                   Electron-App: electron/{main,preload,sidecar,store}.ts → electron/dist/*.cjs (esbuild)
├── streaming/                 NEU — vendored aus GPU_Screen_Recorder/ (Kopie, dann angepasst)
│   ├── gsr-sidecar/           profiles.py · stream_controller.py · config.py + control.py (stdio-Loop, ersetzt main.py/stream_window.py)
│   ├── patches/               GSR-C++-Patches — verbatim (0001-opus-flv-whitelist, 0002-stub-vulkan-encoder)
│   ├── bootstrap-gsr.fish     Custom-GSR-Build — verbatim (läuft im Flatpak-Build)
│   ├── server/                MediaMTX docker-compose + mediamtx.yml.template + player.html — verbatim (NICHT die generierte yml/.stream-key)
│   ├── scripts/               start-stream*.fish — manuelle Test-Skripte, optional
│   └── pyproject.toml
├── packaging/                 NEU — kombiniertes Flatpak-Manifest (Basis: das GSR-Manifest, PySide6-Module raus, Electron+Sidecar+web-build rein)
└── services/{…, media-svc/, mediamtx-auth-hook/}   die letzten zwei = NEU (T5)
```
Was NICHT mitkopiert wird: Binär-/Build-Artefakte (`mediamtx`-Binary, `*.flatpak`, `build/`, `.flatpak-builder/`, `*.log`), die Qt-UI-Dateien.

### Etappen

**E1 — Electron-Migration** (E1a/E1b/E1c) — siehe oben. Erledigt: liefert eine installierbare Electron-Desktop-App = aktuelle Web-App, Voice funktioniert im Fenster (Chromium-WebRTC), GSR-Sidecar-Bridge + Settings-Persistenz stehen. Offen: globaler PTT-Shortcut, Notifications, Packaging (T6).

**T2 — GSR-Paket rüberkopieren + Sidecar** (erledigt)
- `streaming/` = Kopie der relevanten GSR-Teile (s. Layout). Qt-Dateien raus.
- `gsr-sidecar/control.py`: stdio-Loop — Requests von stdin (`{"op":"start","profile":…,"server":…,"capture":…,"audio":…}`, `"stop"`, `"state"`, `"health"`, `"list_monitors"`, `"gpu_info"`, `"list_profiles"`, `"list_application_audio"`, `"build_argv"`), ruft den Controller (QProcess → `subprocess.Popen` + stderr-Reader-Thread), Events auf stdout (`{"ev":"state","running":true,"fps":59,"uptime":12}`, `{"ev":"error",…}`, `{"ev":"log","line":…}`). + `ServerProfile.from_channel(channel_id, token, mediamtx_endpoint)` in `profiles.py` (Pulse-Pfad `channel-<id>`, Stream-Token statt fixem Key).
- GSR-Binary-Resolver im Sidecar: `$GSR_BINARY` → Flatpak (`/app/bin/gpu-screen-recorder`) → Custom-Build (`$XDG_CACHE_HOME/pulse/gsr/...`, Legacy-Fallback `/tmp/gsr-analysis/...`) → System-PATH.
- *Liefert:* `gsr-sidecar` lokal per stdin/stdout testbar; der Electron-Main spawnt/stoppt/abfragt ihn (E1b).

**T3 — Svelte-Streaming-UI** (T3a obsolet — durch E1b ersetzt; T3b/T3c erledigt)
- Components in `web/src/lib/stream/components/`: Profil-Picker, Server-Picker, Capture-Quelle (Portal / Monitor-Liste via Sidecar-`list_monitors`), Audio-Mode + persistente App-Exclude-Liste, Codec/Bitrate/FPS/Auflösung-Overrides, Start/Stop, Live-FPS+Uptime, ausklappbares Log — 1:1 die PySide6-Features.
- Plus die zwei GSR-Pending-Tasks: GPU-Detection (Sidecar-`gpu_info`) → Default-Profil je Hardware (NVIDIA→AV1, AMD pre-RDNA3→H.264) + Warning bei AV1-auf-inkompatibel; Custom-Server-Profile via Dialog (persistiert).
- Nur sichtbar wenn `isElectron() && isLinux() && gsrAvailable()`. Sonst bestehender Browser-Screen-Share-Pfad. Settings via `window.pulse.store.*` (E1c) statt `~/.config/gsr-stream-ui/`.
- *Liefert:* GSR-HQ-Streaming komplett aus der Pulse-Electron-App.

**T4 — WHEP-Playback in Pulse**
- `web/src/lib/stream/whep.ts` — WHEP-Client (`RTCPeerConnection` + Lib), Player-Component im Voice-Channel-View, Stats-Overlay optional (wie `server/player.html`).
- *Interim:* feste MediaMTX-URL (`http://77.42.71.166:8889/<name>` in Dev). Andere Channel-Member sehen den Stream wenn jemand "HQ" streamt.
- *Liefert:* GSR-Stream *in* Pulse sichtbar, nicht nur via externem Player.

**T5 — Server-Seite** (eigener großer Block)
- `mediamtx-auth-hook` (FastAPI, MediaMTX `authHTTP`-Delegation): Publish nur mit gültigem Stream-Token für `channel-<id>`, Read nur für Channel-Member.
- `media-svc`: vergibt Stream-Tokens, koppelt Channel ↔ MediaMTX-Pfad, published Stream-State auf Redis → chat-gateway broadcastet "X streamt in #channel".
- VPS: `mediamtx.yml` umstellen (per-Channel-Pfade + authHTTP), MediaMTX hinter Caddy mit TLS (`stream.unicutmedia.com` → :8888/:8889), Caddy-Block für `pulse.unicutmedia.com` + Pulse-Backend-Deploy auf den VPS (SSH `michael@77.42.71.166` — vorhanden, busy shared VPS, MediaMTX in `~/streaming/`).

**T6 — Electron-Flatpak-Packaging**
- `packaging/` = das GSR-Manifest als Basis. *Behalten:* Custom-FFmpeg n8.1.1 (NVENC/CUDA/VAAPI), nv-codec-headers n13, GSR-Build mit den 2 Patches, `--device=all`, GL-Extensions. *Raus:* PySide6 + Qt-UI-Module. *Dazu:* SvelteKit-Static-Build (`web/build/`), die Electron-App (`desktop/` — `electron-builder` mit Flatpak-Target, oder das Electron-Binary + `electron/dist/*.cjs` manuell ins Manifest), `gsr-sidecar` (Python `.py` + python3). Der Prod-`loadFile`-Pfad in `main.ts` (`../../../web/build/index.html`) muss beim Packaging verifiziert/angepasst werden.
- **Base-Runtime:** Electron bringt Chromium selbst mit — die WebKitGTK-Frage von früher entfällt. Wahrscheinlich `org.freedesktop.Platform` (oder die `org.electronjs.Electron2.BaseApp` als Basis) + die GL/VAAPI-Extensions; beim Bauen verifizieren dass das Custom-FFmpeg-NVENC dagegen baut (sollte; FFmpeg-NVENC ist weitgehend self-contained, CUDA-Stubs).
- Der Standalone-GSR-Flatpak im Original-Repo bleibt unberührt.

### Reihenfolge / Status
E1 (Electron-Migration, E1a→E1b→E1c) ist erledigt — die "Pulse-Electron-App mit Streaming"-Basis steht. Offen davon: globaler PTT, Notifications. T4 (WHEP-Playback), T5 (Multi-User-Auth + Deploy), T6 (Electron-Flatpak) folgen. Pro Code-Etappe gilt die Verifikations-Regel (§15): Team mit Plan/Umsetzung + Verify.
