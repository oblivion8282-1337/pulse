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
