# Nachtrag: bestätigte Befunde aus dem abgebrochenen ersten Durchgang

## Warum es diese Datei gibt

Runde 2 lief zweimal. Der erste Durchgang (17. August, 02:00–02:32) brach ab, als das
Sitzungslimit erreicht war; 32 von 242 Agenten starben, darunter sechs der acht
Berichtsschreiber. Der zweite Durchgang (17. August, 16:07–16:54) nahm den Lauf wieder auf.

Dabei kamen die abgeschlossenen Agenten aus dem Zwischenspeicher — aber alles, was in der
Aufrufreihenfolge **nach** dem ersten gescheiterten Agenten lag, lief live neu. Das betraf
mehrere Reviere in den Stufen Jagd und Nachjagd. Die Jäger sind nicht deterministisch: sie
fanden beim zweiten Mal teils andere Stellen, und die Berichte des zweiten Durchgangs
beschreiben deshalb in einigen Revieren eine **andere Stichprobe** als der erste.

Die hier aufgeführten Befunde stammen aus dem ersten Durchgang, haben dort das
Gegengutachten mit Opus bestanden — und tauchen in keinem der endgültigen Berichte auf.
Sie sind nicht widerlegt worden. Sie sind schlicht beim zweiten Würfeln nicht wieder
gefallen.

**Ihr Status ist damit: bestätigt durch ein Gegengutachten, aber nicht ein zweites Mal
nachgeprüft und nicht in einem Einzelbericht am Code verifiziert.** Wer sie angeht, prüft
sie am besten zuerst noch einmal selbst nach.

## Befunde

### auth-dienst

**Hoch — Einzel-Session-Widerruf tötet nur den Refresh-Token, nicht das gekoppelte
Browser-Session-Cookie**
`services/auth/src/dcc_auth/routes_sessions.py:89`
Ein gekapertes Gerät bleibt trotz Klick auf „Sitzung beenden" voll angemeldet und kann
sogar neue Identity-Zertifikate ausstellen. Passt in dasselbe Bild wie die beiden
bestätigten Zertifikats-Befunde in `auth-dienst.md`: der Widerruf greift jeweils nur einen
Teil der ausgestellten Berechtigungen.

### sozial

**Hoch — `kick_member` ist ein Bestätigungs-Orakel für die Owner-Identität**
`services/chat-gateway/src/dcc_chat_gateway/routes/guilds.py:709`
`bans.py` wurde ausdrücklich gegen dieses Muster abgesichert, `guilds.py` nicht — also
genau der Fall „dieselbe Absicherung an zwei Stellen, eine davon nachgezogen, die andere
nicht", den beide Runden als Hauptmuster ausweisen. Vergleich der beiden Routen genügt zur
Prüfung.

**Mittel — Emoji-Reaktionen auf DM-Nachrichten umgehen den Block-Gate vollständig**
`services/chat-gateway/src/dcc_chat_gateway/routes/reactions.py:99`
Direkte Ergänzung zum bestätigten Befund über die Tippen-Anzeige in `sozial.md`: derselbe
blinde Fleck, anderer Weg. Ein Geblockter kann weiter sichtbar reagieren.

**Mittel — Fenster zwischen Socket-Registrierung und Cache-Hydration verschluckt Block- und
Freund-Ereignisse**
`services/chat-gateway/src/dcc_chat_gateway/pubsub_friend_cache.py:96`
Für frisch verbundene Sockets bleibt der Presence-Filter dauerhaft veraltet. Folgt exakt
dem Rennmuster beider Runden: Zustand gewinnen, `await`, Nebenwirkung eintragen, ohne den
Gewinn dazwischen erneut zu prüfen.

**Mittel — Meldungen über gelöschte Kanäle oder Nachrichten werden für jeden Moderator
dauerhaft unsichtbar und unauflösbar**
`services/chat-gateway/src/dcc_chat_gateway/routes/mod_queue_scope.py:24`
Der zweite Durchgang bestätigte dieselbe Wirkung auf einem anderen Weg
(`user_purge.py:98`, Löschung des gemeldeten Kontos). Dass zwei unabhängige Durchgänge
zweimal auf dieselbe Folge stoßen, spricht dafür, dass die Ursache breiter liegt als eine
einzelne Zeile.

### chat

**Hoch — `GET /messages/{id}/reactions` prüft keine Kanal-Sichtbarkeit, nur
Guild-Mitgliedschaft**
`services/chat-gateway/src/dcc_chat_gateway/routes/reactions.py:47`
Ein Mitglied ohne `VIEW_CHANNEL` erfährt, wer auf welche Nachricht in einem für ihn
gesperrten Kanal reagiert hat. Verwandt mit dem Dropbox-Befund unten — beide prüfen
Mitgliedschaft, wo Kanalsichtbarkeit zu prüfen wäre.

### ablage

**Hoch — Dropbox prüft nur Community-Mitgliedschaft, nie die `VIEW_CHANNEL`-Berechtigung
des Ablage-Kanals**
`services/chat-gateway/src/dcc_chat_gateway/routes/dropbox.py:310`
Der Kanal ist der Rechteanker der Ablage; wird er nicht geprüft, hängt der Zugriff allein
an der Mitgliedschaft in der Community.

**Hoch — Löschen (Papierkorb) eines Ablage-Ordners räumt seine Kinder nicht mit**
`services/chat-gateway/src/dcc_chat_gateway/routes/dropbox.py:646`
Nach dem endgültigen Purge bleiben unerreichbare, aber weiter kontingent-belastende
Datenleichen zurück. Ergänzt die beiden bestätigten Quota-Befunde in `ablage.md` um einen
dritten Weg, auf dem der Zähler von der Wirklichkeit abweicht.

**Mittel — `create_folder` und `patch_entry` prüfen auf Namenskollision, ohne den
anschließenden Commit gegen das Rennen abzusichern**
`services/chat-gateway/src/dcc_chat_gateway/routes/dropbox.py:446`
Zwei gleichzeitige, jede für sich legitime Anfragen enden als unbehandelter 500er statt als
saubere Kollisionsmeldung. Dasselbe Prüf-dann-schreib-Muster wie die beiden bestätigten
Quota-Rennen in `ablage.md`, nur mit anderer Folge.

### plugins-watch

**Hoch — Bann, Rauswurf und Austritt beenden eine laufende Watch-Party des Betroffenen
nicht**
`services/chat-gateway/src/dcc_chat_gateway/routes/ws_watch.py:318`
`watch_control`, `watch_heartbeat` und `watch_stop` prüfen die Mitgliedschaft nach dem
Start nie erneut. Dasselbe Bild wie der bestätigte Streaming-Befund aus Runde 1 (Bann
beendet die laufende Übertragung nicht) — die Moderationshandlung erreicht das laufende
Ding nicht.

**Hoch — Guild-Plugin-Toggle kann eine `guild_plugins`-Zeile neu anlegen, nachdem der Admin
das Plugin instanzweit entfernt und cascade-gelöscht hat**
`services/chat-gateway/src/dcc_chat_gateway/routes/guild_plugins.py:192`
Rennen zwischen instanzweiter Sperre und Pro-Community-Schalter.

**Mittel — Tamagotchi-Reset zeigt optimistisch Erfolg, obwohl das Backend ihn wegen
fehlender `MANAGE_GUILD`-Berechtigung ablehnt**
`plugins/tamagotchi/frontend.ts:126`
Gehört zur Gruppe der stillen Fehlschläge, die auch der zweite Durchgang für Watch-Party
und Video-Wechsel bestätigt hat: der Server lehnt korrekt ab, die Oberfläche meldet Erfolg.

## Was daraus folgt

Zwölf bestätigte Befunde, die ohne diesen Nachtrag verlorengegangen wären — sieben mit
Schwere „hoch", fünf mit „mittel". Vier davon fallen inhaltlich mit bestätigten Befunden der
endgültigen Berichte zusammen und stützen diese eher, als dass sie neue Themen aufmachen
(Reaktions-Block, Meldungen ins Leere, Quota-Abweichung, stiller Fehlschlag in der
Oberfläche).

Methodisch bleibt festzuhalten: **ein einzelner Jagd-Durchgang ist eine Stichprobe, keine
vollständige Abdeckung.** Zwei Durchgänge über denselben Code fanden in mehreren Revieren
teils disjunkte Mengen. Wer Vollständigkeit will, wiederholt die Jagd, statt einem einzelnen
Lauf zu vertrauen.
