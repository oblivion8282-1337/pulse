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
  `True` → ein späterer `start()` machte nichts (Self-Heal unmöglich; bereits in
  `NIGHT_RUN_REPORT.md` notiert). (c) `await ws.send_json(envelope)` seriell pro
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

## LOW / Cleanup — bewusst NICHT in diesem Durchlauf

Alle als offen (`[ ]`) markiert, niedrige Priorität, kein Sicherheits-Showstopper:

- [ ] **L1** JWT-Exception-Messages werden 1:1 an den Client durchgereicht
  (`auth/routes.py` `detail=str(exc)` bzw. `f"invalid token: {exc}"`) — minimaler
  Info-Leak (Library-Versions-Hinweise). Cleanup: generische Messages, Details ins Log.
- [ ] **L2** `RefreshIn` (`auth/schemas.py`) ohne `max_length` auf `refresh_token` —
  ein riesiger String läuft erst beim JWT-Decode auf; harmlos, aber sauberer mit Limit.
- [ ] **L3** `serialize_message` (`chat-gateway/routes/messages.py`) hat einen toten
  `datetime.now()`-Fallback für `created_at` — `Message.created_at` hat ein
  Server-Default, kann nach `refresh()` nie `None` sein. Cleanup: Fallback entfernen.
- [ ] **L4** `publish` nach `commit` ohne Kompensation — fällt Redis zwischen Commit
  und Publish aus, ist die Message persistiert, aber andere WS-Subscriber sehen sie
  nicht (sie holen sie beim nächsten History-Load). Bewusste „at-most-once"-Semantik
  (PLAN.md: kein exactly-once anstreben). Dokumentiert.
- [ ] **L5** `pttMode` persistiert über Channel-Wechsel (Frontend) — UX-Detail.
- [ ] **L6** Doppelter `/me`-Call beim Erststart (Frontend) — kleiner Init-Overhead.
- [ ] **L7** JWKS-Cache ohne Inflight-Dedup (`chat-gateway/security.py`,
  `voice-signaling/security.py`) — bei kaltem Cache + N parallelen Requests N
  JWKS-Fetches statt 1. Cleanup: single-flight um den Fetch.
- [ ] **L8** `messages.deleted_at IS NULL`-Filter ohne Partial-Index — bei vielen
  gelöschten Messages langsamer Scan. Cleanup: `CREATE INDEX ... WHERE deleted_at IS NULL`.
- [ ] **L9** Refresh-Token im `localStorage` (Frontend, Design-Entscheidung aus
  PLAN.md Section 6.6) — XSS-Exposure. Bewusst akzeptiert für die Bearer-Auth-API;
  Tauri-Bundle nutzt den Plugin-Store. Dokumentiert.
- [ ] **L10** Index-Coverage generell prüfen — `guild_members(user_id)`,
  `channels(guild_id, position)`, `messages(channel_id, id DESC)` sind da; ein
  Review gegen die tatsächlichen Query-Pläne steht aus.

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

## Fix-Durchlauf — Backend-Commits

- `docs: audit findings` — diese Datei.
- `fix: backend security + robustness (audit #1,#3,#4,#6,#10,#11,#14,#15,#16)`

## Fix-Durchlauf — Frontend-Commits

- `fix: frontend bugs + perf + CSP (audit #2,#5,#7,#9,#12,#13,#17,#18,#19,#20,#21)`
