# Bughunt Runde 2 — Freunde, Blocks, Privatsphaere und Moderation

Durchsucht wurden der Freundschafts- und Blockpfad des chat-gateway (`routes/friends.py`,
`routes/blocks.py`, `friend_helpers.py`, `pubsub_friend_cache.py`), der Meldeweg samt
Moderations-Warteschlange (`routes/reports.py`, `routes/mod_queue.py`,
`routes/mod_queue_scope.py`, `models/moderation.py`), der Bannpfad (`routes/bans.py`,
`models/guilds.py`), der Aufraeumweg bei Kontoloeschung (`user_purge.py`, auth-svc
`routes_account.py`, `routes/internal.py`) sowie die zugehoerigen Oberflaechenstuecke
(`MessageItem.svelte`, `ReportMessageDialog.svelte`, `ws/handlers/chat.ts`).

Vier Befunde haben die Gegenpruefung ueberstanden; alle vier sind am Code belegt und
wurden fuer diesen Bericht Zeile fuer Zeile nachgelesen. Der schwerste ist die stille
Aufhebung fremder Baenne bei der Kontoloeschung des bannenden Moderators: eine
Moderationsentscheidung gegen einen Dritten faellt spurlos weg, ohne Pruefspur und ohne
dass irgendjemand sie aufgehoben haette.

Zur Einstufung: zwei Befunde waren urspruenglich als "hoch" gemeldet. Die Gegengutachter
haben in beiden Faellen die Wirkungsbeschreibung korrigiert (kein Rechteloch, kein
Gewinn fuer einen Angreifer), der Sachverhalt selbst blieb stehen. Die Schweren unten
sind die korrigierten.

## Befunde

### Mittel — Kontoloeschung hebt stillschweigend alle vom Nutzer ausgesprochenen Baenne gegen andere, weiterhin aktive Nutzer auf

- **Stelle:** `services/chat-gateway/src/dcc_chat_gateway/user_purge.py:184-188`
- **Was falsch ist:** Schritt 7 von `_purge_db` loescht Bannzeilen ueber
  `sa_delete(GuildBan).where(or_(GuildBan.user_id == user_id, GuildBan.banned_by_id == user_id))`.
  Der zweite Zweig trifft den Fall, dass der geloeschte Nutzer der *bannende* Moderator
  war — und loescht dann die ganze Zeile, nicht nur die Zuschreibung. Die Sperrwirkung
  haengt aber ausschliesslich an der Existenz der Zeile: `routes/bans.py:53-57`
  (`is_user_banned`) macht nichts anderes als `session.get(GuildBan, (guild_id, user_id))`,
  und der Modell-Docstring `models/guilds.py:185-188` sagt dasselbe. An diesem einen
  Riegel haengen alle Beitrittswege (`routes/invites.py:260`, `:307`,
  `routes/member_invites.py:244`, `routes/guilds.py:413`, `:421`,
  `routes/public_community.py:135`, `:187`). Faellt die Zeile, faellt der Bann.
  Der Kommentar `user_purge.py:181-183` benennt die Loeschung ("bans they issued also
  drop") und begruendet sie mit dem fehlenden "banned by deleted user"-Tombstone — diese
  Begruendung deckt aber nur die Zuschreibung, nicht die Aufhebung einer Massnahme gegen
  einen Dritten. Ein Nullen des Feldes waere ohne Migration ohnehin nicht moeglich:
  `banned_by_id` ist `nullable=False` (`models/guilds.py:203`).
- **Wie man es ausloest:** Ein Nicht-Eigentuemer mit `BAN_MEMBERS` (in der ausgelieferten
  Rollenvorlage "Moderation" enthalten, `web/src/lib/components/settings/roles/vorlagen.ts:34`)
  bannt Nutzer B; `banned_by_id` wird auf ihn gesetzt (`routes/bans.py:216`/`:222`).
  Spaeter loescht der Moderator sein eigenes Konto ueber `DELETE /me`
  (`services/auth/src/dcc_auth/routes_account.py:91`, ruft in Zeile 170
  `POST /internal/users/{id}/purge` → `purge_user`). Damit verschwindet die Bannzeile fuer
  B. Der Fall greift nur bei Nicht-Eigentuemern; gehoert die Community dem Loeschenden,
  wird sie in Schritt 1 (`user_purge.py:140-142`) ohnehin komplett geloescht.
- **Was es kostet:** B ist entbannt und kann ueber jede Einladung oder eine oeffentliche
  Community zurueck. Es entsteht kein `ModAuditLog`-Eintrag "unban" (`user_purge.py`
  importiert `audit_log` gar nicht) und kein `guild_ban_removed`-Ereignis (einziger
  Erzeuger ist `routes/bans.py:363`). Die Bannliste zeigt B einfach nicht mehr. Der
  urspruengliche `ban`-Eintrag im `mod_audit_log` ueberlebt dagegen — die Pruefspur
  behauptet danach einen Bann, den es nicht mehr gibt. Wirkt ueber alle Communities des
  Loeschenden hinweg.
- **Vorschlag:** Die Bannzeile beim Purge nur noch ueber `GuildBan.user_id == user_id`
  entfernen und die Zuschreibung stattdessen entwerten — dafuer `banned_by_id` nullable
  machen (Migration) oder auf eine reservierte Systemkennung umschreiben. Wenn die Zeile
  wirklich fallen soll, muss derselbe Schritt einen `unban`-Audit-Eintrag und ein
  `guild_ban_removed`-Ereignis erzeugen, damit die Massnahme nicht spurlos verschwindet.

### Mittel — Kontoloeschung des gemeldeten Nutzers macht die offene Meldung fuer jede Community dauerhaft unsichtbar und unloesbar

- **Stelle:** `services/chat-gateway/src/dcc_chat_gateway/user_purge.py:98-109` (gerufen aus
  `_purge_db`, Zeile 164)
- **Was falsch ist:** `_delete_user_authored_messages` loescht jede vom Nutzer verfasste
  Nachricht hart (`sa_delete(Message)`), ohne die `Report`-Zeilen zu beruecksichtigen, die
  per `target_message_id` darauf zeigen. `Report.target_message_id` ist ein blankes
  `BigInteger` ohne Fremdschluessel (`models/moderation.py:113`) — es gibt weder Kaskade
  noch SET NULL, die Meldezeile ueberlebt verwaist. `Report` wird in `user_purge.py`
  nicht einmal importiert (nur `GuildBan` u. a., Importblock ab Zeile 29).
  Der Meldeweg fuer Community-Nachrichten traegt dabei nur zwei Ziele:
  `web/src/lib/components/MessageItem.svelte:265-269` setzt am `<ReportMessageDialog>`
  ausschliesslich `messageId`, `userId`, `toCloud` — `channelId`/`guildId` existieren als
  Props (`ReportMessageDialog.svelte:20-36`), werden hier aber nicht gefuellt und daher als
  `undefined` gesendet (`ReportMessageDialog.svelte:99-104`). Der Server ergaenzt nichts
  (`routes/reports.py:96-106` schreibt die Felder eins zu eins). Danach fallen in
  `mod_queue_scope.py:49-59` alle vier Zweige durch: Kanal NULL, Nachrichten-Subquery leer
  (Zeile geloescht), Guild NULL, und der Nutzer-Zweig verlangt ausdruecklich
  `target_message_id.is_(None)` (Zeile 56). Dasselbe in `_report_in_guild`. Daran haengen
  Liste, Zaehler, Triage, Aufloesung und Eskalation in `routes/mod_queue.py`.
- **Wie man es ausloest:** A meldet eine Community-Nachricht von B ueber die normale
  Oberflaeche. Bevor ein Moderator sie anfasst, loescht B sein Konto (`DELETE /me` →
  `POST /internal/users/{id}/purge`). Derselbe Effekt trifft reine Nutzer-Meldungen ohne
  `target_guild_id`, weil Schritt 2 des Purge auch die `GuildMember`-Zeile loescht
  (`user_purge.py:146-148`) und damit der Nutzer-Zweig ebenfalls leer laeuft.
- **Was es kostet:** Die Meldung faellt aus jeder Warteschlange, laesst sich nie mehr
  triagieren, aufloesen oder ans Betreiberteam eskalieren und bleibt dauerhaft als tote
  `new`-Zeile in `chat.reports` stehen; ein Moderator mit bereits geladener Liste bekommt
  beim Aufloesen einen 404. Kein Zaehlerdrift (Liste und Abzeichen teilen dasselbe
  Praedikat), kein Leck. Ausdruecklich *nicht* zutreffend ist der urspruenglich gemeldete
  Rahmen "Sanktion umgangen": Konto, Mitgliedschaft, Nachricht und Anhaenge sind durch
  denselben Purge bereits weg, `ban`/`kick`/`message_delete` (`routes/mod_queue.py:170-211`)
  waeren gegenstandslos. Ebenso falsch ist "kein Moderator erfaehrt davon" — beim Anlegen
  geht ein `ReportNewEvent` an jede betroffene Community (`routes/reports.py:115-126`).
  Es bleibt der fehlende Vorgangsabschluss plus Datenleiche.
- **Vorschlag:** `_purge_db` um einen Report-Schritt erweitern: offene Meldungen gegen den
  geloeschten Nutzer mit einem Endstatus schliessen (z. B. `resolved`/`obsolete` mit
  Begruendung "Konto geloescht") und dabei `target_message_id` entwerten, statt sie als
  `new` zurueckzulassen. Ergaenzend beim Anlegen einer Nachrichten-Meldung den Kanal aus
  der Nachricht ableiten und `target_channel_id` serverseitig fuellen, damit die
  Community-Zuordnung nicht allein an der geloeschten Nachrichtenzeile haengt.

### Niedrig bis mittel — Block-Route sperrt die Freundschaftszeile nicht: gleichzeitige Annahme kann "blockiert und befreundet" erzeugen

- **Stelle:** `services/chat-gateway/src/dcc_chat_gateway/routes/blocks.py:71-82`
- **Was falsch ist:** `create_block` liest die Freundschaftszeile mit einem einfachen
  SELECT (Zeile 71-77) und loescht sie mit einem einfachen DELETE (Zeile 78-82) — ohne
  `with_for_update()` oder sonstige Sperre auf das `(lo, hi)`-Paar. Der Docstring
  (Zeile 44-50, 63-69) verspricht einen "atomic sweep", der "friend AND blocked"
  ausschliesst. Parallel dazu sperrt `accept_friend_request` (`routes/friends.py:295 ff.`)
  ueber `load_request_for_caller` nur die `FriendRequest`-Zeile
  (`friend_helpers.py:111`, `session.get(..., with_for_update=True)`); das INSERT in
  `_atomic_install_friendship` (`routes/friends.py:74-87`) haengt an keiner Sperre, die
  `blocks.py` kennt. Die Engine laeuft ohne gesetztes `isolation_level` (`db.py:23`), auf
  Postgres also READ COMMITTED — ein DELETE auf eine noch nicht sichtbare Zeile sperrt
  nichts. Der Blockschutz in `accept_friend_request` (`routes/friends.py:300-308`) greift
  nicht, weil die Blockzeile zum Lesezeitpunkt noch nicht committet ist.
- **Wie man es ausloest:** B nimmt eine Freundschaftsanfrage von A an, waehrend A nahezu
  gleichzeitig `POST /blocks` auf B ausfuehrt. Die Block-Transaktion liest
  `friendship_existed = False`, loescht null Zeilen, laeuft anschliessend am
  `FriendRequest`-DELETE ins Leere (Zeile ist schon weg) und committet ihren `UserBlock`,
  nachdem die Accept-Transaktion die `Friendship` committet hat.
- **Was es kostet:** Fuer dasselbe Paar existieren danach dauerhaft eine `UserBlock`- und
  eine `Friendship`-Zeile. Beide Seiten sehen die geblockte Person nach dem naechsten
  Reconnect wieder in der Freundesliste (`routes/ws_ready.py` liefert `friends` und
  `blocked_user_ids` getrennt, `GET /friends` filtert nicht gegen Blocks) — Serverzustand,
  nicht nur Client-Cache, und nur ueber "entfreunden" aufloesbar. Ein zweiter Blockversuch
  repariert nichts, weil `blocks.py:59-61` bei bestehendem Block sofort zurueckkehrt, ohne
  den Sweep erneut zu fahren. Kein Rechteleck: Nachricht, DM, Erwaehnung und Praesenz
  pruefen den Block getrennt und in dieser Reihenfolge (`routes/messages.py:157-162`,
  `routes/dms.py:172`, `:179`, `pubsub_friend_cache.py`).
- **Vorschlag:** In `create_block` das Paar vor dem Sweep sperren — entweder die
  `Friendship`-Zeile per `with_for_update()` lesen oder, weil die Zeile im Rennen noch gar
  nicht existiert, beide Pfade ueber einen gemeinsamen Advisory-Lock auf `(lo, hi)`
  serialisieren. Alternativ am Ende der Accept-Transaktion nach dem Friendship-INSERT ein
  letztes Mal `block_exists_either_way` pruefen und die gerade angelegte Freundschaft bei
  Treffer wieder verwerfen.

### Niedrig bis mittel — Tippen-Anzeige in DM-Kanaelen ist nicht block-gated

- **Stelle:** `services/chat-gateway/src/dcc_chat_gateway/routes/ws_ops_handlers.py:386-414`
- **Was falsch ist:** `handle_typing` prueft nur, ob der Sender den Kanal abonniert hat
  (Zeile 402) und die 2-Sekunden-Bremse (Zeile 405-407), und veroeffentlicht dann direkt
  ueber `ctx.manager.publish` (Zeile 409-412). Kein Aufruf von `block_exists_either_way`
  oder eines block-bewussten Filters. Der Zustellweg faengt es ebenfalls nicht ab: DMs
  passieren den Fan-out-Filter ungefiltert (`pubsub_perm_filter.py:366-367`, `kind == -1`
  → `return targets`). Das steht im Gegensatz zu allen uebrigen Durchsetzungspunkten
  desselben Dienstes: Senden prueft den Block hart (`routes/ws_op_send.py:160`, 4014
  "blocked"), Erwaehnungen werden gefiltert (`mentions.py:352-378`), und die Praesenz
  benutzt ausdruecklich den block-bewussten Filter (`pubsub_friend_cache.py:186-237`,
  inklusive der Regel, dass ein Socket mit unbekanntem Blockstatus lieber ausgeschlossen
  wird). Empfangsseitig markiert `web/src/lib/ws/handlers/chat.ts:64-69` jeden Absender
  ungeprueft. Auch ein Abo bleibt nach dem Block moeglich: `routes/_deps.py` prueft bei DMs
  nur die Mitgliedschaft, keinen Block.
- **Wie man es ausloest:** Nicht mit dem ausgelieferten Client im Dauerbetrieb — dort
  sperrt `can_send=false` das Eingabefeld (`routes/dms.py:93-141`, `routes/ws_ready.py:363-368`
  → `composerDisabled` → `MessageInput.svelte`), und ein `disabled`-Textfeld feuert kein
  `input`, also auch kein `typing`. Es bleiben zwei Wege: das Rennfenster direkt nach dem
  Block, bevor die Neu-Hydrierung beim Geblockten ankommt (angestossen ueber
  `friend_removed`, `web/src/lib/ws/handlers/friends.ts:104-107` — und dort mit
  `.catch(() => undefined)` verschluckt, ein zweiter Versuch findet nicht statt), sowie
  jeder selbstgebaute WS-Client, der `{"op":"typing","channel_id":<dm>}` schickt.
- **Was es kostet:** Der Blockierende sieht weiterhin live "X schreibt …" (Anzeige haelt
  bis zu sechs Sekunden, `web/src/lib/stores/typing.svelte.ts:14`), waehrend Nachricht,
  Erwaehnung, Freundschaftsanfrage und Praesenz derselben Person serverseitig abgeriegelt
  sind. Ein Aktivitaetsleck, dessen einziger Riegel im Client liegt — genau die Lage, die
  das Projekt an der Praesenzstelle ausdruecklich ablehnt.
- **Vorschlag:** In `handle_typing` fuer DM-Kanaele denselben Blockcheck fahren wie der
  Sendepfad (`block_exists_either_way` bzw. den socket-lokalen Blockcache aus
  `pubsub_friend_cache.py` wiederverwenden, wie es `presence_status.py` fuer den
  Praesenz-Op tut) und die Nachricht bei Treffer still verwerfen. Alternativ das Abo eines
  DM-Kanals bei bestehendem Block gar nicht erst zulassen, dann faellt die Tippen-Anzeige
  automatisch mit.

## Verworfen

- **Nicht gesperrtes `/triage` ueberschreibt eine parallel abgeschlossene Meldung
  (Lost Update)** (`routes/mod_queue.py:404`) — die Gegenpruefung hat den behaupteten
  Datenverlust nicht am Code halten koennen.
- **Tippen-Anzeige in DM-Kanaelen ist nicht block-gated** (`routes/ws_ops_handlers.py:386`)
  — als eigenstaendiger Befund verworfen, weil deckungsgleich mit dem oben gefuehrten
  Befund; er ist dort verschmolzen.
- **Instanzweiter Bann (`/admin/members/{id}/ban`) trennt keine laufende Sitzung**
  (`routes/admin_members.py:79`) — die Sperre wirkt nach Entwurf beim naechsten
  Cert-Login; ein Verstoss gegen eine zugesagte Sofortwirkung liess sich nicht belegen.
- **Nutzer-Report ohne Community-Bezug wird nach Loeschung des gemeldeten Kontos aus jeder
  Warteschlange unsichtbar** (`routes/mod_queue_scope.py:53`) — dieselbe Ursache wie der
  oben gefuehrte Meldungs-Befund (fehlender Report-Schritt im Purge), dort als Variante
  mitbeschrieben; die Zweig-Logik in `mod_queue_scope.py` ist nicht die Fehlerstelle,
  ihr `target_message_id IS NULL` schuetzt ausdruecklich gegen ein Leck zwischen
  Communities.

## Nicht nachvollzogen

Keine. Alle vier bestaetigten Befunde liessen sich an den genannten Stellen wiederfinden.
Drei Teilbehauptungen aus den Meldetexten sind allerdings am Code widerlegt und oben
entsprechend korrigiert statt uebernommen:

- "Widerspruch zwischen Kommentar und Codewirkung" beim Bann-Purge — der Kommentar
  `user_purge.py:181-183` benennt die Loeschung ausdruecklich; der Fehler liegt in der
  Folge fuer Dritte, nicht in einer Abweichung von der eigenen Beschreibung.
- "Ohne dass irgendein Moderator das je erfaehrt" bei der verwaisten Meldung —
  `routes/reports.py:115-126` pusht beim Anlegen ein `ReportNewEvent` an jede betroffene
  Community.
- "Auch frontend-seitig gibt es keine Kompensation" bei der Tippen-Anzeige — der
  ausgelieferte Client sperrt das Eingabefeld ueber `can_send=false` und sendet in einem
  geblockten DM kein `typing`; der Befund traegt nur ueber das Rennfenster und ueber
  fremde Clients.
