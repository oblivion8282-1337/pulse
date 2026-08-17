# Bughunt Stream-Tokens, Redis-Schluessel und Auth-Hook

Durchsucht wurde der gesamte Weg eines HQ-Streams von der Token-Anforderung im Browser
(`web/src/lib/stream/`) ueber die Weiterreichung im chat-gateway (`routes/streaming.py`,
`stream_revoke.py`), die Ausstellung in media-svc (`routes.py`, `poller.py`, `streamkeys.py`)
bis zur Pruefung im mediamtx-auth-hook (`routes.py`, `shared.py`) samt der geteilten
Schluesselnamen in `shared/src/dcc_shared/streaming.py`. Zusaetzlich die Aufraeumpfade, die
Stream-Zustand beruehren: Bann, Rauswurf/Verlassen und Kontoloeschung.

Bestaetigt sind **zwei** Befunde. Der schwerste: Bann und Rauswurf raeumen zwar Voice,
Fernsteuerung, Standplatz-Geraete und die Lese-Token des Betroffenen auf, beenden aber
seine **eigene laufende Bildschirmuebertragung** nicht — der Gebannte sendet weiter in die
Community, aus der er gerade entfernt wurde, und verbliebene Mitglieder koennen sogar erst
nach dem Bann neu einsteigen.

## Befunde

### Hoch — Bann/Rauswurf beendet nicht die eigene laufende HQ-Uebertragung des betroffenen Nutzers

- **Stelle:** `services/chat-gateway/src/dcc_chat_gateway/routes/bans.py:268-305`
  (gleiche Luecke in `services/chat-gateway/src/dcc_chat_gateway/routes/guilds.py:616-645`)
- **Was falsch ist:** Der Aufraeumblock nach einem Bann fuehrt genau vier Schritte aus:
  `evict_user_from_guild_voice` (bans.py:272), `end_remote_sessions_for_member` (276),
  `remove_devices_for_member` (288) und `revoke_read_tokens_for_viewer` (298). Der letzte
  Schritt entzieht dem Betroffenen nur die Token, mit denen er **fremde** Streams anschaut
  (`stream_revoke.py` loescht ausschliesslich `stream:read-cache:<viewer>:*` und die daran
  haengenden `stream:token:*`). Nichts im gesamten chat-gateway fasst die **Sende-Seite** an:
  weder `stream:active:channel-<cid>-<uid>` noch der `stream:stopping`-Grabstein noch ein
  Stopp-Aufruf an media-svc. Ein `rg` nach `stream:active` im chat-gateway trifft nur
  `user_purge.py:272-274` (Kontoloeschung, nicht Bann) und lesende Stellen in
  `stream_chat.py:71`. Nachgeprueft wird die Mitgliedschaft danach nie wieder: der
  Publish-Token wird im auth-hook beim Verbindungsaufbau einmal verbraucht
  (`services/mediamtx-auth-hook/src/dcc_mediamtx_auth_hook/routes.py`, `_LUA_CONSUME_AND_MARK`),
  und der geschriebene `stream:active`-Datensatz haelt 6 Stunden
  (`services/mediamtx-auth-hook/src/dcc_mediamtx_auth_hook/config.py:22`,
  `publisher_ttl_seconds`). Das ist genau die Struktur, die fuer die Lese-Seite am 2026-08-13
  bewusst geschlossen wurde (`docs/plans/2026-08-13-lese-token-nach-rauswurf.md`); die
  Sende-Seite kommt dort nirgends vor.
- **Wie man es ausloest:** Nutzer A streamt per HQ (RTMPS oder WHIP) in einen Sprachkanal
  von Community X. Ein Moderator bannt oder wirft A waehrenddessen aus X. Der Sidecar auf
  A's Rechner pusht unveraendert weiter; `media-svc/poller.py:241-412` sieht den Publisher in
  der MediaMTX-Pfadliste, findet keinen `stream:stopping`-Grabstein und haelt den Kanal in
  `stream:channel:<cid>` weiter auf „live".
- **Was es kostet:** Der Bann erreicht sein eigentliches Ziel — die sofortige Trennung von
  der Community — fuer die Bildschirmuebertragung nicht. Verbliebene Mitglieder sehen den
  Stream nicht nur weiter, sie koennen ueber `GET /channels/{id}/whep` sogar **nach** dem Bann
  erstmals einsteigen: `routes/streaming.py:263-296` prueft Mitgliedschaft und `VIEW_CHANNEL`
  nur des **Zuschauers**, nie die des Streamers, und `media-svc/routes.py:366-457` liest
  ausschliesslich `stream:active` und mintet dafuer ein frisches Lese-Token. Spiegelbildlich
  beim freiwilligen Verlassen ein Datenabfluss zu Lasten des Austretenden: sein Bildschirm
  laeuft weiter zu Ex-Mitgliedern, waehrend die Community aus seinem Client verschwunden ist
  und er die Stopp-Bedienung gar nicht mehr sieht. Der offizielle Client versucht zwar zu
  stoppen (`web/src/lib/ws/handlers/voice.ts:25-37` und der `fireGuildDeleted`-Weg rufen
  `voice.disconnect()`, das in `web/src/lib/voice/livekit.svelte.ts:538-542` alle Slots
  beendet), verliert das Rennen aber typischerweise: `bans.py:269-271` reisst absichtlich
  **zuerst** den LiveKit-Raum ab, danach steigt `disconnect()` bei `#room === null` sofort
  aus (livekit.svelte.ts:531-533) und `#teardown` stoppt keinen Slot. Wer ohne
  LiveKit-Beitritt publiziert — `issue_stream_token` in `routes/streaming.py:179-227` verlangt
  nur Mitgliedschaft und `STREAM`, keine Voice-Praesenz — ist ohnehin nie betroffen.
- **Vorschlag:** Der Bann-/Rauswurf-Pfad braucht einen fuenften Aufraeumer analog zu
  `revoke_read_tokens_for_viewer`, der die Publish-Seite des Betroffenen in dieser Gilde
  beendet. Ein blosses Loeschen von `stream:active` reicht nicht — der Poller nimmt den
  Publisher beim naechsten Durchlauf wieder auf, solange kein `stream:stopping`-Grabstein
  liegt (`poller.py:260-276`), und der bereits aufgebaute Medienfluss zu bestehenden
  Zuschauern laeuft weiter. Noetig sind Grabstein plus ein serverseitiger Kick des Pfades
  ueber die MediaMTX-API; der bestehende `DELETE /channels/{id}/stream` in media-svc taugt
  nicht als Aufhaenger, weil er den Streamer aus dem Bearer ableitet
  (`media-svc/routes.py:461-490`) und ein Moderator damit seinen eigenen Stream stoppen
  wuerde.

### Mittel — Stream-Token meldet Zuschauern faelschlich 8 bit, obwohl ein Standplatz-Geraet mit 10 bit sendet

- **Stelle:** `web/src/lib/stream/starten.ts:81`
- **Was falsch ist:** `streamStarten()` setzt den `ten_bit`-Parameter der Token-Anfrage fuer
  Standplatz-Geraete hart auf `false` (`standplatz ? false : tenBitPossible()`), mit dem
  Kommentar in Zeile 80 „10 bit gibt es im Fernbetrieb nicht". Seit dem Commit
  „feat(standplatz): 10 Bit und HDR im Profil waehlbar" stimmt diese Praemisse nicht mehr:
  `web/src/lib/devices/profil.svelte.ts:200` uebersetzt den Profilhaken in
  `bit_depth: 10`, und `buildStartArgs()` in `web/src/lib/stream/settings.svelte.ts:434-437`
  setzt daraus bei AV1 und faehiger Karte tatsaechlich `cleaned.bit_depth = 10` an den
  Sidecar. `starten.ts` wurde dabei nicht mitgezogen. Der Docstring von `tenBitPossible()`
  (`settings.svelte.ts:59-64`) benennt genau diese Invariante: „EINE Definition fuer drei
  Verwendungen … Liefen die auseinander, bekaeme ein Zuschauer das eigene Fenster fuer einen
  8-bit-Stream oder umgekehrt." Der falsche Wert wird nirgends unterwegs korrigiert, sondern
  unveraendert durchgereicht: `media-svc/routes.py:314-315` (Token-Record) →
  `mediamtx-auth-hook/routes.py:188-189` (Kopie in `stream:active`) →
  `media-svc/routes.py:455` (`ten_bit` in `WhepOut`).
- **Wie man es ausloest:** Ein Standplatz-Profil mit Codec AV1 und gesetztem Haken „10 bit"
  einrichten, das Geraet wecken. `web/src/lib/devices/wecken.ts:302-306` reicht die
  Uebersteuerung an `streamStarten` durch; ist `stream.tenBitAvailable` auf dem
  Standplatz-Rechner wahr, sendet der Sidecar mit 10 bit, das Token meldet 8 bit.
- **Was es kostet:** Der Schutzriegel in `web/src/lib/stream/hqStreamManager.svelte.ts:450`
  faellt aus. Er verhindert normalerweise, dass ein Browser-Zuschauer sich ueberhaupt mit
  einem 10-bit-Stream verbindet (Begruendung im Kommentar darueber, gemessen 2026-08-01:
  Chromes Decoder steigt mitten im Lauf aus, `dav1d` kann kein 10 bit, der Zuschauer fordert
  dann endlos Vollbilder an — „der Schaden trifft also nicht nur diesen Zuschauer, sondern
  jeden anderen im selben Stream"). Mit `ten_bit=false` landet der Zuschauer genau auf dem
  Weg, den der Code ausdruecklich sperren will. Dieselbe Fehlentscheidung trifft die
  Player-Seite (`web/src/lib/player/store.svelte.ts:198`,
  `web/src/lib/player/useNativePlayback.svelte.ts:89`). Betroffen sind die uebrigen
  Zuschauer im Sprachkanal; der weckende Steuernde selbst landet ueber `fensterOeffnen`
  ohnehin im nativen Fenster.
- **Vorschlag:** In `starten.ts:81` denselben Wunsch/Erfuellbarkeits-Ausdruck verwenden, den
  `buildStartArgs` fuer den Standplatz bildet — also den Wunsch aus
  `standplatz.uebersteuerung.bit_depth` gegen `codec === 'av1' && stream.tenBitAvailable`
  pruefen, statt hart `false` zu senden. Sauberer waere, diese Ableitung einmal in
  `settings.svelte.ts` neben `tenBitPossible()` abzulegen und von beiden Stellen aufzurufen,
  damit die im Docstring geforderte „EINE Definition" wieder gilt. Den veralteten Kommentar
  in Zeile 80 mitziehen.

## Verworfen

- **Lese-Token-Cache und Token-Datensatz werden nicht atomar geschrieben**
  (`services/media-svc/src/dcc_media_svc/routes.py:435`) — der Code holt sich den Cache-Platz
  per `SET NX` und schreibt erst danach den Token-Datensatz; ein Fehlschlag laesst kein
  dauerhaftes Schloss zurueck, weil der Cache-Eintrag dieselbe TTL wie das Token traegt und
  von selbst verfaellt.
- **Bann-Sperre kann ein gerade neu ausgestelltes Lese-Token verpassen**
  (`services/chat-gateway/src/dcc_chat_gateway/stream_revoke.py:99`) — ein Rennen von
  Millisekunden gegen eine bereits bestehende, viel groessere Luecke; kein belegbares
  Fehlverhalten im Betrieb.
- **WHIP-Push-URL verdoppelt den Slash bei Trailing-Slash in MEDIAMTX_PUBLIC_BASE**
  (`services/media-svc/src/dcc_media_svc/routes.py:225`) — setzt eine Fehlkonfiguration
  voraus, die in keiner ausgelieferten Konfiguration vorkommt.

## Nicht nachvollzogen

Zwei Nebenbehauptungen aus dem ersten Befund halten dem Code nicht stand und sind oben
entsprechend korrigiert eingearbeitet, nicht als eigener Fehler ausgewiesen:

- „Selbst ein wohlverhaltener offizieller Client beendet die Uebertragung nicht" — er
  versucht es sehr wohl (`web/src/lib/ws/handlers/voice.ts:25-37` →
  `web/src/lib/voice/livekit.svelte.ts:538-542`), verliert aber das Rennen gegen den vorher
  abgerissenen LiveKit-Raum.
- „Es fehlt ein `DELETE /channels/{id}/stream` im Bann-Pfad" — dieser Endpunkt kann per
  Bauart nur die eigene Uebertragung des Aufrufers stoppen
  (`services/media-svc/src/dcc_media_svc/routes.py:461-490`) und taugt deshalb nicht als
  Abhilfe.
