# iOS: nativer Sprachweg (Sprachkanal und Anruf)

**Stand 2026-10-10 · Entwurf zur Abnahme · noch kein Code**

## 1. Warum — und was vorher nicht half

Auf iOS lässt sich der Sprachton nicht auf die Hörmuschel legen. Das ist kein
Fehler in unserem Code, sondern eine Grenze der Bauform, und sie ist am Gerät
belegt (iPhone 16 Pro, iOS 26.6.2):

- Die Session, die den Ton wirklich abspielt, gehört **WebKits eigenem
  Prozess**. Im Gerätelog: `com.apple.WebKit(…) with
  [PlayAndRecord_WithBluetooth_DefaultToSpeaker/VideoChat]`, **NonMixable**.
- Unser `overrideOutputAudioPort` erreicht sie nicht. Es dreht *unsere*
  Session — die meldet danach brav `Receiver` —, während die aktive
  Systemroute auf dem Lautsprecher bleibt. Im ganzen Mitschnitt kommt
  `Receiver` nie als aktive Route vor.
- Der vorgesehene Weg aus dem Web heraus, `navigator.audioSession.type`,
  **kommt bei WebKit an** (der Modus kippte sichtbar auf `Default`), **nimmt
  `DefaultToSpeaker` aber nicht weg**. Die W3C-API kennt dazu kein
  Gegenstück; sie wählt keine Route.

**Dass der Lautsprecher funktioniert, beweist nichts:** dorthin geht WebKit von
selbst, unser Knopf hat daran keinen Anteil.

Dazu kommt ein zweiter, teurerer Befund desselben Tages: jedes `setActive` von
uns **unterbricht** WebKit. Zwei Fehler, die heute behoben wurden — stummes
Mikrofon nach dem Beitritt und totes Mikrofon nach der Rückkehr aus dem
Hintergrund — hatten beide dieselbe Wurzel: zwei Parteien an einer Session.
Solange beide an ihr drehen, bleibt diese Fehlerklasse offen.

**Was nativ es löst:** das LiveKit-Swift-SDK hat genau den Schalter, der im Web
fehlt — `AudioManager.shared.isSpeakerOutputPreferred` (`false` = Hörmuschel)
— und eine dokumentierte CallKit-Einbindung. Vor allem aber gibt es dann nur
noch **eine** Partei an der Session.

> **Nachtrag 2026-10-10, am Gerät gemessen: der letzte Satz traf nicht zu, und
> er hat die Hörmuschel ein weiteres Mal gekostet.** Die Oberfläche spielt
> weiter ihre eigenen Töne, und der erste kommt unmittelbar nach dem Beitritt
> (`voice.self_join`). WebKit richtet dafür seine eigene Session ein; mit der
> Vorgabe `auto` ist die nicht mischbar, übernimmt die Routen-Hoheit
> (`cmsTakeControl … requires Volume_Routing`) und iOS **unterbricht** die
> Session der Hülle. Danach bewegt kein `setCategory` mehr eine Route — das
> SDK wählt Lautsprecher/Hörmuschel nur darüber, und eine Kategorie wirkt an
> einer nicht aktiven Session nicht (sie meldet nicht einmal einen
> Routenwechsel). Es sind also zwei Parteien, bis der Klient WebKits Session
> ausdrücklich als `ambient` erklärt; das tut `webSessionTyp` in
> `web/src/lib/platform/iosSprache.ts`, dort steht die Vorher/Nachher-Messung.
> **Die Lehre:** „der Ton läuft jetzt nativ" heisst nicht „die WebView hat
> keine Audio-Session mehr". Jeder Ton, den die Oberfläche selbst spielt,
> bleibt eine zweite Partei.

## 2. Zuschnitt (vom Eigentümer entschieden, 2026-10-10)

| | |
|---|---|
| **Nativ** | Der LiveKit-Raum auf iOS — für **Sprachkanäle UND Direktanrufe**. Dazu die **Kanalansicht** mit allen Kacheln, weil dort das Video liegt. |
| **Web** | Alles andere, einschliesslich der **Sprachleiste**, die auf jedem Bildschirm sichtbar bleibt und über die Brücke steuert. |
| **Unberührt** | Android, Desktop (Electron), Browser. Dort bleibt der Web-Weg, wie er ist. |
| **Unberührt** | **HQ-Streaming (WHEP)**. Es läuft nicht über LiveKit und bleibt im WebView. |

Verworfen wurden: *nur Ton auf iOS* (Kamera und Videokacheln wären entfallen)
und *native Videoflächen unter der WebView* (Positionen müssten laufend
nachgerechnet werden — dasselbe Muster hat das Projekt beim AirPlay-Knopf
schon einmal verworfen, und bei scrollenden Kacheln ist es schlimmer).

## 3. Wer besitzt was

**Nativ ist die Wahrheit, der Web-Store spiegelt.** Auf iOS besitzt die Hülle
das `Room`-Objekt und allen Zustand daran. `voice` im Web behält seine heutige
Form und Felder, bekommt seine Werte dort aber aus nativen Ereignissen statt
aus dem JS-SDK.

**Warum so und nicht als zweiter Store:** 31 Dateien benutzen `voice.`. Eine
Fassade mit zwei Maschinen darunter lässt sie alle unverändert; eine Weiche in
der Oberfläche müsste an 31 Stellen stimmen. Dasselbe Muster trägt im Projekt
schon den Wake-Lock (`nativerSchalter`).

**Die Anmeldung bleibt im Web.** Der Klient holt das Token weiter selbst
(`getVoiceToken`) und reicht `{ws_url, token}` an die Hülle. Nativ bekommt
damit keine zweite Sitzungs-, Token- und Fehlerbehandlung — der Teil, der am
ehesten auseinanderliefe.

**Das Web entscheidet, wann beigetreten wird — mit genau einer Ausnahme.** Ein
ankommender CallKit-Anruf erreicht das Gerät, wenn die App geschlossen ist.
Dort muss die Hülle allein handeln und das Web nachziehen, sobald es da ist.

## 4. Die Brücke

**Regel: was schnell ist, bleibt nativ.** Pegel und Sprechanzeigen
aktualisieren 10–20 mal pro Sekunde und Teilnehmer. Capacitors Brücke ist
**eine einzige serielle Warteschlange** (`DispatchQueue(label: "bridge")`) —
am 2026-10-10 gemessen, und ihre Verstopfung war die Ursache dafür, dass die
App einfror. Alles darüber zu schicken wäre dieselbe Falle noch einmal.

Deshalb: die native Kanalansicht zeichnet Pegel und Sprechringe **selbst**.
Über die Brücke geht nur grober Zustand, **ereignisgetrieben, nicht getaktet**.

### Befehle (Web → Hülle)

| Befehl | Zweck |
|---|---|
| `beitreten({wsUrl, token, kanalId, kanalName, startStumm, startTaub})` | Raum verbinden und die native Ansicht zeigen |
| `verlassen()` | Raum trennen, Ansicht schliessen |
| `mikrofon({an})` · `taub({an})` | Stummschalten und Mithören |
| `ausgabe({weg})` | `lautsprecher` · `hoermuschel` · `auto` |
| `kamera({an})` · `kameraSeite({front})` | Kamera im Sprachkanal |
| `lautstaerke({identitaet, wert})` | Lautstärke je Teilnehmer |
| `zustand()` | Vollbild des Zustands — für den Abgleich nach einem Reload |
| `tokenErneuern({token})` | Antwort auf `tokenLaeuftAb` |

### Ereignisse (Hülle → Web)

| Ereignis | Nutzlast | Wann |
|---|---|---|
| `verbindung` | `zustand`, `fehler?` | Verbinden, verbunden, getrennt, Wiederaufbau |
| `teilnehmer` | ganze Liste in der Form von `VoiceParticipant` | Beitritt, Austritt, Stummschaltung, Kamera an/aus |
| `sprechen` | `{identitaet, spricht}` | Nur die Kippkante, **nicht** der Pegel |
| `eigenerZustand` | `mikro`, `taub`, `kamera`, `ausgabe` | nach jedem Befehl und bei Änderung von aussen |
| `tokenLaeuftAb` | — | rechtzeitig vor Ablauf |
| `ansichtGeschlossen` | — | Nutzer hat die native Ansicht verlassen (nicht den Raum) |

`teilnehmer` schickt bewusst die **ganze Liste** statt Einzeländerungen: die
Liste ist kurz, und Teil-Updates brauchen eine Reihenfolge-Garantie, die eine
Brücke mit Ereignissen nicht gibt.

> **Nachtrag 2026-10-11 (Behebungen aus `docs/2026-10-11-ios-bughunt.md`) —
> was von den Tabellen oben abweicht:**
>
> - `lautstaerke({identitaet, wert})` heisst `lautstaerken({lautstaerken,
>   gesamt})` und schickt die **ganze Tabelle** (Nutzer-Id → Faktor, dazu die
>   Gesamtlautstärke) — aus demselben Grund wie `teilnehmer`. Die Hülle
>   rechnet daraus und aus `taub` die Lautstärke jeder Spur aus, gedeckelt bei
>   1 wie der Mobil-Web-Weg (`SpracheRaumTaub.swift`).
> - `beitreten` liefert `sitzung`; `verlassen({sitzung?})` trifft dann nur
>   genau diesen Raum. `zustand()` trägt zusätzlich `kanalName` und `sitzung`.
> - Neues Ereignis `wunsch` (`{aktion: mikrofon|taub|auflegen, an}`): die
>   Knöpfe der nativen Ansicht, deren Regeln im Web liegen, bitten das Web.
>   Hört dort niemand zu, handelt die Hülle selbst; Auflegen erledigt sie nach
>   4 s auch dann, wenn das Web nicht antwortet.
> - `verbindung` trägt das schlichte Wort (`connected`), nicht LiveKits
>   `description` (`.connected`). Das Web liest beides.
> - Die native Ansicht öffnet nach einem Beitritt nur, wenn die Web-Route den
>   Kanal zeigt (§5), und schliesst, wenn die Route ihn verlässt.
> - Der Abgleich nach einem Reload (§5) ist gebaut: übernommen wird nur ein
>   Raum, den der Eintrag fürs Wiederaufnehmen bestätigt; alles andere wird
>   verlassen (`web/src/lib/voice/nativAbgleich.ts`).
> - Solange der native Raum steht, fasst `iosTon` die Session nicht an (§6:
>   „fasst sie im Sprach-Betrieb nicht mehr an" galt bis dahin nur für den
>   Sprachkanal selbst, nicht für Stream-Ton und Anrufe daneben).

## 5. Die native Ansicht

- **Vorgehängt, nicht eingebettet.** Ein `UIViewController` wird über der
  WebView präsentiert. Die Web-App bleibt darunter stehen, mitsamt ihrer
  Navigation; sie weiss nur, dass die Ansicht offen ist.
- **Die Web-Route wird trotzdem gewechselt.** Ein Tipp auf einen Sprachkanal
  navigiert im Web wie heute UND ruft `beitreten`. Das klingt doppelt, ist
  aber nötig: an der URL hängen Android-Zurück, Tiefenlinks und das
  Wiederherstellen nach einem Reload (`lib/navigation/tabs.ts`). Die native
  Ansicht legt sich darüber; schliesst man sie, steht die richtige Web-Seite
  darunter.
- **Zurück-Geste und Wischen nach unten schliessen die ANSICHT, nicht den
  Raum.** Das ist der heutige Zustand im Web (man verlässt den Kanalbildschirm
  und bleibt verbunden) und muss gleich bleiben, sonst legt eine Wischgeste
  versehentlich auf.
- **Die Web-Leiste bleibt sichtbar, solange der Raum steht** — auch wenn die
  native Ansicht geschlossen wurde. Sie ist dann der einzige Weg zurück, also
  bekommt sie dort einen Griff „zurück in den Kanal".
- **Ein Reload der Web-App darf den Raum nicht reissen.** Nativ lebt weiter;
  das Web fragt beim Start `zustand()` und stellt sich darauf ein. Das ist
  gegenüber heute ein **Gewinn**: ein Reload im Sprachkanal kostet heute die
  Verbindung.

## 6. Tonweg und CallKit

- Die Hülle führt die Session **allein**. Unser `AudioSessionPlugin` fasst sie
  im Sprach-Betrieb auf iOS nicht mehr an.
- Lautsprecher ↔ Hörmuschel über `AudioManager.shared.isSpeakerOutputPreferred`.
  **AM GERÄT NACHGEMESSEN, 2026-10-10** (iPhone 16 Pro, iOS 26.6.2, gegen den
  Dev-Stack, nativer Prüfpfad ohne Oberfläche):

  | Schritt | erreichte Route |
  |---|---|
  | verbunden, ohne Mikrofon | `Speaker` |
  | Mikrofon an | `Speaker` |
  | Ausgabe `hoermuschel` | **`Receiver`** |
  | Ausgabe `lautsprecher` | `Speaker` |
  | Ausgabe `hoermuschel` | **`Receiver`** |

  **Die Hörmuschel ist damit erreichbar** — mitten im Gespräch, in beide
  Richtungen, sofort. Genau das, was über WebKit unmöglich war.

  **Mit einer Bedingung, und die ist wichtig für die Oberfläche:** ohne
  veröffentlichte Aufnahme wirkt der Schalter NICHT. In einem ersten Lauf
  wurde dreimal umgeschaltet, bevor das Mikrofon lief — die Route blieb jedes
  Mal `Speaker`, und erst das `Mikrofon an` sprang auf `Receiver`. Der Grund
  steht in LiveKits Dokumentation: das SDK wählt die Kategorie nach dem
  Zustand der Audio-Maschine, `.playback` ohne Aufnahme und `.playAndRecord`
  mit. Nur im zweiten Fall gibt es überhaupt eine Hörmuschel-Wahl. Im
  Sprachkanal ist das unkritisch (Stummschalten beendet die Spur nicht), aber
  wer reines Zuhören baut, muss es wissen.

  **Am Quelltext geprüft** (`Sources/LiveKit/Audio/Manager/AudioManager.swift`),
  Doc-Kommentar wörtlich: „Determines whether the device's built-in speaker or
  receiver is preferred for audio output. Defaults to `true` … Set to `false`
  if the receiver is preferred instead of the speaker."
  Bluetooth und AirPlay bleiben Sache des Systems; der AirPlay-Griff
  (`airplayWaehler`) bleibt, wie er ist.
- **Die Falle dabei, und sie trifft genau unseren CallKit-Fall.** Derselbe
  Doc-Kommentar sagt: die Eigenschaft wird **ignoriert**, sobald
  `customConfigureAudioSessionFunc` gesetzt ist, und `sessionConfiguration`
  hat ohnehin Vorrang vor ihr. Für CallKit schaltet LiveKit die automatische
  Konfiguration ab — und damit ist der Schalter dort wirkungslos.
  **Es gibt also ZWEI Wege zur Hörmuschel, je nachdem wer die Session führt:**
  im Sprachkanal der SDK-Schalter, im Anruf unser eigenes `setCategory` +
  `overrideOutputAudioPort`. Letzteres funktioniert dann auch wirklich — es
  scheiterte bisher nur daran, dass WebKit eine zweite Session hielt.
  **Die beiden dürfen einander nicht überschreiben**; welcher gilt, hängt an
  genau einer Frage (führt CallKit gerade?), und die beantwortet
  `Anrufverwaltung.callkitAktiv` schon heute.
- **Bei CallKit gibt das SDK die Session ab**, wie LiveKits README es
  vorschreibt (dort geprüft; eine eigene `Docs/callkit.md` gibt es nicht):
  `audioSession.isAutomaticConfigurationEnabled = false` und
  `setEngineAvailability(.none)` vor dem Verbinden; in
  `provider(_:didActivate:)` erst Kategorie und Modus setzen, dann
  `setEngineAvailability(.default)`; in `provider(_:didDeactivate:)` wieder
  `.none`. `Anrufverwaltung` hält diesen Zustand heute schon
  (`callkitAktiv`) und hat beide Delegat-Methoden — das Stück ist gebaut.
> **Nachtrag 2026-10-11 — Etappe 4 gebaut** (`AnrufRaum.swift`,
> `AnrufSitzung.swift`, `AnrufCallKit.swift`; im Web `anrufe/anrufMedien.ts`
> mit zwei Medienwegen). Was entschieden und wo es begründet ist:
>
> - **CallKit trägt JEDES Gespräch**, auch das in der App angenommene
>   (`CXAnswerCallAction` per Transaktion) und das ausgehende
>   (`CXStartCallAction`). Nur so gibt es eine einzige Stelle, die über die
>   Session entscheidet. Lehnt CallKit ab (Simulator ohne Audio, laufendes
>   Mobilfunk-Gespräch), läuft der Anruf mit der Automatik des SDK weiter
>   (`ohneCallKit`), und der Hörmuschel-Wunsch des Kanals wird gemerkt.
> - **Die Session-Übergabe** — Tabelle und Reihenfolge im Kopf von
>   `AnrufSitzung.swift`: erst Automatik aus, dann Maschine `.none`; zurück
>   erst nach `didDeactivate` (Notbremse 3 s).
> - **Ein Anruf gewinnt** (Punkt 2 unten, Eigentümer-Entscheid): der Kanal
>   bleibt verbunden, Mikrofon zu, Spuren auf 0, und meldet sich so (`taub`,
>   `pausiert`) — in der Hülle, weil der Anruf oft auf dem Sperrbildschirm
>   angenommen wird (`SpracheRaumStumm.swift`).
> - **Verschlüsselung über HKDF**, wie livekit-client sie für rohe
>   Schlüssel-Bytes nimmt — mit der Vorgabe des Swift-SDK (PBKDF2) hörten
>   beide Seiten nur Rauschen. Am Quelltext beider SDKs geprüft, nicht an
>   zwei Geräten gemessen.
> - **Messbar im Simulator** (`AnrufProbe.swift`, gegen den lokalen
>   LiveKit): Übergabe, Pause und Rückkehr des Kanals, Raum verbunden und
>   verschlüsselt — beim Bau als grün gemeldet. **Zwei Läufe danach (noch am
>   2026-10-11) nur teilweise:** der Simulator nimmt den Anruf bei CallKit an
>   und beendet ihn 65–95 ms später selbst (`callservicesd`: „Disconnecting
>   call because there wont be a UI to host the call"). Danach führt weder
>   CallKit noch der Weg ohne CallKit, die Probe betritt den Raum trotzdem,
>   und `beenden` findet ihn nicht mehr: 11 von 15 Prüfungen grün (Raum
>   verbunden und verschlüsselt, Rückgabe an das SDK, Kanal danach wie
>   vorher), rot sind „einer der beiden Wege führt", „Kanal angehalten",
>   „Kanal meldet sich taub" und „Anruf-Raum weg". Der Ablauf dahinter ist
>   auch am Gerät denkbar: CallKit beendet einen Anruf, bevor sein Raum
>   steht, und ein danach noch ankommender Beitritt hat keinen Eintrag
>   mehr, über den ihn `beenden` fände. **Nur am Gerät**: ob CallKit die
>   Session aktiviert, die Hörmuschel am Ohr, das Mikrofon im Anruf neben
>   der stummen Kanal-Spur, Lautsprecher-Taste im System-Bildschirm.
> - **Behoben am selben Tag (Buchführung):** ein Anruf-Raum entsteht nur
>   noch für ein Gespräch, das `Anrufverwaltung.fuehrt` (`AnrufRaum.Fehler.
>   keinAnruf`, Begründung dort: eine Prüfung, keine Reihenfolge), und ein
>   Gespräch ohne CallKit steht mit seiner Kennung in der Buchführung
>   (`ohneCallKitKennung`) — ein Push dafür meldet und endet sofort, das
>   Ende eines fremden CallKit-Eintrags gibt den Kanal nicht mehr frei, und
>   nach dem Ende steht es unter „kürzlich beendet". Die Probe ist darauf
>   umgebaut: im Simulator führt sie das Gespräch absichtlich ohne CallKit
>   (CallKit weist wegen einer belegten Anrufgruppe ab) und prüft so
>   Pause, Push, fremdes Ende und Ende an einem STEHENDEN Raum — 0 Fehler;
>   ohne die neue Prüfung 4 rot, darunter „Anruf-Raum weg".

- Ebenfalls aus dem README: vor dem Veröffentlichen des Mikrofons muss die
  Session mit `.playAndRecord` und Modus `.voiceChat`/`.videoChat`
  **konfiguriert UND aktiviert** sein. Das ist dieselbe Reihenfolge-Regel, an
  der heute der Web-Weg hing — sie gilt nativ unverändert weiter.
- **Die Rauschunterdrückung wechselt die Seite.** RNNoise läuft heute in einem
  Web-Audio-Graphen und entfällt auf iOS; es bleibt Apples Verarbeitung.
  `voice/filterwahl.ts` muss das wissen, sonst filtert niemand oder zweimal.
  **Ob das besser oder schlechter klingt, ist nicht bekannt — es wird
  gemessen, bevor es als gelöst gilt.**

## 7. Was dafür verschwindet

- Der iOS-Zweig in `platform/iosTon.ts` für den **Sprach**-Modus. Der
  Wiedergabe-Modus (Stream-Ton ohne Mikrofon) bleibt: HQ-Streaming läuft
  weiter im WebView.
- `AudioSessionPlugin.setVoiceActive` verliert seinen Aufrufer auf dem
  Sprachweg. Die Ausgabe-Wahl (`AudioSessionAusgabe.swift`) wird vom nativen
  Raum bedient statt von der eigenen Session.
- Der am 2026-10-10 entfernte Hörmuschel-Eintrag kommt **zurück** —
  mit dieser Änderung hält er, was er verspricht.

## 8. Risiken, offene Punkte, Messplan

**Das grösste Risiko steht nicht im Sprachweg, sondern daneben:** ein
HQ-Stream zuschauen, WÄHREND man im Sprachkanal ist. Dann spielt WebKit
(Stream-Ton) und der native Raum (Sprache) gleichzeitig — genau die
Konstellation zweier Sessions, die heute die beiden Mikrofon-Fehler verursacht
hat, nur mit vertauschten Rollen. **Das wird als Erstes gemessen, nicht
zuletzt.**

Weiter offen und bewusst benannt:

1. ~~Lautstärke je Teilnehmer~~ — **geklärt:** `RemoteAudioTrack.volume`
   („Playout volume of the remote audio track"). Ein Haken steht im
   Doc-Kommentar: Lesen und Schreiben **blockiert den rufenden Thread**, bis
   WebRTCs Signalisierungs-Thread es angewandt hat — also nicht vom
   Hauptthread und nicht aus einem Brücken-Ruf heraus, der etwas anderes
   aufhält.
2. ~~**Anruf WÄHREND eines Sprachkanals.**~~ **Entschieden 2026-10-11: der
   Anruf gewinnt**, der Kanal bleibt angehalten bestehen (Nachtrag in §6).
   Der ursprüngliche Text: Heute sind das zwei Räume
   nebeneinander, und `iosTon.ts` hält dafür zwei Quellen (`'sprachkanal'`,
   `'anruf'`) auseinander. Nativ wären es zwei `Room`-Objekte und EINE
   Audio-Session — wer dann wen verdrängt, ist nicht entschieden. Vermutlich
   muss der Anruf gewinnen und der Kanal stummgeschaltet weiterlaufen, aber
   das ist eine Produktentscheidung, keine technische.
3. **Gast-Links** auf iOS: ein Gast tritt heute über die Web-App bei. Fällt er
   in den nativen Weg oder bleibt er im Web? Nicht entschieden.
4. **Bildschirmfreigabe VON iOS** ist heute nicht angeboten und bleibt
   ausserhalb.
5. **Mikrofon-Test und Selbst-Mithören** (`micTest`, `selfMonitor`) brauchen
   ein natives Gegenstück oder entfallen dort.
6. **Zwei Sprach-Implementierungen** sind ab dann dauerhaft zu pflegen — Web
   für Android/Desktop, nativ für iOS. Das ist der eigentliche Preis dieses
   Weges und keine Übergangserscheinung.
7. ~~SDK-Fassung und Mindest-iOS~~ — **geprüft** an `Package.swift`:
   `swift-tools-version:6.1`, **iOS 13+**, macOS 10.15+. Das Paket zieht zwei
   vorgebaute Binär-Abhängigkeiten nach, beide exakt gepinnt:
   `webrtc-xcframework` 150.7871.02 und `livekit-uniffi-xcframework` 0.1.9.
   **Das ist die eigentliche neue Abhängigkeit** — ein WebRTC-Build als
   Binärpaket, nicht ein paar Swift-Dateien. Wer das Vorhaben abnimmt, nimmt
   das mit ab.
8. **Die Quellen waren teils veraltete Spiegel.** Was oben als geprüft steht,
   ist am Quelltext oder am offiziellen README nachgelesen; `Docs/audio.md`
   dokumentiert den Lautsprecher/Hörmuschel-Schalter NICHT, obwohl mehrere
   Fundstellen das behaupteten.

**Reihenfolge der Messungen am Gerät** (alles andere lässt sich im Simulator
bauen; Hörmuschel, Bluetooth, CallKit und gesperrter Bildschirm nicht):

1. Hörmuschel ↔ Lautsprecher — der Grund für den ganzen Umbau
2. Stream-Ton und Sprache gleichzeitig (s. oben)
3. Mikrofon trägt nach Beitritt, Hintergrund und Rückkehr — dieselben drei
   Messungen wie heute, damit die Behebungen nicht wieder verloren gehen
4. CallKit-Anruf: Hörmuschel am Ohr, Lautsprecher-Taste im System
5. Bluetooth im Auto

Das Messmittel steht: `testBeitrittDreimalHintereinander` und
`testTonImHintergrund` fahren die Strecken, WebKits `RTCStats` im Gerätelog
zeigt ohne Hinhören, ob die Aufnahme trägt. **Für den nativen Weg braucht es
ein zweites Messmittel** — WebKit sieht den nativen Raum nicht. Das ist Teil
der Umsetzung, nicht eine Zugabe danach.

## 9. In welcher Reihenfolge gebaut wird

Nicht in einem Stück. Die Etappen sind so geschnitten, dass jede für sich am
Gerät zu belegen ist:

1. **Tonweg allein.** SDK einbinden, Raum verbinden, Mikrofon veröffentlichen,
   Lautsprecher ↔ Hörmuschel schalten — ohne Oberfläche, ohne Video, über
   einen Testbefehl angestossen. Damit ist die Kernfrage des ganzen Vorhabens
   beantwortet, bevor etwas Grosses darauf steht.
2. **Brücke und Zustand.** Befehle und Ereignisse, der Web-Store spiegelt. Die
   bestehende Web-Leiste bedient den nativen Raum. Noch ohne native Ansicht:
   man hört und spricht, sieht aber niemanden.
3. **Native Ansicht.** Kacheln, Video, Lebenszyklus, Zurück-Geste.
4. **Anrufe.** CallKit an denselben Raum, Hörmuschel am Ohr.
5. **Aufräumen.** Der iOS-Sonderweg in `iosTon.ts` fällt, der
   Hörmuschel-Eintrag kommt zurück.

Etappe 1 ist der Prüfstein: trägt sie nicht, ist der ganze Weg falsch, und wir
haben es für den Preis einer Etappe erfahren statt für den des Umbaus.
