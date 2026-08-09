# Vierter Bughunt — nativer HQ-Player (`streaming/pulse-player`)

Stand 2026-08-08, am selben Tag um den **Reproduktionsstand** (Stufe 2) und den
**Behebungsstand** (Stufe 3) ergänzt.

**Zur Lesart der Standzeilen:** jeder reproduzierte Befund trägt jetzt zuerst eine Zeile
`**Stand (Stufe 3): …**` und darunter unverändert die alte `**Stand: REPRODUZIERT**`-Zeile.
Die Reproduktionsangabe wird nicht gelöscht — sie ist der Beleg, gegen den die Behebung
abgenommen wurde, und bleibt nach der Projektregel als datierte Momentaufnahme stehen.

**Hier stand bis zur Reproduktion:** "Rein lesende Prüfung (der Crate baut hier nicht,
`vendor/webrtc-rs` fehlt). Grundlage: 35 Befunde aus **sechs** Prüf-Linsen." Beides ist
falsch und bleibt hier als widerlegt stehen. Richtig ist: es waren **zwölf Prüf-Linsen plus
ein Vollständigkeits-Kritiker**, jeder Befund von drei unabhängigen Skeptikern gegengelesen —
und der Crate **baut und testet inzwischen**. `vendor/webrtc-rs` ist eingerichtet (v0.17.2 +
zwei Pulse-Patches); Grundlinie auf der Prüfmaschine: `cargo build --all-targets` erfolgreich
mit 5 Warnungen (nur toter Code), `cargo test` **226 bestanden / 0 fehlgeschlagen / 5
ignoriert** (die fünf sind Diagnose- und Messwerkzeuge hinter Umgebungsvariablen bzw. echter
HDR-Hardware, keine stillgelegten Fehlschläge). Ein Vollbau dauert rund 75 s.

Nach dem Entdoppeln bleiben **34** Befunde; drei davon sind gegenüber der Erstmeldung
**herabgestuft**, einer ist nur eingeschränkt erreichbar.

Jeder Befund trägt jetzt direkt unter der Ortsangabe eine **Standzeile** mit dem
Reproduktionsergebnis. Die Prüfmaschine ist ein **Mac (Apple Silicon)**: kein Windows, kein
D3D11/D3D12, kein Vulkan, kein CUDA, kein HDR-Schirm, kein echter WHEP-Sender. "NUR MIT
HARDWARE", "NUR MIT ECHTEM SENDER" und "NICHT NACHBAUBAR" sind deshalb ein eigenes Ergebnis
und ausdrücklich **keine Widerlegung**. Alle Reproduktionen sind reine Tests — der
Produktivcode ist unverändert.

## Zusammenfassung

### Behebungsstand (Stufe 3, 2026-08-08)

Gemessene Grundlinie im Crate, Stand 2026-08-09 nach Auflösung der beiden Vorbehalte (s.u.):
`cargo test` → **248 bestanden, 0 fehlgeschlagen, 6 ignoriert** (vor Stufe 3: 227/0/25; direkt
nach Stufe 3, mit den beiden noch offenen Vorbehalten: 247/0/6).
Die sechs verbliebenen `#[ignore]` sind fünf Diagnose- und Messwerkzeuge hinter
Umgebungsvariablen bzw. echter HDR-Hardware — **plus einer echten offenen Reproduktion**:
`recorder::tests::repro_27_aufnahme_kennt_keine_obergrenze`.

| Stand | Zahl | Befunde |
|---|---|---|
| **BEHOBEN**, Reproduktionstest grün, kein offener Einwand | **16** | 3, 5, 7, 10, 11, 13, 14, 15, 19, 21, 22, 24, 28, 29, 31, 34 |
| **BEHOBEN, bewusst unvollständig** — der Rest hängt an Befund 4 | **1** | 17 (`hw_ziel` frei, Ring bleibt absichtlich belegt) |
| **TEILWEISE BEHOBEN** | **1** | 27 (Pfadprüfung ja, Aufnahme-Obergrenze bewusst nein) |
| **OFFEN — nicht auf dieser Maschine prüfbar** | **16** | 1, 2, 4, 6, 8, 9, 12, 16, 18, 20, 23, 25, 26, 30, 32, 33 |
| **BEFUND WAR FALSCH** | **0** | — |

**Hier standen bis 2026-08-09 15 + "2 mit Vorbehalt" (13, 17) — beide Vorbehalte sind aufgelöst,
noch am selben Tag und vor dem ersten Push:** Befund 13 hat einen dritten, tatsächlich
unterscheidenden Testentwurf bekommen (s. Abschnitt dort); Befund 17s riskante Zeile
(`self.bruecke = Some(None)`) ist wieder heraus, bevor sie je auf `main` stand. Zusätzlich hat
das Gegenlesen von Befund 5 einen bis dahin unbekannten **dritten Weg** zu demselben Bildmüll
aufgedeckt und mitbehoben — Befund 5 zählt deshalb weiterhin zu den vollständig behobenen, nur
gründlicher als ursprünglich gemeldet.

**Kein einziger der 34 Befunde hat sich bei der Behebung als Fehldeutung erwiesen.** Was sich
in acht Fällen als falsch erwies, war der mitgelieferte **Behebungsvorschlag oder die
Testskizze** (deutlichster Fall: Befund 19 — die BT.2020-Matrix muss in linearem Licht
rechnen, der Vorschlag ergäbe 0,057 Fehler im Blau). Diese Korrekturen stehen jeweils in der
Stufe-3-Zeile des Befunds und sind dort als widerlegt kenntlich gemacht, nicht wegretuschiert.

**Die 16 offenen Befunde sind nicht ungeprüft geblieben, weil sie unwichtig wären** — im
Gegenteil, beide *kritischen* sind darunter. Sie scheitern an drei Dingen: an fehlender
**Hardware** (1, 2, 4, 6, 16, 18 — Windows/D3D11/D3D12, Linux/Vulkan/CUDA, NVDEC, HDR-Schirm),
an einem fehlenden **echten Sender** (8, 9, 20, 25, 30, 32 — ausgehandelte PeerConnection) und
an einem fehlenden **Prüfeinstieg** im Code selbst (12, 23, 26, 33). Die dritte Gruppe ist die
einzige, die sich ohne fremde Maschine schließen ließe, und sie ist damit auch der einzige
Posten der Stufe-3-Liste, der ohne Vorbedingung liegen geblieben ist.

**Zwei Punkte, die vor dem Landen Aufmerksamkeit brauchten — beide aufgelöst am 2026-08-09,
bevor der Stapel zum ersten Mal gepusht wurde:**

1. **Befund 17** — die Zeile `self.bruecke = Some(None)` hätte auf Windows die NT-Handles
   freigegeben, während bis zu ~45 `GpuBild` mit genau diesen Handles noch unterwegs gewesen
   wären. Das war wortwörtlich **Befund 4**, mit einem neuen Auslöser, und Befund 4 ist
   unbehoben. **Behoben durch Entfernen der Zeile, nicht durch Reparieren** — die `hw_ziel`-Hälfte
   bleibt, der Ring bleibt bis zur strukturellen Lösung von Befund 4 absichtlich belegt. Ein
   ausführlicher Kommentar an der Stelle hält fest, warum, damit niemand denselben Griff
   wiederholt.
2. **Befund 13** — der Produktivcode war richtig, der Reproduktionstest aber von
   *unerfüllbar* auf *unfehlbar* repariert: er bestand auch mit zurückgedrehtem Fix. **Behoben
   durch einen dritten Testentwurf**, der misst, ob nach dem Überlauf wieder eine saubere Einheit
   herauskommt — eigens gegengeprüft: rot ohne Fix, grün mit Fix, und deckt auch den zuvor
   ungedeckten `h264_reset`-Aufruf im Deckel-Zweig selbst ab.

Dazu kommt ein wiederkehrender Nebenbefund aus den Gegenproben, der keinem einzelnen Befund
gehört: **mehrere Behebungen führen neue stille Verwurfspfade ein** (14, 21, 28 — vergiftete
Einheit, abgelehnte FEC-Kopfzeile, widersprüchlicher OBU). Alle drei verwerfen ohne Zähler,
ohne Log und ohne Vollbild-Anforderung. Für einen fremden Sender heißt das: statt Bildmüll
jetzt dauerhaft schwarzes Bild, und in der Ferndiagnose sieht das wie eine ruhige Leitung aus.
Das ist dasselbe Muster, das die Einordnung unten als „Wächter, die ihren eigenen Fall nicht
abdecken" führt — es ist bei der Behebung nicht kleiner geworden, sondern gewachsen.

### Reproduktionsstand

| Stand | Zahl | Befunde |
|---|---|---|
| **REPRODUZIERT** (Test rot, Ursache am benannten Ort belegt) | **18** | 3, 5, 7, 10, 11, 13, 14, 15, 17, 19, 21, 22, 24, 27, 28, 29, 31, 34 |
| **WIDERLEGT** | **0** | — |
| **NUR MIT HARDWARE** (Windows/D3D11, Linux/Vulkan/CUDA, NVDEC, HDR-Schirm) | **6** | 1, 2, 4, 6, 16, 18 |
| **NUR MIT ECHTEM SENDER** (WHEP-Gegenstelle, ausgehandelte PeerConnection) | **6** | 8, 9, 20, 25, 30, 32 |
| **NICHT NACHBAUBAR** (kein Injektionspunkt, kein Testmodul, Fenster nötig) | **4** | 12, 23, 26, 33 |

**18 von 18 versuchten Reproduktionen sind gelungen, keine einzige ist umgefallen.** Die
übrigen 16 sind auf dieser Maschine nicht ausführbar — sie bleiben ungeprüft, nicht
entkräftet. Vier davon (12, 23, 26, 33) scheitern nicht an fehlender Hardware, sondern daran,
dass der betroffene Code **keinen Prüfeinstieg besitzt**: `AudioOutput::new()` holt sich das
Gerät selbst, `app/mod.rs` hat kein Testmodul und keine `Session` ohne Fenster,
`Renderer::render` braucht eine echte Oberfläche. Diese Untestbarkeit ist selbst ein Befund
und gehört auf die Behebungsliste.

### Was das über die adversarische Prüfung in Stufe 1 sagt

In Stufe 1 hat jeder Befund drei Skeptiker durchlaufen, 105 Urteile insgesamt — und **nur drei
davon haben etwas verworfen** (21 und 27 herabgestuft, 34 als unsicher geführt). Das ist eine
Verwerfungsquote von **3 Prozent**, und eine so milde Quote ist normalerweise ein Warnzeichen:
Sie sieht nach Zustimmungsdruck aus. Die Reproduktion sagt dazu zweierlei, und beides gehört
nebeneinander:

- **Für das Ob war die Quote berechtigt.** 18 von 18 ausführbaren Befunden ließen sich
  auslösen; keiner erwies sich als Fehldeutung, und in mehreren Fällen (3, 13, 22, 28) traf
  nicht nur die Behauptung, sondern auch die genannte Codezeile. Auch die drei Herabstufungen
  waren richtig: bei 21 und 27 hatten die Skeptiker den *Schaden* korrigiert, nicht die
  Beobachtung — und beide Beobachtungen stehen jetzt als roter Test da.
- **Für das Wie war die Prüfung zu mild.** In mindestens acht der 18 Fälle stimmte die
  mitgelieferte Testskizze oder der Behebungsvorschlag nicht: die Lückengröße bei 7, der
  Zeitpunkt bei 34 (die Wirkung tritt beim *ersten* Duplikat ein — wer der Skizze folgt, hält
  den Befund fälschlich für widerlegt), ein untaugliches Prüfbild **und ein sachlich falscher
  Behebungsvorschlag** bei 19 (die Matrix muss in linearem Licht laufen), ein unerreichbarer
  Zielzustand bei 24, eine nicht schreibbare Gegenprobe bei 11, ein nicht assertierbarer
  zweiter Teil bei 15, eine Zusatzbehauptung bei 14, die die eigene Minimalbehebung überlebt,
  und die nur zur Hälfte prüfbare Aussage bei 17. **Kein Skeptiker hat einen dieser Fehler
  gefunden** — sie haben die Behauptung geprüft, nicht den Beweisweg. Genau dort liegt die
  Lücke der Stufe 1.
- **Und die schwersten Befunde sind weiterhin ungeprüft.** Beide *kritischen* (1 und 2) hängen
  an Hardware, die es hier nicht gibt. Die 3 Prozent stehen damit über gut der Hälfte der
  Befunde bestätigt da — ausgerechnet über die zwei, die den Prozess abstürzen lassen, nicht.

### Sachstand (unverändert gültig)

Der Player ist nach drei vorherigen Durchgängen im Kern stabil — die tragenden Wege
(Jitter, Nachforderung, Neuaufbau, Tonanlauf) sind mit Messungen belegt und größtenteils
getestet. Das verbliebene Risiko sitzt fast vollständig in den **jungen Randpfaden**:
Zero-Copy/GPU-Bilder (zwei Speichersicherheitsfehler, davon einer bei praktisch jedem
Sitzungsende auf Linux — beide hier nicht nachstellbar), HDR (ein wgpu-Absturz beim ersten
HDR-Bild auf Windows; die Erstmeldung nannte ihn "sicher", geprüft ist er nicht)
und die neu eingezogenen Nebenwege (FlexFEC, Auffangnetz, Aufnahme). Zwei Fehler kann ein
**fremder Sender** unmittelbar auslösen: ein STAP-A-Paket mit einem überzähligen Byte
lässt den H.264-Depacketizer über das Pufferende lesen (**mit Test belegt**, Befund 3), und
ein Auflösungswechsel mitten im Strom liefert dauerhaft ein falsch beschnittenes Bild
(Befund 6, nur mit Hardware prüfbar). Auffällig ist ein Muster, das
sich durch mehrere Befunde zieht: **Wächter und Zähler decken den Weg nicht ab, den sie
zu decken behaupten** (Einfrier-Wächter, Bilanz-Wache, `alive`, `fec_repariert`) — die
Kommentare versprechen dort mehr als der Code hält.

---

## Kritisch

### 1. HDR-Formatwechsel macht zwischengespeicherte Bindegruppen inkompatibel — wgpu bricht mit Panik ab
`src/render/fremdbild.rs:175` — **kritisch, Absturz**

**Stand: NUR MIT HARDWARE** — auf der Prüfmaschine (Mac) nicht auslösbar. `Fremdbilder::importe`
liegt vollständig hinter `#[cfg(windows)]` bzw. `#[cfg(target_os="linux")]`
(`fremdbild.rs:46/268`); hier gilt der Leerzweig ab Zeile 243, es gibt also gar keine
Fremdbild-Bindegruppe. Zusätzlich nötig: eine echte Oberfläche, die `Rgba16Float` anbietet, und
`schirmwissen.ist_hdr(hwnd)` — das ist die DXGI-Abfrage aus `hdr_fenster.rs` und liefert außerhalb
von Windows immer false. Der Befund ist damit **ungeprüft, nicht widerlegt**.

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

**Stand: NUR MIT HARDWARE** — das ganze Modul `zerocopy::linux` hängt an
`#[cfg(target_os = "linux")]` (`zerocopy/mod.rs:127`) und wird auf dem Mac nicht einmal übersetzt;
`Ringplatz::drop` ruft `cuMipmappedArrayDestroy`/`cuDestroyExternalMemory`/`vkDestroyImage` und
braucht CUDA plus ein Vulkan-Gerät. Die Reihenfolge-Frage sitzt zwar in `app::close_session`, ist
aber ohne die Linux-Typen nicht auslösbar. **Ungeprüft, nicht widerlegt.**

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

**Stand (Stufe 3): BEHOBEN** — Längentabelle wird vorab geprüft; `repro_3_stapa_ueberzaehliges_byte`
läuft ohne `#[ignore]` grün. Behoben schon vor dem Stufe-3-Durchgang (Commit `99ba633a`).
**Nicht mitbehoben** ist der zweite Satz des Behebungsvorschlags: die Sitzungs-Tasks werten ihren
`JoinHandle` weiterhin nicht aus, eine Panik an anderer Stelle friert das Bild also weiter wortlos ein.

**Stand: REPRODUZIERT** — Test `depacket::tests::repro_3_stapa_ueberzaehliges_byte`.
Die Panik entsteht genau an der benannten Stelle, `vendor/webrtc-rs/rtp/src/codecs/h264/mod.rs:239`
(`packet[curr_offset + 1]`, "index out of bounds: the len is 4 but the index is 4"), also im
vendorten Crate und nicht im Pulse-Code. Damit ist zugleich belegt, dass `Err(_) => *dropped = true`
(Zeile 114) wirkungslos ist: es wird nie erreicht, weil eine Panik kein `Result` ist. Die im Test
mitgeführte Gegenprobe (wohlgeformtes STAP-A plus Füllbyte, `[0x18,0x00,0x01,0x41,0xAA]`) wird heute
nicht mehr erreicht und deckt nach der Behebung denselben Weg mit echtem Inhalt davor ab.

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

**Stand: NUR MIT HARDWARE** — `bruecke.rs` steht unter `#[cfg(windows)]`
(`zerocopy/mod.rs:111`) und benutzt durchgehend D3D11 (`CreateTexture2D`, `CreateSharedHandle`,
`CloseHandle`); auch das bestehende Testmodul der Datei legt ein echtes D3D11-Gerät an. Der Ablauf
braucht zusätzlich einen laufenden Auflösungswechsel mit gefüllter Takt-Warteschlange.
**Ungeprüft, nicht widerlegt.**

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

**Stand (Stufe 3): BEHOBEN, in zwei Schritten** — `on_gap` baut den `H264Packet`-Depacketizer neu auf
(`h264_reset()`, `depacket/mod.rs:59`), weil dessen `fua_buffer` privat und anders nicht leerbar ist;
der im Vorschlag genannte Struct-Update-Ausdruck übersetzt deshalb nicht (E0451).
**Der Einwand der Gegenprobe stand hier bis 2026-08-09 als offen — das ist überholt.** Er hatte
recht: die Fehlerklasse war nur über den *Lücken*-Weg geschlossen, der Zweig
`Err(_) => *dropped = true` ließ `fua_buffer` unangetastet stehen, und mit einem unbehandelten
NAL-Typ (FU-B 0x7D, Typ 0/30/31, gekürzte FU-A) ließ sich dasselbe Schadbild ganz ohne `on_gap`
erzeugen — unvalidierte RTP-Nutzlast, also von der Gegenstelle wählbar. Jetzt ruft auch der
`Err`-Zweig `h264_reset()`. Test `depacket::tests::verworfenes_paket_leert_die_fua_reste`: ohne
den zweiten Schritt rot (Ausgabe zeigt die `0xAA`-Reste vor der neuen IDR), mit ihm grün.
Zweitens rettet `h264_reset` weiterhin das Feld `is_avc` von Hand — kommt im `rtp`-Crate ein
weiteres öffentliches Einstellfeld dazu, fällt es beim Bump still unter den Tisch. Heute
folgenlos (`is_avc` wird im Player nirgends gesetzt), aber ungedeckt: **bleibt offen**, kein
Test kann eine stille Regression bei einem künftigen `rtp`-Bump fangen.

**Stand: REPRODUZIERT** — Test `depacket::tests::repro_5_gap_laesst_fua_reste_stehen`.
Die angeblich heile IDR lautet `00 00 00 01 65 AA AA AA AA 11 22 33 44`: Startcode, NAL-Kopf 0x65
(IDR, ref_idc 3), dann die vier Füllbytes der **vor** der Lücke abgebrochenen FU-A, erst danach die
eigenen Bytes. Der Weg braucht wirklich alle drei Schritte — das Marker-Paket dazwischen (einzelnes
NAL 0x41) setzt `dropped` zurück, während `fua_buffer` im `H264Packet` unberührt bleibt. Die
Präzisierung der Skeptiker ist damit vollständig bestätigt.

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

**Stand: NUR MIT HARDWARE** — `in_den_hauptspeicher` (`decode.rs:565`) ruft
`av_hwframe_transfer_data` auf ein GPU-Bild mit `hw_frames_ctx`; solche Bilder entstehen nur über
VAAPI (Linux) oder D3D11VA (Windows), und die Kandidatenliste vergibt auf Nicht-Windows
`Hwaccel::Vaapi` (Test `geraetetyp_passt_zur_plattform`), das es auf dem Mac nicht gibt. Ohne den
Transfer lässt sich weder der asymmetrische Größenvergleich noch das Weiterbenutzen des alten Ziels
auslösen; der Folgefehler in `convert` (Maße aus `ziel` statt aus der Quelle) ist ebenfalls nicht
sichtbar, weil `convert` nur EIN Bild bekommt. **Ungeprüft, nicht widerlegt.**

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

**Stand (Stufe 3): BEHOBEN** — `push` legt `arrived` nur noch beim ersten Eintreffen an
(`jitter.rs:206`), eine Dopplung ersetzt bloß die Nutzlast. **Risiko (beabsichtigt):** auf einer
doppelnden Strecke meldet der Puffer Lücken jetzt tatsächlich nach `target` — mehr `Release::Gap`, mehr
`on_gap()`, mehr Vollbild-Anforderungen; `frames_dropped`/`lost` und die PLI-Rate sind mit früheren
Messakten nicht mehr direkt vergleichbar. **Nicht geschlossen:** die Schwesterlücke — die Geduldsgrenze
hängt weiter am Kopfeintrag, ein regulär umsortiertes Paket mit kleinerer Sequenz startet sie ebenfalls neu.

**Stand: REPRODUZIERT** — Test `jitter::tests::repro_7_duplikat_erneuert_ankunftszeit`.
20 Dopplungen von Paket 5 im 10-ms-Takt bei `target = 50 ms` halten die Lücke 2..4 über 200 ms (das
Vierfache der Geduldsgrenze) offen: kein `Release::Gap`, `lost` bleibt 0. Die Zähler schließen die
Alternativen aus — `duplicates=20` (die Dopplungen kamen an und wurden erkannt), `buffered=1`
(`MAX_BUFFERED` kann also nicht greifen). Gegenprobe ist der vorhandene Test
`luecke_wird_nach_zielzeit_uebersprungen`: dieselbe Konstellation ohne Dopplungen meldet die Lücke
zuverlässig. **Korrektur an der Testskizze des Berichts:** die Lücke ist `missing: 3` (Pakete 2, 3
und 4), nicht 4 — der Fließtext daneben war richtig, die Zahl in der Skizze nicht.

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

**Stand: NUR MIT ECHTEM SENDER** — die Prüfung (`stille_fenster >= STILLE_FENSTER_BIS_ABBRUCH`)
liegt inmitten der rund 600 Zeilen langen `select!`-Schleife von `session::run`; es gibt keine
herausgelöste Funktion und keinen Uhr-Parameter. Um sie zu erreichen, muss `whep::connect`
**erfolgreich** zurückkehren — dafür braucht es eine Gegenstelle mit gültiger SDP-Antwort, die
ICE/DTLS zu Ende bringt. Der vorhandene Test der Datei nutzt genau deshalb eine unerreichbare URL und
kommt nie so weit. **Ungeprüft, nicht widerlegt.**

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

**Stand: NUR MIT ECHTEM SENDER** — `aufsammeln(transport: Arc<RTCDtlsTransport>, …)` braucht
einen echten DTLS-Transport; den gibt es nur aus `receiver.transport()` einer laufenden
PeerConnection mit angemeldeter Spur, und `RTCDtlsTransport` hat keinen öffentlichen Konstruktor.
Die statische Flagge `GESTARTET` hat zudem keinen Lesezugriff von außen. Der sichtbare Beweis
(zweite Sitzung sieht kein Paritätspaket) verlangt zwei aufeinanderfolgende echte WHEP-Sitzungen im
selben Prozess. **Ungeprüft, nicht widerlegt.**

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

**Stand (Stufe 3): BEHOBEN** — `nach_anhaengen` bekommt die Kanalzahl als Parameter (nicht als Feld,
sonst hätte `#[derive(Default)]` sie auf 0 gesetzt und den Feinabbau still auf das alte Ein-Sample-Verhalten
zurückfallen lassen) und entfernt je Feinschritt ein volles Frame. Eine Zeile des Reproduktionstests wurde
angehoben (`verworfen` 1 → 2): der Rückgabewert speist `Shared::dropped`, und das zählt Samples, nicht Frames —
bei 1 hätte der Feinabbau bei Stereo die Hälfte des Verworfenen unterschlagen. **Risiko:** `RING_FEIN_TEILER`
zählt weiter angehängte *Samples*, entfernt aber ein *Frame* — der Abbau ist damit kanalzahl-abhängig schnell
(Stereo 0,1 %, 5.1 dann 0,3 %, 7.1 0,4 %); nur der Stereo-Wert steht im Kommentar. Sauberer wäre, den
`fein_zaehler` in Frames zu führen. **Vorbestehend offen:** Grobzweig, Hartdeckel und Negativ-Trim sind
weiterhin nicht frame-bewusst und nur durch Arithmetik-Zufall ausgerichtet (bei 44,1 kHz mit 10 oder 12
Kanälen ist `per_ms` kein Vielfaches der Kanalzahl — dann verdreht der Grobschnitt den Ring dauerhaft).

**Stand: REPRODUZIERT** — Tests
`audio::ringregelung::tests::repro_10_feinabbau_kippt_die_kanalzuordnung` und `…_wieder_zurueck`.
Ring mit verschränktem Stereo (L=+1,0 / R=-1,0), Länge `soll+1` bei `soll = RING_SOLL_MS*96`
(48 kHz Stereo wie zur Laufzeit): ein einziger `nach_anhaengen(…, RING_FEIN_TEILER)` geht in den
Feinzweig, verwirft per `pop_front()` genau ein Sample (Zeile 118), und der Ring beginnt danach auf
dem **rechten** Kanal. Der zweite Test belegt die Korrektur der Skeptiker ausdrücklich: es ist kein
einmaliger dauerhafter Tausch — der nächste Feinabbau-Schritt kippt zurück (-1,0 dann +1,0), das
Umkippen läuft im Takt der angehängten Pakete.

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

**Stand (Stufe 3): BEHOBEN** — statt des vorgeschlagenen Sichtbarkeits-*Zustands* meldet der Renderer
das *Ereignis* „dieser Durchgang hatte keine Oberfläche" über den ohnehin geteilten Briefkasten
(`einfrieren/gpuabdruck.rs:151`, gesetzt in `render/mod.rs:394`, verbraucht per `swap(false)`). Ein Zustand
wäre die falsche Größe gewesen: der `Zulauf` sitzt im Decoder-Faden ohne Zugang zum Fenster, und ein
hängengebliebener Zustand schaltete die Aufsicht für immer aus. Gegenprobe-Test
`nach_dem_verdecktsein_wird_ein_toter_rueckweg_wieder_bemerkt` sichert die Verbrauchs-Semantik ab.
**Nicht umgesetzt** ist der zweite Satz des Vorschlags: der Rückweg wird weiterhin **prozessweit und
bleibend** abgeschaltet (`zerocopy/mod.rs:232`) — der Auslöser dieses Fehlalarms ist weg, der Verstärker
nicht, jeder andere Fehlalarm derselben Wache trifft weiter alle Sitzungen dauerhaft.
**Weitere Risiken:** gemeldet wird bei *jedem* `acquire() == Ok(None)`, also auch bei `Outdated`/`Lost` —
ein dauernd gezogenes Fenster verzögert die Erkennung eines echt toten Rückwegs; ist `abdruck_auftrag`
`None` (erstes Bild, direkt nach Bauart-Wechsel), bleibt der Ausfall unbemerkt; und dass der Renderer im
verdeckten Fall wirklich weiterzeichnet, kann kein Unit-Test zeigen — es hängt daran, dass `uebernehmen`
`draw(id)` direkt ruft. `streaming/pulse-player/README.md:279` nennt die neue Ausnahme noch nicht.

**Stand: REPRODUZIERT** — Test
`einfrieren::gpuabdruck::tests::repro_11_verdecktes_fenster_gilt_als_toter_rueckweg`. 400 GPU-Bilder
in 6,4 s ohne einen einzigen eingeworfenen Abdruck — genau das Bild, das ein minimiertes Fenster
erzeugt — lassen `einspeisen_zur_zeit` ab Bild 313 (5,008 s) "Rückweg tot" melden. Bindend ist dabei
`STUMME_DAUER` (5 s), nicht `STUMME_BILDER` (schon nach 0,96 s erreicht). Die Kette ist im Code
belegt: `acquire()` liefert bei `Cst::Occluded | Cst::Timeout` `Ok(None)` (`render/mod.rs:309-312`),
`render` steigt in Zeile 383 aus und zeichnet den Abdruck erst in Zeile 414 auf, während der
Decoder-Thread unbeirrt jedes Bild meldet (`decode.rs:1593`) und bei `true` `zerocopy::abschalten`
ruft (`decode.rs:1642-1644`, prozessweiter, nicht rücksetzbarer `swap(false)`).
**Einschränkung:** die im Bericht vorgeschlagene Gegenprobe `z.verdeckt(true)` ließ sich nicht
schreiben — `Zulauf` besitzt heute überhaupt kein Sichtbarkeitssignal (das wäre ein
Übersetzungsfehler statt eines Testfehlschlags). Der Test stellt den verdeckten Zustand deshalb über
das ausbleibende Einwerfen dar und wird grün, sobald ein Signal nachgerüstet ist. Der vorhandene
`eine_kurze_pause_reicht_nicht` deckt tatsächlich nur 1,9 s ab und konnte das nie zeigen.

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

**Stand: NICHT NACHBAUBAR** — alle drei Sendestellen hängen an `&mut App` und greifen über
`self.sessions.get_mut(&id)` auf ein `Session`-Struct zu, das ein `Arc<winit::Window>`, einen
`render::Renderer` und einen `Ausgabetakt` führt (`app/mod.rs:163ff`). `app/mod.rs` hat kein
Testmodul und keinen Weg, eine `Session` ohne Fenster zu bauen; der Nachweis der Vertauschung
braucht außerdem eine laufende `session::run`, die die Befehle beantwortet. **Ungeprüft, nicht
widerlegt** — die Untestbarkeit ist hier selbst ein Befund.

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

**Stand (Stufe 3): BEHOBEN, Test dritte Fassung.** Der Produktivcode stimmt seit Stufe 3:
`Kind::H264` führt jetzt ein Feld `fua_bytes`, das den fremden `fua_buffer` exakt nachrechnet
(`payload.len() - 2` je angenommenem FU-A-Paket, beim E-Bit auf 0 — geprüft gegen
`vendor/webrtc-rs/rtp/src/codecs/h264/mod.rs:268-300`), der Deckel misst `unit.len() + fua_bytes` und räumt
beim Überschreiten auch den Depacketizer aus.
**Hier stand bis 2026-08-09 "Test belegt das nicht" — das war richtig für die zweite Fassung des Tests, nicht
mehr für die dritte.** Zwei Entwürfe waren tatsächlich wertlos: der erste unerfüllbar (20 MB unter dem
32-MB-Deckel und gleichzeitig `geliefert <= 4800`), der zweite *unfehlbar* (die Gegenprobe mit
zurückgedrehtem Produktivcode bestand ihn ebenfalls, weil das fertige Riesen-NAL beim E-Bit auch am alten
Deckel hängenbleibt — `geliefert == 0` in beiden Fassungen). Der dritte Entwurf misst, was wirklich
unterscheidet: er häuft Fortsetzungen an, bis `buffered_len()` beim Überschreiten des Deckels **fällt** statt
zu wachsen, verzehrt `dropped` mit einem Marker-Paket, und prüft dann, dass eine frische FU-A mit anderem
Füllbyte sauber (klein, ohne `0xAA`-Reste) herauskommt. Eigens nachgemessen (2026-08-09): mit
zurückgedrehtem Deckel läuft der Test bis zum Notausstieg bei 40 000 Fortsetzungen (47,9 MB, Deckel greift
nie) und schlägt fehl — der Test ist jetzt scharf.
**Der Einwand zum `h264_reset` im Deckel-Zweig war ebenfalls berechtigt, ist aber jetzt gedeckt:** eigens
geprüft, indem NUR dieser eine Aufruf entfernt wurde (der `Err`-Zweig-Aufruf aus Befund 5 blieb stehen) —
`repro_13` schlägt dann fehl. Der dritte Testentwurf deckt also beide `h264_reset`-Stellen ab, die zur
Behebung dieses Befunds gehören.
**Bleibt offen, gehört aber zu Befund 5, nicht hierher:** `fua_bytes` ist eine zweite Kopie fremder Regeln —
ändert der Upstream die FU-A-Behandlung, driftet der Zähler lautlos. Ein Patch 0004 mit
`pub fn fua_buffered()`/`pub fn reset()` im vendorten Crate wäre der sauberere Weg, ist aber eine größere
Umbauarbeit und war nicht Teil dieser Behebungsrunde.

**Stand: REPRODUZIERT** — Test `depacket::tests::repro_13_fua_puffer_waechst_am_deckel_vorbei`.
Nach 17 501 FU-A-Paketen ohne E-Bit liegen **20 966 198 Byte** im `fua_buffer`, während
`buffered_len()` — also `unit.len()`, das Einzige, was `MAX_ACCESS_UNIT_BYTES` misst — durchgehend
**0** meldet. Ein kleines FU-A-Ende mit Marker fördert danach eine Einheit von 20 966 205 Byte
zutage (7 Zusatzbytes: Startcode, rekonstruierter NAL-Kopf, 4 eigene Bytes). Der bestehende
Regressionstest `h264_einheit_waechst_nicht_unbegrenzt` erwischt das nicht, weil er
Einzel-NAL-Pakete benutzt, die sofort in `unit` landen — genau wie im Befund vermutet.

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

**Stand (Stufe 3): BEHOBEN** — der Marker-Zweig setzt vor dem Flush `poisoned`, wenn
`expect_continuation` steht (`depacket/av1.rs:230`); die widersprüchliche Einheit fällt, statt ein
Bruchstück mit gelogenem LEB128-Größenfeld auszuliefern. Der im Befund abgetrennte Zusatz (Zeile 240 setzt
`expect_continuation` zurück, das echte Fortsetzungspaket kostet zusätzlich die nächste Einheit) ist bewusst
**nicht** mitbehoben — die Gegenprobe hält das nicht bloß für die konservative, sondern für die einzig
haltbare Auflösung: bliebe `expect_continuation` stehen, hinge das Fortsetzungspaket an einem gerade
geleerten `partial` und erzeugte genau denselben Fehler eine Einheit später. Das gehört als Kommentar an
Zeile 240; das Feld-Doc (`av1.rs:141`) widerspricht dem Code in genau diesem Fall noch.
**Risiko:** ein nicht-konformer Fremdsender geht von „Bildmüll" zu „gar nichts" — und der Verwurf wird
nirgends gezählt oder protokolliert (`session.rs:546` macht bei `None` nur `continue`), sieht also wie ein
stiller Stillstand aus. Gilt für alle `poisoned`-Pfade, der Fix erbt es nur.

**Stand: REPRODUZIERT** — Test
`depacket::av1::tests::repro_14_marker_mit_y_liefert_bruchstueck_aus`. Ausgeliefert wird
`[32, 04, AA, AA, BB, BB]`: 0x32 ist der OBU-Kopf mit nachträglich **gesetztem** Größen-Bit, 0x04 das
von `append_obu_with_size` geschriebene LEB128-Feld — es trägt die Länge des Bruchstücks und
behauptet damit, der halbe OBU sei vollständig. `poisoned` bleibt ungesetzt.
**Bewusst nicht mitgeprüft:** der Zusatz aus Zeile 210 (zurückgesetztes `expect_continuation`, das
die nächste heile Einheit ebenfalls fallen lässt). Er überlebt die unten vorgeschlagene
Minimalbehebung und würde den Test dann aus einem zweiten, anderen Grund rot halten — er ist ein
eigener Punkt, kein Teil dieses Beweises.

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

**Stand (Stufe 3): BEHOBEN (beide Teile, der zweite ohne Test)** — Ratenbremse im `other`-Zweig von
`convert` (Meldung nur beim Formatwechsel, `decode.rs:1735`) plus ein Wächter: `unbrauchbare_bilder` zählt
vom Decoder gelieferte, von `convert` abgelehnte Bilder und `decode` bricht nach `MAX_UNBRAUCHBARE_BILDER`
(60, eine Sekunde bei 60 fps) mit `bail!` ab. Der Vorschlag „denselben Weg wie `classify` nehmen" ist
bewusst **nicht** umgesetzt: der Ersatz ist immer Software, und Software dekodiert einen 4:4:4-Strom wieder
nach YUV444P — ein Neuaufbau kann das Pixelformat des Bitstroms nicht ändern, kostet nur Sekunden Standbild
und verbrennt das Neuaufbau-Kontingent, dessen Erschöpfung „Sitzung beenden" heißt.
**Einwände der Gegenprobe:** (a) Der neue Kommentar (`decode.rs:1740`) behauptet, das sei „die einzige
Wiederholmeldung dieser Datei ohne Bremse" — falsch, `decode.rs:1686` und `:1781` sind es auch, letztere
60 Zeilen tiefer in derselben Funktion. (b) Die Zusage „der Zähler fällt bei jedem gelieferten Bild auf
null" gilt für den Zero-Copy-Weg **nicht** (`decode.rs:1650` `out.push(f); continue;`) — abgelehnte
Rücklese-Bilder können sich über erfolgreiche Zero-Copy-Bilder hinweg zur Grenze summieren und eine Sitzung
beenden, in der tatsächlich Bild kommt. (c) `static ZULETZT` ist prozessweit, der Player fährt aber mehrere
Sitzungen gleichzeitig: zwei Decoder mit zwei verschiedenen unbrauchbaren Formaten lassen die Bremse
ausfallen, und eine zweite Sitzung meldet dasselbe Format gar nicht mehr. Ein Feld am `VideoDecoder` wäre
richtig. (d) `convert` liefert auch bei „Ebene zu kurz" `None` — das zählt mit, die Abbruchmeldung behauptete
dann das Falsche. (e) Verhaltenswechsel: wo bisher nur das Bild stand, endet jetzt die ganze Sitzung samt
Ton; verbindet die Desktop-App automatisch neu, ergibt ein dauerhaft nicht darstellbarer Strom eine Schleife
im Sekundentakt.

**Stand: REPRODUZIERT (erster Teil)** — Test
`decode::tests::repro_15_unbekanntes_pixelformat_meldet_ohne_ratenbremse`. 100 Ablehnungen ergeben
100 stderr-Zeilen, je 100 für YUV444P und YUV422P; ein Formatwechsel ändert daran nichts. Bei 60 fps
sind das 60 identische Zeilen je Sekunde, während das Bild steht — es ist damit die einzige
Wiederholmeldung der Datei ohne Ratenbremse. Der Nachweis braucht ein zweites Exemplar des
Testbinärs (`PULSE_REPRO15_KIND=1`), weil `convert` per `eprintln!` meldet und der Testläufer stderr
nicht programmatisch herausgibt. **Der zweite Teil** (fehlender Zähler "Einheit angenommen, kein
Bild geliefert") ist per Lesen bestätigt — `drain` ruft `wacht.bild(&f.planes)` nur im
`if let Some(f)`-Zweig (`decode.rs:1626-1637`), `consecutive_errors` steht nach dem erfolgreichen
`send_packet` auf 0, `letzte_aenderung` bleibt `None` — aber **nicht als Zusicherung schreibbar**: es
gibt kein Feld und keine Kennzahl, gegen die man prüfen könnte. Genau das ist der Befund; er steht
als Doc-Kommentar am Test statt als erfundene Behauptung.

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

**Stand: NUR MIT HARDWARE** — der Unterschied wird nur sichtbar, wenn `receive_frame` einen
**anderen** Fehler als EAGAIN/EOF liefert; genau das ist der cuvid-Fall. Auf dieser Maschine gibt es
weder CUDA noch einen Hardware-Decoder in der Kandidatenliste, und mit dem Software-Decoder kommt in
`while … .is_ok()` praktisch nur EAGAIN heraus. Der Rückgabewert ist nicht injizierbar
(`self.decoder` ist ein konkreter `ffmpeg::decoder::Video`). **Ungeprüft, nicht widerlegt.**

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

**Stand (Stufe 3): BEHOBEN, bewusst nur zur Hälfte — der Rest ist an Befund 4 gebunden.**
`hw_ziel` wird beim Rückfall auf `Video::empty()` gesetzt (`decode.rs:1410`) — sauber, genau der
Zustand aus `VideoDecoder::new`, `in_den_hauptspeicher` verträgt ein leeres Ziel ausdrücklich, Test
`repro_17_rueckfall_gibt_hw_ziel_nicht_frei` grün.
**Hier stand bis 2026-08-09 kurzzeitig zusätzlich `self.bruecke = Some(None)` — das war falsch und ist
noch am selben Tag wieder entfernt worden, bevor es auf `main` landete.** Die Gegenprobe hatte richtig
gefangen: `Some(None)` droppt die `Bruecke` sofort, und `Bruecke::drop` (`zerocopy/bruecke.rs:161`) macht
`CloseHandle` auf alle NT-Handles des Rings. Die schon ausgelieferten `GpuBild` halten auf Windows nur den
Zahlenwert `handle: isize` (`zerocopy/platz.rs:22`), **kein** `Arc<Ringplatz>` wie auf Linux. Der Ablauf
steht in derselben Funktion: `decode.rs:1310` holt `let bilder = self.drain();`, erst danach läuft
`auf_software(...)` — und `Ok(bilder)` wäre mit bereits geschlossenen Handles in die Pipeline gegangen, dazu
bis zu 32 + 12 früher abgeschickte. Das hätte Befund 4 einen zweiten, neuen Auslöser gegeben: bis dahin lebte
die Brücke bis zum Sitzungsende, der Rückfall wäre der eine Moment gewesen, in dem garantiert etwas
geschlossen wird. **Der Ring bleibt jetzt bewusst belegt, bis Befund 4 behoben ist** — `self.bruecke = Some(None)`
darf erst landen, wenn `Ringplatz` per `Arc` an den `GpuBild`ern hängt. Ein ausführlicher Kommentar an der
Stelle (`decode.rs`, `frischer_software_decoder`) hält die Begründung fest, damit niemand denselben Griff
ein zweites Mal macht. Kein Test kann das auf dieser Maschine sehen — der Pfad existiert auf macOS nicht.

**Stand: REPRODUZIERT (für `hw_ziel`)** — Test
`decode::tests::repro_17_rueckfall_gibt_hw_ziel_nicht_frei`. `frischer_software_decoder` ersetzt
`decoder`, `name`, `hardware`, `consecutive_errors`, `awaiting_keyframe` und
`skipped_before_keyframe` — den Bildpuffer nicht: ein 1280x720-NV12-Ziel (1 382 400 Byte, 2 Ebenen)
steht nach dem Rückfall unverändert da und wird nie wieder angefasst, weil der Software-Decoder
YUV420P/YUV420P10LE liefert und `auf_gpu` damit falsch ist. Bei 1440p10 ist es ein Vielfaches davon.
**Einschränkung:** der Zero-Copy-Ring hängt an D3D11 und ist hier nicht herstellbar — ein
`Some(Some(Bruecke))` lässt sich auf dem Mac nicht bauen; der Test prüft dort nur, dass der Rückfall
den Zustand nicht nach `None` zurücksetzt. Der Codepfad ist derselbe (das Feld wird schlicht nicht
angefasst), belegt sind hier die 1,4 MB von `hw_ziel`.

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

**Stand: NUR MIT HARDWARE** — wie Befund 4: `#[cfg(windows)]`, das Modul wird hier nicht
übersetzt. Der Ablauf braucht zusätzlich ein `CreateTexture2D`, das mitten in der Schleife an
Grafikspeichermangel scheitert, also ein echtes D3D11-Gerät unter Speicherdruck. **Ungeprüft, nicht
widerlegt.**

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

**Stand (Stufe 3): BEHOBEN** — im SDR-Zweig von `fs_main` (`render/shader.wgsl:337`) läuft bei
`u.output.y > 1.5` jetzt `srgb_to_linear` → `bt2020_zu_bt709` → Clamp → ggf. `linear_to_srgb`.
**Der Behebungsvorschlag des Berichts war sachlich falsch und bleibt hier als widerlegt stehen:** die Matrix
ohne Kurvenwechsel auf gamma-kodierte Werte anzuwenden ergäbe bei der Prüffarbe (0,2/0,8/0,35) den Wert
(0; 0,878; 0,307) statt (0; 0,843; 0,248) — 0,057 Fehler im Blau, über der Testtoleranz. Gemessen liefert
der Fix `[0,0; 0,84314; 0,24706]`, Spanne 0,0012.
**Einwände:** (a) Die Begründung, `weiter_farbraum` liege „nicht im Uniform-Block", trägt nicht —
`build_uniforms` bekommt `farbe: Farbangaben` bereits, und `output[3]` ist frei. Die *Entscheidung*, auf die
Matrix-Kennzahl zu gaten, ist trotzdem richtig: `weiter_farbraum` ist false, sobald der Sender die
Primärvalenzen gar nicht setzt — also genau im Fall des Befunds. Sauber wäre die Oder-Verknüpfung beider
Kennungen; `weiter_farbraum` bleibt sonst weiter toter Code, was der Befund ausdrücklich erschwerend nennt.
(b) „Keine Verschlechterung gegenüber dem Ist-Zustand" stimmt nicht: ein Strom mit `BT2020NCL`-Matrix und
ausdrücklichen BT.709-Primärvalenzen kam bisher richtig heraus und wird jetzt übersättigt — ein *neuer*
Fehlfall, nicht bloß ein ungedeckter. (c) „Muss in LINEAREM Licht laufen" überzieht: der auslösende Fall ist
HLG, dessen Kurve eine andere ist als sRGB — deutlich besser als gar keine Umrechnung, aber nur näherungsweise
linear. (d) Hartes Abschneiden je Kanal statt Gamut-Mapping kann bei gesättigtem Grün/Rot den Farbton kippen
(Neutralgrau ist sicher, Zeilensummen exakt 1); und das Dither wird jetzt durch EOTF/Matrix/OETF gezogen, was
seine gemessene Stärke je nach Farbe leicht verschiebt.

**Stand: REPRODUZIERT** — Test
`messen::farbwerte::tests::repro_19_bt2020_sdr_bleibt_unkonvertiert`. Eine BT.2020-NCL-Quelle mit
`Uebertragung::Sdr` (`hdr.x = 0`) kommt in BT.2020-Primärvalenzen wieder heraus: gemessen
`[0.200, 0.800, 0.349]`, das deckt sich auf drei Nachkommastellen mit der reinen BT.2020-YUV-Matrix
`[0.1989, 0.7999, 0.3486]`; in BT.709 müssten dort `[0.000, 0.8429, 0.2483]` stehen. Es findet also
**überhaupt keine** Gamut-Umrechnung statt. Die vorangestellte Gegenprobe mit `ColorMatrix::Bt709`
läuft durch (< 0,01 Abweichung), der Messstand misst also richtig.
**Zwei Präzisierungen der Testskizze:** (1) Gesättigtes Grün als BT.2020-**Primärvalenz** taugt NICHT
als Prüfbild — seine BT.709-Entsprechung ist (-0,588; 1,133; -0,101), und der SDR-Zweig clamped sie
auf exakt dasselbe (0; 1; 0) zurück, der Test wäre auch nach der Behebung grün; genommen ist deshalb
0,2/0,8/0,35, wo der rote Kanal um 0,2 danebenliegt (51 von 255 Codes). (2) Die unten vorgeschlagene
Behebung ist **unvollständig**: die Matrix muss in LINEAREM Licht laufen (das verlangt der
Shader-Kommentar selbst) — auf die gamma-kodierten Werte angewandt ergäbe sie (0; 0,878; 0,307) statt
(0; 0,843; 0,248), also 0,057 Fehler im Blau, mehr als die Toleranz des Tests.

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

**Stand: NUR MIT ECHTEM SENDER** — `target` ist eine lokale Variable in `session::run`, und
`buffers.entry(codec).or_insert_with(…)` wird nur erreicht, wenn über `rtp_rx` ein Paket eines bis
dahin unbekannten Codecs eintrifft. Beides setzt eine erfolgreich aufgebaute WHEP-Verbindung mit
echten Spuren voraus (Video zuerst, Ton später); `run` baut die Verbindung selbst, es gibt keinen
Injektionspunkt. **Ungeprüft, nicht widerlegt.**

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

**Stand (Stufe 3): BEHOBEN** — `kopf_lesen()` erzwingt Mindestgruppengröße 2
(`fec/flexfec03.rs:143`). Das ist die Engstelle: sowohl `empfaenger.rs:167` als auch `gegenprobe.rs:106`
rufen sie zuerst, der Empfangsweg steigt also schon am Kopf aus und zählt nichts als `repariert`.
`zurueckrechnen()` wurde bewusst nicht angefasst — bei Gruppengröße ≥ 2 ist `vorhanden` konstruktionsbedingt
nie leer, ein zweiter Wachposten wäre toter Code. Der Reproduktionstest in `flexfec03.rs` musste umgebaut
werden: er ließ `kopf_lesen()` erst per `expect("heute lesbar")` gelingen und verlangte dieselbe Rückgabe
drei Zeilen später als Fehler — nach jeder denkbaren Behebung unpassierbar. Geblieben ist die schärfere
Hälfte (`expect_err`) plus Gegenprobe mit zwei Mitgliedern; der zweite Test (`empfaenger`) ist im Rumpf
bytegleich unverändert und war der eigentliche Nachweis.
**Zur Sache:** es ist kein Rechenfehler — bei Gruppengröße 1 ist die Parität durch die XOR-Identität
zwangsläufig das Paket selbst, die „Reparatur" wäre inhaltlich korrekt, nur eine 100-%-Doppelung ohne jede
Paritätswirkung. Behoben ist die fehlende Plausibilitätsprüfung und der Zähler, der Wirkung behauptet.
**Risiko:** abgelehnte Kopfzeilen werden im Empfangsweg **still** verworfen (`empfaenger.rs:167` kennt
keinen Zähler) — eine Einstellung mit `PULSE_FLEXFEC_MEDIA == PULSE_FLEXFEC_FEC` leistet ab jetzt lautlos
gar nichts mehr, wo sie vorher (teuer) wirklich reparierte. Produktion fährt 10/2, der Fall ist heute
unerreichbar, wäre es aber durch eine bloße Env-Änderung am Server wieder.

**Stand: REPRODUZIERT (beide Hälften)** — Tests
`fec::flexfec03::tests::repro_21_einzelgruppe_wird_angenommen` und
`fec::empfaenger::tests::repro_21_einzelgruppe_wird_als_repariert_gezaehlt`. Drei Zwischenschritte
laufen im ersten Test grün durch und belegen den Ablauf: `kopf_lesen()` nimmt die Ein-Bit-Maske an
(`geschuetzte_sequenzen == [1000]`), und `zurueckrechnen()` gelingt mit einem **leeren**
`vorhanden`-Slice und liefert exakt die Originalbytes zurück — es wurde also nichts gerechnet, die
Paritätsnutzlast wird nur durchgereicht. Im Empfangsweg zählt das als `repariert == 1`, und das Paket
geht über `tx` in den Jitter-/Decoder-Pfad (der Beleg führt beides mit: "eingespeist: true,
bytegleich mit dem Original: true"). Die Einordnung der Skeptiker bestätigt sich: nicht falsch
gerechnet, sondern ein Zähler, der Wirkung behauptet, wo keine stattfand.

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

**Stand (Stufe 3): BEHOBEN** — `lies_answer_begrenzt` (`whep.rs:710`) weist ein
`Content-Length > MAX_ANSWER_BYTES` (256 KiB) ab, bevor ein Byte gelesen wird, und zählt beim gestreamten
`res.chunk()` mit, falls der Kopf fehlt oder lügt. Die Vorabprüfung geht über den Vorschlag hinaus; 256 KiB
statt „wenige KB", damit eine echte Answer mit langer ICE-Kandidatenliste unter keinen Umständen anschlägt.
**Einwand:** der Kommentar über der ersten Zusicherung (`whep.rs:976`) sagt weiterhin, der Abbruch komme
„aus der SDP-Prüfung dahinter" — er kommt jetzt aus der Größenprüfung davor. Ausgerechnet an der Zusicherung,
für die der Fehlertext bewusst gleichlautend gewählt wurde: sie kann seither nicht mehr belegen, woher der
Abbruch stammt. Ein zusätzliches `fehler.contains("Obergrenze")` würde den Test stärker machen.
**Weitere Risiken:** `reqwest` ist ohne `charset` gebaut, `res.text()` war also `from_utf8_lossy` — ungültiges
UTF-8 wird jetzt hart abgewiesen statt mit Ersatzzeichen durchgereicht (praktisch harmlos, aber unerwähnt).
Und die Byte-Zusicherung des Tests misst Kernel-Sendepuffer: auf einer Maschine mit größer autoabgestimmtem
`wmem` (Linux) kann sie die 1-MB-Grenze reißen, obwohl der Fix korrekt arbeitet.

**Stand: REPRODUZIERT** — Test `whep::tests::repro_22_whep_antwort_ohne_groessengrenze`. Ein
Stub-Server auf 127.0.0.1 kündigt per `Content-Length: 209715200` 200 MB an; `whep::connect` nimmt
alle 209 715 200 Byte an, in 1,17 s — weit innerhalb des 15-s-Timeouts, das die einzige Schranke ist.
Zwei Dinge sind mitbewiesen: der Abbruch kommt erst aus `answer.contains("v=")` **dahinter**
(Fehlertext "WHEP-Antwort war kein gültiges SDP"), der Body war also komplett im Speicher, bevor
überhaupt geprüft wurde; und der Stub bekam kein EPIPE, der Client hat also nicht früh zugemacht.
Gemessen wird bewusst die abgesetzte Byte-Menge der Gegenstelle — von außen beobachtbar und nach
einer Behebung (gestreamtes Lesen mit kleiner Obergrenze) automatisch bei wenigen KB.

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

**Stand: NICHT NACHBAUBAR** — die fehlenden `alive = false` liegen in den `return`-Zweigen der
Thread-Closure **innerhalb** von `AudioOutput::new()`. `new()` holt Host und Gerät selbst über
`cpal::default_host().default_output_device()`; es gibt keinen Parameter, über den ein scheiterndes
Gerät oder eine unpassende Konfiguration untergeschoben werden könnte, und auf diesem Mac öffnet
`build_output_stream` mit der Standardkonfiguration erfolgreich. Die zweite Hälfte (Panik im Thread)
hängt an derselben Closure. Der Befund ist damit **nicht widerlegt, sondern unerreichbar** — was
zugleich zeigt, dass dieser Fehlerpfad überhaupt nicht testbar gebaut ist.

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

**Stand (Stufe 3): BEHOBEN** — `Unit.data` ist `bytes::Bytes`, `Recorder::push`/`handle_unit` nehmen
`Bytes` entgegen, `to_vec()` entfällt; der Ring hält die Einheit referenzgezählt statt kopiert. Der Test
musste an die Signatur angepasst werden (`Bytes::from(vec![…])` + `clone()`) — anders geht es nicht, ohne
genau die Kopie einzubauen, um die es geht; die Zusicherung (Adressgleichheit) ist wörtlich unverändert.
**Risiko (ungemessen, kein Test):** die Form der Speicherbindung ändert sich. Der Ring hielt bisher exakt
dimensionierte `Vec`-Kopien, jetzt hält er die Allokationen des Depacketizers — und weil er 60 Sekunden lang
eine zweite Referenz hält, ist der geteilte Puffer nie mehr `is_unique()`: `BytesMut::reserve_inner` nimmt
dauerhaft den Zweig „neu allozieren" statt den Puffer nach jedem `split()` wiederzuverwenden. Netto klar ein
Gewinn, aber der Ring kann im ungünstigen Fall bis etwa das Doppelte der reinen Nutzlast binden (Vec-Wachstum
verdoppelt), und er wird **ausschließlich nach Zeit** beschnitten (`RING_SECONDS = 60`, keine Bytegrenze) —
der Spitzenspeicher bleibt nach oben offen. `ClipData` erbt dieselbe Bindung. **Nebengewinn, nicht
nachgezogen:** `clip_snapshot` kopiert keine Nutzlast mehr, der Doc-Kommentar `recorder.rs:507` behauptet
das Gegenteil.

**Stand: REPRODUZIERT** — Test `recorder::tests::repro_24_ring_kopiert_jede_einheit`. 600 Pushes
desselben 100-kB-Puffers ohne jede laufende Aufnahme (`is_recording()` ist false) erzeugen
60 000 000 Byte an Kopien — genau die eingespeiste Menge, nichts wird geteilt. Der eigentliche Beweis
ist der Adressvergleich: `r.ring.back().unwrap().data.as_ptr()` unterscheidet sich vom `as_ptr()` des
Aufrufer-Puffers, also liegt in `recorder.rs:395` ein vollständiges memcpy je Zugriffseinheit.
**Abweichung von der Testskizze:** deren Zielzustand `sum == 0` wäre auch nach der `Bytes`-Umstellung
nicht erreichbar (`Bytes` haben weiterhin eine Länge) — prüfbar ist die Adressgleichheit, die
kopierte Bytemenge wird nur protokolliert.

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

**Stand: NUR MIT ECHTEM SENDER** — `spawn_with_fallback` ist eine Methode auf `App` (braucht
`self.runtime`) und startet zwei echte `session::run`-Aufgaben gegen zwei URLs. Die Kapazität des
Zwischenkanals ist ein Literal (`mpsc::channel::<SessionEvent>(8)`) und von außen nicht abfragbar;
um die Wirkung (verworfene Bilder) zu sehen, braucht es einen Sender, der schneller liefert als der
Fenster-Faden zeichnet — also einen echten Strom plus Fenster. `app/mod.rs` hat kein Testmodul, und
`Session` verlangt ein `Arc<Window>`. **Ungeprüft, nicht widerlegt.**

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

**Stand: NICHT NACHBAUBAR** — der frühe Ausstieg steht in `Renderer::render`, und `Renderer`
hält eine `wgpu::Surface` samt Konfiguration, die nur aus einem winit-Fenster entsteht. Der
vorhandene kopflose Weg (`messen::gpu::Messstand`) umgeht `render()` ausdrücklich und zeichnet in
eine eigene Textur, er kann diesen Zweig also nicht prüfen. Auf macOS kommt hinzu, dass ein Fenster
den Haupt-Thread und eine laufende EventLoop braucht, was `cargo test` nicht bietet. **Ungeprüft,
nicht widerlegt.**

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

**Stand (Stufe 3): ERSTER TEIL BEHOBEN, ZWEITER TEIL BEWUSST NICHT** — neue Prüfung `pruefe_ziel()`
(`recorder.rs:83`), aufgerufen in `Recorder::start` **vor** `video_info`/`with_container` und in
`write_clip` vor `Writer::create`: abgelehnt werden relativer Pfad, jede `..`-Komponente und ein nicht
vorhandenes Zielverzeichnis; die Datei wird gar nicht erst angelegt. Test
`repro_27_pfad_verlaesst_das_aufnahmeverzeichnis` grün.
**Abweichung vom Vorschlag:** „gegen ein festes Aufnahmeverzeichnis kanonisieren" kann der Player nicht —
welches Verzeichnis vorgesehen ist, weiß allein der Electron-Hauptprozess (`player.ts::recordingDir` aus
`app.getPath('videos')`), der Player bekommt nur den fertigen Pfad. Symlink-Kanonisierung wurde weggelassen,
weil unter macOS schon `std::env::temp_dir()` über `/var` → `/private/var` zeigt. Es ist damit eine
**Formprüfung, keine Eingrenzung**: ein absoluter Pfad ohne `..` wird angenommen, egal wohin er zeigt.
**Zweiter Teil — NICHT BEHOBEN**, `repro_27_aufnahme_kennt_keine_obergrenze` trägt weiter `#[ignore]`. Der
Test verlangt, dass eine Aufnahme spätestens nach 999,9 s bzw. ~15 MB endet. Jede Grenze, die das erfüllt,
liegt unter einer Viertelstunde Aufnahmezeit — das ist für den Mitschnitt eines HQ-Streams kein Schutz,
sondern eine stille Verstümmelung: der Nutzer bekäme wortlos eine abgeschnittene Datei, denn die
Statusmeldung kennt nur `recording`/`recording_failed`, kein „Grenze erreicht". Eine ehrliche Grenze läge bei
Stunden bzw. zweistelligen GB — dann bliebe der Test rot. Der Weg dorthin ist zudem nicht offen (der
Renderer kann `record` nicht auslösen, nur der Hauptprozess), und der Bericht stuft diesen Teil selbst als
„niedrig, Verteidigungstiefe" und die Behebung als „optional" ein. **Vor einer Behebung braucht es eine
Produktentscheidung über die Grenze und eine Meldung dafür nach vorn — und der Test gehört auf einen
realistischen Zeitraum umgeschrieben.**
**Weitere Einwände:** der Wächter in `write_clip` ist von keinem der 248 Tests erreicht; unter Windows sind
die Randfälle des `is_absolute()`/`is_dir()`-Zweigs ungeprüft (fehlender Laufwerksbuchstabe, MAX_PATH ohne
`\\?\`); und `proto.rs:65/68` tragen weiterhin `#[allow(dead_code)]` auf `path`/`seconds`, obwohl beide
gelesen werden — genau die Behauptung in Maschinenform, deren Prosa daneben gerade korrigiert wurde.

**Stand: REPRODUZIERT (beide Teile)** — Tests
`recorder::tests::repro_27_pfad_verlaesst_das_aufnahmeverzeichnis` und
`recorder::tests::repro_27_aufnahme_kennt_keine_obergrenze`. Erstens: `Recorder::start` nimmt einen
Pfad mit `..` an, `with_container` hängt nur `.ts` an, und `ffmpeg::format::output`
(`recorder.rs:245`) legt die Datei tatsächlich **zwei Ebenen über** dem vorgesehenen Verzeichnis an —
nachgewiesen über `exists()` am aufgelösten Ort. Zweitens: 10 000 Einheiten über 1000 s Aufnahmezeit
werden vollständig geschrieben (15,4 MB bei 1-kB-Einheiten; bei realer Bitrate entsprechend mehr),
und die Aufnahme läuft danach unverändert weiter — playerseitig gibt es weder eine Dauer- noch eine
Größenobergrenze. Die Einordnung bleibt wie unten: das ist die fehlende **zweite** Schicht im Player,
kein offener Weg. Beide Tests räumen ihre Dateien vor der Behauptung auf.

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

**Stand (Stufe 3): BEHOBEN** — `append_obu_with_size` liefert jetzt `bool` und hält das mitgelieferte
Feld gegen die verbindliche RTP-Elementlänge (`header_len + LEB128-Breite + obu_size == obu.len()`,
`depacket/av1.rs:100`); `flush_partial` setzt bei Widerspruch `poisoned`. Die Prüfung sitzt richtig — nach
dem Zusammensetzen aller Fragmente, denn vorher steht die Elementlänge nicht fest. Der Zweig
`obu.len() < header_len` (abgeschnittener Kopf mit Extension-Bit) lässt den OBU weiterhin still weg; im
Befund nicht genannt, jetzt ausdrücklich als bewusst dokumentiert.
**Risiken:** (a) neuer stiller Verwurfspfad — ein widersprüchliches Element vergiftet die ganze
Zugriffseinheit, ohne Zähler, Log oder Keyframe-Anforderung; ein fremder Sender, der `obu_has_size_field`
systematisch falsch setzt, liefert damit dauerhaft schwarzes Bild statt Bildmüll, und genau für fremde Sender
ist der Zweig laut Kommentar da. (b) `header_len + n + size as usize` ist ungeprüfte Arithmetik — auf einem
32-Bit-Ziel Überlauf (heute latent, es gibt keins); `obu.len().checked_sub(header_len + n) == Some(size)`
wäre immun. (c) Der Funktionskopf `av1.rs:79` sagt weiterhin unbedingt „wird unverändert übernommen" — das
gilt jetzt nur bei stimmigem Feld.

**Stand: REPRODUZIERT (beide Hälften)** — Test
`depacket::av1::tests::repro_28_gelogenes_obu_size_wird_durchgereicht`. Ein 400-Byte-Element, dessen
Kopf `obu_size = 1` behauptet, kommt byte-gleich mit 400 Byte heraus — `append_obu_with_size` hält
das Feld nirgends gegen die verbindliche RTP-Elementlänge (1 Kopfbyte + 1 LEB128-Byte + 1 = 3, nicht
400). Und der Anschluss an den Mitschnitt trägt: dieselbe Einheit meldet über
`recorder::is_keyframe(Codec::Av1, ..)` **true**, obwohl kein Einstiegspunkt vorliegt —
`scan_av1_for_keyframe` springt nach dem gelogenen Größenfeld weiter, deutet das Füllbyte 0x00 als
Vollbild-Kopf mit `frame_type=KEY` und das darauffolgende 0x0A als Sequence-Header-OBU. Der Sender
bestimmt also frei, worauf der Decoder einsteigt.

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

**Stand (Stufe 3): BEHOBEN** — `surface_is_linear` liefert `matches!(format, Rgba16Float) ||
format.is_srgb()` (`render/farbe.rs:173`); `format.is_srgb()` statt eigener Formatliste, weil eine zweite
Tabelle bei einem neuen Format still danebenläge. Der Vorschlag stimmte hier. Der Doku-Punkt in
`docs/2026-08-04-player-farbwerte-messung.md`, der die Falle als unangetastet führte, hat einen
Erledigt-Nachtrag bekommen.
**Einwand:** die Reichweite ist größer als behauptet. „Nur über die Diagnose-Variable erreichbar" stimmt
nicht — `pick_format` (`render/setup.rs:109`) fällt am Ende auf `offered.first()` zurück, und die
protokollierte reale Angebotsliste beginnt mit `[Rgba8UnormSrgb, Bgra8UnormSrgb, …]`. Auf einem System, das
nur sRGB-Oberflächen anbietet, greift der Rückfall ohne jede Umgebungsvariable, und der Fix **ändert dort das
ausgelieferte Bild** (in die richtige Richtung, aber auf einem Pfad, den kein Test fährt).
**Nicht mitgezogen:** `render/shader.wgsl:186` behauptet weiterhin „nur für Oberflächen, die lineares Licht
erwarten — auf dieser Maschine `Rgba16Float`" und schreibt die Doppelkodierung „dem Compositor" zu; es gilt
jetzt für jedes `*_SRGB`-Ziel, und dort kodiert die ROP. Ungeprüft bleibt, ob das egui-Overlay (bekommt das
Format direkt, `overlay/mod.rs:161`) auf einer sRGB-Oberfläche mitzieht — das ginge nur per Sichttest.

**Stand: REPRODUZIERT** — Test
`messen::farbwerte::tests::repro_29_srgb_ziel_wird_doppelt_kodiert`. Derselbe Graukeil in zwei Ziele
gezeichnet: Luma-Code 200 (10 bit) landet nach `Bgra8Unorm` bei 0,1569, nach `Bgra8UnormSrgb` bei
0,4314 — das ist genau `srgb_kodieren(0,1553) = 0,4306`; die ROP behandelt den bereits
gamma-kodierten Shader-Wert als linear und legt die sRGB-Kurve ein zweites Mal darauf. Die
Richtungskorrektur des Berichts (Mitten werden **heller**, nicht dunkler) ist damit gemessen, nicht
nur behauptet. Schwarz (Code 64) bleibt in beiden Zielen 0, deshalb fällt erst die zweite Keilstufe.
Die Direktzusicherung `assert!(surface_is_linear(Bgra8UnormSrgb))` ist im selben Test enthalten und
wäre ebenfalls rot. Der Test steht in `messen/farbwerte.rs` statt in `render/farbe.rs`, weil
`messen::gpu` ein privates Modul von `messen` ist.

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

**Stand: NUR MIT ECHTEM SENDER** — die Kopie steht in `pump_track`, dessen erstes Argument ein
`Arc<TrackRemote>` ist; den gibt es nur aus `on_track` einer ausgehandelten Verbindung, und
`TrackRemote` lässt sich nicht ohne PeerConnection bauen. Der Kern des Befunds ist ohnehin eine
Typumstellung (Kanal auf `bytes::Bytes`), deren Nutzen nur unter echtem Paketdurchsatz messbar ist.
**Ungeprüft, nicht widerlegt.**

`pump_track` marshalt jedes Videopaket zurück nach `Bytes` und ruft dann
`m.try_send((seq, bytes.to_vec()))`; ist zusätzlich die Gegenprobe eingeschaltet (eigener
Diagnoseschalter, im Normalbetrieb aus), kommt ein zweites `to_vec()` dazu. FlexFEC ist seit
2026-08-03 der Standardweg, der Zweig also im Regelbetrieb aktiv. Der Klon in
`empfaenger.rs:263` fällt entgegen der Erstmeldung nur im Reparaturfall an, nicht bei jeder
Prüfung.

Behebung: Kanal und `Vorrat::inhalt` auf `bytes::Bytes` umstellen; dann genügt `clone()`.

### 31. Gegenprobe-Diagnose sammelt Nachlauf-Zeiten unbegrenzt
`src/fec/gegenprobe.rs:145` — **niedrig, Ressourcenleck**

**Stand (Stufe 3): BEHOBEN** — `nachlauf_us` ist `VecDeque` mit `push_back` plus Deckel bei `VORRAT`
(512), genau nach dem Muster des Nachbarfeldes `medien` (`fec/gegenprobe.rs:155`). Von den zwei angebotenen
Wegen wurde gedeckelt statt bei jedem `MELDEABSTAND` geleert: Leeren stützte die Verteilung auf je ≤50 Werte
(ein 99-%-Perzentil aus 50 Werten ist der zweitgrößte Wert, also Rauschen). Die Meldezeile sagt jetzt „aus
den **letzten** N Gruppen" — ohne das hätte sie ab 512 gelogen.
**Risiko:** die Abschlussbilanz misst jetzt ein sehr kurzes Fenster — bei fünf Paketen je Gruppe rund 2560
Medienpakete, je nach Bitrate eine halbe bis wenige Sekunden. Die Zeile „Maximum" heißt danach faktisch
„Maximum der letzten Sekunden", und der seltene Ausreißer ist genau das, wonach diese Diagnose sucht.
Entschärfend: `MELDEABSTAND` (50) ist viel kleiner als der Deckel, jeder Wert steht in mindestens zehn
Zwischenmeldungen im Log. Wer die Zahl sitzungsweit braucht, hält zwei Skalare (laufendes Maximum,
Gesamtzahl) neben dem Fenster — 16 Byte, keine Rechenzeit. Nebenbei: die Doku von `VORRAT` begründet die 512
weiter rein aus der Paritätsverzögerung, obwohl die Konstante jetzt einen zweiten Nutzer in einer anderen
Einheit hat (512 Gruppen statt 512 Pakete).

**Stand: REPRODUZIERT** — Test `fec::gegenprobe::tests::repro_31_nachlauf_waechst_unbegrenzt`.
Nach 2000 Gruppen hält `nachlauf_us` 2000 Einträge; der Test führt das direkt benachbarte
`medien`-Feld als **Kontrollgruppe** mit, dessen Zusicherung (`len() <= VORRAT`, 512) hält. Damit
steht der Unterschied zwischen den zwei Feldern im Beleg und nicht nur eine absolute Zahl; die eigene
Ausgabe des Prüfstands quittiert es nebenbei selbst ("aus 2000 Gruppen"). **Ergänzung, die der
Bericht nicht nennt und die die Einstufung "niedrig" stützt:** `nachlauf_melden()` klont und sortiert
den Vektor bei JEDEM `MELDEABSTAND`-Ausdruck (alle 50 Gruppen), der Aufwand wächst also mit n log n
mit — spürbar erst bei sehr langen Sitzungen, und der ganze Pfad hängt an
`PULSE_PLAYER_FEC_GEGENPROBE=1`.

`Pruefstand::nachlauf_us` ist ein `Vec<u64>`, das bei jedem verwertbaren Paritätspaket
wächst und nie verkleinert wird — anders als das direkt daneben liegende `medien`-Feld, das
auf `VORRAT` (512) gedeckelt ist. `PRUEFSTAND` ist ein `static OnceLock<Mutex<…>>`, lebt
also über die ganze Prozesslaufzeit und über beliebig viele Sitzungen hinweg. Erreichbar
nur mit `PULSE_PLAYER_FEC_GEGENPROBE=1`.

Behebung: Analog zu `medien` deckeln oder bei jedem `MELDEABSTAND`-Ausdruck leeren.

### 32. Die Auffangnetz-Sitzung bekommt niemals `Options`
`src/app/mod.rs:292` — **niedrig, Korrektheit**

**Stand: NUR MIT ECHTEM SENDER** — wie Befund 25: `spawn_with_fallback` hängt an `App` mit
`self.runtime`, `apply_options` an `self.sessions.get_mut(...)` mit einer `Session`, die ein Fenster
führt. Der sichtbare Beweis (Hauptstrom stumm, Netz spielt weiter) verlangt zwei laufende Sitzungen
mit echter Tonausgabe, also zwei echte Sender. **Ungeprüft, nicht widerlegt.**

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

**Stand: NICHT NACHBAUBAR** — `bilanz_pruefen(&mut self, id, presented)` liest
`self.sessions.get_mut(&id)` und damit `session.stats`, `session.frames_never_drawn` und
`session.takt.verdraengt()`. Eine `Session` verlangt `Arc<Window>`, `render::Renderer`, `Overlay` und
einen Befehlskanal; `app/mod.rs` hat kein Testmodul und keinen Konstruktor ohne Fenster. Die Rechnung
selbst wäre trivial prüfbar, sobald sie aus `App` herausgelöst wäre — heute ist sie es nicht.
**Ungeprüft, nicht widerlegt.**

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

**Stand (Stufe 3): BEHOBEN** — die Kapazitätsprüfung lautet jetzt
`self.wartend.len() >= WARTENDE_PARITAET && !self.wartend.contains_key(&kopf.basis_sequenz)`
(`fec/empfaenger.rs:184`): das folgende `insert()` braucht bei bekanntem Schlüssel keinen Platz, verdrängt
wurde trotzdem eine fremde, noch lösbare Gruppe. Kapazitätsinvariante hält, der Hash-Lookup fällt im
Normalbetrieb (nicht voll) gar nicht an.
**Restschaden, im Kommentar untertrieben:** der neue Text sagt, das `insert()` hätte „bloß überschrieben",
nennt zwei Sätze später aber den einzigen real erreichbaren Weg, den 16-bit-Umlauf — und genau dort ist das
Überschreiben nicht folgenlos: die alte, fremde Wartegruppe unter derselben Basis geht still verloren, ohne
`verworfen` hochzuzählen. Der Fix halbiert den Schaden (eine verlorene Gruppe statt zwei), beseitigt ihn
nicht. Kein Test und keine Kennzahl macht das sichtbar. Nebenbei meldet `fec_verworfen` jetzt niedriger, was
die Vergleichsbasis zu älteren Messakten verschiebt.

**Stand: REPRODUZIERT** — Test
`fec::empfaenger::tests::repro_34_doppelte_basis_verdraengt_fremde_wartegruppe` (8 Wiederholungen,
jedes Mal identisch). **Korrektur an der Testskizze:** sie erwartet die Wirkung beim ZWEITEN gleichen
Paritätspaket — tatsächlich schlägt schon das **erste** Duplikat zu, denn in dem Moment ist
`wartend.len() == WARTENDE_PARITAET`; danach stehen nur noch 63 Einträge, und ein zweites Duplikat
löst gar keine Verdrängung mehr aus (63 >= 64 ist falsch). Wer nur auf das zweite schaut, sähe
`verworfen` unverändert und hielte den Befund fälschlich für widerlegt. Über die Skizze hinaus zeigt
der Test **echten Schaden** statt nur eines Zählerstands: alle 64 Wartegruppen haben genau zwei
Löcher und sind mit je einem Nachzügler lösbar, repariert werden aber nur 63 — die verdrängte Gruppe
ist endgültig weg. Die Verdrängung per `HashMap::keys().next()` könnte theoretisch die gerade
eingefügte Basis treffen (dann bliebe der Schaden aus); in acht Läufen ist das kein einziges Mal
passiert, und die tragende Zusicherung (`verworfen == 0`) fällt ohnehin deterministisch.

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

**Hier stand vor der Reproduktion:** "Nicht geprüft werden konnte: alles, was Ausführung
braucht (der Crate baut hier nicht). Die Befunde 1, 2 und 4 sind Kandidaten für eine gezielte
Laufzeit-Bestätigung, sobald `vendor/webrtc-rs` verfügbar ist." Der erste Satz ist überholt:
`vendor/webrtc-rs` ist da, der Crate baut und testet, und **18 Befunde sind mit einem roten
Test belegt** (siehe Standzeilen und die Übersicht in der Zusammenfassung). Der zweite Satz
gilt weiter, aber aus einem anderen Grund als angenommen: 1, 2 und 4 scheitern nicht am
fehlenden Vendor-Verzeichnis, sondern an fehlender **Hardware** — sie sind auf einem Windows-
bzw. Linux-Rechner mit echter Grafikeinheit binnen Minuten nachstellbar, auf einem Mac
grundsätzlich nicht (`#[cfg]`-Zweige, die hier nicht einmal übersetzt werden).

**Hier stand vor Stufe 3:** „Was Stufe 3 als Erstes braucht: 1. Die 18 roten Tests
behebungsbegleitend grün ziehen … 2. Zwei Prüfläufe auf fremder Hardware … 3. Prüfeinstiege
nachrüsten, wo es heute keine gibt (12, 23, 26, 33)." Punkt 1 ist erledigt (17 von 18, siehe
Behebungsstand oben); die Punkte 2 und 3 stehen unverändert offen und werden deshalb unten
weitergeführt. Punkt 3 hat sich dabei zur Hälfte selbst erledigt: `Zulauf` hat mit Befund 11
ein Ausfallsignal bekommen — allerdings als verbrauchtes **Ereignis** über den Briefkasten,
nicht als der dort vorgeschlagene Sichtbarkeits-**Zustand**, weil ein hängengebliebener
Zustand die Aufsicht dauerhaft ausschalten würde.

**Stand 2026-08-09, vor dem Deploy:** Punkt 1 unten ist erledigt — beide Vorbehalte sind aufgelöst,
nicht durch Zurücknehmen, sondern durch echte Behebung (Befund 13: dritter, scharfer Testentwurf;
Befund 17: die riskante Zeile ist wieder raus, noch am selben Tag, vor dem ersten Push). Dazu ist beim
Gegenlesen ein **dritter, bis dahin unbekannter Weg** zum Bildmüll aus Befund 5 aufgetaucht (der
`Err`-Zweig ließ `fua_buffer` unangetastet) und ebenfalls behoben — siehe Befund 5. Damit sind
**18 von 34 Befunden behoben**, alle mit grünem statt rotem Test. Die Punkte 2-6 stehen unverändert
offen; 2 ist jetzt der wichtigste, weil er die beiden einzigen kritischen Befunde trägt.

Was als Nächstes ansteht:

1. ~~Die zwei Vorbehalte auflösen~~ **ERLEDIGT 2026-08-09**, s.o.
2. **Zwei Prüfläufe auf fremder Hardware — der wichtigste offene Punkt:** ein Windows-Rechner mit
   HDR-Schirm (Befunde 1, 4, 6, 16, 18) und ein Linux-Rechner mit Vulkan/CUDA (2, 6). Befund 1 und 2
   sind die beiden **kritischen** Befunde des ganzen Berichts (Absturz bzw. Speichersicherheit) und
   bislang auf keiner Plattform auch nur ausführbar geprüft — auf dem Mac übersetzen ihre `#[cfg]`-Zweige
   nicht einmal. Befund 4 hat mit der Behebung von 17 zusätzlich an Dringlichkeit gewonnen: der Ring
   bleibt jetzt absichtlich bis zum Sitzungsende belegt, bis 4 seine strukturelle Lösung bekommt
   (`Ringplatz` per `Arc` an den `GpuBild`ern).
3. **Prüfeinstiege nachrüsten, wo es heute keine gibt** (12, 23, 26, 33): `bilanz_pruefen` aus
   `App` herauslösen, `AudioOutput::new()` Host/Gerät übergeben lassen. Ohne diese Einstiege
   bleibt der nächste Bughunt an denselben Stellen wieder rein lesend.
4. **Die neuen stillen Verwurfspfade sichtbar machen** (14, 21, 28, dazu die bestehenden
   `poisoned`- und `kopf_lesen`-Ablehnungen): ein Zähler je Verwurfsgrund im Empfangsweg, damit
   ein dauerhaft schwarzes Bild in der Ferndiagnose nicht wie eine ruhige Leitung aussieht.
5. **Restarbeit an Kommentaren**, die eine gerade korrigierte Aussage anderswo weitertragen —
   gesammelt aus den Gegenproben: `depacket/mod.rs:40` (**erledigt 2026-08-09**, `fua_buffer` ist
   modulprivat, nicht `pub(crate)`), `depacket/av1.rs:79` und `:141`, `decode.rs:1740` und `:255`,
   `recorder.rs:507`, `render/shader.wgsl:186`, `whep.rs:976`, `proto.rs:65/68`
   (`#[allow(dead_code)]` auf gelesenen Feldern), `zerocopy/platz.rs:53` und
   `render/fremdbild.rs:469` (Lebensdauer-Zusicherung — bleibt vorerst korrekt, weil Befund 17 den
   Bruch zurückgenommen hat, statt ihn zu begehen), `bruecke.rs:63`
   (Ringgröße noch mit 24 Plätzen gerechnet) sowie `streaming/pulse-player/README.md:279`
   (Einfrier-Wächter ohne die neue Ausnahme).
6. **Changelog:** der Stapel enthält mit Befund 19 und 29 sichtbare Farbänderungen; dafür gibt
   es noch keinen Eintrag in `web/static/changelog.json`. Wird Teil des Deploys, den dieser Bericht
   begleitet.
