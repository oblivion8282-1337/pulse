# Bughunt ConnectionManager, WebSocket-Ops und Registraturen

Durchsucht wurde das Revier rund um den ConnectionManager des chat-gateway: die
Verbindungsverwaltung (`pubsub.py`, `pubsub_listener.py`), der Ops-Verteiler
(`routes/ws_ops.py`, `ws_ops_registry.py`), die Fernsteuer-Handler
(`routes/ws_remote_handlers.py`, `ws_remote_teardown.py`, `ws_remote_geraet.py`),
die Geraete-Handler (`routes/ws_device_handlers.py`) sowie die drei
In-Memory-Registraturen `remote_registry.py`, `device_registry.py` und
`watch_registry.py` — dazu die Client-Seite, an der sich die Wirkung zeigt
(`web/src/lib/devices/`). Zwei Befunde sind bestaetigt und am Code belegt, beide
im Zusammenspiel von Fernsteuer-Sitzung und Standplatz-Geraeteregister. Der
schwerste ist die Belegung, die nach einem Rennen zwischen Zustimmung und
Sitzungsende haengen bleibt und das Geraet fuer jeden unuebernehmbar macht.

## Befunde

### Hoch — Standplatz-Geraet kann nach einer Fernsteuer-Sitzung dauerhaft auf „belegt" haengen bleiben

- **Stelle:** `services/chat-gateway/src/dcc_chat_gateway/routes/ws_remote_handlers.py:351`
  (Belegung erst in Zeile 368-374), Gegenstueck
  `services/chat-gateway/src/dcc_chat_gateway/remote_registry.py:197-214` und
  `services/chat-gateway/src/dcc_chat_gateway/device_registry.py:369-388`
- **Was falsch ist:** In `handle_respond()` gewinnt die Zustimmung in Zeile 351
  atomar (`mgr.remote_activate`, CAS unter Sperre, `remote_registry.py:155-166`).
  Danach folgen drei `await` auf FREMDE Sockets — `remote_dismiss_host_tabs`
  (Zeile 359) und zweimal `send_to_socket` (Zeile 361, 362) —, und erst am Ende
  (Zeile 368-371) wird ueber `device_for_socket(websocket)` das Geraet ermittelt
  und mit `device_set_busy(...)` als belegt eingetragen. Der lokal gehaltene
  `sess`-Verweis wird in diesem Fenster kein zweites Mal gegen
  `mgr.remote_get(session_id)` geprueft. Faellt die Sitzung genau dort weg, ruft
  `remote_end` (`remote_registry.py:211`) `device_release_for_socket`, und die
  Funktion (`device_registry.py:382-388`) sucht ausschliesslich in
  `_device_busy_socket` — dort steht fuer diese Sitzung noch nichts, weil
  `device_set_busy` erst danach kommt. Die Freigabe kehrt in Zeile 386 still
  zurueck (kein Log, kein Fehler), und anschliessend traegt Zeile 371 die
  Belegung fuer eine Sitzung ein, die es nicht mehr gibt. Danach raeumt niemand
  mehr auf: `device_set_busy(..., None)` wird sonst nur aus `device_withdraw`
  (`device_registry.py:276`, erst wenn der LETZTE Socket des Geraets faellt) und
  `device_forget` (Zeile 300, geloeschte Zeile) gerufen; die Rechte-Wache
  `audit_remote_sessions` laeuft nur ueber `remote_sessions_snapshot()` und
  sieht eine entfernte Sitzung gar nicht.
- **Wie man es ausloest:** Ein Steuernder schickt `remote_request`, der Host
  akzeptiert. Bevor Zeile 371 die Belegung setzt, endet die frisch aktivierte
  Sitzung — durch ein sofortiges `remote_end` des Steuernden, durch
  Tab-Schliessen/Reload (`cleanup_remote_on_disconnect` ueber den
  Controller-Socket) oder durch eine externe Beendigung (Rechte-Wache, Kick,
  Bann). Damit ueberhaupt eine Unterbrechungsstelle entsteht, muss einer der
  drei `await` an den Event-Loop abgeben: das passiert bei gestautem
  Schreibpuffer und — nachweisbar in der websockets-Bibliothek — im `send`-Pfad
  ueber `ensure_open`, wenn die Gegenstelle gerade schliesst; genau der Fall,
  wenn der Steuernde unmittelbar nach dem Zustimmen die Leitung verliert. Der
  Host bleibt dabei online, `device_for_socket(websocket)` liefert also weiter
  ein Geraet. Die Datei selbst geht diese Wette nicht ein: Zeile 283-288
  beschreibt einen bereits behobenen Fehler derselben Bauart, und Zeile 329-334
  verlangt ausdruecklich, dass jede Nebenwirkung erst nach dem atomaren Gewinn
  steht — `device_set_busy` ist die einzige Nebenwirkung ohne Absicherung gegen
  den inzwischen moeglichen Wegfall der Sitzung.
- **Was es kostet:** Das Geraet steht in der Kanalliste als „belegt" samt Namen
  eines Steuernden, dessen Sitzung laengst weg ist (`device_state`,
  `device_registry.py:183-186`). Die Oberflaeche blendet bei „belegt" den
  Uebernahme-Weg aus (`web/src/lib/devices/components/DeviceView.svelte:87` und
  `:146`, `web/src/lib/devices/schirme.svelte.ts:151`) — das Geraet ist damit
  fuer niemanden mehr fernsteuerbar. Es ist keine Rechteumgehung: serverseitig
  prueft `remote_create` (`remote_registry.py:136-153`) die Belegung gar nicht,
  eine neue Sitzung ginge technisch durch; die Sperre ist rein die Anzeige.
  Geheilt wird der Zustand erst, wenn der letzte Socket des Geraets faellt
  (`device_withdraw`, `device_registry.py:276`) — bei einem unbeaufsichtigten
  Standplatz-Geraet also fruehestens beim naechsten Verbindungsabriss oder
  Token-Wechsel, ohne dass jemand vor Ort waere.
- **Vorschlag:** Die Belegung gehoert unmittelbar hinter den atomaren Gewinn in
  Zeile 351, vor die drei Sends — dann findet ein spaeteres `remote_end`
  garantiert einen Eintrag in `_device_busy_socket`. Alternativ (oder
  zusaetzlich) vor dem Setzen in Zeile 368-371 noch einmal
  `mgr.remote_get(session_id)` pruefen und bei verschwundener Sitzung nichts
  eintragen. Sauber waere zusaetzlich, den Zustand wie im Entwurf vorgesehen aus
  der Sitzungs-Registry ABZULEITEN statt ihn als zweites Feld zu fuehren
  (`docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md:109-110`).

### Mittel — Standplatz-Geraet meldet nach einem Verbindungsabbruch weiter stale Stream-Plaetze, obwohl es als offline gilt

- **Stelle:** `services/chat-gateway/src/dcc_chat_gateway/device_registry.py:263`
  (`device_withdraw`, Zeile 263-282)
- **Was falsch ist:** `device_withdraw()` raeumt beim Abmelden eines
  Geraete-Sockets `_device_sockets`, den Rueckindex und ueber
  `device_set_busy(device_id, None)` (Zeile 276) auch die Belegung auf und setzt
  den Zustand damit auf „offline" — `_device_streams[device_id]`, die Menge der
  Plaetze, auf denen das Geraet sendet, bleibt aber unangetastet stehen. Der
  dokumentierte Erhalt in Zeile 277-281 gilt ausdruecklich nur den Bildschirmen.
  Geleert wird `_device_streams` ausschliesslich in `device_streams_set()`
  (Zeile 156-175, verlangt eine ausdrueckliche Client-Nachricht) und in
  `device_forget()` (Zeile 303, nur bei geloeschter Datenbankzeile); weitere
  Schreibstellen gibt es im Repo nicht. Der Abrissweg
  (`routes/ws_ops.py` → `on_disconnect` → `device_forget_socket`,
  `device_registry.py:305-313`) fuehrt nur nach `device_withdraw`.
  `publish_device_state` (Zeile 346-367) sendet daraufhin `state="offline"`
  gemeinsam mit den alten `stream_slots`. Das widerspricht der im selben Modul
  begruendeten Absicht (Zeile 110-112: „nach einem Absturz loege sie, und zwar
  Richtung ‚sendet'") — genau diese Luege entsteht hier.
- **Wie man es ausloest:** Ein Standplatz-Geraet meldet per `device_streams`,
  dass es auf Platz 0 sendet (`handle_streams` in
  `routes/ws_device_handlers.py`). Die Verbindung faellt (Absturz, Netzausfall)
  ohne vorheriges Leermelden. Der Zustand wird korrekt „offline",
  `_device_streams[device_id] = {0}` bleibt stehen. Selbstheilung beim
  Wiederverbinden gibt es nicht: `web/src/lib/devices/components/DeviceKiosk.svelte:63-79`
  sendet `device_streams` nur bei geaendertem Schluessel, und nach einem
  Neustart der App ist der Schluessel identisch mit dem leeren Anfangswert
  (`web/src/lib/devices/wecken.ts:173-176`) — es geht nichts hinaus. Da
  `_device_where` beim Abmelden bewusst stehenbleibt, ueberlebt der veraltete
  Eintrag sogar ein erneutes `device_announce`.
- **Was es kostet:** `stromGehoertGeraet`
  (`web/src/lib/devices/darstellung.ts:81-92`) entscheidet allein anhand von
  `stream_slots`, ohne den Geraetezustand zu pruefen — `alleImKanal`
  (`web/src/lib/devices/store.svelte.ts:70-78`) filtert ebenfalls nicht nach
  Zustand. Startet der Besitzer spaeter an seinem EIGENEN Client einen Stream
  auf demselben Platz in diesem Kanal (Platz 0 ist der Regelfall,
  `streamPresence.svelte.ts:118`), wird der Strom faelschlich dem laengst
  offline gegangenen Geraet zugeschrieben, und dem wirklich sendenden Menschen
  fehlt sein LIVE-Abzeichen in Kanalliste, Mitgliederliste und
  Aktivitaets-Kopfzeile — exakt der Fehler „falsches Abzeichen am falschen Ort",
  den die Funktion laut ihrem eigenen Kommentar (Zeile 62-67) beheben sollte.
- **Vorschlag:** Beim vollstaendigen Offline-Gehen in `device_withdraw` auch
  `_device_streams` raeumen, parallel zu `device_set_busy(device_id, None)` in
  Zeile 276. Zu beachten ist der Gegenfall, in dem nur die WebSocket faellt
  waehrend die Uebertragung ueber ihren eigenen Weg weiterlaeuft — da der Client
  nach dem Wiederverbinden nichts nachmeldet, sollte `DeviceKiosk.svelte`
  zusaetzlich beim Anmelden den aktuellen Stand unbedingt senden statt nur bei
  Aenderung. Alternativ auf der Anzeigeseite in `stromGehoertGeraet` Geraete mit
  `state === 'offline'` ueberspringen.

## Verworfen

- **`_fan_out` entfernt Sockets bei blossem Sende-Stau aus der
  Verbindungsverwaltung, ohne die Register fuer Geraete/Fernsteuerung/Watch-Party
  zu benachrichtigen** (`pubsub_listener.py:74`) — von den Gegengutachtern
  widerlegt: der Abbauweg fuehrt nicht an den Registraturen vorbei, die
  behauptete Verwaisung liess sich am Code nicht belegen.
- **CORE_OPS-Schutzliste vergisst `watch_source_change` — Plugin kann den
  eingebauten Handler stillschweigend uebernehmen** (`ws_ops_registry.py:148`) —
  widerlegt: die Op ist ueber den bestehenden Namensraum-Schutz nicht durch ein
  Plugin belegbar.
- **Abgelehnte WS-Registrierung hinterlaesst leere, nie aufgeraeumte Eintraege
  in den Verbindungszaehlern** (`pubsub.py:309`) — widerlegt: die Eintraege
  werden im weiteren Ablauf geraeumt, ein wachsendes Leck entsteht nicht.

## Nicht nachvollzogen

Keine. Beide bestaetigten Befunde liessen sich an den genannten Stellen
vollstaendig am Code wiederfinden. Eine Einschraenkung gegenueber der
urspruenglichen Meldung wurde eingearbeitet: die Belegung aus Befund 1 ist nicht
im Wortsinn „dauerhaft" — sie heilt beim naechsten vollstaendigen
Verbindungsverlust des Geraets (`device_registry.py:276`), also spaetestens beim
turnusmaessigen Token-Wechsel des Sockets.
