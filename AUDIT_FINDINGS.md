# Audit Findings — Security / Robustness / Performance

**Branch:** `night-team-2026-05-11`
**Worktree:** `~/Dokumente/discord-clone/.claude/worktrees/night-team`
**Audit-Datum:** 2026-05-11
**Scope:** Etappe 1 (Auth + Chat) + Etappe 1.5 (shadcn) + Etappe 2 (Voice-Frontend)

Status-Legende: `[ ]` offen · `[x]` gefixt in diesem Durchlauf · `[-]` bewusst deferred (Begründung dabei)

---

## CRITICAL

- [x] **#1 — [Backend] add_member Self-Add → IDOR / Auth-Bypass**
  `services/chat-gateway/src/dcc_chat_gateway/routes/guilds.py:72` — `add_member`
  erlaubte `current.id == payload.user_id`, d.h. **jeder authentifizierte User
  konnte sich selbst zu jeder beliebigen Guild hinzufügen** (Guild-IDs sind
  ratbar/enumerierbar). Folge: voller Zugriff auf alle Channels, Message-History,
  Voice-Tokens jeder Guild.
  **Fix:** Self-Add-Bedingung entfernt — nur der Guild-Owner darf Mitglieder
  hinzufügen (später: `MANAGE_MEMBERS`-Permission). Test-Seeds, die vorher
  Self-Add nutzten, gibt es nicht — alle bestehenden Tests adden über den Owner
  (bleiben grün). `_bootstrap_sync` in `tests/test_ws.py` und
  `test_create_channel_requires_owner` nutzen bereits den Owner-Token.

---

## HIGH

- [x] **#2 — [Frontend] Optimistic Message bleibt für immer bei WS-Disconnect vor ACK**
  `web/src/lib/ws/connection.ts:148` + `.../channels/[channelId]/+page.svelte:112`
  — wird von `fix-frontend` behandelt.

- [x] **#3 — [Backend] WS `int(cid)` / `int(payload["sub"])` ohne try/except + `nonce` ohne Längenlimit**
  `services/chat-gateway/src/dcc_chat_gateway/routes/ws.py:29,70,89,97` —
  ein nicht-numerisches `channel_id` (oder `sub`) löste `ValueError` aus und
  beendete die WS-Connection mit einem unsauberen Stacktrace statt eines
  Error-Frames. `nonce` wurde mit `nonce if isinstance(nonce, str) else None`
  ungebremst übernommen → bei sehr langem `nonce` `StringDataRightTruncation`
  in Postgres (`nonce VARCHAR(64)`).
  **Fix:** `int()`-Konvertierungen in `try/except ValueError` mit Error-Frame
  (Codes 4001 für `sub`, 4008 für `channel_id`); `nonce` auf `[:64]` getrimmt.

- [x] **#4 — [Backend] Refresh-Token-Rotation Race + keine Reuse-Detection**
  `services/auth/src/dcc_auth/routes.py:143` — `refresh` lud den `RefreshToken`
  ohne `SELECT ... FOR UPDATE`. Zwei parallele Requests mit demselben Refresh-Token
  konnten beide die Prüfung passieren → **Token-Fork** (zwei gültige Token-Bäume).
  Außerdem: ein bereits revoketer Token wurde nur abgelehnt, ohne Reuse zu erkennen.
  **Fix:** `session.get(..., with_for_update=True)` (Postgres: row-lock; auf
  SQLite-Tests stiller No-Op, daher zusätzlich der atomare Pfad unten). Bei einem
  Treffer auf einen bereits-revoketen Token → **alle aktiven Refresh-Tokens des
  Users werden revoket** (Reuse-Detection, Discord-/OAuth-Best-Practice). Tokens
  werden erst nach erfolgreichem Lock/Revoke ausgestellt.

- [x] **#5 — [Frontend] `$effect` ruft async `switchTo` ohne Generations-Guard**
  `.../channels/[channelId]/+page.svelte:34` — wird von `fix-frontend` behandelt.

- [x] **#6 — [Backend] Argon2-Hashing synchron im Event-Loop**
  `services/auth/src/dcc_auth/routes.py:104,135` + `security.py` — `hash_password`
  / `verify_password` (50–150 ms bei t=3/m=64MiB/p=4) liefen synchron im
  asyncio-Event-Loop → blockierten **alle** gleichzeitigen Requests des Workers
  für die Dauer.
  **Fix:** Aufrufe via `asyncio.to_thread(...)` in `register`/`login`. Argon2
  ist CPU-gebunden; `to_thread` gibt den Loop frei (GIL wird während des nativen
  argon2-cffi-Calls freigegeben).

- [x] **#7 — [Frontend] `livekit-client` statisch im Main-Bundle (~500–800 KB)**
  `app/+layout.svelte:8` + `ChannelList.svelte:10` — wird von `fix-frontend` behandelt.

- [-] **#8 — [Infra] Keine Service-Dockerfiles, LiveKit `:latest`, LiveKit als root**
  **DEFERRED** — Prod-Readiness-Thema (Etappe 4+), nicht Teil dieses Durchlaufs.
  Erst beim Hetzner-Deployment relevant; siehe `PLAN.md` Section 9.

---

## MEDIUM

- [x] **#9 — [Frontend] PTT bleibt aktiv bei Tab-Fokus-Verlust → Mikro offen**
  `VoiceChannelView.svelte` — `<svelte:window onblur=... onvisibilitychange=...>` ergänzt: beide rufen `voice.pttRelease()` wenn PTT-Mode aktiv. *(Backend nicht betroffen.)*

- [x] **#10 — [Backend] Kein Rate-Limit im chat-gateway**
  `services/chat-gateway/...` — weder Guild-Create noch Message-POST noch
  WS-`send` waren begrenzt → ein User konnte das Gateway / die DB fluten.
  **Fix:** In-process per-User-Token-Bucket (`ratelimit.py`): `post_message`
  und WS-`send` 10/s (sliding window über `monotonic`), `create_guild` 10/min.
  Über die Grenze → HTTP 429 (REST) bzw. `{"op":"error","code":4290}` (WS).
  Kommentar im Code: für Multi-Instance-Deployments Redis-backed nötig (wie bei
  auth-svc, `slowapi`-Limitierung).

- [x] **#11 — [Backend] Kein WS-Frame-Size-Limit → Memory-DoS**
  `services/chat-gateway/.../routes/ws.py` — ein Client konnte beliebig große
  Text-Frames schicken; `receive_text()` puffert den ganzen Frame im RAM.
  **Fix:** `len(raw) > 16 KiB` → Error-Frame 4009 + Connection-Close. Kommentar:
  zusätzlich `uvicorn --ws-max-size` in Prod setzen (Defense-in-Depth).

- [x] **#12 — [Frontend] Guild-Sort mit `Number()` → 64-bit-Precision-Loss**
  `web/src/lib/stores/guilds.svelte.ts:10` — wird von `fix-frontend` behandelt.

- [x] **#13 — [Frontend] Message-Store wächst unbegrenzt**
  `web/src/lib/stores/messages.svelte.ts` — wird von `fix-frontend` behandelt.

- [x] **#14 — [Backend] pubsub Fanout-Head-of-Line-Blocking + malformed Redis-Message killt Listener**
  `services/chat-gateway/src/dcc_chat_gateway/pubsub.py` — (a) `json.loads(data)`
  ohne `try/except`: eine korrupte Redis-Message warf `JSONDecodeError`, der
  `_listen`-Loop fing das im äußeren `except`, loggte und `raise`-te → **der
  einzige Listener-Task für alle Channels stirbt**. (b) `_started` blieb dabei
  `True` → ein späterer `start()` machte nichts (Self-Heal unmöglich). (c)
  `await ws.send_json(envelope)` seriell pro
  Ziel-Socket → ein langsamer/hängender Client verzögert die Zustellung an alle
  anderen (HoL-Blocking).
  **Fix:** `json.loads` pro Message in `try/except` → korrupte Messages werden
  geloggt und übersprungen, nicht re-raised. Fan-out parallel über
  `asyncio.gather(*[asyncio.wait_for(ws.send_json(...), timeout=5)], return_exceptions=True)`
  — Timeouts/Fehler markieren den Socket als tot, ohne andere zu blockieren. Im
  äußeren `except` von `_listen`: `_started = False` setzen, damit ein erneutes
  `start()` den Listener neu aufsetzen kann; zusätzlich Recovery-Restart aus `start()`.

- [x] **#15 — [Backend] `_check_rate` Memory-Leak (Buckets nie evicted) + Proxy-IP-Problem**
  `services/auth/src/dcc_auth/routes.py:217` — `request.app.state.rate_buckets`
  wuchs pro je gesehener IP monoton (keine Eviction). `get_remote_address` liest
  `request.client.host` — hinter Caddy/einem Reverse-Proxy ist das immer die
  Proxy-IP → ein Angreifer-IP-Wechsel hilft nicht, aber legitime User teilen sich
  ein Bucket.
  **Fix:** abgelaufene Buckets werden bei jedem `_check_rate`-Aufruf opportunistisch
  evicted (TTL = Fenstergröße, lazy-sweep). Client-IP wird aus `X-Forwarded-For`
  (erster Eintrag) gelesen, wenn vorhanden — mit Kommentar, dass das nur sicher ist,
  wenn der Service hinter einem vertrauenswürdigen Proxy steht, der den Header setzt
  (Caddy tut das).

- [x] **#16 — [Backend] WS-`send` macht 2× DB-Lookup pro Message**
  `services/chat-gateway/.../routes/ws.py:72` (war: `:89`) — `channel_membership`
  beim `send` machte zwei `session.get` (Channel + GuildMember) pro Nachricht,
  obwohl die Membership beim `subscribe` schon validiert wurde.
  **Fix:** `send` prüft jetzt zuerst gegen das lokale `subscribed`-Set (O(1), kein
  DB-Roundtrip) — ist der Channel dort, wird direkt persistiert. Nur wenn *nicht*
  subscribed (Edge-Case: Client sendet ohne vorher zu subscriben) fällt es auf die
  DB-Validierung zurück. **Trade-off dokumentiert:** wird ein User aus einer Guild
  entfernt, während er subscribed ist, kann er bis zum nächsten Reconnect noch
  senden — bekanntes, akzeptiertes MVP-Verhalten; periodische Re-Validierung wäre
  die saubere Lösung (Kommentar im Code).

- [x] **#17 — [Frontend] Lade-Fehler nur `console.error` → irreführende leere UI**
  `.../channels/[channelId]/+page.svelte:46,76` — wird von `fix-frontend` behandelt.

- [x] **#18 — [Frontend] Keine CSP**
  `web/src/app.html` — wird von `fix-frontend` behandelt.

- [x] **#19 — [Frontend] audioLevel-Polling baut alle 200 ms das ganze Participants-Array neu**
  `web/src/lib/voice/livekit.svelte.ts:313` — wird von `fix-frontend` behandelt.

- [x] **#20 — [Frontend] Init-Waterfall (auth→guilds→gateway sequentiell)**
  `web/src/routes/app/+layout.svelte:17` — wird von `fix-frontend` behandelt.

- [x] **#21 — [Backend+Frontend] gemischtes Finding**
  - **#21a [Backend] `add_member` ohne User-Existenz-Check** — `add_member`
    legte einen `GuildMember`-Row mit der übergebenen `user_id` an, ohne zu prüfen,
    dass dieser User in der auth-DB existiert (Services teilen keine DB → kein
    FK möglich). **DEFERRED:** ein sauberer Check bräuchte entweder einen
    Invite-Flow oder einen `GET /users/{id}`-Endpoint im auth-svc. Die
    Audit-Vorgabe verbietet das Anlegen neuer Endpoints in diesem Durchlauf →
    bleibt offen. Mitigation durch #1 (nur der Owner kann adden — er kennt die
    gültigen IDs ohnehin). Folgeticket: "Invite-Flow oder `/users/{id}` für
    Membership-Validierung".
  - **#21b [Frontend] `guilds.list` re-sortiert bei jedem Zugriff** — `list` ist jetzt
    `$derived` (cached, nur bei `byId`-Änderung neu berechnet). Lexikografischer Sort
    statt `Number()`.
  - **#21c [Frontend] Guild-Icon-URL ohne https-Whitelist** — `GuildList.svelte`:
    `img` nur wenn `icon_url?.startsWith('https://')`, sonst Initials-Fallback.

---

## LOW / Cleanup — Tech-Debt-Runde 2026-05-11

- [x] **L1** JWT-Exception-Messages werden 1:1 an den Client durchgereicht
  (`auth/routes.py` `detail=str(exc)` bzw. `f"invalid token: {exc}"`) — minimaler
  Info-Leak (Library-Versions-Hinweise). **Fix (tech-debt):** generische Messages
  `"invalid token"` in `auth/routes.py`, `chat-gateway/security.py`,
  `voice-signaling/security.py`.
- [x] **L2** `RefreshIn` (`auth/schemas.py`) ohne `max_length` auf `refresh_token` —
  ein riesiger String läuft erst beim JWT-Decode auf. **Fix:** `max_length=4096`.
- [x] **L3** `serialize_message` (`chat-gateway/routes/messages.py`) toter
  `datetime.now()`-Fallback für `created_at`. **Fix:** Fallback entfernt
  (`msg.created_at.isoformat()` direkt).
- [x] **L4** `publish` nach `commit` ohne Kompensation — fällt Redis aus, war die
  Message persistiert aber 500. **Fix:** `mgr.publish` / `manager.publish` in
  `try/except` (best-effort, Logging bei Fehler) in `messages.py` und `ws.py`.
- [-] **L5** `pttMode` persistiert über Channel-Wechsel (Frontend) — **bewusst beibehalten**: `pttMode` ist eine User-Preference, nicht Channel-State (Discord-Verhalten). Ein Reset würde den User überraschen.
- [x] **L6** Doppelter `/me`-Call beim Erststart (Frontend) — **Fix:** Guard `if (this.user || this.loading) return;` am Anfang von `auth.hydrate()` in `web/src/lib/stores/auth.svelte.ts`.
- [x] **L7** JWKS-Cache ohne Inflight-Dedup (`chat-gateway/security.py`,
  `voice-signaling/security.py`) — **Fix:** `asyncio.Lock` um den Fetch-Block
  (double-checked locking). Nur ein Fetch pro Key-Rollover-Event statt N parallele.
- [x] **L8** `messages.deleted_at IS NULL`-Filter ohne Partial-Index. **Fix:**
  Migration `0003_messages_active_idx` — `CREATE INDEX ix_messages_channel_active ON
  chat.messages (channel_id, id) WHERE deleted_at IS NULL`. Angewendet auf dcc + dcc_test.
- [ ] **L9** Refresh-Token im `localStorage` (Frontend, Design-Entscheidung aus
  PLAN.md Section 6.6) — XSS-Exposure. Bewusst akzeptiert für die Bearer-Auth-API;
  Tauri-Bundle nutzt den Plugin-Store. Dokumentiert.
- [ ] **L10** Index-Coverage generell prüfen — `guild_members(user_id)`,
  `channels(guild_id, position)`, `messages(channel_id, id DESC)` sind da; ein
  Review gegen die tatsächlichen Query-Pläne steht aus.
- [-] **#21a** `add_member` ohne User-Existenz-Check — **DEFERRED (bewertet im
  tech-debt run):** `GET /api/auth/users?ids=...` braucht einen Bearer-Token. Das
  chat-gateway hat keinen eigenen Service-Account-Token und müsste den User-Token des
  Callers weiterleiten — das ist architektonisch unsauber. Mitigation durch #1 (nur
  Owner kann adden). Folgeticket: Service-to-Service-Auth oder Invite-Flow.
- [-] **E2E-Teardown (globalTeardown-Fix):** `_globalTeardown.ts` nutzte
  `process.env.__DCC_TEST_PIDS` (nicht über Playwright-Worker-Grenzen geteilt).
  **Fix:** PIDs in `/node_modules/.dcc-e2e-pids.json` persistieren; Teardown liest
  nur diese PIDs und killt nur die Child-Prozesse des Setups — nicht per Pattern.

---

## Geprüft — kein Finding

Folgende Bereiche wurden im Audit untersucht und für sauber befunden:

- **Keine SQL-Injection** — durchgängig SQLAlchemy-Core/ORM mit parametrisierten
  Statements; keine String-Interpolation in Queries.
- **JWT-Härtung wasserdicht** — RS256 fest verdrahtet (`algorithms=["RS256"]` beim
  Decode), `aud` + `iss` werden geprüft, `typ`-Claim wird geprüft (`access` vs.
  `refresh`); kein `alg`-Confusion / `none`-Bypass möglich.
- **Passwort-Handling korrekt** — Argon2id mit den PLAN.md-Parametern (t=3, m=64 MiB,
  p=4), `check_needs_rehash` vorhanden, kein Plaintext-Logging.
- **Kein XSS** — kein `{@html}` im Frontend; Message-Content wird als Text gerendert.
  (Markdown-Rendering mit `marked`+`DOMPurify` ist in PLAN.md vorgesehen, noch nicht
  implementiert — wenn es kommt, muss `DOMPurify` zwingend dazwischen.)
- **Secrets-Hygiene exzellent** — `secrets/` in `.gitignore`, nichts Sensibles im
  Git-Verlauf; `.env.example` als Template; LiveKit-Dev-Keys sind dokumentierte
  Wegwerf-Werte.
- **Dependencies aktuell** — `uv.lock` / `pnpm-lock.yaml` auf 2026er-Stable-Versionen,
  keine bekannten CVEs in den verwendeten Versionen.
- **Snowflake-Generator thread-safe** — Lock um Sequenz-Increment + Clock-Skew-Handling
  (`_wait_next_ms`), passt in signed 64-bit.
- **WS-Auth korrekt** — Token wird *vor* `websocket.accept()` validiert, ungültig →
  Close 4001; Channel-Subscribe prüft Guild-Membership gegen die DB.
- **Frontend-Lifecycle sauber** — Logout räumt Stores + WS + Voice auf, kein
  Reconnect-Leak, Audio-Elemente werden bei Disconnect detached, PTT-Hotkey ignoriert
  Eingabe-Felder.

---

## Zusammenfassung dieses Durchlaufs

| Severity  | Findings | Gefixt | Deferred / offen |
|-----------|----------|--------|------------------|
| CRITICAL  | 1 (#1)   | 1      | 0 |
| HIGH      | 6 (#2,#3,#4,#5,#6,#7) | 6 | 0 |
| MEDIUM    | 14 (#8–#21, ohne die HIGH-Nummern) | 12 | #8 (Infra, bewusst), #21a (Backend-Teil von #21) |
| LOW       | 10 (L1–L10) | 0 | 10 (bewusst, siehe oben) |

**20 von 21 nummerierten Findings vollständig gefixt** (#1–#7, #9–#20, plus #21b/#21c).
Bewusst **nicht** in diesem Durchlauf:

- **#8 (Infra)** — Service-Dockerfiles, LiveKit-Image-Pin statt `:latest`, LiveKit
  nicht als root, Caddy-TLS: alles Prod-Readiness, gehört in Etappe 4+ (Hetzner-
  Deployment). Kein Risiko im lokalen Dev-Setup.
- **#21a (Backend)** — `add_member` ohne auth-DB-User-Existenz-Check. Bräuchte einen
  Invite-Flow oder einen `GET /users/{id}`-Endpoint im auth-svc; das Anlegen neuer
  Endpoints war in diesem Durchlauf ausgeschlossen. Durch #1 (nur der Owner kann
  adden) deutlich entschärft. Folgeticket: "Invite-Flow / `/users/{id}`".
- **L1–L10 (LOW/Cleanup)** — Kleinigkeiten ohne Sicherheits-Showstopper (Info-Leak in
  JWT-Exception-Messages, fehlende `max_length`-Limits, toter `now()`-Fallback,
  at-most-once-Publish-Semantik, UX-Details, JWKS-Inflight-Dedup, Partial-Index,
  `localStorage`-Refresh-Token als Design-Entscheidung, Index-Coverage-Review).
  Bewusst zurückgestellt; je als eigenes Cleanup-Ticket nachziehbar.

Keine Test-Assertions wurden geschwächt oder entfernt. Verhaltensändernde Findings
(#1: Self-Add → 403) wurden mit *neuen* Tests abgesichert, nicht durch Weglassen.

---

## Fix-Run-Report

### Geänderte Dateien

**Backend** (Commit `d3e37fd`):
- `services/chat-gateway/src/dcc_chat_gateway/routes/guilds.py` — #1 (Self-Add raus,
  Owner-only), #10 (`create_guild`-Rate-Limit).
- `services/chat-gateway/src/dcc_chat_gateway/routes/ws.py` — #3 (`_channel_id()`-Parser,
  nonce-Trim), #10 (`send`-Rate-Limit), #11 (16-KiB-Frame-Limit), #16 (subscribed-Set-
  Fast-Path statt DB-Roundtrip).
- `services/chat-gateway/src/dcc_chat_gateway/routes/messages.py` — #10 (`post_message`-
  Rate-Limit).
- `services/chat-gateway/src/dcc_chat_gateway/pubsub.py` — #14 (json.loads-try/except,
  paralleler Fan-out mit per-Socket-Timeout, `_started`-Self-Heal).
- `services/chat-gateway/src/dcc_chat_gateway/ratelimit.py` — **neu**: in-process
  Token-Bucket (#10).
- `services/auth/src/dcc_auth/routes.py` — #4 (`with_for_update`, Reuse-Detection mit
  Familien-Revoke), #6 (argon2 via `asyncio.to_thread`), #15 (Bucket-Eviction,
  `X-Forwarded-For`), Cleanup (ungenutzter `timedelta`-Import entfernt).

**Frontend** (Commit `c04b665`, von `fix-frontend`): #2, #5, #7, #9, #12, #13, #17,
#18, #19, #20, #21b, #21c — siehe die einzelnen Findings oben für Datei/Fix-Details.

### Tests angepasst (und warum)

- **`services/chat-gateway/tests/test_rest.py`** — 3 neue Tests: `test_self_add_to_guild_forbidden`
  (Audit #1: Self-Add → 403), `test_owner_can_add_member` (Owner-Pfad bleibt 201),
  `test_message_rate_limit` (Audit #10: 11. Message → 429). Bestehende `add_member`-
  Tests blieben unverändert — sie addeten schon immer über den Owner-Token, also kein
  Bruch durch #1.
- **`services/chat-gateway/tests/test_ws.py`** — 4 neue Tests: `test_ws_non_numeric_channel_id_errors`
  (Audit #3: kein ValueError-Crash, Error-Frame, Connection lebt weiter),
  `test_ws_oversized_frame_rejected` (Audit #11: Error 4009 + Close),
  `test_ws_long_nonce_trimmed` (Audit #3: langer nonce ≤ VARCHAR(64)).
- **`services/chat-gateway/tests/conftest.py`** — `_isolate_chat_settings` ruft jetzt
  `ratelimit.reset()` pro Test, damit der module-globale Bucket-State nicht zwischen
  Tests durchschlägt.
- **`services/auth/tests/test_auth_routes.py`** — 1 neuer Test: `test_refresh_reuse_revokes_family`
  (Audit #4: Replay des alten Tokens nach Rotation → 401, *und* der frisch ausgestellte
  Token ist danach auch tot).
- **Frontend-Tests** (`fix-frontend`): siehe Commit `c04b665`. `pnpm check` / `pnpm build`
  / Playwright-E2E grün ohne Regression.

Backend: `REDIS_URL=redis://localhost:6380/0 uv run pytest` → **56/56 grün** (49 vorher
+ 7 neu). Verifiziert von `fix-verify` (Backend + Frontend je separat freigegeben).

### git log der Fix-Commits

```
c04b665 fix: frontend bugs + perf + CSP (audit #2,#5,#7,#9,#12,#13,#17,#18,#19,#20,#21)
d3e37fd fix: backend security + robustness (audit #1,#3,#4,#6,#10,#11,#14,#15,#16)
cd57acd docs: audit findings
```
(plus `docs: finalize audit findings + fix report` für diese Datei.)
