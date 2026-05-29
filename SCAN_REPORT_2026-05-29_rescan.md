# Pulse — Finaler Sicherheits- und Qualitäts-Audit

## 1. Executive Summary

Insgesamt **130 verifizierte Findings** (nach Dedup: **128 eindeutige Issues**). Alle Schweregrade nutzen die `adjustedSeverity` des Verifizierers.

### Nach Schweregrad (adjusted)

| Schweregrad | Anzahl |
|---|---|
| Critical | 3 |
| High | 5 |
| Medium | 30 |
| Low | 90 |

### Nach Dimension

| Dimension | Anzahl |
|---|---|
| bugs | 51 |
| perf | 51 |
| security | 28 |

### Dedup-Hinweise

Drei Root-Issues wurden von mehreren Reviewern unabhängig gemeldet und hier zu je einem Eintrag zusammengeführt:

- **channelPermissions ignoriert self-host Admin-Status** — 3-mal gemeldet (`web-core`, 2× `web-perms-admin`), alle auf `channelPermissions.svelte.ts:64`.
- **N+1 DB-Sessions im Push-Fan-out** — 2-mal gemeldet (`chat-gw-routes-social`, `web-stream-watch`), beide auf `push.py:248-255`.
- **Spoofbares X-Forwarded-For in cert-login** — 3-mal gemeldet (`chat-gw-routes-admin`, `chat-gw-core`, sowie als separater `cert_login.py:154`-Befund), alle dieselbe Wurzel.
- **GET /channels/{id} umgeht VIEW_CHANNEL** — 2-mal gemeldet (`chat-gw-routes-social`, bugs + security), eine Wurzel.
- **`_apply_room_finished` Doppel-DELETE** — 2-mal gemeldet (bugs-Race + perf-RTT), eine Wurzel.
- **store:setAll macht N Disk-Writes** — 2-mal gemeldet (bugs-Atomarität + perf-Latenz), eine Wurzel.
- **JWT-Tokens in localStorage** — 2-mal gemeldet (`web-core` high, `web-misc` medium), eine Wurzel.
- **In-process Rate-Limiter Multi-Worker/Restart-Schwäche** — mehrfach gemeldet über auth-svc, chat-gateway, media-svc (jeweils eigene Codestelle, daher als getrennte Findings belassen, aber gemeinsames Muster).
- **Cert-login `time.sleep`/Snowflake-Blocking** — 2-mal gemeldet (bugs + perf), eine Wurzel `snowflake.py:67`.

---

## 2. Critical

### C1. Self-Host Caddyfile nutzt `handle` statt `handle_path` — API-Präfix wird nie entfernt
`infra/self-host/s6/etc/caddy/Caddyfile.template:50` · [bugs]
**Impact:** Alle API-Blöcke (`/api/auth/*`, `/api/chat/*`, `/api/voice/*`, `/api/media/*`) leiten den vollen Pfad weiter. Die Services registrieren bare Pfade (`/login`, `/guilds`) → jeder API-Call auf Self-Host liefert 404. Self-Host ist komplett funktionsunfähig.
**Fix:** `handle` durch `handle_path` ersetzen (strippt das gematchte Präfix vor dem Forward), analog zum `rewrite … break` im Prod-nginx.

### C2. Self-Host Caddyfile fehlt `handle /ws` — WebSocket verbindet nie
`infra/self-host/s6/etc/caddy/Caddyfile.template:65` · [bugs]
**Impact:** Self-Host-Frontend verbindet auf `wss://host/ws`, aber nur `handle /api/ws` existiert. Der Upgrade fällt auf den Catch-All (index.html) → Handshake scheitert. Realtime-Chat und alle WS-Funktionen auf Self-Host kaputt.
**Fix:** `handle /ws { reverse_proxy 127.0.0.1:8002 }` hinzufügen; ungenutzten `handle /api/ws`-Block entfernen/umwidmen.

### C3. WHEP/Stream-Read im MediaMTX-Auth-Hook ohne Membership-Check
`services/mediamtx-auth-hook/src/dcc_mediamtx_auth_hook/routes.py:192` · [security]
**Impact:** Reads/Playback auf `channel-<cid>-<uid>-<nonce>` liefern unbedingt 200, ohne Guild-Membership zu prüfen. Verstärkend: `GET /channels/{id}/stream` und `GET /channels/{id}/whep` in media-svc sind **unauthentifiziert** → ein Angreifer holt sich ohne Pulse-Session die exakte WHEP-URL und sieht private Streams mit. TODO im Code anerkennt die Lücke.
**Fix:** Auf `read`/`playback` einen Pulse-Member-Token verlangen und Membership gegen chat-gateway/Redis prüfen. Bis dahin Nonce auf ≥128 bit (`secrets.token_hex(16)`) und die media-svc-Read-Endpoints authentifizieren.

---

## 3. High

### H1. Cloud-JWT Access- und Refresh-Token in localStorage — per XSS exfiltrierbar
`web/src/lib/api/storage.ts:10-30` · [security] *(2 Reviewer: web-core + web-misc)*
**Impact:** Beide Tokens liegen in `localStorage` (same-origin-JS-lesbar). Eine einzige XSS-Lücke → Account-Übernahme via 30-Tage-Refresh-Token. CSP im `app.html` enthält `unsafe-inline`/`unsafe-eval` und ist damit faktisch wirkungslos; Caddy setzt keine CSP-Header.
**Fix:** Refresh-Token in `HttpOnly; SameSite=Strict`-Cookie (Backend hat den Mechanismus bereits für Browser-Sessions), Access-Token nur im Speicher. Strikte CSP auf howispulse.com.

### H2. `edit_message` löscht MinIO-Objekte vor Commit — kaputte Attachment-Rows bei Bind-Fehler
`services/chat-gateway/src/dcc_chat_gateway/routes/messages.py:388-397` · [bugs]
**Impact:** `hard_delete_attachments` löscht MinIO-Bytes sofort und staged nur das DB-Tombstone. Wirft das nachfolgende `bind_attachments` HTTP 400, rollt die Session zurück → DB-Row erscheint wieder aktiv (`deleted_at=None`), aber die Bytes sind weg. Presigned URLs liefern 404/403, kaputte Medien.
**Fix:** Reihenfolge umdrehen: erst validieren+binden, einmal committen, dann entfernte Attachments löschen (wie `delete_message`).

### H3. N+1 Permission-Queries in `list_channels` — ein `resolve_permissions` pro Channel
`services/chat-gateway/src/dcc_chat_gateway/routes/channels.py:98-102` · [perf]
**Impact:** Bei bis zu 500 Channels ~1.000 serialisierte DB-Round-Trips pro Request (Guild-/Member-PK via Identity-Map gecacht, Overwrites nicht). Identische Datei enthält mit `members_who_can_view()` bereits das Batch-Pattern.
**Fix:** Roles/member_roles/overwrites für Guild+alle Channels in flachen SELECTs vorab laden, dann den Pure-Python-Resolver in der Schleife — null DB-I/O pro Channel.

### H4. `applyNoiseFilter`: gleichzeitige Aufrufe installieren zwei Prozessoren (AudioContext/WASM-Leak)
`web/src/lib/voice/livekit.svelte.ts:698` · [bugs]
**Impact:** `LocalTrackPublished` feuert `void applyNoiseFilter()` synchron, danach ruft `setMicEnabled` es nochmal mit `await`. Beide passieren die Guard bei noch `off`-Mode → zwei `setProcessor()`. Der erste Prozessor (AudioContext + WASM + RNNoise-Worklet) wird nie zerstört; Level-Tap-RAF läuft weiter. Leak pro Mic-Enable.
**Fix:** Concurrency-Guard (`#applyingFilter`-Flag in try/finally) oder den redundanten Event-Handler-Aufruf entfernen.

### H5. X-Forwarded-For-Spoofing umgeht Rate-Limit-IP-Bucketing (Cloud)
`infra/prod/Caddyfile.pulse.snippet:27` · [security]
**Impact:** Caddys bare `reverse_proxy` **appendet** XFF statt zu ersetzen; nginx appendet weiter. Auth-svc `_client_ip()` vertraut XFF von Peers im `TRUSTED_PROXIES`-Subnetz und nimmt den **ersten** (vom Angreifer injizierten) Wert. Alle Rate-Limit-Buckets (Login, Registration, TOTP, WebAuthn) lassen sich über beliebige Fake-IPs verteilen → Brute-Force-Schutz ausgehebelt.
**Fix:** Im Caddy-Block `header_up X-Forwarded-For {remote_host}` setzen oder `trusted_proxies` global konfigurieren.

---

## 4. Medium

### Auth-Service

**M1. `rotate_secret`: `hash_password` synchron im Event-Loop**
`services/auth/src/dcc_auth/routes_admin_instances.py:440` · [bugs] — Argon2id (50–150 ms) blockt alle Coroutinen. Fix: `await asyncio.to_thread(hash_password, …)`.

**M2. In-process Rate-Limiter evictet abgelaufene Einträge nie — unbegrenztes Wachstum**
`services/auth/src/dcc_auth/routes.py:652` · [perf] — Nur der angefragte `(key, IP)` wird evictet; andere IPs bleiben. Bei vielen Source-IPs langsames Memory-Leak. Fix: Full-Sweep wie `cred_issue` in routes_credentials.py, oder Redis-Limiter.

**M3. SMTP STARTTLS ohne Zertifikatsprüfung (MITM auf ausgehende Mails)**
`services/auth/src/dcc_auth/email.py:164` · [security] — `starttls()`/`SMTP_SSL()` ohne Context → `CERT_NONE`, keine Hostname-Prüfung. Reset-Token/Verify-Links MITM-bar. Fix: `context=ssl.create_default_context()` an beide übergeben.

**M4. Klartext-Recovery-Token im Service-Log bei unkonfiguriertem SMTP**
`services/auth/src/dcc_auth/email.py:131` · [security] — `logger.info('email_skipped', body=body_plain)` enthält die volle Reset-URL inkl. Token. Log-Aggregation speichert Klartext-Token. Fix: Body redacten oder nur bei explizitem Dev-DEBUG loggen.

### Chat-Gateway (social/core)

**M5. `accept_friend_request`: FriendRequest-Row bleibt bei Concurrent-Accept-Rollback liegen**
`services/chat-gateway/src/dcc_chat_gateway/routes/friends.py:285-310` · [bugs] — IntegrityError im `_atomic_install_friendship` rollt auch das `sa_delete(FriendRequest)` zurück → stale eingehender Request trotz bestehender Freundschaft. Fix: Delete nach Recovery erneut absetzen oder separat committen.

**M6. `GET /channels/{id}` umgeht VIEW_CHANNEL**
`services/chat-gateway/src/dcc_chat_gateway/routes/channels.py:130-136` · [bugs+security, 2 Reviewer] — Nur `require_member`, kein VIEW_CHANNEL. Member mit Deny-Overwrite liest Metadaten privater Channels (Name/Topic/Type/Position). Fix: VIEW_CHANNEL prüfen, 404 (nicht 403) bei Deny.

**M7. `GET /guilds/{id}/voice-state` und `/stream-state` leaken Presence in VIEW_CHANNEL-Deny-Channels**
`services/chat-gateway/src/dcc_chat_gateway/routes/channels.py:106` · [security] — REST-Resync + `ws_ready` filtern nicht per VIEW_CHANNEL, die Live-WS-Fan-out (`pubsub_perm_filter`) schon → Inkonsistenz. Fix: `voice_channel_ids` auf VIEW_CHANNEL-berechtigte Channels filtern.

**M8. `edit_message` erzwingt kein Attachment-Count-Limit pro Channel**
`services/chat-gateway/src/dcc_chat_gateway/routes/messages.py:323` · [security] — `post_message` prüft `max_count_per_message`, `edit_message` nicht. Post mit 1 Attachment → Edit auf bis zu 64. Fix: `_limits_for_channel`-Check auf `len(desired_ids)` im Edit.

**M9. `unassign_member_role` published Event für Nicht-Member ohne Membership-Check**
`services/chat-gateway/src/dcc_chat_gateway/routes/role_members.py:98` · [bugs] — Assign prüft `require_member`, Unassign nicht; DELETE ist No-op aber `member_roles_updated` feuert für beliebige user_id → alle Clients re-fetchen. Fix: `require_member` vor DELETE oder rowcount-Check.

**M10. `dm_bump` wird an alle Sockets gebroadcastet wenn User-IDs nicht parsen**
`services/chat-gateway/src/dcc_chat_gateway/pubsub_channel_guild.py:121` · [bugs] — `int(get("user_a_id","0"))==0` ist falsy → Guard greift nicht, voller Broadcast. Nur `strict`-Validation blockt das. Leakt DM-Beziehungs-Metadaten in `warn`/`off`-Mode. Fix: `if not (a_id and b_id): return` (drop statt broadcast).

**M11. Cert-Login: spoofbares X-Forwarded-For umgeht Rate-Limit**
`services/chat-gateway/src/dcc_chat_gateway/routes/cert_login.py:147-158` · [security, 3 Reviewer] — Linkester XFF-Wert ungeprüft als Limit-Key; nginx/Caddy appenden. Auth-svc hat den `TRUSTED_PROXIES`-Guard, cert-login nicht. DoS auf RS256/Ed25519-Pfad. Fix: rechtesten trusted-Hop bzw. `request.client.host` nutzen.

**M12. CRL-Revocation-Fenster: revoziertes Cert kann bis zu 30 s noch authentifizieren**
`services/chat-gateway/src/dcc_chat_gateway/crl_poller.py:146` · [security] — Poll alle 30 s; zwischen Cloud-Revoke und nächstem Poll liefert `validate_cert` aus stalem Redis-Set. `auth:valid:cert:*`-Deletes sind Dead Code (Key wird nie geschrieben). Fix: Poll-Intervall 5–10 s oder Push-Invalidierung.

**M13. Überbreite `.googleapis.com`-SSRF-Allowlist im Web-Push**
`services/chat-gateway/src/dcc_chat_gateway/routes/notifications.py:40-79` · [security] — Suffix `.googleapis.com` erlaubt beliebige Subdomains (storage/iam/secretmanager). VAPID-signierter POST an attacker-gewählte Google-APIs = blind SSRF. `fcm.googleapis.com` ist bereits exakt gelistet. Fix: Wildcard `.googleapis.com` entfernen.

**M14. `internal_evict_from_voice` published kein `voice_disconnect` — gekickter Client bleibt in stalem Voice-State**
`services/voice-signaling/src/dcc_voice_signaling/routes/internal.py:58` · [bugs] — Ban/Kick entfernt LiveKit-Participant, sendet aber nie das gezielte `voice_disconnect`-Event; Client hängt im Voice-UI bis die Verbindung selbst schließt. Fix: nach der Schleife `VoiceDisconnectEvent` pro (cid, user_id) publishen.

### Permissions / Frontend

**M15. `channelPermissions.resolveForUser` ignoriert Self-Host-Admin-Status**
`web/src/lib/stores/channelPermissions.svelte.ts:64` · [bugs, **3 Reviewer**] — Liest `isAdmin` nur aus `auth.user?.is_admin` (Cloud-JWT). Self-Host-Cert-Admin → immer `false`, kein `GRANT_ALL_SAFE`; bei VIEW_CHANNEL-Deny verstecken sich HQ-Stream-/Screenshare-/Video-Buttons. `roles.recomputeGuild` macht es bereits korrekt. Fix: gleiche `srv?.isCloud ? auth.user?.is_admin : serverAdmin.isAdmin(serverId)`-Logik übernehmen.

### Voice-Service

**M16. Sequenzielle LiveKit-Round-Trips in der Evict-Schleife — O(n) bei großen Guilds**
`services/voice-signaling/src/dcc_voice_signaling/routes/internal.py:58` · [perf] — Bis zu 100 Channels seriell, je neuer LiveKitAPI-Client + RPC + Teardown. Fix: `asyncio.gather(*[_livekit_remove_participant(cid, uid) …])`.

**M17. Interner Evict-Endpoint trotz nginx `/internal/`-Deny aus dem Internet erreichbar**
`services/voice-signaling/src/dcc_voice_signaling/routes/internal.py:33` · [security] — `location /internal/ deny` verliert gegen längeres `location /api/voice/`; `/api/voice/internal/evict-from-voice` wird zu `/internal/evict-from-voice` proxied. Schutz nur durch ein Shared-Secret ohne Rate-Limit. Fix: `location ^~ /api/voice/internal/ { deny all; }` vor dem generischen Block (Muster wie `/api/voice/webhook` bereits vorhanden).

**M18. Kein Rate-Limit auf `POST /token` — authentifizierte Amplification-DoS gegen chat-gateway**
`services/voice-signaling/src/dcc_voice_signaling/routes/token.py:36` · [security] — Jeder Request feuert zwei Calls an chat-gateway; keine Drosselung. Single-Account-Flut sättigt chat-gateway-Pool. Fix: per-User-Limit (slowapi).

### Streaming-Backend

**M19. SMTP-/cert-login-übergreifend: in-process Limiter (siehe M2/M11)** — bereits oben.

### Plugins

**M20. Fehlercode-Kollision 4043: `tamagotchi:reset` reused `WS_CODE_PLUGIN_NOT_ENABLED`**
`plugins/tamagotchi/backend.py:272` · [bugs] — 4043 bedeutet im Gate „Plugin nicht aktiviert", im Handler „kein MANAGE_GUILD". Client kann nicht unterscheiden. Fix: eigener Code (4044) als benannte Konstante in ws_op_gate.py.

### Infra

**M21. `PULSE_INSTANCE_OWNER_ID` nicht validiert/exportiert — Self-Host ohne Admin**
`infra/self-host/s6/etc/s6-overlay/scripts/10-check-cloud-creds.sh:16` · [bugs] — `.env.example` markiert es als PFLICHT, aber Check-Script prüft es nicht und `07-render-env.sh` exportiert es nicht. Default `0` (falsy) → Admin-Check still übersprungen, kein Admin. Fix: `check_var` ergänzen + in env.sh-Heredoc exportieren.

**M22. INTERNAL_SERVICE_SECRET leer in `.env.example` — Ban/Kick-Voice-Evict still deaktiviert**
`infra/prod/.env.example:68` · [security] — Leer gelassen ⇒ chat-gateway short-circuitet, gebannte User bleiben im Voice; `DELETE /me` liefert 503. Fix: Startup-WARNING + compose `:?required`-Guard.

**M23. HLS-Proxy ohne `proxy_buffering off` — Latenz bei LL-HLS**
`infra/prod/web-nginx.conf:169` · [perf] — Default-Buffering hält Partial-Segments zurück, konterkariert LL-HLS. `/pulse-attachments/` hat das Off bereits. Fix: `proxy_buffering off;` im `/hls/`-Block.

**M24. SRT auf MediaMTX aktiv während Stream-Tokens im Klartext über UDP reisen**
`infra/prod/mediamtx.yml:80` · [security] — `srt: yes`, 8890/udp public; Auth-Hook prüft `protocol` nicht → RTMP-Token funktioniert auch über SRT, Token im `streamid`-Feld klartextlesbar. Fix: SRT deaktivieren oder Port schließen; sonst SRT-only-Token + Protokoll-Enforcement im Hook.

**M25. MinIO-Backup hält permanent doppelten Attachment-Speicher**
`infra/prod/backup/backup.sh:42` · [perf] — `mc mirror` in persistentes `pulse_minio_stage`-Volume + restic → drei Kopien gleichzeitig. Fix: restic rclone/S3-Backend direkt, oder Stage-Volume als tmpfs.

### Voice / Watch (Frontend)

**M26. Viewer-Manual-Pause unterdrückt durch unbedingtes `syncingUntil`-Update in `syncSoft`**
`web/src/lib/components/WatchPartyTile.svelte:139` · [bugs] — `syncingUntil` wird auch bei `applySoft()=='none'` (kein Eingriff) gesetzt; das 2 s-Fenster überlappt den 3 s-Heartbeat → ~2/3 der manuellen Pausen verschluckt. Fix: `syncingUntil` nur setzen wenn eine Korrektur tatsächlich erfolgte.

### Misc (Frontend)

**M27. `GuildSettingsDialog`: Permission-Change-WS-Event resettet den aktiven Tab mitten in der Bearbeitung**
`web/src/lib/components/settings/GuildSettingsDialog.svelte:90-98` · [bugs] — `$effect` liest reaktive Permission-Deriveds und setzt `tab` bei jedem Change zurück; verwirft Tab-Auswahl, kann Dirty-Prompt verstecken. Fix: nur beim Öffnen (Closed→Open) initialisieren.

**M28. `roleMentionLabel` scannt alle Guild-Rollenlisten statt der O(1)-`roleIdMap`** — *(als low eingestuft, siehe L-Sektion)* — entfällt hier.

**M29. ModQueue feuert zwei parallele `listModQueue`-Fetches beim ersten Mount**
`web/src/lib/components/admin/ModQueue.svelte:76` · [perf] — `$effect` und `onMount` laden beide initial `activeTab='new'` → doppelter Request, Race beim Überschreiben. Fix: `onMount`-Aufruf entfernen.

**M30. `MentionAutocomplete` holt unabhängig von `MemberList` die volle Member-Liste**
`web/src/lib/components/MentionAutocomplete.svelte:57` · [perf] — Tippen von `@` löst `GET …/members` aus; bei offener MemberList doppelter Voll-Fetch. Fix: geteilter Member-Cache-Store (dedupliziert konkurrente `listMembers`).

### Desktop

**M31. Sidecar-Binary-Pfad-Env-Overrides nicht auf packaged Builds gegated**
`desktop/electron/sidecar.ts:28,101,147` · [security] — `PULSE_PYTHON`/`PULSE_SIDECAR_PY`/`PULSE_HQ_SIDECAR` werden auch im signierten Flatpak unbedingt befolgt; ein bösartiger Launcher kann auf eine Angreifer-Binary umleiten, die Stream-Tokens via stdin erhält. `PULSE_URL` ist bereits per `!app.isPackaged` geschützt. Fix: gleichen Guard um die drei Overrides legen.

---

## 5. Low

Kompakt, gruppiert nach Bereich. Format: Titel · `file:line` · [dim].

### Auth-Service
- **TOTP-Replay über Fenstergrenze** (Future-Code im aktuellen Slot akzeptiert) · `routes_totp.py:331-338` · [bugs] — Counter als Timecode des *akzeptierten* Codes speichern oder `valid_window=0`.
- **Fixed-Window-Burst im Rate-Limiter** (2N an Fenstergrenze) · `routes.py:679-683` · [bugs] — Sliding-Window/Token-Bucket.
- **ETag-Vergleich CRL inkonsistent (quotes)** · `routes_crl.py:137-150` · [bugs] — beide Pfade `strip('"')`.
- **`approve_application`: `hash_password` synchron** · `routes_admin_instances.py:245` · [bugs] — `asyncio.to_thread`.
- **`logout` fängt zu breit (`except (ValueError, Exception)`)** · `routes.py:539` · [bugs] — nur `ValueError`.
- **TOTP `verify-setup` setzt `totp_last_counter` nicht → kurzes Replay-Fenster** · `routes_totp.py:137` · [security] — Counter am Ende setzen.
- **2 separate COUNT-Queries bei Register-Konflikt** · `routes.py:271` · [perf] — eine kombinierte Query.
- **Extra Passkey-Count-Query bei jedem Login trotz aktivem TOTP** · `routes.py:403` · [perf] — bei `totp_enabled` short-circuiten.
- **CRL-ETag recomputed SHA-256 über ganze Liste bei Cache-Miss** · `routes_crl.py:88` · [perf] — vorberechnetes ETag mit langem TTL.
- **Bootstrap-Admin-Race (zwei Erst-Registrierungen → beide Admin)** · `routes.py:330` · [security] — `SELECT … FOR UPDATE`/`ON CONFLICT`; bewusst akzeptiert.

### Chat-Gateway (social)
- **`ban_user`: Ghost `guild_member_removed` bei Concurrent-Ban-Rollback** · `bans.py:161-190` · [bugs] — `was_member=False` im except.
- **`delete_block` committet vor rowcount-Check** · `blocks.py:136-144` · [bugs] — 404 vor commit.
- **`fan_out_mention_push`: eine DB-Session pro Empfänger (N+1)** · `push.py:248-255` · [perf, 2 Reviewer] — Subscriptions per `user_id = ANY(:ids)` batchen.
- **`members_who_can_view` lädt ganze Memberliste ohne Cap** · `permissions.py:309-381` · [perf] — Member-Count-Guard / SQL-Filter.
- **`get_guild`: zwei sequenzielle PK-Lookups** · `guilds.py:124-129` · [perf] — JOIN oder Guild-first.
- **Reaper lädt volle ORM-Rows statt Spaltenprojektion** · `attachments.py:387-421` · [perf].
- **Fehlender Index `DirectMessageChannel.last_message_id`** · `models/channels.py:75-80` · [perf].
- **`list_members` ohne Cursor-Pagination** · `guilds.py:465-480` · [perf] — `after_user_id`-Keyset.
- **mention-candidates leakt Usernamen aller Guilds** · `mention_search.py:63` · [security] — JOIN auf `guild_members`.
- **Kein Rate-Limit auf Friend-Request-Erstellung (Harassment)** · `friends.py:89` · [security] — `ratelimit.check('friend_request', …)`.
- **In-process Rate-Limiter ineffektiv bei Multi-Instanz** · `ratelimit.py:1` · [security] — Redis-Limiter.

### Chat-Gateway (admin/core)
- **`_report_in_guild` Early-Return statt OR (divergiert von `list_mod_queue`)** · `mod_queue.py:175` · [bugs] — OR-Logik spiegeln.
- **`create_report` gibt `received` zurück, speichert `new`** · `reports.py:86` · [bugs] — `report.status` nutzen.
- **cert-login Limiter nutzt linkestes XFF** · `cert_login.py:154` · [bugs] — rechtesten Hop.
- **Fehlender Index `messages.created_at` → Full-Scan in Admin-Stats** · `admin.py:95-101` · [perf] — Partial-Index.
- **`list_mod_queue` ohne LIMIT** · `mod_queue.py:154-172` · [perf] — `limit`+Cursor.
- **Idle-Sweeper: sequenzielle `redis.publish` pro User** · `presence_status.py:277-292` · [perf] — Pipeline.
- **Idle-Sweeper: unbounded `ZRANGEBYSCORE`** · `presence_status.py:251` · [perf] — `LIMIT` + Pruning.
- **Fehlende Indizes auf `reports`-Target-Spalten** · `mod_queue.py:158-166` · [perf] — Partial-Indizes.
- **`/admin/stats` 4 sequenzielle COUNTs** · `admin.py:87-101` · [perf] — UNION ALL/parallele Sessions.
- **`update_role_positions`: ein WS-Event pro Rolle** · `roles.py:262-264` · [perf] — gebündeltes `RolePositionsUpdatedEvent`.
- **cert-login Bucket-Scan O(n_IPs) pro Request** · `cert_login.py:167-174` · [perf] — Cap/Background-Cleanup.
- **`status`-Query unvalidiert (Enum-Bypass/Info-Leak)** · `mod_queue.py:131,157` · [security] — `Literal`.
- **`action_type` ohne Längenbound im Audit-Log** · `mod_queue.py:65,247` · [security] — `max_length=100`.
- **`PULSE_INSTANCE_ID=0` kollabiert pairwise-sub-Namespace** · `credential_validator.py:231,249` · [security] — 503/Startup-Assertion bei 0 auf Self-Host.

### Chat-Gateway (core/pubsub)
- **`_fan_out` cleanupt Sockets nicht bei `CancelledError`** · `pubsub_listener.py:52` · [bugs] — `except BaseException`.
- **`validate_cert` überspringt CRL-Call bei leerem cert_id (Timing-Invariante)** · `credential_validator.py:181` · [bugs] — `sismember(…, cert_id or "")` immer.
- **`_filter_by_view_channel` hält zwei DB-Sessions offen** · `pubsub_perm_filter.py:290` · [bugs/perf] — Outer-Session vor Batch schließen.
- **`voice_overrides_for`: serielle per-Channel-SCAN** · `pubsub.py:413-450` · [perf] — `asyncio.gather`/Broad-Pattern-SCAN.
- **`voice/stream/watch_states_for`: ein GET pro Channel statt MGET** · `pubsub.py:392-547`, `watchkeys.py:58-68` · [perf] — `MGET`.
- **Ready-Frame zweite DB-Session für Peer-Presence** · `ws_ready.py:321-337` · [perf] — in erste Session falten + Cap.
- **Idle-Sweeper unbounded ZRANGEBYSCORE (Gesamt-User)** · `presence_status.py:251` · [perf] — `LIMIT`/`zremrangebyscore`.
- **`fan_out_mention_events`: ein PUBLISH pro User** · `mentions.py:371-377` · [perf] — Pipeline/Listener-Fan-out.
- **`_fan_out`: ein Task pro Socket, 5 s Timeout (Head-of-Line)** · `pubsub_listener.py:48-66` · [perf] — kürzerer Timeout.
- **Cert-login XFF-Spoofing (Self-Host-Variante)** · `cert_login.py:154` · [security] — siehe M11.
- **Watch-Party Native-URL erlaubt interne Hostnames (Client-SSRF via DNS)** · `watch_source.py:217` · [security] — Allowlist/Permission-Gate.
- **WS-Endpoint baut `AuthenticatedUser` ohne `user_identifier`/`is_self_host`** · `ws.py:106` · [security] — über `get_current_user`-Logik ableiten.

### Voice-Service
- **`_apply_room_finished`: nicht-atomares Doppel-DELETE (TOCTOU + RTT)** · `webhook.py:215-217` · [bugs/perf, 2 Reviewer] — `redis.delete(room_key, streaming_key)`.
- **`_is_screen_share` String-Fallback Dead Code** · `webhook.py:97` · [bugs] — Branch entfernen.
- **Neuer `LiveKitAPI`-Client pro Mute/Disconnect** · `livekit_client.py:53` · [perf] — Singleton in `app.state`.
- **Neuer `httpx.AsyncClient` pro chat-gateway-Call** · `chat_gateway.py:49` · [perf] — langlebiger Client.
- **Force-Deafen rein client-seitig (kein Server-Enforcement)** · `voice_override.py:52` / `web/src/lib/ws/handlers/voice.ts:38` · [security] — Limitierung dokumentieren; echte Iso nur via Disconnect.
- **Kein Target-Member-Check in voice-override/disconnect** · `voice_override.py:36` · [security] — Membership des Targets prüfen.

### Streaming-Backend
- **Token vor Validierung konsumiert; Re-Auth blockt legitimen Publisher** · `mediamtx-auth-hook/routes.py:165` · [bugs] — GET→validate→DEL.
- **Poller-Lifespan: `cancel()` ohne await im except** · `media-svc/app.py:43` · [bugs] — `suppress(Exception): await task`.
- **In-process Token-Limiter per-Worker/Restart** · `media-svc/routes.py:48` · [bugs] — Redis.
- **O(N)-Dict-Scan pro Token-Rate-Call** · `media-svc/routes.py:55` · [perf] — Time-Bucketing.
- **`redis.eval` sendet vollen Lua-Body pro Call** · `mediamtx-auth-hook/routes.py:121` · [perf] — `register_script`/EVALSHA.
- **`scan_iter` ohne `count`-Hint** · `media-svc/poller.py:96` · [perf] — `count=100`.
- **PUBLISH seriell statt gebatcht nach Pipeline-Flush** · `media-svc/poller.py:177` · [perf] — `asyncio.gather`.
- **Unauth `GET /channels/{id}/stream` in media-svc** · `media-svc/routes.py:171` · [security] — `CurrentUser`/Shared-Secret.
- **In-process Stream-Token-Limiter per-Worker/Restart** · `media-svc/routes.py:43` · [security] — Redis.

### Shared
- **`time.sleep` in `SnowflakeGenerator._wait_next_ms` blockt Event-Loop** · `shared/.../snowflake.py:67` · [bugs/perf, 2 Reviewer] — `run_in_executor`/async.
- **Redundantes `sorted()` pro Member in `members_who_can_view`** · `permission_resolver.py:167` · [perf] — pro Role-Set einmal sortieren.
- **`RSAAlgorithm.from_jwk(json.dumps(dict))` Round-Trip** · `…/security.py:87` · [perf] — Dict direkt übergeben.
- **`GRANT_ALL_SAFE` setzt reservierte Bits trotz gegenteiliger Garantie** · `permissions.py:65` · [security] — OR der definierten Flags.

### Plugins
- **`apply_atomic_update` gibt `default_state` bei Rollback zurück → False-Broadcast** · `state_store.py:173` · [bugs] — Sentinel/Exception + Publish guarden.
- **Zwei DB-Sessions pro Plugin-Op (Gate + Handler)** · `ws_ops.py:128` · [perf] — Gate-Session durchreichen.
- **Drei DB-Connections für `tamagotchi:reset`** · `tamagotchi/backend.py:265` · [perf] — eine Session teilen.
- **Unconditional INSERT ON CONFLICT bei jedem `apply_atomic_update`** · `state_store.py:141` · [perf] — Row-Exists-Cache; bewusst akzeptiert.
- **`log.info` bei jedem Broadcast-Fan-out** · `tamagotchi/backend.py:330` · [perf] — `log.debug`.
- **Plugin-Op-Gate läuft nach Handler-Lookup (Op-Enumeration)** · `ws_ops.py:113-118` · [security] — Gate vor `get_handler` für `colon:`-Ops.
- **Broadcast enthält `updated_by_user_id`** · `tamagotchi/backend.py:213-220` · [security] — opt-in/dokumentieren.
- **`PULSE_PLUGIN_PERMISSIONS=off` deaktiviert Capability-Enforcement** · `permissions.py:57-77` · [security] — Dev-only dokumentieren + Startup-Warning.

### Web (core)
- **Pre-Ready-Buffer vor Hello/Version-Check geleert; `gapFillAll` vor Kompatibilitäts-Check** · `gateway-connection.ts:236-249` · [bugs] — `gapFillAll` nach Hello.
- **`dm_bump`-Handler: `userCache.queue` dann sofortiges `get` → Miss** · `handlers/chat.ts:106-109` · [bugs] — `queue` entfernen oder Toast lazy.
- **`openIdentityDb`-Fehlerpfad schließt DB nicht (Connection-Leak)** · `idb-shared.ts:29` · [bugs] — try/finally in Save-Funktionen.
- **Unvalidierte `isCloud`-Deserialisierung aus localStorage** · `servers.svelte.ts:66-77` · [security] — `isCloud` aus Hostname re-derivieren.
- **O(n)-Dedup-Scan pro Live-Message** · `messages.svelte.ts:43` · [perf] — `Set<string>` der IDs.
- **`confirmedNonces` als `$state` (Proxy-Overhead)** · `messages.svelte.ts:9` · [perf] — Plain-`Set`.
- **O(n)-Scan in `upsertRole`** · `roles.svelte.ts:82` · [perf] — `roleIdMap.has`.
- **1-Hz-Poll reassigned reaktiven State immer** · `server-state.svelte.ts:33` · [perf] — Snapshot-Vergleich.
- **Wiederholtes IndexedDB-Open/Close pro Identity-Op** · `idb-shared.ts:18` · [perf] — Connection lazy cachen.

### Web (voice)
- **`RemoteAudioElements.attach`: random Fallback-SID-Key → detach no-op (Leak)** · `audioElements.ts:85` · [bugs] — gleicher Fallback-Key/Assertion.
- **`#ensureContext` prüft `AudioContext.state` nicht vor Reuse** · `audioElements.ts:73` · [bugs] — `state !== 'closed'`-Check.
- **`setPttMode(off)` ignoriert Force-Mute-Override** · `livekit.svelte.ts:416` · [bugs] — Override-Guard.
- **Voll-Array-Spread pro Speaking-Change** · `livekit.svelte.ts:1078` · [perf] — per-Participant `$state`.
- **Redundanter 200-ms-Poll für event-getriebene Werte** · `livekit.svelte.ts:967` · [perf] — `isSpeaking`-Poll entfernen.
- **Ein RAF-Loop pro Remote-Participant** · `remoteSpeakingTracker.ts:63` · [perf] — ein geteilter Loop.
- **Force-Deafen client-seitig** · `handlers/voice.ts:38` · [security] — siehe Voice-Service.

### Web (stream/watch)
- **`DetachedWatchParties`-Poll läuft unbedingt ab Konstruktion** · `watchPartyDetach.svelte.ts:35` · [bugs] — lazy start/stop (Muster aus `detach.svelte.ts`).
- **`connectWhep`: kein onTrack bei stream-loser Track-Lieferung → blank Video** · `whep.ts:90` · [bugs] — MediaStream-Fallback/Timeout.
- **Per-Request `httpx.AsyncClient` für WHEP/Token-Proxy** · `streaming.py:69` · [perf] — Client in `app.state`.
- **N+1 DB-Sessions im Push-Fan-out** · `push.py:248-255` · [perf] — siehe oben (M-Dedup), Batch-Query.
- **`StreamChatOverlay`: O(n)-Filter + Set-Rebuild pro Update** · `StreamChatOverlay.svelte:35-65` · [perf] — In-Place-Set + Version-Signal.
- **`fan_out_mention_push` blockt POST /messages-Response** · `messages.py:278-285` · [perf] — `asyncio.create_task`/`BackgroundTasks`.
- **`youtubeTitle`-Cache nie evictet; `null`-Caching dauerhaft** · `youtubeMeta.svelte.ts:7` · [perf] — LRU-Cap, kein `null`-Cache.
- **WHEP-Resource-URL ohne Origin-Validierung (Open Redirect auf DELETE)** · `whep.ts:64` · [security] — Origin-Vergleich.
- **Native-Watch-URL SSRF via DNS-Rebinding** · `watch_source.py:183` · [security] — DNS-Resolve/Allowlist.
- **Attachment-MIME nicht gegen Allowlist validiert (Stored-XSS-Vektor)** · `attachments.py:159` · [security] — MIME-Allowlist.
- **Watch-Party-Sync-State in Prod-Console geloggt** · `WatchPartyTile.svelte:126` · [security] — DEV-Gate.
- **Push-Subscription sendet `navigator.userAgent` verbatim** · `pushSubscribe.ts:127` · [security] — UA strippen/kürzen.

### Web (misc)
- **PTT-Keyup vs. `@svelte-put/shortcut`-Normalisierung (Multi-Char-Keys tot)** · `VoiceChannelView.svelte:126-131` · [bugs] — konsistente Key-Normalisierung.
- **`InviteEmbed.handleJoin`: `goto` ohne `await`/`void`** · `InviteEmbed.svelte:39-41` · [bugs] — `void goto(...)`/async.
- **`MemberRoleAssignment`-Filter matcht nicht `display_name` aus userCache** · `MemberRoleAssignment.svelte:49-57` · [bugs] — Cache-DisplayName mit einbeziehen.
- **`roleMentionLabel` scannt alle Guild-Rollen statt `roleIdMap`** · `messageRender.ts:91` · [perf] — `roleIdMap.get(id)`.
- **`isSelfMention` Doppel-Scan aller Guild-Rollen** · `messageRender.ts:106` · [perf] — `roleIdMap.get(m.id).guild_id`.
- **`buildItems`/`messageMap` rebuild komplett pro WS-Message** · `ChatView.svelte:106` · [perf] — inkrementell/memoize.
- **`sortName` zweimal pro Vergleich in MemberList-Sort** · `MemberList.svelte:113` · [perf] — Schwartzian Transform.
- **`EmojiPicker` ruft `EMOJIS.find` pro Kategorie pro Render** · `EmojiPicker.svelte:50` · [perf] — `CATEGORY_REPRESENTATIVE`-Map.
- **WS-Access-Token als Klartext-Query-Param in Server-Logs** · `gateway-connection.ts:212` · [security] — kurzes TTL/dedizierte WS-Ticket.
- **DOMPurify erlaubt beliebige CSS-`class`-Injektion (Phishing-Lures)** · `messageRender.ts:30` · [security] — `class` aus `ALLOWED_ATTR` entfernen.
- **Invite-Embed-Auto-Fetch durch beliebigen `/invite/XXXXXXXX`-Substring** · `MessageItem.svelte:61` · [security] — Hostname-Präfix verpflichtend.

### Desktop
- **`store:setAll` macht N Disk-Writes statt einem (Atomaritäts-Bruch + Latenz)** · `main.ts:294-307` · [bugs/perf, 2 Reviewer] — `storeSetBatch` mit einem `persist()`.
- **Deep-Link-Invite Doppel-Delivery bei Renderer-Reload** · `deeplink.ts:91-98` · [bugs] — Buffer nach Eager-Push leeren.
- **`_isAllowedOrigin` re-parsed `TARGET_URL` pro Event** · `main.ts:213` · [perf] — `TARGET_ORIGIN` konstant.
- **`gsr:call` leitet beliebige Op-Strings ohne Allowlist weiter** · `main.ts:235` · [security] — `ALLOWED_GSR_OPS`.
- **`notify:show` nutzt Renderer-Payload ohne Runtime-Type-Checks** · `notify.ts:89-103` · [security] — Type-Guards + Längen-Clamp.

### Infra
- **MediaMTX-Fallback-Config falscher `authHTTPExclude`-Key (`path:` statt `action:`)** · `08-init-mediamtx.sh:60` · [bugs] — `- action: api/metrics/pprof`.
- **`/.well-known`-Proxy ohne `Connection ""`-Header (Connection-Close pro Poll)** · `web-nginx.conf:124` · [perf] — Header ergänzen.
- **MediaMTX-API auf `0.0.0.0:9997` ohne Auth, nur UFW-geschützt** · `mediamtx.yml:73` · [security] — Loopback/`apiAllowAddresses`-Bind + DEPLOY.md-Hinweis.

### By area

| Bereich | Findings |
|---|---|
| auth-svc | 17 |
| chat-gw-routes-social | 16 |
| chat-gw-routes-admin | 16 |
| chat-gw-core | 16 |
| voice-svc | 11 |
| stream-backend | 11 |
| web-misc | 12 |
| web-stream-watch | 12 |
| web-core | 11 |
| plugins-backend | 9 |
| web-voice | 8 |
| infra | 9 |
| shared | 4 |
| web-perms-admin | 4 |
| desktop | 5 |

Hinweis: Die Bereichszählung basiert auf dem `target`-Feld der Findings (vor Dedup); mehrfach gemeldete Root-Issues erscheinen daher unter mehreren Bereichen.