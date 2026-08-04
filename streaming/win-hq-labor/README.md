# Windows-HQ-Labor — Intra-Refresh auf AMD/Windows

**Das Ziel und die Regeln stehen in `CLAUDE.md` daneben.** Kurz: Intra-Refresh
soll das reguläre Verfahren mit periodischen Vollbildern ersetzen; hier wird es
auf AMD/Windows portiert. Was hier entsteht, heißt `pulse-win-hq-labor` und geht
in keinen Nutzer-Build — `win-build.yml` baut ausschließlich
`pulse-win-hq-sidecar`.

## Stand (2026-08-02): Intra-Refresh läuft — über AMF, nicht über Vulkan

**Der Encode-Weg ist seit dem 2026-08-02 `av1_amf`/`h264_amf` mit Auffrischung**,
ein nackter Lauf braucht dafür keine Umgebungsvariable. Der Vulkan-Weg bleibt
allein als Vergleichsarm stehen (`PULSE_LABOR_VULKAN=1`) — sein Code und seine
Messakten sind Absicht, nicht Rückstand: der Vergleich muss nachfahrbar bleiben.
**Die Begründung, Optionen und Schalter stehen in `CLAUDE.md`**, Abschnitt „Der
Encode-Weg"; hier steht bewusst keine zweite Fassung davon.

Belegt am Zuschauer (dekodierendes Messwerk, `amf-2026-08-02-intra-refresh-doch.json`,
`amd-2026-08-02-h264-intra-refresh.json`, `amd-2026-08-02-qualitaet-und-browser.json`):

| | |
|---|---|
| AV1 8 und 10 Bit, `intra_refresh_mode=gop_aligned` | **ein** Vollbild statt sechs |
| Vollbild auf Anforderung, *während* die Auffrischung läuft | wird eingelöst |
| Zuschauer ohne Anforderung | **0 Bilder** — bleibt blind, wie es sein muss |
| Browser, alle drei Fälle gleichzeitig | durchgehend Hardware, 0 Rückfälle |
| Qualität gegen den Vulkan-Weg | rund **43 % weniger Bits** bei gleicher PSNR/SSIM |

Der dritte Punkt ist der Beleg dafür, dass der Rückkanal Voraussetzung ist:
ein Intra-Refresh-Strom hat nach dem Start kein Vollbild, an dem jemand
einsteigen könnte.

**Offen:** eine Hörprüfung und eine A/V-Versatz-Messung über den eigenen
Sendeweg. Ton läuft mit (Opus kommt am Server an), ist aber nie angehört und nie
gegen das Bild vermessen worden — das eigene Messwerk zählt nur Bilder.

## Warum getrennt

Der experimentelle Weg (eigener WebRTC/WHIP-Push, AV1-Paketierer,
Intra-Refresh) greift mitten in den Sendepfad: der Encoder-Ausgang wird von
„schreib in den Muxer" zu einem Enum `Muxer | Whip`. Über den ausgelieferten
Stand gelegt liefe **jeder Windows-Nutzer** durch diesen Code — auch wer nie
WHIP anfasst, und ein Fehler darin zeigte sich nicht als Absturz, sondern als
etwas mehr Ruckeln bei Leuten, die nichts damit zu tun haben.

Dazu kommt: der Weg funktioniert nur mit Beiwerk, das ebenfalls nicht
ausgeliefert ist — gepatchtes MediaMTX (`../hq-labor/mediamtx-patches/`),
gepatchtes FFmpeg (s.u.) und ein Player, der kein Produktteil ist.

## Der Stand, den dieses Verzeichnis voraussetzt

Drei Befunde vom 2026-08-01, alle auf Radeon 780M / Treiber 32.0.31035.1003 —
**der erste ist am 2026-08-02 widerlegt worden**, und weil er die Begründung für
alles Vulkan-Beiwerk in diesem Verzeichnis war, steht er hier weiter, statt
stillschweigend zu verschwinden:

1. ~~**AMF kann kein Intra-Refresh.**~~ **Falsch.** Gemessen wurde
   `-intra_refresh`, und die Option heißt bei `av1_amf` schlicht anders:
   `-intra_refresh_mode gop_aligned` (plus `-intra_refresh_stripes`), bei
   `h264_amf` `-intra_refresh_mb`. Damit frischt AMF wirklich auf, in 8 wie in
   10 Bit. Die byte-identischen Ströme waren echt — sie kamen davon, dass der
   Treiber einen Optionsnamen annimmt, den er nicht kennt.
   Herleitung: `amf-2026-08-02-intra-refresh-doch.json`.
2. **D3D12 ebenfalls nicht brauchbar.** `av1_d3d12va` bricht mit Intra-Refresh
   sofort ab; `h264_d3d12va` nimmt die Option an, ändert den Strom um 0,47 % und
   setzt weder `constrained_intra_pred_flag` noch einen recovery point.
   (Steht weiter — hier war der Optionsname `intra_refresh_mode row_based` der
   richtige.)
3. **Vulkan Video geht** — technisch, aber nicht gut genug: 43 % mehr Bits bei
   gleicher Qualität als AMF, eine Ratensteuerung, die ihr Ziel nicht trifft,
   und 10 Bit ist magenta (s.u.). Deshalb nur noch Vergleichsarm.

**Was Intra-Refresh NICHT leistet, auf keiner Plattform:** heilen. Ein einziges
verworfenes Bild tötet den Strom dauerhaft — gemessen auf Linux mit `av1_nvenc`
(`../testbench/profiles/decoder-2026-07-29-intra-refresh.json`), und der Grund
ist der Decoder, nicht der Encoder. Der Verlustschutz kommt aus der Schicht
darunter (FEC, NACK) plus dem Vollbild auf Anforderung. Wer hier misst und
„erholt sich nicht" findet, hat das erwartete Verhalten gemessen.

## Wie die Trennung gebaut ist

Wie beim Linux-Labor: der ausgelieferte Sidecar wird als **Bibliothek**
eingebunden (`pulse-win-hq-sidecar = { path = "../win-hq-sidecar" }`, dessen
`lib.rs` alle Module bereits `pub` führt). Kopiert wird nur, was der WHIP-Weg
ohnehin umbaut.

Die Abhängigkeit läuft nur in eine Richtung: die Bibliothek weiß vom Labor
nichts. Der Preis ist die Duplikation der kopierten Dateien — bewusst in Kauf
genommen, bis feststeht, welche Teile bleiben.

**Beim nächsten Eingriff am ausgelieferten Sidecar abgleichen**, mindestens die
messrelevanten Werte. Auf der Linux-Seite ist genau das schon am Tag der
Trennung fällig geworden.

### Was im Verzeichnis liegt

| Modul | Wofür |
|---|---|
| `senke.rs` | die Naht zur Bibliothek — der Sidecar encodiert, das Labor sendet. Eine `push_url` **ohne** `http` schreibt statt dessen eine Datei; damit ist jede Sichtprüfung ohne Netz zu haben |
| `whip/` | eigener WebRTC-Sender, AV1-Paketierer, Level-Berichtigung, Entpacker, Taktgeber |
| `whep/` + `whep.rs` | der eigene Zuschauer (`examples/whep_messwerk.rs`): empfängt, setzt zusammen, **dekodiert**, zählt, kann PLI schicken und Verlust erzeugen. **Bild only** |
| `auffrischung.rs` | setzt die AMF-Auffrischungsoptionen für den eigenen Prozess, bevor der Auftrag hineingeht — und nur dann (kein laufender Strom, keine Angabe von außen, kein Vulkan, nicht abgeschaltet) |
| `vulkan_encoder.rs` + `vkimport/` | der Vergleichsarm: D3D11-Textur zero-copy nach Vulkan, eigener Encode-Weg |
| `grenzen.rs` | wo der Vulkan-Weg auf dieser Karte abbricht statt umzuleiten (10 Bit) |
| `bildabzug.rs` | holt das Bild an der Übergabestelle zum Encoder zurück — trennt „Textur schon falsch" von „Encoder liest falsch" |
| `logging.rs` | der `tracing`-Empfänger. Ohne ihn ist das Labor stumm, ohne Warnung beim Bauen |

## Gepatchtes FFmpeg — wofür es heute noch gebraucht wird

Das eigene FFmpeg ist **mit** der Vulkan-Begründung entstanden und überlebt sie:
seit der Umstellung auf AMF (2026-08-02) tragen die beiden Patches nur noch den
Vergleichsarm, die beiden Zusatz-Bibliotheken dagegen den täglichen Betrieb.

Zwei Patches, beide nur für den Vulkan-Weg:

1. **`-intra_refresh` gibt es an `av1_vulkan`/`h264_vulkan` nicht.** FFmpeg
   reicht `VK_KHR_video_encode_intra_refresh` in keiner Version durch (8.1 und
   master geprüft). Ohne den Patch ist der Vulkan-Vergleich nicht messbar.
   (Bis zum 2026-08-02 stand hier „und damit kann diese Maschine gar kein
   Intra-Refresh, weil AMF es ignoriert" — das war der Fehlschluss aus dem
   falschen Optionsnamen, s. oben.)
2. **`h264_vulkan` öffnet mit keiner Ziel-Bitrate.** Ein Parametersatz-Abzug
   des Treibers, den FFmpeg gar nicht braucht, bringt den Encoder um.

Zwei Bibliotheken, die auch der AMF-Weg braucht:

* **`libdav1d`** — der Decoder des Messwerks. Ohne ihn fällt es auf `av1_amf`
  zurück, eine reine Hardware-Hülle, die jedes Bild annimmt und keines liefert:
  „0 Bilder" für einen kerngesunden Strom. Hat einen halben Tag gekostet.
* **`libopus`** — der Ton. Ohne ihn läuft **jeder** Weg stumm, nicht nur der
  Vulkan-Weg (der Satz stand hier bis 2026-08-02 zu eng).

Patches, Herleitung und Bauanleitung: **`ffmpeg-patches/README.md`**.

**Das Labor linkt deshalb gegen `ffmpeg-patched/`**, nicht gegen das
ausgelieferte `../win-hq-sidecar/ffmpeg-dist/` (s. `.cargo/config.toml`). Beide
Verzeichnisse sind gitignored — Bau-Erzeugnisse.

## Wie das Crate entstanden ist (2026-08-01)

**Was steht und läuft:**

* Das Crate baut (`cargo build --release`) und das Binary antwortet auf dem
  stdio-Protokoll — `health`, `gpu_info`, `list_monitors` gegengeprüft.
* Das WHIP-Modul des Linux-Labors ist portiert (`src/whip/`) — damals 1100
  Zeilen und wörtlich übernommen, **heute weder das eine noch das andere**:
  rund 2150 Zeilen, davon zwei hier entstandene Dateien (`av1_entpacken.rs`
  für den eigenen Zuschauer, `av1_level.rs` für die Level-Berichtigung) und ein
  offener Rückport in `av1.rs` (s. `CLAUDE.md`). Verzahnung waren genau zwei
  Bezüge:
  `crate::encode::request_keyframe` → `crate::keyframe::request_keyframe` und
  `redact_url` → `pulse_win_hq_sidecar::redact::secrets` (dafür wurde die
  Funktion in der Bibliothek von `pub(crate)` auf `pub` gehoben — eine zweite,
  eigene Token-Maskierung wäre die Sorte Doppelung, die irgendwann einen
  Stream-Key ins Log schreibt).
* `src/keyframe.rs` mit Tests: genau ein Vollbild je Anforderung, und der
  Merker bleibt nicht kleben.
* Der Branch hat die **AMD-Zero-Copy- und Latenz-Arbeit gemergt**
  (`perf/win-sidecar-gop`). Ohne sie liefe AV1 auf dieser Karte über die
  CPU-Pipeline mit 113 % einer Kerne — als Grundlage eines Messstands wertlos.
  Drei Doku-Konflikte, alle zugunsten von `main` aufgelöst.

**Der Zero-Copy-Bildweg ist belegt und die Verdrahtung steht** (2026-08-02):

```
WGC (BGRA, D3D11)
  → VideoProcessorBlt        Farbwandlung + Skalierung in einem Durchgang
  → NV12/P010-Textur         geteilt (NTHANDLE|SHARED)
  → vkAllocateMemory(Import) dediziert, an ein VkImage gebunden
  → AVVkFrame                an den Vulkan-Encoder
```

* `examples/probe_d3d11_vulkan_import.rs` führt jeden Schritt einzeln vor —
  für **NV12 und P010**. Messakte:
  `../testbench/profiles/vulkan-2026-08-01-d3d11-import-zerocopy.json`.
* `examples/probe_vulkan_encode_import.rs` geht weiter und prüft den **Inhalt**:
  Muster hinein, durch `av1_vulkan`, wieder heraus.
* `src/vkimport/` ist die Umsetzung (seit dem Ausbau ein Modul-Verzeichnis, kein
  Einzel-File): Import je Pool-Textur (gecacht, nicht je Bild), `AVVkFrame`-
  Spiegel mit Größen-Test, Übergabe in `mit_bild`.
* Teilbare Pool-Texturen holt sich das Labor über `HwPoolConfig { shared: true }`
  (`hwctx.rs`) — kein Umgebungsschalter, der Aufrufer sagt, was er braucht.

**Drei Fallen, die dabei je Stunden gekostet hätten:**

1. `SHARED_NTHANDLE` allein reicht nicht — es braucht `SHARED` dazu.
   **Nicht `KEYEDMUTEX` nehmen**, obwohl das auch geht: ein Keyed-Mutex
   verlangt, dass jeder Zugriff die Sperre nimmt, und an FFmpegs
   Vulkan-Kommandopuffer kommt man nicht heran.
2. Die Import-Allokation muss **dediziert** sein, und der Speichertyp muss zu
   Bild *und* Handle passen.
3. Der Pool muss aus **Einzeltexturen** bestehen. Auf AMD ist er das schon —
   wegen des AMF-Fehlers vom 2026-07-30. Der Fehler von damals macht den Weg
   von heute möglich.

### Stand der Verdrahtung (2026-08-02) — der Bildweg trägt

`examples/probe_vulkan_encode_import.rs` schiebt importierte Bilder durch
`av1_vulkan` und rechnet den Inhalt nach. Ergebnis: **der Verlauf kommt an**,
in beide Richtungen steigend wie vorgegeben, mittlere Abweichung 9,2 von 255
an 16 Stichpunkten. Die Abweichung ist systematisch (dunkel zu dunkel, hell zu
hell) und der Wertebereich, nicht der Bildweg — die Probe schreibt rohe 0-255
hinein, die Videokette rechnet mit 16-235.

**Vier Fehler lagen auf dem Weg dorthin, jeder mit einem irreführenden
Erscheinungsbild:**

* `AVVkFrame.internal` muss belegt sein — FFmpeg sperrt darin einen Mutex
  (`hwcontext_vulkan.c:2955`). Bei NULL: Absturz ohne jede Meldung. Eine
  genullte Allokation genügt, weil FFmpegs `pthread_mutex_t` unter Windows ein
  `SRWLOCK` ist und dessen gültiger Anfangszustand null ist.
* `AVFrame.buf[0]` muss gesetzt sein, sonst lehnt `avcodec_send_frame` mit
  `EINVAL` ab.
* Die Bilder müssen `CONCURRENT` über alle Queue-Familien angelegt sein, wie
  FFmpegs eigene — bei `EXCLUSIVE` sind FFmpegs Barrieren (`queueFamilyIndex =
  IGNORED`) für unser Bild ungültig. Das äußert sich als `VK_ERROR_DEVICE_LOST`
  beim **dritten** Bild, also weit weg von der Ursache.
* Der D3D11-Fence darf **nicht** als Vulkan-Semaphore in den `AVVkFrame`. Der
  Import gelingt, aber FFmpeg kann sie nicht benutzen: schon das erste Bild
  endet in `DEVICE_LOST`, auch ohne Signalisieren (per Halbierung
  nachgewiesen). Stattdessen eine gewöhnliche Zeitleisten-Semaphore **je
  Textur** plus ein kurzes CPU-Warten auf den Fence. Kostet Wartezeit, keine
  Kopie.

Dazu kam ein sporadischer `DEVICE_LOST` bei Bild 2 — etwa einmal in fünf
Läufen. Ursache waren zwei echte Lücken: niemand wartete darauf, dass der
Encoder mit einer Textur fertig ist, bevor D3D11 sie neu beschrieb; und
`layout`/`access` blieben nach dem fremden Schreibzugriff auf dem Wert stehen,
den FFmpeg hinterlassen hatte. Beides steckt jetzt in `mit_bild`, das die
Reihenfolge erzwingt statt sie zu dokumentieren. Danach 15 von 15 Läufen sauber
— **das ist kein Beweis**, nur ein deutlich besserer Ausgangspunkt als vorher.

## Der eigene Sendeweg (2026-08-02) — steht

Eine `http(s)://`-URL geht jetzt über den **eigenen** WebRTC-Sender statt über
den FFmpeg-WHIP-Muxer. Gemessen gegen ein lokales MediaMTX, Messakte
`../testbench/profiles/whip-2026-08-02-windows-eigener-sendeweg.json`:

| | Spuren am Server |
|---|---|
| AV1 ohne Ton | `AV1` |
| AV1 mit Ton | `Opus+AV1` |
| AV1 10 bit mit Ton | `Opus+AV1` |
| H.264 mit Ton | `Opus+H264` |

Die Gegenprobe gehört dazu: FFmpegs eigener WHIP-Muxer **läuft auf dieser
Maschine überhaupt nicht** (`Creating security context failed (0x80090331)` —
Schannel-DTLS). Er ist also nicht nur AV1-untauglich; ein Windows-Nutzer könnte
auf eine WHIP-Instanz heute gar nicht senden.

### Wie die Gabelung gebaut ist, und warum so

Nicht als zweite Encoder-Fassung. Auf Windows gibt es **drei** Encoder-Wege
statt einem wie auf Linux (`encoder_hw.rs`, `encoder_d3d12.rs`, `encoder.rs`),
dazu die Pipeline für Aufnahme, Skalierung und Taktung — zusammen weit über
2000 Zeilen. (Absichtlich keine genauen Zahlen: die Tabelle, die hier zuerst
stand, war schon beim Schreiben veraltet, weil dieselbe Änderung eine der
Dateien um über hundert Zeilen bewegt hat.)

Drei Kopien einer Datei, die je Bild läuft, laufen auseinander; welche Fassung
dann welchen Fehler hat, findet niemand mehr. Also sitzt die Gabelung
**hinter** dem Encoder: der Sidecar bekommt ein schmales Trait
(`encode::senke::PaketSenke`) und einen Anmelde-Punkt, das Labor meldet beim
Start seinen WHIP-Sender an (`src/senke.rs`). Alles bis zum fertigen Paket
bleibt **eine** Implementierung; Pipeline und Encoder sind unverändert geteilt.
Der ausgelieferte Sidecar meldet nichts an und verhält sich Byte für Byte wie
vorher.

Drei Dinge, die dabei nicht offensichtlich sind:

1. **`global_header` ist auf dem eigenen Weg aus.** Ein Container erwartet die
   Parametersätze einmal im Kopf; über RTP müssen sie im Strom mitlaufen, weil
   jeder Zuschauer zu einem beliebigen Zeitpunkt einsteigt. Mit globalem Kopf
   bekäme er nie welche und sähe dauerhaft nichts — ein Fehler, der wie ein
   Netzproblem aussieht.
2. **Kein `rescale_ts` und kein Stream-Index.** Der Sendeweg nimmt die rohen
   Bytes; die Zeitstempel entstehen erst am RTP-Ende. Ein umgerechneter
   Zeitstempel wäre dort nicht nur nutzlos, sondern irreführend.
   **Wer sie setzt, ist inzwischen dreigeteilt** (und das gehört gewusst, bevor
   jemand einen Versatz erklären will): AV1 paketiert das Labor selbst und
   rechnet den Zeitstempel je Bild aus `Bildzahl × 90000/fps` neu (`whip/mod.rs`,
   `Av1Zustand` — aufaddiert liefe er bei krummen Bildraten um rund eine
   Millisekunde je Sekunde davon); H.264 geht über webrtc-rs' Sample-Spur mit
   der Soll-Bilddauer; der Ton über dieselbe Spur mit der Opus-Paketlänge.
   **Alle drei sind Nennwerte, keine Aufnahmezeiten.** Die verankerte
   Aufnahmezeit aus `encode::audio`, an der die ausgelieferte RTMPS-Variante
   hängt, wird auf diesem Weg nicht verwendet — weicht die echte Bildrate von
   der Soll-Bildrate ab oder füllt die Tonaufnahme eine Lücke, laufen Bild- und
   Ton-Uhr auseinander, ohne dass irgendwo ein Fehler auftaucht. Ungemessen
   (s. „Was noch fehlt").
3. **Der Encode-Weg muss zum Ziel passen.** H.264 geht auf AMD regulär über
   D3D12 — und dieser Encoder ist nicht gegabelt. Vor dem Fix liefen seine
   Pakete am angemeldeten Sendeweg vorbei in den ffmpeg-Muxer, der dann still
   an DTLS starb. Jetzt wählt `VideoCodec::encode_path` bei angemeldetem
   Sendeweg den D3D11-Weg, und `open_output` sagt laut ab, falls doch ein
   ungegabelter Weg dort landet.

### Was noch fehlt

Stand 2026-08-02. Zwei Punkte, die hier standen, sind seither erledigt: die
**Sichtprüfung** gibt es (Datei-Bild aus der Mitte plus Browser, AV1 10 Bit vom
Nutzer bestätigt), und über die **echte Leitung** ist der Weg gemessen
(Hetzner-Messstand, Zuschauer-Nachweis und Browser). Offen ist:

* **Der Ton ist gemessen, aber nicht gehört.** Unversehrtheit und Synchronität
  stehen als Zahlen (s.u.); die Hörprüfung durch einen Menschen fehlt weiterhin,
  und sie ist die eine, die keine Zahl ersetzt.
* **H.264 lief dem Ton mit rund 21 ms je Minute davon** (~1,3 s je Stunde), AV1
  nicht. Gefunden am 2026-08-02, Ursache ein abgeschnittener Zeitstempel in
  webrtc-rs, **behoben am 2026-08-03** und gegengeprüft. Der offene Rest steht
  in `CLAUDE.md`, Abschnitt „Der Ton" — darunter der Rückport nach Linux.
* **`encoder_d3d12.rs` und `encoder.rs` sind nicht gegabelt.** Sie sagen jetzt
  klar ab statt still zu muxen. Für AMD ist das folgenlos (H.264 nimmt den
  D3D11-Weg), für Intel heißt es: kein WHIP aus dem Labor.
* **Windows+NVIDIA ist seit dem 2026-08-04 gemessen** — aber nicht von hier
  aus. Der Nachweis dort läuft am **ausgelieferten** Sidecar gegen einen
  Dateimitschnitt (`testbench/nvidia-intra-refresh-nachweis.ps1`), weil NVENC
  weder den Vulkan-Umweg noch ein gepatchtes FFmpeg braucht. Das Labor selbst
  ist auf dieser Karte nie gelaufen; der Weg über den eigenen Sendeweg zum
  dekodierenden Zuschauer ist auf NVIDIA weiterhin offen.

### Der Rückkanal — vollständig gemessen

Die Anforderung eines **Zuschauers** erreicht den Encoder und wird eingelöst.
Drei Läufe, Messakte `../testbench/profiles/rueckkanal-2026-08-02-windows.json`:

| Lauf | Anforderungen am Sender |
|---|---|
| Fork, Takt aus, Zuschauer fordert an | 1 empfangen, 1 Vollbild |
| Fork, Takt aus, Zuschauer sieht nur zu | 0 |
| **Lagerfassung**, Zuschauer fordert an | 7 — aber **alle exakt 60 Bilder auseinander**, also durchweg der Takt |

Der dritte Lauf ist der eigentliche Beleg: bei der Lagerfassung fällt **keine**
Anforderung aus dem Zwei-Sekunden-Raster. Die des Zuschauers stirbt unterwegs
(`outbound_track.go`). Damit ist gemessen statt angenommen, dass Patch 0002
gebraucht wird.

Der Zuschauer dafür ist `examples/whep_messwerk.rs` (Mechanik in
`src/whep.rs`): er empfängt, setzt die AV1-RTP-Pakete zusammen, **dekodiert**
und zählt Bilder — und er kann auf Zuruf eine `PictureLossIndication` schicken
und Verlust selbst erzeugen. Ein Zähler über ankommende Pakete beantwortet die
eigentliche Frage nämlich nicht: Pakete kommen auch dann weiter an, wenn das
Bild seit zehn Sekunden steht.

Zwei weitere Dinge sind es wert, hier zu stehen:

* **`{"op":"keyframe"}` löst ein Vollbild von Hand aus.** Damit ist die
  Wirkung messbar, ohne dass Zuschauer, Verlustprofil und MediaMTX-Patch
  zusammenkommen müssen — der weitere Bau steht auf einer Zahl statt auf einer
  Erwartung. Gleiche Idee wie im Linux-Labor.
* **`forced_idr=1` ist Pflicht, und das war ein echter Fehler.** Ohne die
  Option macht FFmpeg aus `pict_type = I` bei AV1 ein *Intra-Only*-Bild statt
  eines Keyframes: vollständig intra-kodiert, aber ohne Sequenzkopf, also für
  einen neu einsteigenden Zuschauer wertlos. Der Sender meldete beide
  Anforderungen als angenommen — in der Datei stand trotzdem nur der reguläre
  Takt. **Aufgefallen ist das nur, weil die Messung die Datei gelesen hat statt
  dem Log zu glauben.**

Wer hier Intra-Refresh misst, muss außerdem den Zwei-Sekunden-Takt der
Lagerfassung abschalten (`PULSE_KEYFRAME_INTERVAL=0` im Fork) — sonst misst er
ihn mit, und er setzt genau die Bild-Stöße zurück, gegen die Intra-Refresh
antritt.

### Messen ohne in die Fallen zu laufen

* **stdin offen halten.** Kommt die Anfrage aus einer Datei, sieht der Sidecar
  nach der letzten Zeile EOF und fährt korrekt herunter — mitten im
  ICE-Aufbau. Von außen sieht das wie ein Netzproblem aus (der Server meldet
  `deadline exceeded while waiting connection`) und hat hier eine Stunde
  gekostet.
* **stderr am Ende in einem Stück lesen.** `Register-ObjectEvent` in
  PowerShell hat Zeilen verschluckt — sechs kamen an, der Rest nicht, und
  ausgerechnet die fehlenden waren die, die den Rückkanal belegen. Eine erste
  Messung meldete deshalb „null Anforderungen empfangen", obwohl es sieben
  waren.
* **`PULSE_WHIP_LOOPBACK=1`** für einen Server auf derselben Maschine. Ohne
  das läuft ICE über die LAN-Adresse und damit durch die Windows-Firewall, die
  für ein frisch gebautes Binary ohne Zutun eines Menschen eine Block-Regel
  anlegt.
* **`PULSE_HQ_LOG=whip=debug,info`** zeigt Kandidaten, Antwort und die
  ICE-/Verbindungszustände. Ohne den Empfänger aus `logging.rs` ist das Labor
  stumm — `tracing` ohne Empfänger verschluckt alles, ohne Warnung beim Bauen.
