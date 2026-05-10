# Über-Nacht-Auftrag — Discord-Klon Etappe 1 + Voice-Backend-Skelett

**Erstellt:** 2026-05-11 Nacht
**Modus:** Worktree-Isolation, nur lokale commits (kein push)
**Stoppkriterium:** Alle Tests grün UND Playwright-E2E grün ODER 5 Iterations-Failures bei einem Bug
**Maximalzeit:** ~7 Stunden (danach Report schreiben und beenden)

---

## 1. Dein Auftrag in einem Satz

Setze Etappe 1 (Auth + Text-Chat) **vollständig funktionsfähig** um. Wenn vor 4h fertig: Starte zusätzlich den Voice-Backend-Skelett (LiveKit-Container + voice-signaling-svc-Stub mit Token-Endpoint), aber **kein Frontend-Voice-Code** — den braucht der User selbst um Qualität zu beurteilen.

## 2. Quellen, die du lesen MUSST bevor du anfängst

1. `PLAN.md` (im Repo-Root) — **vollständig**, das ist die Single-Source-of-Truth für Stack und Architektur
2. Memory-Files: `~/.claude/projects/-home-michael-Dokumente/memory/project_discord_clone.md`, `project_streaming_setup.md`, `feedback_docker_ports.md`
3. Globale CLAUDE.md: `~/.claude/CLAUDE.md`

## 3. Harte Regeln (NIEMALS brechen)

1. **KEIN `git push`.** Nur lokale commits.
2. **KEINE GitHub-Operationen** (`gh`-CLI). Repo bleibt lokal.
3. **KEINE Änderungen an `~/Dokumente/GPU_Screen_Recorder/`** — das ist der GSR-Streamer, der ist tabu in dieser Nacht (Etappe 3 ist nicht im Scope).
4. **KEINE destruktiven Aktionen außerhalb des Worktrees** (`rm -rf` woanders, `git reset --hard` am main, force-push).
5. **KEINE großen Docker-Port-Ranges** (siehe `feedback_docker_ports.md`). Single-Port-Mappings ok.
6. **Port 5432 darf NICHT belegt werden** — wird vom User schon mit `cs_trading_postgres` genutzt. **Discord-Klon-Postgres auf Port 5433.**
7. **KEINE externen Services anrufen** außer für Package-Downloads (npm, PyPI, crates.io).
8. **KEINE Passwörter/Secrets ins Repo committen.** `secrets/` muss in `.gitignore`.
9. **Bei Verifikations-Failure: max 5 Iterationen** pro Problem. Danach: skippen, dokumentieren, weitermachen.

## 4. Port-Mapping (FIX, nicht ändern)

| Service | Port |
|---|---|
| Postgres (Discord-Klon) | **5433** (nicht 5432!) |
| Redis | 6379 |
| auth-svc | 8001 |
| chat-gateway | 8002 |
| voice-signaling (Stub) | 8003 |
| LiveKit (nur wenn Voice-Etappe startet) | 7880 (HTTP), 7881 (WS), 7882 (UDP RTC range start) |
| Vite Dev (Frontend) | 5173 |
| Adminer (optional) | 8084 (nicht 8081, das ist `cs_trading_adminer`) |

## 5. Verzeichnis-Layout (genau so anlegen)

Siehe `PLAN.md` Section 3. Beachte: `services/`, `web/`, `desktop/`, `gsr-helper/`, `infra/`, `docs/`.

**Tag-1 (heute Nacht) konkret anzulegen:**
- `services/auth/` — voll
- `services/chat-gateway/` — voll
- `services/voice-signaling/` — **NUR Skelett mit Token-Endpoint** (kein Webhook-Receiver, kein Redis-State — das macht User später)
- `web/` — voll für Login + Chat
- `infra/caddy/` — minimal, lokales Dev-HTTP (kein TLS für localhost)
- `infra/livekit/` — `livekit.yaml` minimal (nur wenn Voice-Etappe gestartet wird)
- `secrets/.gitignore` so dass nur `.gitignore` selbst committed wird

## 6. Stack-Picks (festgenagelt, NICHT re-evaluieren)

Aus PLAN.md Section 2:
- Backend: FastAPI 0.115+, SQLAlchemy 2.x async, asyncpg, Alembic, redis async, pyjwt[crypto] RS256, argon2-cffi, snowflake-id-toolkit
- Frontend: SvelteKit 5 + TypeScript + TailwindCSS 4 + shadcn-svelte + bits-ui + @humanspeak/svelte-virtual-list + svelte-sonner + @svelte-put/shortcut + valibot
- Pakete in pnpm-Workspace, Python in uv-Workspace

**Frontend-Start:** Forke NICHT `alysonhower/tauri2-svelte5-shadcn` (Tauri brauchen wir Etappe 4 — heute Nacht reines SvelteKit). Stattdessen: `pnpm create svelte@latest web` mit TypeScript-Skeleton, dann shadcn-svelte init.

## 7. Reihenfolge (linear, nicht überspringen)

### Phase A: Setup (~30 Min)
1. `.gitignore` schreiben (Python, Node, secrets/, build/, dist/, .env, *.log, __pycache__, node_modules, .venv)
2. JWT-Keypair: `openssl genpkey -algorithm RSA -out secrets/jwt_private.pem -pkeyopt rsa_keygen_bits:2048` und `openssl rsa -in secrets/jwt_private.pem -pubout -out secrets/jwt_public.pem`. `chmod 600 secrets/*.pem`, `chmod 700 secrets/`
3. `.env.example` schreiben (POSTGRES_PASSWORD, JWT_PRIVATE_KEY_FILE, JWT_PUBLIC_KEY_FILE, REDIS_URL, AUTH_JWKS_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET — letzte zwei nur falls Voice-Etappe)
4. `.env` aus `.env.example` kopieren, Passwort generieren (`openssl rand -hex 32`)
5. `pyproject.toml` als uv-Workspace anlegen mit Members `services/auth`, `services/chat-gateway`, `services/voice-signaling`, `shared`
6. `package.json` + `pnpm-workspace.yaml` für Frontend
7. `docker-compose.yml` (Postgres auf 5433, Redis 6379, beides mit Healthchecks)
8. `git commit` Zwischenstand

### Phase B: Backend Foundation (~2h)
9. `shared/snowflake.py` (oder via `snowflake-id-toolkit`) + Tests
10. `services/auth/`: Alembic-Setup, `auth.users`, `auth.refresh_tokens`, Routes (`/register`, `/login`, `/refresh`, `/logout`, `/me`, `/.well-known/jwks.json`), Argon2id-Hashing, RS256-JWT-Issue, **Pytest mit ≥80% Coverage** der Routes
11. `services/chat-gateway/`: Alembic-Setup, `chat.guilds`, `chat.channels`, `chat.guild_members`, `chat.messages`, REST-Routes (Guild/Channel-CRUD + Message-History), JWKS-Verify-Middleware mit Cache, **Pytest**
12. `services/chat-gateway/`: WebSocket-Handler mit `op`-Protokoll (subscribe/unsubscribe/send → ready/message/message_ack/error), Redis-Pub/Sub-ConnectionManager, **Pytest mit 2 Test-Clients**
13. `git commit` Zwischenstand

### Phase C: Frontend (~2-3h)
14. SvelteKit 5 + TypeScript + Tailwind v4 setup in `web/`
15. shadcn-svelte init, benötigte Components installieren: button, input, dialog, scroll-area, dropdown-menu, context-menu, resizable, separator, tooltip, sonner, avatar
16. `lib/api/`: typed HTTP-Client mit JWT-Refresh-Logik, Endpoints für Auth + Chat
17. `lib/ws/`: WebSocket-Singleton mit auto-reconnect + Backoff
18. `lib/stores/`: messages, channels, guilds als `.svelte.ts` mit Runes
19. Routes: `/`, `/login`, `/register`, `/app/`, `/app/guilds/[guildId]/channels/[channelId]/`
20. Components: GuildList, ChannelList, ChatView (mit @humanspeak/svelte-virtual-list), MessageInput, MessageItem
21. Tailwind-Style: Dark-Mode default, Discord-ähnliche 3-Spalten-Optik
22. `git commit` Zwischenstand

### Phase D: Verifikation (~1h)
23. Backend-Tests: `cd services/auth && pytest -v && cd ../chat-gateway && pytest -v` — beide grün
24. Frontend-Build: `cd web && pnpm build` — keine Type-Errors
25. Playwright installieren in `web/tests/e2e/`, schreibe E2E-Test:
    - Register zwei User
    - Login beide
    - Erster User legt Guild + Channel an
    - Zweiter User wird zum Guild eingeladen (via API, kein UI-Invite-Flow nötig)
    - Beide schicken Messages, sehen jeweils die der anderen
    - `pnpm test:e2e` grün
26. Smoke-Test manuell via `playwright codegen` oder headless: `docker compose up -d`, `cd web && pnpm dev &`, dann Playwright-Script ausführen
27. `git commit` "Etappe 1 fertig, Tests grün"

### Phase E (NUR wenn vor 4h fertig): Voice-Backend-Skelett
28. `infra/livekit/livekit.yaml` minimal (development-keys, port 7880-7882)
29. LiveKit-Container in docker-compose.yml hinzufügen
30. `services/voice-signaling/`: FastAPI-App mit einem Endpoint `POST /token` der für gegebenen `channel_id` einen LiveKit-AccessToken issued (JWKS-Verify wie chat-gateway, dann `livekit-api`-Lib für AccessToken-Generation)
31. Pytest dafür
32. **KEIN Webhook-Receiver, KEIN Redis-State, KEINE Frontend-Integration** — das macht User
33. `git commit` "Voice-Backend-Skelett"

## 8. Verifikations-Strategie

Nach Phase B (Backend fertig):
- Spawne einen Verify-Agent (Sonnet, general-purpose, run_in_background false), brief ihn: "Verifiziere services/auth und services/chat-gateway: lies die Tests, prüfe ob die Coverage echte Pfade abdeckt oder nur Happy-Path, prüfe Schema-Mismatches, prüfe JWT-Signatur-Sicherheit, prüfe SQL-Injection-Anfälligkeit, prüfe WS-Reconnect-Verhalten unter Test. Liste konkrete Bugs."
- Bei Bugs: fix, re-verify (max 5 Iterationen pro Bug)

Nach Phase C (Frontend fertig):
- Spawne Verify-Agent: "Verifiziere web/: Type-Errors via tsc, Tailwind-Output-Größe, gibt es Component-State-Leaks zwischen Routes, hat die WS-Singleton-Logik Memory-Leaks bei Reconnect, Token-Refresh-Race-Conditions."

Nach Phase D (E2E grün):
- Spawne Final-Verify-Agent: "Lies das ganze Repo: passt es zu PLAN.md Section 3 (Verzeichnis-Layout)? Sind alle harte Regeln eingehalten? Welche kritischen Edge-Cases sind nicht getestet?"

## 9. Output beim Stoppen

Wenn fertig oder Maximalzeit erreicht: Schreibe `NIGHT_RUN_REPORT.md` ins Repo-Root mit:

```markdown
# Nacht-Lauf Report

## Status: [ERFOLGREICH | TEILWEISE | ABGEBROCHEN]

## Was läuft
- [Liste]

## Was NICHT läuft (Bekannte Bugs)
- [Liste mit File:Line]

## Übersprungene Items (mit Begründung)
- [Liste]

## Verbleibende Iterations-Failures
- [Liste der Bugs, die nach 5 Versuchen nicht behoben wurden]

## Wie User morgen früh weitermachen kann
1. `cd ~/Dokumente/discord-clone`
2. `docker compose up -d`
3. `cd web && pnpm dev` (in zweitem Terminal)
4. `cd services/auth && uv run pytest` — sollte grün sein
5. ... etc

## Wichtige Entscheidungen, die ich getroffen habe
- [Liste]

## git log --oneline
[einfügen]
```

## 10. Fehlerbehandlung

**Wenn ein Test-Run failt:**
1. Lies die Fehlermeldung **vollständig**
2. Identifiziere die Ursache, nicht das Symptom
3. Fix, re-run
4. Bei 5 Versuchen: skip, dokumentieren, weiter

**Wenn ein Dependency-Install hängt:**
- Niemals Y/N-Prompts blind beantworten
- Nutze nicht-interaktive Flags (`--yes`, `--non-interactive`)
- Bei tatsächlichem Hänger: skip die Library, dokumentieren

**Wenn ein Bug das Setup blockiert:**
- z.B. Port-Konflikt, Postgres-Container kommt nicht hoch
- Logs prüfen (`docker compose logs <service>`)
- Bei Unklarheit: stoppen, Report schreiben, User soll selbst entscheiden

**Wenn dir Zeit ausgeht (~6h gelaufen):**
- Phase abschließen, in der du gerade bist
- `git commit -am "WIP: <was zuletzt funktionierte>"`
- Report schreiben

## 11. Was du NICHT tun sollst (zusätzlich zu Section 3)

- Keine eigenen Architektur-Entscheidungen, die PLAN.md widersprechen
- Keine neuen Libraries einführen, die nicht in PLAN.md Section 2 stehen
- Keine UI-Polish-Stunden (Animationen, Themes, Custom-Fonts) — das macht User
- Keine vorzeitigen Optimierungen (Caching, CDNs, Performance-Tuning)
- Keine Etappe 3, 4 oder 5 Inhalte (kein GSR, kein Tauri, kein MinIO, keine Streaming-Features)
- Keine Service-Worker, keine PWA-Config — Etappe 4
- Kein E2EE — Etappe 5

## 12. Wenn alles funktioniert: was User morgen Erwartung

```bash
cd ~/Dokumente/discord-clone
docker compose up -d              # Postgres+Redis (+ optional LiveKit)
cd services/auth && uv run pytest # alle grün
cd ../chat-gateway && uv run pytest # alle grün
cd ../voice-signaling && uv run pytest # nur wenn Phase E erreicht
cd ../../web && pnpm dev          # Vite auf :5173
# Browser: http://localhost:5173
# → Registrieren, einloggen, Server anlegen, Channel anlegen, Message schicken
# → in zweitem Inkognito-Tab: anderen User registrieren, derselbe Channel, Messages laufen real-time
```

---

**Final note:** Be tenacious (siehe globale CLAUDE.md). Wenn du auf einen Bug stößt, der lösbar ist — löse ihn. Aber bei klaren Sackgassen: stoppen, Report, User entscheidet morgen. Quality over quantity.
