# Bughunt Fernsteuerung: Vorrang, Plaetze, Zeigerform, Transportwechsel

Durchsucht wurde der Fernsteuer-Weg vom Steuernden bis in die Injektion: der Renderer-Anteil
(`web/src/lib/remote/{session.svelte.ts,p2p.ts,buchfuehrung.ts,vorrang.ts,zeigerform.ts}`), die
Geraete- und Weckruf-Seite (`web/src/lib/devices/`, `services/chat-gateway/.../routes/ws_device_handlers.py`),
der Gateway-Durchreichepfad fuer `remote_input`/`remote_signal` sowie die Windows-Seite
(`streaming/win-hq-sidecar/src/remote_input/`: `ausfuehrung.rs`, `injektion.rs`, `druck.rs`, `wache.rs`,
`zeigerform.rs`). Ein Befund ist bestaetigt und am Code nachvollzogen; er ist zugleich der schwerste:
beim Rueckfall vom direkten P2P-Kanal auf den Serverweg wird ein frisch gedrueckter Knopf beziehungsweise
eine frisch gedrueckte Taste doppelt an den Host geschickt. Zwei weitere gemeldete Punkte tragen nicht
und stehen unter „Verworfen". Es wurde ausschliesslich gelesen, keine Tests und keine Builds ausgefuehrt.

## Befunde

### Mittel — Beim Rueckfall vom P2P-Eingabekanal auf den Serverweg wird ein frisch gedrueckter Knopf/eine frisch gedrueckte Taste doppelt an den Host geschickt

- **Stelle:** `web/src/lib/remote/session.svelte.ts:240` (im Zusammenspiel mit `web/src/lib/remote/p2p.ts:185-200` und `web/src/lib/remote/buchfuehrung.ts:137-155`)
- **Was falsch ist:** `remoteP2P.senden()` bucht in `p2p.ts:186-187` **jede** ausgehende Nachricht
  unbedingt in die Gedrueckt-Buchfuehrung (`for (const frame of frames) this.#buch.buchen(frame)`), und
  zwar **bevor** in `p2p.ts:189-200` ueberhaupt geprueft wird, ob der DataChannel noch traegt. Ist der
  Kanal gerade weggebrochen (`#ueberKanal === true`, `kanalOffen === false`), liefert die Funktion
  `'ws_mit_hello'` zurueck. `sendInput()` schickt daraufhin erst das Hello-Buendel (Zeile 227), meldet
  den Rueckweg (`wsHelloGesendet()`, Zeile 228) und sendet dann in Zeile 235-237 alle Buendel aus
  `remoteP2P.nachziehBuendel()`. Dieses Nachzieh-Buendel liest `#unten` (`buchfuehrung.ts:140`) — und
  darin steht der Druck aus genau dieser Nachricht bereits drin. Anschliessend faellt der Code **ohne
  `return`** auf Zeile 240 durch und sendet die urspruengliche `frames`-Nachricht ein zweites Mal.
  Damit geht derselbe Down-Frame zweimal ueber die geordnete WS-Verbindung an den Host. Weder der
  Gateway (er parst Frames nicht) noch der Sidecar faengt das ab: `ausfuehrung.rs:98-99` ruft
  `injektion::maus` und `ausfuehrung.rs:132-133` `injektion::taste` bedingungslos bei jedem Down-Frame
  auf; `druck.rs` ist ein reines `HashSet` und kein Tor. Der Vergleichspfad beim Vorrang-Ende
  (`vorrang.ts:254`) ruft `nachziehBuendel()` dagegen standalone, ohne die aktuelle Nachricht zusaetzlich
  zu wiederholen — die Asymmetrie zeigt, dass die Doppelsendung nicht beabsichtigt ist. In den
  Entwurfsdokumenten (`docs/plans/2026-08-12-input-wire-protokoll-v2.md`,
  `docs/plans/2026-08-13-fernsteuerung-p2p-eingabeweg.md`) ist eine bewusste Doppelung nirgends erwaehnt.
- **Wie man es ausloest:** Eine laufende Sitzung laeuft ueber den direkten DataChannel. Der Kanal
  bricht ab (Netz-Aussetzer, NAT-Timeout, Verbindungswechsel) und im selben Umlauf sendet der Steuernde
  eine Nachricht, die einen **neuen**, bis dahin nicht gehaltenen Tastendruck oder Mausklick enthaelt.
  `senden()` gibt in diesem Umlauf `'ws_mit_hello'` zurueck.
- **Was es kostet:** Der Host bekommt fuer einen physischen Druck zwei getrennte Down-Ereignisse kurz
  hintereinander. Bei der Tastatur ist das von einer Auto-Wiederholung nicht zu unterscheiden und meist
  folgenlos; der belastbare Schaden ist das doppelte `MOUSEEVENTF_*DOWN` ohne dazwischenliegendes Up
  (`injektion.rs:66-81`), das echte Hardware so nie erzeugt. Anwendungen und Spiele, die jeden Down als
  eigene kantengetriggerte Aktion werten (Sprung, Schuss, Umschalter, Faehigkeit), loesen die Aktion
  zweimal aus, obwohl nur einmal gedrueckt wurde. Ein Klemmen entsteht nicht, das spaetere Up gibt
  beides frei. Alles ohne Fehlermeldung, und der Ausloeser ist ein enges Rennen — die Schwere liegt am
  unteren Rand von „mittel". Kein automatischer Test faengt es, das Modul ist reines TypeScript und im
  Web gibt es kein Vitest.
- **Vorschlag:** Den `ws_mit_hello`-Zweig so abschliessen, dass die aktuelle Nachricht nicht ein
  zweites Mal hinausgeht — entweder durch ein `return` nach dem Nachziehen (das Nachzieh-Buendel traegt
  den frischen Druck bereits) oder dadurch, dass in `p2p.ts` die Buchung erst nach der
  Transportentscheidung erfolgt, damit `nachziehBuendel()` im Rueckfall nur den vorherigen Stand
  behauptet. Die zweite Variante haelt den Vorrang-Pfad und den Rueckfall-Pfad symmetrisch.

## Verworfen

- **Geraete-Streamplaetze werden serverseitig auf 0..7 begrenzt, obwohl Stream-Plaetze bis 98 gueltig
  sind** (`services/chat-gateway/src/dcc_chat_gateway/routes/ws_device_handlers.py:176`): Der Deckel ist
  in `_plaetze()` ausdruecklich als Schutz gegen eine Client-Behauptung dokumentiert, und die Folge einer
  verworfenen Zahl ist laut derselben Stelle ein fehlendes Abzeichen, keine kaputte Sitzung —
  Geraete-Plaetze folgen der Bildschirmliste und liegen nicht im Bereich der freien Stream-Slots.
- **Sofortfehler des Weckrufs (4060/4061) werden im Frontend nie ausgewertet**
  (`web/src/lib/devices/wecken.ts:186`): `geraetWecken()` meldet per Vertrag nur „nicht hinausgegangen";
  Ablehnungen des Gateways kommen als `op:'error'` zurueck und werden auf dem gemeinsamen
  Fernsteuer-Fehlerweg behandelt, der Rueckgabewert ist also nicht die Auswertungsstelle.

## Nicht nachvollzogen

Keine. Der bestaetigte Befund liess sich an allen genannten Zeilen (`session.svelte.ts:214-241`,
`p2p.ts:175-232`, `buchfuehrung.ts:137-155`, `vorrang.ts:250-255`, `ausfuehrung.rs:83-134`) unveraendert
wiederfinden.
