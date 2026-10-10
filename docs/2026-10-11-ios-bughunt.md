# iOS-Bughunt 2026-10-11

Branch `feat/ios`, Stand `c0c67af2`. Nur gesucht und belegt, nichts behoben.
Reihenfolge der Prüfung nach Risiko: (1) nativer Sprachweg, (2) die
Audio-Änderungen vom 2026-10-10 im Web-Weg und an den Anrufen, (3) der Rest des
Branches gegen `origin/main` (Backend-Push/VoIP sowie die übrigen Web- und
Hüllen-Teile, je von einem eigenen Durchgang).

**Belegt** heisst: Code-Pfad vollständig nachverfolgt, wo möglich mit einem
Lauf (Node-Nachbau oder Simulator). **Vermutet** heisst: der Pfad steht, die
Wirkung hängt an Laufzeit oder Gerät. Was nur am Gerät zu klären ist, steht
dabei. Das iPhone wurde nicht angefasst; der Simulator nur über den
Debug-Prüfpfad (`-PulseSpracheProbe`) gegen den lokalen LiveKit.

Prüfläufe nebenher: `pnpm test:unit` 1436/1436 grün, `pnpm check` 0 Fehler.
Keiner der Funde unten wäre davon erfasst worden.

---

## Kritisch

### K1 — Die Versionsweiche `nativerSprachwegDa()` ist auf iOS immer wahr — auf jedem älteren App-Bau ist die Sprache tot

`web/src/lib/platform/iosSprache.ts:52` und `:87-96`

Die Weiche soll erkennen, ob die Hülle das `SprachePlugin` kennt, und prüft
dafür `window.Capacitor.Plugins.SprachePlugin !== undefined`. Dasselbe Modul
ruft aber beim Import `registerPlugin('SprachePlugin')` — und Capacitors
`registerPlugin` schreibt **unbedingt** `Plugins[pluginName] = proxy`
(`@capacitor/core` 8.4.0, `dist/index.js`, `registerPlugin`). Ab dem ersten
Import dieser Datei ist der Eintrag also immer da, ob die Hülle das Plugin hat
oder nicht. Der Kommentar daneben („die Frage ist nicht, ob es da ist, sondern
ob die Hülle es kennt") benennt genau das Problem, die Prüfung löst es nicht.

Ablauf auf einem App-Bau ohne `SprachePlugin` (jeder heute ausgelieferte, und
jeder Bau, dem ein `cap sync` das Plugin aus `packageClassList` geworfen hat):
Beitritt → `nativerSprachwegDa()` = `true` → `#nativVerbinden` →
`spracheBeitreten` wirft `UNIMPLEMENTED: "SprachePlugin" plugin is not
implemented on ios` → Kanal bleibt „nicht verbunden" mit dieser Fehlermeldung.
Kein Rückfall auf den Web-Weg. Dazu: `VoiceAusgabeMenue.svelte:95` zeigt die
Hörmuschel an, `audioRoute.ts:109` schickt jede Ausgabe-Wahl an das fehlende
Plugin (unbehandelte Ablehnung), der alte Weg (`iosTonWegSetzen`) wird nie
erreicht.

Da die Oberfläche zentral ausgeliefert wird, trifft das **jedes** iOS-Gerät mit
älterem Bau in dem Moment, in dem dieser Web-Stand deployt wird. Es entwertet
ausserdem den Zweck von `scripts/ios-release-check.sh` (fehlendes Plugin in
`packageClassList`): der Ausfall wäre nicht mehr „das Plugin tut nichts",
sondern „keine Sprache".

**Belegt (Node-Nachbau, rot):** `iosSprache.ts` mit esbuild gebündelt, in Node
mit nachgebauter iOS-Hülle OHNE das Plugin geladen:

```
vor dem Import: Plugins.SprachePlugin = undefined
nach dem Import: Plugins.SprachePlugin definiert = true
nativerSprachwegDa() = true
beitreten wirft: UNIMPLEMENTED - "SprachePlugin" plugin is not implemented on ios
```

Skript im Anhang A. Die tragfähige Frage wäre `Capacitor.isPluginAvailable`
bzw. `Capacitor.PluginHeaders` — das ist ein Hinweis, keine Änderung.

### K2 — Stream schauen im Sprachkanal: unser eigenes Plugin stellt LiveKits Session auf `.playback` und deaktiviert sie danach

`web/src/lib/platform/iosTon.ts:223-249`, `:364-378` ·
`web/src/lib/stream/hqStreamManager.svelte.ts:382`, `:709` ·
`mobile/ios/App/App/AudioSessionPlugin.swift:232-236`, `:307-322`

Auf dem nativen Weg meldet sich der Sprachkanal bewusst NICHT bei `iosTon`
an (`tonVoice('sprachkanal', …)` läuft nur im Web-Weg). Öffnet man dann eine
HQ-Übertragung, meldet `hqStreamManager` Ton an, und `zielModus(false, 1)`
ergibt `wiedergabe` → `AudioSessionPlugin.setPlaybackMode` →
`setCategory(.playback)` + `setActive(true)` auf
`AVAudioSession.sharedInstance()` — **derselben** Session, die LiveKits
`AudioManager` im selben Prozess führt. `.playback` hat keinen Eingang. Beim
Schliessen der Übertragung: `zielModus(false, 0)` = `aus` →
`setVoiceActive(false)` → `setActive(false, .notifyOthersOnDeactivation)` auf
der laufenden Sprach-Session.

LiveKit stellt das nicht von selbst zurück: `AudioSessionEngineObserver`
richtet die Session nur bei einer Änderung der Anforderungen (Wiedergabe/
Aufnahme an/aus) oder von `isSpeakerOutputPreferred` neu ein
(`AudioSessionEngineObserver.swift:147-171`, `guard … != oldState… else
return`), und aktiviert nur aus dem Zustand „beides aus" heraus (`:230-238`).
Eine fremd umgestellte Kategorie bleibt also für den Rest des Raums stehen.

Zweite Hälfte desselben Falls: solange der native Raum steht, ist WebKits
Session `ambient` (`iosSprache.ts:138-149`). Das gilt auch für den Ton der
Übertragung, die ja in der WebView läuft — `ambient` folgt dem
Klingel-Schalter und endet beim Sperren. Der Kommentar dort nennt nur die
Oberflächen-Töne als Preis; der Stream-Ton ist der Hauptinhalt.

Derselbe Mechanismus greift bei einem **Direktanruf während eines nativen
Sprachkanals** (Anrufe laufen weiter im Web-Weg): `tonVoice('anruf', true)` →
`setVoiceActive(true)` richtet LiveKits Session mit `.defaultToSpeaker` neu ein
(Hörmuschel weg), das Auflegen → `setActive(false)` auf derselben Session.

Der Entwurf (§6) sagt „Unser `AudioSessionPlugin` fasst sie im Sprach-Betrieb
auf iOS nicht mehr an"; §8 nennt Stream+Sprache als grösstes Risiko, aber als
Frage zweier Prozesse — tatsächlich ist die zweite Partei unser eigenes Plugin
im selben Prozess.

**Belegt (Pfad):** JS-Seite im Node-Nachbau (Anhang B) — Stream an, Stream aus
ergibt genau `setPlaybackMode()` und danach `setVoiceActive({aktiv:false})`.
Native Wirkung aus dem Swift-Quelltext und LiveKit 2.17.0. **Hörbare Wirkung
(Mikrofon stumm für die anderen, Ton weg nach dem Schliessen) nur am Gerät
belegbar** — Messplan §8 Punkt 2 trifft genau das.

### K3 — Jedes Anrufende schickt einen VoIP-Push, auf den die Hülle keinen Anruf meldet

`mobile/ios/App/App/AnrufPlugin.swift:181-202`, `:87-90` ·
`services/chat-gateway/src/dcc_chat_gateway/anruf_push.py:146-170` ·
`routes/anrufe.py:124`

`_beenden` schickt bei JEDEM Anrufende (Auflegen, Ablehnen, Zeitablauf)
`art=abbruch` als VoIP-Push an alle Teilnehmer, ohne Offline-Filter — also auch
an das Gerät, das gerade selbst aufgelegt hat und im Vordergrund ist. Die Hülle
beendet darauf nur den Anruf und ruft `completion()`, ohne
`reportNewIncomingCall`. Seit iOS 13 beendet das System eine App, die auf einen
VoIP-Push keinen Anruf meldet, und entzieht bei Wiederholung die VoIP-Pushes
ganz — dann klingelt bei geschlossener App gar nichts mehr. Der Kommentar
„Ein überzähliger Abbruch-Push ist harmlos" (`anruf_push.py:158`) stimmt
deshalb nicht. Dieselbe Lücke im Klingel-Weg: kommt der Push für einen Anruf,
den die WebSocket schon gemeldet hat, kehrt `klingeln` ohne Meldung zurück
(`:87-90`).

Der Kreis ist grösser als „wer geklingelt hat": `_teilnehmer` schliesst den
Initiator ein, und bei Gruppen bekommt jedes Mitglied den Abbruch, auch wer nie
per Push geklingelt hat (`routes/anrufe.py:72-82`). Der Test
`test_abbruch_prueft_NICHT_auf_offline` schreibt das Verhalten fest.

**Belegt am Code + dokumentierte Plattform-Regel; Wirkung nur am Gerät
beobachtbar**, und nur dort, wo ein APNs-VoIP-Schlüssel konfiguriert ist
(sonst fällt der Push fail-open aus).

---

## Ernst

### E1 — Der Taub-Stand der Hülle überlebt das Auflegen und wird beim Beitritt überschrieben, ohne die Lautstärken nachzuziehen → man hört Teilnehmer nicht

`mobile/ios/App/App/SpracheRaum.swift:66`, `:143`, `:148-157` ·
`SpracheRaumTaub.swift:19-22` · `SpracheRaumZustand.swift:157-166` ·
`web/src/lib/voice/livekit.svelte.ts:860-869`, `:2226`

`SpracheRaum.taub` wird beim Verlassen absichtlich NICHT zurückgesetzt
(„eine Entscheidung des Nutzers … dasselbe Verhalten wie im Web"). Das Web
setzt beim Auflegen aber `deafened = false` (`#teardown`), übergibt bei jedem
Beitritt `startTaub` ausdrücklich, und nur ein Kanal**wechsel** trägt den Stand
mit. Der Swift-Wert wird erst am ENDE von `beitreten` überschrieben
(`taub = taubStart`, Zeile 143). Dazwischen:

1. Taub stellen → Auflegen → später irgendeinem Kanal beitreten.
2. `r.connect` ist durch, die vorhandenen Teilnehmer werden abonniert, während
   `setMicrophone` noch veröffentlicht. `didSubscribeTrack` →
   `taubAufNeueSpur` sieht das alte `taub = true` → Lautstärke 0, alter Wert
   gemerkt.
3. Zeile 143 setzt `taub = false` — ohne `lautstaerkenAnwenden(false)`. Die
   Spuren bleiben auf 0. Die Oberfläche zeigt „nicht taub"; man hört diese
   Teilnehmer nicht, bis man einmal taub und wieder zurück schaltet.

Zweite Folge derselben Ursache: das lokale `didPublishTrack` (Mikrofon) läuft
über LiveKits Delegat-Warteschlange und schickt `eigenerZustand` mit dem alten
`taub: true` und `mikro: true`. `#nativEigenerZustand` übernimmt
`deafened = true` und meldet wegen des Mikrofon-Wechsels sofort
`sendVoiceSelfState(…, deafened=true)` samt Resume-Eintrag. Das spätere
`taub: false` ändert das Mikrofon nicht und wird **nicht** gemeldet — alle
anderen sehen einen tauben Teilnehmer, ein Reload kommt taub zurück.

Gleiche Klasse, zweiter Auslöser: Taub stellen WÄHREND des Beitritts
(`setDeafened` → `taubStellen(true)`) wird von Zeile 143 ebenso überschrieben;
die schon auf 0 gestellten Spuren bleiben stumm.

**Belegt am Code-Pfad** (Swift, LiveKit-Delegat-Warteschlange
`MulticastDelegate.notify` = `_queue.async`). Dass das Abonnieren in das
Zeitfenster fällt, ist **vermutet** (bei LiveKit typisch: Abo kommt mit der
Primärverbindung, das Veröffentlichen braucht eine eigene Aushandlung). Der
Simulator-Prüfpfad kann die Folge nicht fahren (er beginnt immer mit
`taub = false`).

### E2 — Auf dem nativen Weg wird `voiceState.channelId`/`connected` nie gesetzt — Watch-Party-Host beendet die Party beim Wegnavigieren

`web/src/lib/voice/livekit.svelte.ts:740-832` (setzt sie nicht; nur der
Web-Weg bei `:613-614`) · `voice/state.svelte.ts:55-57` ·
`components/WatchPartyTile.svelte:266-271` ·
`components/StreamGrid.svelte:115-118` · `ws/streamDiff.ts:29` ·
`components/channels/ChannelVoiceSection.svelte:171` ·
`components/ShortcutHost.svelte:97-128`

`voiceState` ist der schlanke Spiegel, den alles ohne `livekit-client` liest.
`#nativVerbinden` setzt `this.state`/`channelId`, aber nie
`voiceState.channelId`/`voiceState.connected`. Damit ist
`inVoiceChannel(cid)` auf iOS immer `false`:

- `WatchPartyTile` schickt beim Unmount (= blosses Wegnavigieren aus dem
  Kanal) `watch_leave`. Für den **Host** beendet das die Party für alle
  (CLAUDE.md: „Unmount (`watch_leave`) beendet sofort") — auf dem iPad, wo es
  den Start-Knopf gibt. Zuschauer fliegen bei jeder Navigation aus der Party.
- `StreamGrid` schliesst beim Wegnavigieren jede HQ-, Kamera- und
  Party-Kachel, statt sie ins Eckfenster zu geben.
- `fireStreamDiff` spielt keine Stream-Töne für den eigenen Kanal.
- Kein „verbunden"-Punkt in der Kanalliste; Tastenkürzel (iPad mit Tastatur)
  für Stumm/Taub/Auflegen tun nichts.

**Belegt am Code** (einzige Schreibstellen sind `livekit.svelte.ts:613-614`,
`:921-922`, `:1751`, `:2257-2258`).

### E3 — Mikrofon schalten scheitert nativ → die Oberfläche bleibt auf „an" und meldet allen ein offenes Mikrofon

`web/src/lib/voice/livekit.svelte.ts:989-1006`

Nativer Zweig: `this.micEnabled = on` vorab, dann `spracheMikrofon(on)`; bei
einem Fehlschlag wird nur geloggt (`return null`), `micEnabled` bleibt auf dem
Wunsch, und `#publishSelfState()` meldet ihn an den Gateway. Ein
`eigenerZustand` kommt nicht (die Hülle wirft vor `schickeEigenen`). Der
Web-Weg rollt dagegen zurück und setzt `error`. Der Kommentar an derselben
Stelle („Nicht schlucken: ein stumm gebliebenes Mikrofon, das die Oberfläche
für offen hält, ist der teuerste Zustand") beschreibt genau, was der Code
tut.

Ablauf: Beitritt mit verweigerter Mikrofon-Erlaubnis (Hülle lässt den Raum
stehen, `mikrofonFehler`) → Nutzer tippt „Mikrofon an" → Hülle wirft → Knopf
zeigt offen, die eigene Kachel stumm, alle anderen sehen ein offenes Mikrofon,
niemand hört etwas, keine Meldung.

**Belegt:** Code-Pfad, und im Simulator, dass die Hülle in genau diesem Fall
wirft (`Probe MIKROFON fehlgeschlagen: Audio Engine Error … -4010`).

### E4 — Eingehender Anruf auf iOS: nach der Annahme ist die App-Session auf beiden Wegen nicht aktiv

`mobile/ios/App/App/AnrufPlugin.swift:101-117`, `:124-131`, `:238-242` ·
`AudioSessionPlugin.swift:203`, `:211-213` ·
`web/src/lib/anrufe/anruf.svelte.ts:323-356`, `:606`

Der Kommentar bei `tonVoice('anruf', true)` sagt: ohne aktive Session kein
Mikro-Routing und kein System-Echo-Auslösen, „nur ein über CallKit
angenommener Anruf hatte Ton". Nach dem Umbau gilt:

- **Im Web angenommen:** Jeder per WebSocket gemeldete Anruf geht auch an
  CallKit (`nativAnkommen` → `klingeln`), und `klingeln` setzt
  `callkitAktiv = true`, sobald CallKit ihn annimmt (Zeile 116).
  `annehmen()` ruft `#verbinden()` → `tonVoice('anruf', true)` →
  `setVoiceActive` sieht `callkitAktiv = true` und **überspringt
  `setActive(true)`** — CallKit aktiviert aber auch nicht, der Anruf wurde dort
  ja nicht angenommen. Erst danach beendet `nativBeenden()` den CallKit-Anruf.
  Und weil `iosTon` `angewandt = 'voice'` schon gesetzt hat, wird nie
  nachgeholt.
- **Über CallKit angenommen:** CallKit aktiviert die Session (`didActivate`),
  aber `annehmen()` ruft nach dem Verbinden `nativBeenden()` →
  `reportCall(endedAt:reason:.remoteEnded)` → CallKit zeigt „Anruf beendet",
  deaktiviert die Session (`didDeactivate`), und die App verliert den
  CallKit-Schutz im Hintergrund — während das Gespräch im Web weiterläuft.
  `nativBeenden` war für Android („Klingel-Notification weg") gedacht und
  wurde auf iOS mitgezogen.

**Belegt am Code-Pfad; hörbare Wirkung nur am Gerät.**

### E5 — Erweiterung zu „kein Abgleich nach Reload": der native Beitritt meldet seinen Stand nicht, und der Resume-Eintrag fehlt dann — zurück bleibt ein Raum ohne Oberfläche

`web/src/lib/voice/livekit.svelte.ts:790-832` gegen `:690-698`, `:2267-2289` ·
`resumeVoiceIfPending` `:2337-2355`

Der Web-Weg ruft nach jedem Beitritt `#publishSelfState()` (mit Begründung:
auch wenn kein Setter lief). Der native Weg nie; er meldet nur, wenn ein
`eigenerZustand` das Mikrofon kippt. Startet man ohne Mikrofon (Erlaubnis
verweigert, Gerät belegt, Simulator) oder ohne dass ein Zwischenereignis den
Wechsel sieht, bleibt `mikroVorher === e.mikro` → kein
`sendVoiceSelfState` (andere sehen kein Stumm-Zeichen) und **kein
`#saveResume`**.

Folge bei einem Reload (Update-Toast, WebContent-Absturz im Hintergrund): kein
Resume-Eintrag → das Web hält sich für getrennt, der native Raum läuft weiter,
für alle anderen sitzt man im Kanal. Das native Blatt bleibt über der neu
geladenen Seite stehen (es hängt am Brücken-Controller); wurde es vorher
weggewischt, gibt es keinen Weg hinaus ausser einem neuen Beitritt oder dem
Beenden der App. Gleiches, wenn der Resume-Eintrag existiert, der Token-Abruf
nach dem Reload aber scheitert (`clearVoiceResume`) — dann ist es ein
unsichtbarer Raum **mit offenem Mikrofon**.

**Belegt am Code** (Simulator-Lauf zeigt den Mikrofon-Fehlschlag beim
Beitritt, der den Fall auslöst).

### E6 — Direktanruf (Web-Weg): ein Wegwechsel mitten im Gespräch aktiviert unsere Session neu — die am 2026-10-10 gemessene Falle

`web/src/lib/platform/iosTon.ts:315-330` · `tonModus.ts:80-88` ·
`AudioSessionPlugin.swift:207-213`

Während eines Anrufs steht `'anruf'` in `voiceQuellen`. AirPods einsetzen oder
Kabel ziehen → `routeGewechselt` mit neuem Tonweg → `wegAntwort` =
`neu-einrichten` → `setVoiceActive(true)` → `setCategory` + `setActive(true)`.
Genau das hat `iosTon.ts` (Zeile 281ff.) am Gerät gemessen: jedes eigene
`setActive(true)` unterbricht WebKits Session und räumt dessen laufende
Aufnahme ab, „kein Mute-Zyklus half". Der Sprachkanal ist dem durch den
nativen Weg entkommen, der Anruf läuft weiter über WebKit (Etappe 4 steht
aus).

**Vermutet (Gerät)**, Pfad belegt; die Wirkung ist die vom Projekt selbst
gemessene.

---

## Mittel

### M1 — Abbruch von aussen (Netz, Server) räumt auf dem nativen Weg nichts ab

`web/src/lib/voice/livekit.svelte.ts:750-756` ·
`SpracheRaumZustand.swift:185-197`

Der Web-Weg ruft bei `Disconnected` `#teardown()` (`:1752`). Der native
`verbindung`-Hörer setzt nur `state`/`error`. Es bleiben: das Wachhalten
(`isIdleTimerDisabled`, der Bildschirm geht nie mehr aus, bis irgendwann ein
Teardown läuft), WebKits Session auf `ambient` (s. K2), `voice.nativ = true`,
`channelId`, der eigene Presence-Eintrag, kein `sendVoiceSelfState(null)`.
Nativ bleibt `SpracheRaum.raum` ein toter Raum stehen. Ein Admin-Rauswurf
heilt sich über `voice_disconnect`; Netzverlust und Serverneustart nicht.
**Belegt am Code.**

### M2 — Gescheiterter nativer Beitritt lässt WebKit auf `ambient` stehen

`web/src/lib/platform/iosSprache.ts:159-166` · `livekit.svelte.ts:818-824` ·
`SpracheRaum.swift:93-97`

`spracheBeitreten` setzt `ambient` vor dem Ruf; scheitert er, setzt niemand
`auto` zurück (der Fehlerzweig ruft `spracheVerlassen` nicht). Danach folgt
jeder Stream-Ton in der WebView dem Klingel-Schalter und endet beim Sperren —
bis zum nächsten erfolgreichen Verlassen. Nativ bleibt `raum` auf dem
gescheiterten Raum stehen. **Belegt am Code.**

### M3 — Die native Ansicht springt nach JEDEM Beitritt auf, auch ohne Blick auf den Kanal

`web/src/lib/voice/livekit.svelte.ts:825-830` ·
`SprachePlugin.swift:139-149`

Beide Kommentare begründen, warum das Zeigen beim Web liegt: „die Hülle weiss
nicht, ob der Nutzer gerade auf den Kanal schaut … Das Web weiss es". Der Code
fragt das nicht ab, sondern ruft `ansichtOeffnen()` nach jedem
`#nativVerbinden` — also auch nach `voice_pull` (ein Moderator holt einen in
den Kanal, das Vollbild-Blatt legt sich über die offene Unterhaltung), nach
dem Resume und nach Auto-Connect. **Belegt am Code.**

### M4 — Lautstärke je Teilnehmer und Gesamtlautstärke tun auf dem nativen Weg nichts

`web/src/lib/voice/livekit.svelte.ts:1569-1584` ·
`components/VoiceChannelMembers.svelte`

`setUserVolume`/`setOutputVolume`/`setLimiterEnabled` gehen an
`RemoteAudioElements`, die es nativ nicht gibt; die gespeicherten Werte
erreichen die Hülle nie. Der Regler wird auf iOS trotzdem angeboten — dieselbe
Klasse, die der Taub-Knopf bis zum 2026-10-10 hatte („ein Knopf, der nichts
tut"). Der Entwurf führt `lautstaerke({identitaet, wert})` als Befehl; er ist
nicht gebaut. **Belegt am Code.**

### M5 — Auflegen im CallKit-Bildschirm eines angenommenen Anrufs lehnt ab statt aufzulegen

`mobile/ios/App/App/AnrufPlugin.swift:221-227` ·
`web/src/lib/anrufe/anruf.svelte.ts:703`, `:366-379` · `routes/anrufe.py:219-233`

`CXEndCallAction` meldet immer `ablehnen`, auch wenn der Anruf schon
angenommen ist; das Web ruft dann `anrufAblehnen`, der Server antwortet bei
laufendem Anruf `409 anruf_laeuft`, das wird verschluckt, lokal wird
abgeräumt. Die Gegenseite bleibt in einem Anruf mit niemandem. Erreichbar im
Fenster zwischen CallKit-Annahme und `nativBeenden` — bei E2EE bis zu 10 s
Schlüssel-Wartezeit. **Belegt am Code.**

### M6 — Rennen: ein überholter Beitritt räumt den neueren Raum ab

`web/src/lib/voice/livekit.svelte.ts:784-789` · `SpracheRaum.swift:89-97`,
`:252-263`

Überholt ein neuerer `connect()` einen laufenden nativen Beitritt, ruft der
alte nach seiner Rückkehr `spracheVerlassen()`. Das trifft das GEMEINSAME
`SpracheRaum.raum` — wenn der neue Beitritt ihn schon gesetzt hat, also den
neuen Raum, und setzt WebKit auf `auto` (die Hörmuschel-Falle). Ebenso wirken
`stummSchalten` und `taub = taubStart` eines alten, noch laufenden
`beitreten` auf den neuen Raum, weil sie `raum`/`taub` statt des lokalen `r`
lesen. Fenster: Beitreten → Auflegen → Beitreten innerhalb eines
Verbindungsaufbaus. **Vermutet** (Zeitfenster), Pfad belegt.

---

## Gering

### G1 — `verbindung` kommt als `.connected`, nicht als `connected`

`SpracheRaumZustand.swift:178-183` · `livekit.svelte.ts:751-753` ·
LiveKit `Extensions/CustomStringConvertible.swift:145-154`

`ConnectionState` hat ein eigenes `description` mit Punkt. `"\(state)"` ergibt
`.connecting`, `.connected`, `.reconnecting`. Der Web-Hörer vergleicht mit
`'connected'`/`'disconnected'` — der Zweig aus `didUpdateConnectionState`
greift nie (nur das wörtliche `"disconnected"` aus `didDisconnectWithError`
kommt an). Wiederaufbau wird nie angezeigt; die Kopfzeile der nativen Ansicht
zeigt `.reconnecting` roh. **Belegt im Simulator:** derselbe Ausdruck im Log —
`Verbindung .connecting → .connected`.

### G2 — `iosTon` merkt sich eine Betriebsart, bevor sie angewandt ist

`web/src/lib/platform/iosTon.ts:227-244` — `angewandt = ziel` steht vor dem
`await`; scheitert `setVoiceActive`, wird bei gleichem Ziel nie erneut
versucht. **Vermutet** (ob es in der Praxis scheitert).

### G3 — CallKit zeigt per WebSocket gemeldete Videoanrufe als Sprachanruf

`AnrufPlugin.swift:264-271` — `ankommen` ruft `klingeln(…, video: false)`
fest. **Belegt am Code.**

### G4 — Befehle an die Hülle haben keine Reihenfolge

`SprachePlugin.swift:79-90` — jeder Ruf startet einen eigenen `Task`. Schnelles
Ein/Aus (Push-to-Talk) kann sich überholen; LiveKits `_mute` kehrt bei noch
nicht gesetztem `isMuted` früh zurück (`Track.swift:340-360`), ein schnelles
„aus" nach „an" kann also verpuffen und das Mikrofon offen lassen. **Vermutet**,
enges Fenster.

---

## Teil 3 — Rest des Branches (Backend, übrige Web- und Hüllen-Teile)

Zwei eigene Durchgänge, Repro-Skripte und Belegtests nur im Scratchpad (nicht
im Repo). Die wichtigsten Stellen sind hier gegengelesen; was nicht
gegengelesen ist, steht so da.

### Kritisch

**T1 — Zwei Alembic-Köpfe, sobald der Branch landet.**
`services/chat-gateway/alembic/versions/20261008_2100_0101_voip_tokens.py:19`.
`origin/main` hat inzwischen `0101_zustellstand` mit derselben
`down_revision = "0100_cached_user_profiles_lower"` (gegengelesen). Auf dem
Branch allein gibt es einen Kopf, deshalb bleibt der Kopf-Test grün; nach dem
Rebase-Merge auf `main` scheitert `migrate-chat` an `alembic upgrade head`
(„Multiple head revisions"), und der `chat-gateway` startet nicht
(`service_completed_successfully`). Mit dem Cron-Deploy ist das ein
Prod-Ausfall. **Belegt** (Kopf-Prüfung über beide Migrationsstände).

### Ernst

**T2 — VoIP-Token und Badge-Meldung gehen an den AKTIVEN Server, Anrufe und
DM-Pushes kommen aber aus der Cloud.** `web/src/lib/platform/voipToken.ts:29`,
`:61`, `badgeMelden.ts:29` rufen `request()` ohne Cloud-Route (gegengelesen;
`api/anrufe.ts` routet ausdrücklich über `cloudRoute()`). Mit aktivem
Self-Host: der PushKit-Token landet dort, die Cloud kennt ihn nie → Anrufe
klingeln bei geschlossener App nicht; das `DELETE` beim Abmelden trifft den
Self-Host → die Cloud-Zeile bleibt, das abgemeldete Telefon klingelt weiter für
das alte Konto; `POST /fcm/badge` setzt den Self-Host-Zähler zurück, der
Cloud-Zähler wächst weiter. Dieselbe Klasse wie `gapFill`/`ablageArchiv` im
CLAUDE.md. **Belegt am Code** (beide Durchgänge unabhängig).

**T3 — Gesperrter oder entfreundeter Kontakt lässt das iPhone klingeln.**
`routes/anrufe.py:142` prüft nur die DM-Mitgliedschaft, nicht Sperre/
Freundschaft wie `postfach`. Neu durch den VoIP-Push: es klingelt per CallKit
auch bei geschlossener App, bis zu 5-mal pro Minute. **Belegt** (Test im
Scratchpad: 201 und `fan_out_klingeln({B})`).

**T4 — Gruppenanruf: nach der ersten Annahme bekommen die übrigen iPhones nie
einen Abbruch.** `routes/anrufe.py:255` (Auflegen bei laufendem Gruppenanruf
kehrt zurück), `:233` (Ablehnen → 409). Für ein per VoIP klingelndes Gerät gibt
es serverseitig keinen Weg mehr zu `_beenden`; die Hülle hat keinen eigenen
Klingel-Timeout. Server-Teil **belegt**, endloses Klingeln **vermutet (Gerät)**.

**T5 — Das Badge-Plugin löst den Mitteilungs-Dialog beim ersten Start aus,
ohne Vorerklärung und nur für Badges.** `web/src/routes/app/+layout.svelte:457`
ruft `badgeSetzen` ungegatet; `@capawesome/capacitor-badge` ruft dafür
`requestAuthorization(.badge)`. Wird erlaubt, ist nur `.badge` erteilt, die
Firebase-Prüfung meldet trotzdem `granted`, Banner und Ton kommen nie; wird
abgelehnt, ist die Erlaubnis dauerhaft weg. **Belegt am Code beider
Plugins**, Dialogverhalten laut Apple, nicht gemessen.

**T6 — Vorerklärung für Mitteilungen umgedreht.**
`platform/berechtigung.svelte.ts:110` (`if (!noetig) return true`) mit
`fcm.ts:192-193`: bei weniger als 3 Sendungen oder nach „später" öffnet der
System-Dialog sofort, ohne Blatt. **Belegt** (Repro im Scratchpad, Gegenprobe
mit 3 Sendungen öffnet das Blatt).

**T7 — Netzwache: neuer Socket, während der alte noch schliesst.**
`ws/wachentscheid.ts:65` (`SCHLIESST` → sofort verbinden) mit
`ws/gateway-connection.ts:691` (close-Handler nullt `this.ws` ohne Prüfung, ob
es noch derselbe Socket ist). Das späte close des alten nullt den neuen, stoppt
seinen Herzschlag und plant einen dritten; der zweite bleibt offen und
dispatcht weiter → doppelte `ready`/`message`/`dm_bump`, doppelte Zähler und
Töne. **Belegt** (Simulation mit dem echten Modul und Fake-WebSocket); wie
lange WebKit in CLOSING bleibt, ungemessen.

**T8 — Externe Links in der bestehenden Android-App tot.**
`platform/externeLinks.ts:19-27` greift auch auf Android, ruft
`preventDefault` und dann `Browser.open`; ausgelieferte APKs haben das
Browser-Plugin nicht (`capacitor.settings.gradle` auf HEAD ohne Browser,
gegengelesen) → `UNIMPLEMENTED`, verschluckt, der frühere System-Browser-Weg
entfällt. Jeder `_blank`-Link in Nachrichten tut nichts, sobald das Web
deployt ist. Dieselbe Klasse wie K1. **Belegt** (Repro im Scratchpad).

**T9 — QR-Scanner kann bei verweigerter Kamera stehen bleiben.**
`QrScanPlugin.swift:74/81`, `:147`: `melden(nil)` schon in `viewDidLoad`, das
`dismiss` während der laufenden Präsentation verpufft, danach ist `erledigt`
gesetzt und „Abbrechen" tut nichts. **Vermutet** (UIKit-Verhalten ungemessen).

### Mittel

- **T10 — Antwort aus dem Banner wird nicht gesendet**, nur als Entwurf
  abgelegt (`fcm.ts:94`); im schon offenen DM greift die Wiederherstellung
  nicht, der erste Tastendruck überschreibt sie. Knopf heisst „Senden",
  `AppDelegate.swift:129` behauptet Senden. Belegt am Code.
- **T11 — Badge-Zähler zählt Steuer-Umschläge mit** (`fcm.py:267` über
  `postfach.py`): Reaktion, Bearbeitung, Löschung, Anruf-Schlüssel,
  Verteilschlüssel erhöhen das Icon-Badge. Belegt am Code.
- **T12 — Badge am Server driftet nach oben**: die Drossel nimmt an, der Server
  kenne den letzten Wert (`badgeDrossel.ts:51`), der Server zählt aber selbst
  hoch. Belegt am Code + Modell.
- **T13 — Frische Installation: ältere DMs als ungelesen**
  (`ws/handlers/ready.ts:190`, Lesestand-Tabelle ohne Backfill, eigene letzte
  Nachricht wird mitgezählt). Belegt am Code.
- **T14 — Anrufe kurz nach dem Wegstecken gehen verloren**: Frische einmal beim
  Start geprüft (40 s), eingefrorenes JS verarbeitet `call_klingelt` nicht
  (`anruf_push.py:43/60`). Code belegt, Einfrieren vermutet.
- **T15 — `BadDeviceToken` löscht Tokens bei Umgebungs-Verwechslung**
  (`apns_voip.py:129-133`): Dev-Bau gegen Cloud oder TestFlight gegen den
  Remote-Dev-Stack verliert den Token bei jedem Anruf. Belegt am Code.
- **T16 — `apns-interruption-level` als HTTP-Kopf wirkt nicht** (`fcm.py:165`),
  gehört in den Payload (`aps.interruption-level`). Belegt (Apple-Doku).
- **T17 — APNs-Rundlauf im Anfragepfad** von `POST /anrufe` und `_beenden`
  (`apns_voip.py:216`, je Push neuer HTTP/2-Klient, 10 s je Phase): solange
  kennt der Anrufer die Call-ID nicht; ein Auflegen geht an `/anrufe//auflegen`.
  Code belegt, Häufigkeit vermutet.

### Gering

- `badgeMeldungZuruecksetzen` ohne Aufrufer — Kontowechsel ohne Reload löscht
  den Serverzähler des neuen Kontos.
- Neue `geraet_id` bei gleichem Token → dauerhaft 409 (`_geraetetoken.py:60/80`,
  Test im Scratchpad).
- `anruf_art` ist am Server `dm`/`gruppe`, Swift prüft `== "video"`
  (`AnrufPlugin.swift:199`), das Web fällt auf das ungültige `'audio'` zurück
  (gegengelesen).
- Stale-WS-Reaper wird beim Herunterfahren nicht beendet (`app.py:258/396`).
- Ältere iOS-Bauten: `wakeLock.ts` verliert den Rückfall auf
  `navigator.wakeLock`, `qrScanMoeglich()` zeigt den Knopf ohne Plugin.
- Schnellwahl zeigt Gesprächspartner auch bei aktiver App-Sperre.
- Vermutet: läuft die Sprache nativ im Hintergrund, während das JS
  eingefroren ist, schliesst der Reaper den Socket nach 95 s und räumt den
  Sprach-Selbststatus ab, obwohl man im Kanal sitzt.

---

## Bekannte Punkte — bestätigt und erweitert

- `abbilden()` schneidet nur `user-` ab: bestätigt (`SpracheRaumZustand.swift:133`).
- `spracheZustand()` ohne Aufrufer: bestätigt; die Folgen stehen in E5.
- Kein Auflegen aus der nativen Ansicht: bestätigt
  (`SpracheSteuerleiste.swift:11-18`). Verschärft durch E5: nach einem Reload
  ist das Blatt der einzige sichtbare Rest des Raums.
- Kommentar „Taubstellen gibt es nativ nicht" in `SpracheSteuerleiste.swift:19-21`:
  bestätigt, die Brücke hat `taub` längst.
- `voice.ansichtSchliessen()` ohne Aufrufer: bestätigt.
- `livekit.svelte.ts` 2355 Zeilen: bestätigt.
- `NATIVER_SPRACHWEG_AN = true`: bestätigt — K1 zeigt, dass der Schalter allein
  nicht reicht, solange die Weiche dahinter immer wahr ist.

---

## Nicht geschafft

- Nichts am Gerät (Hörmuschel, Bluetooth, CallKit, Sperrbildschirm, VoIP-Push).
  K2, K3, E4, E6 brauchen das zur Bestätigung der Wirkung.
- E1 im Simulator nachstellen: der Prüfpfad beginnt immer mit `taub = false`
  und kann ohne Code-Änderung nicht taub → verlassen → beitreten fahren; einen
  zweiten Teilnehmer mit Tonspur gab es im Aufbau nicht.
- Keine Playwright-Läufe. Backend: nur die 54 neuen Tests des Branches
  (grün) und die Belegtests im Scratchpad, kein Volllauf.
- Teil 3 nicht am Gerät oder im Simulator (Dialogverhalten, UIKit-`dismiss`,
  CLOSING-Dauer, APNs Sandbox/Produktion, AASA über Apples CDN, Android-Neubau).
- Die Reaper-/Disconnect-Reihenfolge im Gateway nur gelesen, kein WS-Test.

---

## Anhang A — Nachbau K1 (Node)

```bash
SP=<scratch>; cd <repo>
node_modules/.pnpm/esbuild@0.28.0/node_modules/esbuild/bin/esbuild \
  web/src/lib/platform/iosSprache.ts --bundle --format=esm --platform=neutral \
  --main-fields=module,main --outfile=$SP/iosSprache.mjs
```

```js
// altes-binary.mjs — iOS-Hülle OHNE SprachePlugin
globalThis.window = globalThis;
globalThis.webkit = { messageHandlers: { bridge: { postMessage() {} } } };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', maxTouchPoints: 5 }, configurable: true });
globalThis.Capacitor = { Plugins: {}, PluginHeaders: [{ name: 'AudioSessionPlugin', methods: [] }] };
const m = await import('./iosSprache.mjs');
console.log(m.nativerSprachwegDa());                 // true
await m.spracheBeitreten('wss://x', 't', '1', 'K', false, false); // wirft UNIMPLEMENTED
```

## Anhang B — Nachbau K2, JS-Seite (Node)

`web/src/lib/platform/iosTon.ts` ebenso bündeln; `window.Capacitor` mit
`isNativePlatform: () => true` und einem `Plugins.AudioSessionPlugin`, das die
Rufe mitschreibt. `tonWiedergabe('hq:42:0', true)` und danach `false` ergibt:

```
setPlaybackMode()                                  -> setCategory(.playback) + setActive(true)
setVoiceActive({"aktiv":false,"hqFunk":false})     -> setActive(false, .notifyOthersOnDeactivation)
```
