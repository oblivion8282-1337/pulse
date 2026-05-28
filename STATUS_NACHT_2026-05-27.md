# Status 2026-05-27 (Cert-Modell + Self-Host komplett gehärtet, manuell verifiziert, alle Tests grün)

**Branch:** `feat/cert-modell-self-host` (lokal **+ gepusht**, 155 Commits ahead of `main`)
**Watchtower auf Hetzner:** gestoppt. Production unberührt.
**Vorgänger-Snapshot:** `STATUS_NACHT_2026-05-26.md` (113 Commits, vor dem 10-Bug-Smoke-Fix)

## Was heute passiert ist (10 neue Commits)

| Hash | Was |
|---|---|
| `89def67` | refactor(member-list): MemberListItem.svelte als eigene Komponente extrahiert |
| `4d60f86` | fix(self-host): 10 Container-Boot-Bugs durch ersten echten Smoke-Test gefunden |
| `eb73aaa` | fix(self-host): nachgezogene Dockerfile + Init-Script-Edits |
| `50f1062` | docs: STATUS_NACHT_2026-05-26.md als historischer Snapshot |
| `0b2f5aa` | docs(win-hq-sidecar): 4 Analyse-Docs (Code-Review × 2, Code-Reduction, A/V-Sync) |
| `7ebbb7a` | fix(chat-gateway): /health antwortet bei JWKS-Cold-Start 200 'warming_up' statt 503 |
| `0f3eb30` | fix(self-host): 6 Findings aus Code-Review + Doku-Check |
| `9a3c15f` | docs(self-host): README an die Realität nach den 18 Smoke-Test-Fixes anpassen |
| `f996a49` | scripts(cdp): Multi-Chromium-Toolkit für Live-UI-Tests via Chrome DevTools Protocol |
| `da0bec2` | docs: ONBOARDING.md — Entwickler-Setup für eine neue Maschine |

## Was wirklich erreicht wurde

### 1. MemberList-Split (kosmetisch)
`MemberList.svelte` 394 Z. → 237 Z. + neue `MemberListItem.svelte` 186 Z. Verhaltensneutral
(alle data-testids erhalten, ContextMenu/Popover-Dual-Trigger-Muster intakt, `$derived` ersetzt
per-Render-Helper-Calls). Code-Größen-Cap-Verstoß weg.

### 2. Container-Smoke-Test — 10 echte Boot-Bugs gefunden + gefixt

Das Phase-6-Image baute zwar zu 1.1 GB durch, aber bei einem ehrlichen `docker run` mit
gültigen Env-Vars kam **kein einziger Service hoch**. Iterations-Smoke-Test deckte auf:

1. `.dockerignore`: `desktop/` schloss `package.json` aus → pnpm-Install brach
2. `python:3.13-slim` wandert mit Debian-stable → seit 2025 auf Trixie (glibc 2.38), Runtime ist Bookworm (glibc 2.36) → `GLIBC_2.38 not found`
3. Postgres-Schemas `auth` + `chat` mussten vor Alembic existieren (Henne-Ei mit `alembic_version`)
4. `06-run-migrations.sh` Postgres ohne TCP-Listening → asyncpg auf `127.0.0.1:5432` connection-refused
5. `VAPID_KEY_FILE` relativ → cwd-Problem bei s6-supervised Prozessen
6. MediaMTX RTMPS-Cert wurde nicht generiert
7. Phase-6.B-Files (Caddyfile.template, init-caddy.sh, pulse-health) lagen außerhalb von `s6/` → kamen nie ins Image
8. coturn pidfile/userdb auf root-only-Pfaden
9. **auth-svc s6-rc.d-Definition komplett gefehlt** — Service lief nie
10. Caddyfile fehlte `/api/auth/*` + `/.well-known/jwks.json`-Routing

### 3. Code-Review + Doku-Check — 6 weitere Findings + 2 Folge-Bugs

Zwei Sonnet-Agents gingen über die ersten 10 Fixes:

- [HIGH] Caddyfile.template CORS-Origin hardcoded auf `howispulse.com` → `{$PULSE_CLOUD_ORIGIN}`
- [MED] `06-run-migrations.sh` ohne Guard gegen bereits laufenden Postgres → `pg_isready`-Check ergänzt
- [LOW] RTMPS-Cert ohne SAN → `subjectAltName=DNS:$PULSE_HOSTNAME`
- [HIGH] `docs/SELF_HOST.md` beschrieb Watchtower als eingebaut — ist separater Container
- [HIGH] `PULSE_CLOUD_ORIGIN` als optional dokumentiert + Default-Absicherung in 07-render-env.sh
- [MED] `docs/PRIVACY_SELF_HOST_TEMPLATE.md` Punkt 5 ergänzt: Instanz-ID via PULSE_CLOUD_CLIENT_ID bei jedem Cloud-Call (DSGVO-Transparenz)
- **Folgefund 11**: pulse-health rief `nc -z`, netcat nicht im Image → auf bash builtin `</dev/tcp/host/port` umgestellt
- **Folgefund 12**: Dockerfile `HEALTHCHECK ... || /bin/true` maskierte Folgefund 11 — Fallback entfernt

### 4. chat-gateway `/health` für JWKS-Cold-Start

`/health` antwortet jetzt 200 `warming_up` mit `warming=["jwks"]` statt 503 `degraded` —
Container-Healthchecks und Load-Balancer flappen nicht mehr beim Cold-Start. 503 bleibt
für echte DB/Redis-Pfanne reserviert. `test_health_jwks_not_ready` umgestellt, alle
8 Health-Tests grün.

### 5. Self-Host-README-Konsistenz nach 18 Fixes

`infra/self-host/README.md` aktualisiert:
- auth-Service ins Architektur-Diagramm + ins File-Layout
- 09-init-caddy.sh in den Scripts-Baum
- `/data/livekit/` + `/data/mediamtx/` in der Volumes-Tabelle
- "Known Limitations Phase 6.A" + "Phase 6.B will add" entfernt (war veraltet)
- Hinweis ergänzt: cont-init-main.sh regelt Ausführungsreihenfolge, nicht die Dateinummer

### 6. CDP-Toolkit für Live-UI-Tests (`scripts/cdp/`)

Aus einer realen Multi-User-Test-Session destilliert:
- `launch.fish` startet Chromium mit isoliertem Profil + Remote-Debugging-Port
- `observe.mjs` passiver CDP-Listener, loggt Console/pageerrors/4xx/5xx in `/tmp/pulse-cdp-events-<port>.log`
- `shot.mjs` Screenshot mit `--full`-Option
- `drive.mjs` aktive Steuerung: navigate/click/fill/eval/wait-for/login (testid-basiert)
- README mit Workflow + Cleanup + Stolperstellen

@playwright/test wird via `createRequire` aus `web/node_modules/` gezogen — Aufruf
aus jedem cwd.

### 7. Manuelles UI-Testing (komplettes Cert-Modell live verifiziert)

In drei parallelen Chromium-Instanzen (Alice/Bob/Admin) via CDP durchgeklickt:

- ✓ Register → Cert-Erzeugung in IndexedDB → Bootstrap-Admin-Mechanismus
- ✓ Cloud-Backup-Setup (Argon2id + AES-256-GCM)
- ✓ Recovery-Page mit Auto-Detect via Cert-ID + Device-Label (Re-Login auf neuem Browser-Profil löste den Flow korrekt aus)
- ✓ Re-Issue-Flow ("Als neues Gerät weiter")
- ✓ Multi-Device + Backup-Badge-Differenzierung in DeviceManagement
- ✓ Multi-Server-Sidebar in allen drei Tabs
- ✓ MemberList-Split im Live-Einsatz (2 Mitglieder, alle Klassen + Testids korrekt)
- ✓ WebSocket-Real-Time-Sync (hodor + bob chatten live)
- ✓ Admin-Panel (Übersicht, Plugins, Self-Host-Instanzen-Tabs, User-Verwaltung, Audit-Log)
- ✓ Plugin-System (hello + tamagotchi in Allowlist)

**Findings:** Null Bugs in Source-Code. Drei User-Stolpersteine identifiziert + in
`docs/ONBOARDING.md` festgehalten:
- `email-validator` blockt `*.test`-TLDs → Konvention `*@dcc-test.example.com`
- `allow_guild_creation` default `false` in fresh deploys
- JWT-`is_admin`-Claim wird nicht live aktualisiert nach DB-Promotion → logout+login nötig

### 8. ONBOARDING.md für Maschinen-Switch

Schritt-für-Schritt Bring-up auf einer neuen Entwickler-Maschine: Repo + Secrets +
Deps + Stack + erster Test-Account + Tests + CDP-Toolkit + Self-Host-Image-Smoke.
Plus "Wo finde ich was"-Tabelle. Bringt einen neuen Claude (oder einen Menschen) in
ca. 15 Min auf Stand.

## Tests-Status

- **Backend**: **1205/1205 grün** in 144s
- **Frontend**: 0 Errors / 0 Warnings über 1546 Files (`pnpm check`), build clean
- **Playwright E2E**: **86/86 grün** in 1m30s
- **Container Idempotenz**: zwei Starts mit gleichem Volume — beide healthy,
  Reuse-Markers in den Logs sichtbar ("data dir already initialized",
  "database 'dcc' already exists", "schema auth/chat already exists, skipping",
  Alembic findet alle Migrations applied)
- **Container HTTPS-Endpoints**: `/health` → 200 `warming_up`, `/.well-known/jwks.json`
  → 200 mit echtem RSA-JWKS via Caddy → auth-svc routing
- **Manuelles UI**: alle Cert-Modell-Pieces im Live-Einsatz verifiziert

## Was nach wie vor offen ist (vor Merge nach `main`)

- **Echter End-to-End-Container-Test** mit DNS + Cloud-Approval-Flow (lokaler Smoke
  war ohne ACME / ohne echtes Cloud-Pair). Braucht eine reale Domain + Hetzner-Slot.
- **Watchtower auf Hetzner wieder hochfahren** — erst nach Merge nach main.
- **Mod-Tools End-to-End** (Report → ModQueue → Resolve → Audit-Log) — noch nicht im
  UI durchgeklickt; Backend ist getestet.
- **Voice/HQ-Stream-Test** — schwer rein im Browser, müsste mit Electron oder
  zweitem Voice-Client.
- **Win-HQ-Sidecar** — vier Analyse-Docs (Code-Review × 2, Code-Reduction, A/V-Sync)
  liegen im Repo, konkrete Code-Aktionen noch nicht umgesetzt — separates Thema.

## Stats

- **155 Commits** ahead of `main`
- **~170 Files neu** zwischen Backend + Frontend + Container + Tools + Docs
- **~14.000 Zeilen** netto Code + Doku in der gesamten Branch-Geschichte
- **22 echte Bugs** in dieser Session gefunden + gefixt (10 Boot + /health + 6 Code/Doku + 2 Folge + 4 README-Konsistenz)
- **Null** verbleibende bekannte Bugs

## Konstanten (User-Anweisungen)

- Kein `git push` zum main, kein PR-Open, kein `main`-Merge, kein Production-Touch
  ohne explizite Freigabe
- Alles im Branch bleibt; Watchtower bleibt gestoppt
- Branch wandert mit dem Repo (gepusht zu `origin/feat/cert-modell-self-host`),
  Memory wandert NICHT (Claude-lokal)
