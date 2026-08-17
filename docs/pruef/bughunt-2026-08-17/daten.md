# Bughunt Datenbank, Migrationen und Zustandsspeicher

Durchsucht wurden die Löschketten des chat-gateway (`user_purge.py`, `routes/internal.py`,
`routes/guilds.py`, `routes/channels.py`, `routes/devices.py`, `remote_guard.py`), das
In-Prozess-Geräteregister (`device_registry.py`) sowie die zugehörigen Modelle und
Migrationen (`models/devices.py`, `alembic/versions/20260816_0100_0059_devices.py`).
Zwei Befunde sind am Code belegt, beide betreffen die 2026-08-16 neu hinzugekommene
Tabelle `chat.devices` (Standplatz-Geräte) und ihren Zustandsspeicher. Der schwerere ist
der fehlende Geräte-Schritt im Konto-Purge: eine als „hart" zugesagte Kontolöschung
lässt Gerätezeilen mit toter Besitzerkennung dauerhaft stehen. Er wurde von drei
Prüfern unabhängig voneinander gemeldet und steht hier einmal zusammengefasst.

## Befunde

### mittel — Konto-Purge löscht die Standplatz-Geräte des Nutzers nicht

- **Stelle:** `services/chat-gateway/src/dcc_chat_gateway/user_purge.py:135` (Rumpf 135–249),
  Importblock 29–49
- **Was falsch ist:** `_purge_db()` zählt jede zu räumende Tabelle einzeln auf — Guild
  (140–142), GuildMember/MemberRole (146–153), PermissionOverwrite (156–161),
  Nachrichten (164), Reaktionen (167–169), Mentions (174–179), Bans (184–188),
  WebPush (191–193), DM-Kanäle (197–198), Freundschaftssystem (203–229),
  CommunityInvite (235–242), UserPreference (245–247). `Device` kommt weder im
  Importblock noch im Rumpf vor; auch `remote_guard.remove_devices_for_member()` bzw.
  `end_remote_sessions_for_member()` werden aus diesem Pfad nicht gerufen. Ein Auffang
  auf DB-Ebene existiert nicht: `models/devices.py:63-74` und die Migration
  `20260816_0100_0059_devices.py:56-61` legen Fremdschlüssel nur auf `guilds.id` und
  `channels.id` (beide CASCADE) an, `owner_user_id` ist ein FK-loses `BigInteger`
  (`models/devices.py:74`, Migration Zeile 46) — bewusst, weil die Nutzertabelle dem
  auth-svc gehört. Genau deshalb müsste die Spalte, wie jede andere `user_id`-Spalte in
  diesem Schema, ausdrücklich im Purge geleert werden. Für die Communities, die der
  Nutzer selbst besitzt, greift der Guild-Cascade (`user_purge.py:140-142`); für
  fremde Communities bleibt die Zeile stehen. Der einzige Aufrufer
  (`routes/internal.py:89-123`) sagt im Docstring ausdrücklich zu, „every piece of data
  chat-gateway owns for `user_id`" zu löschen; auth-seitig gibt es keinen zweiten
  Aufräumweg (`services/auth/src/dcc_auth/routes_account.py`, `_purge_chat_state`).
  Die dafür gebaute Funktion `remote_guard.remove_devices_for_member()`
  (`remote_guard.py:157-214`) wird nur aus `routes/guilds.py:630` (Rauswurf und
  freiwilliges Verlassen) und `routes/bans.py` gerufen.
- **Wie man es auslöst:** Ein Nutzer trägt in einer Community, die er nicht besitzt, über
  `POST /guilds/{id}/devices` (`routes/devices.py:209`) ein Standplatz-Gerät ein — dafür
  genügt Mitgliedschaft plus `STREAM` im Sprachkanal. Danach löscht er sein Konto über
  den auth-svc, der `POST /internal/users/{id}/purge` auslöst.
- **Was es kostet:** Die Zeile in `chat.devices` bleibt dauerhaft stehen und trägt die
  Kennung eines nicht mehr existierenden Kontos. `list_devices` (`routes/devices.py:186-206`)
  filtert nur über `VIEW_CHANNEL`, nicht über die Existenz des Besitzers — die Kachel
  bleibt jedem sichtbaren Mitglied in der Kanalliste erhalten und gibt Besitzerkennung und
  Gerätenamen eines hart gelöschten Kontos weiter. Der Besitzerzweig in
  `_require_owner_or_manager` (`routes/devices.py:174-183`) kann nie wieder greifen, weil
  Snowflakes nicht neu vergeben werden; entfernen kann die Zeile nur noch jemand mit
  `MANAGE_GUILD`, umstellen (besitzergebunden) niemand mehr. Zusätzlich blockiert
  `UniqueConstraint("guild_id","name")` (`models/devices.py:86`) diesen Gerätenamen in
  der Community dauerhaft — ein neuer Rechner gleichen Namens bekommt für immer 409
  (`routes/devices.py:249-260`).
  Zwei in den Meldungen genannte Folgen tragen dagegen nicht und sind hier
  ausdrücklich ausgenommen: das Gerät ist **nicht** übernehmbar (die Anmeldung verlangt
  `device.owner_user_id == ctx.user.id`, `routes/ws_device_handlers.py:149`, das Konto
  existiert nicht mehr → dauerhaft „offline", `handle_wake` endet in 4061), und eine zum
  Löschzeitpunkt laufende Fernsteuerung wird vom 30-s-Prüflauf gekappt
  (`remote_guard.py:41`, `_end_reason` → `permission_revoked`, weil die
  `GuildMember`-Zeile weg ist). Es bleibt ein Datenrest entgegen einer ausdrücklichen
  Zusage, kein Rechteproblem.
- **Vorschlag:** Im Purge-Pfad denselben Weg gehen wie beim Verlassen einer Community: vor
  oder unmittelbar nach dem Löschen der `GuildMember`-Zeilen für jede nicht selbst
  besessene Community `remove_devices_for_member()` aufrufen (das räumt Zeile, Register
  und Meldung in einem) oder — falls der Einzeltransaktions-Charakter von `_purge_db()`
  gewahrt bleiben soll — dort ein schlichtes `sa_delete(Device).where(Device.owner_user_id
  == user_id)` ergänzen und die betroffenen Kennungen anschliessend in `purge_user()`
  über `manager.device_forget()` samt `device_changed removed=true` nachziehen. In beiden
  Fällen den `commit()`-Hinweis aus `remote_guard.py` beachten.

### niedrig — Kanal- und Community-Löschung räumen das In-Prozess-Geräteregister nicht auf

- **Stelle:** `services/chat-gateway/src/dcc_chat_gateway/routes/channels.py:208`
  (`delete_channel`, 207–286) und `services/chat-gateway/src/dcc_chat_gateway/routes/guilds.py:271`
  (`delete_guild`, 270–332)
- **Was falsch ist:** Beide Routen lassen die Gerätezeilen über die FK-CASCADE fallen
  (`models/devices.py:63-72`, Migration `…0059_devices.py:56-61`), rühren aber das
  Geräteregister im `ConnectionManager` nicht an. In `channels.py` gibt es keinen einzigen
  Treffer für „device"; in `guilds.py` steht der einzige Geräte-Bezug im
  Mitglieder-Entfernen-Pfad (Zeile 37 Import, Zeile 630 Aufruf), nicht in `delete_guild`.
  Nach `session.delete(...)` + `commit()` folgen dort nur MinIO-Purge, das
  `Channel-/GuildDeletedEvent` und `evict_all_from_voice_channels` (channels.py 284–286,
  guilds.py 314–332). Alle anderen Löschpfade rufen ausdrücklich auf, was hier fehlt:
  `routes/devices.py:365-366` (`device_forget` nach `delete_device`),
  `routes/devices.py:318` (`device_move`/`sitzung_beenden` beim Standplatzwechsel),
  `remote_guard.py:188` und `:213` (`end_remote_sessions_for_device`, `device_forget`).
  Der Docstring von `device_forget` (`device_registry.py:284-303`) benennt die Folge
  wörtlich als „ein Leck, das mit jedem entfernten Gerät wächst".
- **Wie man es auslöst:** Ein Verwalter löscht per `DELETE /channels/{id}` einen
  Sprachkanal oder per `DELETE /guilds/{id}` eine Community, in der ein Standplatz-Gerät
  eingetragen und über `device_announce` online gemeldet ist.
- **Was es kostet:** `_device_sockets`, `_device_where`, `_device_busy`,
  `_device_monitors` und `_device_streams` (`device_registry.py:115-121`) behalten den
  Eintrag für die restliche Prozesslaufzeit — ein kleines, aber monoton wachsendes Leck,
  und `device_state()` (Zeile 177–190) meldet für eine nicht mehr existierende Kennung
  weiter „bereit"/„belegt". Da kein `device_changed` mit `removed=true` verschickt wird,
  bleibt die Kachel in einer bereits offenen guild-weiten Geräteliste stehen, bis neu
  geladen wird; ein Klick darauf endet in 4060 bzw. 4061. Kein Rechteproblem: eine
  Sitzung auf eine cascade-gelöschte Zeile lässt sich nicht mehr aufbauen (die
  Handler laden die Zeile), und eine laufende stirbt spätestens nach 30 s über
  `remote_guard`, weil die Kanal-Mitgliedschaft nicht mehr auflösbar ist. Deshalb
  „niedrig" statt der ursprünglich gemeldeten Schwere „mittel".
- **Vorschlag:** In beiden Routen vor dem Commit die betroffenen Gerätekennungen samt
  Standplatz einsammeln (`select(Device.id, Device.channel_id)` über `channel_id` bzw.
  `guild_id`) und nach dem Commit dieselbe Reihenfolge fahren wie `delete_device`:
  `end_remote_sessions_for_device`, `publish_device_change(..., removed=True)`, dann
  `device_forget` — die Reihenfolge ist wichtig, weil die Meldung den gemerkten
  Standplatz noch braucht.

## Verworfen

- **[mittel] Community-Löschung räumt Standplatz-Geräte weder aus dem In-Prozess-Register
  noch beendet sie laufende Fernsteuer-Sitzungen dafür** (`routes/guilds.py:314`) — sachlich
  richtig, aber deckungsgleich mit dem obigen Registerbefund; hier als dessen
  `delete_guild`-Hälfte geführt statt doppelt gezählt.
- **[niedrig] Geräte-Obergrenze je Besitzer ist ein nicht-atomarer
  Zählen-dann-Einfügen-Ablauf** (`routes/devices.py:227`) — zweimal in identischer Form
  gemeldet; die Grenze ist laut Kommentar (`routes/devices.py:85-91`) ausdrücklich kein
  Schutz vor einem Angreifer, sondern ein Riegel gegen den wiederholt eintragenden
  Client, und ein knappes Überschreiten unter Gleichzeitigkeit erzeugt kein falsches
  Verhalten.

## Nicht nachvollzogen

Keine. Alle vier bestätigten Meldungen liessen sich an den genannten Zeilen belegen; drei
davon (`user_purge.py:135` / `:144`) beschreiben denselben Fehler und sind zu einem
Befund zusammengefasst. Von den beschriebenen Auswirkungen habe ich zwei nicht
bestätigen können und oben ausdrücklich ausgenommen: die Übernehmbarkeit der verwaisten
Gerätezeile und das Weiterlaufen einer Fernsteuer-Sitzung über den 30-Sekunden-Prüflauf
hinaus.
