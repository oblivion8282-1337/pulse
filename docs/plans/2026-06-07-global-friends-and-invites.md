# Globale Freunde + neues Einladungs-Modell

**Status:** Entwurf / geplant — noch nicht begonnen
**Datum:** 2026-06-07
**Betrifft:** Identitäts-/Social-Schicht (Cert-Modell), chat-gateway, web. Ergänzt `IDENTITY_CONCEPT.md`.

## Ziel

Freundeslisten/DMs werden eine **globale Cloud-Schicht** (eine Liste überall, statt heute eine pro Instanz). Community-Einladungen laufen über genau zwei Wege: **privat per Freund-Einladung** und **öffentlich per fester Community-Adresse**. Wegwerf-Invite-Links entfallen.

## Ausgangslage (Ist-Zustand, verifiziert 2026-06-07)

- **Freunde sind heute pro-Instanz**, nicht cloud-zentral: `friendships` liegt im chat-gateway-Schema → jede Instanz (Cloud + jeder Self-Host) hat ihre eigene Tabelle. `friends.py`/`dms.py` sind **ohne** `_require_cloud` registriert (`routes/__init__.py`), `ws_ready.py` seedet Freunde bedingungslos aus der **aktiven** Connection. Beim Server-Wechsel überschreibt `friends.seedAll()` → man sieht die Freunde des aktiven Servers.
- **Einladungen heute** = Invite-Code pro Community (`routes/invites.py`), geteilt als Link (`lib/guilds/inviteLink.ts`, `?host=` für Self-Host), angenommen über `/invite/[code]` bzw. `AddServerDialog` (Server adden + join_code + invite). Freund-Varianten (`InviteFriendPicker`, `InviteToServerSubmenu`) posten denselben Link in den DM.
- **Self-Host hat zwei Schlösser:** Instanz-`join_mode` (open/invite_only/closed, `AdminJoinControl`/`admin_join_invites.py`) **und** Community-Mitgliedschaft.
- **Privacy:** Self-Host kennt User nur über `pairwise_sub` (pro Self-Host verschieden); die Cloud trackt heute **keine** Self-Host-Mitgliedschaften (nur welche Instanzen existieren + Owner).
- **WS-Dispatch:** Nur die **aktive** Connection dispatcht (`gateway-connection._handle`: `if (this.serverId !== activeServer.serverId) return;`).

## Entscheidungen (festgezurrt)

1. **Freunde + DMs = global (Cloud).** Eine Liste, überall identisch.
2. **Self-Host-Friend-/DM-System wird ersatzlos gestrichen.**
3. **Privat = Freund-Einladung.** Erst befreundet → Community-Admin (CREATE_INVITES) klickt „Leute einladen" → User auswählen → die bekommen eine Nachricht/Karte mit „Beitreten" → ein Klick, Auto-Join. Self-Host-Ziele laufen über **B-lite**: die Cloud vermittelt und **löscht den Invite-Datensatz beim Annehmen** (kein dauerhaftes Mitglieder-Register).
4. **Öffentlich = feste Community-Adresse.** Plus → „Community beitreten" → Adresse eingeben. Adresse ist **pro Community fix/unveränderlich**, in den Community-Settings sicht-/kopierbar, **funktioniert nur, wenn die Community auf öffentlich steht**. Öffentliche Beitritte gehen **direkt** Client→Server — die Cloud sieht sie nicht.
5. **Öffentliche Community = eigene Erlaubnis.** Wer einer öffentlichen Community beitritt, wird automatisch **community-scoped Instanz-Mitglied**, **unabhängig vom globalen `join_mode`**.
6. Community-Erstellung bleibt durch den Cloud-Admin-Toggle (`allow_guild_creation`) gegated (existiert bereits).
7. **Instanz-Beitritts-Codes entfallen.** Das alte Instanz-Schloss (`join_mode` open/invite_only/closed + Join-Codes, `AdminJoinControl`/`JoinInviteSection`/`admin_join_invites.py`) gatet nichts mehr — Zugang läuft pro Community (Freund-Einladung bzw. öffentliche Adresse). Es bleibt **ein einziger** Instanz-Toggle **„Server gesperrt — keine neuen Beitritte"**, der **alles übersticht, auch öffentliche Communities** (Owner-Not-Aus). Kein Code-Management mehr. (Getrennt davon: die auth-svc `registration_mode`/`registration_invites` für *lokale Passwort-Accounts* bleiben unberührt.)

## Architektur-Konsequenzen & Detailfragen

- **pairwise_sub-Folge:** Globale Freundschaften werden **cloud-nativ** geschlossen (über Cloud-Handle), **nicht** aus einer Self-Host-Begegnung heraus — der Self-Host kennt die Cloud-Identität bewusst nicht. (Optionaler späterer Opt-in-„Identität freigeben"-Flow — v1 **out of scope**.)
- **DM-Folge:** Da Self-Host-DMs wegfallen, können zwei Leute, die sich **nur** über einen Self-Host kennen, sich **nicht** per DM schreiben (keine global auflösbare Identität). Self-Hosts sind Community-Räume, kein 1:1-Messaging. Der „DM senden"-Eintrag im Self-Host-Member-Kontext entfällt entsprechend.
- **Presence-Split:** Globale **Freund**-Presence kommt von der Cloud; **Guild**-Presence (wer ist in diesem Server online) bleibt server-lokal aus dem aktiven `ready`-Frame.
- **WS-Dispatch-Ausnahme:** Die **Cloud**-Connection muss globale Social-Ops (Freunde/DMs/Friend-Requests/Freund-Presence) **auch dann** dispatchen, wenn der aktive Server ein Self-Host ist. Heißt: `_handle`-Guard bekommt eine Ausnahme für eine definierte Op-Allowlist auf der Cloud-Connection.
- **Adress-Format + Namespace:** Cloud z. B. `howispulse.com/c/<handle>`, Self-Host `pulse.firma.de/c/<handle>`. Braucht Eindeutigkeits-/Vergabe-Regel (Cloud: global eindeutig; Self-Host: pro Host eindeutig) + Policy gegen Squatting/anstößige Handles.
- **Logged-out + öffentliche Adresse →** Registrieren-dann-Beitreten-Fluss.

## Stufenplan

### Stufe 1 — Freunde/DMs global (Cloud-only)

**Detaillierter Mechanismus (verifiziert 2026-06-07):**
- **Connections bleiben offen** (`active-server.svelte.ts:66`, nur `closeAll()` bei Sign-Out) → Cloud ist Dauer-online. **Init muss die Cloud-Connection garantiert verbinden**, auch wenn der restaurierte aktive Server ein Self-Host ist.
- **Dispatch-Regel** (`gateway-connection._handle`, heute `if (this.serverId !== activeServer.serverId) return;`): dispatchen wenn **aktiv** ODER (**Cloud** UND `backgroundEligible(evt)`).
  - `backgroundEligible` = Op ∈ **PURE_SOCIAL** (`friend_request_received/accepted/declined/cancelled`, `friend_removed`, `user_blocked`, `user_unblocked`, `dm_bump`) ∪ **PRESENCE** (`presence_update`, `presence_status_changed`) ∪ (**MESSAGE-Familie** `message`/`message_update`/`message_delete`/`reaction_add`/`reaction_remove`/`typing`/`message_ack`/`mention_added` **nur wenn `evt.channel_id` ein DM-Channel** ist, lookup in `directMessages`).
  - Guild-/Voice-/Stream-/Watch-Ops bleiben **aktiv-only**.
- **`ready`-Split:** Der Handler wendet den **Server-Teil** (guilds/roles/voice/stream/watch/guild-presence) nur an, wenn die dispatchende Connection **aktiv** ist; den **Social-Teil** (friends/dm_channels/friend_requests/blocks) nur, wenn sie die **Cloud** ist. (Flag „isActive/isCloud" in den ready-Handler reichen.) Cloud-aktiv = beides; Self-Host-aktiv = Server von Self-Host + Social aus Cloud-Background-ready.
- **`_dispatchingConn`-Race:** Dispatch ist synchron → `_dispatchingConn = this` pro Dispatch ist sicher; Implementierer muss prüfen, dass kein async Social-Handler nach `await` auf `_dispatchingConn` zugreift.
- **DM-Outbound an die Cloud:** Der `gateway`-Proxy zeigt auf den aktiven Server. DM-Senden/-Subscribe braucht einen **`cloudGateway`**-Accessor (auf die Cloud-Connection gepinnt). Friends/DM-UI nutzt diesen.
- **Presence merge:** Self-Host-User-IDs (pairwise) und Cloud-IDs sind disjunkt → Freund-Presence (Cloud) + Guild-Presence (aktiv) koexistieren konfliktfrei im Store.

**Arbeiten:**
- **Frontend:** Init-Cloud-Connect; `_handle`-Regel + `backgroundEligible`; `ready`-Split; `cloudGateway`-Accessor + Friends/DM-UI (`routes/app/friends`, `routes/app/@me`, `DMChannelList`) darauf umstellen; Social-Stores nur aus Cloud-ready seeden.
- **Backend:** Self-Host fährt kein Friend-/DM-System mehr — `friends.py`/`dms.py`/`blocks.py` + Social-Teil von `ws_ready.py` per `pulse_instance_mode != 'cloud'`-Guard deaktivieren; Self-Host-`ready` schickt keine Social-Payloads.
- **Migration:** Bestehende per-Instanz-`friendships`/DMs auf Self-Hosts verwerfen (vermutlich nur Testdaten).

### Stufe 2 — Freund-Einladung als Objekt + B-lite-Broker
- **Cloud-Invite-Objekt** (neue Tabelle, Cloud): `{inviter_cloud_id, invitee_cloud_id, target_host, target_instance_id, target_guild_id, token, created_at}`; **gelöscht bei Accept**, TTL-Ablauf für nicht angenommene.
- **Token-Hoheit:** Den **Community**-Invite-Token stellt der hostende Server aus (Cloud-Community → Cloud; Self-Host-Community → Self-Host). Die Cloud trägt nur `{host, token}` + Zustellung.
- **Accept-Auto-Join:** Client führt automatisch aus — Self-Host: Server adden → Cert-Login → **community-scoped Instanz-Beitritt** (Token gewährt Membership) → Community-Beitritt; Cloud: direkt Community-Beitritt. Erfolgreicher Accept löscht den Broker-Datensatz (B-lite).
- **Backend Self-Host:** Community-Invite-Token muss instanz-scoped Membership gewähren (analog heutigem `join_code`, aber an die Community gebunden).

#### Stufe 2 — Detaildesign (Backend implementiert 2026-06-07)

**Umgesetzt: das Backend des Brokers + der Self-Host-Instanz-Grant. Kein Frontend (Stufe 3), keine Frontend-API-Funktionen.**

**1. Cloud-Invite-Broker (cloud-only).**
- Tabelle `chat.community_invites` (Model `models/community_invites.py::CommunityInvite`, Migration `0033_community_invites`): `id` (Snowflake), `inviter_id`, `invitee_id`, `target_host`, `target_instance_id?`, `target_guild_id`, `target_guild_name` (Preview-Snapshot), `code` (host-gemünzter `GuildInvite`-Code), `created_at`, `expires_at?`. Liegt im **chat**-Schema, wird aber **nur auf der Cloud** beschrieben/gelesen (Router trägt `CloudOnly` — auf Self-Host 404 auf allen drei Routen; Tabelle dort harmlose Dead-Weight wie `friendships`/`dm_channels`).
- Routen (`routes/community_invites.py`, alle hinter `CloudOnly`):
  - `POST /community-invites` `{invitee_id, target_host, target_instance_id?, target_guild_id, target_guild_name, code, expires_in_seconds?}` → **Friend-Gate** (Produktmodell „erst befreundet, DANN einladen") → Zeile anlegen + WS-Event `community_invite_received` **nur an den invitee** (über `publish_friend_event`/`publish_user_event` auf `user:events`, gleicher Pfad wie `friend_*`). Per-inviter-Rate-Limit (`ratelimit.py::"community_invite"` = 30/h). **Dedupe:** gleiche `(inviter, invitee, target_guild)` kollabiert auf **eine** Zeile (alter Code wird vorm Insert gelöscht — neuester Code/Expiry gewinnt), damit ein gespammter „Einladen"-Button keine Kartenflut macht. Selbst-Einladung → 400.
    - **Friend-Gate (Reihenfolge):** (1) **Block** in **irgendeiner** Richtung → 403 `block_in_place` (Block gewinnt immer, auch über eine veraltete Freundschaft hinweg — `block_exists_either_way`); (2) keine **bestätigte** Freundschaft → 403 `not_friends` (`friendship_exists` gegen die cloud-globale `friendships`-Tabelle, **dieselbe Quelle** wie `friends`/`ws_ready`). Beides aus `friend_helpers.py` wiederverwendet (kein Eigenbau). Konsequenz: nur ein sozialer Kontakt kann überhaupt eine Karte beim invitee landen (schließt Restrisiko #3 der ersten Iteration).
  - `GET /community-invites` → pending Invites des **current user** (= invitee), newest-first, ≤200; **lazy TTL-Sweep** der eigenen abgelaufenen Zeilen vorab (kein Background-Task — Zeilen sind kurzlebig + werden bei Accept gelöscht; globaler Sweeper ist v1-Overkill).
  - `DELETE /community-invites/{id}` → **B-lite: Zeile löschen** (kein „consumed"-Flag, kein dauerhaftes Mitglieder-Register). Autorisiert für **invitee ODER inviter** (guarded `DELETE … RETURNING`); Fremde bekommen 404 (kein Existenz-Leak). WS-Event `community_invite_removed` an den invitee (Multi-Tab-Sync — deckt „in Tab A angenommen" **und** „inviter rescinded" ab).
- **Events:** `shared/events/community.py` (`CommunityInviteReceivedEvent` mit free-form `data`; `CommunityInviteRemovedEvent` mit `{invite_id}`), in `EVENT_REGISTRY` registriert.

**2. Self-Host-Instanz-Grant (der sicherheitskritische Teil).**
- **Wer ein gültiger, aktiver `GuildInvite`-Code ist die Erlaubnis, der Instanz beizutreten** — community-scoped, **ohne** separaten `join_code`. Additiv eingehängt; das bestehende `join_code`/`join_mode`-System bleibt unverändert (Abbau erst Stufe 5).
- Mechanik: `VerifyRequest` (cert-login) bekommt ein **optionales** Feld `community_grant_code`. `_enforce_join_gate` prüft im `invite_only`-First-Contact: `membership.py::community_invite_grants_access(code)` → True nur wenn der `GuildInvite` existiert, **nicht** revoked, **nicht** abgelaufen, **nicht** use-erschöpft. Trifft das zu → `add_member(joined_via="community_invite")` (Instanz-Membership). Sonst Fallback auf den Legacy-`join_code`-Pfad.
- **Non-consuming:** Der Grant verbraucht **keine** `GuildInvite`-Nutzung. Die eine Nutzung wird **später** in `invites.py::accept_invite` beim echten Community-Beitritt verbraucht. Begründung: Instanz-Membership ist ein gröberes Schloss als Community-Membership, und der 5-Min-Session-Token wird oft re-auth't — ein use-Verbrauch pro cert-login würde einen `max_uses=1`-Invite beim ersten Re-Auth sprengen. (Test deckt das ab.)
- **Re-Auth-Pfad:** Wer einmal via Community-Invite drin ist, ist `instance_members`-Mitglied → künftige cert-logins gehen über den „existing member"-Zweig **ohne** Code (kritisch: Invite darf nicht bei jedem Token-Refresh neu verlangt werden).
- **Default-Entscheidung `closed`:** Ein Community-Invite **übersticht `closed` NICHT** (Owner-Not-Aus). Spiegelt den künftigen einzelnen „Server gesperrt"-Toggle aus Entscheidung 7/Stufe 5. In `open`-Mode kommt sowieso jeder rein.

**3. Datenfluss + Sicherheitsmodell des Self-Host-Grants (kurz).**
Der inviter ist über die **Cloud** authentifiziert; den Berechtigungs-Beweis liefert der **host-gemünzte `code`** (ein lebender `GuildInvite` auf dem Zielserver). Die Cloud **validiert den Code nicht** (sie kann die Invite-Tabelle eines Self-Hosts gar nicht erreichen) — sie **relayed** nur `{host, code}` + Zustellung an den invitee. Der Code gewährt **für sich genommen nichts**: Zugang entsteht erst, wenn der **Host** den lebenden Invite zur Accept-Zeit nachprüft — beim cert-login (`community_grant_code` → `community_invite_grants_access`, live-Read) **und** beim Community-Beitritt (`accept_invite`, atomarer guarded UPDATE, verbraucht die Nutzung). Ein abgelaufener/revoked/erschöpfter/unbekannter Code gewährt **nichts** (live-Read → revoke/erschöpfung wirken sofort beim nächsten cert-login; replay-sicher, weil kein State über die Zeit getragen wird).

**Getroffene Annahmen / Default-Entscheidungen (vom User zu reviewen):**
- a) **Grant non-consuming** (s.o.) — bewusst entkoppelt von der Community-`use`-Zählung.
- b) **Community-Invite umgeht `closed` nicht** — konservativster Default; falls Community-Invites auch `closed` durchbrechen sollen, wäre das eine explizite Änderung.
- c) **Dedupe pro `(inviter, invitee, guild)`** (eine Karte) statt N Karten.
- d) Rate-Limit **30/h pro inviter** (in-process, single-pod-Caveat wie der Rest von `ratelimit.py`).
- e) Broker-Zeile trägt `target_guild_name` als **Preview-Snapshot** (nie für Zugangskontrolle benutzt); bei Umbenennung der Community veraltet er bis zum nächsten Invite.
- f) **TTL lazy** (Sweep beim GET des invitee) statt Background-Task.

### Stufe 3 — UX „Leute einladen" + Annehmen-Karte
- `InviteDialog`/`InviteFriendPicker` → strukturierter „Leute einladen"-Flow (nur Freunde, Multi-Select), erzeugt Freund-Invites statt Roh-Links.
- Empfänger: strukturierte „Beitreten"-Karte (Notification/DM) mit Ein-Klick-Auto-Join.
- Entfernen/umbauen: Link-Copy-UI im `InviteDialog`, `/invite/[code]/+page.svelte`, `InviteToServerSubmenu` (link-in-DM), `lib/guilds/inviteLink.ts` (`?host=`).

### Stufe 4 — Öffentliche Community-Adresse
- Pro Community ein **stabiler Handle** (vanity), in den Community-Settings sicht-/kopierbar, Gate = `public`-Flag (Toggle in Settings, `MANAGE_GUILD`).
- „Plus → Community beitreten → Adresse" (Verallgemeinerung von `AddServerDialog`): Adresse → `(host, handle)`; Self-Host = Server adden (falls neu) + Cert-Login + **öffentlicher** Community-Join.
- **Backend:** handle-basierter Public-Join-Endpoint pro Community: bei `public=true` nimmt er jeden (Cloud-User bzw. nach Registrierung) als **community-scoped** Member auf und gewährt auf Self-Host die Instanz-Mitgliedschaft mit — **`join_mode`-unabhängig** (Entscheidung 5).
- Logged-out → Registrieren-dann-Beitreten. Public→Private-Toggle deaktiviert die Adresse, lässt sie aber stabil (bei Reaktivierung gleiche Adresse).

#### Stufe 4 — Detaildesign (Backend implementiert 2026-06-08)

**Umgesetzt: das Backend der öffentlichen Community-Adresse. Kein Frontend (kommt separat).**

**1. Guild-Felder + Migration 0034.**
- `Guild.is_public: bool` (NOT NULL, default `false`) + `Guild.handle: str | None` (`String(32)`, nullable) in `models/guilds.py`. Migration `0034_public_community_handle` (single-head, Revises 0033, reversibel) fügt beide Spalten an plus einen **partiellen Unique-Index** `uq_guilds_handle` auf `handle` (`WHERE handle IS NOT NULL` — die vielen handle-losen Communities kollidieren nicht auf NULL). Kein Daten-Migrations-Backfill nötig: jede Bestands-Community startet privat mit NULL-Handle (genau der Default). Der partielle Index ist auch im Model (`__table_args__`, `postgresql_where` + `sqlite_where`), damit das `create_all` der Tests die Eindeutigkeit ebenfalls erzwingt.
- **Handle-Format zentral** in `community_handle.py::validate_handle` (single source of truth, von Schema + Tests importiert): Slug `^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$` (3–32, lowercase alnum + Bindestriche, nicht am Rand) **plus eine Reserved-Wort-Liste** (`new`/`admin`/`api`/`everyone`/… — verhindert Kollisionen mit dem `/c/<handle>`-Namespace + Keyword-Shadowing). Validierung **mangelt nicht** (kein Silent-Lowercasing): ein Großbuchstabe ist 422, nicht stille Umschreibung — der Client soll wissen, welche Adresse er bekommt.

**2. Settings-Endpoint (`MANAGE_GUILD`).**
- Erweitert `PATCH /guilds/{id}` (`routes/guilds.py`) um `handle` + `is_public` (beide optional → Ein-Feld-Patch möglich). Neuer `GET /guilds/{id}/settings` → `{id, name, handle, is_public, address_path}` (`address_path` = host-relatives `/c/<handle>` bzw. `None`; den Host hängt der Client an, das Backend kennt seinen öffentlichen FQDN hinter Caddy nicht zuverlässig). Beide hinter `MANAGE_GUILD`.
- Regeln: Handle wird im Schema **format**-validiert (422 bei malformed), **per-Instanz-eindeutig** per DB-Index → **409** bei Kollision (kein Pre-Query/TOCTOU — der Insert/Update läuft, `IntegrityError` → Rollback → 409). `is_public=true` verlangt einen Handle (entweder schon gesetzt oder im selben Patch mitgesetzt → der Code berechnet den **resultierenden** Handle aus dem Patch) → sonst **400**. `handle=""` löscht den Handle, aber **nur wenn die Community danach nicht public** ist (eine public Community muss eine Adresse behalten) → sonst 400.

**3. Öffentlicher Beitritt (`routes/public_community.py`, NICHT `CloudOnly` — bedient Cloud + Self-Host).**
- `GET /c/{handle}` → `{guild, member_count, is_public}` — **nur** wenn `is_public`, sonst **404** (identische opake Antwort wie „unbekannter Handle"; kein Member-Count-/Existenz-Leak privater Communities).
- `POST /c/{handle}/join` → Public-only (sonst 404). **Ban-Check zuerst** (403, vor dem Idempotenz-Pfad, mit Re-Check **innerhalb** der TX gegen die Concurrent-Ban-Race). `add_member` (community-scoped Guild-Membership) + auf **Self-Host** zusätzlich **community-scoped Instanz-Membership** (`InstanceMember`, `joined_via="public_community"`) — **`join_mode`-unabhängig** (Entscheidung 5). Idempotent (schon Mitglied → no-op-Erfolg). WS-`guild_member_added` nur beim echten Insert.
- **Self-Host cert-login-Gate:** `VerifyRequest` bekommt optionales `public_join_handle` (additiv zu `join_code`/`community_grant_code`). In `_enforce_join_gate` wird es **vor** dem `join_mode`-Branch (nach owner + existing-member) geprüft via `membership.py::public_community_grants_access(handle)` → True nur wenn der Handle eine **aktuell-public** Community benennt. **Bewusst `join_mode`-unabhängig** — anders als `community_grant_code` (das `closed` NICHT durchbricht) **übersticht ein public-Handle auch `closed`**, weil Entscheidung 5 die öffentliche Community zur eigenen Erlaubnis macht. Der Owner-Not-Aus aus Stufe 5 („Server gesperrt") wird das später überstechen — er existiert heute nicht, also gatet hier **nur** das `is_public`-Flag. Non-consuming, kein Code. Re-Auth-sicher: einmal beigetreten → `InstanceMember` → künftige cert-logins gehen über den existing-member-Zweig ohne Handle.

**4. Zugangskontroll-Modell / Sicherheit (kurz).**
Die öffentliche Community ist ihre **eigene** Zugangserlaubnis: ein Beitritt fügt die Guild-Membership **und** (Self-Host) die Instanz-Membership in einem Rutsch hinzu, ohne separates Schloss (kein Invite, kein Code), `join_mode`-unabhängig. Private Communities **leaken nicht**: Preview **und** Join geben für eine nicht-public/unbekannte Community dieselbe opake 404 — der Handle-Namespace lässt sich nicht abklopfen, um Existenz oder Member-Count einer privaten Community zu erfahren. Gebannte User können nicht beitreten (403, vor allem anderen). Handle-Eindeutigkeit ist **race-sicher** über den DB-Unique-Index (kein Check-then-Write). `public_community_grants_access` liest **Live-State** → eine zurück-auf-privat geschaltete Community gewährt sofort beim nächsten cert-login nichts mehr (replay-sicher, kein Zeit-getragener State).

**Getroffene Annahmen / Default-Entscheidungen (vom User zu reviewen):**
- a) **Public übersticht `closed`** (im cert-login-Gate UND im `/c/.../join`-Pfad), weil Entscheidung 5 `join_mode`-unabhängig ist. Der einzige künftige Override ist der „Server gesperrt"-Not-Aus aus Stufe 5 (existiert noch nicht). Konservativere Alternative wäre, public nicht über `closed` zu lassen — bewusst NICHT gewählt (widerspräche Entscheidung 5).
- b) **`GET /c/{handle}` + `GET /guilds/{id}/settings` brauchen Auth** (kein anonymer Preview). Logged-out-Flow (Entscheidung „Registrieren-dann-Beitreten") wird im Frontend gelöst, nicht durch einen anonymen Backend-Endpoint — hält die Angriffsfläche klein.
- c) **`GET /guilds/{id}/settings` ist `MANAGE_GUILD`-gated** (nicht für jedes Mitglied) — die Adress-Verwaltung ist Server-Management; ein normales Mitglied muss von innen nicht enumerieren können, ob die Community public adressierbar ist.
- d) **Handle wird nicht normalisiert** (kein Silent-Lowercasing) — malformed = 422, klare Client-Rückmeldung statt stiller Umschreibung.
- e) **Reserved-Wort-Liste** als dünner Anti-Squatting-/Anti-Confusion-Guard, **keine** Voll-Moderation (Handle-Moderation bleibt offene Frage im Plan).
- f) **`address_path` host-relativ** (`/c/<handle>`) — das Backend kennt seinen öffentlichen FQDN hinter Caddy/nginx nicht zuverlässig; der Client setzt den verbundenen Host davor.
- g) **Idempotenter Join füllt auf Self-Host eine fehlende `InstanceMember`-Zeile nach** (Edge: Guild-Member ohne Instanz-Zeile, z.B. Altdaten) — defensiv, schadet nie.

### Stufe 5 — Aufräumen & Konsolidierung
- **Instanz-Beitritts-Codes entfernen** (Entscheidung 7): `AdminJoinControl`/`JoinInviteSection` aus der Admin-UI raus, `admin_join_invites.py` + das `join_mode`-3-Wege-Modell + Code-Tabelle abbauen. Den „Server-Einladungscode"-Schritt im (alten) `AddServerDialog` entfernen.
- **Ersatz:** ein einzelner Instanz-Toggle **„Server gesperrt"** (boolean) — wenn an, lehnt der Server **jeden** neuen Beitritt ab (Freund-Invite-Accept **und** öffentliche Adresse), unabhängig vom Community-Public-Flag. Gate sitzt im Beitritts-Pfad (Community-Join + community-scoped Instanz-Membership).
- auth-svc `registration_mode`/`registration_invites` (lokale Accounts) **unangetastet** lassen — andere Ebene.
- `IDENTITY_CONCEPT.md` + CLAUDE.md aktualisieren.

## Risiken / offene Entscheidungen

- **Handle-Namespace & Moderation** (Squatting, anstößige Namen) — Vergabe-Policy festlegen.
- **WS-Cloud-Background-Dispatch** ist eine echte Änderung am bewusst einfachen „nur aktive Connection dispatcht"-Modell — sorgfältig testen (kein Doppel-Dispatch von Guild-Ops).
- **Migration**: sicherstellen, dass kein produktiver Self-Host echte Freundschaften verliert (Stand: vermutlich nur Testdaten).
- **pairwise-Reveal** (Self-Host-Bekanntschaft → globale Freundschaft) bewusst v1 ausgelassen — später entscheiden.
- Reihenfolge: Stufe 1 ist Voraussetzung; 2+3 gehören zusammen; 4 ist unabhängig danach; 5 zum Schluss.
