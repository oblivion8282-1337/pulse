# Bughunt: Veraltete & falsche Behauptungen in Notizen (2026-09-28)

**Auftrag:** Sämtliche Notiz-/Memory-Quellen des Repos gegen den tatsächlichen Code-Stand prüfen — veraltete und falsche Behauptungen finden. Mehrere Agenten, aufgeteilt nach App-Bereichen; iteriert, bis alle Quellen gescannt waren.

**Methode:** 14 Read-only-Scans (Explore-Agenten) in 4 Wellen. Jede prüfbare Behauptung (Dateipfade, Symbole, env-vars, Defaults, Ports, Migrationsnummern, „existiert/entfallen/synchron"-Aussagen, offene TODOs) wurde gegen den Code verifiziert. Spot-Gegenprobe der gravierendsten Befunde durch den Leit-Agenten (alle bestätigt). Reine Historie/Anekdoten/Messwerte zählen nicht als Befund; als „überholt" korrekt markierte Stellen auch nicht.

**Umfang (alle gescannt):**
- Kern-Anweisungen: `AGENTS.md`, `CLAUDE.md` (komplett), `docs/ONBOARDING.md`, `docs/git-workflow.md`, `.githooks/README.md`, `.claude/hooks/README.md`
- Root-Statusdateien: `PLAN.md`, `README.md`, `HALBFERTIG.md`, `IDEAS.md`, `AUDIT_FINDINGS.md`, `PONYTAIL_AUDIT.md`, `BACKUP_NOTES.md`, `WINDOWS_HQ_SIDECAR.md`, `IDENTITY_CONCEPT.md`, `CLA.md`, `THIRD-PARTY-NOTICES.md`
- streaming/READMEs (inkl. aller Sidecars, Labor, Player, Testbench), docs/-Referenzdocs, infra-Docs, aktuelle datierte Docs, alle specs, 71 plans (leichtgewichtig bei archivierten), packaging/desktop/legal-Readmes, Sync-Paare (Lizenz, Permissions-Bits, Redis-Keys, WS-Codes, Preload↔Typen, Zeigerbild, Paraglide, Bau-Auslöser)
- Memory: `~/.claude/projects/-home-michael-Dokumente-Pulse/memory/` — alle 72 Dateien (inkl. `MEMORY.md`-Index); `.zcode/plans/` (1 Plan)
- **Nicht Scans schwerpunkt:** historische Messberichte (`docs/2026-07-*`, `docs/2026-08-0x/1x-*` ohne IST-Anspruch), `.superpowers/sdd/`-Archiv (Task-Briefs/Reports eines abgeschlossenen Laufs), `graphify-out/` (generiertes Tool-Artefakt mit eigenem Git), `.claude/worktrees/` (Worktree-Mirror), `LICENSE*`-Texte selbst.

**Bilanz: 248 Befundzeilen, davon 29× Schwere „hoch".** Nach Deduplikation überlappender Fundstellen (dieselbe Wurzel an mehreren Notizorten) ~200 einzelne Stellen. Der Code selbst war nicht Auftragsgegenstand — wo ein Befund aber offenbart, dass auch CODE-Kommentare kürschen (z. B. `kanalrechte.ts`, `postfach.py`), ist er mit notiert.

---

## Die Fehlerklassen (Muster)

1. **Umbenennungen nicht nachgezogen:** `gsr` → `sidecar` (2026-09-21) — IPC `sidecar:call`, Store `sidecarAvailable`, `window.pulse.sidecar.*`, Health-Feld `health.sidecar.*`. ~15 Notizstellen nennen weiter `gsr:call`/`gsrAvailable`/`health.gsr.*`; CLAUDE.md sagt an drei Stellen ausdrücklich „nicht umbenennen".
2. **Entfernte Features leben in Notizen weiter:** Cert-Modell/CRL (entfallen 2026-08-28), E2E-Vault (entfallen 2026-06-28), Account-Key-/Cloud-Backup-Modell (entfallen 2026-06-28), Python-GSR-Sidecar (entfernt 2026-08-27), Intra-Refresh (entfernt 2026-08-21), join_mode-3-Wege-System (entfernt Stufe 5), MinIO (ersetzt durch Garage), Podman-Bündelung (geparkt 2026-07-14), native localBackend-Orchestrierung (ersetzt 2026-07-02), TWA-Android (ersetzt durch Capacitor `mobile/`), Watchtower (überall entfernt).
3. **Umgekehrte Schalter-/Default-Strände:** Diagnose-Log-Upload (default AN seit 2026-08-06, Notizen sagen Opt-in), `REMOTE_CONTROL` (seit 2026-09-09 in `DEFAULT_EVERYONE_PERMISSIONS`, Notizen sagen Gate), vier Krypto-Schalter (AN, alte Stellen sagen AUS), DM-Sperre `ohne_app` (2026-09-12 aufgehoben, CLAUDE.md/Spec sagen gegenteilig), `ABLAGE_KANAL_ENABLED=true`, presign-TTL 1800 statt 600, Keyframe-Vorgabe 60 s statt 2 s.
4. **Erledigte Pläne als offen:** ~20 Plan-/Statusdateien mit offenen Checkboxen zu längst gebauten Features (etappen a–g1, zwischenablage, chatfirst, installer-audit, mac-whip, Zwillinge …).
5. **Lizenz-Sync-Lücken:** 4 Verzeichnis-LICENSEs noch PolyForm; `WINDOWS_HQ_SIDECAR.md` nennt PolyForm als aktuell; `docs/code-schutz-und-geschaeftsmodell.md` behauptet AGPL.
6. **Gedriftete Zahlen/Pfade/Ports:** u. a. ws_op_gate 4043 wird nicht mehr gesendet, ws.py↔constants.ts asymmetric, `PULSE_KEYFRAME_SECONDS`-Grenzen, jitter_ms 100 statt 20, MediaMTX `pulse7`, `install.sh`-Image, Port 1935 entfernt.

---

## A. Schwere-Befunde („hoch") — die 29 im Einzelnen

### Datenschutz & Rechte
- **[H] `web/src/lib/legal/datenschutz.md:139-143`** — Behauptung „Weitergabe nur an Hosting + E-Mail-Dienst". Realität: Desktop-App lädt seit 2026-08-06 **standardmäßig** (Opt-out, `uploadDiagnosticLogs !== false`, `desktop/electron/experimental-log-upload.ts:119`) bei Stream-Ende/-Fehler Sidecar-Log + Systeminfo (Rechnername, GPU-/Codec-Fähigkeiten) auf `https://howispulse.com/api/experimental-logs` hoch. Diese Verarbeitung fehlt in der Erklärung (Stand 28.08.2026) vollständig.
- **[H] `CLAUDE.md:153`** — Behauptung „eigenes Opt-in `uploadDiagnosticLogs` (default false)". Realität: Default AN + Migration auf „an" (`experimental-log-upload.ts:93-121`), ebenso `web/src/lib/stream/diagnose-senden.ts:46`.

### Permissions / Fernsteuerung
- **[H] `CLAUDE.md:138` + `docs/fernsteuerung.md:19` + Kommentar `web/src/lib/permissions/kanalrechte.ts:97-99`** — „REMOTE_CONTROL = Bit 37, NICHT in DEFAULT_EVERYONE_PERMISSIONS". Realität: seit 2026-09-09 ausdrücklich drin (`shared/src/dcc_shared/permissions.py:100`, Kommentar 60-67: Eigentümer-Entscheid „anfragen erlaubt"). Neue Communitys starten mit Fernsteuerungs-Anfragen; die drei Stellen behaupten das Gegenteil.

### Krypto / DMs
- **[H] `docs/superpowers/specs/2026-08-28-e2e-dm-design.md:192-201` (§3a) und `CLAUDE.md:230`** — „der Code setzt die Koexistenz-Regel heute noch um" bzw. (Spec) sie sei ersetzt durch „ohne App-Gerät keine DMs". Realität: die `ohne_app`-Sperre wurde **2026-09-12 wieder aufgehoben** (`web/src/lib/krypto/dmSendeSperre.ts:5-9`: „auch reine Browser-Konten senden und empfangen"; `dmBrowserWarnung.ts:7-10`). Beide Stellen beschreiben einen Zustand, der nie oder nicht mehr galt. Klartext-Altbestand stillgelegt (Migration `0083_legacy_readonly`).
- **[H] `docs/superpowers/specs/2026-09-21-diagnose-berichte-design.md:3,65`** — „Entwurf, noch nicht umgesetzt" / „Nicht vorhanden: Admin-Lesezugriff…". Realität: Phase 1+2 gebaut — `web/src/lib/diagnose/app-diagnose.ts`, `KaeferDialog.svelte`, `web/src/lib/api/diagnose.ts`, Admin-Endpoint `GET /admin/experimental-logs` (`services/auth/src/dcc_auth/routes_experimental_logs.py:360-396`).
- **[H] `docs/superpowers/specs/2026-09-11-pulse-laufwerk-design.md:3`** — „Spezifikation, nicht gebaut". Realität: gebaut — `services/chat-gateway/src/dcc_chat_gateway/routes/ablage_pulse.py`, Migration `0090_ablage_pulse`, Klient `web/src/lib/ablage/ablageUeberPulse.ts`.
- **[H] `docs/superpowers/specs/2026-08-28-selfhost-identitaet-vereinfachung-design.md:3`** — „Entwurf, noch nicht umgesetzt". Realität: umgesetzt (Cloud-Ticket-Login steht; Löschliste fast vollständig abgearbeitet).
- **[H] `docs/superpowers/specs/2026-08-28-e2e-dm-design.md:482` (§6)** — „Hinter `GERAETE_KOPPLUNG_ENABLED` … (aus)". Realität: alle vier Schalter AN (`schalter.ts`), Kopplung per E2E nachgewiesen.

### Streaming-Docs
- **[H] `streaming/README.md:110-113`** — „Windows und macOS melden `ten_bit` nicht". Realität: Windows meldet `ten_bit`+`hevc_ten_bit` ausdrücklich (`win-hq-sidecar/src/ops/health.rs:83-85`); Feld heißt zudem `health.sidecar.*`. Widerspricht Zeile 78 derselben Datei.
- **[H] `streaming/README.md:267-277`** — „Zwei Encode-Pfade (NVIDIA Zero-Copy / CPU für AMD+Intel)". Realität: drei Pfade (D3D11 Zero-Copy für NVIDIA **und AMD**, D3D12-Gegenprobe, CPU nur Intel; `win-hq-sidecar/src/encode/mod.rs:3-33`, `codec.rs:193-206`); `pipeline_hw` ist ein Verzeichnis.
- **[H] `streaming/hq-labor/README.md:42-74`** — ganze Duplikations-Tabelle (kopierte `encode/`-, `whip/`-Dateien). Realität: Labor hat seit 2026-08-02 keinen eigenen `src/`-Baum mehr (nur Re-Exporte, `hq-labor/src/lib.rs:3-21`) — Tabelle samt „Preis ist die Duplikation" gegenstandslos.

### Backup / Infra
- **[H] `infra/prod/DEPLOY.md:527-536` + `infra/prod/backup/restore.md:179-181`** — „`.env`, `secrets/jwt_*.pem`, `certs/` sind NICHT in restic, separat off-host vorhalten". Realität: seit 2026-08-07 sichert die Gruppe `config` genau diese Dateien (`docker-compose.yml:163`, `crontab:21`, `backup.sh:96-101`). Wer dem Doc folgt, hält Secrets doppelt, aber glaubt sie wären im Desasterfall nur off-host — die Annahme „none of these are in restic" ist falsch, das betrifft Restore-Doku an heiße Stelle.
- **[H] `docs/plans/2026-08-25-selfhost-erreichbarkeit-diagnose.md:10,26,58`** — „nur ein Glied, Ja/Nein", „Client kann nicht unterscheiden", „port_busy prüft nur 80/443". Realität: `reason`-Unterscheidung gebaut (`web/src/lib/api/server-info.ts:61-62`), Medienport-Checks in `web/static/install.sh:119-127`, Stufe 3 (`/health/setup`) + Diagnose-Paket existieren.

### Packaging / Desktop
- **[H] `packaging/android/README.md:1-6`** — beschreibt die TWA (Bubblewrap, `com.howispulse.pulse`) als DIE Android-App, „HQ-Streaming nicht — Desktop/Electron-only". Realität: aktuell ist der Capacitor-Wrapper `mobile/` (`com.howispulse.app`, CI `android-build.yml` baut `mobile/**`); HQ-**Wiedergabe** läuft im Browser per WHEP (`web/src/lib/stream/whep.ts`). Das README ist die Bauanleitung einer toten App.
- **[H] `desktop/electron/localBackend/README.md:26-75`** — beschreibt native Prozess-Orchestrierung (postgres/redis/minio/frpc-Binaries, `tunnel.ts`, `LocalBackendManager`, zwei Integrationstests). Realität: seit 2026-07-02 All-in-one-Container (`containerBackendManager.ts`), `tunnel.ts`+Tests gelöscht, Podman-Bündelung geparkt (2026-07-14).

### Rechts-/Lizenz-Texte im Repo
- **[H] `docs/code-schutz-und-geschaeftsmodell.md:3`** — „Pulse ist öffentlich auf GitHub (AGPL-3.0)" (tragend §§3,5). Realität: source-available, zwei eigene Lizenzen (`LICENSE:1-8`), „not open source". Das Doc begründet das Geschäftsmodell auf einer längst ersetzten Lizenz.

### Memory-Index & Memories (Auszug der schwersten)
- **[H] `MEMORY.md` (Index) → fec-produktivbetrieb-offen** — „FEC ist lokal UND auf Prod AUS". Realität: Prod hat FEC AN + adaptiv (`infra/prod/docker-compose.yml:476,524`); Chromium-Empfang belegt (Testbench-Akte 2026-07-31). Der Index widerspricht sogar der eigenen Memory-Datei.
- **[H] `memory/cert-modell-block-status.md`** — ganzer „Wegweiser" + offene Punkte zum Cert-Modell. Realität: Modell komplett entfernt (Commit `cda08a66`, 2026-08-28); alle genannten Dateien (`routes_crl.py`, `cert.ts`, `crl_poller.py` …) existieren nicht mehr.
- **[H] `memory/keyframe-abstand-und-vbv-stand.md`** — „`PULSE_KEYFRAME_SECONDS` auf 0.1..=10.0 begrenzt, fällt still auf 2,0". Realität: Vorgabe 60 s, Grenzen 0,1–120 s, Verletzung wird gemeldet (`linux-hq-sidecar/src/encode/mod.rs:782,805,728`); die Auswertungsdaten (`scratchpad/`) existieren nicht mehr.
- **[H] `memory/intra-refresh-produktion-stand.md`** — „HIER WEITER: Branch `feat/intra-refresh-produktion`, nichts gepusht". Realität: Intra-Refresh am 2026-08-21 aus dem Code entfernt, Branch existiert nicht mehr. (Dasselbe gilt für `intra-refresh-restpumpen-entscheidung.md`: die „bleibt so"-Entscheidung regelt ein gelöschtes Feature.)
- **[H] `memory/e2e-server-vault.md` (ganze Datei)** — Vault gebaut + deployed, Pfade `server-vault.svelte.ts` u. a. Realität: Vault komplett entfernt (Commit `acca64de`, 2026-06-28); alle Pfade tot.
- **[H] `memory/self-host-join-mode.md`** — 3-Wege-`join_mode` + `/admin/join-invites` + `AddServerDialog`. Realität: System entfernt (Stufe 5); Gate jetzt `routes/gates.py:49` (`enforce_join_gate`, 403 `join_not_permitted`).
- **[H] `memory/self-host-reauth-rate-limit.md`** — Cert-Login-Challenge/Verify + `_CERT_LOGIN_RATE_LIMIT` + 5-min-Session-Tokens. Realität: cert_login existiert nicht mehr; Re-Auth = `POST /me/server-ticket` (60 s Ticket, 1-h-Sitzung).
- **[H] `memory/self-host-message-identity-bug.md`** — server-lokale IDs ≠ Cloud-IDs, Store `serverUser.svelte.ts`. Realität: seit dem Ticket-Weg trivial identisch (`currentServerUser.ts:5-23`); Store gelöscht.
- **[H] `memory/self-host-hetzner-deploy.md`** — „MinIO-Abschnitte weiterhin gültig" + Watchtower-Labels/Intervall. Realität: Garage ersetzt MinIO (kein `minio`-s6-Unit), „No Watchtower — anywhere" (`infra/self-host/README.md:137`), nativer Multi-Arch-Build statt QEMU.
- **[H] `memory/account-key-sync-key-model.md` (ganze Datei)** — `account_keys`-Tabelle, `/me/account-key`, „Sync-Schlüssel". Realität: komplett gedroppt (Migration `20260628_9999_drop_user_cloud_backup`); heute Sicherung mit „PUSI"-Format (`web/src/lib/sicherung/krypto.ts`).
- **[H] `memory/community-invite-as-dm.md`** — Einladungen als DM via `_send_invite_dm`. Realität: entfernt (Migrationen `0063`, `0092`); heute Cloud-Relay + Push (`fan_out_community_invite_push`).
- **[H] `memory/watchparty-multi-per-channel-plan.md`** — „heute nur eine Party pro Channel, zurückgestellt". Realität: gebaut — `party_id` über alle Ops (`ws_watch.py:8,13`), Frontend parte-keyed, Route `/watch-popup/[channelId]/[partyId]`.

---

## B. Befunde je Quelldatei (vollständige Liste)

Format: `[Schwere] Datei:Stelle — Behauptung → Realität (Beleg)`.

### AGENTS.md, ONBOARDING, git-workflow, hooks
- [M] `AGENTS.md:10` — „Dev-App nutzt eigenes Profil `~/.config/Pulse-Dev`" → Profil setzt ausschließlich `dev-up.fish:289-290` via `--user-data-dir`; Electron-Code kennt „Pulse-Dev" nicht; ein Start nur mit `PULSE_DEV_URL` landet im Profil `~/.config/Pulse` (Trennung ist Skript-Konvention, nicht App-Eigenschaft).
- [N] `.githooks/README.md:9-10` — „repo already has it set" → hier zeigt `core.hooksPath` auf `.git/hooks`, der `.githooks/pre-push` läuft lokal gar nicht.
- [M] `.githooks/README.md:14-24` — Hook rebuilt+rsync't Flatpak-Repo → Hook ist „SUPERSEDED by flatpak.yml", ohne `PULSE_FORCE_LOCAL_PUBLISH=1` no-op; README kennt CI-Ablösung nicht.
- [N] `docs/ONBOARDING.md:100` — `pnpm install` deckt `plugins/` mit → `plugins/` ist kein JS-Workspace (`pnpm-workspace.yaml`: nur web+desktop).
- [N] `docs/ONBOARDING.md:101` — `uv sync --all-packages` „(services/*, shared/, streaming/)" → uv-Workspace: shared + services/*; `streaming/pyproject.toml` gelöscht.
- [N] `docs/ONBOARDING.md:125` — „Electron-Dev-Fenster … per Strg+C beendbar" → läuft `setsid nohup … &`; Stop nur via `dev-down.fish`.
- [N] `docs/ONBOARDING.md:14` — „CLAUDE.md + Nachtlauf-Status-Markdown in Git" → kein Nachtlauf-Markdown mehr getrackt (widerspricht auch eigener Zeile 298: `/tmp/`).
- [N] `docs/git-workflow.md:8` — Beispiel-Zweige `feat/remote-control-windows`, `wgpu30-migration` im Präsens → existieren weder lokal noch remote.
- Nicht prüfbar im Repo, aber struktur-seitig bestätigt: AGENTS.md-Migrationsbehauptung (feat/mobile hat eigene 0090–0093, main trägt andere 0090–0093) ist **nicht** veraltet.

### CLAUDE.md (24 Befunde)
- [M] `CLAUDE.md:12` — „vendored GPU Screen Recorder als Sidecar" → GSR wird nicht mehr benutzt; widerspricht eigener Zeile 14 (Entfernung 2026-08-27).
- [M] `CLAUDE.md:19-22` — Lizenz-Sync-Liste → Verzeichnis-LICENSEs services/shared/infra (PolyForm Free Trial) + mobile (PolyForm Perimeter) NICHT nachgezogen; `krypto/` fehlt auf beiden Seiten der Aufzählung.
- [N] `CLAUDE.md:30` — pyjwt-Eigenbau „in `security.py`" → lebt in `dcc_shared/token_verify.py:103` (+2 Kopien chat-gateway).
- [N] `CLAUDE.md:40` — „`@livekit/components-core` obwohl installiert" → nicht mehr installiert (web/package.json, pnpm-lock).
- [M] `CLAUDE.md:69` — „Race bei Parallel-Registrierung akzeptiert" → Advisory-Lock `pg_advisory_xact_lock(724011)` seit 2026-09-16 (`auth/routes.py:423-429`).
- [N] `CLAUDE.md:72` — `reissue_refresh` → Symbol existiert nicht mehr; Mechanik jetzt in `pruefe_wiedervorlage` (`refresh_kette.py:116-160`).
- [N] `CLAUDE.md:93` — `_set_exact` → heißt `_set_exact_triple` (`voice-signaling/reconcile.py:85`).
- [M] `CLAUDE.md:104` — „av1Nutzbar … ohne den `!isMac()`-Riegel" → Riegel steht wieder drin (`settings.svelte.ts:126-127`).
- [M] `CLAUDE.md:109,150` — `stream.gsrAvailable` → `sidecarAvailable` (`state.svelte.ts:67`).
- [M] `CLAUDE.md:149` — „Name `gsr` ist Relikt, NICHT umbenennen" → Umbenennung passiert (2026-09-21; `sidecar:call`, `window.pulse.sidecar`).
- [M] `CLAUDE.md:111-115` — chat-first-Gating über `lg`/`md`-Breakpoints, `GuildRail hidden lg:flex` → seit 2026-09-04 GERÄTEKLASSE (`geraetKlasse.ts:36-45`, `viewport.svelte.ts`, `GuildRail.svelte:366-369`).
- [M] `CLAUDE.md:138` → siehe A-Sektion (REMOTE_CONTROL).
- [H] `CLAUDE.md:153` → siehe A-Sektion (Log-Upload).
- [N] `CLAUDE.md:159` — `isDesktop()` in `runtime.ts` → existiert dort nicht; jetzt Viewport-Getter (`viewport.svelte.ts:75`).
- [N] `CLAUDE.md:159` — Route `/app/dev/stream` → gelöscht (Commit `123040b0`).
- [M] `CLAUDE.md:324` — „Klartext-Weg hat `dm_bump` an alle" → dm_bump geht nur an die zwei DM-Teilnehmer (Audit-Fix 2026-05-29; `pubsub_channel_guild.py:181-199`). derselbe falsche Satz im Kommentar `routes/postfach.py:370`.
- [N] `CLAUDE.md:170` — `_selfhost_payload` → existiert nicht mehr; Payload in `dcc_shared/session_tokens.py:255`.
- [N] `CLAUDE.md:274` — Base64-„=="-Muster `schluessel_nachweis.py`, `routes/postfach.py` → beide ohne b64decode heute; Muster lebt in `_postfach_deps.py:201`, `kopplung_umzug.py:106`.
- [N] `CLAUDE.md:243` — „`plans/2026-08-28-e2e-dm-etappen.md`" → Pfad unvollständig (liegt unter docs/superpowers/plans/).
- [M] `CLAUDE.md:379` — ws_op_gate-Codes 4040–4043 → 4043 wird nicht mehr gesendet (Guild-Toggle-Miss = 4040 „unknown op", `plugins/ws_op_gate.py:86-89,274-311`).
- [M] `CLAUDE.md:403` — „CI nur auf main real testbar (kein PR-Check)" → exakt umgekehrt: Test-Jobs laufen nur auf PRs (`ci.yml:20-21,42-43,109-110`); main-Push ohne CI-Tests; Tag-Trigger nur allinone.
- [N] `CLAUDE.md:357` — WASM „531 kB" → 541 101 Bytes.
- [N] `CLAUDE.md:419` — Port-Tabelle nennt 1935/RTMP → Plain RTMP entfernt, nur RTMPS :1936 (`streaming/server/mediamtx.yml:25-37`).
- [N] `CLAUDE.md:99` — Sync-Aufzählung stream-keys unvollständig: `ACTIVE_KEY`/`CHANNEL_STATE_KEY` fehlen (`dcc_shared/streaming.py:113,115`).

### Root-Statusdateien (16)
- [N] `PLAN.md:817-823` — `ptt.ts`/`isDesktop()`-Alias/`gsr.ts`/`streaming/gsr-sidecar/*` als IST → alle weg (Dateien gelöscht bzw. geleert).
- [N] `HALBFERTIG.md:91` — „Helfer `flushSection`/`deleteServerSection` ohne Aufrufer" → Symbole existieren nicht mehr (`server-sync.ts`).
- [N] `AUDIT_FINDINGS.md:70` — „keine Service-Dockerfiles, LiveKit :latest" → `Dockerfile.service` existiert; LiveKit gepinnt v1.13.3.
- [M] `AUDIT_FINDINGS.md:195` — „Refresh-Token im localStorage … Tauri" → HttpOnly-Cookie `pulse_rt`; Tauri-Rest 0.
- [N] `PONYTAIL_AUDIT.md:56` — „krypto/ unversioniert" → längst versioniert.
- [N] `PONYTAIL_AUDIT.md:40,65` — `web/src/lib/dropbox`-Pfad / „dev-Route löschen" → Pfad falsch; Route längst gelöscht.
- [M] `BACKUP_NOTES.md:44-90` — key-backup.svelte.ts/JWK-Export/PBKDF2-v1 → existiert nicht; heute `web/src/lib/sicherung/krypto.ts` (PUSI-Format, Argon2id).
- [M] `WINDOWS_HQ_SIDECAR.md:53,125` — „PolyForm Perimeter/Free Trial" als aktuelle Lizenz → Pulse Client/Server License 1.0.
- [M] `WINDOWS_HQ_SIDECAR.md:63,106,123,143` — Referenzen auf `gsr-sidecar/control.py`, `streaming/patches/`, `bootstrap-gsr.fish` → alles entfernt.
- [M] `IDEAS.md:9-15` — offen: Permissions-UI, Web-Push, Notifications-IPC, Win/Mac-Builds „HQ Linux-only" → alles längst gebaut.
- [N] `IDEAS.md:24-25` — offen: Markdown+DOMPurify, Typing-Indicator → gebaut.
- [M] `IDEAS.md:156,208,217` — „kein automatisiertes Backup, 2FA fehlt, Backups ungestartet" → `infra/prod/backup/` + TOTP existieren.
- [N] `IDEAS.md:280` — „keine LICENSE-Datei da" → existiert seit 2026-05-21.
- [N] `THIRD-PARTY-NOTICES.md:39 vs 79,126` — pulse-player „since 0.1.73" vs „since 0.1.69" (Widerspruch in derselben Datei).
- [N] `THIRD-PARTY-NOTICES.md:177,271` — „pulse-linux-hq-sidecar in eigenem Repo" → in-tree seit 2026-07-29.
- [N] `THIRD-PARTY-NOTICES.md:262-272 vs 18-24` — „Voll-Sweep noch offen" vs „Sweep gelaufen 2026-08-05" (Abschnitt beim Update vergessen).

### streaming/-READMEs (37)
- [M] `streaming/README.md:17` — `gsrAvailable` → `sidecarAvailable`. · [M] `:78,210` — Health-Key `gsr` → `sidecar` (alle 3 Sidecars). · [M] `:89` — „keyframe nur Linux+Windows" → mac hat die Op (`mac dispatch.rs:43`). · [H] `:110-113` → A-Sektion. · [M] `:114-119` — 10 bit nur an AV1 gebunden → HEVC Main 10 seit 2026-09-13 (`start.rs:222-227`, `settings.svelte.ts:105-106`); WHIP-Rückfall entfallen. · [M] `:3` — „alle pushen via RTMPS" → immer WHIP. · [M] `:128-133` — „Push-Protokoll entscheidet der SERVER (`MEDIAMTX_PUSH_PROTOCOL`, default rtmp)" → Client fordert fest `whip`. · [N] `:25` — ffmpeg-dist „selbst gebaut + gepatcht" → unverändertes BtbN-Paket `n8.1-lgpl-shared` seit 2026-08-21. · [H] `:267-277` → A-Sektion. · [M] `:317-320` — `gsr:call`/`window.pulse.gsr` → `sidecar:call`.
- [M] `streaming/linux-hq-sidecar/README.md:25` — „nur H264+AV1 (kein HEVC)" → HEVC Kandidat (`caps.rs:15-18,32`). · [M] `:43` — „10 bit nur mit AV1" → HEVC-10-bit-Weg. · [M] `:57` — „VAAPI hat keinen 10-bit-Zweig" → `scale_vaapi=format=p010` (`va_import.rs:215`). · [N] `:30` — `health.gsr.tls_backend` → `sidecar`. · [N] `:17` — `streaming/linux-hq-sidecar/scripts/hq-bauen.sh` → Skript liegt im Repo-Wurzel. · [M] `:46-49` — „WHIP+AV1 → Fallback H.264" → Rückfall entfallen (`start.rs:57-63`).
- [M] `streaming/linux-hq-sidecar/CLAUDE.md:84` — „kein HEVC, nicht proben" → wird angeboten und probiert. · [M] `:87-90` — ffmpeg-WHIP-Muxer/AV1-Fallback → eigener Sendeweg, kein Fallback. · [N] `:359` — `health.gsr.ten_bit` → `sidecar`. · [N] `:45-49` — Op-Liste ohne `clip_save` → fehlt (`dispatch.rs:51`).
- [M] `streaming/win-hq-sidecar/README.md:3-8` — „Gegenpart zu `streaming/gsr-sidecar/`", `health.gsr.*`, `gsr:call` → alles alt. · [N] `:86` — `health.gsr.hdr` → `sidecar`. · [N] `:50` — `gsr-sidecar/profiles.py` → entfernt. · [N] `:59,136` — `stream_controller.rs`/`pipeline_hw.rs` als Dateien → Verzeichnisse.
- [N] `streaming/mac-hq-sidecar/README.md:5` — „Linux = gsr-sidecar" → `linux-hq-sidecar`. · [M] `:115-129` — „Twin-Tabelle in ops/mod.rs says the same; change both or neither" → Tabellen auseinander (direct_offer/direct_stop/clip_save fehlen in README).
- [H] `streaming/hq-labor/README.md:42-74` → A-Sektion. · [M] `:84-87` — „WHIP fällt auf H264 8 bit zurück" → falsch (eigener WHIP-Sendeweg).
- [M] `streaming/hq-labor/EINRICHTUNG.md:21-27` — Arbeit auf Zweigen `werkzeug/pruefstand-labor-server`, `feat/native-hq-player` → existieren nicht; Stand auf main. · [M] `:156-158` — `intraref-verlust.py` → gelöscht.
- [N] `streaming/hq-labor/CLAUDE.md:437` — „`web/src/lib/player/**` gibt es auf main nicht" → existiert.
- [N] `streaming/pulse-player/README.md:83` — `src/overlay.rs` → Verzeichnis `src/overlay/`. · [N] `WISSENSSTAND.md:94` — `jitter_ms` Vorgabe 20 → 100 (`proto.rs:353`). · [N] `WISSENSSTAND.md:276` — „RTMPS→WHIP-Entscheidung steht aus" → entschieden+umgesetzt.
- [M] `streaming/player-labor/cuda-vulkan-import/README.md:8-10` — „Heute Hauptspeicher-Weg" → CUDA-Weg ist Vorgabe seit 2026-08-07 (`decode.rs`-Kopf). · [M] `streaming/player-labor/cuvid-cuda-ausgabe/README.md:11-14` — „Modulkopf sagt bis heute nein" → sagt das Gegenteil.
- [N] `streaming/testbench/README.md:31` — „88 Messakten" → 119.

### docs/-Referenzdocs (17)
- [H] `docs/fernsteuerung.md:19` → A-Sektion (REMOTE_CONTROL). · [M] `:111` — `gsr:ablageEnde` → `sidecar:ablageEnde`. · [N] `:63` — „Bedingung steht doppelt, ein Platz = keine Stromliste" → seit 2026-08-25 auch label/monitor_index (`media-svc poller.py:89-104`, `routes.py:704-708`).
- [M] `docs/selfhost-erreichbarkeit.md:8` — „acht Glieder" → neun (Anmeldeweg, `selfhost_probe_anmeldeweg.py`). · [N] `:17` — `crl_poller` → `jwks_poller`. · [N] `:19` — `cert_login.py::is_owner_admin` → weg; jetzt `routes/session_ticket.py:116-129` (`ist_betreiber`). · [N] `:25` — „Befund-Texte an EINER Stelle: diagnose_texte.py" → drei Module (`_betreiber`, `_anmeldeweg`).
- [M] `docs/medien-speicher-und-scanning.md:32` — MinIO → Garage. · [M] `:37,72` — presign-TTL default 600 s → 1800 s (`chat-gateway config.py:74-78`).
- [H] `docs/code-schutz-und-geschaeftsmodell.md:3` → A-Sektion (AGPL).
- [M] `docs/INSTANCE_APPROVAL_POLICY.md:123` — „Secret per E-Mail" → .env-Download/rotate-secret-Antwort, nie E-Mail. · [M] `:134` — CRL-Push/Sperre → suspended-instances-Poller 60 s. · [M] `:140` — Status `revoked` + 30-Tage-Grace → Statuswerte active|suspended|deleted; Hostname sofort frei.
- [M] `docs/PLUGIN_MANIFEST.md:129` — `plugin_settings`-Tabelle/„alle Plugins aktiv" → existiert nicht; Allowlist-Modell (`chat.instance_plugin_allowlist`).
- [M] `docs/user-gehostete-kanaele-konzept.md:360` — „hinter `ABLAGE_KANAL_ENABLED` (aus)" → `= true` (`featureFlags.ts:43`).
- [M] `docs/PRIVACY_SELF_HOST_TEMPLATE.md:62` — „CRL-Fetch" → entfallen (nur JWKS).
- [N] `docs/managed-server-vermietung.md:86` — Stack mit MinIO → Garage; All-in-one-Compose.

### infra-Docs (13)
- [H] `infra/prod/DEPLOY.md:527-536` → A-Sektion. · [M] `:441-451` — Backup-Plan ohne `config`-Zeile → 6. Gruppe täglich 04:40.
- [M] `infra/prod/backup/restore.md:179-181` → A-Sektion (gleiche Annahme).
- [M] `infra/self-host/README.md:106` — Komponententabelle MinIO → Garage v1.1.0 im Image (widerspricht eigener Architektur-Sektion Z. 214). · [M] `:72-84` — docker-run-Ports ohne TURN-Relay 49160-49200/udp → ohne sie tote TURN-Relays (`docker-compose.yml:68`). · [M] `:199-268` — s6-Unit-/cont-init-Liste → fehlen backup/direct-adapter/frpc, `11-render-frpc.sh`; `init-garage.sh` heißt `garage-init`-Unit; caddy hängt nicht an auth.
- [N] `infra/self-host/templates/README.md:3-13` — „Phase 6.B befüllt Verzeichnis, Caddyfile/mediamtx-Template/pulse-health hier" → liegt woanders bzw. existiert nicht; Platzhalter heißen `@@LIVEKIT_KEY@@/@@LIVEKIT_SECRET@@`.
- [M] `infra/dev-remote/README.md:82-88` — Build-Tag `pulsetest-chat-gateway:local` → compose erwartet `pulsetest-chat:local` (`docker-compose.yml:139,181`). · [M] `:8-14` — „Bind-Mounts, keine Named Volumes" → compose definiert `pgdata`/`garagedata`. · [M] `:66-68` — „uv.lock zuletzt 2026-07-01, Images aktuell" → uv.lock zuletzt 2026-09-18 (Commit `23e2dff1`).
- [N] `infra/mediamtx-fork/README.md:50,71` — Pins pulse4/pulse5 → pulse7 (`Dockerfile:88`, beide Composes). · [N] `:74-76` — Watchtower-Label im Image → keine Labels gesetzt.
- [N] `infra/prod/docker-compose.yml:1` (Header) — „Hetzner VPS = production" → Produktion ist netcup seit 2026-05-28.

### Aktuelle datierte Docs (16)
- [M] `docs/2026-09-20-bughunt-offene-entscheidungen.md:245` — „Clip-Stack komplett gebaut, kein Renderer-Aufruf" → Renderer ruft überall auf (Release 0.1.88 verdrahtet; `player/store.svelte.ts:367,378,395`, `shadowClip.ts:18`, `main.ts:1181-1186`). · [M] `:7` — „2.5 (dev-up.fish-Loops) umgesetzt" → Warte-Loops brechen weiter still nach 30×0,3 s (`dev-up.fish:225-233`). · [N] `:252-259` — Toter-Code-Liste (`anzahlBerechtigte`, `getDirectConnection`, `sicherungClientKonfiguriert`) → alle drei Symbole längst entfernt.
- [M] `docs/2026-09-20-bughunt-serie.md:34,109,177` — „MinIO-Pin 410 akut" → MinIO komplett entfernt (Garage). · [N] `:214-229 vs 256-271` — zwei Tabellen „Teil 4: Runden 33–42" mit widersprüchlichem offen/erledigt-Stand. · [N] `:229,264` — Runden 35/36 „offen" → erledigt (Code belegt).
- [M] `docs/ablage-bughunt-2026-08-31.md:187` (B12) — „kein Adapter setzt `lösche` um" → dropbox/webdav/gdrive/syncOrdner tun es jetzt; · [M] `:175` (B11) — „`auffrischeZugang` wird von niemandem aufgerufen" → `sicherung/ziele.ts:272` + Adapter-Fehlerpfade; · [M] `:166` (B10) — `AblageSektion.svelte`/localStorage-Hauptschlüssel → Datei weg, Umzug dokumentiert; · [M] `:205` (B13) — „Verzeichnis-Griff wird nirgends abgelegt" → `AblageVerbindenDialog.svelte:122-135`.
- [M] `docs/ablage-umsetzung-stand.md:43-49` — offen „Megolm für Ablage-Kanäle" → gebaut (`kryptoBehaelter.ts`, `kanalFestigung.ts`, e2e-ablage-kanal.spec.ts). · [N] `:49-51` — „Kopplungs-E2E braucht eigenes Spec" → existiert (`e2e-kopplung.spec.ts`).
- [M] `docs/ablage-krypto-schnittanalyse.md:24,94` — „drei Schalter, alle AUS" → vier Schalter, alle AN; beide Stränge auf main.
- [N] `docs/2026-08-27-streaming-audit.md:192` — „REMB wird nur unter Windows gelesen" → widerspricht §2.2 (REMB-Behhebung in pulse-whip, alle Sidecars). · [N] `:343` — offen „nach pulse6 umstellen" → pulse7 überall. · [N] `:348` — „Mac-Tests in keinem Gate" → gate-rust.sh fährt sie (seit 2026-08-26).
- [N] `docs/2026-09-07-direktweg-berechtigung.md` — Owner-Gate stimmt (Fix 2026-09-23 bestätigt).

### Specs (14)
- [H] e2e-dm-design §3a + §6 + §1 + §10 → A-Sektion bzw. oben; zusätzlich: §1 „Es gibt heute keinerlei Inhaltsverschlüsselung" + Geräteverzeichnis über `routes_credentials.py` → beides überholt (Verschlüsselung Normalweg; Datei gelöscht); §10 „G2 Megolm noch nicht geplant" → gebaut (`web/src/lib/krypto/gruppe/`).
- [H] diagnose-berichte / pulse-laufwerk / selfhost-identitaet → A-Sektion.
- [M] einladungen-ohne-dm §8 — „api/community-invites.ts und communityInvites.ts zusammenführen" → beide existieren weiter nebeneinander (Server-Teil drin, Klienten-Teil nicht); Statuszeile der Spec veraltet.
- [M] mobile-chatfirst-design §3.3 — Breakpoints `md`/`lg` als Steuerung → Geräteklasse seit 2026-09-04.
- [M] fernsteuerung-macos-design — „noch nicht umgesetzt" + `health.gsr.remote_input` → gebaut (`mac-hq-sidecar/src/remote_input/`); Wire-Key jetzt `sidecar.*`.
- [N] gast-links-design — Tabelle ohne `valid_from` → Migration `0089_gast_zeitfenster` (2026-09-05).
- [N] watch-party-host-handoff-design — „bereit für Implementierung" (Auto-Handoff) → Gegenteil gebaut (host-sticky + Gnadenfrist); Spec trägt keinen Ablösungs-Vermerk.
- [N] mac-player-design — „Player wird auf macOS gar nicht gebaut" → seit 2026-08-20 in mac-build.yml + electron-builder extraResources.

### packaging/desktop/legal (13)
- [H] `packaging/android/README.md` → A-Sektion. · [M] `:71` — assetlinks.json-Anleitung → Datei existierte nie, nginx-Whitelist ohne sie. · [N] `:20` — „*.apk/*.aab nie committet" → `app-release-signed.apk.idsig` ist getrackt.
- [N] `packaging/README.md:167` — „Electron-42 binary" → 43 (Manifest + package.json; interner Widerspruch zur eigenen Zeile 6). · [N] `:74-82` — paths-Liste unvollständig → 7 gemeinsame Crates + esbuild.mjs fehlen.
- [M] `desktop/resources-podman/README.md:4-6` — CI lädt podman.exe → Step entfernt (2026-07-14). · [M] `desktop/resources-podman-mac/README.md:4` — `scripts/fetch-mac-podman.sh` → existierte nie.
- [H] `desktop/electron/localBackend/README.md:26-41` → A-Sektion. · [M] `:53-75` — media.int.test/manager.int.test → gelöscht. · [M] `:11-13` — „binden echte Ports 7882/8189/7881/1936" → heutige Tests binden Port 0. · [N] `:23` — „sieben Unit-Tests" → neun Dateien, `netdiag.test.ts` fehlt in test:unit.
- [M] `web/src/lib/legal/drittanbieter.md:148` — „zwei Stellen von webrtc-rs 0.17.2 verändert" → dritter Patch `0003-h264-stapa-bounds-check.patch` fehlt in der Offenlegung (Apache-2.0 §4(b)).
- [H] `web/src/lib/legal/datenschutz.md:139` → A-Sektion.

### plans-Sweep (32; Kompaktliste)
Als offen/ungebaut markiert, längst gebaut: [H] `2026-08-25-selfhost-erreichbarkeit-diagnose`; [H] `2026-08-19-befunde-gnadenfrist-zusammenspiel` („Nichts davon ist repariert" → `_end_reason`-Fix vorhanden); [M] `2026-06-23-multi-hq-stream` („Idee, kein Code" → Slot-System gebaut); [M] `2026-07-13-unified-hosting-applications` („noch nicht gebaut" → vereint, Migration 0044); [M] `2026-08-20-mac-whip-sender` (41 offene Boxen → `mac-hq-sidecar/src/whip/`); [N] etappe-0-zwillingsnetz, [N] etappe-1-2-redact-zeitbasis, [N] etappe-3-pulse-whip; [M] mac-bild-ton-trennung („ein SCContentFilter" → zwei SCStreams gebaut); [M] 2026-08-20-geraeteverwaltung (75 Boxen → Migration 0060 + geraete.py); [M] dependency-descriptor (60 Boxen → av1.rs bildnummer); [M] fernsteuerung-macos-1 (79 Boxen → pulse-fernsteuerung + remote_input); [M] mobile-chatfirst (79 Boxen → mobile-Komponenten); [N] fernsteuerung-macos-1b, [N] fernsteuerung-macos-4; [M] bildschirm-karte-im-overlay (21 Boxen → overlay/schirmkarte); [M] eindeutige-zuordnung-strom-bildschirm (24 Boxen → monitor_index bis Kachel); [N] fenster-wie-beim-host-anordnen; [N] wayland-zug-ueber-das-datengeraet; [M] ziehen-ueber-die-fenstergrenze (37 Boxen → Umziel-Logik); [M] installer-audit-behebung (79 Boxen → Installer-Tests existieren); [M] etappe-a-krypto-kern (32 Boxen → Kiste im Einsatz); [N] etappe-b, [N] etappe-b2, [N] etappe-c1, [N] etappe-c2, [N] etappe-d, [N] etappe-d2, [N] etappe-g1 („private Gruppen gibt es heute nicht" → gebaut); [M] selfhost-cloud-ticket (68 Boxen → Phase 1 gebaut); [M] zwischenablage-1-kiste (32 Boxen → pulse-ablage); [M] zwischenablage-1b1-der-weg (36 Boxen → auch Host-Seiten 1b-2/1c gebaut).
Korrekt/kein Befund u. a.: 2026-09-06 P2P-Stufe 1, Übergabe-Docs 2026-08-20/22 (markiert), e2e-dm-etappen (selbst „ÜBERHOLT"), ablage-e*.

### Sync-Paare (7)
- [M] Lizenz-Sync → siehe CLAUDE.md-Sektion; zusätzlich `README.md:20` (Client-Liste ohne Logo//scripts/) und `README.md:11` („verändern" vs. Verbots-Tabelle 3 Zeilen tiefer). In Sync: metainfo.xml ×2, allinone-OCI-Label, impressum, CLA, krypto/Logo/desktop/streaming/packaging/scripts/plugins/web-LICENSEs.
- [M] REMOTE_CONTROL-Kommentar in `kanalrechte.ts:97-99` → Bits selbst vollständig synchron (25 Namen geprüft).
- [N] CLAUDE.md:99 Stream-Key-Aufzählung unvollständig (ACTIVE_KEY/CHANNEL_STATE_KEY).
- [N] `ws.py` ↔ `constants.ts`: 4009 fehlt im Klienten; 4045/4047 haben keinen Absender mehr (Sync-Beziehung asymmetrisch).
- [N] `pulse.d.ts` dokumentiert leeres `PulseClipboardApi` ohne Preload-Pendant (readImage-Brücke entfernt).
- [M] gsr→sidecar in CLAUDE.md/pulse.d.ts-Kommentaren → siehe oben.
- [N] `win/linux-hq-sidecar/Cargo.toml` verweisen auf `streaming/pulse-remote-webrtc` → Kiste nicht versioniert/im Repo (Verweis ins Leere; Fassungs-Gleichheit stimmt trotzdem).

---

## C. Memory-Dateien (~/.claude/projects/-home-michael-Dokumente-Pulse/memory/) — 51 Befunde

Die schweren stehen in Sektion A. Hier die restlichen (M=mittel, N=niedrig):

**Index `MEMORY.md`** führt ferner mit überholtem Stand: community-invite-as-dm (DM-Modell weg), e2e-server-vault („noch NICHT deployed" → Feature komplett entfernt), account-key-sync-key-model (Modell gedroppt), self-host-hetzner-deploy (Watchtower/Compose-Stand), session-stand-2026-06-23 („MORGEN WEITER" auf gelöschten Branches), hq-streaming-messreihe („MORGEN WEITER" — alle vier Schichten erledigt, NACHTRAG fehlt im Index), self-host-fallstricke-todo („14 offen" → Datei selbst sagt „ALLE ENTSCHIEDEN"), self-host-multi-backend-plan („Implementation nicht gestartet" → gelandet).

Weitere Memories:
- [M] `account-switch-leak-and-backup-gate.md` (Pakete 2+3) — key-backup/Backup-Gate-Dateien weg; Beitritt über Cloud-Ticket (`server-ticket.ts`, `add-server-flow.ts`). Paket 1 weiter korrekt.
- [M] `app-hosting-container-status.md` — Podman-Phase 2/3 „erledigt" → Bündelung geparkt (2026-07-14), `LocalHostingWinSetup.svelte` entfernt.
- [N] `spatial-audio-stage1-status.md` + Index — „Tip 43429a7 via reflog wiederherstellbar" → Objekt garbage-collected.
- [N] `session-stand-2026-06-05.md` — Privacy-Leak `pulse.servers` „Entscheidung steht aus" → gefixt (`keepOnlyCloud()`, `servers.svelte.ts:261-273`).
- [M] `selfhost-instance-deletion-todo.md` — „Suspend-Liste konsumiert niemand" → suspend_poller seit 2026-07-27.
- [M] `self-host-host-updater.md` — Default-Image ghcr.io → `registry.howispulse.com/pulse-allinone:edge` (`install.sh:27`); Watchtower-Pfade weg.
- [M] `self-host-multi-backend-plan.md` — Mockups `self-host-explainer.html`/`self-host-ui.html` → gelöscht; Cert/CRL-DEs überholt.
- [M] `e2e-pulse-instance-mode-cloud.md` — „globalSetup setzt kein PULSE_INSTANCE_MODE" → setzt Default `cloud` (`_globalSetup.ts:373`); Workaround obsolet.
- [M] `pulse-local-dev-setup.md` — MinIO im Dev-Stack, MediaMTX 1.17.1-pulse, „nicht plug-and-play (Ports)" → Garage, `1.19.1-pulse7`, `.env`-Defaults 5434/6380 gesetzt.
- [M] `version-policy-edge-semver-clash.md` — „Phase 4 noch nicht gebaut" → Frontend-Enforcement gebaut (`MIN_SERVER_VERSION='0.8.0'`, `server-info.ts:143`).
- [N] `self-host-one-command-installer.md` — `install-guide.md`/`/install/guide`/`InstanceSetupDialog.svelte` → alle weg (heute `InstanceSetupPanel.svelte`).
- [N] `self-host-invite-host-param.md` — Route `/invite/[code]` + cert-login-Schritt → weg (heute `/app/invites`, Ticket).
- [N] `self-host-avatars-and-voice-resync.md` — `scripts/backfill-avatar-hashes.py` → gelöscht (Ponytail-Audit).
- [N] `flatpak-electron-startup-failures.md` — App-ID `com.unicutmedia.Pulse`, `wireUpdater` → `com.howispulse.Pulse`, `startUpdater`.
- [N] `self-host-e2e-test-progress.md` — `SELF_HOST_TEST_FINDINGS.md` (Repo-Root) existiert nicht; GSR-Bezug tot.
- [N] `global-friends-branch-status.md` — `community_invites`-Broker → gedroppt (Migration 0092); `inviteLink.ts` existiert wieder.
- [N] `self-host-admin-gating.md` — „Cert-Login mintet admin-Claim" → Cloud-Ticket-Vergleich (`owner_admin_log.py`); Frontend-Muster weiterhin korrekt.
- [M] `friend-system-tech-debt.md` — Dateigrößen (pubsub.py 1314 Z. → 896, ws.py 995 → 253 …), `window.confirm`, fehlender Toast → alles überholt (Split, confirmDialog, OS-Notification).
- [M] `simplify-scan-workflow.md` — `scripts/source-size-scan.py` → gelöscht; Workflow bricht ohne die args ab.
- [M] `security-audit-2026-06-10.md` — „bewusst offen: Refresh-Token im localStorage; mention-candidates ohne Guild-Filter; GSR capture_source" → alle drei erledigt/gegenstandslos (Cookie, Fix `mention_search.py:94-99`, GSR weg). TOTP-Klartext + reports-Visibility weiterhin offen (korrekt).
- [M] `mobile-background-mic-limitation.md` — „nativer Wrapper aufgeschoben, TWA löst das nicht" → Capacitor-Wrapper mit Mic-Foreground-Service gebaut (`mobile/android/.../AndroidManifest.xml`).
- [M] `mobile-tablet-mockups.md` — Drawer/Hamburger `mobile-menu-toggle` → neu gebaut (Bottom-Tab-Bar/Sheets).
- [M] `hq-streaming-connection-tuning.md` — GSR-Keyframe 2 s, „TURN bewusst nicht eingebaut" → GSR weg; coturn gebaut (self-host; Prod weiterhin ohne, Google-STUN im whep.ts).
- [M] `electron-dev-start-fallen.md` — „Startskript scratchpad/start-electron.sh immer benutzen" → `scratchpad/` gelöscht (Fallen-Beschreibungen weiterhin zutreffend).
- [N] `link-previews.md` — „Offen: Changelog+Commit+Push+Live-Test" → alles erledigt (Stufe 2 weiterhin offen, korrekt).
- [N] `youtube-live-watchparty-loop-fix.md` — „Offen: Changelog+Push+Live-Test" → Commit auf main; Fachkern korrekt.
- [N] `media-moderation-plan.md` — Hook-Anker `attachments.py:258` → jetzt :369.
- [N] `hdr-linux-kwin-tonemapper.md` — `PULSE_PLAYER_HDR_BEZUGSWEISS` + `testbench/hdr-kwin/BEFUND.md` → env nicht mehr im Code, Verzeichnis weg.
- [N] `changelog-no-emojis.md` — „historische Einträge emoji-frei" → Eintrag 2026-08-05 trägt 🚀 (`web/static/changelog.json`).
- [N] `friend-*`/`self-host-message-identity` siehe oben (A-Sektion bzw. Liste).
- Kein Befund (weiterhin korrekt): alembic-32-char-Limit, desktop-global-shortcuts-wayland, git-add-aborts, logout-on-deploy, no-shipping-until-perfect, playwright-route-glob-trap, plugin-sandbox-future, pulse-messmethodik-fallen, pulse-terminology, ui-copy, ursache-statt-umgehung, no-giant-parallel-tool-batches, watch-party-sync-research, repo-private-registry-strategy, watchtower-skips-migrate (selbst als behoben markiert), allinone-gha-cache-flake, lokal-bauen/lokal-testen, hetzner-selfhost-instanz, selfhost-auto-update-entwurf (Spec-Branch existiert, nicht auf main — so beschrieben).

### `.zcode/plans/`
- `plan-sess_971560c2…` (P2P-Direktpfad Mac) — Plan abgearbeitet (`mac-hq-sidecar/src/direct/`, `ops/direct_offer.rs`, `ops/direct_stop.rs` existieren); kein Befund, kann archiviert werden.

---

## D. Explizit nicht prüfbar (kein Befund, aber erwähnt)

- Live-Zustände außerhalb des Repos: netcup/Hetzner-Container, Crontabs, Registry-Sichtbarkeit, UFW, `latest.yml`-Stand, ob assetlinks.json auf dem Live-Server liegt.
- Laufzeit-/Messbehauptungen (Testzahlen, fps, Prozent, Latenzen) — nur per Ausführung prüfbar.
- `~/.claude/plans/`-Dateien (z. B. die in self-host-multi-backend-plan referenzierte) — nicht mehr vorhanden.
- Ob das 🚀 im Changelog-Eintrag 2026-08-05 eine spätere Freigabe war (changelog-no-emojis).
- `.superpowers/sdd/`-Archiv (62 Dateien, Task-Briefs/Reports des Installer-Audits 2026-08-25): als abgeschlossener Lauf historisch klassifiziert, nur stichprobenartig (der zugehörige Plan wurde über die Umsetzungs-Tests als größtenteils erledigt befundet).
- `graphify-out/` + `streaming/player-labor/wgpu-cuda-import/graphify-out/`: generierte Graph-Artefakte mit eigenem Git — keine Behauptungsquelle.

## E. Empfehlung (nicht umgesetzt — dieser Branch enthält nur den Bericht)

1. **Zuerst die Rechts-nahesten:** datenschutz.md um den Diagnose-Log-Upload (default AN!) ergänzen; drittanbieter.md um Patch 0003; die 4 PolyForm-Verzeichnis-LICENSEs + WINDOWS_HQ_SIDECAR.md + code-schutz-Doc auf die aktuellen Lizenzen ziehen.
2. **Dann die handlungsleitenden Kerndateien:** CLAUDE.md (24 Stellen), AGENTS.md (Profil-Zeile), streaming/README.md + Sidecar-READMEs (gsr→sidecar, HEVC-10-bit, Drei-Pfade, Push-Weg), docs/fernsteuerung.md (REMOTE_CONTROL), docs/selfhost-erreichbarkeit.md (9 Glieder), infra/prod/DEPLOY.md + restore.md (config-Backup), packaging/android/README.md (TWA→Capacitor oder löschen), desktop/electron/localBackend/README.md (neu schreiben oder löschen).
3. **Memory-Aufräumen:** die 13 als ganz/mehrfach veraltet befundenen Memory-Dateien löschen oder mit „VERALTET <Datum>"-Kopf versehen (cert-modell-block-status, e2e-server-vault, account-key-sync-key-model, community-invite-as-dm, watchparty-multi-per-channel-plan, self-host-join-mode, self-host-reauth-rate-limit, self-host-message-identity-bug, self-host-hetzner-deploy, intra-refresh-*, keyframe-abstand-und-vbv-stand), und den `MEMORY.md`-Index nachziehen.
4. **Erledigte Pläne archivieren:** die ~30 Plan-Dateien mit offenen Checkboxen zu gebauten Features entweder abhaken oder in ein `docs/plans/archiv/` verschieben; das bughunt-serie-Doc um eine Korrektur der doppelten „Teil 4"-Tabellen ergänzen.
5. **Code-Kommentare nicht vergessen:** `kanalrechte.ts:97-99`, `routes/postfach.py:370`, `persistence.ts:8`, `pulse.d.ts` (PulseClipboardApi), Sidecar-Cargo.toml (pulse-remote-webrtc-Verweis).
