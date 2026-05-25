# Plan: Zentrale Identität + private Self-Host-Server (Multi-Backend-Client)

## Context

Pulse ist heute Single-Instance: ein `auth-svc`, ein `chat-gateway`, eine DB.
Ziel: Eine **zentrale Identität** auf der Haupt-Domain (heute
`pulse.unicutmedia.com`, Name ändert sich später) — damit Usernamen global
eindeutig sind und kein Namens-Wirrwarr entsteht — plus die **Möglichkeit, eigene
private Server zu hosten**, auf denen Messages/Voice/Streams isoliert auf
eigener Hardware liegen.

Im UI sitzen Cloud- und Self-Host-Server **in derselben App** nebeneinander
(Discord-style Sidebar, Multi-Backend-Client). Die Liste der Self-Host-Server
liegt **nur lokal** im Browser/Electron — die Cloud erfährt nicht, welche
privaten Server ein User noch nutzt.

### Designentscheidungen (vom User bestätigt)

1. **Wer darf rein?** Jeder Cloud-User per Invite-Link. Daten-Isolation, nicht Identitäts-Isolation.
2. **Offline:** Self-Host läuft mit gecachten JWKS + Profilen weiter; nur neue Logins warten auf die Cloud.
3. **Voice/Streaming:** Self-Host bringt eigenen LiveKit + MediaMTX mit — kein Traffic über die Cloud.
4. **Snowflake-IDs:** Cloud vergibt pro Self-Host eine Worker-ID-Range.
5. **Privacy:** Die Cloud darf NICHT mitloggen können, welche Self-Host-Server ein User nutzt, wer wann dort online ist, oder was dort geschrieben wird. Was im Cert-Modell (DE 11) unvermeidbar bleibt: Cert-Issuance beim Geräte-Add (~jährlich pro Gerät) + Profile-Statement-Issuance (alle ~24h pro aktivem User-Gerät) + CRL-Polls von Self-Hosts (zeigt nur „Instance lebt", kein User-Bezug). Kein laufender Token-Refresh-Stream mehr.
6. **UI:** Eine App, alle Server in der Sidebar. Self-Host-Liste **local-only** (Browser-localStorage bzw. Electron-Store).
7. **Friends/DMs:** Pro Server eigene Welt. Cloud-Friends ≠ Self-Host-Friends. Max Privacy + Datenisolation.
8. **MFA-Pflicht (Hijack-Mitigation, Fallstrick #1):** Cloud-only-User dürfen ohne MFA chatten. Sobald ein User einen Self-Host hinzufügt, ist MFA Pflicht — und beim Add-Server-Flow wird sie per **Step-Up** (RFC 9470) frisch erzwungen, nicht bloß aus der Session geerbt. JWT bekommt `acr`/`amr`-Claims. **Kein Account-Recovery** außer den Backup-Codes (keine E-Mail-Resets, kein Admin-Reset) — sauberer Schutz, harte Warnung im MFA-Setup. Self-Hosts dürfen über `acr_values=mfa` selbst MFA verlangen, ist aber redundant: der Cloud-Add-Flow tut es ohnehin.
9. **Credential-Revocation (Fallstrick #2):** Mit dem Cert-Modell aus DE 11 sind Identitäts-Zertifikate (pro Gerät, Validity ~1 Jahr) das primäre Auth-Artefakt. Self-Host gibt nach Cert-Validierung + Challenge-Response einen **kurzlebigen lokalen Session-Token** aus (TTL **5 Min**, refreshable via Cert-Re-Auth — Self-Host-internes Token, NICHT Cloud-signiert). Cloud serviert `/.well-known/revoked-credentials` mit Cert-IDs der CRL (Certificate Revocation List) — Self-Host pollt alle 30s, hält Set in Redis, reject bei Match. Schema-Felder ändern sich gegenüber JWT-JTI-Modell (`cert_id` + `revoked_at` statt `jti`), Mechanik bleibt gleich. Account-weite Suspendierung durch Cloud = alle Certs des Users wandern in CRL → spätestens nach 30s Poll + 5 Min Session-Token-TTL auf allen Self-Hosts inaktiv. Geräte-Einzel-Revocation (User klickt "Abmelden" in Geräte-UI) = nur das eine Cert in CRL, andere Geräte bleiben aktiv. **Polling ist hart erzwungen** (default-an, kein Opt-out, konsistent mit DE 10). Kein Online-Cert-Status-Check pro Request (sonst Privacy-Bruch gegen DE 5 — CRL-Pull ist anonym).
10. **Update-Modell (Fallstrick #8) — "Cloud regiert, instant, ohne Wahl, aber mit Sicherheitsnetzen":** Cloud-Frontend ist die einzige Quelle. Self-Host-Backends MÜSSEN **exakt** mit der aktuell deployten Cloud-Frontend-Version laufen — **keine N-1-Toleranz**, **keine Deprecation-Window**, **keine Vorankündigung**. Watchtower ist im Self-Host-Stack default-an **ohne Opt-out**. Update-Trigger-JWT wird mit demselben Cloud-RS256-Key signiert, der auch für Cert-Signing (DE 11) und JWKS dient.

    **Sicherheitsnetze (alle 4 obligatorisch, 2026-05-25 User-Entscheidung):**

    **(a) Pre-Migration-Test im CI** — vor jedem Image-Push startet CI einen frischen Postgres-Container, läuft alle Alembic-Migrations + bestehende Production-Snapshot dagegen. Bricht der Test → kein Image-Push, kein Self-Host-Crash. Verhindert die schlimmste Klasse von Bugs.

    **(b) Auto-Backup vor Update** — Self-Host-Single-Container macht **vor jedem** Image-Tausch automatisch `pg_dump` nach `/data/backups/pre-update-$timestamp.sql.gz`. **Backup-Rotation hart erzwungen**: max **3 Pre-Update-Backups** (FIFO) + **1 wöchentlicher Snapshot** (max 4 wöchentliche behalten). Konfigurierbar via `PULSE_BACKUP_RETENTION_PRE=3` und `PULSE_BACKUP_RETENTION_WEEKLY=4`. Container warnt im Health-Endpoint wenn `/data` Volume zu <20% freiem Platz kommt. Bei Migration-Crash kann Container automatisch zurückrollen (alter Image-Tag + Backup-Restore).

    **(c) Health-Probe nach Update** — Cloud signiert 60s nach Update-Trigger einen Health-Probe-JWT (`purpose:"health-probe", instance_id, exp:5min`), ruft `GET https://{hostname}/internal/health`. Bei Fehler/Timeout: Self-Hoster bekommt E-Mail-Notification + Admin-UI-Banner ("Dein Server X ist nach dem Update nicht hochgekommen — Logs prüfen oder Rollback anfordern").

    **(d) Staged Rollout (Canary)** — Cloud-Production updated zuerst, **15 Min Canary-Wartezeit** mit automatischer Error-Rate-Überwachung. Wenn OK nach 15 Min: Webhook an alle Self-Hosts. Wenn Cloud-Production-Healthcheck/Error-Rate auffällig: Webhook NICHT auslösen, du bekommst Alert. Self-Hosts bleiben auf alter Version bis du grünes Licht gibst.

    **Watchtower-Standard-Polling** (5 Min) als Fallback für Instances, die zum Push-Zeitpunkt offline waren. Cloud serviert `/.well-known/pulse-version-policy.json` nur noch für Diagnose. **Versionierte GHCR-Tags**: jedes Image hat `:stable` UND `:v0.8.1` (Semver). Bei kaputtem Deploy: du re-tagest `:stable` auf vorherige Versions-Tag, Webhook erneut auslösen → Self-Hosts pullen alte Version. Schema-Änderungen brauchen ggf. Down-Migration; Alembic-Down-Migrations sind Pflicht für jede Up-Migration (CI-Test bricht sonst).

    **Explizit revisitable** wenn das Projekt aus der aktiven Bauphase rauswächst — dann kann Modell B/C-Migration sinnvoll werden.
11. **Identitäts-Architektur + Haftungsmodell (Fallstrick #12) — "Idee A+C, Stealth-Beta-Phase":** Beide Aspekte werden **gleichzeitig von Anfang an** umgesetzt (User-Entscheidung 2026-05-25, siehe `docs/mockups/identity-options.html` für visuelle Erklärung).

    **(A) Identitäts-Zertifikat-Modell** statt klassischem OAuth-Token-Flow.
    **Zwei Cloud-signierte Artefakte werden sauber getrennt** (User-Entscheidung 2026-05-25):

    **A.1 Identitäts-Cert** (stabil, ~1 Jahr Validity, selten erneuert):
    - Pro Gerät (Web, Electron, Mobile später) generiert die Client-App lokal ein **Ed25519-Schlüsselpaar** via WebCrypto (Browser) bzw. Node-Crypto (Electron). Privater Schlüssel verlässt das Gerät nie.
    - Cloud signiert mit RS256-Key (geteilt mit JWKS). Enthält ausschließlich **stabile Identity-Claims**:
      `cert_id` (UUID), `user_id` (Snowflake), `device_pubkey`, `device_label`,
      `pairwise_seed` (pro USER, nicht pro Cert — siehe A.4), `amr`, `acr`, `iat`, `exp` (~1 Jahr).
    - **Kein** Username/Avatar/Display-Name im Cert (diese ändern sich, Cert nicht).
    - Self-Host validiert Cert via Cloud-JWKS lokal, schickt Challenge → User signiert → Self-Host gibt **kurzlebigen lokalen Session-Token** aus (DE 9, 5-Min-TTL).

    **A.2 Profile-Statement** (kurzlebig, **24h Validity**, häufig erneuert):
    - Separates JWT, Cloud-signiert. Enthält **änderbare Profile-Felder**:
      `statement_id` (UUID), `user_id` (Snowflake), `username`, `display_name`,
      `avatar_hash`, `profile_color`, `iat`, `exp` (24h).
    - Frontend holt Statement initial nach Cert-Issuance, refreshed automatisch nach 24h oder bei Profil-Change.
    - Beim WS-Connect/Statement-Refresh pusht Frontend aktuelles Statement an Self-Host → Self-Host cached + zeigt es überall an.
    - **Avatar/Display-Name/Username-Change** wirkt schnell (User holt neues Statement, pusht es bei nächstem Connect zu allen aktiven Self-Hosts) ohne Cert-Neuausstellung.
    - **Refresh während aktiver Session** (Punkt 9): Frontend hat Background-Timer, holt 4h vor Statement-Expiry neues Statement, pusht es batched (max 1× pro Server pro Stunde) an alle aktiven WS-Connections. Bei Profil-Change durch User: sofort-Push. WS-Op `profile_statement_update` (server-bound).

    **A.3 Username-Änderung erlaubt jederzeit** (Mastodon-Style):
    - User ruft `POST /me/username` mit gewünschtem neuen Username
    - Cloud prüft Eindeutigkeit, aktualisiert `auth.users.username`
    - **Username-Reservierung** (Punkt 17): Eigene Tabelle `auth.username_reservations` (`old_username TEXT PK`, `original_user_id BIGINT`, `released_at TIMESTAMPTZ`). Beim Username-Change wird `old_username` reserviert, Daily-Cron räumt abgelaufene Reservierungen weg. Wenn Original-User innerhalb 30 Tage zurück will: `POST /me/username` checkt `username_reservations` und erkennt eigene reservierte Namen als verfügbar. Username-Eindeutigkeits-Check schaut sowohl in `users.username` UND `username_reservations`.
    - Profile-Statement-Cache wird invalidated → User holt neues Statement → wirkt bei nächstem Self-Host-Refresh
    - **Replay-Protection**: Self-Host akzeptiert nur Statements mit `iat > last_seen_statement_iat[user_id]` (verhindert Rollback-Attacks mit altem Statement).
    - **First-Use-Replay-Protection** (Punkt 7): Beim ersten Statement eines Users (kein `last_seen` für ihn) akzeptiert Self-Host nur wenn `iat > now - 48h` — verhindert dass jemand ein altes abgefangenes Statement von vor Wochen pushed um sich als jemand anders auszugeben.

    **A.4 Pairwise-Subjects**: Token-`sub` auf Self-Host wird Self-Host-seitig berechnet als `hash(user_id, instance_id, pairwise_seed)`.
    - **`pairwise_seed` ist pro USER, nicht pro Cert** (kritisch für Multi-Device!) — Cloud generiert beim User-Account-Anlegen einmalig `auth.users.pairwise_salt` (32 random Bytes), inkludiert ihn in jedem Cert dieses Users.
    - Damit haben alle Geräte desselben Users denselben Pairwise-Sub auf einer Instance — Self-Host sieht „Alice" einmal, egal ob sie von Laptop, Handy oder Web kommt.
    - Self-Hosts können untereinander nicht auflösen, dass „Alice auf A" und „Alice auf B" derselbe Cloud-User ist (verschiedene `instance_id` → verschiedene Pairwise-Subs). Privacy by Design.
    - **Cloud-chat-gateway ist Sonderfall** (Punkt 4, User-Entscheidung): nutzt **direkte `user_id`**, kein Pairwise-Sub. Cloud kennt user_id sowieso (sie hat ihn erstellt), Pairwise-Sub auf Cloud bringt keinen Privacy-Gewinn. Cloud-Friends + Cloud-DMs sind damit konsistent user_id-basiert.

    **A.5 Multi-Device** via Cloud-verwaltete Liste: pro User mehrere aktive Geräte-Certs, alle mit derselben User-Identität. Geräte-Management-UI in Cloud-Settings.
    - **Geräte-Limit max 20 aktive Certs pro User** (Punkt 8): verhindert CRL-Aufblähung bei kompromittierten Accounts + DB-Pollution. Beim 21. Geräte-Add: Cloud verlangt „älteres Gerät zuerst abmelden". Endpoint `POST /credentials/issue` returnt 409 wenn Limit erreicht.
    - **Pro physisches Gerät immer nur EIN aktives Cert** (Punkt 5+6, User-Entscheidung): Bei Step-Up-MFA-Wechsel wird neues Cert mit höherem `acr` ausgestellt UND altes Cert auf demselben `device_pubkey` automatisch revoked. Bei Auto-Rotation (A.8): neuer Cert übernimmt `acr`-Wert des alten — wenn aktuelle Session nicht denselben MFA-Status hat, wird Re-Auth gezwungen (kein silent Downgrade von `acr=1` auf `acr=0`).

    **A.6 Recovery — Cloud-Backup mit Master-Passwort** (Zero-Knowledge wie Bitwarden):
    - **Opt-in beim Setup, stark empfohlen** — UI zeigt beim ersten Geräte-Setup einen Backup-Flow ("Wir empfehlen Cloud-Backup einzurichten — sonst kannst du bei Cache-Verlust deinen Account verlieren"). User kann überspringen mit harter Warnung.
    - **Master-Passwort** separat vom Account-Passwort. UI erzwingt **Minimum 12 Zeichen** + Strength-Meter.
    - Frontend leitet Master-Key via **Argon2id** ab (`argon2-cffi` ist schon im Dep-Tree für Account-Passwort-Hashing) — Parameter `t=3, m=65536, p=4` (OWASP-konform).
    - Frontend verschlüsselt privaten Ed25519-Schlüssel mit **AES-256-GCM** (12-Byte-Nonce, 16-Byte-Salt random).
    - Encrypted Blob hochladen via `POST /credentials/{cert_id}/backup`. Cloud sieht NUR Ciphertext + Argon2-Params + Salt + Nonce, **niemals** Master-Passwort oder privaten Schlüssel.
    - **Recovery-Flow**: User loggt sich auf neuem Browser ein → Settings → „Aus Cloud-Backup wiederherstellen" → wählt Gerät aus Liste → gibt Master-Passwort ein → Frontend GET `/credentials/{cert_id}/backup` → entschlüsselt lokal → privater Schlüssel wieder verfügbar → bisheriges Gerät wird **wiederbelebt** (gleicher cert_id, gleiche Pairwise-Subs auf allen Self-Hosts).
    - Plus **Backup-Codes** (DE 8) bleiben als MFA-Backup unabhängig nutzbar.
    - **Bei Master-Passwort-Verlust: Backup unbrauchbar** — Standard-Warnung wie bei Bitwarden ("Wenn du das verlierst und keine andere Backup-Methode hast, ist der Account weg").
    - **Master-Passwort-Change-Flow** (Punkt 6 aus Review #4): User klickt „Master-Passwort ändern" in Settings → gibt alt + neu ein. Frontend (auf aktivem Gerät A): entschlüsselt eigenen Backup mit alt-MP, verschlüsselt mit neu-MP, lädt neu hoch. Plus: Cloud pusht **WS-Op `master_password_changed`** (auf Browser-Session-Channel) an alle anderen aktiven Geräte → die kriegen 1 Push, machen lokal denselben Re-Encrypt. Offline-Geräte: Cloud behält **alt-Backup-Version für 30 Tage** parallel (in `encrypted_key_backups`-Spalte `previous_blob`), damit Geräte die nachträglich online kommen migrieren können. Nach 30 Tagen wird `previous_blob` gelöscht → Offline-Gerät kann sein eigenes Backup nicht mehr entschlüsseln, muss revoked + neu registriert werden.

    - **Backup-Status-Anzeige** (Punkt 4 aus Review #4): Geräte-Management-UI (`DeviceManagement.svelte`) zeigt pro Gerät ein **Backup-Status-Indikator** — grünes Häkchen wenn Cloud-Backup aktuell, rotes Warning-Icon + Tooltip „Dieses Gerät hat KEIN Cloud-Backup — bei Cache-Verlust verlierst du den Account" wenn keiner vorhanden. Plus: nach Cert-Issue zeigt Frontend Toast „Backup-Upload fehlgeschlagen, bitte später erneut versuchen" wenn POST `/credentials/{id}/backup` fehlt (Netzwerk-Issue), mit Retry-Button.

    **A.7 Cloud sieht NICHT**: auf welchen Self-Hosts User aktiv ist, welche Self-Hosts in der Sidebar sind. Cloud sieht NUR: Cert-Issuance (selten, ~jährlich + Geräte-Add) + Profile-Statement-Issuance (alle ~24h pro aktivem User-Gerät). Statement-Issuance ist häufiger als Cert-Issuance, aber **deutlich seltener als klassischer Token-Refresh** (5-Min vs. 24h = Faktor 288).

    **A.13 Cloud-eigene `instance_id`** (Punkt 6 aus Review #5): Cloud-chat-gateway hat eine spezielle `instance_id = 0` (reserviert), die NICHT in `registered_instances` steht. Verwendet für Snowflake-Worker-Konfiguration + Cloud-`PULSE_INSTANCE_MODE=cloud`-Erkennung. Cloud-User-Identification nutzt user_id direkt (DE 11 A.4), nicht Pairwise-Sub mit instance_id=0.

    **A.8 Cert-Rotation-Automatik** (~1 Jahr Validity, Punkt 8):
    - Frontend-Background-Task prüft Cert-Expiry beim Start + täglich.
    - Wenn weniger als **30 Tage** verbleiben: holt automatisch neues Cert via `POST /credentials/issue` mit aktivem User-Session-Cookie.
    - User merkt nichts (transparente Rotation während er normal nutzt).
    - Sollte Session abgelaufen sein bei Rotation-Zeitpunkt → fallback: nächster manueller Login löst Rotation aus, plus In-App-Banner ab 7 Tagen vor Ablauf ("Bitte einmal neu einloggen — Geräte-Zertifikat läuft bald aus").
    - Wenn Cert während aktiver WS-Session abläuft: Frontend kriegt 4001-Close vom Self-Host, prüft Cert, triggert Rotation, reconnect.

    **A.9 Account-Löschung-Kaskade** (Punkt 10, GDPR-relevant):
    - User klickt "Account löschen" in Cloud-Settings → Confirmation-Flow (Master-Passwort + MFA) → Cloud setzt alle Certs des Users auf `revoked_at=now()` → User fliegt auf allen Self-Hosts raus (max 5:30 Min via CRL-Pull, DE 9).
    - **Cloud broadcastet KEIN Event** an Self-Hosts (würde Privacy brechen, weil Cloud sonst weiß welche Self-Hosts den User kennen).
    - **Self-Host-Member-Records bleiben als "Zombie"**: alte Messages bleiben, Username/Avatar zeigt `[deleted user]` (weil Profile-Statement nie mehr aktualisiert wird → Profile-Statement-Refresh fail → Self-Host markiert User als "inactive deleted").
    - **GDPR-Recht-auf-Vergessen**: User muss separat pro Self-Host kontaktieren wo er Mitglied war. Cloud kann nicht helfen (weiß nicht wo). Doku-Hinweis im Account-Löschung-Flow: "Bei privaten Servern, auf denen du Mitglied warst, musst du den jeweiligen Server-Admin separat kontaktieren."
    - Cloud-Account-Löschung selbst: nach Confirmation hard-delete der `auth.users`-Row + alle Certs + alle Backups + alle Anträge.

    **A.10 Voice-Auth-Flow** (Punkt 11): voice-signaling-Service akzeptiert das Self-Host-lokale Session-Token (DE 9) aus dem Cert-Auth-Flow. Beim Voice-Channel-Beitritt: Frontend ruft `POST /voice/channel/{id}/join` mit Session-Token im Header → voice-signaling **validiert Session-Token via Redis-Lookup** (Punkt 18: `session_tokens.py` schreibt nach Cert-Auth in `auth:session_tokens:<token>` mit 5-Min-TTL, voice-signaling liest dort, prüft user_id + Pairwise-Sub) → voice-signaling generiert LiveKit-JWT mit `participant_id=pairwise_sub` + Channel-Permissions → Frontend nutzt das im LiveKit-Client. Wenn Session-Token abläuft während Voice-Session aktiv ist: Cert-Re-Auth triggert neues Session-Token, voice-signaling refreshed LiveKit-Token. Analog für media-svc (Stream-Keys).

    **A.11 Account-Suspension** (Punkt 14): Zwei Pfade parallel:
    - **User-Self-Service**: `POST /me/logout-everywhere` → alle eigenen Certs in CRL. Settings-UI "Alle Geräte abmelden".
    - **Admin-Force-Suspension**: `POST /admin/users/{user_id}/suspend` (Bootstrap-Admin only) → alle Certs in CRL + User-Account-Flag `is_suspended=true` (verhindert neue Logins). Admin-UI auf `/app/admin/users`. Für Notfall (Hijack, Content-Policy-Verstoss).
    - **Race-Condition-Schutz** (Punkt 18+19 aus Review #4): `auth.users.revoke_until` (TIMESTAMPTZ, nullable) als Watermark. Bei Logout-Everywhere/Suspend wird auf `now()` gesetzt. **Cert-Issuance prüft**: wenn `revoke_until IS NOT NULL AND now() < revoke_until + 5min` → `POST /credentials/issue` returnt 409 "Account in revoke-window, bitte einen Moment warten + neu authentifizieren". Verhindert dass Cert-Rotation in flight die Suspension umgeht. Watermark wird beim nächsten erfolgreichen MFA-Login zurückgesetzt. Plus: `auth.issued_credentials.issued_at < users.revoke_until` werden bei jedem Sweep auch revoked (Catch-Up für race-Certs).
    - **Backup-Restore-Cert-Check** (Punkt 5 aus Review #4): Frontend prüft beim Restore-Start `GET /credentials/{cert_id}` (Cloud-Status-Lookup mit User-Session-Cookie) — wenn `revoked_at IS NOT NULL` → UI zeigt "Dieses Geräte-Backup ist veraltet — das Gerät war zwischendurch abgemeldet. Neues Gerät registrieren statt restoren." Verhindert dass User „untoten" Cert wiederbelebt.

    **A.12 Self-Hoster-wird-Owner-Race-Schutz** (Punkt 9 aus Review #5): Beim Instance-Approval berechnet Cloud `expected_owner_pairwise_sub = hash(applicant_user_id, new_instance_id, applicant_pairwise_salt)` und speichert es in `registered_instances.expected_owner_pairwise_sub` (neue Spalte). Beim Setup sendet Cloud diesen Wert als Teil der Credentials zum Self-Hoster. Self-Host's `cont-init.d`-Script schreibt ihn in `/data/expected_owner.json`. Beim ersten Cert-Auth eines Users prüft Self-Host: nur User mit matching Pairwise-Sub wird automatisch Owner. Andere User können sich connecten (wenn sie via Invite-Link kommen), werden aber normale Members. **Race-frei**: selbst wenn jemand vor dem Self-Hoster connectet, wird er nicht Owner.

    **(B) Rechtliche Position („Reddit-Style"):**
    - Globale **Cloud-Content-Policy** (öffentlich publiziert, kein CSAM, keine Volksverhetzung etc.)
    - Self-Host-Hoster akzeptiert beim Onboarding einen **Click-Wrap-Vertrag**, der ihn als alleinigen DSA-Verantwortlichen für seinen Server deklariert und ihn zur Content-Policy-Durchsetzung verpflichtet.
    - Cloud hat `POST /reports` als Notice-and-Action-Endpoint (DSA-konform, siehe Phase 2 Admin-Endpunkte).
    - Mod-Tools (Reporting + Mod-Queue + Audit-Log) im chat-gateway-Core eingebaut (kein Opt-out).
    - Bei Verstoß-Beschwerden: Cloud → Self-Host-Admin mit Frist → Suspension bei Nichtreaktion.

    **B.1 Suspension-Wirkungs-Mechanik** (Punkt 7+8+9+23 aus Review #4 — vorher undefiniert!): Cloud setzt `registered_instances.status='suspended'`. Doppelter Schutz-Pfad:
    - **Self-Host-Self-Pull**: Self-Host's chat-gateway pollt `/.well-known/pulse-suspended-instances` (öffentliche Liste mit `instance_id`s aller suspendierten Instances) alle 5 Min. Eigener `instance_id` drin → **alle WS-Connects + REST-Requests werden mit 503 "Instance suspended by Pulse-Cloud" abgelehnt**. Self-Host läuft technisch weiter (für Admin-Recovery + Backup-Export), aber für User unbenutzbar.
    - **Frontend-Pull**: Cloud-Frontend pollt dieselbe Liste alle ~1h. Beim Add-Server-Dialog + bei Sidebar-Render wird Server-`instance_id` (aus `pulse-server-info`) gegen die lokale Suspended-Liste geprüft. Suspended → Server bekommt rotes "gesperrt"-Badge, WS-Connect wird gar nicht erst versucht, Add-Server-Dialog rejected mit Begründungs-Link.
    - **Liste ist öffentlich, privacy-konform** (wie CRL): keine User-Bezüge, nur Instance-IDs + ggf. Begründungstext.
    - Self-Hoster-Recovery: Cloud-Admin macht `POST /admin/instances/{id}/unsuspend` → Liste-Eintrag weg → Self-Host's nächster Poll merkt das → akzeptiert wieder Connects. Plus E-Mail-Benachrichtigung an Self-Hoster bei Suspension + Unsuspension.

    **(C) Stealth-Beta-Phase (für Phase 0)**: Self-Host-Registration ist **Bootstrap-Admin-only**, kein Self-Service. Du registrierst manuell vertrauenswürdige Hoster. Cloud-Registration kann Invite-Code-only sein. AGB + e.V. + Versicherung erst beim öffentlichen Federation-Launch (Phase 1).

    **(D) Lizenz schon erledigt**: AGPL-3.0-or-later + CLA nach Apache-ICLA-Vorbild (existiert, `LICENSE` + `CLA.md`) — Mastodon-Modell mit zusätzlicher Dual-Licensing-Option. Foundation-fähige Code-Struktur (die pulse.unicutmedia.com-Instanz ist code-seitig eine normale Pulse-Instanz, später an e.V./gGmbH übertragbar).

    **(E) UI macht Cloud/Self-Host-Trennung sichtbar**: Server-Badge in Sidebar, einmaliger Disclaimer beim ersten Beitritt pro Server.

    **(F) Migration aus heutigem Zustand (Big-Bang, weil Pulse noch Beta):**
    - Alembic-Migration `auth.users.pairwise_salt` ADD COLUMN, default `gen_random_bytes(32)` für bestehende User.
    - Alle bestehenden `auth.refresh_tokens` werden bei Deploy revoked (`revoked_at=now()`).
    - Bestehende Sessions enden — User müssen sich einmal neu einloggen. Beim Re-Login generiert Browser Keypair, holt Cert + Profile-Statement → ab da Cert-Modell.
    - chat-gateway-Deploy parallel zu auth-svc-Deploy. WS-Sessions kappen alle, reconnect mit Cert-Auth.
    - Akzeptables Migrations-Risiko bei Pulse-Beta-Größe (du + paar Test-User).

    **(G) Cloud-RS256-Key-Rotation (PKI-Standard):**
    - JWKS unterstützt mehrere `kid`s (Key IDs). Cloud kann mehrere aktive Keys halten.
    - Normaler Lifecycle: neuen Key generieren mit `kid="v2"`, wird Signing-Default. Alter Key `kid="v1"` bleibt für Validation existierender Certs gültig bis deren Expiry (~1 Jahr). Danach entfernbar.
    - Notfall-Lifecycle (Cloud-Key kompromittiert): alten Key sofort aus JWKS entfernen → Self-Hosts pullen → alle Certs mit altem `kid` ungültig → System-weiter Re-Login mit MFA.
    - Code-Support: `services/auth/src/dcc_auth/security.py` JWKS-Endpoint serviert alle aktiven Keys, Cert-Signing nimmt den als „primary" markierten. `services/chat-gateway/src/dcc_chat_gateway/security.py` Cert-Validation prüft `kid` im JWT-Header gegen JWKS.

13. **Plugin-System-Integration mit Cert-Modell (Review #5, vorher komplett übersehen!)** — Pulse hat bereits ein Plugin-System (`plugins/`, `chat.instance_plugin_allowlist`, `chat.guild_plugins`, `chat.guild_plugin_state`, Plugin-Loader, WS-Op-Gate, etc., siehe CLAUDE.md). Es muss explizit ins Cert-Modell integriert werden:

    **A. Plugin-Distribution** (User-Entscheidung): Plugins (heute `hello`, `tamagotchi`, künftige) sind **Teil des pulse-allinone-Container-Images** (DE 12). Updates kommen automatisch mit Container-Update (DE 10). Self-Hoster kann KEINE eigenen Plugins installieren — alles geht durch Cloud-Allowlist-Approval (Stufe-A-Konsistenz). Volume-Mount für Custom-Plugins kommt erst in Stufe B (`docs/PLUGIN_ROADMAP.md`).

    **B. Plugin-State-User-Identifier**: Plugins nutzen **„instance-local user identifier"** — abstrahiert über Helper `ctx.user_identifier()`:
    - In **Cloud-Mode** (`PULSE_INSTANCE_MODE=cloud`): returnt direkte `user_id` (Snowflake).
    - In **Self-Host-Mode** (`PULSE_INSTANCE_MODE=self-host`): returnt **Pairwise-Sub** (`hash(user_id, instance_id, pairwise_seed)`).
    - Plugin-State-Storage (`chat.user_preferences`, `chat.guild_plugin_state`-Tabelle) ist instance-lokal identifiziert — Cross-Instance-Plugin-Sync ist explizit **nicht möglich** (Privacy by Design via Pairwise-Subs).
    - **Bestehende Plugins (hello, tamagotchi) müssen refactored werden** — `user_id`-Felder ersetzen durch `user_identifier`. Migration-Script konvertiert in Cloud-Mode `user_id`-Spalten 1:1 (kein Datenverlust). Für Self-Host-Mode: First-Start hat noch keinen Plugin-State, kein Migration-Issue.

    **C. Plugin-Allowlist auf Self-Host**: `instance_plugin_allowlist`-Tabelle existiert in jeder Pulse-Instanz (Cloud + Self-Host). **Self-Host-Owner ist Self-Host-Bootstrap-Admin** für die Allowlist-Verwaltung — er entscheidet welche der gebakten Plugins auf seinem Server aktiv sind. Default: nur `hello` aktiv (existierender Self-Heal-Mechanismus, CLAUDE.md). Self-Host-Allowlist ist von Cloud-Allowlist unabhängig (jede Instance entscheidet selbst).

    **D. Plugin-Updates + Migrations**: Plugin-Schema-Migrationen (z.B. `tamagotchi` ändert Pet-Schema) laufen mit dem Container-Restart (DE 10). **Pre-Migration-Test (DE 10a) prüft auch Plugin-Migrations**. Wenn Plugin-Migration bricht: Container rollt zurück (Auto-Backup, DE 10b).

    **E. Cross-Pod-Channels** (CLAUDE.md: `plugin:<name>:events`): in Single-Container-Self-Host trivial (alle Services teilen Redis). In Cloud-Multi-Container: bestehende Redis-Pub-Sub-Mechanik funktioniert weiter.

14. **Snowflake-ID-Format-Erweiterung (Review #5, User-Entscheidung: 16-bit Worker statt 10-bit)** — bestehendes Format `[42-bit ms ab 2026-01-01][10-bit worker][12-bit seq]` skaliert nicht ausreichend (max ~300 Self-Host-Instances). **Neues Format: `[42-bit ms][16-bit worker][6-bit seq]`** = 65.536 Worker-IDs (≈ 21.000 Self-Host-Instances bei 3 Workers/Instance), 64 IDs/ms/Worker (= 64.000 IDs/s pro Worker, ausreichend für Chat-Workloads).

    **Trade-off bewusst akzeptiert**: 64 IDs/ms ist tight bei hochfrequenten Insert-Workloads — bei Message-Sturm könnte ein Worker theoretisch hit the limit. Mitigation: chat-gateway-Insert-Path nutzt Snowflake-Generator mit Spinlock+Wait wenn Seq erschöpft (bekanntes Pattern). Bei realer Last (kein Voice-Service erzeugt 64k Snowflake-IDs/s, voice/media-Service generiert IDs pro Voice-Session, nicht pro Message) unkritisch.

    **Migration**: Snowflake-Worker-Spalten in DB (`smallint`) → `integer`. **Bestehende Snowflake-IDs** bleiben gültig (sie sind Bigint, das Format wird nur **für neue IDs** anders interpretiert). Cutover-Punkt: `epoch_ms` der Migration ist in Plan-Migration `0024_snowflake_worker_16bit.py` festgehalten. IDs vor Cutover werden mit altem 10-bit-Worker-Format gelesen, neue mit 16-bit. Snowflake-Library bekommt Cutover-Logik.

    **Worker-ID-Range-Allokation**: Cloud reserviert 1-999, Self-Hosts 1000-65535. Wiederverwendung von suspendierten Worker-IDs nach 5 Jahren (alle Snowflake-IDs aus der Zeit sind unkritisch).

## Architektur

**Asymmetrische Distribution** (User-Entscheidung): Cloud bleibt **Multi-Container** (`infra/prod/`, skaliert horizontal, externe Postgres bei Wachstum). Self-Host läuft als **Single-Container** (`infra/self-host/`, DE 12, embedded alles).

```
   pulse.unicutmedia.com (Cloud, Multi-Container)   chat.firma.de (Self-Host, Single-Container)
   ──────────────────────────────────────────       ──────────────────────────────────────────
   ┌──────────────────────┐                         ┌─────────────────────────┐
   │ auth-svc             │                         │ Pulse All-in-One        │
   │ ─ Zertifizierungs-   │                         │ (Single-Container, DE12)│
   │   stelle für         │                         │ ─ chat-gateway          │
   │   Identitäts-Certs   │                         │ ─ voice-signaling       │
   │   (Ed25519, ~1 Jahr) │                         │ ─ media-svc             │
   │ ─ CRL für Revokation │                         │ ─ mediamtx-auth-hook    │
   │ ─ Instance-Registry  │                         │ ─ LiveKit + MediaMTX    │
   │ ─ Notice-and-Action  │                         │ ─ coturn (TURN/STUN)    │
   │                      │                         │ ─ Postgres (embedded)   │
   │ JWKS public          │                         │ ─ Redis (embedded)      │
   └──────────────────────┘                         │ ─ Caddy (Reverse-Proxy) │
   ┌──────────────────────┐                         │ ─ Watchtower (Updates)  │
   │ Cloud chat-gateway   │                         └─────────────────────────┘
   │ + voice-signaling    │                                   ▲
   │ + media-svc          │                                   │
   │ (separate Container, │                                   │
   │  infra/prod/)        │      ┌───── Cert-Auth + Challenge-Response
   └──────────────────────┘      │       (privater Key bleibt im Browser)
            ▲                    │
            │                    │       ┌──── CRL-Pull alle 30s
            │ Cert-Issuance      │       │     JWKS-Pull (selten)
            │ (selten, beim      │       │     Update-Webhook (CI-Push)
            │  Geräte-Add)       │       │
            └────────┐    ┌──────┴───────┴─────┐
                     │    │                    │
              ┌──────┴────┴───────────────────┐│
              │  Frontend (eine App)          ││
              │  ─ Ed25519-Keypair lokal      ││
              │    (IndexedDB, non-extractable)│
              │  ─ Identitäts-Cert (von Cloud)│
              │  ─ Profile-Statement          │
              │  ─ pro Server eine            │
              │    WS-Connection              │
              │  ─ Server-Liste: localStorage │
              │    (nie an Cloud)             │
              └───────────────────────────────┘
```

**Cloud sieht NICHT, wo der User aktiv ist** (DE 5 + DE 11). Sie ist
Zertifizierungs-Stelle, kein Identity-Provider mit Token-Pumpe. Cert wird
einmal beim Geräte-Add ausgestellt, danach validiert Self-Host **lokal** via
gepullter JWKS. Cloud erfährt nur über CRL-Polls dass Self-Host "lebt" (kein
User-Bezug).

---

## Phase 1 — `auth-svc` zur Zertifizierungs-Stelle erweitern

Heute hat `auth-svc` `/register`, `/login`, `/refresh`, RS256-Signing und
`/.well-known/jwks.json` (`routes.py:393`, `security.py:52`). Es fehlen die
**Credential-Endpoints** (DE 11, primärer Pfad) für Identitäts-Cert-Ausstellung
+ Profile-Statements + CRL. Zusätzlich gebaut wird ein **OAuth-Fallback-Pfad**
für Edge-Cases, der aber nicht primär ist.

**Cloud-internal Browser-Session** (Punkt 3, neu — Voraussetzung für die Credential-Endpoints):
- Nach erfolgreichem `/login` (Username + Passwort + MFA wenn gefordert) setzt auth-svc einen **HttpOnly + SameSite=strict + Secure**-Session-Cookie (`pulse_session=...`, ~30 Min TTL, auto-refreshed bei Activity).
- Cookie ist nur für die Cloud-Domain (`pulse.unicutmedia.com`), nicht für Self-Hosts.
- Cloud-API-Calls (`POST /credentials/issue`, `GET /credentials/profile-statement`, `POST /me/profile`, `POST /me/username`, `POST /me/instance-applications`, `POST /me/logout-everywhere`, `POST /admin/*` etc.) authentifizieren via Session-Cookie.
- Cookie-Storage: `auth.user_sessions` (`session_id UUID PK, user_id BIGINT, created_at, last_seen_at, expires_at, amr JSONB, acr TEXT, user_agent TEXT, ip INET`). Score-basierter Cleanup-Job entfernt abgelaufene Sessions.
- **Logout-Everywhere** (DE 11 A.11) revoked alle Sessions des Users zusätzlich zu den Certs.
- **Self-Host-Auth** läuft komplett über Cert-Modell — keine Session-Cookies.

**Neue Endpunkte** (`services/auth/src/dcc_auth/routes_credentials.py`, neu — primärer Auth-Pfad ab DE 11):

**Identitäts-Cert** (stabil, ~1 Jahr):
- `POST /credentials/issue` — User-Browser/Electron lädt seinen frisch generierten
  Ed25519-Public-Key hoch + Geräte-Label, bekommt **Identitäts-Cert** zurück
  (JWT, RS256-signiert). Enthält NUR stabile Claims: `cert_id`, `user_id`,
  `device_pubkey`, `device_label`, `pairwise_seed`, `amr`, `acr`, `iat`, `exp`.
  Voraussetzung: aktive User-Session (Username+Passwort+MFA wenn Geräte-Add).
- `GET /credentials/list` — Liste aller aktiven Geräte-Certs des Users (für Geräte-Management-UI)
- `POST /credentials/{cert_id}/revoke` — User markiert ein Gerät als „abmelden" → wandert in CRL
- `GET /.well-known/revoked-credentials` — CRL als JSON-Liste der `cert_id`s **aller noch nicht expirierten** revozierten Certs (Self-Host pollt alle 30s, DE 9). Öffentlich, privacy-konform. **Wichtig**: Einträge bleiben in CRL bis `cert.expires_at < now()` (also bis zu ~1 Jahr nach Revocation), NICHT nur ~10 Min — sonst würde Self-Host nach kurzer Zeit „vergessen" dass Cert revoked ist und Angreifer käme durch.

**Profile-Statement** (kurzlebig, 24h):
- `GET /credentials/profile-statement` — Frontend holt aktuelles Profile-Statement.
  Cloud signiert mit RS256. Enthält: `statement_id`, `user_id`, `username`,
  `display_name`, `avatar_hash`, `profile_color`, `iat`, `exp` (24h).
  Wird beim Geräte-Setup initial geholt + automatisch alle ~20h refreshed.
- `POST /me/profile` — User ändert Avatar/Display-Name/Profile-Color. Cloud
  invalidiert in-flight Statement-Cache, neues Statement wird beim nächsten
  `GET /credentials/profile-statement` ausgestellt.
- `POST /me/username` — Username-Change (DE 11 A.3). Eindeutigkeits-Check,
  30-Tage-Reservierung der alten Username (anti-Squatting). Profile-Statement
  wird invalidated.

**Encrypted-Key-Backup** (DE 11 A.6, Zero-Knowledge):
- `POST /credentials/{cert_id}/backup` — Frontend lädt verschlüsselten privaten
  Schlüssel + Argon2id-Params + GCM-Nonce hoch. Cloud speichert nur Ciphertext.
- `GET /credentials/{cert_id}/backup` — Holt encrypted Blob fürs Recovery.
- `DELETE /credentials/{cert_id}/backup` — User löscht Backup (z.B. wenn er Master-Passwort vergessen hat und neu einrichten will).
- Backup-Tabelle (`auth.encrypted_key_backups`):
  ```sql
  CREATE TABLE auth.encrypted_key_backups (
    cert_id        UUID PRIMARY KEY REFERENCES auth.issued_credentials(cert_id),
    user_id        BIGINT NOT NULL REFERENCES auth.users(id),
    device_label   TEXT NOT NULL,        -- Klartext für UI ("Mein Laptop")
    encrypted_blob BYTEA NOT NULL,       -- AES-256-GCM(ed25519-privkey)
    argon2_salt    BYTEA NOT NULL,       -- 16 Bytes random
    argon2_params  TEXT NOT NULL,        -- z.B. "t=3,m=65536,p=4"
    gcm_nonce      BYTEA NOT NULL,       -- 12 Bytes random
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ```
- `GET /.well-known/pulse-version-policy.json` — Cloud-Versions-Stand (DE 10), nur Diagnose:
  ```json
  {"current_version": "0.8.0"}
  ```

**Optional / fallback** (`services/auth/src/dcc_auth/routes_oidc.py`):
- Klassischer OAuth-PKCE-Flow als **Fallback** falls Cert-Modell für Edge-Cases nicht greift
  (Server-zu-Server-Auth z.B.). In Stufe A nicht primärer Pfad — gebaut aber nicht beworben.

**Identitäts-Cert-Claims** (`services/auth/src/dcc_auth/credentials.py`, neu — primär ab DE 11, stabile Identity-Werte):
- `cert_id` — UUID v4, für CRL-Lookup
- `user_id` — Snowflake, eindeutig für den User
- `device_pubkey` — Ed25519-Public-Key des Geräts (Base64)
- `device_label` — User-vergebener Name ("Mein Laptop")
- `pairwise_seed` — **Pro USER** (nicht pro Cert!), aus `auth.users.pairwise_salt` (32 Bytes). Kombiniert mit `instance_id` zu Self-Host-spezifischem `sub`. Gleicher Wert in allen Certs desselben Users → Multi-Device funktioniert.
- `iat`, `exp` — Issued + ~1 Jahr Validity
- **`amr`-Claim** (vom Login-Vorgang vererbt): Auth-Methoden bei Cert-Issuance
  - Passwort-only → `amr=["pwd"]`
  - Passwort + TOTP → `amr=["pwd", "otp"]`
  - Passwort + Passkey-2FA → `amr=["pwd", "webauthn"]`
  - Passwortloser Passkey-Login → `amr=["webauthn"]`
- **`acr`-Claim**: `"0"` = nur Passwort, `"1"` = MFA wurde durchlaufen. Self-Host kann via
  `acr_values=mfa` im Cert-Request MFA fordern (DE 8 Step-Up, beim Add-Server-Flow Pflicht).

**Profile-Statement-Claims** (separates JWT, 24h Validity, änderbare Werte):
- `statement_id` — UUID v4
- `user_id` — Snowflake (gleich wie im Cert, verbindet beide)
- `username` — aktueller Username (änderbar via `POST /me/username`)
- `display_name` — UI-Anzeigename
- `avatar_hash` — SHA-256 des aktuellen Avatars
- `profile_color` — optional, accent-color
- `iat`, `exp` — Issued + 24h Validity

**Fallback-JWT-Claims (OAuth-Pfad)** (`security.py:96` `issue_access()`):
- Wenn der klassische OAuth-Fallback genutzt wird: `aud` pro Client, `jti` für JTI-Revocation
  (alte Mechanik, parallel verfügbar aber nicht primärer Pfad in Stufe A).

**OAuth-Authorize-Verhalten bei `acr_values=mfa`:**
- Self-Host (oder der Cloud-Add-Server-Flow) darf `acr_values=mfa` im Authorize-Request setzen.
- Aktuelle Session war MFA → Token kriegt `acr=1`, `amr` entsprechend.
- Aktuelle Session war nicht MFA (z.B. User hat Passkey gar nicht, ist nur per Passwort drin) → **Step-Up erzwingen** (RFC 9470):
  - User hat MFA eingerichtet → Re-Auth-Prompt (TOTP oder Passkey)
  - User hat MFA nicht eingerichtet → Setup-Flow erzwingen, dann zurück zum Authorize
- Der **Add-Server-Flow im Frontend** (Phase 4, `AddServerDialog`) setzt **immer** `acr_values=mfa`,
  unabhängig davon, was der Self-Host verlangt. Doppelte Absicherung schadet nicht.

**Recovery-Politik (DE 8 + A.6 zusammen, Punkt 20):**
- **MFA-Recovery**: 10 Backup-Codes bei MFA-Setup. Kein E-Mail-Reset, kein Admin-Reset.
- **Geräte-Schlüssel-Recovery**: optionales Master-Passwort-Cloud-Backup (DE 11 A.6, Zero-Knowledge).
- **Beide Mechanismen sind unabhängig**: Backup-Codes ersetzen MFA-Faktor beim Login. Master-Passwort entschlüsselt den Geräte-Schlüssel-Backup. User der beides verliert (kein MFA + kein Master-Passwort + alle Backup-Codes weg) → Account permanent verloren.
- MFA-Setup-UI muss eine **harte Warnung** zeigen ("Verlierst du sowohl dein 2FA-Gerät als auch alle Backup-Codes, ist dein Account dauerhaft verloren. Es gibt keinen Recovery-Pfad."). A.6-Setup-UI zeigt analoge Warnung fürs Master-Passwort.
- Backup-Codes-Re-Download (nach Login mit MFA) ist erlaubt — gibt's heute schon
  via `/2fa/backup-codes/regenerate` (verifizieren in `routes_totp.py`).
- **Backup-Code-Re-Generate-Sicherheit** (Punkt 21 aus Review #4): Neue Codes werden **nur einmalig** im UI angezeigt (modal mit „Ich habe sie sicher gespeichert"-Bestätigung), danach nicht mehr abrufbar. Alte Codes werden sofort invalidiert. Frontend-Memory-Cleanup nach Modal-Close. UI warnt explizit: „Speichere die Codes JETZT — sie werden nie wieder angezeigt."

**TTL-Defaults** (DE 9 + DE 11):
- **Identitäts-Cert** (Cert-Modell primär): `cert_validity_days: 365` (~1 Jahr). User rotiert proaktiv vor Ablauf bei nächstem Cloud-Kontakt.
- **Self-Host-Session-Token** (lokal, post-Cert-Validation): `session_token_ttl_seconds: 300` (5 Min, refreshable via Cert-Re-Auth).
- **Fallback OAuth-Pfad** (nur falls Cert-Modell für Edge-Cases nicht greift):
  - `jwt_access_ttl_seconds: 300` (5 Min, heute 900)
  - `jwt_refresh_ttl_seconds: 60*60*24*30` (30 Tage)
  - Diese Werte gelten nur für den OAuth-Fallback, NICHT für den primären Cert-Pfad — Cert-Modell hat keine Refresh-Tokens.

**CRL-Backend** (DE 9 + DE 11, `routes_credentials.py` + neue Redis-Struktur):
- Tabelle `auth.issued_credentials`: `cert_id` (PK), `user_id`, `device_label`,
  `device_pubkey`, `issued_at`, `expires_at`, `revoked_at` (nullable).
- "Account suspendieren" oder "Geräte einzeln abmelden": setzt `revoked_at` + fügt
  `cert_id` in `auth:revoked_certs` (Redis Sorted-Set, Score = Expiry) ein.
  Score-basierter Auto-Prune löscht Einträge, deren Expiry vergangen ist
  (CRL bleibt bounded auf Validity-Window).
- `GET /.well-known/revoked-credentials` liefert
  `{"version": 1, "cert_ids": ["..."]}` — Self-Host filtert lokal. **Liste enthält
  alle revozierten Certs deren `expires_at > now()`** (= bis 1 Jahr Lookback).
  Auto-Prune entfernt nur Einträge mit `expires_at < now()`. Realistische Größe:
  10k User × 3 Geräte × ~5% jährliche Revocation-Rate = ~1500 Einträge im Pool.
  Plain-JSON OK bis ~10k Einträge (~360 KB), danach Bloom-Filter.
- **HTTP-Caching** (Punkt 15): Endpoint setzt `ETag`-Header (Hash der Liste).
  Self-Host pollt mit `If-None-Match` → bei unveränderter Liste antwortet Cloud
  **304 Not Modified** (~200 Bytes statt ~360 KB bei 10k Einträgen).
  Bei 300 Self-Hosts × 30s Polling spart das ~95% Cloud-Traffic.
- **Schaden-Fenster bei Revocation**: Self-Host-CRL-Poll-Lag (max 30s) + Self-
  Host-Session-Token-TTL (5 Min) = max 5:30 Min bis User wirklich raus ist.

**Library:** `cryptography` (Ed25519-Support, schon im Dep-Tree via py_webauthn)
für Cert-Signing. `authlib` für OAuth-Fallback-Pfad. Refresh-Token-Reuse-Mitigation
aus `routes.py:314` bleibt nur im Fallback-Pfad relevant.

**JWT-Validation-Härte** (Punkt 9): Cert-Validation MUSS `alg=RS256` **hartcoded** prüfen — NICHT vom JWT-Header ableiten. `pyjwt.decode(token, key, algorithms=["RS256"])` mit explicit Whitelist. Verhindert `alg=none`-Attacks. Test: `services/auth/tests/test_credentials_alg_none.py` prüft dass manipuliertes Token mit `alg=none` als `alg`-Header nicht akzeptiert wird.

**Timing-Attack-Schutz** (Punkt 14 aus Review #4): CRL-Membership-Check (Redis-Set, O(1)) vs. Signature-Validation (~ms) hat Timing-Differenz. `credential_validator` macht IMMER beide Checks in fester Reihenfolge (Signature first, dann CRL) auch wenn früherer Check schon fehlschlägt — `secrets.compare_digest`-Style. Verhindert dass Angreifer aus Response-Time ableitet ob Cert in CRL oder Signature kaputt.

**Cert-Validation-Cache-Invalidation** (Punkt 22 aus Review #4): Self-Host caches Validation-Results pro Cert in Redis (`auth:valid:cert:<cert_id>`, 5-Min TTL — synchron mit Session-Token-TTL) für Performance. **CRL-Pull invalidiert betroffene Einträge atomar**: nach jedem CRL-Update iteriert über neue `cert_id`s, löscht `auth:valid:cert:<cert_id>` Schlüssel. Verhindert dass revoked Cert kurz noch durchgeht weil cached.

**Concurrent-Cert-Issuance-Schutz** (Punkt 1 aus Review #4): Wenn User in zwei Tabs gleichzeitig `POST /credentials/issue` aufruft, könnte er 2 Geräte ungewollt registrieren. Mitigation: **Idempotency-Key** im Request-Body (`idempotency_key=hash(device_pubkey)`). Cloud prüft: wenn Cert mit gleichem `device_pubkey` schon existiert (nicht-revoked), returnt das existierende Cert statt neues zu erstellen. Frontend nutzt deterministisch denselben Key für denselben Browser-Tab-Set.

**CRL-Pull-Race direkt nach Cert-Issue** (Punkt 2 aus Review #4): Self-Host pollt CRL → Cert wird ausgestellt → kurz danach revoked. Self-Host's nächster Poll (max 30s später) holt aktualisierte CRL. **Sub-30s-Schaden-Fenster akzeptabel** — analog zu jeder CRL-basierten Architektur. Plus: Cert-Validation prüft auch `cert.expires_at > now()` (extra Schutz wenn Cert sehr kurz vor Issue läuft, sollte aber nie passieren bei 1-Jahr-Validity).

**Cert-Issuance Rate-Limit** (Punkt 11): `POST /credentials/issue` ist via slowapi rate-limited auf **max 3 Calls / Stunde / User**. Verhindert Account-Hijack-Followup wo Angreifer 10000 Certs erstellt + revoked um CRL aufzublähen. Geräte-Limit (A.5: 20 aktive) als zweite Linie.

**GDPR-Export-Endpoint** (Punkt 12, Art. 15 — Auskunft): `GET /me/gdpr-export` → returnt JSON mit allen Cloud-Daten des Users:
- `auth.users`-Row (Username, E-Mail, Created, MFA-Status)
- Liste aller Geräte-Certs (Cert-IDs, Labels, Issuance-Daten)
- Liste aller Instance-Applications + Status
- Liste aller Profile-Statement-Issuance-Logs der letzten 90 Tage
- Aktive Sessions
- HINWEIS im Export: "Pulse-Cloud weiß NICHT, auf welchen Self-Hosts du Mitglied bist (DE 11 Privacy). Für vollständige GDPR-Auskunft musst du jeden Self-Host-Admin separat kontaktieren."
Rate-Limited auf 1× pro 24h pro User (verhindert Bulk-Export-Abuse).
**Zusätzlich CSRF + MFA-Schutz** (Punkt 20 aus Review #4): Export-Request verlangt CSRF-Token (aus Session-Cookie) + frische MFA-Re-Auth (innerhalb der letzten 5 Min) — verhindert dass via CSRF-Attack oder gestohlenes Session-Cookie alle PII abgegriffen werden.

**Privacy-Constraint im Audit-Log (Cert-Modell, DE 11):**
- Audit nur **Cert-Issuance** (User, Gerät-Label, Timestamp, IP) — selten, ~jährlich + bei Geräte-Add.
- Audit für **Profile-Statement-Issuance** (selten, bei Avatar/Name-Change).
- Kein Endpoint, der "auf welchen Self-Hosts ist User X?" beantwortet (technisch nicht herleitbar wegen Pairwise-Subs).
- **Kein Bulk-/Lookup-Endpoint für fremde Profile** — Self-Host pollt NIE über fremde User. Profile kommen ausschließlich aus Cert + Profile-Statement, die User selbst mitbringt.
- OAuth-Fallback's `/userinfo` (falls genutzt) validiert nur das vom User selbst gehaltene Token, kein Bulk-Lookup.

---

## Phase 2 — Instance-Registry auf der Cloud

Neue Tabelle im `auth`-Schema
(`services/auth/alembic/versions/…_0014_instance_registry.py`, neu):

```sql
CREATE TABLE auth.registered_instances (
  id              BIGINT PRIMARY KEY,        -- Snowflake
  hostname        TEXT UNIQUE NOT NULL,      -- z.B. chat.firma.de
  client_id       TEXT UNIQUE NOT NULL,      -- Self-Host-Identifikation gegenüber Cloud
  client_secret   TEXT NOT NULL,             -- Argon2id-Hash. Use-Cases: (1) Worker-ID-Lookup beim First-Start (Punkt 14), (2) OAuth-Fallback-Pfad (Server-zu-Server)
  redirect_uris   JSONB NOT NULL DEFAULT '[]'::jsonb,  -- nur für OAuth-Fallback-Pfad relevant, im Cert-Modell ungenutzt (Punkt 13)
  worker_id_chat  SMALLINT NOT NULL,
  worker_id_voice SMALLINT NOT NULL,
  worker_id_media SMALLINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',  -- active | suspended
  registered_by   BIGINT NOT NULL REFERENCES auth.users(id),
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE auth.issued_credentials (
  cert_id       UUID PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES auth.users(id),
  device_pubkey BYTEA NOT NULL,             -- Ed25519-Public-Key (32 Bytes raw)
  device_label  TEXT NOT NULL,              -- User-vergebener Name
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,       -- iat + 365d
  revoked_at    TIMESTAMPTZ                 -- NULL = aktiv, sonst CRL-Eintrag bis expires_at
);
CREATE INDEX ON auth.issued_credentials (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON auth.issued_credentials (expires_at);
```
(Punkt 4: `issued_credentials`-Schema explizit hier, war vorher nur in Phase-1-Prosa erwähnt.)

**Worker-ID-Vergabe**: Reserviere **1–99 für Cloud** (heute 1–3), **100+ für
Self-Hosts** (3 Worker-IDs pro Instance). Snowflake-Range 0–1023 → ~300
Self-Host-Instanzen, reicht für Stufe A.

**User-facing Antrags-Endpunkte** (jeder eingeloggte Cloud-User):
- `POST /me/instance-applications` — Self-Hoster reicht Antrag ein. Body:
  `{hostname, purpose, expected_users, contact_email, notes}`. Persistiert in
  `auth.instance_applications` (neue Tabelle: `id`, `applicant_user_id`, `hostname`,
  `purpose`, `expected_users`, `contact_email`, `notes`, `status` (`pending`/`approved`/`rejected`),
  `reviewed_by`, `reviewed_at`, `rejection_reason`, `created_at`).
- `GET /me/instance-applications` — eigene Anträge + Status sehen.
- `GET /me/instances` — alle freigeschalteten eigenen Instances + Credentials-Download
  (Secret nur einmal sichtbar nach Approval, danach Hash + Hinweis "Falls verloren: neu generieren").

**Admin-Endpunkte** (Bootstrap-Admin only, DE 11 — kein Self-Service-Registration
in Stealth-Beta-Phase, alles über manuelle Reviews):
- `GET /admin/instance-applications?status=pending` — Liste offener Anträge
- `POST /admin/instance-applications/{id}/approve` — du genehmigst → Instance wird
  in `auth.registered_instances` erstellt, `client_id` + `client_secret` generiert,
  applicant kriegt sie unter `/me/instances` zum Download (einmaliger Klartext).
- `POST /admin/instance-applications/{id}/reject` — du lehnst ab mit Begründung.
- `GET /admin/instances` — Liste aller Instances
- `DELETE /admin/instances/{id}` — Sperren (`status='suspended'`, kein hard-delete wegen Snowflake-Historie). Triggert auch Eintrag in `auth.suspended_instances`-Tabelle (DE 11 B.1).
- `POST /admin/instances/{id}/unsuspend` (DE 11 B.1) — Entsperrung, entfernt aus Suspended-Liste, sendet E-Mail-Notification an Self-Hoster.
- `POST /admin/instances/{id}/rotate-secret` — neues `client_secret` generieren (für "vergessenes Secret"-Recovery)
- `GET /.well-known/pulse-suspended-instances` (öffentlich, DE 11 B.1) — JSON-Liste `{"version":1,"instance_ids":[...],"updated_at":"..."}`. Self-Host pollt alle 5 Min, Frontend alle ~1h. ETag-Caching wie CRL.
- `POST /admin/instances/_broadcast-update` — Internal/CI-only (auth via
  `INTERNAL_SERVICE_SECRET`, DE 10): iteriert alle `status='active'` Instances,
  signiert pro Instance ein kurzlebiges JWT (`{purpose:"watchtower-update", instance_id:<id>, exp:now+60s}`)
  mit Cloud's RS256-Key, ruft parallel `POST {hostname}/internal/trigger-update`
  mit `Authorization: Bearer <jwt>`. Returnt Summary `{ok: [...], failed: [...]}`.
  Wird vom GitHub-Actions-Deploy-Step aufgerufen direkt nach `docker push`.
  **Kein gespeichertes Watchtower-Token in der Cloud-DB** — Cloud-DB-Leak würde
  sonst Update-Hijack auf jedem Self-Host erlauben.

**Admin-UI** (`web/src/lib/components/admin/AdminInstances.svelte`, neu) als Tab
neben `AdminPlugins.svelte` auf `/app/admin`. Zeigt:
- **Pending Applications** (top): Liste mit Antrag-Details, Approve/Reject-Buttons
  mit Begründungs-Textarea
- **Active Instances**: Liste + Suspend/Rotate-Secret-Actions
- **Suspended Instances**: separate Liste, reversible

**User-UI für Self-Hoster-Antrag** (`web/src/lib/components/account/SelfHostApplication.svelte`,
neu): im Account-Settings-Bereich. Formular: Hostname (mit Validierung), Zweck-
Dropdown (privat/verein/firma/sonst), erwartete User-Anzahl, Kontakt-E-Mail (default
= Cloud-E-Mail), Notizen.

**User-UI für Credentials-Verwaltung** (`web/src/lib/components/account/MyInstances.svelte`,
neu): zeigt Antrags-Status + nach Approval die Credentials. `client_secret` ist
nur direkt nach Approval einmalig sichtbar (Banner: "Speichere das jetzt — danach
weg"). Download-Button für vorgefertigtes `.env`-Snippet bzw. `docker run`-Befehl
mit den Credentials eingebaut.

**Notice-and-Action-Endpoint** (DE 11, neu: `routes_reports.py` auf auth-svc):
- `POST /reports` — öffentlich, rate-limited. Eingabe: Beschwerde-Text + URL/Referenz
  + Kontakt-E-Mail (optional). Persistiert in `auth.complaints` (neue Tabelle:
  `id`, `target_instance_id` (nullable), `target_user_id` (nullable), `body`,
  `submitter_email`, `submitted_at`, `status` (`new`/`acknowledged`/`forwarded`/`resolved`),
  `resolution_note`, `resolved_at`).
- `GET /admin/complaints` (Bootstrap-Admin only) — Liste + Bearbeitung
- `POST /admin/complaints/{id}/forward` — leitet an Self-Host-Admin weiter (E-Mail
  + on-the-fly-Notice-Token), setzt Frist.
- In Stealth-Beta-Phase (DE 11) ist der Endpoint da, aber realistisch wenig Last —
  Phase-0-Beta-User wissen nicht mal von der Cloud-Bekanntheit. Workflow + UI
  sind aber von Anfang an fertig.

---

## Phase 3 — `chat-gateway` Self-Host-tauglich + privacy-konformer Profile-Cache

**Derselbe Code, unterschiedliche Konfiguration + Infrastruktur** (Punkt 16):
- **Cloud-Deployment** (`infra/prod/`, Multi-Container): chat-gateway als separater Container, extern Postgres + Redis, kein LiveKit/coturn im selben Stack (separate Container). User-Auth via **`user_id` direkt** (kein Pairwise-Sub, DE 11 A.4).
- **Self-Host-Deployment** (`infra/self-host/`, Single-Container DE 12): chat-gateway als Sub-Prozess in pulse-allinone, embedded Postgres + Redis + LiveKit + coturn im selben Container. User-Auth via **Pairwise-Sub** (DE 11 A.4).
- Code-Pfad ist identisch, Konfiguration entscheidet:
  - `PULSE_INSTANCE_MODE=cloud` → direkter `user_id` aus Cert, kein Pairwise-Hash
  - `PULSE_INSTANCE_MODE=self-host` → Pairwise-Sub-Berechnung mit `instance_id` + `pairwise_seed`

Was sich konkret ändert gegenüber heutigem chat-gateway: Konfigurierbarkeit + Cert-Validation + Profile-Beschaffung ohne Cloud-Pollen.

**Config-Änderungen** (`config.py:24`):
```python
auth_jwks_url     = "https://pulse.unicutmedia.com/.well-known/jwks.json"
jwt_audience      = "self-host:<instance_id>"   # bzw. "cloud" für Cloud-Instanz
jwt_issuer        = "dcc-auth"
pulse_oidc_issuer = "https://pulse.unicutmedia.com"
```

**JWKS-Persistence** (`security.py:65`):
Heute in-memory mit 3600s-TTL. Neu:
- Bei erfolgreichem Fetch → persistiere in Redis (`auth:jwks:cached`, kein TTL).
- Startup: Redis-Cache zuerst, dann HTTP-Fetch.
- HTTP-Fail: Last-known-good aus Redis verwenden + WARN. Aktive WS-Sessions
  laufen weiter; neue Logins schlagen mit klarem Fehler fehl (kein 401-Loop).
- **JWKS-Cold-Start** (Punkt 12): Self-Host startet zum ersten Mal, hat keinen Redis-Cache + Cloud nicht erreichbar → Container startet trotzdem hoch (Services laufen), aber `credential_validator` markiert sich als "JWKS not ready" → alle WS-Connect-Versuche bekommen WS-Close 4046 "Server initialisiert noch". Retry-Loop alle 30s im Hintergrund. Bei erfolgreichem Fetch: ready, Validierung läuft. Healthcheck-Endpoint reflektiert das (returns 503 solange "not ready").
- **JWKS-Pinning** (Punkt 10 aus Review #5, Defense-in-Depth): Beim First-Start speichert chat-gateway den SHA-256-Hash der initial gepullten JWKS in `/data/jwks-pin.txt`. Bei jedem späteren Pull: wenn Hash sich ändert UND die alten `kid`s nicht mehr enthalten sind (Key-Rotation-Detection) → WARN-Log + Admin-UI-Banner "Cloud-JWKS hat sich unerwartet geändert, prüfen ob legit". Verhindert DNS-Hijack-Szenarien wo Self-Host gegen Fake-Cloud-Endpoint pullt. TLS-Cert-Validation alleine deckt das nicht (TLS-Cert kann auch falsch ausgestellt sein bei CA-Compromise).

**User-Profile-Cache** (neu: `user_profile_cache.py`, DE 11 Profile-Statement-Modell) — **privacy-konform**:

Heute holt `auth_mirror.py:32` Profile per `POST /internal/users/discoverable`
direkt aus der Cloud-DB. Das wäre für Self-Host ein Privacy-Leak (Cloud würde
sehen, wessen Profile auf welchen Self-Hosts angefragt werden). Stattdessen
**Profile-Statement-Push-Modell** (DE 11 A.2):

1. **Beim WS-Connect** pusht der User sein **Cloud-signiertes Profile-Statement**
   (24h Validity) an den Self-Host. Self-Host validiert Signatur via Cloud-JWKS,
   prüft `iat > last_seen_statement_iat[user_id]` (Replay-Protection, DE 11 A.3).
2. **Beim Statement-Refresh** (alle ~20h oder bei Profil-Change) pusht der Client
   das neue Statement an alle aktiven Self-Host-WS-Connections.
3. **Beim Beitritt zu einer Guild** dito: Member liefert aktuelles Statement mit.
4. **Anzeige fremder Profile** (z.B. Message-Autor offline): aus Self-Host-Cache.
   Wenn nicht gecacht → Fallback "User <ID>" + Default-Avatar. Kein Cloud-Lookup.
5. **Cache-Storage**: Redis-Hash `user:profile:<user_id>` (Username, Avatar-Hash,
   Display-Name, Profile-Color, `last_seen_statement_iat`) + Postgres-Tabelle
   `chat.cached_user_profiles` für Persistenz nach Redis-Flush. Schema (Punkt 9 aus Review #5):
   ```sql
   CREATE TABLE chat.cached_user_profiles (
     user_identifier  TEXT PRIMARY KEY,        -- user_id in Cloud / Pairwise-Sub in Self-Host
     username         TEXT NOT NULL,
     display_name     TEXT NOT NULL,
     avatar_hash      TEXT,
     profile_color    TEXT,
     last_statement_iat TIMESTAMPTZ NOT NULL,  -- für Replay-Protection (DE 11 A.3)
     updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     stale            BOOLEAN NOT NULL DEFAULT FALSE  -- gesetzt wenn Statement >24h alt
   );
   CREATE INDEX ON chat.cached_user_profiles (username);  -- für Mention-Suche (DE 14)
   ```
6. **Statement-Expiry-Handling**: Wenn gecachtes Profile-Statement älter als 24h
   ist und User nicht aktiv → Self-Host behält den Eintrag (besser stale-Profil
   als gar keins), markiert es aber als `stale=true`. UI kann das optional zeigen.

→ Self-Host pollt die Cloud **nie** über fremde User. Die Cloud erfährt nicht,
welche User auf welchem Self-Host bekannt sind. Statement-Issuance auf Cloud-Seite
zeigt nur "User X holt sein eigenes Profil", nicht wer es auf welchen Servern braucht.

**@-Mention-Suche** (Punkt 14 aus Review #5): Self-Host-Mention-Autocomplete sucht ausschließlich im **lokalen** `chat.cached_user_profiles` (Username-Index). Nur User die auf diesem Self-Host bereits aktiv waren (= Profile-Statement gepusht haben) sind suchbar. Bei Username-Wechsel: Profile-Statement-Refresh aktualisiert die Tabelle, neue Mention-Suche findet neuen Username. Alter Username verschwindet aus Index (Profile-Statement enthält nur aktuellen). Edge-Case: User mentioned `@alice_old` direkt nach Username-Change — Self-Host's Cache hat noch alten Eintrag bis nächster Statement-Push, dann konsistent.

**Server-Info-Endpoint** (DE 10):
- `GET /.well-known/pulse-server-info` (öffentlich, kein Auth):
  ```json
  {
    "server_version": "0.8.0",
    "pulse_oidc_issuer": "https://pulse.unicutmedia.com",
    "instance_id": "<snowflake>",
    "capabilities": []
  }
  ```
  Frontend liest das **vor** dem Cert-Auth-Flow im Add-Server-Dialog. Wenn
  `server_version != cloud_policy.current_version` → Add-Server bricht früh mit
  "Server-Update läuft vermutlich noch, in ein paar Minuten erneut versuchen".
  Sonst weiter mit Cert-Auth (DE 11).
- `capabilities` bleibt für Stufe A leer (keine Capability-Gates unter Modell A,
  DE 10) — aber das Feld existiert von Anfang an, damit Migration zu Modell B/C
  später nicht das Schema bricht.

**Cloud-Policy-Poller** (`cloud_policy_poller.py`, neu, DE 10):
- Pollt `https://pulse.unicutmedia.com/.well-known/pulse-version-policy.json`
  alle 6h (konfigurierbar). Persistiert in Redis.
- Nur Diagnose-Zweck (DE 10 finale Variante): wenn Self-Host's `server_version`
  != Cloud's `current_version` → Admin-UI zeigt Banner "Update läuft vermutlich
  noch, Watchtower sollte das automatisch fixen". Keine 14-Tage-Vorwarnungen,
  kein `upcoming_min`/`sunset_date` (DE 10: instant updates, keine Verzögerung).
- Fail-Soft: Cloud nicht erreichbar → letzter bekannter Stand.

**WS-Handshake-Hello-Frame** (DE 10):
- Direkt nach WS-Connect (vor Ready) schickt Self-Host:
  ```json
  {"op":"hello","server_version":"0.8.0","capabilities":[]}
  ```
- Frontend prüft Min-Server-Version aus seinem gebakten `MIN_SERVER_VERSION`-Build-
  Constant. Wenn Server-Version != gebakte Version → WS-Close 4044 ("server too old"), UI zeigt sanften Update-Banner ("Server wird gerade aktualisiert, in ~30 Sekunden wieder da"). **Keine Toleranz** (DE 10 finale Variante: instant updates, kein N-1) — Reconnect-Backoff gibt Watchtower Zeit zu pullen.

**Mod-Tools im Core** (DE 11, neu: `routes/reports.py` + `routes/mod_queue.py`):
- `chat.reports` (neue Tabelle): `id`, `reporter_user_id`, `target_message_id`
  (nullable), `target_user_id` (nullable), `target_channel_id` (nullable),
  `reason_code` (enum: spam, harassment, illegal, csam, other), `body`,
  `created_at`, `status` (`new`/`triaged`/`resolved`/`dismissed`), `resolver_user_id`,
  `resolved_at`, `resolution_note`.
- `chat.mod_audit_log` (neue Tabelle): immutable Log aller Mod-Aktionen
  (Permission-Change, Ban, Message-Delete, Report-Resolution etc.).
- `POST /reports` — User meldet Inhalt (rate-limited per User).
- `GET /guilds/{id}/mod-queue` — Guild-Mods sehen offene Reports (Permission:
  `MANAGE_MESSAGES` oder `BAN_MEMBERS` oder `MANAGE_GUILD`).
- `POST /guilds/{id}/mod-queue/{report_id}/resolve` — Mod-Aktion + Audit-Log-Eintrag.
- **Kein Opt-out**: Tabellen sind im Core-Migration, Endpoints sind immer aktiv.
  In Stealth-Beta-Phase wenig Last, ab Phase 1 sofort nutzbar.

**Cert-Validation + CRL-Pull** (neu: `credential_validator.py` + `crl_poller.py`, DE 9 + DE 11):
- **WS-Connect-Flow** (Self-Host-Seite):
  1. Client sendet Identitäts-Cert im WS-Hello-Frame
  2. Self-Host validiert Cert-Signatur via Cloud-JWKS (lokal, kein Cloud-Call)
  3. Self-Host prüft `cert_id` gegen lokale CRL-Cache (Redis-Set `auth:revoked:certs`)
  4. Self-Host schickt Challenge (random 32 Bytes) → Client signiert mit privatem Schlüssel
  5. Self-Host verifiziert Challenge-Signature mit `device_pubkey` aus Cert
  6. Self-Host erstellt lokalen Session-Token (5 Min TTL), gibt Connection frei
- **CRL-Poller** Background-Task pollt `https://pulse.unicutmedia.com/.well-known/revoked-credentials`
  alle 30s (hart erzwungen, kein Opt-out konsistent mit DE 10). Antwort persistiert in Redis-Set
  `auth:revoked:certs` mit per-Cert-TTL = `expiry - now`.
- Fail-Soft: Cloud nicht erreichbar → letzter bekannter Stand bleibt aktiv, WARN-Log. Nicht hart
  fehlschlagen (Offline-Garantie aus DE 2).

**Snowflake-Worker-ID via Env-Var** (Punkt 13): Mechanik existiert (`config.py:56`).
Bei Single-Container-Setup (DE 12) automatisch: `cont-init.d`-Skript fragt Cloud beim
First-Start ab (`GET /admin/instances/{client_id}/worker-ids` mit client_secret) →
bekommt 3 Worker-IDs (chat/voice/media) → schreibt in `/data/.env` → Services laden
beim Start. Lookup nur einmalig beim First-Start, danach lokal gecached. Bei
manueller Multi-Container-Setup (Power-User): Worker-IDs aus Cloud-UI manuell
in `.env` setzen.

**`INTERNAL_SERVICE_SECRET`** bleibt **Cloud-intern** (auth-svc ↔ Cloud-
chat-gateway). Self-Host-Instanzen rufen `auth-svc` ausschließlich via
öffentliche Credential-Endpoints (`/.well-known/jwks.json`,
`/.well-known/revoked-credentials`, `/.well-known/pulse-version-policy.json`).

---

## Phase 4 — Frontend zu Multi-Backend-Client umbauen

Das ist die größte Frontend-Änderung. Heute ist `web/` Single-Backend
(`web/src/lib/api/client.ts:21`, ein `ApiEndpoint`-Mapping, ein Token im
localStorage). Neu: pro Server eine eigene Connection + eigene Token.

**Identitäts-Cert + Schlüsselpaar** (DE 11, neu: `web/src/lib/identity/`):
- `keypair.svelte.ts` — generiert beim ersten Cloud-Login Ed25519-Keypair via
  WebCrypto (Browser) bzw. Node-Crypto (Electron). Privater Schlüssel wird in
  `IndexedDB` mit `non-extractable`-Flag persistiert (kann nicht ausgelesen werden,
  nur signiert). **Ausnahme**: bei aktiviertem Cloud-Backup wird das Keypair mit
  `extractable: true` generiert, damit es für Backup verschlüsselbar ist.
  - **Browser-Support-Check** (Punkt 12 aus Review #5): WebCrypto Ed25519 ist erst seit Safari 17 / Chrome 117 / Firefox 130 verfügbar. Beim App-Start wird Feature-Detection gemacht (`crypto.subtle.generateKey({name:'Ed25519'},...)`). Bei nicht-unterstützten Browsern: Fallback auf `@noble/curves`-Library (Pure-JS Ed25519, ~30KB gzipped). Etwas langsamer aber funktional identisch.
  - **Inkognito-Mode-Warnung** (Punkt 13 aus Review #5): Frontend prüft beim Setup ob `navigator.storage.persist()` verfügbar UND erfolgreich → wenn nicht (Inkognito-Mode-Detection): hard-Banner "Du bist im Inkognito-/Privatfenster — IndexedDB wird beim Schließen gelöscht. Pulse funktioniert dann beim nächsten Mal nicht mehr. Bitte normales Browserfenster nutzen.".
  - **Electron-IndexedDB-Persistenz** (Punkt 16 aus Review #5): Electron-`BrowserWindow` muss `webPreferences: {partition: 'persist:pulse'}` setzen — sonst ist IndexedDB beim App-Restart weg, was den ganzen Cert-Modell-Pfad bricht. Kritischer Check in `desktop/electron/main.ts`.
- `cert.svelte.ts` — hält Identitäts-Cert (JWT), pushed beim WS-Connect zu Self-Hosts
  + signiert Challenges mit privatem Key.
- `profile-statement.svelte.ts` (neu, DE 11 A.2) — hält aktuelles Profile-Statement,
  refreshed alle ~20h via `GET /credentials/profile-statement`, pusht aktualisiertes
  Statement an alle aktiven Self-Host-WS-Connections.
- `device-list.svelte.ts` — fetched `GET /credentials/list` für Geräte-Management-UI,
  POST `/credentials/{cert_id}/revoke` für Single-Device-Abmelden.
- `key-backup.svelte.ts` (neu, DE 11 A.6) — Cloud-Backup-Flow: Master-Passwort-
  Setup via Argon2id (WebAssembly-Build von `argon2-browser`), AES-256-GCM-
  Verschlüsselung des privKey via WebCrypto, Upload + Recovery-Flow.

**Neue Storage-Struktur** (`web/src/lib/api/servers.svelte.ts`, neu):
```ts
type ServerEntry = {
  id: string;                 // lokale UUID (kein Cloud-Tracking)
  hostname: string;           // z.B. https://chat.firma.de
  instance_id: string;        // Snowflake der Instance (vom Self-Host bei Cert-Auth zurückgegeben)
  label: string;              // User-vergeben oder vom Server geholt
  pairwise_sub: string;       // Pro-Server-Pseudonym (vom Self-Host nach Cert-Auth zurückgegeben, NICHT client-seitig berechnet)
  session_token: string;      // Self-Host-lokales 5-Min-Token (DE 9, in Memory + auto-refresh, nicht persistiert für XSS-Härte)
  session_expires: number;
  isCloud: boolean;           // true für pulse.unicutmedia.com
  notification_mode: 'all' | 'mentions' | 'none';  // Fallstrick #9
};

const servers = $state<ServerEntry[]>([]);  // persistiert in localStorage (OHNE session_token — der bleibt in Memory)
```

Persistenz: `localStorage["pulse.servers"]` im Browser bzw. Electron-Store
`pulse-servers.json` (analog `desktop/electron/store.ts`). **Nie an Cloud
gesendet.** Identitäts-Cert + privater Schlüssel separat in IndexedDB (nicht in
localStorage, weil non-extractable Key-Storage).

**Client-Refactor** (`web/src/lib/api/client.ts`):
- `request(serverId, endpoint, ...)` statt `request(endpoint, ...)` —
  Server-ID identifiziert, welches Backend angesprochen wird.
- Token-Auswahl + Refresh aus `servers.svelte.ts` (statt globalem Auth-Store).
- **Cross-Origin** (Punkt 18): REST-Calls vom Cloud-Frontend zum Self-Host
  brauchen CORS-Header (`Access-Control-Allow-Origin: https://pulse.unicutmedia.com`
  + `Allow-Credentials: true`). WebSocket-Connections nutzen Origin-Header-Check
  (kein CORS) — Self-Host validiert `Origin: https://pulse.unicutmedia.com` direkt
  in `credential_validator`. Wenn Origin nicht in Whitelist (Cloud-Domain + ggf.
  Self-Host eigener Hostname für Health-Check-Tools): WS-Close 4003.

**WS-Multi-Connection** (`web/src/lib/ws/`):
Heute eine WS-Connection (`gateway.svelte.ts`, eine `Map<ChannelId, Listener>`).
Neu: **eine Map `Map<ServerId, GatewayConnection>`**. Jede Connection hält ihre
eigenen Reconnect-/Heartbeat-Loops. UI bekommt Events vom "aktiven" Server.

**WS-Handshake-Hello-Check** (DE 10):
Erstes Frame nach Connect = Self-Host's `{op:"hello", server_version, ...}`.
Frontend prüft Min-Version-Toleranz. Bei Inkompatibilität → Close mit Code 4044,
UI markiert den Server als "veraltet, Update läuft" mit Reconnect-Retry-Loop
(exponential backoff, max 5 Min — gibt Watchtower Zeit zu pullen + Container zu
restarten + Migration zu fahren).

**Sanfter Update-Banner** (DE 10, neu: `web/src/lib/components/server/UpdateBanner.svelte`):
Wenn WS-Close mit Code 4044 (Server veraltet) ODER 4045 (Server gerade im Update)
empfangen wird, statt rotem "Disconnected!"-Symbol einen freundlichen Banner zeigen:
"[chat.firma.de] wird gerade aktualisiert, sollte in 30 Sekunden wieder da sein."
Banner verschwindet automatisch beim erfolgreichen Reconnect. Reconnect-Loop läuft
im Hintergrund (max 5 Min Backoff).

**Reconnect-Backoff konkrete Werte** (Punkt 19): Exponential, deterministisch:
1s → 2s → 4s → 8s → 16s → 32s → 60s → 120s → 300s (=5 Min Cap, dann konstant).
Bei `acr=0`-Cert + Self-Host-MFA-Pflicht-Reject (WS-Close 4047): Reconnect-Loop
abbrechen, UI zeigt „Bitte einmal MFA-Re-Auth durchführen" mit Button zur
Cloud-Login-Page. Reconnect-Loop alleine hilft hier nicht — User muss aktiv.

**Notifications bei Multi-Backend** (Fallstrick #9, neu: `web/src/lib/notifications/`):
- **Web**: Service Worker hält alle WS-Connections im Background offen (notification-only-
  Modus, kein Full-State-Sync). Web Push API für Browser-Notifications. Permission-
  Request beim Add-Server-Flow. Pro Server eine konfigurierbare Notification-Queue
  (alle/nur Mentions/aus).
- **Electron**: Tray-Icon mit Unread-Badge, OS-native Notifications via IPC zum Main-
  Prozess (`window.pulse.notify()` in `preload.ts`, IPC-Handler in `main.ts` — heute
  noch TODO, siehe CLAUDE.md). Wake-Lock damit OS die App nicht schläft. Mehrere
  WS-Connections parallel sind in Electron-Fenster kein Problem (kein Service Worker
  nötig).
- **Notification-Queue pro Server**: ServerEntry-Store (DE 11) bekommt Feld
  `notificationMode: 'all' | 'mentions' | 'none'`. UI in Server-Kontextmenü
  ("Stummschalten").

**Sidebar-UI** (`web/src/lib/components/sidebar/ServerList.svelte`, anpassen):
- Discord-Style vertikale Icon-Spalte
- Oben: Cloud-Server (`pulse.unicutmedia.com`-Guilds + DMs/Friends)
- Trennlinie
- Darunter: Self-Host-Server (jeder ist ein Icon mit Hostname-Hover **+ Self-Host-Badge** zur klaren Unterscheidung von Cloud, DE 11)
- Plus-Icon "Server hinzufügen" → Dialog mit URL-Eingabe

**Self-Host-Disclaimer** (DE 11, neu: `web/src/lib/components/server/SelfHostDisclaimer.svelte`):
Beim ersten Beitritt zu einem Self-Host (pro Server, einmalig persistiert in
`localStorage`) zeigt ein dezenter Toast/Banner: "Dieser Server wird von
[hostname] betrieben — nicht von Pulse-Cloud. Es gelten dortige Regeln und
Datenschutz-Bestimmungen." Mit "Verstanden"-Bestätigung. Kein Eintritts-Friction,
aber juristisch sichtbare Kommunikation.

**Browser-Storage-Privacy** (Punkt 15 aus Review #4, `web/src/lib/components/settings/PublicComputerSafety.svelte`, neu): In Settings Option "Auf öffentlichem Computer? Daten löschen + abmelden" — purged IndexedDB (Keypair + Cert), localStorage (Server-Liste, alle Caches), Browser-Sessions. Self-Hoster-Memberships bleiben auf Self-Host-Seite bestehen (User kann von anderem Gerät wieder einsteigen). Plus: Login-Page kann optional Checkbox "Öffentlicher Computer — nach Logout alles löschen" anbieten.

**WS-Hello-Frame-Signing** (Punkt 16 aus Review #4): Server-Hello-Frame `{op:"hello", server_version, instance_id, capabilities}` ist **vom Self-Host mit seinem JWKS-Key signiert** (Signature in Frame als `sig: "..."`-Feld). Frontend validiert die Server-Signatur — verhindert dass Browser-Extension/Man-in-the-Middle das Hello-Frame fälscht. Skaliert: Self-Host hat keinen eigenen Signing-Key — vereinfachte Variante: Hello-Frame ist NICHT signiert (akzeptabel weil Frontend gegen TLS-Cert + Cloud-Pre-Check schon validiert dass es der richtige Server ist). **Entscheidung**: für Stufe A NICHT signiert (zusätzliche Komplexität ohne klaren Angriffsvektor — TLS deckt MitM, Cloud-Pre-Check deckt Server-Identität). Im Doku-Kommentar erwähnen dass Hello-Frame-Signing eine spätere Härtungs-Option ist.

**Report-Button** (DE 11): Im Message-Kontextmenü "Melden" → `POST /reports` an
den jeweiligen Self-Host (oder Cloud, je nach Server). Einfaches Reason-Dropdown
+ optionaler Freitext.

**Mod-Queue-UI** (DE 11, neu: `web/src/lib/components/admin/ModQueue.svelte`):
Im `GuildSettingsDialog` als neuer Tab "Moderation" für User mit `MANAGE_MESSAGES`
o.ä. Permissions. Listet offene Reports, ermöglicht Resolution + Audit-Log-Einsicht.
**Cloud-suspendierte User-Markierung** (Punkt 7 aus Review #4): Self-Host's Mod-UI zeigt User mit revoked Cert (Audit-Log-Einträge) mit grauem "Cloud-account suspended"-Badge. Self-Host-Admin kann „Unban" klicken aber das hat keine Wirkung weil User sich eh nicht mehr authentifizieren kann — UI zeigt Tooltip „Unban wirkt erst wenn Cloud-Account wieder aktiv ist". Tatsächlich gespeichert wird die Unban-Aktion (für audit-log), aktiv wird sie aber erst wenn User wieder zurückkommt.

**"Server hinzufügen"-Flow** (`web/src/lib/components/sidebar/AddServerDialog.svelte`, neu):
1. User trägt URL ein (z.B. `https://chat.firma.de`).
1a. **Pre-Check (DE 10)**: Frontend ruft `GET /.well-known/pulse-server-info` ab.
    Wenn `server_version < MIN_SUPPORTED_SERVER_VERSION` → Dialog bricht mit klarer
    Meldung: "Dieser Server läuft auf einer veralteten Version (X.Y.Z). Update
    läuft vermutlich gerade, in ein paar Minuten erneut versuchen."
2. **Self-Host-Disclaimer** anzeigen (DE 11, einmalig pro Server): "Du verlässt
    die Pulse-Cloud — dieser Server wird vom Hoster betrieben, andere Regeln gelten."
3. Frontend nimmt das **gehaltene Identitäts-Cert** (aus `cert.svelte.ts`) + den
    privaten Schlüssel und macht den Cert-Auth-Flow zum Self-Host:
    a. WS-Connect mit Cert im Hello-Frame
    b. Self-Host validiert, schickt Challenge
    c. Frontend signiert Challenge mit privatem Schlüssel
    d. Self-Host gibt lokales Session-Token (5 Min TTL) zurück
4. **MFA-Step-Up bei Bedarf** (DE 8): wenn das gehaltene Cert nicht aus einer
    MFA-Session entstand und der Self-Host MFA verlangt → Frontend triggert
    Re-Auth bei Cloud zur Erneuerung des Certs mit `acr=1`-Claim.
5. Erfolgreich → ServerEntry (mit Pairwise-Sub + Session-Token) wird in
    localStorage gespeichert + WS-Connection bleibt etabliert.

**Aktiver-Server-State** (`web/src/lib/stores/active-server.svelte.ts`, neu):
Welcher Server gerade in der Sidebar selektiert ist. Alle View-Komponenten
(GuildList, ChannelView, Friends) lesen daraus die `serverId`.

**Login-Page für Cloud-Domain** bleibt wie heute (E-Mail + Passwort). Es gibt
**keine** Self-Host-eigene Login-Page mehr — Self-Hosts brauchen kein Frontend
auszuliefern (siehe Phase 6).

---

## Phase 5 — Invite-Flow + Hinzufügen eines Self-Host-Servers

User auf der Cloud bekommt einen Invite-Link, z.B. `https://chat.firma.de/invite/abc123`.

**Klick öffnet**: die Cloud-App mit Deep-Link
`https://pulse.unicutmedia.com/app/add-server?invite=https://chat.firma.de/invite/abc123`.

(Das ist die saubere Variante, weil der Self-Host kein eigenes Frontend hat
und die Cloud-App den Server-Switcher steuert. Bookmark-fähig.)

**Flow** (Cert-Modell, DE 11):
1. Cloud-App öffnet AddServerDialog mit vorbefülltem Hostname (`chat.firma.de`).
2. **Pre-Check**: `GET https://chat.firma.de/.well-known/pulse-server-info` (DE 10) — Versions-Check.
3. **Self-Host-Disclaimer** anzeigen (DE 11, einmalig pro Server).
4. **MFA-Step-Up bei Bedarf** (DE 8): wenn das aktuelle Identitäts-Cert nicht aus einer
   MFA-Session entstand → Cloud-Re-Auth mit `acr=1` → neues Cert mit `acr=1`-Claim.
5. **Cert-Auth-Flow zum Self-Host**:
   a. Frontend öffnet WS zu `wss://chat.firma.de/ws`, sendet Identitäts-Cert im Hello-Frame
   b. Self-Host validiert Cert via Cloud-JWKS (lokal, kein Cloud-Call), prüft CRL
   c. Self-Host schickt Challenge → Frontend signiert mit privatem Schlüssel
   d. Self-Host verifiziert Challenge-Signature mit `device_pubkey` aus Cert
   e. Self-Host gibt lokales Session-Token (5 Min TTL) zurück
6. **Invite akzeptieren**: POST an `chat.firma.de/invites/abc123/accept` mit
   Session-Token → erstellt lokalen `chat.members`-Record mit
   `user_id=<Pairwise-Sub für diese Instance>`.
7. ServerEntry persistiert in localStorage (mit Pairwise-Sub + Session-Token),
   Sidebar zeigt neuen Server.

**Schon vorhanden**: Invite-Code-System (`chat.invites` — bitte vor
Implementierung verifizieren in `services/chat-gateway/src/dcc_chat_gateway/routes/invites.py`).

**Edge-Case**: Wenn der User die Invite-URL direkt öffnet (`chat.firma.de/invite/abc123`),
liefert der Self-Host eine **minimale HTML-Seite** mit Meta-Refresh/Link zur
Cloud-App-URL. Kein vollständiges Frontend nötig.

**First-Time-Setup-Flow** (Fallstrick #10): Wenn der User Cloud-App ohne
existierenden Account öffnet (`?invite=...`-Param erkannt, aber keine Session) →
Cloud-Login-Page mit Banner "Du wurdest zu [Server] eingeladen. Bitte zuerst
Pulse-Account anlegen oder einloggen — danach kommst du automatisch zum Invite zurück."
Nach erfolgreichem Cloud-Auth + Cert-Issuance → Redirect zurück zum AddServerDialog
mit dem Original-Invite-Code (in `sessionStorage` zwischenparken).

**Cross-Server-DMs gehen nicht** (Fallstrick #11): UI zeigt im Friends/DM-Tab des
aktiven Servers nur Friends/DMs **innerhalb dieses Servers** — kein Server-übergreifender
Friend-List. Beim Versuch, eine DM-Adresse aus Server A auf Server B zu öffnen:
Hinweis "DMs sind pro Server isoliert (Privacy-by-Design). Um mit Alice auf
beiden Servern zu chatten, muss sie auf beiden Servern Mitglied sein." Kein
Cross-Server-Workaround — das würde Cert-Pairwise-Sub-Privacy brechen.

---

## Phase 6 — Self-Host-Deployment (Single-Container All-in-One)

**Distribution-Modell (User-Entscheidung 2026-05-25):** Self-Hoster bekommen ein
**einziges Docker-Image** (`ghcr.io/oblivion8282-1337/pulse-allinone:stable`)
in dem alle Services + embedded Postgres + embedded Redis + LiveKit + MediaMTX +
coturn + Caddy laufen. Kein `docker-compose.yml` zu pflegen. Setup = **ein
Befehl**. Klassisches Multi-Container-Compose existiert nicht als Self-Host-Option.

**Was im Container läuft** (via s6-overlay als Process-Supervisor):
- `postgres` (embedded, daten in `/data/pg/`, initdb beim First-Start)
- `redis-server` (embedded, daten in `/data/redis/`)
- `chat-gateway`, `voice-signaling`, `media-svc`, `mediamtx-auth-hook` (Python-Services)
- `livekit-server` (Go-Binary)
- `mediamtx` (Go-Binary)
- `coturn` (für Voice-NAT-Traversal, Fallstrick #6)
- `caddy` (Reverse-Proxy + Auto-TLS via Let's Encrypt)
- `watchtower` (für Self-Update, DE 10)

**Identischer Code-Pfad wie Cloud-Production**: chat-gateway nutzt asyncpg wie
in Cloud, keine SQLite-Special-Logik in Production. Migrations laufen via
Alembic beim Container-Start. Postgres-Daemon-Overhead ~50 MB RAM, lächerlich
bei modernem Server.

**Realistisches Skalierungs-Limit pro Container**: ~1000-1500 aktive User je
nach Hardware (4 Cores, 8 GB RAM Server). Bottleneck ist CPU/RAM/Bandbreite,
nicht die Datenbank. Für Stealth-Beta + alle wahrscheinlichen Self-Host-Größen
mehr als ausreichend. Wer wirklich wächst, exportiert Postgres via `pg_dump`
und baut eigene Skalierung — wir dokumentieren das nicht, ist Power-User-Only.

**Update-Modell** (DE 10): Watchtower pullt das **eine** Pulse-Image alle 5 Min
als Fallback. Cloud-CI triggert per JWT-signiertem Webhook direkt nach Push.
Container-Restart ist atomar (alle Services gleichzeitig down + up). Kein
`PULSE_AUTO_UPDATE`-Opt-out: Self-Hoster, der Watchtower deaktiviert, ist beim
nächsten Cloud-Deploy inkompatibel und fliegt am WS-Hello-Check raus.

**Bekannte Limitation Single-Container** (DE 12): Container-Restart bei Update
unterbricht **ALLES gleichzeitig** — auch laufende Voice-Calls (LiveKit restartet
mit) und Streams (MediaMTX restartet mit). User-Clients reconnecten automatisch
binnen 30s. Bei Multi-Container wäre rolling restart möglich, ist hier explizit
nicht möglich — Trade-off des Single-Container-Modells. Dokumentiert in
`docs/SELF_HOST.md` unter "Was passiert bei Updates".

**Watchtower-HTTP-API Hardening** (DE 10): Watchtower's HTTP-API bindet
ausschließlich auf `127.0.0.1` im Container. **Caddy proxied diese Route NICHT
extern** — nur `chat-gateway`'s `/internal/trigger-update`-Endpoint ist von außen
erreichbar (mit JWT-Validation). Self-Host-Compromise auf Container-Network-
Ebene ist trotzdem möglich, aber dann hat der Angreifer eh Container-Access.

**`/internal/trigger-update` Rate-Limiting** (Punkt 16): Endpoint ist
rate-limited auf **max 10 Calls / 5 Min** pro Source-IP (slowapi). Verhindert
Replay-Attacks mit abgefangenen JWTs. Plus: JWT-`jti`-Tracking via Redis-Set
`watchtower:used_jtis` (10 Min TTL) — derselbe JWT kann nicht zweimal genutzt
werden, auch nicht innerhalb seiner 60s Validity.

**TURN-Credentials-Rotation** (DE 12 + Fallstrick #6): coturn nutzt
time-limited credentials (REST-API-Style). Secret wird beim First-Start
generiert (`/data/coturn-secret`), persistent über Container-Restarts.
Credentials werden vom voice-signaling-Service pro Voice-Session generiert
(HMAC-SHA1 mit dem Secret, 8h Validity) → aktive Sessions bleiben gültig auch
nach Container-Restart. Secret-Rotation manuell durch Self-Hoster (löscht
`/data/coturn-secret`, restart → neues Secret).

**coturn-Secret-Sharing** (Punkt 19): voice-signaling-Service liest das Secret
beim Start aus `/data/coturn-secret` (read-only Mount/Permission). Im Single-
Container teilen alle Services denselben `/data`-Mount via s6-overlay-Setup.
coturn-Daemon selbst hat dieselbe Datei als Static-Auth-Secret-Konfiguration
(im `coturn.conf.template` referenziert). Bei Secret-Rotation muss Container
neu gestartet werden (beide Services laden neu).

**Backup-Encryption-Hinweis** (DE 10b): `pg_dump`-Backups in `/data/backups/`
sind plain SQL. **Self-Hoster ist verantwortlich für Disk-Encryption auf
Host-Level** (LUKS, ZFS-Encryption etc.). Wer richtige Defense-in-Depth will,
mountet `/data` auf einem encrypted Volume. Dokumentiert in `docs/SELF_HOST.md`.

**Operative Standards** (Review #4):
- **Logging** (Punkt 10): Alle Sub-Services loggen **structured JSON auf stdout** (Docker-Standard, von s6-overlay an Docker-Log durchgereicht). PII-Filter: chat-gateway-Middleware redactet `username`, `email`, `cert_id` aus Error-Logs. Log-Level via `PULSE_LOG_LEVEL` (Default `info`).
- **Container-Restart-Loop-Limit** (Punkt 12): s6-overlay-Service-Definitionen haben `max-restart-count=5` pro Sub-Service. Nach 5 Fail-Restarts in 60s: Container-Exit (Docker `restart: unless-stopped` greift → Cleaner Restart). Verhindert Endless-Loop bei Postgres-Korruption etc.
- **Disk-Space-Mitigation** (Punkt 13): Bei `/data` <20% frei → Health-Endpoint returnt `disk_warning:true`. Bei <5% frei: Backup-Job pausiert (verhindert Voll-Schreiben). Bei <1% frei: chat-gateway geht in Read-Only-Modus (User können noch lesen + offline-Backup-Export machen, aber nicht mehr schreiben). Self-Hoster-Notification via Admin-UI-Banner.
- **Caddy-TLS-Failure-Handling** (Punkt 17): Wenn Let's-Encrypt-Cert-Fetch beim First-Start fehlt (DNS nicht korrekt etc.): Container loggt aussagekräftige Fehler („DNS für chat.firma.de zeigt nicht auf diese Maschine"). Self-Host läuft trotzdem hoch (auf Port 80 ohne TLS) für Diagnose. Setup-Doku in `docs/SELF_HOST.md` warnt: „DNS-A-Record VOR `docker run` setzen, sonst hängt Caddy in Retry-Loop".

**Setup für Self-Hoster** = ein Befehl:
```bash
docker run -d --name pulse \
  -v pulse-data:/data \
  -p 443:443 -p 80:80 -p 7882-7892:7882-7892/udp -p 3478:3478 -p 3478:3478/udp \
  -e PULSE_HOSTNAME=chat.firma.de \
  -e PULSE_CLOUD_CLIENT_ID=... \
  -e PULSE_CLOUD_CLIENT_SECRET=... \
  -e PULSE_ADMIN_EMAIL=admin@firma.de \
  ghcr.io/oblivion8282-1337/pulse-allinone:stable
```
Container generiert beim First-Start automatisch: alle internal Secrets, Worker-
Token für Watchtower-HTTP, coturn-Credentials, JWT-Signing-Keys, initdb. Kein
`setup.sh` mehr nötig.

**Self-Host-interner JWT-Signing-Key** (Punkt 11 aus Review #5): Beim First-Start
generiert `cont-init.d` ein Ed25519-Schlüsselpaar in `/data/jwt_keys/session-token-signing.pem`
(Private + Public). Self-Host-Session-Tokens (DE 9, 5-Min-TTL) werden damit
signiert. chat-gateway + voice-signaling + media-svc lesen den Public-Key beim
Start zum Validieren. Manual-Rotation: Self-Hoster löscht Datei + Container-
Restart → neuer Key. Alle laufenden Sessions werden invalidated (User reconnect
automatisch via Cert).

**Coturn-Default** (Fallstrick #6): default-aktiv im Container für Voice-NAT-
Traversal. Opt-out via `PULSE_TURN_DISABLED=true` für Self-Hoster mit eigenem TURN.

**Caddy-Config**: erzeugt beim First-Start, setzt CORS-Allow für die Cloud-Domain
(`Access-Control-Allow-Origin: https://pulse.unicutmedia.com` + `Allow-Credentials`).
Auto-TLS via Let's Encrypt wenn Port 80 + 443 erreichbar; Fallback auf User-
provided Cert via `/data/certs/`-Volume-Mount für Hoster ohne Public-Reach.

**Security-Headers** (Punkt 10, Caddy-Default für alle Responses):
- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` (HSTS, 1 Jahr)
- `Content-Security-Policy: default-src 'self'; connect-src 'self' wss://*; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'` (XSS-Härte, kein iframe-Embedding)
- `X-Frame-Options: DENY` (Backup gegen ältere Browser)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(self), microphone=(self), display-capture=(self), geolocation=()`
Identische Headers in Cloud-Production-Caddy (`infra/prod/Caddyfile`) — Pflicht für beide.

**Pflicht-Env-Vars** (nur diese 4 nötig, alles andere generiert sich selbst):
- `PULSE_HOSTNAME=chat.firma.de` — DNS-Name, hinter dem der Server erreichbar ist
- `PULSE_CLOUD_CLIENT_ID=...` — von Cloud-Approval
- `PULSE_CLOUD_CLIENT_SECRET=...` — von Cloud-Approval
- `PULSE_ADMIN_EMAIL=admin@firma.de` — für Let's-Encrypt-TLS-Anmeldung + Health-Probe-Notifications (DE 10c)

**Automatisch gesetzt im Single-Container** (Punkt 24+25 aus Review #4):
- `PULSE_CLOUD_ORIGIN=https://pulse.unicutmedia.com` — Default, override-bar für private Cloud-Foundation-Setups
- `PULSE_INSTANCE_MODE=self-host` — Default für Single-Container. Cloud-Multi-Container nutzt `=cloud`

**Optionale Env-Vars:**
- `PULSE_TURN_DISABLED=true` — wenn eigener TURN
- `PULSE_TLS_MODE=auto|provided` — Default `auto` (Let's Encrypt), `provided` für eigenes Cert in `/data/certs/`
- `PULSE_DATA_PATH=/data` — Volume-Mount-Pfad (Default ok)
- `PULSE_LOG_LEVEL=info|debug`
- `PULSE_BACKUP_RETENTION_PRE=3` — Anzahl Pre-Update-Backups (DE 10b, Default 3)
- `PULSE_BACKUP_RETENTION_WEEKLY=4` — Anzahl wöchentlicher Snapshots (DE 10b, Default 4)
- `PULSE_BACKUP_DISABLED=true` — komplett deaktivieren (nicht empfohlen, nur für externe Backup-Lösungen)

**Setup-Doku** (`docs/SELF_HOST.md`, neu) — wirklich Schritt für Schritt:
1. **Cloud-Account anlegen** auf `pulse.unicutmedia.com`, MFA einrichten (DE 8 Pflicht für Self-Host-Hoster).
2. **Self-Host-Antrag stellen** im Cloud-UI: "Ich möchte selbst hosten" → Formular (Hostname, Zweck, Kontakt).
3. **Warten auf Approval** (manuell, du als Bootstrap-Admin reviewst — DE 11 Stealth-Beta).
4. **Credentials abholen** im Cloud-UI unter "Meine Self-Host-Instances": `client_id` + `client_secret` (einmalig anzeigbar, Download als `.env`-Snippet).
5. **Domain vorbereiten**: DNS-A-Record auf eigene Server-IP, Ports 80 + 443 + 3478 + 7882-7892/udp freischalten.
6. **Container starten** mit dem einen `docker run`-Befehl (siehe oben).
7. **Healthcheck**: `https://chat.firma.de/health` muss 200 OK liefern.
   **Beim First-Start dauert das ~60-120s**: Caddy holt Let's-Encrypt-
   Cert (~30-60s, erfordert Port 80+443 erreichbar + DNS korrekt), Postgres-initdb
   läuft (~10s), JWKS-Cold-Start kann Cloud-Fetch brauchen (~5s). Bei Container-
   Restarts danach: ~20-30s (TLS-Cert schon gecacht in `/data/caddy/`).

**Drei verschiedene Health-Endpoints klar getrennt** (Punkt 17):
- `/health` (öffentlich, kein Auth) — Caddy proxied zu `chat-gateway`. Simpler Status: 200 wenn alle Services laufen, sonst 503. Für Monitoring/Uptime-Checks. Kein User-Bezug, kein Privacy-Leak.
- `/internal/health-probe` (Cloud-only, JWT-validiert) — speziell für DE 10c Health-Probe nach Update. Validiert JWT mit `purpose=health-probe`. Returnt detailliertes JSON (version, services, last_migration, etc.). Caddy proxied auch.
- `pulse-health`-Script (Container-internal, nur via `docker exec`) — wird vom Dockerfile-`HEALTHCHECK` aufgerufen, prüft via s6-overlay-Sockets ob alle Sub-Services up sind. Nicht extern erreichbar.
8. **Erster Login** auf `pulse.unicutmedia.com` → "Server hinzufügen" → `chat.firma.de` eintragen → wird automatisch Server-Owner.

**Setup-Doku-Abschnitte zusätzlich** (Fallstricke #5, #7, #13):
- **TLS + Public-Reach** (Fallstrick #7): Empfohlene Pfade je nach Setup —
  Caddy-Auto-TLS via Let's Encrypt (Standard); DynDNS-Service (DuckDNS, No-IP)
  für nicht-statische IPs; **Cloudflare Tunnel** oder **Tailscale Funnel** als
  Alternative bei nicht-möglichem Port-Forwarding (Carrier-Grade-NAT, restriktive
  Firewall). Schritt-für-Schritt-Anleitung pro Pfad.
- **DNS-Leakage-Hinweis** (Fallstrick #5): In `docs/PRIVACY_SELF_HOST_TEMPLATE.md`
  (Vorlage für Self-Hoster-Datenschutzerklärung): "Der ISP/DNS-Resolver des Users
  sieht den Hostnamen dieses Servers — gilt für jede Website, technisch unvermeidbar.
  Wer das vermeiden will, nutze DNS-over-HTTPS oder Tor."
- **Hostname-Anti-Squatting-Policy** (Fallstrick #13): in `docs/INSTANCE_APPROVAL_POLICY.md`
  (Cloud-interne Doku): "Keine verwechselbaren Hostnamen genehmigen (z.B. `pulse-unicutmedia.com`
  mit Bindestrich). Geprüft beim Admin-Approval (DE 11 — Bootstrap-Admin-only)."

---

## Kritische Dateien

**Backend** (auth-svc, Cloud-Seite):
- `services/auth/src/dcc_auth/routes_credentials.py` (neu, DE 11) — Cert-Issue/List/Revoke/Profile-Statement
- `services/auth/src/dcc_auth/credentials.py` (neu, DE 11) — Cert-Signing + Pairwise-Sub-Derivation
- `services/auth/src/dcc_auth/routes_oidc.py` (neu) — OIDC-Fallback-Endpoints
- `services/auth/src/dcc_auth/security.py:96` — `issue_access()` für per-Client `aud` (Fallback-Pfad)
- `services/auth/src/dcc_auth/routes_admin_instances.py` (neu) — Instance-CRUD + Approval-Workflow
- `services/auth/src/dcc_auth/routes_me_instances.py` (neu) — User-facing Anträge + Credentials-Download
- `services/auth/alembic/versions/…_0014b_instance_applications.py` (neu) — Antrags-Tabelle
- `services/auth/src/dcc_auth/routes_reports.py` (neu, DE 11) — Notice-and-Action
- `services/auth/alembic/versions/…_0014_instance_registry.py` (neu)
- `services/auth/alembic/versions/…_0015_complaints.py` (neu, DE 11)
- `services/auth/alembic/versions/…_0016_issued_credentials.py` (neu, DE 11)
- `services/auth/alembic/versions/…_0017_encrypted_key_backups.py` (neu, DE 11 A.6) — Backup-Tabelle
- `services/auth/alembic/versions/…_0018_user_pairwise_salt.py` (neu, DE 11 A.4) — pairwise_salt-Spalte für `auth.users`
- `services/auth/alembic/versions/…_0019_username_reservations.py` (neu, DE 11 A.3) — Anti-Squatting-30-Tage-Reservierung (Punkt 17)
- `services/auth/src/dcc_auth/routes_admin_users.py` (neu, DE 11 A.11) — Admin-User-Suspension (Bootstrap-Admin only)
- `services/auth/src/dcc_auth/routes_me_account.py` (neu, DE 11 A.9 + A.11) — User-Self-Service: Logout-Everywhere + Account-Löschung
- `services/auth/src/dcc_auth/account_deletion.py` (neu, DE 11 A.9) — Hard-Delete-Cascade: revoked Certs + Backups + Anträge → schließlich `auth.users`-Row
- `services/auth/src/dcc_auth/browser_sessions.py` (neu, Punkt 3) — Cookie-basierte Cloud-internal-Session-Verwaltung (HttpOnly + SameSite=strict)
- `services/auth/src/dcc_auth/routes_gdpr.py` (neu, Punkt 12) — `GET /me/gdpr-export` (rate-limited 1×/24h)
- `services/auth/alembic/versions/…_0020_user_sessions.py` (neu, Punkt 3) — Browser-Session-Cookie-Tabelle
- `services/auth/alembic/versions/…_0021_suspended_instances.py` (neu, DE 11 B.1 / Review #4) — Suspended-Liste-Tabelle
- `services/auth/alembic/versions/…_0022_users_revoke_until.py` (neu, Race-Schutz aus Review #4) — `revoke_until`-Watermark in `auth.users`
- `services/auth/alembic/versions/…_0023_encrypted_backup_previous_blob.py` (neu, MP-Change-Flow Review #4) — `previous_blob`-Spalte für 30-Tage-Migration-Window
- `services/auth/alembic/versions/…_0024_snowflake_worker_16bit.py` (neu, DE 14 Review #5) — Worker-Spalten von SMALLINT auf INTEGER + Cutover-epoch_ms
- `services/auth/alembic/versions/…_0025_expected_owner_pairwise_sub.py` (neu, DE 11 A.12 Review #5) — Spalte in `registered_instances`
- **Migration-Nummern-Disclaimer**: Alle Migration-Pfade hier sind **Platzhalter** — Real-Stand vor Implementation prüfen (`alembic current` für jeden Service). chat-gateway aktuell bei `0020 user_preferences` + `0021 guild_plugin_state` (CLAUDE.md), Plan-Migrations beginnen also bei `0022+`. auth-svc-Stand muss verifiziert werden.
- `services/auth/src/dcc_auth/suspended_instances.py` (neu, DE 11 B.1) — Suspension-Set-Verwaltung + ETag-CRL-Endpoint
- `services/auth/pyproject.toml` — `authlib` + `cryptography` (Ed25519-Support, schon im Dep-Tree via py_webauthn)

**Backend** (chat-gateway, Cloud + Self-Host):
- `services/chat-gateway/src/dcc_chat_gateway/config.py:24` — JWKS-URL + Audience konfigurierbar
- `services/chat-gateway/src/dcc_chat_gateway/credential_validator.py` (neu, DE 11) — Cert-Validation + Challenge-Response
- `services/chat-gateway/src/dcc_chat_gateway/crl_poller.py` (neu, DE 9+11) — CRL-Pull alle 30s
- `services/chat-gateway/src/dcc_chat_gateway/suspension_poller.py` (neu, DE 11 B.1) — Suspended-Instances-Pull alle 5 Min, eigenen instance_id checken, bei Match: alle Requests rejecten mit 503
- `services/chat-gateway/src/dcc_chat_gateway/session_tokens.py` (neu, DE 9) — Self-Host-lokale 5-Min-Tokens
- `services/chat-gateway/src/dcc_chat_gateway/security.py:65` — JWKS-Persistence in Redis + Cert-Check gegen `auth:revoked:certs`
- `services/chat-gateway/src/dcc_chat_gateway/cloud_policy_poller.py` (neu) — Pollt `pulse-version-policy.json` (DE 10)
- `services/chat-gateway/src/dcc_chat_gateway/routes/well_known.py` (neu) — `/.well-known/pulse-server-info` + WS-Hello-Frame-Hook
- `services/chat-gateway/src/dcc_chat_gateway/routes/reports.py` (neu, DE 11) — User-Reporting
- `services/chat-gateway/src/dcc_chat_gateway/routes/mod_queue.py` (neu, DE 11) — Mod-Workflow + Audit-Log
- `services/chat-gateway/src/dcc_chat_gateway/user_profile_cache.py` (neu) — Lazy-Push aus Cert-Profile-Claims
- `services/chat-gateway/src/dcc_chat_gateway/auth_mirror.py:32` — Self-Host-Mode bypasst Cloud-Calls
- `services/chat-gateway/alembic/versions/…_0022_reports_and_audit.py` (neu, DE 11) — **chat-gateway-Migration-Stand verifizieren** vor Implementation, vermutlich `0022+` da `0021_guild_plugin_state` schon existiert
- `services/chat-gateway/alembic/versions/…_0023_plugin_user_identifier_refactor.py` (neu, DE 13 Review #5) — bestehende Plugin-State-Tabellen: `user_id`-Spalten → `user_identifier` (Cloud-Mode-Migration trivial via direkte Übernahme)

**Frontend** (alles im `web/`-Workspace):
- `web/src/lib/identity/keypair.svelte.ts` (neu, DE 11) — WebCrypto-Keypair-Generierung + IndexedDB-Persistence
- `web/src/lib/identity/cert.svelte.ts` (neu, DE 11) — Identitäts-Cert-Halter + Challenge-Signing
- `web/src/lib/identity/device-list.svelte.ts` (neu, DE 11) — Geräte-Management-State
- `web/src/lib/identity/profile-statement.svelte.ts` (neu, DE 11 A.2) — Profile-Statement-Halter + Refresh-Loop
- `web/src/lib/identity/key-backup.svelte.ts` (neu, DE 11 A.6) — Cloud-Backup-Flow
- `web/src/lib/identity/cert-rotation.svelte.ts` (neu, DE 11 A.8) — Background-Task für Cert-Auto-Rotation (30 Tage vor Ablauf)
- `web/src/lib/components/settings/AccountDeletion.svelte` (neu, DE 11 A.9) — Confirmation-Flow + GDPR-Hinweis
- `web/src/lib/components/settings/LogoutEverywhere.svelte` (neu, DE 11 A.11) — Self-Service-Suspension
- `web/src/lib/components/admin/AdminUsers.svelte` (neu, DE 11 A.11) — Bootstrap-Admin User-Liste + Force-Suspend
- `web/src/lib/components/settings/PublicComputerSafety.svelte` (neu, Punkt 15 Review #4) — „Daten löschen + abmelden"-Option
- `web/src/lib/identity/suspension-poller.svelte.ts` (neu, DE 11 B.1) — Frontend pollt Suspended-Instances-Liste alle ~1h, markiert betroffene Server in Sidebar
- `web/src/lib/components/settings/MasterPasswordChange.svelte` (neu, MP-Change-Flow Review #4) — Multi-Device-Sync für Master-Passwort-Wechsel
- `web/src/lib/components/settings/DeviceManagement.svelte` (neu, DE 11) — Geräte-Liste-UI mit Abmelden
- `web/src/lib/components/settings/CloudBackup.svelte` (neu, DE 11 A.6) — Master-Passwort-Setup + Recovery-UI
- `web/src/lib/components/onboarding/BackupSetupStep.svelte` (neu, DE 11 A.6) — Opt-in-Flow im Setup-Onboarding
- `web/src/lib/api/servers.svelte.ts` (neu) — ServerEntry-Store, localStorage-Persistenz
- `web/src/lib/api/client.ts:21` — `request(serverId, endpoint, ...)`-Refactor
- `web/src/lib/ws/gateway.svelte.ts` — Multi-Connection-Map + Cert-Hello-Frame + Challenge-Response
- `web/src/lib/stores/active-server.svelte.ts` (neu)
- `web/src/lib/components/sidebar/ServerList.svelte` — Cloud + Self-Host nebeneinander (Self-Host-Badge, DE 11)
- `web/src/lib/components/sidebar/AddServerDialog.svelte` (neu)
- `web/src/lib/components/server/SelfHostDisclaimer.svelte` (neu, DE 11)
- `web/src/lib/components/admin/ModQueue.svelte` (neu, DE 11)
- `web/src/lib/components/messages/ReportButton.svelte` (neu, DE 11)
- `web/src/lib/notifications/service-worker.ts` (neu, Fallstrick #9) — Web-Notification-Backend
- `web/src/lib/notifications/electron-bridge.ts` (neu, Fallstrick #9) — Tray + Native-Notify
- `web/src/lib/components/server/ServerNotificationSettings.svelte` (neu, Fallstrick #9)
- `web/src/lib/components/server/UpdateBanner.svelte` (neu, DE 10) — Sanfter Banner bei WS-Close 4044/4045
- `web/src/routes/app/add-server/+page.svelte` (neu, inkl. First-Time-Setup-Flow Fallstrick #10)
- `web/src/lib/components/admin/AdminInstances.svelte` (neu) — Pending-Apps + Approve/Reject + Active-Instances
- `web/src/lib/components/account/SelfHostApplication.svelte` (neu) — Antrags-Formular
- `web/src/lib/components/account/MyInstances.svelte` (neu) — Credentials-Download + Status-Anzeige

**Desktop** (Electron):
- `desktop/electron/store.ts` — neuer Storage-Slot `pulse-servers.json` für Server-Liste
- `desktop/electron/main.ts` — IPC-Handler für `pulse.notify()` + Tray-Icon mit Unread-Badge (Fallstrick #9, war eh in CLAUDE.md als TODO markiert)
- `desktop/electron/preload.ts` — `window.pulse.notify(...)` exponieren

**Infra:**
- `infra/self-host/Dockerfile.allinone` (neu) — Multi-Stage-Build: Python-Services + LiveKit + MediaMTX + coturn + Caddy + Postgres + Redis + s6-overlay
- `infra/self-host/rootfs/etc/s6-overlay/` (neu) — Service-Definitionen für s6-overlay (Init-Reihenfolge: postgres → redis → migrations → backends → frontend-proxy)
- `infra/self-host/rootfs/etc/cont-init.d/` (neu) — First-Start-Init-Scripts (Secret-Generierung, Caddy-Config-Render, initdb)
- `infra/self-host/rootfs/usr/local/bin/pulse-backup` (neu, DE 10b) — pg_dump-Wrapper mit FIFO-Rotation, läuft via cron-im-Container oder s6-pre-stop-Hook
- `infra/self-host/rootfs/usr/local/bin/pulse-health` (Wrapper-Script für Container-internen Healthcheck — wird vom Docker-HEALTHCHECK aufgerufen, prüft ob alle s6-overlay-Services up sind, kein JWT, kein extern erreichbar)
- `infra/self-host/rootfs/usr/local/bin/pulse-rollback` (neu, DE 10) — Self-Host-Rollback-Script: alten Image-Tag pullen + Backup-Restore
- `infra/self-host/Caddyfile.template` (neu, CORS-Headers für Cloud-Origin, beim First-Start mit Hostname befüllt)
- `infra/self-host/coturn.conf.template` (neu, Fallstrick #6)
- `.github/workflows/build-allinone.yml` (neu, Pfad korrigiert Review #5 — GitHub-Workflows MÜSSEN in Repo-Root-`.github/workflows/` liegen, NICHT in Subdirectories) — CI-Build des Single-Images
- `docs/SELF_HOST.md` (neu) — der eine `docker run`-Befehl + Domain/DNS-Setup + TLS/DynDNS/Tunnel-Alternativen (Fallstricke #6, #7)
- `docs/PRIVACY_SELF_HOST_TEMPLATE.md` (neu, Fallstrick #5) — Datenschutz-Vorlage
- `docs/INSTANCE_APPROVAL_POLICY.md` (neu, intern, Fallstrick #13) — Anti-Squatting-Policy
- `docs/CLOUD_DEPLOY_HYGIENE.md` (neu, intern) — Checkliste vor jedem Cloud-Deploy,
  weil ein kaputter Cloud-Deploy nun **alle Self-Hosts gleichzeitig + sofort bricht** (DE 10).
  Min: Staging-Smoke-Test, schneller Rollback-Path (CI revertet auf vorherigen Image-Tag + ruft Webhook erneut).
- **`PLAN.md`-Update im Repo** (Punkt 11+18 aus Review #5): Dieser Plan liegt aktuell in `~/.claude/plans/lass-uns-mal-planen-fuzzy-fountain.md` (lokales Claude-Verzeichnis). **Vor Implementation muss er ins Repo synchronisiert werden** — entweder als Update zu `PLAN.md` (existiert laut CLAUDE.md, beschreibt Pulse-Architektur) oder neuer `docs/SELF_HOST_PLAN.md`. Sonst sehen andere Entwickler die Architektur nicht.
- `.github/workflows/deploy.yml` (anpassen) — neue Steps (DE 10):
  1. **Pre-Migration-Test** (DE 10a): startet Postgres-Service-Container, läuft `alembic upgrade head` für alle Services gegen frische DB + gegen Production-Snapshot. Bricht der Test → Pipeline failed, kein Push.
  2. **Docker push** mit Tags `:stable` UND `:v$VERSION` (Semver) UND `:rollback-target` (für letzte stable)
  3. **Cloud-Production-Deploy** + 15-Min-Canary-Wait (DE 10d), während dieser Zeit Healthcheck + Error-Rate-Monitoring auf Cloud-Instance
  4. Wenn Canary OK: **Self-Host-Broadcast-Update** via `POST /admin/instances/_broadcast-update`
  5. **Health-Probe-Sweep** 60s nach Broadcast (DE 10c): ruft `/internal/health` jeder Instance, loggt Ergebnisse, sendet E-Mail-Notifications bei Failures
- `.github/workflows/migration-test.yml` (neu, DE 10a) — Job-Definition für Pre-Migration-Test, called von `deploy.yml`

---

## Privacy-Garantien (Zusammenfassung — Cert-Modell, DE 11)

Was die Cloud **erfährt**:
- **Cert-Issuance** (selten, beim Geräte-Add oder jährlicher Rotation): User X hat sich an einem Gerät authentifiziert, Cloud signiert Cert mit Public-Key.
- **Profile-Updates** (selten, bei Avatar/Display-Name-Change): User X hat neues Profile-Statement angefordert.
- **Aktive Gerätelisten** des Users (für Geräte-Management-UI).
- **Welche Self-Hosts registriert sind** (Instance-Registry — aber NICHT welcher User dort aktiv ist).
- CRL-Polls von Self-Hosts (zeigt nur "Instance lebt", kein User-Bezug).

Was die Cloud **nicht erfährt** (technisch unmöglich, nicht nur Versprechen):
- **Auf welchen Self-Hosts ein User aktiv ist** — Cloud sieht keine Token-Refreshes (gibt's nicht mehr), keine User-Activity-Stream.
- **Wann der User wo online ist** — kein Presence-Push, kein Aktivitäts-Heartbeat.
- **Cross-Instance-Verbindungen** — Pairwise-Subjects machen es kryptographisch unmöglich, "Alice auf A" und "Alice auf B" zu verbinden.
- **Welche Self-Hosts ein User in seiner Sidebar hat** (lokal, nie hochgeladen).
- **Inhalte von Self-Host-Channels** (kein Webhook, keine Mirrors).
- **Member-Listen von Self-Host-Guilds** (Self-Host pollt nie über fremde Profile).
- **Voice/Stream-Aktivität auf Self-Host** (eigene LiveKit/MediaMTX im Container).

Was **technisch unvermeidbar** bleibt:
- Wenn Self-Host komplett offline ist, kann der User dort nicht **neu** rein (Cert-Validation würde fail-soft auf JWKS-Cache zurückfallen, aber Self-Host muss laufen).
- ISP/DNS-Resolver sieht Self-Host-Hostnames (Fallstrick #5, kein Pulse-Problem).
- Self-Host-Hoster selbst sieht ALLES auf seinem Server (Inhalte, Member, etc.) — das ist explizit Self-Host-Verantwortung (DE 11, Click-Wrap-Vertrag).

**Vergleich zu klassischem OAuth-IdP** (vor DE 11): wesentlich besser. Klassisch hätte Cloud bei jedem Token-Refresh (alle 5 Min) gesehen, dass User aktiv ist + bei welchem Client (= Self-Host). Mit Cert-Modell: nichts davon.

---

## Verifikation

**Lokal (1 Maschine, 2 Stacks — Cloud-Dev + Self-Host-Single-Container):**
1. **Cloud-Dev starten**: bestehender `scripts/dev-up.fish` → Cloud-Stack auf `:8001/2/3/4` (Postgres `:5434`, Redis `:6380`).
2. **Self-Host-Single-Container starten**:
   ```bash
   docker run -d --name pulse-test \
     -v pulse-test-data:/data \
     -p 9443:443 -p 9080:80 \
     -e PULSE_HOSTNAME=localhost:9443 \
     -e PULSE_CLOUD_CLIENT_ID=test_client \
     -e PULSE_CLOUD_CLIENT_SECRET=test_secret \
     -e PULSE_CLOUD_ORIGIN=http://localhost:8001 \
     ghcr.io/oblivion8282-1337/pulse-allinone:dev
   ```
3. **Cloud-Admin-UI**: `http://localhost:5173/app/admin/instances` → Self-Host-Antrag approven → Credentials notieren.
4. **Im Cloud-Frontend** (`http://localhost:5173`):
   - Cloud-Account anlegen (mit MFA, DE 8)
   - Browser generiert Ed25519-Keypair (DevTools: `await navigator.permissions.query({name:'idle-detection'})` — bzw. IndexedDB-Eintrag prüfen)
   - Identitäts-Cert wird ausgestellt (`POST /credentials/issue` im Network-Tab)
5. **Server hinzufügen**: Sidebar-Plus → `https://localhost:9443` → Cert-Auth-Flow läuft durch → Self-Host taucht in Sidebar auf.
6. **Guild auf Self-Host erstellen**, Voice-Channel betreten → verifiziere im Self-Host-Container-Log: Connect geht zu **embedded LiveKit**, Cloud bleibt still.
7. **Friends-Liste**: auf Cloud-Server → Cloud-Friends. Wechsel zu Self-Host-Server → separate Friends-Liste (kein Cross-Server-Friend).

**Privacy-Test (DE 11):**
1. **Cloud-auth-svc-Logs** prüfen während User auf Self-Host aktiv ist → es darf NUR Cert-Issuance (selten) + CRL-Polls erscheinen. KEIN Token-Refresh-Stream (gibt's nicht). KEIN User-Activity-Tracking pro Self-Host.
2. **Cloud-chat-gateway** darf KEINE Calls vom Self-Host empfangen (außer Webhook-Trigger via CI).
3. **Pairwise-Sub-Test**: User auf 2 verschiedenen Self-Hosts hinzufügen → DB-Inspect: `user_id` auf Self-Host A != `user_id` auf Self-Host B. Cloud kann technisch nicht zurückrechnen, ohne Cert-Inhalt zu sehen.
4. **Network-Capture** (`tcpdump`): Self-Host → Cloud-Verbindungen sollten sich auf CRL-Polls (30s) + JWKS-Refresh (selten) beschränken. KEIN Per-User-Verkehr.

**Offline-Test (DE 2):**
1. Eingeloggter User auf Self-Host hat aktive WS-Session.
2. Cloud `auth-svc` stoppen.
3. Nachricht senden → muss funktionieren (Session-Token gilt 5 Min, JWKS aus Redis-Cache).
4. Session-Token läuft ab → Self-Host versucht Cert-Re-Auth → Cert ist noch ~1 Jahr gültig, validiert lokal via JWKS-Cache → neuer Session-Token. Funktioniert auch ohne Cloud.
5. Erst beim Geräte-Add (`POST /credentials/issue` auf Cloud) wäre Cloud nötig → schlägt fehl mit klarem Fehler.

**Update-Test (DE 10):**
1. Code-Änderung pushen, CI baut neues Image
2. Self-Host-Watchtower triggert via Webhook
3. Pre-Update-Backup wird in `/data/backups/pre-update-<ts>.sql.gz` geschrieben
4. Container restartet (~20s), Migrations laufen
5. Frontend zeigt sanften Update-Banner statt Disconnect
6. Cloud sendet Health-Probe 60s später, Self-Host antwortet OK
7. Rollback testen: `:stable`-Tag in GHCR zurück auf vorherige Version, Webhook erneut → Self-Host pullt alte Version, lädt automatisch das jüngste Pre-Update-Backup.

**Tests (Cert-Modell ist primärer Pfad — Tests entsprechend priorisiert):**

**Primär — Cert-Modell-Tests (DE 11):**
- Backend: `services/auth/tests/test_credentials_issue.py` (neu, DE 11) —
  Cert-Issue mit gültiger Session; Cert enthält alle Claims; Pairwise-Sub-Seed
  ist random; mehrere Geräte = mehrere Certs derselben User-ID.
- Backend: `services/auth/tests/test_credentials_acr_step_up.py` (neu, DE 8+11) —
  `acr_values=mfa` ohne Session-MFA → Step-Up-Redirect; ohne eingerichtetes MFA →
  Setup-Redirect; Cert-Claims (`acr=1`, `amr` korrekt) bei erfolgreichem MFA-Login.
- Backend: `services/auth/tests/test_crl.py` (neu, DE 9+11) — Revoke füllt
  `auth:revoked_certs`; `/.well-known/revoked-credentials` listet aktive Cert-IDs;
  alte werden geprunt.
- Backend: `services/chat-gateway/tests/test_credential_validation.py` (neu, DE 11) —
  Valid Cert + Valid Challenge → Session-Token; Revoked Cert → WS-Close 4001;
  Invalid Challenge-Signature → WS-Close 4001.
- Backend: `services/chat-gateway/tests/test_crl_polling.py` (neu, DE 9+11) —
  Poller füllt lokales Set; Cloud-Outage → letzter Stand bleibt (Fail-Soft).
- Backend: `services/chat-gateway/tests/test_crl_window.py` (neu, Punkt 1) —
  Revoked Cert bleibt in CRL bis `expires_at < now()`, NICHT nur 10 Min;
  Replay-Test: revoked Cert von Tag 1, Poll Tag 30, Cert ist immer noch in CRL.
- Backend: `services/auth/tests/test_credentials_alg_none.py` (neu, Punkt 9) —
  Manipuliertes Token mit `alg=none`-Header wird abgelehnt; nur `alg=RS256` akzeptiert.
- Backend: `services/auth/tests/test_credentials_rate_limit.py` (neu, Punkt 11) —
  Mehr als 3 Cert-Issuances/Stunde/User → 429.
- Backend: `services/auth/tests/test_gdpr_export.py` (neu, Punkt 12) —
  Export enthält alle relevanten Daten; rate-limited auf 1×/24h.
- Backend: `services/auth/tests/test_device_limit.py` (neu, Punkt 8) —
  21. Cert-Issue → 409 mit Hinweis.
- Backend: `services/auth/tests/test_browser_sessions.py` (neu, Punkt 3) —
  HttpOnly+SameSite-strict gesetzt, Auto-Refresh bei Activity, Logout-Everywhere revoked alle.
- Backend: `services/chat-gateway/tests/test_profile_statement_first_use.py` (neu, Punkt 7) —
  First-Use-Replay: altes Statement (>48h alt) wird abgelehnt; frisches (innerhalb 48h) akzeptiert.
- Backend: `services/auth/tests/test_suspension_propagation.py` (neu, Review #4 / DE 11 B.1) —
  Suspend setzt Eintrag in `auth.suspended_instances`; `/.well-known/pulse-suspended-instances`
  listet ihn; Unsuspend entfernt ihn; ETag-Caching funktioniert.
- Backend: `services/chat-gateway/tests/test_suspension_polling.py` (neu, DE 11 B.1) —
  Poller findet eigene `instance_id` in Liste → setzt internal Flag → alle WS-Connects 503;
  Unsuspend → Flag weg → Connects gehen wieder.
- Backend: `services/auth/tests/test_revoke_race.py` (neu, Punkt 18+19 Review #4) —
  Logout-Everywhere + parallele Cert-Issue: neuer Cert wird sofort mit-revoked, weil
  `users.revoke_until > issued_at` greift.
- Backend: `services/auth/tests/test_cert_issue_idempotency.py` (neu, Punkt 1 Review #4) —
  Zwei parallele POST /credentials/issue mit selbem `device_pubkey` → returnen denselben Cert.
- E2E: `web/tests/e2e/master-password-change.spec.ts` (neu, Punkt 6 Review #4) —
  MP-Change auf Gerät A, anderes Gerät B kriegt WS-Op, Backup wird re-encrypted.
- E2E: `web/tests/e2e/server-suspension.spec.ts` (neu, DE 11 B.1) —
  Frontend pollt Suspended-Liste, suspendierter Server wird rot markiert, WS bricht ab.
- Backend: `services/chat-gateway/tests/test_plugin_user_identifier.py` (neu, DE 13 Review #5) —
  Plugin-Helper `ctx.user_identifier()` returnt user_id in Cloud-Mode, Pairwise-Sub in Self-Host-Mode.
- Backend: `services/auth/tests/test_snowflake_16bit.py` (neu, DE 14 Review #5) —
  Neue Snowflake-IDs nach Cutover-epoch nutzen 16-bit Worker; alte IDs werden korrekt geparst.
- Backend: `services/auth/tests/test_owner_pairwise_sub.py` (neu, DE 11 A.12 Review #5) —
  expected_owner_pairwise_sub wird bei Approval generiert; Self-Host vergibt Owner-Rolle nur an matching User.
- Frontend: `web/src/lib/identity/keypair-browser-fallback.test.ts` (neu, Review #5) —
  WebCrypto-Ed25519-Support-Check + @noble/curves-Fallback funktioniert.
- Frontend: `web/src/lib/identity/incognito-detection.test.ts` (neu, Review #5) —
  Inkognito-Mode wird erkannt, hard-Banner wird gezeigt.
- Frontend: `web/src/lib/identity/keypair.test.ts` (neu, DE 11) — WebCrypto-Keypair-Generierung, IndexedDB-Persistence, non-extractable-Flag.
- Frontend: `web/src/lib/identity/cert.test.ts` (neu, DE 11) — Challenge-Signing mit privatem Key, Cert-Replay-Protection.

**Update-Modell (DE 10):**
- Backend: `services/chat-gateway/tests/test_version_compat.py` (neu, DE 10) —
  `/.well-known/pulse-server-info` enthält `server_version`; WS-Hello-Frame schickt `server_version`.
- Backend: `services/auth/tests/test_update_broadcast.py` (neu, DE 10) —
  `/admin/instances/_broadcast-update` signiert JWTs, ruft alle Instances parallel,
  loggt Failures; Health-Probe-JWT-Validation.
- Frontend: `web/src/lib/ws/handshake.test.ts` (neu, DE 10) — Hello-Frame mit
  inkompatibler Version → Close 4044 + UI-Marker "Server zu alt".

**Self-Host-Modell (DE 12):**
- Container: `infra/self-host/tests/test_single_container.sh` (neu, DE 12) —
  Container-Start ohne Fehler, alle Services healthy nach 60s, initdb läuft beim First-Start,
  Volume-Persistenz nach Restart.
- Container: `infra/self-host/tests/test_backup_rotation.sh` (neu, DE 10b) — Pre-Update-Backups werden FIFO-rotiert, max 3 + 4 wöchentliche.

**E2E (komplette Flows):**
- E2E: `web/tests/e2e/cert-flow.spec.ts` (neu, DE 11) — End-to-End: Cloud-Register → Keypair-Generation → Cert-Issue → Add-Server → Cert-Auth → WS-Session.
- E2E: `web/tests/e2e/multi-device.spec.ts` (neu, DE 11) — 2 Browser-Sessions desselben Users, beide bekommen eigene Certs, Geräte-Management-UI zeigt beide, einzeln revoken.
- E2E: `web/tests/e2e/multi-server.spec.ts` (neu) — Sidebar mit 2 Backends, Server-Wechsel, Pairwise-Subs unterschiedlich.
- E2E: `web/tests/e2e/add-server-stale.spec.ts` (neu, DE 10) — Stale Server → freundlicher Banner statt Crash.

**Allgemeine Service-Tests:**
- Backend: `services/chat-gateway/tests/test_jwks_offline.py` (neu) — Last-known-good-Verhalten bei Cloud-Outage.
- Backend: `services/chat-gateway/tests/test_profile_cache_no_cloud_calls.py` (neu) — Self-Host darf keine Cloud-Profile-Calls auslösen.
- Frontend: `web/src/lib/api/servers.svelte.test.ts` (neu) — Multi-Server-Session-Token-Routing.

**Fallback — OAuth-Pfad (nicht primär, aber verfügbar):**
- Backend: `services/auth/tests/test_oidc_flow.py` (neu) — PKCE End-to-End für OAuth-Fallback.

---

## Implementations-Reihenfolge (für aktuelle Pulse-Beta-Phase)

Phasen 1-6 sind **nicht strikt sequenziell** — manche müssen parallel entwickelt werden, weil sie sich gegenseitig brauchen. Empfohlene Reihenfolge:

**Block 1 — Cert-Modell-Fundament** (parallel: Cloud auth-svc + Frontend keypair):
- DE 11 Schema-Migrationen (`pairwise_salt`, `issued_credentials`, `encrypted_key_backups`)
- Cloud-`POST /credentials/issue` + `GET /credentials/profile-statement`
- Cloud-`/.well-known/revoked-credentials` (CRL)
- Frontend `keypair.svelte.ts` + `cert.svelte.ts` + `profile-statement.svelte.ts`
- Migration der bestehenden User auf Cert-Modell (DE 11 F)
- chat-gateway-Seite: `credential_validator.py` + `crl_poller.py` + `session_tokens.py`
- **Verifizierbar**: User loggt sich in Cloud-Frontend ein, kriegt Cert, kann gegen Cloud-chat-gateway via Cert-Auth eine WS-Session aufmachen.

**Block 2 — Multi-Device + Backup** (nach Block 1):
- `GET /credentials/list` + `POST /credentials/{cert_id}/revoke`
- Cloud-Backup-Endpoints + Frontend-UI (`DeviceManagement.svelte` + `CloudBackup.svelte`)
- Cert-Rotation-Mechanik (Key-Rotation-Hooks)
- **Verifizierbar**: User loggt sich auf zweitem Gerät ein, sieht beides in Geräte-Liste, kann backuppen + recovery testen.

**Block 3 — Self-Host-Single-Container** (nach Block 1, kann parallel zu Block 2):
- `infra/self-host/Dockerfile.allinone` + s6-overlay-Setup
- Postgres + Redis + alle Services im Container
- Cert-Validation funktioniert (übernommen aus Block 1 chat-gateway-Seite)
- Caddy-Auto-TLS, coturn-Default
- **Verifizierbar**: Container startet, Cloud-User kann ihn als Self-Host hinzufügen.

**Block 4 — Frontend Multi-Backend-Refactor** (nach Block 1 + 3):
- `web/src/lib/api/servers.svelte.ts` + multi-WS-Connection-Map
- `AddServerDialog` mit Pre-Check + Disclaimer
- Sidebar mit Cloud + Self-Host-Trennung + Badges
- Active-Server-State + Cross-Component-Routing
- **Verifizierbar**: User hat 2 Server (Cloud + Self-Host) in einer Sidebar, kann wechseln.

**Block 5 — Instance-Registry + Approval-Workflow** (nach Block 1):
- `auth.instance_applications` + `auth.registered_instances` Migrationen
- Admin-UI für Approval (`AdminInstances.svelte`)
- User-UI für Antrag + Credentials-Download (`SelfHostApplication.svelte` + `MyInstances.svelte`)
- Notice-and-Action-Endpoint (`routes_reports.py` Cloud-Seite)
- **Verifizierbar**: User stellt Antrag, Admin approved, Credentials werden im UI angezeigt.

**Block 6 — Update-Modell mit Sicherheitsnetzen** (kann nach Block 3 starten):
- CI-Pipeline mit Pre-Migration-Test (DE 10a)
- Cloud-CI-Broadcast-Endpoint + Health-Probe-Sweep (DE 10c)
- Self-Host-Backup-Script + Rollback-Script (DE 10b)
- Staged-Rollout-Setup (DE 10d)
- Update-Banner-UI im Frontend
- **Verifizierbar**: Code-Push → Self-Host updated automatisch, Backup wird gemacht, Health-Probe läuft.

**Block 7 — Mod-Tools + Invite-Flow** (kann nach Block 4 + 5 starten):
- `chat.reports` + `chat.mod_audit_log` Migrationen + Routes
- Report-Button + ModQueue-UI im Frontend
- Invite-Flow + Deep-Link-Handler
- Cross-Server-DMs-UI-Hinweis
- First-Time-Setup-Flow
- **Verifizierbar**: User klickt Invite-Link auf Self-Host, fügt Server hinzu, kann melden.

**Block 8 — Notifications + Polish** (zuletzt):
- Service Worker für Web-Background-Notifications
- Electron-Tray + IPC-Notifications
- Per-Server-Notification-Settings
- TURN-Setup-Doku
- DNS/TLS-Setup-Doku-Templates

**Geschätzter Aufwand** (sehr grob, abhängig von Solo-Tempo):
- Block 1: 3-4 Wochen (Krypto + Cert-Schema, neu)
- Block 2: 1-2 Wochen
- Block 3: 2-3 Wochen (Single-Container ist nicht trivial)
- Block 4: 2-3 Wochen (Frontend-Refactor)
- Block 5: 1-2 Wochen
- Block 6: 2 Wochen (CI-Pipeline + Self-Host-Scripts)
- Block 7: 1-2 Wochen
- Block 8: 1 Woche
- **Total: ~13-20 Wochen Solo, mit Parallelisierbarkeit ~10-14 Wochen.**
