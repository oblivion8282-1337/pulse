# Claude-Notizen für dieses Projekt

Projekt: **Pulse — Web-First Chat + Voice + Streaming**.
Monorepo (uv-Workspace + pnpm-Workspace).

## Was das Projekt macht

Discord-ähnlicher Chat/Voice-Client, **Web-First** (alle Browser),
Desktop via Tauri 2, PWA-installierbar. Backend = mehrere kleine
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
- **Node** v25.9.0 · **pnpm** 10.33.0 (Frontend-Workspace, `pnpm-workspace.yaml`)
- Ruff `line-length=100`, `target-version=py313`, `ignore=["E501"]`

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

- **Kein `git push`, keine GitHub-CLI** ohne explizite Freigabe. Es gibt noch keinen Remote.
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
- ❌ Electron statt Tauri · ❌ React-Bridge in SvelteKit für LiveKit-React-Components
- ❌ `@livekit/krisp-noise-filter` (kostenpflichtig seit 2026-05-01) · ❌ `svelte-french-toast` (Sv5-inaktiv) · ❌ `svelte-markdown` blind (kein Sanitizer)
- ❌ Exactly-once-Delivery anstreben · ❌ Re-Publishing MediaMTX→LiveKit (Transcoding zu teuer)
- ❌ Routes-/Service-Dateien über die Größen-Grenze wachsen lassen statt zu splitten
