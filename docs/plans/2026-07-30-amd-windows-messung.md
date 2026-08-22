# AMD auf Windows — Schritt 3, gemessen (2026-07-30)

Fortsetzung von `2026-07-30-windows-sidecar-latenz-check.md`. Dort endete die
Arbeit mit „Schritt 3 braucht eine Windows-Maschine mit AMD-Karte". Die gab es
jetzt.

**Maschine:** AMD Radeon 780M (RDNA3-iGPU, VCN 4.0) in einem Ryzen 7 PRO 8845HS,
Treiber 32.0.31035.1003 (Juli 2026), Windows 11 26200, mitgeliefertes FFmpeg
n8.1.1. Ein Bildschirm, 2560x1440.

**Alles unten ist gemessen.** Wo etwas nicht gemessen werden konnte, steht das
dabei. Die zwei Messreihen:

- **Encoder-Ebene** — 25 Konfigurationen über `ffmpeg.exe` gegen einen
  verlustfreien 12-s-Referenzclip (1920x1080@60, Bildschirminhalt: scrollender
  Monospace-Text, flächige UI, schnelle Kästen, ein bewegtes Videofenster).
  Eingang auf Echtzeit gedrosselt, damit die GPU-Zahl die *Kosten* eines
  laufenden Streams misst und nicht, wie schnell der Encoder eine Warteschlange
  leerräumt. Qualität als VMAF + SSIM + PSNR gegen dieselbe Referenz.
- **Sidecar-Ebene** — der echte Pfad (WGC-Capture → Convert → Encode → Mux) mit
  `PULSE_ENC_LATENCY_LOG=1`, 1440p-Capture auf 1080p60 herunterskaliert,
  Desktop-Ton an, während das Referenzvideo im Vollbild lief (auf einem
  stehenden Bildschirm dupliziert der Pacing-Loop nur und jede Zahl wäre
  geschönt).

---

## Die Kurzfassung

1. **Vereinheitlichung auf komplett D3D12 geht nicht.** `av1_d3d12va` erzeugt
   auf dieser Hardware einen Bitstrom, den kein Decoder liest.
2. **Der größte Posten war nicht der Encoder, sondern der Pfad.** AV1 lief auf
   AMD über die CPU-Pipeline und kostete **113 % einer CPU-Kerne** samt 42
   übersprungenen Bildern in 20 s — und AV1 ist auf AMD der *Vorgabe*-Codec.
3. **`async_depth` auf dem d3d12va-Zweig ist ein geschenkter Bildabstand:**
   19,2 → 7,1 ms bei byte-identischem Bitstrom.
4. **`usage=transcoding` war der teuerste Schalter im AMF-Zweig:**
   Video-Engine-Last 23,9 % → 9,4 % bei unveränderter Bildqualität.

---

## 1. AV1 über D3D12 ist auf AMD unbrauchbar

Zwei getrennte Hindernisse, beide gemessen.

### 1a. Der Encoder öffnet nur bei 64x16-Ausrichtung

`av1_d3d12va` scheitert bei 1920x1080 schon vor dem ersten Bild mit
`Failed to create encoder heap`. Bei 1920x1088 läuft er. Die Regel ist scharf:

> **Breite % 64 == 0 und Höhe % 16 == 0.**

21 Auflösungen geprüft; die Regel sagt jede korrekt vorher (7 davon als reine
Vorhersage vor der Messung formuliert, 7/7 getroffen). Beispiele:

| Auflösung | B%64 | H%16 | |
|---|---|---|---|
| 1920x1080 | 0 | 8 | scheitert |
| 1920x1088 | 0 | 0 | läuft |
| 1904x1088 | 48 | 0 | scheitert |
| 3440x1440 | 48 | 0 | scheitert |
| 2560x1440 | 0 | 0 | läuft |

Das ist exakt AMDs `align=64x16` — die Option, die `av1_amf` besitzt und
intern selbst anwendet, weshalb `av1_amf` bei 1920x1080 anstandslos läuft.

### 1b. Wo er öffnet, ist der Bitstrom kaputt

Bei ausgerichteter Größe encodiert er — und **drei unabhängige Decoder lehnen
das Ergebnis ab**:

| Decoder | Meldung |
|---|---|
| dav1d | `Error parsing frame header` |
| libaom | `Corrupt frame detected` / `Failed to decode tile data` |
| FFmpeg nativ | kein Bild |

Schon der Keyframe ist unlesbar; bei 720p wie bei 1088p; in rohem OBU wie in
IVF. Es ist **kein** Muxer- und kein extradata-Problem: die OBU-Struktur ist
gültig (TD → SEQUENCE_HEADER → FRAME_HEADER + TILE_GROUP), und der
Sequence-Header parst von Hand sauber auf 1920x1088, 8 bit, 4:2:0. Es sind die
Bilddaten selbst.

**Gegenprobe:** `h264_d3d12va` und `hevc_d3d12va` — dieselbe Encoder-Familie,
derselbe Weg, dieselbe Hardware — dekodieren mit **null** Fehlern.

**Reichweite dieser Aussage:** eine GPU, ein Treiber, ein FFmpeg-Build. Ob es
am AMD-Treiber oder an FFmpegs `d3d12va_encode_av1` liegt, ist von hier aus
nicht zu unterscheiden. Für die Entscheidung reicht es: der Pfad ist auf der
Hardware, die wir haben, nicht benutzbar.

---

## 2. Der Pfad war teurer als jede Encoder-Einstellung

AV1 landete deshalb auf der CPU-Pipeline (`pipeline_d3d12.rs` gab an
`run_cpu_pipeline` ab). Und AV1 ist auf AMD **die Vorgabe**: `codec_probe.rs`
meldet für AMD hart `["h264","hevc","av1"]`, und
`web/src/lib/stream/settings.svelte.ts:345` setzt bei AV1-fähiger GPU
`defaults.codec = 'av1'`. Der Standard-HQ-Stream lief also über den teuersten
Weg im ganzen Sidecar.

Sidecar-Messung, 1440p-Capture → 1080p60, 4000 kbps:

| | Encode-Latenz | CPU (% einer Kerne) | GPU-Video | übersprungene Bilder / 20 s |
|---|---|---|---|---|
| H.264 (D3D12-Zero-Copy) | 19,2 ms | 13 % | 25,3 % | 3 |
| **AV1 (CPU-Pipeline)** | 19,9 ms | **113 %** | 22,1 % | **42** |

Die Ursache steht in der Tick-Diagnose: `conv` — der CPU-swscale BGRA→NV12 mit
Downscale — brauchte **8,9 bis 19,3 ms pro Tick** bei einem Budget von 16,7 ms.
Der Zero-Copy-Pfad liegt bei 1,5–5,4 ms. Der Loop kam schlicht nicht mit.

Encoder-Optionen ändern daran **nichts**: `async_depth=1`,
`usage=ultralowlatency` und `latency=lowest_latency` ergaben auf diesem Pfad
alle 19,9 ± 0,1 ms und 108–114 % CPU. Wer hier an Encoder-Schrauben dreht,
misst am Problem vorbei.

### Der Umweg, der nicht funktioniert hat — und warum er trotzdem hier steht

**Zurückgenommen.** Der folgende Abschnitt beschreibt einen Umbau, der auf allen
gemessenen Achsen gewann und trotzdem falsch war. Er bleibt stehen, weil der
Fehler lehrreicher ist als das Ergebnis.

`av1_amf` nimmt D3D11-BGRA-Frames an — dasselbe Format, das `pipeline_hw` für
NVENC baut. AV1 dort hindurchzuleiten senkte die CPU-Last von 113 % auf 9 %
einer Kerne und die übersprungenen Bilder von 42 auf 2. Encode-Latenz, GPU-Last,
Bitratentreue, Decodierbarkeit: alles besser oder gleich. Der Strom war formal
einwandfrei — gültige OBU-Struktur, ein Temporal Delimiter pro Bild, kein
Padding, null Decode-Fehler.

**Und das Bild war zerrissen.** Doppelte, gegeneinander versetzte Kopien,
verschmierter Text, in Streifen zerlegte Farbflächen. Bei 1440p nativ ebenso wie
bei 1080p mit Scaler — die Zwischenkopie des Scalers maskiert es nicht. Über den
CPU-Pfad ist dasselbe Material bei denselben Einstellungen tadellos. AMF
synchronisiert offenbar nicht gegen den Capture-Schreiber, anders als NVENC über
denselben Pool.

Aufgefallen ist es erst im Produktionstest, durch den Nutzer. **Nicht durch die
Messung** — denn gemessen wurde Latenz, CPU, GPU, Frame-Gaps, Bitrate und
Decodierbarkeit, und all das sah hervorragend aus. Es wurde nur nie jemand ein
Standbild angesehen.

> **Regel daraus: Bei jedem Eingriff in einen Bildweg gehört eine Sichtprüfung
> dazu.** Ein Encoder kann formal korrekte, fehlerfrei dekodierbare Bilder mit
> falschem Inhalt liefern — kein Zähler dieser Messreihe hätte das je bemerkt.

Der Weg bleibt über `PULSE_HQ_AMD_D3D11=1` erreichbar, damit die Ursache
(Synchronisation zwischen Capture-Schreiber und AMF) später untersucht werden
kann. Als Vorgabe ist er raus.

### Was stattdessen gilt

`av1_amf` nimmt **D3D11-BGRA-Surfaces** entgegen — genau das Format, das
`pipeline_hw` für NVENC ohnehin baut. Geprüft: öffnet, encodiert, sauber
dekodierbar, kein Crash.

AV1 bleibt auf dem CPU-Pfad — mit allen Kosten, die Abschnitt 2 nennt (113 %
einer CPU-Kerne, 42 übersprungene Bilder in 20 s). Das ist unbefriedigend, aber
es ist der einzige Weg, der auf dieser Hardware ein **korrektes Bild** liefert:

| AV1 auf AMD | Bild | CPU |
|---|---|---|
| CPU-Pipeline (`av1_amf`, Software-NV12) | **korrekt** | 113 % |
| D3D11-Zero-Copy (`av1_amf`, D3D11-BGRA) | **zerrissen** | 9 % |
| D3D12 (`av1_d3d12va`) | **gar nicht dekodierbar** | — |

Wer AV1 auf AMD billiger machen will, muss an der Synchronisation zwischen
Capture-Schreiber und AMF ansetzen — nicht an Encoder-Optionen.

**Was das für die Codec-Wahl heißt:** H.264 über d3d12va ist auf AMD derzeit der
einzige Weg, der zugleich zero-copy, latenzarm und bildkorrekt ist (6,8 ms,
13 % CPU). Dass AV1 die Vorgabe auf AMD ist (`codec_probe.rs` + Frontend), ist
damit fragwürdig — solange AV1 nur über die CPU-Pipeline korrekt läuft, zahlt
der Nutzer dafür eine volle CPU-Kerne.

### Was mit AMF-Issue #455 ist

Der ganze D3D12-Pfad existiert, weil `h264_amf` auf D3D11-Surface-Eingang mit
einer Integer-Division durch Null abstürzte. **Auf dieser Maschine ist der
Crash nicht reproduzierbar** — `h264_amf` läuft mit D3D11-NV12 *und* mit
D3D11-BGRA sauber durch (`AMF initialisation succeeded via D3D11`).

Trotzdem bleibt AMD-H.264 auf dem D3D12-Pfad. Ein Rechner ist kein Beleg, und
dort funktioniert es. Bei AV1 ist die Abwägung eine andere, weil die
Alternative nachweislich schlechter ist.

---

## 3. `async_depth` auf dem d3d12va-Zweig

Sidecar, H.264, 1080p60:

| `async_depth` | Encode-Latenz | Maximum |
|---|---|---|
| 1 | **7,1 ms** | 11,2 ms |
| 2 (bisheriger Default) | 19,2 ms | 25,4 ms |
| 4 | 52,4 ms | 59,2 ms |

Rund ein Bildabstand je Stufe (16,7 ms bei 60 fps) — dieselbe Arithmetik, die
der Linux-Zweig bei VAAPI gemessen hat.

**Und es kostet nichts.** Das ist nicht geschätzt: die Bitströme für 1, 2 und 4
sind **byte-identisch** (SHA-256 über 720 Bilder, für H.264 wie für AV1).
`async_depth` verschiebt nur, wann ein fertiges Paket herausgegeben wird. Damit
braucht es für diese Änderung kein Qualitätsargument — die
Byte-Identitätsprobe *ist* das Argument.

---

## 4. `usage` ist der GPU-Hebel im AMF-Zweig

`usage` ist bei AMF kein Etikett, sondern ein Bündel. `transcoding` (= „Generic
Transcoding", der Offline-Fall) stand dort, seit der Zweig existiert.

| | GPU-Video | VMAF |
|---|---|---|
| AV1 `usage=transcoding` | 23,9 % | 82,85 |
| **AV1 `usage=ultralowlatency`** | **9,4 %** | **82,86** |
| H.264 `usage=transcoding` | 26,6 % | 82,00 |
| H.264 `usage=ultralowlatency` | 10,3 % | 81,60 |

Bei AV1 — dem Codec, der über diesen Zweig läuft — **kostet der Wechsel nichts
an Bildqualität und drittelt die Last der Video-Engine**. Im laufenden Sidecar
bestätigt: 22,1 % → 9,8 %.

Zwei Nebenbefunde:

- `usage=lowlatency` (ohne „ultra") bringt **nichts**: 27,2 %, praktisch der
  Ausgangswert.
- Unter `ultralowlatency` ist `quality` **wirkungslos** — `balanced` und `speed`
  lieferten byte-identische Bitströme.
- `async_depth` bewirkt auf `av1_amf` **nichts** (1 wie 16: 17,2 ms). Anders als
  auf dem d3d12va-Zweig. Der Wert bleibt gesetzt, aber ohne behaupteten Gewinn.

---

## 5. Was die Qualitätsmessung sonst noch ergeben hat

Alles bei 1080p60, 4000 kbps CBR, Bildschirminhalt.

| Encoder | VMAF | SSIM | GPU-Video |
|---|---|---|---|
| **AV1 (`av1_amf`, ultralowlatency)** | **82,86** | 0,99117 | **9,4 %** |
| HEVC (`hevc_d3d12va`) | 82,14 | 0,99113 | 24,7 % |
| H.264 (`h264_d3d12va`) | 82,00 | 0,99122 | 25,3 % |
| H.264 (`h264_amf`, ultralowlatency) | 81,60 | 0,99120 | 10,3 % |

**AV1 gewinnt auf allen vier Achsen, nach denen gefragt war** — beste
Bildqualität, niedrigste GPU-Last, niedrigste CPU-Last. Der Preis sind rund
10 ms mehr Encode-Latenz (17,2 gegen 6,9 ms bei H.264 mit `async_depth=1`).

Weitere Befunde:

- **`h264_d3d12va` und `h264_amf` sind pixelgleich.** PSNR zwischen den beiden
  dekodierten Ausgaben: **inf** — bit-exakt identisch. Es ist dieselbe
  VCN-Engine über zwei APIs. *Die API-Wahl auf AMD ist keine Qualitätsfrage*,
  nur eine von Latenz, CPU und Robustheit. (Kontrollwert: gegen die
  cavlc-Variante liefert derselbe Vergleich 47,7 dB — er ist trennscharf.)
- `rc_mode=QVBR` hält die Bitrate nicht (4323 statt 4000 kbps) und ist damit
  für einen Stream mit festem Uplink-Budget ungeeignet.
- `coder=cavlc` (−0,39 VMAF) und `me_precision=half_pixel` (−0,15 VMAF) kosten
  Qualität ohne messbaren Gegenwert. Nicht setzen.
- `av1_amf` signalisiert bei 1080p-Eingang eine Höhe von **1082** statt 1080 —
  eine Eigenart der AMF-internen Ausrichtung, die den AV1-Pfad schon vorher
  betraf und von diesen Änderungen unberührt bleibt.

  **Nachtrag 2026-08-22:** hier stand „kosmetisch (0,18 % Seitenverhältnis),
  aber unsauber". Das Seitenverhältnis ist tatsächlich harmlos, die beiden
  Zusatzzeilen sind es nicht: sie sind hartes Schwarz, und weil der Player die
  Zeigerlage als Anteil am Videobild rechnet, zielt die **Fernsteuerung**
  dadurch systematisch bis zu 2 Pixel zu hoch. Vollständige Messung samt Regel
  (`h % 16 == 8` → `h + 2`), Vergleich mit `h264_amf`/`hevc_amf` und den drei
  erfolglos durchprobierten `-align`-Werten: `streaming/win-hq-sidecar/README.md`,
  Abschnitt „AV1 auf AMD meldet 1082 statt 1080 Zeilen".

---

## Was geändert wurde

| Datei | Änderung |
|---|---|
| `encode/encoder.rs` | neu: `EncodePath` + `VideoCodec::encode_path(vendor)` — die Pfadregel steht ab jetzt an genau einer Stelle |
| `stream_controller.rs` | Dispatch über `encode_path`; neu `StartParams::codec()` (stand vorher viermal wörtlich da) |
| `pipeline_hw.rs` | nimmt jetzt auch AMD+AV1; AMD-Rückfall gibt an `pipeline_d3d12` ab statt `h264_amf` über D3D11 zu öffnen |
| `pipeline_d3d12.rs` | `run` nimmt den Codec als Parameter; AV1-Begründung auf den Messstand gebracht |
| `encode/encoder_d3d12.rs` | `async_depth=1` |
| `encode/opts.rs` | AMD: `usage=ultralowlatency`, `async_depth=1` |

Alle Zahlen stehen als Begründung am jeweiligen Wert im Quelltext, nicht nur
hier.

---

## 6. Kann einer der beiden AMD-Pfade weg?

Naheliegende Frage, nachdem `h264_amf` hier auch über D3D11 läuft: dann wäre der
ganze D3D12-Zweig — `wgc_d3d12.rs` (508 Z.), `d3d12_convert.rs` (422),
`encoder_d3d12.rs` (498), `extradata.rs` (80), `pipeline_d3d12.rs` (337), zusammen
rund **1800 Zeilen** mit handgeschriebenem Compute-Shader, Shared-NT-Handle-Brücke
und der verzögerten `write_header`-Notlösung — vielleicht entbehrlich.

Dafür gebaut: `PULSE_HQ_AMD_D3D11=1` schickt AMD mit jedem Codec über D3D11.
Gemessen, 1440p → 1080p60, 4000 kbps:

| H.264 über | Encode-Latenz | CPU | GPU-Video | GPU-3D |
|---|---|---|---|---|
| D3D12 (`h264_d3d12va`) | **6,8 ms** | 13,0 % | 25,4 % | 10,2 % |
| D3D11 (`h264_amf`) | 17,2 ms | 10,5 % | **10,5 %** | 13,4 % |

> **Nachtrag — die D3D11-Zeile war zum Zeitpunkt dieser Messung wertlos.** Der
> Lauf entstand mit dem Array-Pool, sein Bild war zerrissen (Abschnitt 9), und
> bewertet wurde er nur an Zahlen. Ein zerrissenes Bild kostet natürlich weniger
> Video-Engine — es ist ja weniger echter Inhalt drin. Die Zahlen sind erst nach
> dem Einzeltextur-Fix wieder vergleichbar und **in dieser Form nicht
> nachgemessen**. Der Vergleich unten steht deshalb unter Vorbehalt; die
> Aussagen zu D3D12 (6,8 ms, eigener Pfad, kein Bildvorlauf) sind davon
> unberührt.

**Antwort: nein, keiner von beiden.** D3D12 ist um das Zweieinhalbfache
latenzärmer, AMF belastet die Video-Engine um das Zweieinhalbfache weniger.
Jeder Zweig kann etwas, das der andere nicht kann:

- **D3D12 hält kein Bild zurück.** Die 17,2 ms von AMF sind exakt dieselben, die
  `av1_amf` liefert, und sie bewegten sich unter keiner Option (`async_depth` 1
  wie 16, `latency`, `preanalysis`). AMF hält ein Bild — codec-unabhängig.
- **AMF hat `usage`.** `h264_d3d12va` kennt den Schalter gar nicht und lässt sich
  deshalb nicht sparsam stellen; er liegt fest bei ~25 %.
- **Und AV1 geht nur über AMF** (Abschnitt 1).

Damit ist die heutige Aufteilung nicht nur historisch, sondern begründet:
**H.264 — der Kompatibilitätscodec — über D3D12 mit der niedrigen Latenz, AV1 —
der Effizienzcodec — über AMF mit der niedrigen GPU-Last.** Jeder Codec nimmt
den Weg, der für ihn der bessere ist.

Nebenbei fällt eine Kombination heraus: **H.264 über AMF ist strikt unterlegen** —
es erbt AMFs 17,2 ms *und* liefert schlechtere Bildqualität als AV1 bei
ähnlicher GPU-Last (VMAF 81,60 gegen 82,86 bei 10,5 % gegen 9,5 %). Als
Vorgabeweg gibt es dafür keinen Grund; als Notausgang bleibt er über den
Schalter erreichbar.

## 7. Lässt sich AMFs zurückgehaltenes Bild umgehen?

Kurz: **nicht wegmachen — aber verkleinern.**

### Was es nicht ist

Der naheliegende Verdacht war, dass wir zu früh aufgeben. Der Ablauf ist:
`avcodec_send_frame` → einmal `receive_packet` → EAGAIN → fertig. Ist der
Encoder in dem Moment noch nicht so weit, sehen wir das Paket erst beim
nächsten Tick — und der kommt einen ganzen Bildabstand später. Dann wäre die
Latenz eine Folge unserer Abholstrategie, nicht des Encoders.

Geprüft mit einem Drain, der bis zu **12 ms** lang alle 250 µs gezielt nach dem
Paket zum *gerade eingeschobenen* Bild fragt (die Unterscheidung ist wichtig:
dass irgendein Paket kommt, sagt nichts — es ist in der Regel das vorherige
Bild):

| | Encode-Latenz |
|---|---|
| ohne Budget | 17,23 ms |
| mit 12 ms Budget | **17,21 ms** |

Das Paket ist wirklich nicht da. FFmpegs AMF-Zweig gibt es erst heraus, wenn
das nächste Bild eingeschoben wird. Der Versuchscode ist wieder entfernt, der
Befund steht als Warnung am `drain_video`-Doc in `encoder_hw.rs` — damit ihn
niemand ein zweites Mal unternimmt.

### Was es auch nicht ist

Ohne Wirkung auf die 17,2 ms, jeweils gemessen und ohne Unbekannt-Warnung
(die Optionen kamen also an):

`async_depth` (1 wie 16) · `latency=lowest_latency` · `usage=lowlatency` ·
`usage=lowlatency_high_quality` · `bf=0` · `max_b_frames=0` · `preencode=0` ·
`preanalysis=0` · `pa_lookahead_buffer_depth=0`

### Was es ist — und was daraus folgt

Es ist **exakt ein Bildabstand**, kein fester Zeitwert:

| Bildrate | Bildabstand | `av1_amf` gemessen | Verhältnis |
|---|---|---|---|
| 30 fps | 33,3 ms | 34,0 ms | 1,02× |
| 60 fps | 16,7 ms | 17,2 ms | 1,03× |
| 120 fps | 8,3 ms | 8,9 ms | 1,07× |

Der Encoder selbst braucht also rund **0,5 ms**; alles andere ist Warten auf
das nächste Einschieben. Damit gibt es einen echten Hebel, auch wenn der
Vorlauf bleibt: **die Bildrate.** Bei 120 fps kostet AV1 noch 8,9 ms — halb so
viel wie bei 60, und nahe an H.264 bei 60 fps (6,8 ms). Der Preis ist moderat:
CPU 1,4 → 2,6 s auf 15 s, also rund 17 % einer Kerne statt 9 %.

Zum Vergleich derselbe Sprung auf dem d3d12va-Zweig: H.264 geht von 6,8 auf
**4,8 ms**. Der profitiert weniger, weil er gar nicht auf das nächste Bild
wartet — er ist schlicht schneller fertig.

**Der einzige verbliebene Weg, den Vorlauf wirklich loszuwerden**, wäre AMF
direkt anzusprechen statt über FFmpeg (`SubmitInput`/`QueryOutput` in einer
eigenen Schleife). Das ist ein eigenes Vorhaben und hier nicht bewertet.

## 8. AV1 durch MediaMTX — was der Empfänger daraus macht

Alle Zahlen oben messen den *Erzeuger*. Der Empfänger war ungetestet, weil die
Messungen in FLV-Dateien schrieben. Nachgeholt mit lokalem MediaMTX.

### Der Reinfall: die lokale Testinstallation ist nicht die produktive

`scripts/fetch-mediamtx.ps1` pinnte **1.18.1**, Dev-Compose und Produktion
fahren aber **1.19.1-pulse**. Auf 1.18.1 lehnt MediaMTX jeden AV1-Strom rundweg
ab:

```
[HLS] muxer error: unable to parse AV1 sequence header: not enough bytes
```

Das sah zunächst nach einem Fehler in unserem Encoder-Pfad aus. Ist es nicht —
es reproduziert sich mit

- unserem Sidecar (`av1_amf`),
- dem puren `ffmpeg`-CLI mit `av1_amf`,
- und **`libsvtav1`**, einem reinen Software-Encoder.

Drei verschiedene Erzeuger, derselbe Fehler: es liegt an 1.18.1, nicht an AMD
und nicht an uns. **Auf 1.19.1 verschwindet die Ablehnung.** Der Pin ist
nachgezogen — sonst hält hier irgendwann wieder jemand einen funktionierenden
Encoder für kaputt.

Der Vollständigkeit halber, weil es beim Suchen viel Zeit gekostet hat: der
Sequence-Start-Tag im FLV **ist vorhanden** (Video-Tag bei Position 309, 24
Byte = 1 Byte Kopf + 4 Byte fourCC + 19 Byte `av1C`), und der eingebettete
Sequence-Header parst bitgenau durch bis zum Trailing-Bit. Er ist gültig.

### Gegen den echten Produktions-Fork geprüft: AV1 läuft sauber durch

Nicht bei stock 1.19.1 stehengeblieben, sondern den Fork lokal gebaut — genau
nach dem Rezept aus `infra/mediamtx-fork/Dockerfile`: v1.19.1 geklont,
`0001-rtmp-inject-temporal-delimiter.patch` angewandt (mit GNU `patch`;
`git apply` weist ihn wegen einer Kontext-Leerzeile ohne führendes Leerzeichen
als „corrupt" ab — deshalb nutzt auch das Dockerfile `patch`), beide Generatoren,
dann `go build` mit denselben Flags.

Ergebnis: **AV1 geht durch.** Aus dem laufenden Stream über HLS gezogen und
offline dekodiert — 9,985 s, **554 Bilder, 0 Decode-Fehler**, AV1 + Opus.

### Eine Zwischenmessung war falsch, und das gehört hierher

Vorher stand hier, AV1 scheitere auch auf 1.19.1 mit 218 Decode-Fehlern gegen 0
bei H.264. **Das war ein Messfehler.** Der Abgriff lief mit
`-live_start_index -3`, also am Rand der Playlist, wo unvollständige Segmente
liegen; H.264 steckt das weg, AV1 nicht. Sichert man dieselben Segmente erst in
eine Datei und dekodiert die, sind es null Fehler — bei beiden Codecs.

Die Lehre ist dieselbe wie beim Versions-Pin: **der Messaufbau war kaputt, nicht
das Gemessene.** Zweimal hintereinander sah ein funktionierender Encoder wie ein
defekter aus. Wer hier weitermisst, prüfe zuerst die eigene Kette gegen H.264 —
das ist der Kontrollwert, der beide Male den Fehler aufgedeckt hat.

### Was weiterhin offen ist

**WHEP ist ungetestet.** Zuschauer holen den Stream per WebRTC, und das ist in
MediaMTX anderer Code als der HLS-Muxer. Der saubere HLS-Durchlauf durch den
Produktions-Fork ist ein gutes Zeichen, aber kein Beweis. Diese Prüfung braucht
einen Browser.

### Abgrenzung zum bekannten AMD-AV1-Freeze

`infra/mediamtx-fork/` dokumentiert einen **anderen** Fall: Mesas `av1_vaapi` auf
**Linux** liefert keine `OBU_TEMPORAL_DELIMITER` und riesige `OBU_PADDING`; der
Fork normalisiert beides in `OnDataAV1`. Der Windows-Strom aus `av1_amf` **hat**
Temporal Delimiter (im OBU-Lauf geprüft) und keine Padding-OBUs — er fällt also
gar nicht unter diesen Fall, und der Patch greift bei ihm ins Leere. Das ist
kein Widerspruch, sondern erklärt, warum er hier weder hilft noch schadet.

## 9. Zwei Versuche, AV1 auf AMD/Windows zero-copy zu bekommen — beide gescheitert

### Versuch 1: neueres FFmpeg für `av1_d3d12va`

Der Verdacht war, dass `av1_d3d12va` schlicht fehlerhaft implementiert ist und
upstream inzwischen gefixt wurde. Geprüft gegen den **FFmpeg-Nightly vom
2026-07-30** (N-125856-g2ae2413488):

| | 1920x1088 | 1920x1080 |
|---|---|---|
| n8.1.1 (gepinnt) | Encode ok, 140 Decode-Fehler | Encoder-Heap scheitert |
| Nightly | Encode ok, **141 Decode-Fehler** | Encoder-Heap scheitert |

Unverändert. Der aufschlussreiche Teil: **FFmpegs eigener Parser kommt sauber
durch** — `trace_headers` liest alle Frame-Header und meldet nichts. dav1d und
libaom lehnen exakt dieselben Header ab. Das ist kein Zufall, denn
`d3d12va_encode_av1.c` schreibt über `cbs_av1` und `trace_headers` liest mit
derselben `cbs_av1`; Schreiber und Leser sind dieselbe Implementierung. Worauf
sie sich einigen, ist für unabhängige Decoder ungültig.

Der Fehler sitzt also darin, **womit** `d3d12va_encode_av1` den Frame-Header
befüllt — Verdacht auf die Kachel-Information (`tile_cols_log2 = 0`, während die
Tile-Daten vom Treiber kommen; libaoms Meldung lautet „Failed to decode tile
data"). Material für eine Upstream-Meldung ist damit beisammen: Repro auf RDNA3,
drei Decoder, `h264_d3d12va`/`hevc_d3d12va` als Gegenprobe auf derselben
Hardware, plus die fehlende 64x16-Behandlung.

### Versuch 2: CPU-Fence hinter dem Capture-Copy

`wgc_hw.rs::copy_into_pool` reiht `CopySubresourceRegion` nur ein und wartet
nicht — anders als `wgc_d3d12.rs`, das ausdrücklich per Fence auf die
Fertigstellung wartet. Naheliegende Erklärung für das zerrissene Bild: AMF liest
die Textur, bevor die Kopie durch ist.

**War es nicht.** Fence eingebaut (Signal → Flush → `SetEventOnCompletion` →
warten), gegen die Variante ohne Fence gemessen: das Bild bleibt zerrissen,
unverändert. Der Fence ist wieder entfernt — er behob nichts und hätte sonst
ungetestet in NVIDIAs Hot-Path gehangen.

### Was danach als Erklärung übrig bleibt

Eine Hypothese, gestützt aber ungeprüft: **AMF beachtet den
Subresource-Index des D3D11-Texture-Arrays nicht.** FFmpegs D3D11VA-Pool ist
EIN `ID3D11Texture2D` mit `ArraySize = pool_size`; die Frames unterscheiden sich
nur im Index. AMFs FFmpeg-Anbindung erzeugt ihre Surface aus einer nativen
DX11-Textur — wenn dabei der Index verlorengeht, liest der Encoder immer dieselbe
Scheibe, während der Capture-Thread reihum alle beschreibt. Das erzeugt genau
das beobachtete Bild: Inhalte verschiedener Frames übereinander.

Dazu passt die Gegenprobe aus dem eigenen Haus: der **D3D12-Zweig legt pro
Ring-Slot eine EIGENE Textur an** (`wgc_d3d12.rs`, Shared-NT-Handles), kein
Array — und der läuft auf derselben Hardware mit `h264_d3d12va` einwandfrei.

Wer das weiterverfolgt, prüfe zuerst diese Hypothese, bevor er wieder an
Synchronisation denkt.

## Nachtrag (2026-07-30, später): Ursache gefunden — der Texture-Array-Pool

Die Hypothese aus Abschnitt 9 hat sich bestätigt, mit einer Präzisierung: es ist
nicht FFmpeg, das den Index verliert — `amfenc.c` übergibt ihn korrekt per
`SetPrivateData(AMFTextureArrayIndexGUID)` vor `CreateSurfaceFromDX11Native`.
**Die AMF-Runtime dieses Treibers liest aus dem D3D11-Texture-Array trotzdem
falsch.** Belege:

- **`h264_amf` über D3D11 war ebenso zerrissen** wie `av1_amf` — das Standbild
  aus `sc_cmp_h264_d3d11.flv` wurde für Abschnitt 6 nie angesehen (nur Latenz
  gemessen; dieselbe Falle wie beim ersten Mal). Der Fehler ist also
  codec-unabhängig und liegt im gemeinsamen D3D11-Submissionspfad.
- **Die CLI-Probe F2 (VMAF 82,1, sauber) lief über Einzeltexturen**, ohne dass
  das damals jemand wusste: `hwupload` ohne `extra_hw_frames` lässt
  `initial_pool_size = 0`, und dann legt libavutil je Frame eine eigene
  `ID3D11Texture2D` an (`d3d11va_alloc_single`) statt EINES Arrays.
- **A/B auf demselben Build** (Sidecar, 1440p nativ, `av1_amf`):
  Array-Pool → zerrissen (`f_arrayctl.png`), Einzeltextur-Pool → sauber
  (`f_singletex.png`). Ebenso sauber: 1080p über den Scaler-Pool
  (`f_st1080.png`) und `h264_amf` (`f_sth264.png`).

**Fix:** `hwctx.rs::HwContext::new` setzt `initial_pool_size = 0`, wenn das
Device an einer AMD-GPU hängt (NVIDIA bleibt auf dem erprobten Array;
Messschalter `PULSE_HQ_D3D11_SINGLE_TEX=1|0` übersteuert beides). Der
AVBufferPool recycelt die Einzeltexturen, die Allokation wächst nur bis zur
Arbeitsmenge. `encode_path` schickt AMD+AV1 damit wieder über D3D11 — jetzt
per Standbild belegt statt nur per Zähler:

| AV1 auf AMD, 1440p nativ, 20 s | Bild | Encode-Latenz | CPU |
|---|---|---|---|
| CPU-Pipeline (alter Default) | korrekt | 19,9 ms | 113 % |
| **D3D11 mit Einzeltextur-Pool (neuer Default)** | **korrekt** (`f_defaultav1.png`) | **17,2 ms** | **9 %** |

Abschnitt 2 („Was stattdessen gilt") und die Codec-Warnung darunter sind damit
überholt; die aktuelle Regel steht in `encode/encoder.rs::encode_path` und am
Wert in `hwctx.rs`. Offen bleibt Punkt 1 unten unverändert: eine zweite
AMD-Maschine als Gegenprobe (auch für den Array-Befund — eine GPU, ein Treiber).

## Was offen bleibt

1. **Eine zweite AMD-Maschine**, am besten eine dGPU. Zwei Aussagen hängen an
   dieser einen 780M: dass `av1_d3d12va` kaputt ist, und dass AMF-#455 nicht
   mehr auftritt. Beide sind billig nachzuprüfen — ein AV1-Stream und ein Blick
   in den Log, bzw. `PULSE_HQ_AMD_D3D11=1` für die #455-Konstellation.
2. **Ende zu Ende ist weiterhin ungemessen.** Was von diesen Zahlen beim
   Zuschauer ankommt, sagt keine davon — dafür braucht es einen echten Push
   gegen MediaMTX und einen Empfänger.
3. **Die 17,2 ms von `av1_amf`** sind abschließend untersucht (Abschnitt 7):
   ein Bildabstand, über FFmpeg nicht wegzubekommen, aber über die Bildrate
   halbierbar. Der einzige verbliebene Weg wäre AMF direkt statt über FFmpeg.
4. **Die 1082-Höhe** des AV1-Stroms gehört geradegezogen. *(2026-08-22
   nachgemessen: am Encoder nicht möglich — `-align none` liefert ebenfalls
   1082, `-align 64x16` verweigert 1080 ganz. Es bleiben vier Auswege, die alle
   mehr kosten als der Fehler; Abwägung in
   `streaming/win-hq-sidecar/README.md`. Der Punkt bleibt offen, aber als
   Entscheidung, nicht als ungelöste Frage.)*
