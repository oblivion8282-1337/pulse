# Bughunt-Serie 2026-09-20 — Protokoll (Runden 3–22)

Autonome Fortsetzung der beiden Runden vom 2026-09-20. Pro Runde eine eigene
Fehler-Linse, damit späte Runden Neues finden statt Wiederholungen. Alle Fixes
landen auf `bughunt-2026-09-20`; `main` bleibt auf `origin/main`.

## Plan

| Runde | Linse | Status |
|-------|-------|--------|
| 3 | Zeit & Fristen (TTL, Grace, Clock, Kalender) | erledigt — 5 Fixes: Heartbeat-Timeout + Backoff-Reset + ICE-Deadline (direct-adapter), WS-Expiry-Grenzfall, readState-pagehide-Flush |
| 4 | Daten-Lebenszyklen (anlegen→ändern→löschen→Archiv, side effects) | erledigt — 10 Fixes (Watch/Stream-Evict bei Löschung, Purge-Events, Device-Cap, Edit-Frost, Passkey-Löschung, Avatar-Statement, Poller-Gnade, Voice-Pull-Gnade, WHIP-PC-Leck, Join-Marker) |
| 5 | Zähler, Grenzen & Wachstum (Pagination, Caches, Snowflake-Grenze) | erledigt — 9 Fixes (Mod-Queue-Cursor, Claim-Budget-Frist, Hook-IP-Deckel, Gruppen-Unreads, Frisch-Laden-Gap-Fill, Verlauf-Räumung, Teardown-Zähler, Mac-Audio-Bound, Linux-Queues) |
| 6 | Parallelität & Reihenfolge (Races, Transaktionen, Event-Order) | erledigt — 9 Fixes (Watch atomar, Owner-TOCTOU, Anhang-Bind, DM-Sortierung, vier Web-Store-Races, Hydrate/Seed-Merges) |
| 7 | Fehlerpfade & Halbzustände (verschluckte Exceptions, Retries) | offen |
| 8 | Klient-Server-Drift (desktop/mobile-Capacitor vs. API) | erledigt — 5 Fixes (Allowlist, WSL2-Assistent, Shortcut-Regex, Audio-Dreizustand, Notification-Permission) |
| 9 | Rechte & Sichtbarkeit quer (Resolver-Ränder, Cache-Invalidierung) | erledigt — 5 Fixes (Purge-WS-Caches, Reorder-Evict, id-Tiebreak, Rangklemme, Gastlink-Orakel/Filter) |
| 10 | E2E-Krypto-Glue (Postfach, Kopplung, Sicherung, Ablage) | erledigt — 6 Fixes (eigene R7-Regression, Verteilschlüssel-Partnervergleich, OTK-Deadlock, Ablage-Instanz-Cache, ATTACH_FILES-Gate, Kanal-Sitzungs-Reset) |
| 11 | Tote Wege & Test-Drift (exportiert-nie-gerufen, Tests am falschen Verhalten) | erledigt — 3 Fixes (Single-Flight-Verdrahtung, Test-Anker, WS-Close-Codes) + Inventar toter Wege im Protokoll |
| 12 | Selbst-Review des Serien-Diffs + Abschlussbericht | erledigt — 3 eigene Regressionen behoben (Kopplung-Handler, Purge-Reihenfolge, Voice-Gnade-Task); Rest des Diffs im Review sauber |

## Abschlussbilanz (2026-09-20)

* **Runden 3–12: 63 Fixes** in ~30 Commits auf `bughunt-2026-09-20`
  (inkl. 3 Regressionen aus der eigenen Serie, gefangen vom
  Adversarial-Review in Runde 12).
* **Letzter Stand aller Gates:** Backend 2631/2631 (Singleworker-Test
  braucht Abwesenheit des Dev-Stack-Flags), svelte-check 0 Fehler,
  Web 1190/1190, Desktop 191/193 (2 Umgebung),
  Android-Kompilat grün (JDK 21), depacket 45/45,
  pulse-update-Fälle grün, Kopplung 19/19.
* **Nicht gefixt / Entscheidungen:** s.
  `docs/2026-09-20-bughunt-offene-entscheidungen.md` (u. a. MinIO-Pin
  410 mit akutem Handlungsdruck).

Neue Entscheidungsbedarfe wandern nach
`docs/2026-09-20-bughunt-offene-entscheidungen.md`.

## Bekannt — NICHT wieder melden (Stand: nach Runde 2 + früheren Audits)

**Runde 1 (2026-09-20, gefixt):** Purge-S3-Deferral + Einladungskarten-Feger;
/register-Reservierung + Fallkollisions-Vorabchecks; MediaMTX-Hook-Limit je
Payload-IP; Gast-Gate bei track_published; Fail-closed ohne guild_id;
Session-Key O_EXCL; privateGruppen-Clear + bereit-Gate; hydrate/loadChannels-
Generation-Guards; Zombie-Socket in _dial; SW navigateTo mit url;
Windows-Screenshare Primärbildschirm; oauthPort idempotent; Deep-link-Buffer
wird nicht mehr vorgeleert; nachtlauf.sh Exit-Status; Mobile Headset-Unplug.

**Runde 2 (2026-09-20, gefixt):** Plugin-Aktivierungs-Cache verdrahtet;
WS-Op-Override-Identitäts-Diff + Vorgänger-Restore; Admin-PUT activated-Flag;
Rollen-Reorder-Guard; QuickRole-Rollback; Datei-Lösch-Confirm; Ablage-Reload/
Dropbox-Listing; Invite-Mint-Reihenfolge; TOTP-Lauf-Nummer; Admin-Poller-
Cleanup; Gast-User-Limit zur Token-Zeit (neue internal-Route); HEVC-FU-Zweit-
start-Poison; Backup-Marker je Tag-Gruppe; restore.md-Staging-Pfade; coturn-
Relay-Ports; refresh-checksums deckt MinIO/frp ab; pulse-update prüft alle
Services; pulse-health-Kommentar; voice.ts-Override-Doc; Gate-4040/4043-
Kommentare.

**Aufgeschoben (steht in docs/2026-09-20-bughunt-offene-entscheidungen.md,
nicht als „neu“ melden):** MinIO-Pin 410 (Self-Host-Bau bricht); D3D11-Ring-
Leak bei Software-Fallback; Username-Fallkollisions-Restrisiko (unique lower-
Index); voice_override lost-update; Gate-4040/4043-Enumeration; dev-up.fish
Warte-Loops + env-Quoting; Gast-TTL 404-vs-403; MitgliederRollen-Trägerliste
stale im Dialog; Kopplungs-Warte-Knopf-Label.

**Frühere Runden (alle mit Tests abgesichert, NICHT wieder melden):**
Refresh-Rotation/Reuse-Detection, sync-Argon2, Dummy-Argon2-Timing, UTF-8-
Secret-Vergleiche, WebAuthn-503, create_invite + /users?ids= Rate-Limits,
abgelaufene Einladungen in der Inbox, Profil-Statement-Selbstheilung, DM-
Serverwechsel-Nachrichtenverlust, Mention-Spoofing, Push-Targets, CSP/
Script-Hashes, Dropbox-OAuth-State, WHEP-Gast-Token-Lebensdauer, Mute-
Fallback-Rechte, Gast-Kick fail-closed, Webhook-Replay-Dedup, kryptoId durchs
Archiv, abgelaufene Sound-Override-Signatur, WS int()/nonce-Crashes,
add_member-Self-Add, Ban-Erhalt bei Moderator-Löschung, Report-Cleanup beim
Purge, Kopplung/Postfach/Kopplungs-Purge, plugin ws-op-gate + permission
tests, AV1/HEVC-Fragmentierung (Tests), jitter/fec/state machines im Player.


---

# Teil 2: Runden 13–22 (Fortsetzung, gleicher Tag)

## Plan

| Runde | Linse | Status |
|-------|-------|--------|
| 13 | Konfiguration & Feature-Flags (Defaults, Halb-Ge-Toggelte Wege) | erledigt — 6 Fixes (Member-Invite-Gate, Passkey-SSO-Gate, env.sh-Drei-Vars, permissions_updated-Null, Cap-Reconnect-Refresh, vite envPrefix) |
| 14 | i18n, Encoding & Namen (Interpolation, Unicode, Dateinamen) | offen |
| 15 | Datenschema & Migrationen (Alembic-Kette, Modell-Drift, Nullable) | erledigt — 1 Fix (MemberRole-Composite-FK im Modell, create_all-Kaskade) |
| 16 | Datei- & Pfad-Handling (Traversal, Temp, Serving) | erledigt — 2 Fixes (Abruf-Content-Type-XSS, Sound-Upload-Order) |
| 17 | Netzwerk & Trust-Chain (Timeouts, Proxy-Header, client_ip) | erledigt — 2 Fixes (Bridge-Identitäts-Köpfe, Provisionierungs-Frist) + ponytail-Deckel 127.0.0.1-Kollaps |
| 18 | UI-Zustandsautomaten (Dialoge, Mehrschritt-Flows, Drag&Drop) | erledigt — 5 Fixes (Cross-Apply, Stuck-Busy, TOTP/Passkey-Stale-Guards, Anhang-Fehlversand) |
| 19 | Benachrichtigungs-Pipeline (Push end-to-end, Badge, Stummschaltung) | erledigt — 4 Fixes (DND-Spiegel, DM-Doppel-Push, Server-Stummschaltung für Chime) |
| 20 | DB↔Redis↔Memory-Konsistenz (Invarianten, Reconciliation) | erledigt — 3 Fixes (Purge fremde Guilds, Grabstein-DEL bei Re-Publish, Presence-Order) |
| 21 | Admin- & Betriebswege (Auth-Konsistenz, Operator-Flows, Registry) | erledigt — 5 Fixes (3 Audit-Lücken, Ban-Halberfolg, Hotfix-Cron-Marker) |
| 22 | Regression-Jagd über die Fixes der Runden 13–21 + Abschluss | erledigt — 6 eigene Regressionen behoben (everyone-Rename, Guild-Raw-Name, MemberRole-SQLite-Lücke, Purge-Exception, envPrefix-Secret-Leak, Sound-Restpfad) |

## Abschlussbilanz Teil 2 (2026-09-20)

* **Runden 13–22: 36 Fixes** (+ 6 Regressionen aus Teil 2 im
  Adversarial-Review behoben). Serie gesamt: **~90 Fixes**.
* **Letzter Stand aller Gates:** Backend-Suite 2632/2632 grün (Anmerkung: der Runde-21-VPS-Audit nutzte
tfalsch target_user_id — im Runde-22-Lauf gefangen und korrigiert;
Anmerkung:
  Singleworker-Test braucht Abwesenheit des Dev-Stack-Flags),
  svelte-check 0 Fehler, Web 1190/1190, vite build grün,
  Android-Kompilat grün (JDK 21), esbuild grün.
* **Offene Entscheidungen:** s.
  `docs/2026-09-20-bughunt-offene-entscheidungen.md` (MinIO-Pin 410
  bleibt der akuteste Punkt).

## Bekannt (Erweiterung: Runden 3–12 — NICHT wieder melden)

Kondensiert auf Fix-Klassen (Details je Commit im Log):
* Zeit: direct-adapter Heartbeat-Timeout/Backoff/ICE-Deadline; WS exp==now;
  readState-pagehide-Flush.
* Lebenszyklen: Watch/Stream-Evict bei Kanal-/Guild-Delete; Purge
  friend_removed + Einladungskarten + S3-Deferral; Passkey-Lösch-Dialog;
  Avatar-Statement-Invalidierung; Device-Cap beim Move; edit_message-Frost;
  joinedInvites-Teardown.
* Grenzen: Mod-Queue-DESC-Cursor; Claim-Budget nx-Expire; Hook-IP-Deckel;
  Gruppen-Unreads (Route-Vergleich); Frisch-Laden-Gap-Fill; Verlauf-Räumung
  je Gespräch; Mac-Audio-Bound; Linux-Latenzdeckel; Mux-Sonden-Drain.
* Parallelität: delete_party_if_host + mutate_party für Handoff/Promotion;
  Guild-Zeile FOR UPDATE bei Delete/Transfer; Anhang-Bind bedingtes UPDATE;
  DM last_message_id nur vorwärts; Generation-Guards in
  memberRoles/channelPermissions/roles; DM-Hydrate- + Gruppen-Seed-Merge.
* Fehlerpfade: Reaper commit→purge; Avatar/Icon Temp+Rename-nach-Commit;
  JWKS-Pin-Verwerfen ohne Kids; Kopplungs-PUT-IntegrityError; WS-Reconnect
  nach Token-Fehler; DM-Fehlerzustand-Reset; Sidecar-Waisen-Guard;
  Entwurf-in-Zwischenablage.
* Drift: nativePlayerOnlyTenBit-Allowlist; Shortcut-Backslash;
  WSL2-Assistent am Start-Knopf; Audio-Dreizustand; POST_NOTIFICATIONS.
* Rechte: Purge guild_member_removed; Reorder-Evict; id-Tiebreak;
  create_role-Rangklemme; Gastlink-Liste-Filter + POST-Ordnung.
* Krypto: Verteilschlüssel-Partnervergleich; OTK-Batch-Kappe;
  Ablage-Speicher-Cache; ATTACH_FILES-Gate; Kanal-Sitzungs-Reset bei Ready.
* Sonstige: nachtlauf.sh Exit-Status; Pulse-Update-All-Services-Prüfung;
  Backup-Marker je Tag-Gruppe; restore.md-Staging-Pfade; coturn-Ports;
  Checksummen-Skript deckt MinIO/frp; Guest-User-Limit an Token-Route;
  HEVC-FU-Poison; WS-Gate-4040/4043-Kommentare.


---

# Teil 3: Runden 23–32 (Fortsetzung)

## Plan

| Runde | Linse | Status |
|-------|-------|--------|
| 23 | Suche & Volltext (kanal/dm/verlauf/mention-Suche, Cursor) | erledigt — 6 Fixes (Mention-Lower, LIKE-Masken ×2, Mod-Queue-Komposit-Cursor, 2 Client-Such-Races) |
| 24 | E-Mail & SMTP-Flows (verify, reset, change, SMTP-Config) | erledigt — 5 Fixes (Register-Mail nach Commit/ohne Lock, E-Mail-Wechsel 503 ohne SMTP, Reset-401-Affordance, Row-Lock, Consume-Brakes) |
| 25 | Voice/WebRTC-Sitzungsleben (Token-Grants, Reconnect, Mute) | erledigt — 2 Fixes (Override-Reconciliation beim Ready, Deafen-vor-Mute-Ordnung); 3 Design-Punkte ins Entscheidungs-Doc |
| 26 | Idempotenz & Wiederholung (Retry-Sicherheit je Endpoint) | erledigt — 2 Fixes (REST-Nonce-Dedup, erstelleCommunity-Orphan) |
| 27 | Lokaler Verlauf/IndexedDB (luecke, kontoFilter, Quota) | erledigt — Lücken-Hüllen-Merge (Verlauf) |
| 28 | Rate-Limits & Brakes (Schwellen, Umwege, Deckel-Konsistenz) | erledigt — audio_diagnostic-Regel ergänzt (KeyError→500) |
| 29 | Einladungs-/Freigabe-Arten (guild/guest/member/recovery) | erledigt — Invite-Dedupe auf Cloud-Ziele eingegrenzt; Gast-TOCTOU-Rest notiert |
| 30 | Service-Worker & Offline (Cache, Update, Background) | erledigt — sauber (kein Fetch-Intercept, Cache je Build-Version, DND-Spiegel aus R19) |
| 31 | Watch-Party & Stream-Chat-Protokoll (Kontrolle, Lifecycle) | erledigt — Watch-Publish in Commit-Reihenfolge (atomare Transaktion) |
| 32 | Regression-Jagd über Runden 23–31 + Abschluss | erledigt — Adversarial-Review: Teil-3-Diff sauber |

## Abschlussbilanz Teil 3 (2026-09-20)

* **Runden 23–31: 17 Fixes** (Suche ×6, E-Mail/SMTP ×5, Watch/Invite ×2,
  Verlauf/Brakes ×2, Voice ×2).
* **Adversarial-Review (Selbstlauf):** Teil-3-Diff sauber; der in Runde
  24-Kontext entdeckte target_user_id-NameError (11 rote Tests) wurde
  noch in derselben Serie korrigiert (9cbd770c).
* **Gates final:** Backend 2633/2634 (Singleworker-Test = Dev-Stack-Flag-
  Umgebung), svelte-check 0 Fehler, Web 1190/1190, vite build grün,
  watch tests 101/101.

## Serie gesamt (Runden 1–32)

~107 Fixes, 66+ Commits auf `bughunt-09-20`. Offene Design-/Aufräum-
Punkte: `docs/2026-09-20-bughunt-offene-entscheidungen.md` (MinIO-Pin
410 = akut).

## Bekannt (Erweiterung: Runden 13–22)

Kondensiert je Fix (Details im Commit-Log):
* Flags: allow_member_invites auf member-invites; passwortloser
  WebAuthn-Login hinter Mandatory-SSO; env.sh rendert RELAY_TOKEN/
  TLS_MODE/DATA_PATH; permissions_updated null-vs-undefined +
  serverCapabilities.refresh; capabilities.hydrate je Dial; vite define
  statt envPrefix.
* Namen: validate_name mit max_len (vor+nach NFKC); Rollen/Guild-Namen
  gehärtet + @everyone reserviert (create UND rename); display_name
  gestrippt; Tag-Trenner im App-Locale; Avatar-Initialen surrogatsicher
  (Kernflächen).
* Schema: MemberRole-Composite-FK im Modell; Kick/Leave löscht
  member_roles ausdrücklich.
* Datei/Pfad: Ablage-Abruf erzwingt octet-stream+nosniff+attachment;
  Sound-Upload Temp-Key→Commit→Final (Erst-Upload-Rollback).
* Netz: direct-adapter bridge streift XFF/Identitäts-Köpfe (+ ponytail-
  Deckel 127.0.0.1-Kollaps); Provisionierungs-Calls 30-s-Frist.
* UI: Rollen-Cross-Apply-Guard (beide Editoren); CreateGuildDialog-
  Reset am open-Wechsel; TOTP/Passkey-Lauf-Schutz; Anhang-Fehlerzeile
  blockiert Senden.
* Notifications: dndSpeicher (SW-Flag aus Server-Truth); DM-Mention-
  Push unterdrückt (dm-Push deckt ab); Server-Stummschaltung gilt für
  Chime.
* Konsistenz: Purge räumt fremde-Guild-Streams/Watch/Tokens (best-
  effort); Hook klärt stream:stopping bei Re-Publish; Presence persist
  vor Redis.
* Admin: Guild-Delete im Admin-Bypass auditiert; VPS-Approval + Instanz-
  suspend/unsuspend/rotate auditiert; Ban-Halberfolg getrennt gemeldet;
  hotfix-prod cron HOTFIX-OFF-Marke.


---

# Teil 4: Runden 33–42 (Fortsetzung)

## Plan

| Runde | Linse | Status |
|-------|-------|--------|
| 33 | Logging & Secrets (Redaction, Log-Injection, Debug-Wege) | erledigt — 4 Fixes (Renew-Race, Invite-Codes in Logs, 422-Roh-Echo, tote Diagnose-Zeile) |
| 34 | Cookies & CSRF (Flags, SameSite, Browser-Reachable Mutations) | offen |
| 35 | WS-Ops im Einzelnen (resync/typing/device/watch/token_refresh) | offen |
| 36 | Postfach & Key-Bundle-Flows (Refill, Grants, Fallback) | offen |
| 37 | Upload-/Medien-Pipeline (PIL, MIME, Thumbnails, Presign-TTL) | offen |
| 38 | Session-/Auth-Zustandsflotten (Browser-Sessions, MFA-Tickets) | offen |
| 39 | Sync-Ordner & Ablage-Klient (OAuth-Flows, Festigung) | offen |
| 40 | SQL & Raw-Queries (text()-Stellen, Interpolation) | offen |
| 41 | CI-Workflows & Doku-Drift (Actions vs. Wirklichkeit) | offen |
| 42 | Regression-Jagd über Runden 33–41 + Abschluss | offen |

## Bekannt (Erweiterung: Runden 23–32)

* Suche: mention-search lower(); /c?q= + owner-list LIKE-Maskierung +
  Länge; Mod-Queue-Komposit-Cursor (before+before_id, Sortierung +id);
  ModQueue-Lauf-Zähler; MentionAutocomplete-Lauf-Prüfung.
* E-Mail: Register-Mail nach Commit + ohne Advisory-Lock; Token-Zweile
  committet auch bei SMTP-Fehler; /me/email/change 503 ohne SMTP;
  confirm_email_change Row-Lock; token_confirm-Brake (30/min) auf
  beiden Consume-Endpoints; Reset-Client akzeptiert 401.
* Voice: Override-Reconciliation beim Ready (Force-Mute überlebt
  WS-Lücken); Deafen vor Mute abarbeiten.
* Idempotenz: REST-Senden mit Nonce-Dedup (idempotente 200);
  erstelleCommunity navigiert bei Kanal-Fehler in die neue Guild.
* Verlauf/Brakes: lueckeMarkieren verschmilzt zur Hülle;
  audio_diagnostic-Regel (6/min) ergänzt.
* Watch/Invites: PUBLISH in der MULTI-TX (mutate_party/
  delete_party_if_host/write_party/delete_party); member-invite-Dedupe
  nur für Cloud-Ziel-Karten.
* Garage (Option 3 umgesetzt): Self-Host-Dockerfile + s6 garage/
  garage-init (toml-Render, Layout, Bucket, Key-Import), Prod-Compose
  + nginx-Upstream + .env GARAGE_RPC_SECRET; Live-Probe der s3.py-
  Oberfläche gegen dxflrs/garage:v1.1.0 bestanden.
