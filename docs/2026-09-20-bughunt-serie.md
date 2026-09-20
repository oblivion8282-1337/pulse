# Bughunt-Serie 2026-09-20 — Protokoll (Runden 3–12)

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
| 8 | Klient-Server-Drift (desktop/mobile-Capacitor vs. API) | offen |
| 9 | Rechte & Sichtbarkeit quer (Resolver-Ränder, Cache-Invalidierung) | offen |
| 10 | E2E-Krypto-Glue (Postfach, Kopplung, Sicherung, Ablage) | offen |
| 11 | Tote Wege & Test-Drift (exportiert-nie-gerufen, Tests am falschen Verhalten) | offen |
| 12 | Selbst-Review des Serien-Diffs + Abschlussbericht | offen |

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
