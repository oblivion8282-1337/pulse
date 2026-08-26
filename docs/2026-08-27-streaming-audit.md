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

Der D3D12-Weg hängt an `PULSE_HQ_AMD_D3D12=1` und ist damit eine Gegenprobe,
kein Auslieferweg. Mitgezogen wurde er trotzdem: eine Gegenprobe, die den
Rückkanal nicht bedient, misst etwas anderes als der Regelweg und fällt als
Vergleich still aus.

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

### 2.2 REMB wird nur unter Windows ausgewertet

Das gemeinsame SDP bietet `goog-remb` auf allen drei Plattformen an. Ausgewertet
wird es nur im Windows-Sidecar (`whip/bandbreite.rs`, `BandbreitenWacht`):
Hysterese über 3 s, meldet `bandwidth_low`/`bandwidth_ok`, ändert bewusst keine
Bitrate. Linux und macOS verwerfen jedes REMB-Paket still — keine Meldung, kein
Log. Eine zu enge Leitung zahlt der Nutzer dort als wachsende Latenz, ohne dass
irgendwo eine Zahl steht.

**Warum nicht behoben:** der richtige Weg ist, `bandbreite.rs` in die
gemeinsame Kiste `pulse-whip` zu ziehen (wie zuvor Taktgeber und SDP) und alle
drei daran zu hängen. Das berührt drei Plattformen, zwei davon lassen sich auf
diesem Rechner nicht übersetzen, und diese Nacht trägt bereits ungeprüfte
Windows-Änderungen. Eine Umsetzung nur für Linux verschöbe die Drift bloss.

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

### 2.4 Kein Sidecar merkt einen ICE-Abriss

In keinem der drei `whip/mod.rs` gibt es
`on_ice_connection_state_change`/`on_peer_connection_state_change`. Ein
Verbindungsabriss nach erfolgreichem Handschlag wird nirgends aktiv erkannt
oder geloggt; die Erkennung läuft indirekt über Schreibfehler beim Senden. Ob
ein reiner ICE-Ausfall bei bestehendem SRTP-Kontext zeitnah einen Schreibfehler
auslöst oder Pakete lokal „erfolgreich" ins Leere gehen, ist offen.

### 2.5 macOS bemerkt keinen Quellverlust

`SCStream::initWithFilter_configuration_delegate` bekommt überall `None` als
Delegate → kein `stream:didStopWithError:`. Bricht ScreenCaptureKit selbst ab
(Quelle weg, Berechtigung entzogen, Fenster geschlossen), läuft der Medien-Loop
weiter und dupliziert das letzte Bild. Beim Zuschauer sieht das aus wie ein
Standbild, nicht wie ein Abbruch. Damit ist macOS an dieser Stelle schlechter
gestellt als Windows, wo wenigstens Fenster-Quellen erkannt werden (Monitore
nicht — der bekannte, in `CLAUDE.md` offen geführte Punkt).

### 2.6 Der CPU-/Intel-Weg signalisiert den Farbraum ebenfalls nicht — aber die
naheliegende Korrektur wäre falsch

Der Leselauf hat ihn zusammen mit D3D12 gemeldet. Er ist aber **nicht** derselbe
Fall: `scaling::Context::get(BGRA → NV12, BILINEAR)` fährt in swscale ohne
weitere Angabe die **BT.601**-Matrix. Dort einfach BT.709 anzusagen, machte den
Fehler grösser statt kleiner. Richtig wäre, swscale ausdrücklich auf BT.709
limited zu stellen UND das anzusagen — zwei Änderungen, die zusammengehören und
auf Windows gemessen sein wollen.

### 2.7 `PULSE_REVISION` wurde für Patch 0006 nie hochgezählt

`1.19.1-pulse5` trägt zwei verschiedene Bildinhalte, einen mit und einen ohne
die Bildmarken-Durchreichung. Genau die Mehrdeutigkeit, gegen die der Zähler
gebaut wurde. Nicht behoben, weil das Hochzählen den Bildnamen bewegt: erst
bauen lassen, dann die drei compose-Dateien umstellen — die andere Reihenfolge
holt ein Bild, das es noch nicht gibt. Als Notiz im Dockerfile festgehalten.

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

## 4. Empfohlene Reihenfolge für das, was offen ist

1. **Die Windows- und macOS-Änderungen aus 1.1–1.3 auf einer echten Maschine
   übersetzen und laufen lassen.** Sie sind auf einem Linux-Rechner
   geschrieben; das Gate sagt das ausdrücklich an, prüft es aber nicht.
2. **2.1 messen** — ob die Parität im Browser nicht nur ankommt, sondern auch
   repariert. Das ist seit dem 2026-07-31 die offene Frage und die einzige,
   die an der 60-s-Entscheidung für Browser-Zuschauer wirklich hängt.
3. **2.2 umsetzen**, wenn ohnehin ein Windows-Bau ansteht: `bandbreite.rs` nach
   `pulse-whip`, alle drei daran.
4. **2.7 nachziehen**, sobald der nächste MediaMTX-Bau fällig ist.
5. 2.4–2.6 nach Bedarf.
