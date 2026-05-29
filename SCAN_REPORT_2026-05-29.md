I'll produce the report directly from the findings JSON, deduplicating and grouping by the verifier's adjustedSeverity.

# Pulse — Finaler Audit-Report

## 1. Executive Summary

**Findings nach adjustedSeverity** (nach Dedupe: 96 → 84 eindeutige Issues)

| Severity | Anzahl |
|---|---|
| Critical | 0 |
| High | 9 |
| Medium | 18 |
| Low | 57 |
| **Gesamt** | **84** |

**Findings nach Dimension** (adjustedSeverity-gewichtet, nach Dedupe)

| Dimension | High | Medium | Low | Gesamt |
|---|---|---|---|---|
| bugs | 6 | 11 | 22 | 39 |
| perf | 2 | 2 | 27 | 31 |
| security | 1 | 5 | 23 | 29 |

> Hinweis: Alle ursprünglichen `severity`-Werte wurden vom Verifier teils nach unten korrigiert. Dieser Report verwendet durchgängig die `adjustedSeverity`. Etliche ursprünglich als „high"/„medium" eingestufte Items wurden zu „low" herabgestuft (z. B. wenn der Exploit-Pfad nur in seltenen Degradationszuständen oder bei bereits privilegiertem Angreifer erreichbar ist).

---

## 2. Deduplizierte Findings (Mehrfachtreffer)

Folgende Root-Issues wurden von mehreren Reviewern unabhängig gemeldet und sind im Report jeweils **einmal** gelistet:

1. **`_load_context` feuert eine separate `@everyone`-Query** (`permissions.py:111-137`) — **4×** gemeldet (chat-gw-routes-social, chat-gw-core, chat-gw-routes-admin, shared `dcc_chat_gateway/permissions.py`). Alle beschreiben den zweiten SELECT für die @everyone-Rolle nach dem Member-Roles-JOIN. → eine Low-Perf-Entry.
2. **CRL-Check fällt bei Redis-Fehler „fail-open" offen** (`credential_validator.py:173-176`) — **3×** gemeldet (chat-gw-routes-admin, chat-gw-core, chat-gw-core). Verdicts divergieren (low vs. medium); übernommen wird die höhere Einstufung **Medium**, da der Partial-Redis-Failure-Pfad real ist.
3. **Cert-Login Challenge-Token nicht single-use → Replay im TTL-Fenster** (`cert_login.py`) — **3×** gemeldet (chat-gw-routes-admin :209-278, chat-gw-routes-admin :150-278 rate-limit-Variante, chat-gw-core :30). Replay-Aspekt → **Medium**; das separate „kein Rate-Limit auf /cert-login/*" bleibt eigene Low-Entry.
4. **`DELETE /me` überspringt 2FA für Passkey-only-Accounts** (`routes_account.py:134`) — **2×** gemeldet (bugs + security), identischer Code. → eine Medium-Entry.
5. **Stale presence/`_load_context`-Doppel-Query, mention-Block-Check N+1** und **`fan_out_mention_events` N-Query Block-Check** — `mentions.py:328-334` **2×** gemeldet (chat-gw-routes-social high, chat-gw-core medium). → eine Entry, **Medium**.
6. **mention_search unescaped LIKE-Wildcards** (`mention_search.py:70`) — **2×** gemeldet (bugs medium + security low), identische Zeile. → eine Medium-Entry.
7. **Self-host Admin als unprivilegierter User in Permission-Stores** (`roles.svelte.ts:115` / `channelPermissions.svelte.ts:64`) — **3×** gemeldet (web-perms-admin bugs, GuildRail :477, „Cloud admin bleeds into self-host"). Verwandte Symptome desselben Root-Cause (falsche Admin-Quelle). → eine Medium-Entry + GuildRail-Hinweis.
8. **VAPID-Key nicht persistiert** (`docker-compose.yml`) — **2×** gemeldet (infra bugs high :245, infra security low :233). → eine High-Entry.
9. **Anonymer WHEP/HLS-Read ohne Auth** — **3×** gemeldet (stream-backend `routes.py:176-182`, infra `routes.py:176`, web-stream-watch `streaming.py:150` VIEW_CHANNEL-Bypass). Transport-Layer-Aspekt → **Medium**; der VIEW_CHANNEL-Overwrite-Bypass im chat-gateway-Proxy bleibt verwandte Low-Entry.
10. **Invite-Deeplink akzeptiert HTTP-Hostname → Cert-Login im Klartext** — **2×** gemeldet (web-core `servers.svelte.ts`, web-misc `invite/[code]/+page.svelte:23-29`). → eine Medium-Entry.

---

## 3. Findings nach Severity

### HIGH

**H1 — Backup-Code-Login für Passkey-only-Accounts unmöglich** · `routes_totp.py:260-269` · `[bugs]`
Impact: `/login/totp`-Guard `not user.totp_enabled` blockt Backup-Codes für Passkey-only-Accounts; Recovery nach Geräteverlust dauerhaft gesperrt — Account-Lockout.
Fix: Guard auf „hat irgendeinen MFA-Faktor" (`totp_enabled OR passkey_count > 0`) ändern; `_consume_second_factor` behandelt Backup-Codes bereits korrekt.

**H2 — N+1 in @mention-Fanout bei @everyone** · `mentions.py:328-335` · `[perf]`
Impact: Pro offline-Recipient ein `is_blocked_between`-SELECT; @everyone in großem Server = Hunderte sequenzielle DB-Roundtrips im POST-/messages-Pfad.
Fix: Block-Check batchen — ein `SELECT … WHERE blocked_id = ANY(:ids) OR blocker_id = ANY(:ids)`, dann in Python filtern.

**H3 — mod_queue zeigt message-targeted Reports nie an** · `mod_queue.py:144` · `[bugs]`
Impact: Subquery selektiert `Message.channel_id` statt `Message.id`; `Report.target_message_id.in_(channel_ids)` matcht durch globale Snowflake-Eindeutigkeit praktisch nie → Moderatoren sehen keine Nachrichten-Reports.
Fix: `select(Message.id)` statt `select(Message.channel_id)`.

**H4 — Socket-Leak im ConnectionManager bei Ready-Frame-Fehler** · `routes/ws.py:151-157` · `[bugs]`
Impact: Wirft `build_and_send_ready_frame` nach `register()`, wird `remove_socket` nie aufgerufen; Socket bleibt in allen vier Dicts und verbraucht einen der 10 Connection-Slots dauerhaft.
Fix: Post-register-Block in `try/finally` mit `await manager.remove_socket(websocket)`; `remove_socket` aus `run_session_op_loop.finally` herausziehen.

**H5 — `_filter_by_view_channel` öffnet N parallele DB-Sessions bei Cold Cache** · `pubsub_perm_filter.py:298-305` · `[perf]`
Impact: Jedes voice/stream/watch/channel_bump-Event triggert pro nicht-gecachtem Socket eine eigene Session mit 5–6 Queries; nach Deploy-Restart sättigt der erste voice_state-Event den asyncpg-Pool (max 30) und blockiert den Pub/Sub-Listener.
Fix: Bei Cache-Miss batchen — Guild + Overwrites einmal laden, alle Rollen per `WHERE user_id IN (…)`, dann den pure-Python-Resolver pro Socket. Muster aus `members_who_can_view` adaptieren.

**H6 — Unhandled Exceptions in Plugin-Handlern killen die WS-Session** · `routes/ws_ops.py:140` · `[bugs]`
Impact: `await handler(ctx, msg)` ohne try/except; ein DB-Fehler im Plugin-Handler (z. B. tamagotchi `apply_atomic_update`) propagiert aus dem Op-Loop → FastAPI schließt die Session mit 1011.
Fix: `await handler(ctx, msg)` in try/except wrappen (loggen + Error-Frame senden); zusätzlich try/except um `apply_atomic_update` in `tamagotchi/backend.py:200-208`.

**H7 — Ed25519 Private Key als `extractable: true` generiert** · `keypair.svelte.ts:89` · `[security]`
Impact: Identitäts-Schlüssel per `crypto.subtle.exportKey` aus jedem same-origin-Script exfiltrierbar (CSP hat `unsafe-inline`/`unsafe-eval` → kein XSS-Schutz). Gestohlener Key = unbegrenzte Impersonation auf jedem Self-Host via Cert-Login (Cert bis ~1 Jahr gültig).
Fix: `extractable: false` als Default; für Backup einmaliger Export beim Backup-Erstellen über den `forBackup`-Hook statt dauerhaft exportierbarem Key.

**H8 — Membership-Check stillgelegt wenn `CHAT_GATEWAY_URL` unset** · `routes/chat_gateway.py:64-77` · `[security]`
Impact: Default ist `None`; `_require_voice_channel_member` returnt dann ohne jede Prüfung. Jeder authentifizierte User bekommt LiveKit-Token für beliebige (auch private/non-voice) Channels. Operator ohne explizit gesetzte Env shippt die Lücke nach Prod.
Fix: `CHAT_GATEWAY_URL` als Required-Setting; Startup refusen wenn unset statt still degradieren.

**H9 — VAPID-Key nicht über Container-Neustarts persistiert** · `infra/prod/docker-compose.yml:245` · `[bugs]` *(2 Reviewer)*
Impact: Kein Volume für `data/vapid.json`; Watchtower recreated den Container bei jedem `:latest`-Pull → neues Keypair → alle Browser-Push-Subscriptions still ungültig (403), keine UI-Fehlermeldung.
Fix: Named Volume `pulse_chat_data:/app/services/chat-gateway/data` mounten, oder `VAPID_PRIVATE_KEY`/`VAPID_PUBLIC_KEY` fix in `.env` setzen.

---

### MEDIUM

**M1 — `DELETE /me` überspringt 2FA für Passkey-only-Accounts** · `routes_account.py:134` · `[bugs/security]` *(2 Reviewer)*
Impact: Guard nur `if current.totp_enabled`; Passkey-only-Account löschbar mit Passwort + 15-Min-Token ohne 2. Faktor. Account-Löschung irreversibel.
Fix: Guard auf `totp_enabled or passkey_count > 0`; Backup-Code verlangen (`AccountDeleteIn.backup_code` existiert bereits).

**M2 — Profile-Statement-Cache invertiert** · `routes_profile.py:76-78` · `[bugs]`
Impact: `age >= _CACHE_STALE_SECS`-Guard bypasst den Cache in den ersten 5 s nach Issue → bei Requests häufiger als alle 5 s permanente Neu-Ausstellung.
Fix: `if cached is not None and age < _STATEMENT_TTL_SECS - 60: return token`; `_CACHE_STALE_SECS` entfernen.

**M3 — `GET /guilds/{id}/channels` ohne VIEW_CHANNEL-Filter** · `routes/channels.py:81` · `[bugs]`
Impact: Jedes Mitglied bekommt Metadaten (id/name/topic/type/position) aller Channels, auch privater mit `VIEW_CHANNEL=deny`.
Fix: Resultat per `resolve_permissions(..., channel_id=…)` filtern (Muster aus dem WS-Subscribe-Gate).

**M4 — `presence.py` umgeht email_blocked-Gate** · `routes/presence.py:47-55` · `[bugs/security]` *(2 Reviewer, chat-gw-core + chat-gw-routes-admin)*
Impact: `PUT /me/presence-status` decodiert das Token manuell via `decode_token()` statt `CurrentUser`; email-blockierte User können Presence setzen + an alle Guilds broadcasten.
Fix: `current: CurrentUser`-Dependency verwenden statt manuellem Header-Parsing.

**M5 — Mention-Search: unescaped LIKE-Wildcards** · `mention_search.py:70` · `[bugs/security]` *(2 Reviewer)*
Impact: `q=%` → `LIKE '%%'` matcht alle Profile in `cached_user_profiles` (global, nicht guild-gescoped) → Cross-Guild-User-Enumeration für jedes Mitglied.
Fix: `%`/`_`/`\` escapen und `.like(f"{q_escaped}%", escape='\\')`, oder `startswith()`.

**M6 — Mention-Block-Check: N sequenzielle Queries** · `mentions.py:328-334` · `[perf]` *(2 Reviewer)*
Impact: Offline-Recipients (Cache-Miss) feuern je ein `is_blocked_between`-SELECT; @everyone/@role auf großem Server = N Roundtrips. (Identischer Root-Cause wie H2, separat von beiden Review-Targets gemeldet.)
Fix: Single batched `SELECT … blocked_id IN (targets)`.

**M7 — Web-Push-Sequenzielles Fanout im Send-Pfad** · `push.py:246` · `[perf]`
Impact: `for uid: await send_push_to_user(...)` seriell; jeder Call DB-Query + `asyncio.to_thread` HTTPS-Push. N Mentions = N sequenzielle Roundtrips, blockiert die HTTP-Response.
Fix: `asyncio.gather` über die User, oder Push als Background-Task ausspawnen.

**M8 — `list_invites` filtert in Python statt SQL (kein LIMIT)** · `routes/invites.py:163` · `[perf]`
Impact: Lädt alle non-revoked Invites einer Guild ohne LIMIT, filtert expired/exhausted erst in Python; unbegrenzt wachsendes Resultset.
Fix: Expiry/Use-Conditions in WHERE pushen + LIMIT (Muster aus `accept_invite`).

**M9 — Attachment-Reaper ohne LIMIT** · `routes/attachments.py:383` · `[perf]`
Impact: `_reap_once` lädt alle Orphans ohne LIMIT in Memory und feuert `asyncio.gather(*_drop)` → unbegrenzte parallele S3-DeleteObject-Calls (10 000 Orphans = 20 000 Calls).
Fix: `.limit(500)` / `REAPER_BATCH_SIZE`; Backlog über mehrere Ticks abbauen.

**M10 — `apply_atomic_update` nutzt zwei Transaktionen** · `plugins/state_store.py:144` · `[bugs]`
Impact: `session.commit()` nach `_ensure_row` trennt INSERT von SELECT-FOR-UPDATE/UPDATE; bei concurrent Guild-Delete (CASCADE) zwischen den Commits wirft `scalar_one()` `NoResultFound` → killt die WS-Session.
Fix: Intermediären Commit entfernen (eine Transaktion); `scalar_one_or_none()` mit Guard.

**M11 — Plugin-Entrypoint `backend`-Feld erlaubt Path-Traversal** · `plugins/registry.py:366` · `[security]`
Impact: `backend = "../../services/auth/.../app:evil"` lädt beliebige `.py` außerhalb des Plugin-Dirs via `spec_from_file_location`. Eskalation innerhalb der Admin-Trust-Boundary (Filesystem-Write + Admin-Approval nötig).
Fix: `file_path.resolve().is_relative_to(directory.resolve())` prüfen; Regex-Constraint auf `PluginEntrypoints.backend` (z. B. `^[a-z][a-z0-9_]*:register$`).

**M12 — Plugin kann Core-WS-Ops überschreiben (z. B. `send`)** · `routes/ws_ops.py:119` · `[security]`
Impact: Plugin-Gate greift nur bei colon-Ops; ein Plugin mit `ws_ops = ["send"]` + Handler `"send"` läuft für jeden User ohne Allowlist/Membership/Permission-Check → kompletter Umgehung der Channel-Permission-Enforcement. (Admin-Deploy nötig.)
Fix: Frozenset geschützter Core-Op-Namen; Registrierung non-namespaced Ops aus Plugins ablehnen; im strict-Mode als Violation flaggen.

**M13 — CRL fail-open bei Redis-Fehler** · `credential_validator.py:173-176` · `[security/bugs]` *(3 Reviewer)*
Impact: `except: is_revoked = False` lässt revoked Identity-Certs durch, solange das Set-Op (`sismember`) bei partiellem Redis-Ausfall fehlschlägt; suspendierter User loggt sich weiter ein.
Fix: Fail-closed — bei Exception `is_revoked = True` (oder `None` zurückgeben); Metrik/Alert; optional Last-Known-Good in-process cachen.

**M14 — Cert-Login Challenge-Token nicht single-use (Replay im TTL)** · `cert_login.py:209-278` · `[security/bugs]` *(3 Reviewer)*
Impact: `/verify` markiert das Challenge-Nonce nicht als konsumiert; identischer `{cert, challenge_token, signature}`-Body kann im 60-s-Fenster wiederholt eingereicht werden → mehrere Session-Tokens (relevant bei Log-/Proxy-/TLS-Leak des Request-Body).
Fix: Nach erfolgreichem verify Nonce/Hash in Redis `SET NX EX 60`; bereits gesehene Nonces ablehnen (410).

**M15 — Kein Target-User-Validation in voice-override / voice-disconnect** · `routes/voice_override.py:32-142` · `[security]`
Impact: Caller-Membership + Permission geprüft, Target-`user_id` aber nicht; MUTE/MOVE-Holder kann beliebige Redis-Keys `voice:override:channel-…:user-<beliebig>` schreiben, Pre-Mute vor Join, Membership-Probing. `user_id` ist unbeschränkter `str`.
Fix: Path-Constraint `^\d{1,20}$` auf `user_id` (beide Routes); optional Target-Membership-Check.

**M16 — Cert-Rotation/Profile-Refresh-Timer starten nie bei Issue-Flow-Fehler** · `auth.svelte.ts:71` · `[bugs]`
Impact: In `_doHydrate()` schluckt der äußere catch Nicht-`RecoveryAvailableError`-Fehler aus `runIssueFlow()`; `startProfileRefresh()`/`startCertRotation()` werden nie erreicht → Cert/Profil laufen still ab (bis 1 Jahr), Cert-Login bricht.
Fix: Non-`RecoveryAvailableError` loggen und trotzdem die Timer starten; deren Intervalle retrien selbst.

**M17 — Anonymer WHEP/HLS-Read ohne Membership-Check** · `mediamtx-auth-hook/routes.py:176` · `[security]` *(3 Reviewer)*
Impact: Auth-Hook gibt unbedingt 200 für `read`/`playback` auf `channel-*`; nginx routet `/whep/`+`/hls/` ohne Auth zu MediaMTX. Wer den Pfad kennt (geleakt über Logs/DevTools/URL-Sharing), sieht den Stream — auch nach Guild-Austritt, da nie invalidiert.
Fix: Member-Token auf WHEP/HLS verlangen (von media-svc ausgegeben, Hook validiert gegen Redis) oder nginx `auth_request` an chat-gateway; Nonce an Session binden.

**M18 — Self-host Admin als unprivilegierter User in Permission-Stores** · `roles.svelte.ts:115` / `channelPermissions.svelte.ts:64` · `[bugs]` *(3 Reviewer)*
Impact: `isAdmin` nur aus `auth.user?.is_admin` (Cloud-Flag); Self-Host-Admin (nicht Cloud-Admin) verfehlt den `GRANT_ALL_SAFE`-Shortcut → Settings/Channel-Aktionen versteckt. Auch GuildRail :450/:477 betroffen (Delete/Gear). Umgekehrt: Cloud-Admin sieht „Community löschen" für fremde Self-Host-Guilds.
Fix: `serverAdmin.isAdmin(serverId)` für Self-Host konsultieren (Muster aus `admin/+page.svelte`); GuildRail mitziehen.

---

### LOW

> 57 Findings. Kompakt nach Bereich; alle mit adjustedSeverity = low.

**auth-svc**
- `recovery.py:100-108` / `passkeys.py:103-108` `[bugs]` — MFA-/Challenge-Tickets ohne `aud`/`iss`-Validierung dekodiert. Fix: `issuer`/`audience` an `jwt.decode` übergeben (Muster `JwtSigner.decode`).
- `routes_admin_instances.py:186-201` `[perf]` — N+1 per `session.refresh` in `list_applications`/`list_instances`. Fix: `selectinload`.
- `routes_search.py:76-77` `[perf]` — kein Functional-Index für `LOWER(username)`/`LOWER(display_name)` → Seq-Scan pro Tastendruck. Fix: Expression-Index mit `text_pattern_ops`.
- `routes.py:65-76` `[perf]` — `SmtpSettings`-DB-Hit pro `/login` & `/me` (unverified User). Fix: TTL-Cache (~60 s), invalidieren bei Admin-Update.
- `routes.py:644-646` / `routes_credentials.py:46` `[perf]` — O(N)-Sweep des Rate-Bucket-Dicts pro Request. Fix: lazy Eviction oder `OrderedDict`/Redis.
- `browser_sessions.py:106-119` `[perf]` — `revoke_all_for_user` lädt alle Sessions + N UPDATEs. Fix: Bulk-`update(...)`.
- `routes_suspended_instances.py:261-288` `[perf]` — neuer `httpx.AsyncClient` pro Instanz im `gather`. Fix: einen Client teilen.
- `routes_totp.py:318` `[security]` — TOTP-Code nicht single-use (valid_window=1 → ~90 s Replay). Fix: Last-Counter pro User speichern.
- `routes_suspended_instances.py:204,240` `[security]` — `!=` statt `hmac.compare_digest` für INTERNAL_SERVICE_SECRET. Fix: `compare_digest`.
- `routes.py:622` `[security]` — In-process Rate-Limiter nicht worker-übergreifend; bei `--workers >1` umgehbar. Fix: Redis-Limiter / Single-Worker dokumentieren.

**chat-gateway (routes-social / core / admin)**
- `invites.py:275` `[bugs]` — spuriöses `guild_member_added` bei concurrent Invite-Accept-Race. Fix: `actually_added`-Flag.
- `messages.py:365` / `:193` `[bugs]` — Whitespace-only Content wird ungestrippt gespeichert wenn Attachment vorhanden. Fix: `payload.content.strip()` speichern.
- `permissions.py:111-137` / `dcc_chat_gateway/permissions.py:123` `[perf]` *(4 Reviewer)* — separater @everyone-SELECT zusätzlich zum Member-Roles-JOIN bei jedem Permission-Check. Fix: in eine `OR is_everyone`-Query mergen.
- `permission_overwrites.py:124-141` `[perf]` — doppelter `_load_context` (check_permission + assert_overwrite). Fix: resolved Bitfield aus `check_permission` durchreichen.
- `dms.py:74` `[perf]` — `_can_send_batch` lädt alle Friendships/Blocks statt auf `other_ids` zu filtern. Fix: `.in_(other_ids)`.
- `roles.svelte.ts`-Backend `roles.py:114-116` `[perf]` — Python-`max()` statt SQL `MAX(position)`. Fix: `select(func.max(...))`.
- `roles.py:257-259` `[perf]` — N `session.refresh` + N Redis-Publishes in `update_role_positions`. Fix: refresh droppen, Publishes batchen/gathern.
- `admin_plugins_publish.py:74-85` `[perf]` — N sequenzielle Publishes. Fix: `asyncio.gather`.
- `presence_status.py:248-283` `[perf]` — N sequenzielle GET+SET im Idle-Sweeper. Fix: MGET + Pipeline.
- `dm_bump`-Event broadcast an alle Sockets (`messages.py:308` / `ws_op_send.py:314`) `[security]` — leakt DM-Beziehungs-Metadaten (user_a/b, message_id, timing). Fix: Filter-Branch nur an DM-Teilnehmer.
- `invites.py:157` `[security]` — `list_invites` zeigt alle aktiven Invite-Codes jedem Member. Fix: `MANAGE_INVITES`-Check.
- `messages.py:326` `[security]` — `edit_message` ohne Rate-Limit (Push-DoS via Edit-Spam). Fix: `ratelimit.check("message", …)`.
- `attachments.py:100` `[security]` — kein Rate-Limit auf Upload-URL-Creation (Redis/S3-Flooding). Fix: per-User-Limit (z. B. 20/min).
- `ws_ops_handlers.py:271-275` `[bugs]` — profile_statement-Handler schließt WS ohne Op-Loop-Break → `RuntimeError`-Traceback. Fix: Sentinel-Exception/`break`.
- `pubsub_channel_guild.py:115-118` `[bugs]` — non-numerische `channel_id` → `_filter_by_view_channel` returnt `targets` (bypass). Fix: bei Parse-Fail `[]` zurückgeben.
- `pubsub.py:124-146` `[bugs]` — Plugin-Channels nach Listener-Crash nicht re-subscribed. Fix: `_plugin_channels` tracken und in `start()` replayen.
- `pubsub.py:329-343` `[perf]` — `voice_state_for` 3 serielle Redis-Calls + `voice_overrides_for` SCAN pro Channel. Fix: Pipeline; Overrides als Hash.
- `pubsub_friend_cache.py:199-212` `[perf]` — `_filter_presence_visibility` O(T×C). Fix: `_user_conns`-Reverse-Index nutzen.
- `pubsub.py:231-234` `[perf]` — `remove_socket` scannt alle `_subs`. Fix: `_ws_channels`-Reverse-Index.
- `mentions.py:348-352` `[perf]` — N sequenzielle `publish_user_event`. Fix: `asyncio.gather`.
- `app.py:238` `[security]` — `/internal/jwks-status` öffentlich via nginx erreichbar. Fix: `location /internal/ { deny all; }`.
- `ratelimit.py:6` `[security]` — In-process Limiter per-pod, bei Multi-Instance umgehbar. Fix: Redis-Limiter (aktuell single-pod, latent).
- `ws_ops.py:94` `[security]` — Oversize-Frame-Counter dekrementiert pro Normal-Frame → 4-over/4-under-Pattern unbegrenzt. Fix: striktes Counting / Backoff.
- `permissions.py:207` `[bugs]` — `member=bool(member_roles)` demotet echte Members zu 0 Permissions wenn @everyone-Row fehlt. Fix: explizites `is_member`-Argument.
- `cert_login.py:150-278` `[security]` — kein Rate-Limit auf `/cert-login/challenge|verify` (unauth, Redis/CPU-DoS). Fix: IP-Limit (Caddy/in-process).
- `role_members.py:41-77` `[security]` — `assign_member_role` validiert Target-Membership nicht → 500-vs-204-Oracle (FK-Violation). Fix: `require_member`-Check + IntegrityError-Handler.

**shared**
- `permission_resolver.py:147,152` `[perf]` — `ctx.member_roles()` doppelt aufgerufen in `calculate_channel_permissions`. Fix: einmal in lokale Var.
- `permission_resolver.py:42-47` `[security]` — `Override.apply` Deny-wins, Docstring behauptet Discord-Allow-wins → versehentlicher VIEW_CHANNEL-Lockout möglich. Fix: Docstring korrigieren; optional `allow & deny != 0` ablehnen.

**voice-svc**
- `voice_override.py:32-35` / `voice_disconnect.py` `[bugs]` — `user_id`/`channel_id` Path-Params ohne Format-Validation. Fix: `Path(pattern=r'^\d+$', max_length=64)`.
- `webhook.py:180-181` `[bugs]` — `_apply_leave` 2 separate `redis.eval` → Inkonsistenz-Fenster (Phantom-Streaming-Badge). Fix: Single Two-Key-Lua-Script.
- `webhook.py:86-88` `[bugs]` — `_is_screen_share` Name-Fallback feuert für jede Source, nicht nur UNKNOWN. Fix: hinter `source_int == 0` gaten.
- `webhook.py:135-139` `[perf]` — neuer `WebhookReceiver` pro Webhook-Request. Fix: Singleton in Lifespan.
- `livekit_client.py:53-74` `[perf]` — neuer `LiveKitAPI` pro Mute/Kick. Fix: gemeinsame Instanz.
- `chat_gateway.py:49` `[perf]` — neuer `httpx.AsyncClient` pro Request. Fix: persistenter Client auf app.state.
- `token.py:50-51` (+ override/disconnect) `[perf]` — 2 sequenzielle chat-gateway-Roundtrips. Fix: `asyncio.gather`.
- `webhook.py:180-181` `[perf]` — 2 sequenzielle Lua-EVALs in `_apply_leave`. Fix: Two-Key-Lua.
- `internal.py:25` `[perf]` — `channel_ids` ohne `max_length` → unbegrenzter sequenzieller LiveKit-RPC-Loop. Fix: Liste cappen + `gather`.
- `internal.py:50` `[security]` — `!=` statt `hmac.compare_digest` für Internal-Secret. Fix: `compare_digest`.
- `token.py:35-94` `[security]` — kein Rate-Limit auf `POST /token` (Amplification gegen chat-gateway). Fix: slowapi per-User-Limit.
- `infra/prod/.env.example:66` `[security]` — `INTERNAL_SERVICE_SECRET=` leer → Voice-Eviction bei Ban/Kick still deaktiviert. Fix: Kommentar + Boot-Warnung.
- `infra/prod/web-nginx.conf:89-93` `[security]` — LiveKit-Webhook `/api/voice/webhook` öffentlich routbar. Fix: `location = /api/voice/webhook { deny all; }`.

**stream-backend**
- `mediamtx-auth-hook/routes.py:101-172` `[bugs]` — TOCTOU im single-use Token-Delete (GET+DEL nicht atomar) → Replay/Hijack im Race. Fix: Lua-EVAL (GET+DEL atomar).
- `media-svc/poller.py:74` `[bugs]` — `{"items": null}` → `TypeError`, ganzer Reconcile-Tick übersprungen. Fix: `data.get("items") or []`.
- `poller.py:134` `[bugs]` — `since` bleibt stale bei komplettem Streamer-Wechsel in einem Poll. Fix: bei leerem Schnitt `now` setzen.
- `poller.py:127` `[perf]` — sequenzielle per-Channel Redis-Roundtrips in `reconcile_once`. Fix: MGET + Pipeline.
- `mediamtx-auth-hook/routes.py:167` `[perf]` — 2 sequenzielle Redis-Writes im Publish-Auth-Pfad. Fix: Pipeline/`gather`.
- `media-svc/routes.py:98-133` `[security]` — kein Rate-Limit auf Stream-Token-Issuance. Fix: per-User-Limit (~10/min).
- `poller.py:61-87` `[security]` — unbegrenzter Pagination-Loop (`< items_per_page`-Exit) bei adversem MediaMTX. Fix: `MAX_PAGES`-Guard.
- `media-svc/routes.py:136-174` `[security]` — `GET whep`/`stream` ohne Auth (nur Docker-Netz-isoliert). Fix: Internal-Secret-Dependency.

**web-core / web-voice / web-perms-admin / web-stream-watch / web-misc**
- `idb-shared.ts:46` `[bugs]` — `idbPutIdentity` resolved auf `req.onsuccess` statt `tx.oncomplete` → Crash-Fenster verliert Keypair/Cert. Fix: auf `tx.oncomplete` resolven.
- `ws/handlers/ready.ts:82` `[bugs]` — stale Presence-Statuses bei Reconnect ohne `user_presence_statuses`. Fix: `seedStatuses` unbedingt aufrufen.
- `ws/handlers/ready.ts:54` `[bugs]` — `owner_id ?? ''`-Fallback bricht Owner-Permission-Resolution. Fix: `null`-Fallback + Guard in `isOwner`.
- `ws/gateway-connection.ts:281` `[bugs]` — fehlendes `return` nach `reject()` im close-before-open-Pfad. Fix: `return` ergänzen.
- `ws/gapFill.ts:58` `[perf]` — sequenzielle Gap-Fill-HTTP-Calls pro Channel. Fix: `Promise.allSettled`.
- `messages.svelte.ts:192` `[perf]` — `JSON.stringify` zum Reactions-Vergleich in `reconcile`. Fix: struktureller `reactionsEqual`-Helper.
- `ws/handlers/members.ts:49` `[perf]` — `guild_member_added` triggert volles `GET /guilds`. Fix: `getGuild(id)` + `add`.
- `ws/handlers/guild.ts:68` `[perf]` — `member_roles_updated` feuert unbedingt `ensure()`-Refetch. Fix: nur `invalidate()`.
- `presence.svelte.ts:47` `[perf]` — neuer Set pro Presence-Event. Fix: in-place mutieren (Svelte-5-Proxy trackt).
- `messages.svelte.ts:210` `[perf]` — `isConfirmed` scannt alle Channels/Messages. Fix: `Map<nonce,bool>`.
- `guilds.svelte.ts:66` `[perf]` — `guildIdForChannel` O(guilds×channels) pro Send. Fix: Reverse-Index `Map<channelId,guildId>`.
- `readState.svelte.ts:159` `[perf]` — synchrone localStorage-Writes pro Message. Fix: Debounce (200 ms).
- `guilds.svelte.ts:95` `[perf]` — `removeChannel` rebuildet alle Guild-Listen. Fix: nur betroffene Guild via Reverse-Index.
- `api/storage.ts:13-26` `[security]` — Access/Refresh-Token in localStorage. Fix: Refresh-Token als HttpOnly-Cookie / Electron-Store.
- `ws/gateway-connection.ts:212-216` `[security]` — WS-Token als URL-Query (Logs/History). Fix: Query-String im nginx-Log redacten.
- `livekit.svelte.ts:596-604` `[bugs]` — verwaiste LiveKit-Video-Publication bei Audio-Publish-Fehler (Ghost-Tile). Fix: `unpublishTrack(videoTrack)` im catch.
- `livekit.svelte.ts:290-313` `[bugs]` — fehlender Gen-Recheck nach `startAudio()` → stale connect korrumpiert voiceState/Mic. Fix: `if (gen !== this.#connectGen) return;` nach den awaits.
- `livekit.svelte.ts:938-942` `[perf]` — Map-Rebuild pro 200-ms-Tick in `#patchAudioLevels`. Fix: direktes `remoteParticipants.get()`.
- `livekit.svelte.ts:785-891` `[perf]` — `#refreshParticipants` pro Einzel-Event (Full-Rebuild+Sort). Fix: microtask-debounce.
- `noiseFilter.ts:152-153` `[perf]` — `addModule` unbedingt bei jedem Rebuild. Fix: `WeakSet<AudioContext>`-Guard.
- `localMicAnalyser.ts:53-57` `[perf]` — neuer `AudioContext` pro `attach()`. Fix: laufenden Context wiederverwenden.
- `audioElements.ts:132-134` `[perf]` — `setUserVolume` linearer Node-Scan. Fix: `Map<userId,Set<sid>>`.
- `plugins/guild-activation.svelte.ts:84` `[bugs]` — `refreshGuildPlugins` gibt stale Inflight-Promise zurück (latent, kein Caller). Fix: `loadingByGuild.delete(guildId)`.
- `plugins/registry.ts:144` `[bugs]` — `activatePlugin` ohne Concurrent-Guard (latent). Fix: Inflight-Promise-Map.
- `GuildRail.svelte:477` `[bugs]` — `auth.user?.is_admin` für Guild-Delete-Sichtbarkeit auf Self-Host (Teil von M18). Fix: `serverAdmin.isAdmin(serverId)`.
- `roles.svelte.ts:159-163` `[perf]` — `hasGuildPermission` reparst BigInt aus String pro Read. Fix: bigint speichern/memoizen.
- `bitfield.ts:124-127` `[perf]` — `resolveChannelPermissions` klont+sortiert Rollen pro Call. Fix: resolved Bitfield cachen.
- `roles.svelte.ts:145-156` `[perf]` — `snapshotsForUser` allokiert + reparst pro Channel-Read. Fix: in `recomputeGuild` memoizen.
- `conflict-detector.ts:63` `[perf]` — `Array.includes` statt Set im Dup-Guard. Fix: `Set<string>`.
- `plugins/registry.ts:58` `[security]` — Plugin-Permission-Gate via `globalThis` zur Laufzeit abschaltbar (TOCTOU, soft-sandbox). Fix: Mode auf Modul-Load fixieren + Vite-`define`.
- `tamagotchi/backend.py:245` `[security]` — `tamagotchi:reset` ohne Admin-Gate (Referenz-Plugin). Fix: `MANAGE_GUILD`-Check.
- `plugins/ws_op_gate.py:255` `[security]` — Gate-Error-Codes (4040 vs 4043) leaken Allowlist-Status an Member. Fix: uniforme Fehlermeldung.
- `tamagotchi/backend.py:291-304` `[perf]` — O(total_connections)-Scan pro Event. Fix: guild→sockets Reverse-Index.
- `admin_plugins.py:184-192` `[perf]` — zwei Filesystem-Scans pro Admin-PUT. Fix: PluginManager-Snapshot statt Re-Scan.
- `ws_op_gate.py:111-122` `[perf]` — FIFO- statt LRU-Eviction im Plugin-Cache. Fix: `OrderedDict`/TTLCache.
- `guild_plugins.py:126-132` `[perf]` — `list_guild_plugins` reholt Allowlist aus DB statt `app.state`-Snapshot. Fix: Snapshot lesen.
- `whep.ts:88` `[bugs]` — `ontrack` feuert pro Track, `onTrack` 2× (kurz unmuted Video-Element). Fix: einmal feuern / dedupe.
- `attachments/upload.svelte.ts:186` `[bugs]` — fehlender `cancelled`-Check zwischen Main- und Thumb-PUT → orphaned Thumb. Fix: `if (cancelled) return;`.
- `watch/players/YouTubePlayer.svelte:35` `[bugs]` — `apiPromise` per-Instance → doppelte Script-Injection. Fix: Module-Scope + DOM-Dedup.
- `watch/sync.ts:132` `[bugs]` — Hard-Seek wendet 1.5 s Lookahead auf pausierten State an (Viewer 1.5 s vor Host). Fix: `SEEK_LEAD_S` auf `is_playing` gaten.
- `attachments/upload.svelte.ts:146` `[perf]` — Bild 2× dekodiert (`_measureImage` + `_generateThumb`). Fix: Dimensionen aus `_generateThumb` zurückgeben.
- `stream/detach.svelte.ts:42` / `watchPartyDetach.svelte.ts:35` `[perf]` — permanente 800-ms-Intervals ohne Cleanup. Fix: lazy starten/stoppen.
- `s3.py:158` `[security]` — unescaped Filename in `Content-Disposition` (Header-Korrektheit; XSS-Pfad durch Go-CRLF-Reject blockiert). Fix: RFC-5987-Encoding / `"`,CRLF strippen.
- `streaming.py:150` `[security]` — WHEP-Viewer-Endpoint umgeht VIEW_CHANNEL-Overwrites. Fix: `resolve_permissions`-Check (Muster WS-Subscribe).
- `watch_source.py:174` `[security]` — `native`-Watch-URL erlaubt interne Hosts → Client-SSRF-Probing. Fix: RFC-1918/link-local-Denylist.
- `VoiceChannelView.svelte:140` `[bugs]` — PTT-Release setzt `pttPressed` bei blur/visibilitychange nicht zurück → spuriöser Doppel-Release. Fix: `pttPressed = false` in beiden Handlern.
- `SettingsAudioVideo.svelte:70` `[bugs]` — PTT-Capture-Listener leakt bei Dialog-Close ohne Tastendruck → kapert jeden keydown. Fix: Listener-Cleanup in `onDestroy`/bei Close.
- `InviteDialog.svelte:75` `[bugs]` — concurrent `generateInvite` bei schnellen Dropdown-Changes erzeugt Extra-Invites. Fix: `if (busy) return;`.
- `GuildSettingsDialog.svelte:90` `[bugs]` — Default-Tab-Effekt überspringt `bans` in der Fallback-Kette. Fix: `else if (canBanMembers) tab = 'bans';`.
- `messageRender.ts:214` `[bugs]` — `ALLOW_DATA_ATTR: true` lässt beliebige `data-*` durch DOMPurify. Fix: `'data-self'` explizit in `ALLOWED_ATTR`.
- `invite/[code]/+page.svelte:23-29` `[security]` *(2 Reviewer)* — HTTP-Hostname im Deeplink → Cert-Login im Klartext (Cert-Exfiltration via MITM). Fix: `http://`→`https://` upgraden (Muster `server-info.ts`).
- `ChatView.svelte:157` `[perf]` — O(N) Reply-Parent-Scan pro Message pro Render. Fix: `$derived Map<id,Message>`.
- `settings-registry/registry.svelte.ts:127` `[perf]` — `PERSIST_DEBOUNCE_MS=0` → full JSON-Serialize aller Sections pro Mutation. Fix: Debounce 100–250 ms.
- `MentionAutocomplete.svelte:49` `[perf]` — dupliziert `listMembers`-Fetch. Fix: guild-scoped Share-Store.
- `RolesEditor.svelte:283` `[perf]` — O(N²) filter+findIndex im `{#each}`. Fix: vor der Schleife vorberechnen.
- `messageRender.ts:91` `[perf]` — `roleMentionLabel` linearer Scan über alle Guild-Rollen. Fix: flacher `roleId→Role`-Map.
- `admin/AdminAuditLog.svelte:39` `[perf]` — Set-Clone pro Expand/Collapse (cap 50, marginal). Fix: in-place mutieren.
- `ChatView.svelte:113` `[perf]` — wiederholte `new Date()`/`toDateString()` pro Message. Fix: cachen/weiterreichen.

**desktop**
- `electron/main.ts:184-192` `[bugs]` — Deeplink an Renderer vor dessen `onMount` gesendet → still verloren (open-url/second-instance). Fix: pull-basiert (`ipcMain.handle` + Renderer holt on-mount).
- `electron/main.ts:184-188` `[bugs]` — `webContents.isDestroyed()` vor `send` ungeprüft (vgl. :274). Fix: Guard ergänzen.
- `stream/persistence.ts:96` `[perf]` — `saveAll` N IPC-Roundtrips + N synchrone Disk-Writes pro Debounce. Fix: `store:setAll`-Handler.
- `electron/sidecar.ts:91` `[perf]` — Path-Resolver walkt FS pro Spawn. Fix: resolved `SpawnTarget` memoizen.
- `electron/notify.ts:43` `[perf]` — Notification-Objekte + Closures nie freigegeben. Fix: bounded Map + TTL/Evict.
- `electron/notify.ts:42` `[security]` — beliebiger lokaler File-Path als Notification-Icon (latent, Call-Site unset). Fix: Icon-Pfad strikt validieren.
- `electron/main.ts:314` `[security]` — `store:set` ohne Key-Allowlist. Fix: Allowlist + Size-Cap.
- `electron/main.ts:112` `[security]` — `PULSE_URL` verschiebt die Origin-Guard auf angreiferkontrollierte Origin. Fix: `https://` erzwingen, in Packaged-Builds nicht lesen.

**infra**
- `docker-compose.yml:6` `[bugs]` — Header nennt `.env.production`, `env_file:` braucht `.env`. Fix: Kommentar korrigieren.
- `web-nginx.conf:24-27,70` `[perf]` — `Connection: close` an alle REST-Upstreams (kein Keepalive). Fix: `proxy_set_header Connection ''` pro REST-Location.
- `web-nginx.conf:71` `[perf]` — `proxy_read_timeout 3600s` von allen REST-Locations geerbt. Fix: `60s` pro Nicht-WS-Location.
- `backup/backup.sh:44-50` `[perf]` — MinIO-Staging auf Overlay-FS (kein Volume) → doppelte I/O, voller Re-Mirror. Fix: Named Volume `pulse_minio_stage`.
- `mediamtx.yml:68` `[security]` — Control-API (9997) bindet alle Interfaces, vom nginx-Container erreichbar, ohne Auth. Fix: `apiAddress: 127.0.0.1:9997`.

---

## 4. By Area

| Bereich | Findings |
|---|---|
| auth-svc | 13 |
| chat-gw-routes-social | 12 |
| chat-gw-core | 16 |
| chat-gw-routes-admin | 9 |
| shared | 4 |
| voice-svc | 13 |
| stream-backend | 8 |
| plugins-backend | 11 |
| web-core | 11 |
| web-voice | 6 |
| web-perms-admin | 10 |
| web-stream-watch | 9 |
| web-misc | 14 |
| desktop | 8 |
| infra | 8 |

> Summen über alle Bereiche (152) zählen jeden Original-Finding-Eintrag; die deduplizierten Cross-Area-Issues (Abschnitt 2) erscheinen in mehreren Bereichszeilen, sind im Severity-Report (84) aber je einmal gelistet.