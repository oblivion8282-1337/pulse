# Vierter Bughunt — nativer HQ-Player (`streaming/pulse-player`)

Stand 2026-08-08. Rein lesende Prüfung (der Crate baut hier nicht, `vendor/webrtc-rs` fehlt).
Grundlage: 35 Befunde aus sechs Prüf-Linsen, jeder von drei unabhängigen Skeptikern
gegengelesen. Nach dem Entdoppeln bleiben **34** Befunde; drei davon sind gegenüber der
Erstmeldung **herabgestuft**, einer ist nur eingeschränkt erreichbar.

## Zusammenfassung

Der Player ist nach drei vorherigen Durchgängen im Kern stabil — die tragenden Wege
(Jitter, Nachforderung, Neuaufbau, Tonanlauf) sind mit Messungen belegt und größtenteils
getestet. Das verbliebene Risiko sitzt fast vollständig in den **jungen Randpfaden**:
Zero-Copy/GPU-Bilder (zwei Speichersicherheitsfehler, davon einer bei praktisch jedem
Sitzungsende auf Linux), HDR (ein sicherer wgpu-Absturz beim ersten HDR-Bild auf Windows)
und die neu eingezogenen Nebenwege (FlexFEC, Auffangnetz, Aufnahme). Zwei Fehler kann ein
**fremder Sender** unmittelbar auslösen: ein STAP-A-Paket mit einem überzähligen Byte
lässt den H.264-Depacketizer über das Pufferende lesen, und ein Auflösungswechsel mitten
im Strom liefert dauerhaft ein falsch beschnittenes Bild. Auffällig ist ein Muster, das
sich durch mehrere Befunde zieht: **Wächter und Zähler decken den Weg nicht ab, den sie
zu decken behaupten** (Einfrier-Wächter, Bilanz-Wache, `alive`, `fec_repariert`) — die
Kommentare versprechen dort mehr als der Code hält.

---

## Kritisch

### 1. HDR-Formatwechsel macht zwischengespeicherte Bindegruppen inkompatibel — wgpu bricht mit Panik ab
`src/render/fremdbild.rs:175` — **kritisch, Absturz**

`Fremdbilder::importe` (Cache der Bindegruppen je NT-Handle/VkImage) wird nur geleert, wenn
sich `bauart` (Breite/Höhe/Bittiefe) ändert. Ein Wechsel des Oberflächenformats (SDR→HDR)
ändert `bauart` nicht. `Renderer::farbraum_fuer_quelle` (`src/render/hdr_fenster.rs:337-376`)
baut bei einem Formatwechsel über `build_graphics()` aber ein **neues**
`wgpu::BindGroupLayout` und ersetzt `bind_layout`/`pipeline`. wgpu vergleicht Layouts beim
Zeichnen über Zeiger-Identität (`Arc::ptr_eq`), nicht strukturell — die alte Bindegruppe
ist danach `Incompatible`. Der Player registriert nirgends einen `on_uncaptured_error`-
Handler, also greift wgpus `default_error_handler` und der beendet den Prozess mit `panic!`.

Ablauf: Erstes Zero-Copy-HDR-Bild (Windows P010/AV1 über WHIP). In `draw_inner` läuft
`renderer.upload(&frame)` (`src/app/mod.rs:605`) **vor** `farbraum_fuer_quelle(*farbe)`
(Zeile 617). `upload` legt die Bindegruppe gegen das noch geltende SDR-Layout an, direkt
danach tauscht `farbraum_fuer_quelle` Pipeline und Layout aus, und `render()` zeichnet die
alte Bindegruppe mit der neuen Pipeline. Reproduzierbar beim ersten HDR/PQ-Bild auf einem
HDR-fähigen Windows-Schirm.

Behebung: `Fremdbilder` das zuletzt benutzte Layout merken und in `binden()` per
`Arc::ptr_eq` vergleichen (Cache leeren bei Wechsel), oder `farbraum_fuer_quelle` nach
einem Formatwechsel ein `Fremdbilder::invalidieren()` rufen lassen.

### 2. Ringplatz gibt seine VkImages frei, nachdem wgpu das VkDevice schon zerstört hat
`src/zerocopy/linux/platz.rs:176` — **kritisch, Speichersicherheit**

`Vkseite` hält nur geklonte ash-Griffe (`src/zerocopy/linux/vkbild.rs:29-42`); sie halten
das wgpu-Gerät nicht am Leben — der Modulkopf formuliert genau das als Auflage und
begründet sie damit, dass die `Vkseite` "in der Brücke des Decoders sitzt". Die Auflage
gilt aber nicht nur für die Brücke: jeder `Ringplatz` hält ebenfalls ein `Arc<Vkseite>`
und ruft im `Drop` `vk.freigeben` (`vkDestroyImage`/`vkFreeMemory`, `vkbild.rs:195-198`).
Und ein `Ringplatz` überlebt die Brücke absichtlich — jedes `GpuBild` hält ihn, und
`GpuBild`er liegen in `pending` (`src/app/mod.rs:185`) und in der Takt-Warteschlange
(Zeile 191), die beide **nach** `renderer` (Zeile 164) verworfen werden.

Ablauf: Strom endet regulär → `session::run` sendet `Ended` → `close_session`
(`src/app/mod.rs:1036`) verwirft die `Session` in Felderreihenfolge: mit dem Renderer fällt
das letzte `wgpu::Device`, wgpu-hal führt `vkDestroyDevice` aus (schon das ist regelwidrig,
die VkImages leben noch), **danach** fällt `pending`/`takt` und der letzte `Ringplatz`
zerstört seine Images auf einem toten Gerät. Trifft praktisch jedes Sitzungsende auf dem
Zero-Copy-Weg. (Dass der Decoder-Klon des Geräts zu diesem Zeitpunkt weg ist, ist streng
genommen ein Wettlauf zwischen Tokio-Task und Fenster-Faden — die Zeitverhältnisse machen
ihn aber sehr wahrscheinlich.)

Behebung: `Vkseite` einen `wgpu::Device`-Klon mitführen (billig, hält die hal-Ebene) —
dann ist die Lebensdauer-Auflage strukturell erfüllt, egal wer zuletzt loslässt.
Ergänzend `pending`/`takt` in `close_session` ausdrücklich vor dem Renderer verwerfen.

---

## Hoch

### 3. STAP-A mit einem überzähligen Byte liest über das Pufferende — Panik im Sitzungs-Task
`src/depacket/mod.rs:110` — **hoch, Absturz, von außen auslösbar**

`Kind::H264` reicht die rohe Sendernutzlast an `H264Packet::depacketize`. Dessen
STAP-A-Zweig (rtp-0.17.2, `src/codecs/h264/mod.rs:237-239`) prüft in der Schleifenbedingung
nur `curr_offset < packet.len()`, liest im Rumpf aber `packet[curr_offset]` **und**
`packet[curr_offset + 1]`. Bleibt nach dem letzten NALU-Eintrag genau ein Byte übrig,
panickt der Zugriff. Die Behandlung `Err(_) => *dropped = true` (Zeile 114) fängt nur
`Result`, keine Panik.

Ablauf: Nutzlast `[0x18, 0x00, 0x00, 0xAA]` (NALU-Typ 24 = STAP-A). Erster Durchlauf:
`nalu_size = 0`, `curr_offset` bleibt 3. Zweiter Durchlauf: `3 < 4` hält, `packet[4]` liegt
hinter dem Puffer. Genauso mit jedem wohlgeformten STAP-A plus einem Füllbyte. Der
Sitzungs-Task ist losgelöst gestartet (`src/app/mod.rs:334-341`) und sein `JoinHandle` wird
nicht ausgewertet — es kommt nie ein `Ended`, das Bild friert wortlos ein.

Behebung: Bei `nalu_type == 24` die Längentabelle vorab prüfen (`curr_offset + 2 >
packet.len()` → verwerfen), oder `catch_unwind` um `depacketize`. Zusätzlich sollten die
Sitzungs-Tasks ihren `JoinHandle` auswerten und bei `is_panic()` ein `Ended` melden.

### 4. Windows-Brücke schließt die NT-Handles des alten Rings, während Bilder mit genau diesen Handles noch unterwegs sind
`src/zerocopy/bruecke.rs:293` — **hoch, Speichersicherheit**

`ring_bauen` schließt am Ende alle Handles des alten Rings, obwohl `GpuBild` nur den
Zahlenwert `handle` mitführt und Bilder des alten Rings noch im Kanal zum Fenster-Faden
(Kapazität 32) und in der Takt-Warteschlange (bis 12) liegen — in der Größenordnung 45 bis
48 Bilder. Der Renderer öffnet das Handle erst beim **ersten** Zeichnen dieses Ringplatzes
(`src/render/fremdbild.rs:470-491`). `Fremdbilder` leert seinen Zwischenspeicher nur bei
geändertem `bauart` — für die schon unterwegs befindlichen alten Bilder hat sich die
Bauart aber gerade nicht geändert.

Ablauf: Auflösungs- oder Formatwechsel mitten im Strom (ausdrücklich vorgesehen,
`bruecke.rs:319-321`). Danach laufen die eingereihten alten Bilder durch
`Fremdbilder::binden`; war der Ringplatz noch nie gezeichnet, greift der `Vacant`-Zweig und
`OpenSharedHandle` läuft auf ein geschlossenes Handle. Guter Ausgang: Fehler → Zero-Copy
wird für die Sitzung stillgelegt. Schlechter Ausgang: Windows hat den Handle-Wert
zwischenzeitlich an ein anderes Kernel-Objekt desselben Prozesses vergeben (der Renderer
legt je Bild Ereignisse/Zäune an) und es wird blind geöffnet.

Behebung: `Ringplatz` in ein `Arc` mit `Drop`→`CloseHandle` legen und jedes `GpuBild`
seinen Platz halten lassen (wie auf Linux). Billiger: Generationsnummer je `GpuBild`, und
`binden` verwirft ältere Generationen.

### 5. `on_gap` setzt den H.264-Depacketizer nicht zurück — Fragmentreste überleben die Lücke
`src/depacket/mod.rs:83` — **hoch, Korrektheit**

`Assembler::on_gap` leert nur `unit` und setzt `dropped`, fasst den Zustand **im**
`H264Packet` nicht an. Der hält in `fua_buffer` die eingesammelten FU-A-Bruchstücke; das
Crate wertet das S-Bit nie aus und leert den Puffer ausschließlich beim E-Bit. Geht das
E-Paket verloren, überleben die Reste und werden vor die nächste FU-A-NAL geklebt.

Präzisierung der Skeptiker (im Erstbefund zu direkt dargestellt): betroffen ist **nicht**
die erste Einheit nach der Lücke — die wird über `dropped` korrekt verworfen (Test
`gap_verwirft_h264_einheit`). Der Leck-Pfad braucht zusätzlich ein Marker-Paket, das selbst
kein FU-A-Ende ist (einzelne NAL oder STAP-A als letztes Paket einer Einheit — bei SEI und
kleinen P-Slices der Normalfall): das setzt `dropped` zurück, ohne `fua_buffer` zu leeren.
Die **danach** folgende, lückenlose FU-A-NAL — typischerweise die per PLI angeforderte IDR
— übernimmt dann die alten Reste, gilt als sauber, und `decode.rs` hebt auf ihr
`awaiting_keyframe` auf (Zeile 1237). Der Decoder steigt auf einer verfälschten IDR ein und
zeigt bis zum nächsten Keyframe Bildmüll — genau der "stille Bildmüll", den der Modul-Doc
(`mod.rs:35-46`) als ausgeschlossen beschreibt.

Behebung: In `on_gap` den Depacketizer neu anlegen (`H264Packet { is_avc, ..Default }`).
Test: FU-A-Sequenz ohne E-Bit unterbrechen, prüfen dass die nächste NAL nur eigene Bytes
enthält.

### 6. Auflösungswechsel mitten im Strom: `hw_ziel` wird weiterbenutzt, die Bildmaße stammen aus dem alten Puffer
`src/decode.rs:569` — **hoch, Korrektheit, von außen auslösbar**

`in_den_hauptspeicher` benutzt `self.hw_ziel` wieder und prüft nicht selbst, ob Maße oder
Format sich geändert haben; die Neuanlage hängt allein daran, dass FFmpeg den Transfer
ablehnt. Die Ablehnung ist aber nicht symmetrisch: `vaapi_transfer_data_from` prüft nur
`dst->width > hwfc->width || dst->height > hwfc->height`. Beim Wechsel **nach oben** ist
das Ziel kleiner, der Transfer kopiert einen Ausschnitt und meldet Erfolg. Zudem setzt
`av_hwframe_transfer_data` Breite/Höhe des Ziels nur bei der Erstanlage — und `convert`
liest genau diese Felder (Zeilen 1688-1689) statt der Maße des Quellbildes.

Ablauf: Sender wechselt von 720p auf 1080p (bei WebRTC Alltag). Ab da liefert `convert`
dauerhaft ein Bild, das sich als 1280x720 ausgibt und den linken oberen Ausschnitt der
1080p-Quelle trägt; `stats.width/height` melden ebenfalls die alte Größe. Bleibt für den
Rest der Sitzung so.

Behebung: Vor dem Transfer selbst vergleichen (`ziel.width/height/format` gegen GPU-Bild
bzw. `sw_format` des `hw_frames_ctx`), bei Abweichung `*ziel = Video::empty()`. `convert`
die Maße des Quellbildes übergeben.

### 7. Ein dupliziertes Kopf-Paket erneuert im Jitter-Puffer die Ankunftszeit und hält die Geduldsgrenze an
`src/jitter.rs:195` — **hoch, Korrektheit**

`push()` fügt jedes Paket unbedingt per `entries.insert(seq, Entry { packet, arrived })`
ein; bei einem Duplikat überschreibt das die vorhandene `Entry` samt `arrived`. `poll()`
misst die Geduldsgrenze für eine offene Lücke aber genau daran
(`now.duration_since(entry.get().arrived) < self.target`, Zeile 245).

Ablauf: `next=1`, Paket 5 wartet. Kommt eine Dopplung von Paket 5 vor Ablauf von `target`,
fängt die Wartezeit wieder bei 0 an; `Release::Gap` bleibt aus, `Assembler::on_gap` und die
Vollbild-Anforderung (`src/session.rs:508-521`) werden nicht ausgelöst, der Video-Weg
steht. Präzisierung: nicht unbegrenzt — bei `entries.len() > MAX_BUFFERED` (2048) greift
der Zwangsauswurf. Es braucht also eine anhaltende Folge von Dopplungen genau des
vordersten offenen Pakets, dann steht das Bild bis der Deckel greift, ohne dass ein Zähler
das zeigt.

Behebung: `arrived` nur beim ersten Einfügen setzen.

### 8. Die 3-Sekunden-Stille-Erkennung greift schon während des Verbindungsaufbaus
`src/session.rs:721` — **hoch, Korrektheit**

`STILLE_FENSTER_BIS_ABBRUCH` (12 × 250 ms) bricht ab, sobald `bytes_received` drei Sekunden
unverändert bleibt — ohne Bindung an `announced_playing`. Beide Startwerte sind 0 und
`last_stats` läuft ab Sitzungsbeginn; die Prüfung greift also auch, wenn **nie** ein Paket
kam. Genau dafür existiert `FIRST_FRAME_TIMEOUT` mit 20 s, dessen Kommentar (Zeilen 56-68)
ausdrücklich einen "langsamen, aber funktionierenden Start" schützen will. Die
3-Sekunden-Prüfung feuert immer zuerst und macht das Versprechen wirkungslos.

Ablauf: `whep::connect` gelingt, ICE + DTLS + Encoder-Anlauf des Senders brauchen zusammen
über 3 s (unter Last realistisch). Nach 12 Fenstern bricht die Sitzung mit "Verbindung
abgerissen — seit 3 Sekunden kein Paket" ab, obwohl sie nie stand.

Behebung: Prüfung an `announced_playing` binden oder ihren Zähler erst ab dem ersten
empfangenen Byte starten.

### 9. FlexFEC-Parität wird höchstens einmal je Prozesslauf eingesammelt
`src/fec/mod.rs:192` — **hoch, Korrektheit**

`aufsammeln()` schützt sich mit einem prozessweiten `static GESTARTET: AtomicBool`. Einziger
Aufrufer ist `starten()`, und der läuft je Sitzung genau einmal, nur für Videospuren
(`fec_an && codec.is_video()`, `src/whep.rs:540`). Der Doc-Kommentar begründet die Flagge
damit, `on_track` feuere "für Bild und Ton also zweimal" — dieser Fall kann gar nicht
eintreten. Die Flagge schützt vor nichts und bricht dafür jede Folgesitzung.

Ablauf: Electron startet den Player-Prozess **einmal** lazy und verwendet ihn für alle
weiteren `open` (`desktop/electron/player.ts:184-186`). Erste Sitzung setzt die Flagge;
jede weitere Sitzung (Kanalwechsel, Reconnect, zweites Fenster, Auffangnetz) liest auf
ihrem neuen DTLS-Transport kein einziges Paritätspaket mehr — der Server sendet sie weiter,
der Aufschlag wird bezahlt, FlexFEC ist wirkungslos. Nach außen sichtbar nur daran, dass
`fec_repariert` dauerhaft 0 bleibt: genau die Zahl, die laut Modulkopf beweisen soll, dass
Parität läuft. Erschwerend hält die Sammelschleife (`loop { … sleep }`, kein Ausgang) den
`Arc<RTCDtlsTransport>` der **ersten** Sitzung bis zum Prozessende fest.

Behebung: Flagge entfernen (Einmaligkeit ergibt sich bereits daraus, dass `starten` nur je
Videospur läuft) oder an die Zeiger-Identität des Transports binden. Der Schleife einen
Ausgang geben, wenn der Transport tot ist.

### 10. Feinabbau des Audio-Ringpuffers entfernt einzelne Samples statt ganzer Kanal-Frames
`src/audio/ringregelung.rs:118` — **hoch, Korrektheit**

Der Feinabbau-Zweig entfernt mit `pop_front()` genau **ein** f32-Sample, unabhängig von der
Kanalzahl. Der Ring enthält verschränktes Multi-Channel-PCM, das `fill_output`
(`src/audio.rs:121-124`) unverändert in den interleaved Ausgabepuffer kopiert. Die
`Ringregelung` bekommt die Kanalzahl nirgends übergeben, kann Kanalgrenzen also gar nicht
kennen.

Ablauf: 48-kHz-Stereo, 1920 interleaved Samples je Opus-Paket. Liegt der Ring über dem
Sollwert (der im Modul selbst als gesunder Normalzustand beschriebene Fall), überschreitet
`fein_zaehler` die Schwelle `RING_FEIN_TEILER = 2000` etwa alle 25 ms und poppt je ein
Sample. Jeder Pop kippt die Parität: aus L,R,L,R wird R,L,R,L. Korrektur der Skeptiker: das
ist kein einmaliger dauerhafter Tausch, sondern ein **wiederholtes Umkippen** der
Kanalzuordnung im Opus-Pakettakt (dauerhaft bleibt es nur, wenn der Ring nach einem
ungeraden Pop unter den Sollwert fällt). Kein Zähler zeigt das an.

Behebung: Kanalzahl an `Ringregelung` übergeben und immer ein ganzes Frame
(`drain(..channels)`) entfernen.

### 11. Fensterminimierung wird als toter Zero-Copy-Weg fehlgedeutet und schaltet ihn prozessweit dauerhaft ab
`src/einfrieren/gpuabdruck.rs:228` — **hoch, Korrektheit**

`Zulauf::einspeisen_zur_zeit` erklärt den GPU-Rückweg nach `STUMME_BILDER=60` unbeantworteten
Bildern **und** `STUMME_DAUER=5s` für tot und ruft `zerocopy::abschalten`
(`src/decode.rs:1642-1644`). Der GPU-Abdruck wird aber nur berechnet, wenn `Renderer::render`
über `acquire()` eine Surface-Textur bekommt — bei `Cst::Occluded`/`Cst::Timeout`
(minimiertes oder verdecktes Fenster) kehrt `render()` in `src/render/mod.rs:383` zurück,
bevor `abdruckwerk.aufzeichnen` je läuft. Der Decoder läuft unabhängig vom Fensterzustand
weiter und zählt `bild_hinaus()` hoch.

Ablauf: Nutzer minimiert das Fenster (oder eine Vollbildanwendung/Bildschirmsperre verdeckt
es länger als 5 s) — ein normaler Vorgang. Binnen Sekunden ist die Schwelle erreicht, der
Rückweg gilt als tot, `abschalten` legt ein **prozessweites** `AtomicBool` um
(`src/zerocopy/mod.rs:189-198`) und ist ausdrücklich nicht wiederholbar ("Die Gründe sind
alle bleibend"). Da `App::sessions` mehrere Stream-Fenster in einem Prozess hält, verlieren
**alle** Sitzungen den schnellen Weg — auch die sichtbaren, und auch nachdem das
minimierte Fenster längst wieder zeichnet. Der Test `eine_kurze_pause_reicht_nicht` deckt
nur 1,9 s ab.

Behebung: Zähler/Uhr anhalten, solange `acquire()` Occluded/Timeout liefert (oder ein
explizites Sichtbarkeitssignal an `Zulauf`). Zusätzlich den Rückweg pro Sitzung statt
prozessweit abschalten.

### 12. Sitzungsbefehle können in vertauschter Reihenfolge ankommen, weil jeder Sender einen eigenen Task spawnt
`src/app/requests.rs:168` — **hoch, Nebenläufigkeit**

Der Kommando-Kanal `session.commands` hat drei Sendestellen, die je einen losgelösten Task
erzeugen: `apply_options` (Zeilen 168-171, `Options`), `session_reply` (181-201,
`Record`/`StopRecord`/`Clip`) und `close_session` (`src/app/mod.rs:1036-1044`, `Stop`).
`handle_request` wartet auf keinen davon. Tokio garantiert keine Ausführungsreihenfolge
zwischen zwei so eingeplanten Tasks auf einem Multi-Thread-Runtime.

Ablauf: `record` gefolgt von `stop_record` für dieselbe Sitzung. Läuft Task B vor Task A,
schlägt `stop_record` fehl ("keine Aufnahme aktiv"), und **danach** startet
`session::run` die Aufnahme, die niemand mehr stoppt — sie läuft unbemerkt bis
Sitzungsende. Dieselbe Race trifft `close` direkt nach `record`: kommt `Stop` zuerst, wird
der Empfänger verworfen und der `Record`-Befehl samt seines Oneshot-Senders kommentarlos
gedroppt.

Behebung: Alle Sends einer Sitzung über einen sequentiellen Pfad — z. B. `tx.try_send()`
synchron im Request-Handler (Kapazität 16 reicht im Normalfall) statt eines gespawnten
Tasks.

---

## Mittel

### 13. Die H.264-Obergrenze misst nur `unit` — der FU-A-Puffer wächst daran vorbei unbegrenzt
`src/depacket/mod.rs:116` — **mittel, Ressourcenleck**

Der Kommentar (Zeilen 17-23) behauptet, für H.264 gelte dasselbe wie für AV1. Der AV1-Deckel
prüft ausdrücklich `unit.len() + partial.len()` (`av1.rs:199`, dort schon einmal gemessen:
82 MB bei 32 MB Grenze); der H.264-Deckel prüft nur `unit.len()`. Das Gegenstück zu
`partial` liegt hier aber als `fua_buffer` im `H264Packet` und wird erst beim E-Bit
herausgegeben — bis dahin liefert `depacketize` `Ok(Bytes::new())` und `unit` bleibt 0.

Ablauf: Ein Sender schickt fortlaufend FU-A-Pakete mit korrekten Sequenznummern, gesetztem
S-Bit und nie gesetztem E-Bit. Bei 1200 Byte Nutzlast und 5 Mbit/s rund 32 MB je Minute,
ohne Obergrenze; `on_gap` räumt es ebenfalls nicht weg (Befund 5). Der Regressionstest
(Zeilen 202-215) benutzt Einzel-NAL-Pakete und erwischt das nicht.

Behebung: Angehängte Fragmentmenge mitzählen (`nalu_type & 0x1F == 28` → Nutzlast minus 2),
beim E-Bit/Marker nullen, zusammen mit `unit.len()` gegen `MAX_ACCESS_UNIT_BYTES` prüfen.

### 14. Marker-Bit zusammen mit Y=1 liefert ein abgeschnittenes Fragment als vollständigen OBU aus
`src/depacket/av1.rs:209` — **mittel, Korrektheit**

`push` behandelt Marker und Y unabhängig: Zeile 194 merkt sich `expect_continuation = y` und
lässt `partial` bewusst stehen, Zeile 209 flusht im Marker-Zweig bedingungslos.
`append_obu_with_size` schreibt dabei `payload.len()` als LEB128 und behauptet, das
Bruchstück sei ein vollständiger OBU. `poisoned` wird nicht gesetzt, die Einheit geht
hinaus. Überall sonst reagiert der Zusammensetzer auf eine Inkonsistenz mit
`poisoned = true`; dieser eine Widerspruch — "wird fortgesetzt" und "Einheit endet hier" im
selben Paket — rutscht durch. Zusätzlich setzt Zeile 210 `expect_continuation` zurück,
sodass das echte Fortsetzungspaket als Lücke gilt und die nächste intakte Einheit ebenfalls
fällt. Beide Fragment-Tests setzen den Marker nur auf dem Y=0-Paket.

Behebung: Im Marker-Zweig vor dem Flush `if self.expect_continuation { self.poisoned = true; }`.

### 15. Ein unbekanntes Pixelformat ergibt ein dauerhaftes Standbild, das kein Wächter sieht
`src/decode.rs:1663` — **mittel, Fehlerbehandlung**

`convert` lehnt jedes Format außer YUV420P/YUV420P10LE/NV12/P010LE ab und meldet das per
`eprintln!` ohne Ratenbremse (anders als jede andere Wiederholmeldung der Datei). Schwerer
wiegt: in diesem Fall greift **kein** Wächter mehr. `drain` ruft `wacht.bild(&f.planes)` nur
für erfolgreich umgewandelte Bilder, `decode` liefert `Ok(vec![])`, `consecutive_errors`
wurde nach dem erfolgreichen `send_packet` gerade auf 0 gesetzt — `neuaufbau::classify`
kann nie auslösen. Der Einfrier-Wächter kann es auch nicht: `eingefroren_zur_zeit` verlangt
`letzte_aenderung.is_some()`, und das Feld wird nur gesetzt, wenn ein Bild ankommt.

Ablauf: Sender liefert AV1 Profile 1/2 oder H.264 High 4:2:2/4:4:4 → Software-Decoder gibt
`YUV444P`/`YUV420P12LE` heraus. Bytes fließen weiter (also kein Stille-Abbruch),
`FIRST_FRAME_TIMEOUT` greift nach `announced_playing` nicht mehr: das letzte Bild steht
endlos, und stderr bekommt bei 60 fps 60 identische Zeilen je Sekunde.

Behebung: Meldung einmalig bzw. nur beim Formatwechsel. Zähler "Einheit angenommen, aber
kein Bild geliefert" führen und nach einer Serie denselben Weg wie `classify` nehmen.

### 16. `drain` unterscheidet EAGAIN/EOF nicht von echten Fehlern aus `receive_frame`
`src/decode.rs:1568` — **mittel, Fehlerbehandlung**

`while self.decoder.receive_frame(&mut frame).is_ok()` beendet die Schleife bei jedem
negativen Rückgabewert gleich. Ein harter Fehler wird weder gemeldet noch gezählt — die
einzige Fehlerbuchführung hängt an `send_packet` (1249-1272), und `consecutive_errors` ist
in Zeile 1273 gerade auf 0 gesetzt worden. Relevant gerade bei `cuvid`, das die Fehler
seiner Decodier-Rückrufe auf dem `receive_frame`-Weg herausgibt. Fällt dabei gar kein Bild
mehr heraus, greift auch der Einfrier-Wächter nicht (dieselbe Sackgasse wie Befund 15).

Behebung: `Error::Other { errno: EAGAIN }` und `Error::Eof` beenden still, jeder andere
Wert wird wie ein abgelehntes Paket behandelt (`consecutive_errors += 1`, einmalige
Meldung, `classify`).

### 17. Nach dem Rückfall auf Software bleiben Zero-Copy-Ring und `hw_ziel` bis zum Sitzungsende belegt
`src/decode.rs:1356` — **mittel, Ressourcenleck**
*(zwei Linsen haben denselben Fehler gemeldet — hier zusammengefasst)*

`frischer_software_decoder` ersetzt nur `decoder`, `name`, `hardware` und die Zähler;
`self.bruecke` und `self.hw_ziel` bleiben unangetastet. Danach liefert der Decoder
`YUV420P`/`YUV420P10LE`, `bruecke_moeglich` ist dafür falsch — beide Halden werden nie
wieder angefasst und nie freigegeben. Der Kommentar bei 1606-1613 hält das Stehenbleiben der
Brücke sogar fest, behandelt es aber nur als Problem des Einfrier-Wächters.

Ablauf: Drei Grafik-Stockungen in zehn Sekunden → `auf_software` →
`frischer_software_decoder`. Der Windows-Ring hält bis zu 32 geteilte Texturen, gedeckelt
durch `RING_SPEICHER_MAX = 320 MB`; bei 1440p10 (~11 MB je Platz) bleiben also rund 305 bis
320 MB gebunden (der im Code stehende Wert "160 bis 265 MB" rechnet noch mit der alten
Ringgröße 24). Dazu `hw_ziel` mit einem vollen Bildpuffer (5,5 / 11 MB). Genau in dem
Moment, in dem die Grafikeinheit ohnehin in Not war — das war der Anlass des Rückfalls.

Behebung: In `frischer_software_decoder` `self.bruecke = Some(None)` setzen (nicht `None`,
das hieße "noch nicht versucht") und `self.hw_ziel = Video::empty()`.

### 18. Scheitert der Ringaufbau in der Mitte, bleiben die schon erzeugten NT-Handles für immer offen
`src/zerocopy/bruecke.rs:291` — **mittel, Ressourcenleck**

`Ringplatz` hat keinen `Drop`; geschlossen wird ausschließlich in `Bruecke::drop`
(163-177) und in der Aufräumschleife von `ring_bauen` (293-299) — beide über `self.ring`.
Die neuen Plätze sammelt `ring_bauen` aber lokal (279-292) und weist sie erst nach der
vollständigen Schleife zu. Ein `?` in der Schleife (`CreateTexture2D`, `cast`,
`CreateSharedHandle`) verwirft die lokale Liste ohne ein einziges `CloseHandle`.

Ablauf: Ring soll 32 Plätze bekommen, der Grafikspeicher reicht für 17. Bei i=17 schlägt
`CreateTexture2D` fehl; die 17 COM-Zeiger werden freigegeben, die 17 NT-Handles nicht — und
da ein offenes geteiltes Handle eine Referenz auf die Ressource hält, bleibt auch deren
Speicher bis zum Prozessende belegt. Anschließend schaltet der Aufrufer
(`src/zerocopy/uebergabe.rs:51-84`, nicht wie im Erstbefund 86-93) die Brücke dauerhaft ab,
das Leck bleibt.

Behebung: `Ringplatz` einen `Drop` mit `CloseHandle` geben; dann können beide
Aufräumschleifen entfallen und jeder Abbruchpfad ist gedeckt.

### 19. BT.2020-Matrix ohne PQ bleibt im SDR-Zweig des Shaders unkonvertiert
`src/render/shader.wgsl:321` — **mittel, Korrektheit**

`matrix_of` setzt `Bt2020Ncl` für jeden BT2020-Farbraum unabhängig von der Transferkennung
(`src/decode.rs:834-850`), und `farbangaben_von` fällt für jede nicht als SMPTE2084 erkannte
Kurve (also auch HLG) bewusst auf `Uebertragung::Sdr` zurück — der Kommentar dort sagt
ausdrücklich, dass so ein Strom real ankommen kann. Im Shader wendet `yuv_to_rgb` die
BT.2020-Matrix an, `bt2020_zu_bt709` (Zeilen 255-261) wird aber nur innerhalb von
`pq_ausgeben` gerufen, also nur bei `hdr.x > 0.5`. Der SDR-Zweig (317-327) clamped nur.

Ablauf: Sender liefert BT2020NCL mit HLG oder ohne gesetzte `color_trc` → `output.y = 2.0`,
`hdr.x = 0.0` → das Bild bleibt in BT.2020-Primärvalenzen und wird auf einer
BT.709-Oberfläche ausgegeben: sichtbar zu gesättigte Farben, vor allem Grün und Hauttöne.
Erschwerend existiert mit `weiter_farbraum` ein Feld, das den Fall abdecken sollte, aber
nirgends ausgewertet wird.

Behebung: Im SDR-Zweig `bt2020_zu_bt709` anwenden, wenn `output.y > 1.5` — nur die
Primärvalenzen, ohne PQ-Kurve.

### 20. Ein zur Laufzeit geändertes Jitter-Ziel wirkt nicht auf danach angelegte Puffer
`src/session.rs:443` — **mittel, Korrektheit**

`target` ist eine einmal beim Sitzungsstart berechnete lokale Variable.
`SessionCommand::Options` aktualisiert nur die bereits existierenden Puffer
(`for b in buffers.values_mut() { b.set_target(t); }`, Zeilen 381-387); die äußere Variable
bleibt. Neue Puffer entstehen weiterhin mit ihr:
`buffers.entry(codec).or_insert_with(|| JitterBuffer::new(target))`.

Ablauf: Sitzung startet mit 15 ms, Video-Puffer wird angelegt. Der Nutzer stellt auf 50 ms.
Kommt das erste Opus-Paket erst danach, puffert die Audiospur dauerhaft mit 15 ms, während
`stats.jitter_target_ms` durchgehend 50 meldet.

Behebung: `target` im Options-Zweig mit aktualisieren oder beim Anlegen
`stats.jitter_target_ms` verwenden.

### 21. FEC-Rückrechnung akzeptiert Schutzgruppen mit genau einem Mitglied
`src/fec/flexfec03.rs:189` — **mittel, Robustheit** *(herabgestuft von "hoch/Sicherheit")*

`kopf_lesen()` lehnt nur eine völlig leere Maske ab (Zeilen 132-134), nicht eine mit genau
einem gesetzten Bit. Fehlt ausgerechnet dieses eine Element, ist `vorhanden` in
`Empfaenger::versuchen` leer, beide XOR-Schleifen in `zurueckrechnen()` laufen null Mal,
und das "reparierte" Paket besteht wörtlich aus den Bytes, die der Absender im
Paritätspaket mitgeschickt hat. Es wird als `repariert` gezählt und über `tx.send` in den
Jitter-/Decoder-Pfad eingespeist.

**Nachgeprüft (ein Skeptiker widersprach, zu Recht):** Das ist keine Sicherheitslücke. Der
primäre Empfangsweg (`src/whep.rs:726-757`) liefert jedes echte RTP-Paket ebenso ungeprüft
an denselben Kanal — der WHEP-Sender hat also ohnehin volle Kontrolle über beliebige
Paketinhalte, ganz ohne FEC-Umweg. Bei Gruppengröße 1 ist die Paritätsnutzlast durch die
XOR-Identität zudem zwangsläufig bytegleich mit dem Original; das Verfahren ist an dieser
Stelle also nicht falsch gerechnet. Übrig bleibt eine fehlende Plausibilitätsprüfung: eine
Gruppe ohne ein einziges echtes Vergleichspaket sollte nicht durchlaufen und schon gar
nicht als `repariert` gezählt werden — die Zahl soll ja belegen, dass Parität wirkt.

Behebung: In `kopf_lesen()` Mindestgruppengröße 2 erzwingen bzw. in `zurueckrechnen()` bei
leerem `vorhanden` abbrechen.

### 22. WHEP-Antwortkörper wird ohne Größenbegrenzung vollständig in den Speicher gepuffert
`src/whep.rs:685` — **mittel, Sicherheit**

Der HTTP-Client wird nur mit einem Zeit-Timeout gebaut (15 s, Zeilen 553-556), ohne
Größenbegrenzung. `res.text().await` liest den kompletten Body in einen `String`, bevor
überhaupt geprüft wird, ob es plausibles SDP ist (`answer.contains("v=")`, Zeile 686).

Ablauf: Ein bösartiger oder kompromittierter WHEP-Endpunkt (etwa eine fremde
Self-Host-Instanz) antwortet mit HTTP 200 und mehreren hundert MB Body. Über LAN/localhost
passt das locker in 15 s; jeder Zuschauer-Prozess, der diesen Stream öffnet, alloziert das
vollständig.

Behebung: Body gestreamt lesen und nach einer kleinen Obergrenze abbrechen (SDP-Antworten
sind wenige KB).

### 23. Fehlschlag beim Öffnen des Ausgabegeräts markiert `alive` nie als `false`
`src/audio.rs:341` — **mittel, Fehlerbehandlung**

`s.alive = false` wird ausschließlich nach der Rückkehr aus `pump_commands()` gesetzt
(Zeilen 349-352). Schlägt `build_output_stream()` (337-343) oder `stream.play()` (344-347)
fehl, kehrt der Thread per `return` zurück, ohne diese Zeilen — ebenso bei jeder Panik im
Thread. `alive` bleibt für immer `true`, obwohl der Thread tot ist. Die Kommentare (84-87,
376-378) behaupten ausdrücklich, der Fall "Gerätefehler" sei durch `alive` abgedeckt; das
gilt nur für Sperren-Poisoning. Dieselbe Lücke hat der Fehler-Callback (Zeile 334), der bei
Geräteverlust während der Wiedergabe nur loggt.

Behebung: `alive = false` auch in den Err-Zweigen setzen, besser: Drop-Guard, der beim
Verlassen des Thread-Scopes (regulär, `return` oder Panik) greift.

### 24. Der 60-Sekunden-Clip-Ringpuffer kopiert jede Zugriffseinheit per `to_vec()`
`src/recorder.rs:395` — **mittel, Performance**

In `session.rs` entsteht `unit: Bytes` (referenzgezählt, im Depacketizer bewusst so
gewählt). `MediaSink::handle_unit(&[u8])` entwertet den Typ zu einem Slice und ruft
**unbedingt** `recorder.push(...)` — unabhängig davon, ob aufgenommen wird. `Recorder::push`
baut daraus `Unit { data: data.to_vec(), .. }` und legt sie in den dauerhaft laufenden
60-Sekunden-Ring.

Ablauf: Bei jedem Stream, mit oder ohne Aufnahme, läuft für jedes Video- und jedes
Audio-Bild ein vollständiges memcpy in Höhe der gesamten Bitrate, und die Kopie bleibt 60
Sekunden liegen — für ein Feature, das die meiste Zeit nicht abgerufen wird.

Behebung: `Unit.data`, `MediaSink::handle_unit` und `Recorder::push` auf `bytes::Bytes`
umstellen; am Aufrufort genügt dann ein `unit.clone()`.

### 25. Mit Auffangnetz läuft der Hauptstrom wieder durch einen 8-Bilder-Kanal — die gemessene Vergrößerung auf 32 ist wirkungslos
`src/app/mod.rs:290` — **mittel, Performance**

`spawn_with_fallback` legt für den Hauptstrom einen eigenen Zwischenkanal fester Größe 8 an;
dieser Kanal ist es, den `session::run` als `events` bekommt und in den `emit_frames` per
`try_send` einstellt. Der absichtlich vergrößerte `ev_tx` (`ev_kanal_groesse()`, Vorgabe 32)
sitzt erst dahinter. Der Kommentar bei 402-436 begründet die Vergrößerung mit einer Messung
vom 2026-08-07 (Kapazität 8: 67/91 gezeichnete Bilder je Sekunde bei 859/876 verworfenen;
Kapazität 32: 112/108 bei 193/223) — genau dieser Gewinn fällt weg, sobald ein Auffangnetz
mitläuft. Zusätzlich meldet die einmalige "wirksam"-Zeile (1098-1102) `ev_kanal_groesse()`,
also 32, während 8 gelten — eine Zeile, deren erklärter Zweck ist zu sagen, was wirklich
läuft. Ein Lauf mit `--netz` (`streaming/testbench/ansehen.py`) misst damit systematisch
etwas anderes als ein Lauf ohne.

Behebung: Beide Zwischenkanäle aus `ev_kanal_groesse()` speisen; die "wirksam"-Zeile die
tatsächliche `max_capacity()` des benutzten Senders melden lassen.

### 26. Vor dem ersten dekodierten Bild zeichnet der Renderer gar nichts
`src/render/mod.rs:340` — **mittel, Korrektheit**

`Renderer::render` steigt in der ersten Zeile aus, solange kein Bild hochgeladen ist:
`let Some(quelle) = self.bild.as_ref() else { return Ok(()) };`. Damit wird weder die
Oberfläche geholt noch der Clear-Pass ausgeführt noch der `OverlayPass` benutzt — `paint`
steht erst bei 459-471. Der Kommentar in `App::open` (`src/app/mod.rs:527-529`) behauptet das
Gegenteil: "Einmal zeichnen, bevor das erste Bild da ist: sonst zeigt das Fenster
undefinierten Inhalt … und die Bedienoberfläche wäre nicht auffindbar."

Ablauf: `open` fordert einen Redraw an, der Durchgang läuft bis `renderer.render(...)` und
liefert nichts ab. Bis zum ersten Bild (bei Intra-Refresh bis zu `FIRST_FRAME_TIMEOUT` =
20 s, bei ausbleibendem Vollbild bis zum Abbruch) zeigt das Fenster undefinierten
Swapchain-Inhalt, und die eigene Bedienleiste (Stumm, Vollbild, Zurück in die Kachel) ist
weder sichtbar noch anklickbar; auch der Doppelklick-Vollbildumschalter wird nur in
`paint()` ausgewertet. Das Fenster selbst behält die native Titelleiste, ist also
schließbar.

Behebung: Ausstieg hinter das Holen der Oberfläche legen, Clear-Pass und Overlay immer
ausführen, nur den Bild-Zeichenaufruf hinter `if let Some(quelle)` stellen.

---

## Niedrig

### 27. Dateipfad aus den RPC-Ops `record`/`clip` landet ungeprüft im Dateisystem
`src/recorder.rs:245` — **niedrig, Verteidigungstiefe** *(herabgestuft von "hoch/Sicherheit")*

`Request.path` wird für `record` und `clip` ohne jede Prüfung übernommen und landet über
`session.rs` direkt in `ffmpeg::format::output(&path)`. Keine Kanonisierung, keine
`..`-Prüfung, kein Basisverzeichnis, kein Symlink-Schutz; `with_container()` ersetzt nur die
Endung. Der Kommentar in `src/proto.rs:60-64` ("beide Ops sind noch nicht gebaut",
`#[allow(dead_code)]`) widerspricht dem Code — die Ops sind längst verdrahtet.

**Nachgeprüft (ein Skeptiker widersprach, zu Recht):** Die einzige Aufruferseite verhindert
das bewusst und dokumentiert. `desktop/electron/preload.ts:132-139` exponiert
`record(session)`/`clip(session, seconds)` **ohne** Pfad-Parameter;
`desktop/electron/main.ts:819-821` nimmt `record`/`clip` ausdrücklich aus
`ALLOWED_PLAYER_OPS` heraus ("die tragen einen Dateipfad und laufen deshalb über eigene
Kanäle, bei denen der Hauptprozess das Ziel bestimmt"); `player.ts::recordingDir/`
`recordingPath` bauen den Pfad allein aus `app.getPath('videos')`. Ein XSS im Renderer kann
also strukturell keinen Pfad injizieren, und ein kompromittierter Hauptprozess hätte als
Node-Prozess ohnehin freien Dateisystemzugriff. Bleibt: die Verteidigung ist nur einfach,
nicht doppelt — und für `record` gibt es playerseitig **keine** Dauer- oder
Größenobergrenze.

Behebung (optional, als zweite Schicht): Zielpfad gegen ein festes Aufnahmeverzeichnis
kanonisieren, und für laufende Aufnahmen eine Maximaldauer/-größe erzwingen.

### 28. Ein mitgeliefertes `obu_size` wird ungeprüft durchgereicht
`src/depacket/av1.rs:89` — **niedrig, Korrektheit**

`append_obu_with_size` übernimmt einen OBU mit gesetztem `obu_has_size_field` byte-gleich,
ohne das Feld gegen die tatsächliche RTP-Elementlänge zu halten — die verbindlich ist und an
dieser Stelle vorliegt (Zeilen 168-181). Der Zweig ist laut Kommentar (394-400) ausdrücklich
für fremde Sender gedacht. Damit bestimmt der Sender frei, wo nachgelagerte Parser
OBU-Grenzen sehen.

Ablauf: Element mit 400 Byte, im Kopf `obu_size = 1`. `scan_av1_for_keyframe`
(`src/recorder.rs:165-192`) springt nach einem Byte weiter und deutet ein beliebiges
Nutzlastbyte als OBU-Kopf; trifft es zufällig die Keyframe-Muster, meldet `is_keyframe`
true und der Decoder steigt auf einer Einheit ein, die kein Einstiegspunkt ist. Umgekehrt
(zu großes `obu_size`) verschwinden folgende OBUs still. Kein Absturz — alle Scanner sind
bounds-gecheckt, und `send_packet` fängt einen kaputten Bitstrom robust ab.

Behebung: Kopflänge + LEB128-Breite + `obu_size` muss exakt `obu.len()` ergeben, sonst
verwerfen und `poisoned` setzen.

### 29. `surface_is_linear()` schließt `*_SRGB`-Formate aus, obwohl die Hardware dort selbst kodiert
`src/render/farbe.rs:167` — **niedrig, Korrektheit**

`surface_is_linear()` liefert nur für `Rgba16Float` `true`. Der Kommentar begründet den
Ausschluss der `*_SRGB`-Formate damit, die Hardware kodiere beim Schreiben selbst, eine
zusätzliche Umrechnung wäre doppelt. Tatsächlich ist es umgekehrt: Die ROP behandelt die
Shader-Werte als **linear** und wendet die sRGB-Kurve beim Speichern an — da `rgb` bereits
gamma-kodiert vorliegt, kodiert die Hardware ein zweites Mal.

Ablauf: nur über die Diagnose-Variable `PULSE_PLAYER_SURFACE=bgra8srgb` erreichbar (kein
Code-Pfad setzt sie), dann wirkt das Bild in Mitten und Schatten ausgewaschen (die
Erstmeldung schrieb "zu dunkel" — die Richtung ist andersherum). Der Fehler verfälscht
ausgerechnet das Messwerkzeug, das die Farbraumwahl absichern soll; er ist in
`docs/2026-08-04-player-farbwerte-messung.md:157-161` bereits beschrieben.

Behebung: Für `*_SRGB` ebenfalls `true` liefern, damit der Shader linearisiert.

### 30. Bei aktivem FlexFEC wird jedes Video-RTP-Paket per `to_vec()` kopiert
`src/whep.rs:749` — **niedrig, Performance**

`pump_track` marshalt jedes Videopaket zurück nach `Bytes` und ruft dann
`m.try_send((seq, bytes.to_vec()))`; ist zusätzlich die Gegenprobe eingeschaltet (eigener
Diagnoseschalter, im Normalbetrieb aus), kommt ein zweites `to_vec()` dazu. FlexFEC ist seit
2026-08-03 der Standardweg, der Zweig also im Regelbetrieb aktiv. Der Klon in
`empfaenger.rs:263` fällt entgegen der Erstmeldung nur im Reparaturfall an, nicht bei jeder
Prüfung.

Behebung: Kanal und `Vorrat::inhalt` auf `bytes::Bytes` umstellen; dann genügt `clone()`.

### 31. Gegenprobe-Diagnose sammelt Nachlauf-Zeiten unbegrenzt
`src/fec/gegenprobe.rs:145` — **niedrig, Ressourcenleck**

`Pruefstand::nachlauf_us` ist ein `Vec<u64>`, das bei jedem verwertbaren Paritätspaket
wächst und nie verkleinert wird — anders als das direkt daneben liegende `medien`-Feld, das
auf `VORRAT` (512) gedeckelt ist. `PRUEFSTAND` ist ein `static OnceLock<Mutex<…>>`, lebt
also über die ganze Prozesslaufzeit und über beliebig viele Sitzungen hinweg. Erreichbar
nur mit `PULSE_PLAYER_FEC_GEGENPROBE=1`.

Behebung: Analog zu `medien` deckeln oder bei jedem `MELDEABSTAND`-Ausdruck leeren.

### 32. Die Auffangnetz-Sitzung bekommt niemals `Options`
`src/app/mod.rs:292` — **niedrig, Korrektheit**

In `spawn_with_fallback` bekommt die Netz-Sitzung einen eigenen Befehlskanal, in den
ausschließlich `SessionCommand::Stop` gestellt wird (Zeilen 302, 309). `apply_options`
schickt `Options` nur an den Hauptstrom. Die Netz-Sitzung ist aber eine vollwertige
`session::run`: eigener Audio-Transceiver, eigener `MediaSink`, eigenes Ausgabegerät. Der
Filter im Fenster-Faden (Zeile 316) wirft nur **Ereignisse** weg — der Ton läuft daran
vorbei, weil er die Sitzung nie verlässt.

Ablauf: Nutzer drückt Stumm → der Hauptstrom verstummt, das Auffangnetz spielt weiter, und
es gibt keinen Weg, es stummzuschalten. Ebenso erreichen `av_offset_ms` und ein geändertes
`jitter_ms` die Netz-Sitzung nie.

Behebung: `Options` mit an `netz_cmd_tx` spiegeln — oder besser, passend zur Absicht, der
Netz-Sitzung den Ton von vornherein nehmen (kein Audio-Transceiver bzw.
`MediaSink::play_audio` stilllegen).

### 33. Bei Pause verworfene Bilder laufen in keinen Verlustzähler — die Bilanz-Wache meldet Fehlalarm und verstummt danach
`src/app/mod.rs:1053` — **niedrig, Korrektheit**

Im Pause-Zustand kehrt `on_session_event` beim `Frame` zurück, ohne einen Zähler zu
erhöhen. `bilanz_pruefen` rechnet aber `frames_decoded - presented - frames_skipped -
frames_dropped - frames_never_drawn - takt.verdraengt()` und meldet ab `|rest| >
UNTERWEGS_MAX` (150) die Zeile "BILANZ — N Bilder ohne Ausgang … Ein Verlustzähler fehlt."
Die Sitzung dekodiert während der Pause unverändert weiter (`paused` erreicht `session::run`
nie, es ist reine Anzeige-Unterdrückung).

Ablauf: 144 fps, Pause über `set_option paused=true`. Nach gut einer Sekunde ist die
Schwelle überschritten; beim nächsten Bilanz-Durchlauf (`log_stats_if_due`, gedrosselt auf
höchstens einmal je Sekunde, nur bei gesetztem `PULSE_PLAYER_STATS_LOG`) erscheint die
Falschmeldung. `bilanz_gemeldet` ist ein Einmal-Schalter — danach ist die Wache für den Rest
der Sitzung tot und kann ein echtes Leck nicht mehr melden.

Behebung: Zähler `frames_pausiert` führen und in `bilanz_pruefen` abziehen (und in der
Meldung ausweisen).

### 34. Ein dupliziertes Paritätspaket verdrängt eine unbeteiligte, noch lösbare Wartegruppe
`src/fec/empfaenger.rs:179` — **niedrig, Korrektheit — eingeschränkt erreichbar, unsicher**

Die Kapazitätsprüfung prüft nur `self.wartend.len() >= WARTENDE_PARITAET`, bevor sie einen
beliebigen Eintrag entfernt und danach unter `kopf.basis_sequenz` einfügt — ohne zu prüfen,
ob dieser Schlüssel bereits vorhanden ist. Ist er es, hätte das `insert()` nur überschrieben
und die Verdrängung war unnötig.

**Nachgeprüft (ein Skeptiker widersprach, teilweise zu Recht):** Der im Erstbefund genannte
Auslöser — ein netzwerkseitig dupliziertes UDP-Paket — ist **nicht** erreichbar: das
SRTP-Wiedergabefenster (`SRTP_FENSTER = 2048`, `src/whep.rs:406-424`) verwirft exakte
Duplikate pro SSRC, bevor sie den FEC-Code erreichen, und der MediaMTX-Fork erzeugt je
Batch zwei Paritätspakete für **disjunkte** Gruppen, nie zweimal dieselbe Basis. Ein
schmaler Restweg bleibt: `basis_sequenz` ist ein `u16` und läuft alle 65536 Medienpakete um
(bei 500 Pakete/s rund zwei Minuten), kann also auf eine alte, noch wartende Gruppe
derselben Basis treffen. Die Wirkung ist dann der Verlust genau einer wartenden Gruppe —
mild und ohnehin nur bei vollem Wartestand. Der Logikfehler ist real, die Auswirkung
gering; der Befund ist als unsicher zu führen.

Behebung: `self.wartend.contains_key(&kopf.basis_sequenz)` vor der Verdrängung prüfen.

---

## Einordnung

Die Ausbeute ist für einen vierten Durchgang **noch nicht dünn** — aber sie hat sich klar
verlagert. Die tragenden, oft gemessenen Pfade (Jitter, Nachforderung, Depacket-Grundlogik,
Tonanlauf, Neuaufbau) haben nur noch Randfälle geliefert; die schweren Befunde sitzen
ausnahmslos in dem, was in den letzten vier Wochen dazugekommen ist: Zero-Copy (Befunde 2,
4, 11, 17, 18), HDR (1, 19), FlexFEC (9, 21, 31) und das Auffangnetz (25, 32).

Drei Beobachtungen für die Behebung:

1. **Lebensdauer über Faden- und Modulgrenzen** ist das wiederkehrende Muster bei den
   GPU-Befunden. Beide Speichersicherheitsfehler entstehen daraus, dass eine Ressource an
   einer Stelle freigegeben wird, während ein anderer Halter sie noch mitführt. Beide sind
   strukturell zu lösen (Besitz an `Arc` + `Drop` hängen), nicht durch Reihenfolge-Disziplin.
2. **Wächter, die ihren eigenen Fall nicht abdecken** (15, 16, 23, 33, 11, 9): Der
   Einfrier-Wächter braucht ein Bild, um Bilder zu vermissen; die Bilanz-Wache verbraucht
   sich an einem Fehlalarm; `alive` bleibt true, wenn das Gerät gar nicht erst aufging;
   `fec_repariert` steht auf 0, weil FEC gar nicht läuft. Diese Zähler sind das
   Ferndiagnose-Werkzeug für Produktion — sie zuerst zu reparieren, macht die nächsten
   Fehler überhaupt sichtbar.
3. **Kommentar gegen Code** ist in mindestens sechs Fällen der beste Fundhinweis gewesen
   (13, 23, 26, 29, 9, 27). Das deckt sich mit der Projektregel, Aussagen nie nur an einer
   Stelle zu korrigieren.

Nicht geprüft werden konnte: alles, was Ausführung braucht (der Crate baut hier nicht).
Die Befunde 1, 2 und 4 sind Kandidaten für eine gezielte Laufzeit-Bestätigung, sobald
`vendor/webrtc-rs` verfügbar ist — 1 und 2 sollten sich mit einem HDR-Strom bzw. einem
regulären Sitzungsende auf Linux binnen Minuten reproduzieren lassen.
