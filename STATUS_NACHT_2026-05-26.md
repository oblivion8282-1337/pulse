# Status 2026-05-27 (Cert-Modell + Self-Host komplett, Container baut, alle Tests grün)

**Branch:** `feat/cert-modell-self-host` (lokal, **NICHT gepusht**, 113 Commits ahead of `main`)
**Production-Touch:** keiner. Watchtower auf Hetzner ist gestoppt.

## Was fertig ist

### Block 1 — Cert-Modell Foundation ✅
Migration 0012–0018 + Browser-Session-Cookie + Identity-Cert + CRL + Profile-Statement + Frontend-Integration + Big-Bang-Migration.

### Block 2 — Multi-Device-Backup ✅
- Backend `/credentials/{id}/backup` Endpoints + Migration 0019/0020/0021
- Frontend PBKDF2-SHA256-600k + AES-256-GCM in `key-backup.svelte.ts`
- CloudBackup-UI (3 Komponenten Split)
- Onboarding-Step (opt-in)
- Device-Backup-Status-Icons + `extractable: true` als Default

### Phase 2 — Instance-Registry (Cloud) ✅
- 4 Tabellen: `registered_instances`, `instance_applications`, `suspended_instances`, `complaints`
- User-Endpoints (`/me/instance-applications`, `/me/instances`)
- Admin-Endpoints (Approve/Reject/Suspend/Unsuspend/Rotate-Secret)
- Public/Internal: `/.well-known/pulse-suspended-instances` + `/admin/instances/_broadcast-update`
- Frontend: `AdminInstances` (3 Tabs) + `SelfHostApplication` + `MyInstances` + Snowflake-String-Fix

### Phase 3 — chat-gateway Self-Host-tauglich ✅
- Schema: `cached_user_profiles`, `reports`, `mod_audit_log` (Migration 0022)
- Config-Erweiterung + JWKS-Pinning + WS-Close-4046 + Cold-Start-Retry-Loop
- Profile-Statement-Push-Cache + Pairwise-Sub + Mention-Search
- Cloud-Policy-Poller + WS-Hello-Frame + `/.well-known/pulse-server-info`
- Mod-Tools (Reports + Mod-Queue + Audit-Log)

### Phase 4 — Frontend Multi-Backend ✅
- **4.1**: `serversStore` + `activeServer` + `sessionTokens` (Memory-only) + Auto-Migration zu Cloud-Eintrag
- **4.2**: API-Client + WS-Gateway-Pool (Backwards-Compat-Proxy, Reconnect-Backoff [1s→2s→…→300s], 4044/4045/4046/4047/4003-Mapping)
- **4.3**: ServerSidebar (Discord-Style) + AddServerDialog + UpdateBanner + SelfHostDisclaimer
- **4.4**: Mod-UI (ModQueue + AuditLog + ReportDialog + PublicComputerSafety)
- **4.5**: `resetServerScopedStores()` für 15 Stores + `useGatewayListener`-Helper + Race-Guard im Dispatch

### Phase 5 — Invite-Flow ✅
- **5.1 Backend**: `POST /cert-login/challenge` + `/verify` (stateless HMAC-Challenge, 60s-Replay-Window, iss-Validation-Fix)
- **5.2 Frontend**: `certLogin()` + `initSelfHostReauth()` + AddServerDialog-Integration (mit Rollback bei Fail)
- **5.3 Electron**: `pulse://invite`-Deep-Link-Handler (open-url + second-instance, IPv4-Block, Disclaimer-Pflicht)
- Backend Invite-Routes (`/invites/{code}`, `/invites/{code}/accept`) waren schon da (Migration 0002)

### Phase 6 — Self-Host Single-Container ✅
- **6.A**: `infra/self-host/Dockerfile` (Multi-Stage: Python+Web → Debian-Bookworm-Runtime) + s6-overlay v3.2.0.2 + 10 cont-init.d-Scripts + 10 longrun-Services
- **6.B**: Caddyfile-Template (Auto-TLS + CORS + Security-Headers) + `/health` + `/internal/health-probe` + `pulse-health`-Script + `docs/SELF_HOST.md` (8-Schritte-Setup) + `PRIVACY_SELF_HOST_TEMPLATE.md` + `INSTANCE_APPROVAL_POLICY.md`

**Pflicht-Env-Vars** für Self-Hoster: `PULSE_HOSTNAME`, `PULSE_CLOUD_CLIENT_ID`, `PULSE_CLOUD_CLIENT_SECRET`, `PULSE_ADMIN_EMAIL`. Alles andere generiert sich beim First-Start in `/data/`.

## Sicherheits-Fixes während der Arbeit gefunden + behoben

- **iss-Claim** wird jetzt in `validate_cert` validiert (Defense gegen JWT-Confusion, BLOCKER aus 5.1-Verify)
- **`credentials: 'omit'`** für Self-Host-Requests in `client.ts` (Cross-Origin-Cookie-Leak vermieden, BLOCKER aus 5.2-Verify)
- **IPv4-Hostnames** im Deep-Link blockiert (SSRF gegen private IPs, BLOCKER aus 5.3-Verify)
- **Race-Guard** im Connection-Dispatch (alte Connection schickt nach Switch kein ready in die globalen Stores)
- **`localStorage.setItem` in try/catch** (Safari ITP / Quota-Exceeded)

## Tests-Status

- **Backend**: **1027/1027 grün** (MinIO-Flake gefixt)
- **Frontend**: 0 Errors, 0 Warnings (1510+ Files)
- **Electron-Build**: clean
- **Docker-Build**: 1.1 GB, baut sauber, s6-overlay bootet, fail-fast bei fehlenden Env-Vars

### Kleinkram (KK1-3) fertig

- ✅ Key-Backup auf **Argon2id** (hash-wasm 4.12.0, m=64MB/t=3/p=4). v=1-Blobs bleiben lesbar.
- ✅ Backup-Onboarding-Preference **Backend-Endpoint** (`/me/preferences/backup-onboarding`). Cross-Device-Sync. localStorage als Write-Through-Cache.
- ✅ MinIO-Flake gefixt (Test ist jetzt bucket-state-agnostisch).

## Was offen ist

- **Manuelles UI-Testing**: Multi-Server-Switch + Cert-Login + Invite + Mod-Queue durchklicken
- **GHCR-Image-Build-CI-Workflow** für `pulse-allinone:stable` (GitHub-Actions, baut+pusht bei push nach main)
- **Checksum-Verifikation** der gepinnten Binaries in Dockerfile (s6-overlay, Caddy, LiveKit, MediaMTX) — Build-Args + `sha256sum`-Verify
- **MemberList.svelte Split** (pre-existing NIT, 383 Z. über 250-Cap)
- **Echter End-to-End-Container-Test** (mit DNS + Cloud-Approval-Flow durchlaufen)

## Vor dem Merge nach `main`

1. Manueller UI-Test des Multi-Server-Flows (Cloud + Self-Host)
2. Playwright E2E (`cd web; pnpm exec playwright test`)
3. Container-Smoke-Test (läuft jetzt)
4. Backend: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q`
5. Watchtower auf Hetzner wieder starten + ggf. erst manuell die Migrations triggern (Migration 0020 + 0021 + 0022 sind neu)

## Stats

- **113 Commits** ahead of `main`
- **~165 Files neu** zwischen Backend + Frontend + Container
- **~13.000 Zeilen** netto Code geschrieben
- **5 Backend-Migrations** (0019 KDF-Rename, 0020 Instance-Registry, 0021 target_url, 0022 chat phase3-schemas)
- **2 Worker-ID-Slots** reserviert (1-99 Cloud, 100-1023 Self-Host)
- **1 neue Dep** im Frontend: `hash-wasm@^4.12.0` (Argon2id für Key-Backup)
- **Docker-Image-Größe**: 1.1 GB für `pulse-allinone:smoke`
