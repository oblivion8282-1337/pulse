# Streaming-Audit 2026-08-27 — Vollbild-Abstand, WHIP, FEC, NACK, beide Player

Geprüft wurde die ganze Strecke: die drei Sidecars, der gemeinsame
WHIP-Sendeweg, MediaMTX samt Fork-Patches, der native Player und der
Browser-Player. Sieben parallele Leseläufe plus eigene Gegenproben.

**Kurzfassung: die Kette ist im Kern richtig konfiguriert.** Der
Vollbild-Abstand von 60 s ist auf allen drei Sidecars sauber umgesetzt, die
beiden Zahlen, die ihm ausdrücklich NICHT folgen dürfen, sind überall
entkoppelt und durch Tests festgehalten; das SDP-Angebot sagt genau zu, was
gesendet wird; NACK trägt in beide Richtungen; FlexFEC wird ausgehandelt und
erzeugt.

Gefunden wurden **ein schwerer Fehler** (1.1), mehrere Zusagen ohne Einlösung,
eine Kiste, deren 31 Tests in keinem Gate liefen, und eine Reihe Kommentare,
die mehr behaupten, als sie halten. Dazu ein gemeldeter Grossfund, der sich
beim Nachprüfen aufgelöst hat — er steht als 2.1 trotzdem drin, weil die
Lehre daraus wertvoller ist als der Befund gewesen wäre.

---

## 1. Behoben in diesem Durchgang

### 1.1 Der Windows-Rückfallweg löste keine Vollbild-Anforderung ein — schwer

`keyframe::request_keyframe()` setzt einen prozessweiten Merker, wenn ein
Zuschauer PLI oder FIR schickt. Abgeholt hat ihn **nur** `encoder_hw.rs`
(NVENC/AMF). Der CPU-/Intel-QSV-Weg (`encode/encoder.rs`) und der D3D12-Weg
(`encode/encoder_d3d12.rs`) setzten zwar `set_gop` auf den regulären Abstand,
lasen den Merker aber nie.

Folge auf einem Intel-Rechner — und Intel ist ein Auslieferweg, kein
Debug-Schalter: ein Vollbild kam ausschliesslich im regulären Takt, seit dem
2026-08-18 also **alle 60 s**. Ein beitretender Zuschauer sah bis zu eine
Minute nichts, ein Zuschauer nach einem Verlust bis zu eine Minute ein kaputtes
Bild. Ohne eine einzige Log-Zeile: aus Sicht des Senders lief alles.

Das ist genau die Fehlerklasse, vor der die Wurzel-`CLAUDE.md` beim
Vollbild-Abstand warnt — auf dem Hauptweg durchgezogen, im Rückfall-Zweig nicht
mitgedacht. Sie hat sich damit ein zweites Mal materialisiert.

Der D3D12-Weg ist ebenfalls betroffen, und **schwerer, als hier zuerst stand.**
Die erste Fassung dieses Abschnitts nannte ihn „eine Gegenprobe, kein
Auslieferweg", weil `PULSE_HQ_AMD_D3D12=1` dorthin führt. Das ist nur der eine
Weg. Der andere ist ein automatischer Rückfall: scheitert auf AMD das Öffnen
des AMF-Encoders (AMF-Issue #455), gibt `bildencoder.rs::baue_mit_rueckfall`
ohne Zutun des Nutzers an diesen Zweig ab. Ein AMD-Rechner, auf dem das Issue
zuschlägt, fährt also den D3D12-Weg — und traf dort auf dieselbe Lücke wie ein
Intel-Rechner, nur dass niemand sie ihm ansah.

Die Fehleinschätzung ist selbst ein Beispiel für das, was dieser Bericht sonst
an anderen bemängelt: es wurde die eine Stelle gelesen, die den Zweig anbietet
(`codec.rs::amd_forces_d3d12`), und nicht die andere, die ihn erzwingt.

### 1.2 macOS sagte Opus-Inband-Fehlerkorrektur zu und schaltete sie nie ein

Das gemeinsame SDP (`pulse-whip::sdp::opus_capability`) trägt auf allen drei
Plattformen `useinbandfec=1`. Eingeschaltet hatten sie nur Linux
(`encode/audio.rs`) und Windows (`encode/audio/mod.rs`) — auf macOS ging der
Encoder mit einem leeren Optionswörterbuch auf. Der Empfänger richtet sich
darauf ein, dass ein verlorenes Paket aus dem nächsten teilweise
wiederherstellbar ist, und bekam auf macOS nichts.

Wichtig dabei: die Tonspur hat **keine** FlexFEC (MediaMTX erzeugt Parität nur
für Bild). Die Inband-Korrektur ist damit die einzige Absicherung, die der Ton
überhaupt haben kann.

### 1.3 D3D12 rechnet den Farbraum selbst um und sagte es nicht

`d3d12_convert.rs` wandelt mit eigenem HLSL-Shader nach BT.709 limited
(`rgb_to_yuv709_limited`, Y auf 16..235). Der Strom sagte das nicht. Ein
Empfänger ohne Angabe rät, und die übliche Annahme ist BT.601 — dieselbe
Verwechslung, die auf Linux für VAAPI gemessen und nachgezogen wurde (dort
weiss Y=255 statt 235).

Die Trennlinie ist nicht die Plattform, sondern **wer die Umrechnung macht**:
der AMF-/NVENC-Weg bleibt bewusst stumm, dort wandelt der Encoder nach eigener
Konvention, und etwas anzusagen, das wir nicht herstellen, verstellte einen
funktionierenden Weg auf Verdacht. Genau so steht es im Linux-Zwilling.

### 1.4 `pulse-whip` lief in keinem Gate — und die Begründung stimmte nicht

`gate-rust.sh` nahm die Kiste ausdrücklich aus, mit der Begründung, ihr
`cargo test` löse webrtc von crates.io auf „nicht über den gepatchten Zweig,
den Player und die Sidecars tatsächlich ausliefern".

Nachgesehen: `[patch.crates-io]` für webrtc steht **nur** in
`pulse-player/Cargo.toml`. Die drei Sidecars führen schlicht `webrtc = "0.17"`
von crates.io — und ausser ihnen hängt niemand an `pulse-whip`. Der Gate-Lauf
prüfte also sehr wohl die ausgelieferte Abhängigkeit.

Dahinter lagen 31 Tests, die genau das festhalten, wofür es diesen Sendeweg
gibt: dass `ccm fir`/`nack pli` wirklich im Angebot stehen, dass `stereo=1` es
hinausschafft, dass die H.264-Stufe die gerechnete ist. Jeder einzelne hält
einen Fehler fest, der schon einmal da war. Gemessene Laufzeit nach einer
Änderung an der Kiste: 1 s.

### 1.5 Fünf Kommentare, die mehr behaupteten, als sie hielten

- `win/mac keyframe.rs`: „Paketverlust ist in der heutigen Kette nicht
  reparierbar: es gibt keine Nachlieferung." Falsch, und der Player hält das
  Gegenteil mit einer Messung fest (`whep.rs::rueckkanal_flags`: 505
  Wiederholungen bei 5 % Verlust, null in der Nullkontrolle). pion liefert ohne
  RTX auf demselben Strom nach; sendeseitig hängt der NACK-Responder an jeder
  Bildspur, weil unser Angebot `nack` führt.
- `pulse-player/src/audio.rs`: ein längst behobener Stereo-Absturz stand als
  „BEFUND (Bug, nicht behoben)". Der Satz hat den Fix überlebt — und ein
  Kommentar, der einen erledigten Absturz als offen führt, lädt dazu ein, gegen
  ein Gespenst zu entscheiden.
- `streaming/server/docker-compose.yml`: zwei Kommentarblöcke übereinander über
  demselben Wert, die sich widersprachen. Der zweite behauptete „dieselbe
  Einstellung wie auf dem Testserver: feste Rate, NICHT adaptiv" über einem
  Wert, der die Parität ganz abschaltet — und der Testserver ist seit dem
  2026-08-04 adaptiv.
- `infra/mediamtx-fork/`: „fünf Patches" bei sechs.

---

## 2. Offen — bewusst nicht behoben, mit Begründung

### 2.1 FlexFEC im Browser: der gemeldete Befund war falsch, der Rest gilt

Ein Leselauf meldete als schwersten Fund, FlexFEC erreiche keinen
Browser-Zuschauer — Chromium handle `flexfec-03` über die
Standard-Schnittstelle grundsätzlich nicht aus, die 60-s-Entscheidung stütze
sich dort also auf zwei Schichten statt auf drei.

**Das stimmt nicht, und die als Beleg angeführte Datei belegt das Gegenteil.**
In `streaming/testbench/sdp-chrome-fec.txt`, einem echten Mitschnitt, steht
Nutzlast-Nummer 49 in der `m=video`-Zeile des Chrome-ANGEBOTS, dazu
`a=rtpmap:49 flexfec-03/90000` im Angebot UND in der Antwort und
`a=ssrc-group:FEC-FR`. Eine ältere Messreihe (2026-07-31,
`browser-2026-07-31-fec-und-codecs.json`) hält zusätzlich fest, dass in jeder
Antwort unseres Forks `a=ssrc-group:FEC-FR` steht und je Lauf 1352 bis 5788
Paritätspakete beim Browser ankamen. Auch die Messreihe, mit der die adaptive
Parität begründet ist (2026-08-04), lief mit headless Chromium als Zuschauer
und weist echte Paritäts-Aufschläge aus — das wäre unmöglich, wenn nichts
ausgehandelt würde.

Die Lehre gehört mit in diesen Bericht, weil sie teurer ist als der Befund:
**ein Leselauf hat aus einem Dateinamen und einem Patch-Kommentar geschlossen,
statt die Datei zu öffnen** — und hätte damit fast eine Änderung am Medienweg
jedes Zuschauers ausgelöst, die nichts repariert hätte.

**Was tatsächlich offen bleibt**, unverändert seit dem 2026-07-31: dass die
Parität beim Browser ANKOMMT, ist belegt. Ob sie dort auch REPARIERT, ist
ungemessen — alle Wirkungsmessungen liefen über den nativen Player mit eigenem
FEC-Empfänger. Ebenfalls offen und unabhängig davon: bei gebündeltem Verlust
bringt XOR-Parität nichts (Bündel sind im Mittel 2,5 Pakete lang, eine Gruppe
löst nur eine Unbekannte); die Idee, über FlexFEC-Bitmasken jedes fünfte statt
fünf benachbarte Pakete zu schützen, ist notiert und ungebaut.

**Ein echter Unterschied bleibt trotzdem:** der lokale Dev-Stack
(`streaming/server/docker-compose.yml`) fährt die Parität bewusst aus, Cloud
und Remote-Dev-Stack fahren sie an und verlustgeregelt. Ein Verhalten, das an
der Parität hängt, ist lokal also nicht nachstellbar. Zwei widersprüchliche
Kommentare darüber sind in 1.5 berichtigt; ob der lokale Stack angeglichen
werden soll, ist eine Entscheidung und keine Fehlkonfiguration.

### 2.2 REMB wurde nur unter Windows ausgewertet — BEHOBEN am 2026-08-27

Das gemeinsame SDP bot `goog-remb` auf allen drei Plattformen an, ausgewertet
wurde es nur im Windows-Sidecar. Linux und macOS verwarfen jeden Bericht still.

Behoben: die Zustandsmaschine (`bandbreite.rs`) liegt jetzt in `pulse-whip` —
abhängigkeitsfrei, sie lag ohne Grund plattformeigen —, alle drei Sidecars
werten sie aus, und ihre Tests laufen seit 1.4 im Gate mit.

**Beim Umsetzen kam heraus, dass der Befund noch zu wohlwollend war:** die
Meldung `bandwidth_low` hatte auch unter Windows **keinen Empfänger**. Der
Sidecar verschickte sie, und im ganzen Klienten hörte niemand zu; die Zahl
landete allein im Diagnoseprotokoll. Der Streamer bekommt jetzt einen Hinweis
mit beiden Zahlen und der Handlungsempfehlung, eine kleinere Qualitätsstufe zu
wählen. Die Entwarnung kommt als kurze Information — ohne sie stünde die
Warnung unwiderrufen im Raum.

**Weiterhin bewusst keine automatische Anpassung der Datenrate**: sie steht
beim Öffnen des Encoders fest, sie im Betrieb zu ändern hieße Encoder-Neubau
samt Vollbild und sichtbarem Ruckler. Das bleibt ein eigenes, zu messendes
Vorhaben — hier entsteht die Zahl, an der es später zu beurteilen wäre.


### 2.3 `transport-cc` wird ausgehandelt und von niemandem benutzt

`register_default_interceptors` von webrtc-rs ruft
`configure_twcc_receiver_only`. Das meldet die Rückmeldung und die
Header-Erweiterung an — sie stehen also für Bild UND Ton im Angebot —, hängt
die Transport-Sequenznummer aber nur an EMPFANGENE Pakete. Ein reiner Sender
hat keine Empfangsspur. Es schreibt also niemand die Nummer in die ausgehenden
Pakete, und niemand liest eingehendes `transport-cc`.

Folgenlos, solange REMB die Schätzung trägt (und die wird ohnehin nur unter
Windows gelesen, s. 2.2). Der Kommentar in `sdp.rs` ist dabei ungenau: er sagt,
`register_default_interceptors` hänge seine Rückmeldungen an die Video-Fassungen
— tatsächlich auch an Opus.

### 2.4 Kein Sidecar merkte einen ICE-Abriss — BEHOBEN am 2026-08-27

In keinem der drei `whip/mod.rs` gab es `on_ice_connection_state_change` oder
`on_peer_connection_state_change`. Ein Abriss nach dem Handschlag wurde nur
indirekt bemerkt: irgendwann scheitert ein Schreibvorgang, und der Sendefaden
endet. Was fehlte, war die Aussage.

Behoben: die Einordnung liegt als reine Rechnung in `pulse-whip::verbindung`
(mit Tests), das Absetzen bei den drei Sidecars in ihrer jeweiligen
Log-Sprache.

**Zwei Entscheidungen darin sind wesentlich.** Erstens werden „gestört" und
„verloren" getrennt: ein Gerät, das vom WLAN ins Mobilfunknetz wechselt, läuft
durch `Disconnected` und kommt zurück — wer beides gleich behandelt, meldet bei
jedem Netzwechsel einen Abriss. Zweitens **beendet die Überwachung nichts**.
Der Abbau hängt weiterhin allein am Schreibfehler; ein zweiter Weg, der bei
`Failed` von sich aus aufräumt, liefe mit dem ersten um die Wette, und ein
Wettlauf im Verbindungsabbau ist in diesem Projekt schon einmal teuer geworden
(die Gnadenfrist der Fernsteuerung, zwei Bughunt-Runden).

Offen bleibt die Frage aus dem Leselauf, ob ein reiner ICE-Ausfall bei
bestehendem SRTP-Kontext zeitnah einen Schreibfehler auslöst. Sie ist durch die
Meldung jetzt wenigstens **beantwortbar** — vorher gab es keine Spur, an der
man sie hätte prüfen können.


### 2.5 macOS bemerkte keinen Quellverlust — BEHOBEN am 2026-08-27

`SCStream::initWithFilter_configuration_delegate` bekam `None` als Delegat.
macOS hatte damit keine Möglichkeit, ein selbst herbeigeführtes Ende zu melden
(Fenster geschlossen, Bildschirm abgezogen, Berechtigung entzogen, „Teilen
beenden" im System-Menü). Die Medienschleife dupliziert bei stehender Quelle
das letzte Bild weiter — beim Zuschauer sah ein Abbruch deshalb aus wie ein
**Standbild**.

Behoben: `capture/waechter.rs` implementiert `SCStreamDelegate`; die
Medienschleife fragt den Merker je Durchlauf ab und beendet den Strom über den
regulären Fehlerweg, der `error` samt Begründung und danach `stopped` meldet.

**Die Abfrage steht VOR der Bildabholung**, und das ist kein Schönheitsfehler:
bei weggefallener Quelle liefert die Post nichts mehr, der Durchlauf fände
unten das letzte Bild vor und schöbe es ein weiteres Mal hinaus — die Schleife
täte also genau das, was hier gerade beendet werden soll.

**Nicht mitgemacht:** Windows meldet in diesem Fall `reason: "source_closed"`,
worauf der Klient einen eigenen, freundlicheren Text zeigt. macOS trägt an
seinem `stopped` ein `code`-Feld statt `reason`. Das anzugleichen ist eine
Protokolländerung über Sidecar und Klient und gehört in einen eigenen
Durchgang; bis dahin endet der Strom auf macOS sichtbar, nur mit dem
allgemeinen Fehlertext statt dem besonderen.


### 2.6 Der CPU-/Intel-Weg signalisiert den Farbraum ebenfalls nicht — aber die
naheliegende Korrektur wäre falsch

Der Leselauf hat ihn zusammen mit D3D12 gemeldet. Er ist aber **nicht** derselbe
Fall: `scaling::Context::get(BGRA → NV12, BILINEAR)` fährt in swscale ohne
weitere Angabe die **BT.601**-Matrix. Dort einfach BT.709 anzusagen, machte den
Fehler grösser statt kleiner. Richtig wäre, swscale ausdrücklich auf BT.709
limited zu stellen UND das anzusagen — zwei Änderungen, die zusammengehören und
auf Windows gemessen sein wollen.

### 2.7 `PULSE_REVISION` wurde für Patch 0006 nie hochgezählt — HALB behoben

`1.19.1-pulse5` trug zwei verschiedene Bildinhalte, einen mit und einen ohne
die Bildmarken-Durchreichung. Genau die Mehrdeutigkeit, gegen die der Zähler
gebaut wurde.

Der Zähler steht jetzt auf 6, und der Workflow liest ihn direkt aus dem
Dockerfile — der nächste Bau heißt also `1.19.1-pulse6`.

**Die drei compose-Dateien zeigen absichtlich noch auf `pulse5`.** Die
Reihenfolge ist zwingend: erst muss das Bild gebaut sein, dann dürfen die
Server darauf zeigen. Andersherum holen sie ein Bild, das es noch nicht gibt,
und der Streaming-Server läuft nicht mehr an. Das Umstellen ist der zweite,
getrennte Handgriff — er gehört mit einem Deploy zusammen und nicht in
denselben Commit.


### 2.8 Kleinere Punkte

- **Self-Hosts fahren ungepatchtes MediaMTX.** Weder `PULSE_KEYFRAME_INTERVAL`
  noch FlexFEC noch die Bildmarke wirken dort; der fest verdrahtete
  2-s-Anforderungstakt hebt den eingestellten Vollbild-Abstand aus. Im Code
  bereits offen geführt und als ungemessen gekennzeichnet.
- **Das Browser-Angebot geht über Googles STUN-Server** (`whep.ts`,
  `DEFAULT_ICE_SERVERS`). Für den Verbindungsaufbau kaum nötig — der Server hat
  eine öffentliche Adresse —, kostet aber Sammelzeit und meldet jeden Zuschauer
  an einen Dritten. Verhaltensänderung, deshalb hier nur notiert.
- **Der Web-Player holt das Lesetoken nur beim Verbindungsaufbau.** Eine sehr
  lange ununterbrochene Sitzung kann so an einem abgelaufenen Token hängen.
- **Windows „Desktop + Mikrofon" wird still zu video-only** (`audio/wasapi.rs`:
  die Mischstufe wurde nie gebaut, der Aufruf liefert immer `Err`, ohne Meldung
  an die Oberfläche).
- **macOS-Fensteraufnahme läuft in Bildschirmgrösse**, weil eine Fensterkennung
  als Bildschirmnummer gelesen wird — im Code als Testfall festgehalten.

---

## 3. Ausdrücklich sauber

Damit das nicht untergeht — geprüft und in Ordnung befunden:

- **Vollbild-Abstand:** Vorgabe, Grenzen (0,1–120 s), Umrechnung in die
  GOP-Länge, keine Überläufe bei 120 s × 60 fps. Die beiden Zahlen, die der
  Vorgabe nicht folgen dürfen — die Bremse für angeforderte Vollbilder und die
  Warnschwelle für „langer Takt ohne Rückkanal" — sind auf allen drei Sidecars
  entkoppelt und durch Tests festgehalten. Die erste Anforderung geht überall
  sofort durch (der Einstiegsfall).
- **SDP-Angebot:** meldet genau die Fassungen an, die wirklich gesendet werden,
  samt gerechneter H.264-Stufe, `stereo=1` und den Rückmeldungen, an denen der
  ganze Sendeweg hängt. Der Weg bis ins fertige SDP ist getestet, nicht nur die
  Rechnung davor.
- **NACK:** trägt in beide Richtungen. Sendeseitig 8192 Pakete Verlauf je
  Strom, Nachlieferung auf demselben Strom ohne RTX — dokumentiert, gemessen,
  richtig so.
- **Nativer Player:** Vollbild-Anforderung an drei Stellen verdrahtet
  einschliesslich Einstiegsfall, adaptiver Jitter-Puffer, RTT-gekoppelte
  Geduld, begrenzte Antwortgrösse, Origin-Prüfung, Token-Schwärzung.
- **Browser-Player:** Munging nur auf der Opus-fmtp-Zeile und vor
  `setLocalDescription`, kein Codec-Zwang, Wächter gegen „verbunden, aber kein
  Bild" mit begrenzter Versuchszahl, sauberer Abbau, vollständige
  `getStats()`-Auswertung, kein Token im Log.
- **Kein Stream-Key und kein Token im Klartext-Log** auf allen drei
  Plattformen.
- **Prozessführung** der Sidecars: kein Zombie, kein Verklemmen, saubere
  `Drop`-Implementierungen.
- **B-Frames** überall bewusst 0.

---

## 4. Was danach noch offen ist

1. **Die Windows- und macOS-Änderungen auf einer echten Maschine übersetzen.**
   Sie sind auf einem Linux-Rechner geschrieben; `win-build` und `mac-build`
   sind der erste echte Übersetzungsversuch. Für den macOS-Wächter gilt das
   besonders: die Bibliothek liegt auf dem Schreib-Rechner nicht einmal vor,
   die Schnittstelle wurde gegen den heruntergeladenen Quellcode der Crate
   geprüft.
2. **2.1 messen** — ob die Parität im Browser nicht nur ankommt, sondern auch
   repariert. Seit dem 2026-07-31 die offene Frage.
3. **2.7 zu Ende bringen**: nach dem Bau von `1.19.1-pulse6` die drei
   compose-Dateien umstellen.
4. **Den macOS-Quellverlust auf `reason: "source_closed"` heben** (s. 2.5), damit
   der Zuschauer denselben Text bekommt wie unter Windows.
5. **Die Tests des Mac-Sidecars in ein Gate bringen.** `mac-build` baut nur;
   134 Tests laufen weiterhin nur, wenn jemand daran denkt. Dieselbe
   Fehlerklasse, die dieser Bericht unter 1.4 beschreibt.
6. 2.3 und 2.6 nach Bedarf.
