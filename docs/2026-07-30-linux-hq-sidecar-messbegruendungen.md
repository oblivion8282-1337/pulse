# Linux-HQ-Sidecar: Messbegründungen aus der Repo-Historie

**Zweck:** Der Rust-Linux-Sidecar lag bis 2026-07-29 in einem eigenen Repo
([`pulse-linux-hq-sidecar`](https://github.com/oblivion8282-1337/pulse-linux-hq-sidecar), archiviert)
und wurde als **sauberer Schnitt ohne Historien-Import** nach `streaming/linux-hq-sidecar/`
übernommen. Die 44 Commit-Nachrichten dort trugen die Begründungen für die Encoder-, Puffer-
und Zeitstempel-Werte — im Hauptrepo steht davon nur ein Import-Commit.

Dieses Dokument zieht diese Begründungen her, damit sie eine Datei sind statt einer
Repo-Abhängigkeit. Es ist ein **Archiv-Auszug, kein Design-Dokument**: die Werte hier waren
zum Stand `ba9cc48` (2026-07-27) gültig. Wo der Code seither weitergezogen ist
(AMD-Encoder-Arbeit ab 2026-07-29), steht die aktuelle Begründung **im Code-Kommentar** —
der gilt, nicht dieses Dokument.

Verwandt: [`2026-07-19-hq-encoder-qualitaet-messung.md`](2026-07-19-hq-encoder-qualitaet-messung.md)
(VMAF-Auswertung, plattformübergreifend), `streaming/testbench/profiles/` (die Rohzahlen),
`streaming/testbench/README.md` (der Prüfstand).

---

## 1. Die Latenzkette — wo die Zeit hingeht

Über eine Messreihe vom 2026-07-26 bis 2026-07-27 wurde die Kette Ende zu Ende zerlegt
(1440p, AV1, 10 bit, 4000 kbps, Prüfstand `real-harness.py --e2e`). Der Wert jedes Postens
ist **einzeln gemessen**, nicht als Rest einer Subtraktion:

| Posten | Zeit | Anmerkung |
|---|---|---|
| Anzeige → Encoder-Eingang | 18,7 ms | über Zeitmuster im Bild + Wanduhr in der pts-Liste |
| Encode (vorher) | 33,4 ms | exakt zwei Bildabstände bei 60 fps, 13,9 bei 144 |
| Encode (nachher) | 2,9 ms | nach `zerolatency`+`delay=0` |
| Sendeweg ab Aufnahme | 6,0 ms | |
| RTMPS/Nagle | 3,6 ms | von `tcp_nodelay=1` eingespart |
| Dekodieren | 1,6 ms | |
| Netz bis Schirm | 2,2 ms | |
| **Fixposten MediaMTX (Verdacht)** | **~42,5 ms** | nie ausgeräumt — siehe unten |

**Ende zu Ende, 60 fps:** 99,8 → 82,3 → **17,4 ms** über die drei Eingriffe unten.

**Der wichtigste ungelöste Punkt:** Von den 30,5 ms, die der abgeschaltete Encoder-Vorlauf
einspart, kamen beim Zuschauer nur **10 ms** an. Rund 20 ms werden dahinter wieder
aufgezehrt — was zu einer Station passt, die **nach Zeitstempeln ausgibt statt nach Ankunft**.
Verdacht: MediaMTX, dieselbe Ecke wie der Fixposten von 42,5 ms. **Der nächste Latenz-Hebel
liegt damit nicht mehr an unserem Encoder.** Wer dort weitersucht, fängt hier an.

## 2. Encoder-Einstellungen

### `zerolatency=1` + `delay=0` (NVENC) — 33,4 → 2,9 ms

NVENC gab ein Paket erst heraus, wenn zwei weitere Bilder eingeschoben waren. Das ist **keine
feste Zeit**, sondern exakt zwei Bildabstände — bei niedriger Bildrate kostet es entsprechend
mehr, und es war mehr als der gesamte Empfangsweg zusammen.

Der Windows-Sidecar setzt beides für denselben ffmpeg-Encoder seit jeher. Dass es hier fehlte,
war **ein Versehen, kein Abwägen**. Rückschalter: `PULSE_NVENC_LOW_DELAY=0`.

**Der Preis, nachträglich gemessen** (Commit `4a6842b`, gegen eine verlustfreie Referenz):
0,6–1,4 dB PSNR und 0,010–0,016 SSIM, über zwei unabhängige Paare gleichgerichtet.
Also **10 ms Latenz gegen rund 1 dB**. Bleibt abgeschaltet.

### `preset=p2` — gleiche Qualität, ~40 % weniger GPU

`preset` war ungesetzt und lief auf dem ffmpeg-Default p4; Windows setzt p2 seit jeher.
Wieder ein Versehen, kein Abwägen. Offline an **identischen Bildern** gemessen (RTX 5080, AV1,
echtes Bildschirmmaterial, ganze Leiter p1–p7):

- Spanne p1..p7: Spiel 0,75 / 1,24 VMAF · Desktop 0,18 / 0,05 — die ganze Leiter bewegt fast nichts
- p2 gegen p4: −0,21 bei 4000 kbps, **+0,46 bei 10000** (p2 also besser)
- Encoder-Block live 1440p144: 11,0–11,9 % statt 17,3–18,0 %
- Durchsatz offline: 1440p 537 statt 375 B/s · 4K 477 statt 330 B/s
- Latenz unverändert

**Einschränkung, die nicht verlorengehen darf:** Auf dieser Karte ist der Gewinn folgenlos.
Er zählt auf schwächeren Karten und bei 4K — und **genau dort konnte nicht end-to-end gemessen
werden**: der Sender skaliert nie hoch, der Prüfstand-Bildschirm läuft auf 1440p. Die
4K-Zahlen sind offline.

### Der widerlegte `tune=quality`-Kommentar

`opts.rs` behauptete jahrelang, `preset`/Multipass/`rc-lookahead` wirkten nur mit
`tune=quality` — deshalb wurde `preset` nie gesetzt. **Am 2026-07-19 auf einer RTX 4090
nachgemessen: falsch.** Die Optionen werden auch mit `tune=ll` angenommen und verändern den
Bitstrom nachweislich (verschiedene Prüfsummen, keine „ignoring"-Warnung).

Trotzdem bleibt die Qualitätsleiter aus: auf echtem Bildschirmmaterial bei 4000 kbps bringt
p6+multipass+AQ **+0,85 VMAF**, und selbst mit allem (p7, B-Frames, 30 Bilder Lookahead) nur
**+1,84** — unter der Wahrnehmungsschwelle, während der Durchsatz um 40–50 % fällt. Bei
2000 kbps ist der Gewinn null.

### 10-bit ist an AV1 gebunden

NVENC kann H.264 hier wirklich als High 10 — **das dekodiert aber kein Browser**, und der
WHEP-Rückfall im Web ist ein `<video>`. Jeder 10-bit-Wunsch ohne AV1 fällt mit Log-Zeile auf
8 bit zurück, ebenso auf dem VAAPI-Pfad.

Zwei Sackgassen bei der RGB→P010-Wandlung, damit sie nicht erneut aufgegriffen werden
(Begründungen stehen auch im Modulkopf von `encode/nv_p010.rs`):
- FFmpegs CUDA-Frame-Kontext kennt **kein 10-bit-RGB** (`x2bgr10le` → rc=−38)
- `scale_cuda` kann `bgr0 → semiplanar10` **nicht**
- Gepacktes `GL_RGB10_A2` wäre kürzer, lässt sich aber **nicht bei CUDA registrieren**
  (`CUDA_ERROR_INVALID_VALUE`)

Deshalb zwei eigene GL-Shader-Durchgänge (Luma `R16`, verschränktes Chroma `RG16`).
Farbe: BT.709, begrenzter Bereich — signalisiert **nur** im 10-bit-Pfad, weil NVENC im
8-bit-Pfad nach eigener Konvention wandelt.

## 3. Muxer und A/V-Interleave

**Die zentrale Einsicht: FLV ist EINE Zeitleiste.** `av_interleaved_write_frame` gibt ein
Videopaket erst frei, wenn Ton mit passendem Zeitstempel vorliegt. **Der Rückstand des Tons
ist damit 1:1 Bild-Latenz.** Drei getrennte Befunde hängen daran:

### Der Ton bündelte das Bild (`7cef2a1`)

Symptom: sichtbares Ruckeln beim Zuschauer, während Bildzahl, Bitrate und Paketverlust
tadellos aussahen. Bei 20-ms-Opus-Paketen und dem PipeWire-Standardraster (1024 Samples,
gut 21 ms) verließen die Bilder den Sender in **20-ms-Bündeln**.

Behoben **an der Quelle**: 5-ms-Opus-Pakete (dem Encoder auch per `frame_duration` mitgeteilt,
sonst lehnt libopus sie ab) und `node.latency = 240/48000`. Wirkt bei jeder Bildrate.

Gezählt werden Ausgabe-Abstände über dem doppelten Soll je Sekunde:

| | vorher | nachher |
|---|---|---|
| 144 fps | 46–51 | 1–2 |
| 200 fps | 36–39 | 0 |
| 280 fps | Stream stirbt | läuft |

### `max_interleave_delta`: 100 → 10 ms (`65cd734`)

Ende zu Ende: 60 fps **99,8 → 82,3** · 144 fps 62,5 → 52,7 · 280 fps 676 → 301 ms.
Nebeneffekt: die Latenz wird auch **gleichmäßiger**, weil sie nicht mehr am zufälligen
Ton-Rückstand hängt (drei Läufe 82,5/82,6/82,7 gegen vorher 99,2/98,2/102,0).

**Warum nicht kleiner:** Ein Bild vor dem Ton kippt die Reihenfolge auf der einzigen
FLV-Zeitleiste und **beendet den Stream**. Gemessen: 1 µs starb sofort, 2 ms starb bei
280 fps, 10 ms lief bei 280 fps dreimal über 16 s fehlerfrei. 3 ms und 1 ms brachten bei
60 fps nichts mehr.

**Warum es überhaupt so hoch stand:** `max_interleave_delta` war der naheliegende, aber
falsche erste Weg gegen die Bündelung (siehe oben) — er stand bei 100 ms als reine Notbremse
gegen eine sterbende Tonspur. Er wird am **Format-Kontext** gesetzt, nicht im Wörterbuch von
`output_as_with`: das nimmt nur Protokoll-Optionen an und verwarf ihn vorher stillschweigend.

### Anhaltender Ton-Rückstand (`3b8a4a7`) — 33,5 → 17,4 ms

Die Ton-Zeitlinie wurde **einmal** an der Wanduhr verankert und zählte danach nur noch Samples.
Korrigiert wurde erst ab 100 ms Abweichung — die fängt aber den **Aussetzer**, nicht den
**Rückstand**: ein einmaliger Hänger von 25 ms lässt die Zeitlinie dauerhaft 25 ms zurück,
und weil er unter der Schwelle bleibt, wird das **nie wieder eingeholt**.

Gemessen: im Desktop-Modus (Null-Sink des Routers) startet die Zeitlinie bei 2–4 ms, springt
nach wenigen Sekunden auf 27–29 ms und bleibt dort. Im Mikrofonweg, der diesen Sink nicht
durchläuft, bleibt sie bei 3–6 ms. **Daher stammte der Unterschied 22 gegen 9 ms**, den das
Latenz-Profil als nächsten Hebel notiert hatte.

Fix: zweite, kleinere Schwelle von 15 ms, aber erst **nach 150 Batches am Stück** (gut 0,4 s),
damit normales Zappeln nichts auslöst. Der Zähler setzt zurück, sobald der Rückstand weg ist —
sonst summierten sich weit auseinanderliegende Ausreißer zu einem Sprung.

Ergebnis: 60 fps 33,5 → 17,4 · 144 fps 31,2 → 17,7 ms. Ton-Rückstand am Muxer 34,2 → 2,3 ms.
**280 fps blieb unverändert schlecht (98–249 ms) — dort ist die AUFNAHME am Anschlag, eigener
Faden.**

## 4. Puffer und Warteschlangen

- **Muxer-Queue 256 → 32 Pakete.** 256 waren bei 60 fps rund **vier Sekunden Video**: stockt
  der RTMPS-Socket, bekommt der Zuschauer diese Sekunden **nie zurück** — ein Live-Stream holt
  nicht auf. 32 fangen eine Keyframe-Spitze weiterhin ab.
- **Ton-Kanal auf 64 Pakete begrenzt** statt unbegrenzt. Vorher sammelte er bei stockendem
  Muxer 384 KB/s ohne Grenze — eine Minute Stillstand waren rund 23 MB, nach oben offen.
- **`try_send` im Ton-Pfad**, weil der Sendeaufruf in PipeWires **RT_PROCESS-Callback** sitzt.
  Dort zu blockieren hätte die Tonaufnahme **des ganzen Systems** ausgebremst, nicht nur
  unseren Stream. Verworfene Pakete werden gezählt und in Zweierpotenzen gemeldet (kein
  Logsturm auf dem Echtzeit-Thread).
- **`FrameMailbox` (Ein-Slot, latest wins) statt FIFO-Kanal.** Der bounded Kanal behielt bei
  Stau die **ersten** Frames und verwarf die neuen — nach dem Stall klebte der Stream auf dem
  Stall-Anfangsbild. Die Mailbox ist zugleich EMFILE-fest.

## 5. Geprüft und verworfen

Die teuerste Sorte Wissen: Versuche, die plausibel klangen und nichts brachten.

| Vermutung | Messung | Ergebnis |
|---|---|---|
| `flush_packets = 1` hilft | 86,9 statt 82,5 ms | nichts; die 32-KB-Ausgabepuffer-Theorie (≈64 ms bei 4000 kbps) ist damit erledigt |
| Die Mux-Warteschlange steht dauerhaft voll | auf 1 verkleinert: 100,7 statt 96,0 ms | **schlechter** — Vermutung falsch |
| Nagle + verzögerte Bestätigungen sind die Ursache | `tcp_nodelay=1`: 3,6 ms | Gewinn zum Nulltarif, aber **nicht** die gesuchte Ursache |
| Latenz-Anforderung am Null-Sink des Routers hilft | 21,3 gegen 22,5 ms über je fünf Läufe | nichts |
| Die PipeWire-Rastergröße unterscheidet Desktop- und Mikrofonweg | in **beiden** Modi 2,7 ms | widerlegt; die Ursache war die Zeitlinien-Verankerung |
| `max_interleave_delta` klein löst die Bündelung | 2 ms starb bei 280 fps | falscher Weg — an der Quelle beheben |
| `GL_RGB10_A2` gepackt für 10 bit | `CUDA_ERROR_INVALID_VALUE` | nicht registrierbar |
| Qualitätsstufe für H.264 anbieten | max. +1,84 VMAF bei −40–50 % Durchsatz | unter der Wahrnehmungsschwelle |

## 6. Zwei Fehler am Messverfahren selbst

Beide meldeten plausible Zahlen, die an der Sache vorbeigingen — erwähnenswert, weil dieselbe
Falle bei jeder neuen Sonde droht:

1. **Der Zeitstempel saß NACH `avcodec_send_frame`.** Ohne Vorlauf liefert NVENC im selben
   Aufruf, die Rechenzeit fiel also heraus und die Messung meldete **0,0 ms** — eine Zahl, die
   nach Latenzfreiheit aussah und am Messpunkt vorbeiging. Zusätzlich wird im EAGAIN-Pfad neu
   gestempelt: das Leeren dazwischen gehört nicht zur Verarbeitung dieses Bildes und trieb
   sonst genau die Ausreißer hoch.
2. **Das Format des Ziel-Rahmens wurde beim Rohmitschnitt bei JEDEM Bild auf „unbestimmt"
   gesetzt.** Ab dem zweiten Bild trägt der Rahmen schon Speicher, dann passt die Beschreibung
   nicht mehr zum Inhalt: geschrieben wurden 4.608.000 Bytes (ein yuv420p-Bild) statt
   11.059.200, danach Abbruch mit „Ebene 2 fehlt". **Die Byte-Zahl war der Hinweis, die
   Meldung war die Folge** — sie zeigte woanders hin.

Dazu die grundsätzliche Einsicht aus `92eb06b`: NVENC arbeitet asynchron, das Paket zu Bild N
fällt erst beim Einschieben von Bild N+2 heraus. **Ohne Zuordnung über den pts ist die Latenz
nicht messbar** — und ohne Messung war der größte Posten der Kette unbekannt.

## 7. Messwerkzeuge (Umgebungsvariablen)

Alle standardmäßig aus und dann kostenlos:

| Variable | Zweck |
|---|---|
| `PULSE_ENCODER_OPTS="preset=p6,spatial-aq=1"` | überschreibt `vendor_opts`. **Zweck ist das Messen, nicht das Einstellen** — ein Vergleich, der je Variante einen Neubau verlangt, wird nach der dritten Variante nicht mehr gemacht. Werte werden bewusst nicht geprüft; ffmpeg meldet Unbekanntes selbst |
| `PULSE_MUX_LATENCY_LOG=1` | bildet den Interleaver nach und meldet den **Rückstand des Tons**, die tatsächliche Batch-Größe, den Sendeversatz je Bild, den Nullpunkt in Wanduhrzeit. Misst die **Ursache**, nicht die Wirkung des Deckels |
| `PULSE_DUMP_RAW=<pfad>` | schreibt das Bild mit, das in den Encoder geht (P010 bei 10 bit) + pts-Liste mit Wanduhr. **Gut 660 MB/s bei 1440p60**, Grenze 180 Bilder (`PULSE_DUMP_RAW_FRAMES`). Gehört auf eine SSD, nicht in ein tmpfs |
| `PULSE_MUX_QUEUE` | Warteschlange zum Schreib-Thread — machte die „steht voll"-Vermutung prüfbar |
| `PULSE_TCP_NODELAY=0` · `PULSE_NVENC_LOW_DELAY=0` | Rückschalter |
| `PULSE_PORTAL_REUSE=1` | speichert das Portal-Restore-Token, damit Messungen ohne Dialog laufen. **Standardmäßig aus, weil der Dialog unter Wayland die Quellenauswahl IST** |
| `PULSE_HQ_VENDOR` · `PULSE_HQ_RENDER_NODE` | erzwingen Encode-GPU bzw. Render-Node (Support-Notbremse) |

## 8. GPU-Import — die nicht offensichtlichen Festlegungen

- **Der DRM-Modifier taugt NICHT als Besitzer-Signal.** Der Compositor liefert LINEAR (0x0),
  das trägt keine Vendor-Info. Deshalb probiert `run_stream` den ersten Frame der Reihe nach
  auf **jeder anwesenden Render-Node** zu importieren — wer importieren kann, besitzt den
  Buffer. (Kandidaten sind einzelne Nodes, **nicht Hersteller**: bei Ryzen-iGPU + AMD-dGPU
  wurde sonst nur die zufällig erste AMD-Node versucht.)
- **AMD-DCC-komprimierte Modifier werden gefiltert.** Die Video-Einheit (VCN) vor GFX12/RDNA4
  kann sie nicht lesen — wählt der Compositor so eine, scheitert `hwmap` mit EINVAL.
  RDNA4-transparent-DCC bleibt drin. (Support-Fall RX 6000/RDNA2 auf Bazzite+KDE.)
- **CUDA kann EGLImage-gebundene Texturen nicht registrieren** (`INVALID_VALUE`) → Staging-Kopie
  wie GSR. Keine Umgehung bekannt.
- **`glBlitFramebuffer` kopiert komponentenweise, `glCopyImageSubData` byte-roh.** Zwei
  Kopierpfade hießen zwei Byte-Ordnungen je nach Skalierung → Rot/Blau-Tausch. Es gibt jetzt
  nur noch **einen** Pfad (immer Blit) und der Encoder-Pool ist RGB0, nicht BGR0.
- **`eglTerminate` wird auf geteilten Device-Displays nie gerufen**, und libEGL/libcuda werden
  nie `dlclose`d: Displays sind prozessweit geteilt und **nicht refcounted**. Auf AMD/Intel
  (kein NVENC-Importer als Mithalter) zeigte Treiber-State sonst auf entladenen Code.
- **EGLImage+Textur werden pro Capture-Buffer gecacht** (der Compositor reicht dieselben 2–8
  Buffer im Kreis; bei 144 fps waren das ~288 Wegwerf-Operationen/s inkl. Treiber-Roundtrips).
  Kontroll-Log einmal pro Buffer: **steigt `buffers=N` dauerhaft, ist das Caching kaputt.**
- **Ein Texturfilter-Cache nach Textur-Nummer wäre falsch:** GL vergibt Nummern nach dem
  Löschen wieder, eine neue Textur könnte eine alte erben und ihre Filter nie bekommen —
  Aliasing beim Skalieren, kein Absturz, **also spät sichtbar**.
- **HW-Codec-Verfügbarkeit wird durch echtes Öffnen geprobt.** Die bloße Encoder-Existenz im
  gelinkten FFmpeg sagt nichts über die GPU; eine hartkodierte Liste bot AV1 auf RTX 30xx an.
  Nur **definitive** Ergebnisse werden gecacht (ein transienter Treiberfehler beim ersten
  `health` schaltete HQ sonst bis zum Neustart ab), mit 30s-Retry-Drossel.

## 9. Sonstiges, das nur hier stand

- **Portal-Session muss explizit geschlossen werden.** Der Sidecar ist ein Dauerläufer mit
  prozessweit gecachter zbus-Verbindung — ohne Close bleibt jede ScreenCast-Session im
  Compositor registriert und **KDE zeigt dauerhaft das rote Aufnahme-Tray-Symbol** (eines pro
  Stream/Fehlversuch). GSR betrifft das nicht: dort endet der Prozess pro Aufnahme.
- **Der Stereo-Router summierte den linken Kanal in den rechten.** PipeWire meldet die Ports
  eines Stereo-Streams **einzeln**; beim ersten Registry-Event sah der Node wie Mono aus →
  FL wurde auf beide Sink-Kanäle gelinkt, und `FL→FR` blieb kleben. Ergebnis: rechts = FL+FR
  (**exakt +6 dB** bei Dual-Mono). Gemessen an der ganzen Kette: Analyser-Tap am MoQ-Player
  R = 2×L, ffmpeg-astats am HLS-Abgriff −23,3 gegen −29,3 dB.
  **WHEP hatte den Fehler verdeckt, weil WebRTC auf Mono heruntermischt — der MoQ-Player war
  der erste ehrliche Zuhörer.** Das ist die eigentliche Lehre: der Testpfad kann den Fehler
  wegmischen.
- **Der Echo-Schutz muss `application.name` UND `node.name` matchen.** Electron heißt
  „Chromium" im `application.name`, der Exclude „Pulse" (`node.name`) griff nie — eigene
  Voice-Wiedergabe konnte als Echo in den Stream laufen.
- **Der Profil-Katalog war tot.** „AV1 Effizient" / „H.264 Standard" / „H.264 Sparmodus" /
  „Custom" trugen **alle dieselben 4000 kbps / 60 fps** — die Namen suggerierten Abstufungen,
  die es nie gab. Das HQ-Panel ist channel-mode-only und setzt hart `Custom`.
- **`max_interleave_delta` als Netz gegen Audio-Tod:** Ein Audio-Encoder-Fehler führt zu
  Video-only, und der Track wird dann **gar nicht angekündigt** — ein deklarierter stummer
  Track ließe den Interleave-Muxer 10 s puffern.
- **Die Aufnahme selbst bleibt 8 bit** (der Compositor liefert XRGB8888), auch im 10-bit-Pfad.

## 10. Register: Thema → Archiv-Commit

Für den Fall, dass die volle Nachricht doch gebraucht wird. Repo:
`oblivion8282-1337/pulse-linux-hq-sidecar` (archiviert, read-only).

| Commit | Datum | Thema |
|---|---|---|
| `ba9cc48` | 2026-07-27 | `preset=p2` — Qualitätsleiter p1–p7, drei Kostenmesswege |
| `1d7c7c6` | 2026-07-27 | `PULSE_ENCODER_OPTS` — Messen statt Einstellen |
| `3b8a4a7` | 2026-07-27 | Ton-Rückstand aufholen, 33,5 → 17,4 ms |
| `65cd734` | 2026-07-27 | `max_interleave_delta` 100 → 10 ms, 99,8 → 82,3 ms |
| `003bbcb` | 2026-07-27 | `tcp_nodelay`, Wanduhr je Bild, widerlegte Queue-Vermutung |
| `4a6842b` | 2026-07-27 | verlustfreier Rohmitschnitt → PSNR/SSIM-Preis des Vorlaufs |
| `211240b` | 2026-07-26 | `zerolatency`+`delay=0`, 33,4 → 2,9 ms + Messfehler-Korrekturen |
| `92eb06b` | 2026-07-26 | Encode-Latenz je Bild über pts — warum sie vorher unmessbar war |
| `7cef2a1` | 2026-07-26 | 5-ms-Opus + `node.latency`, Bündelung an der Quelle |
| `c36be15` | 2026-07-26 | Queue-Größen, RT-Callback, CUDA-Kopie, Texturfilter |
| `1a9f1b8` | 2026-07-26 | 10-bit über eigene RGB→P010-Wandlung, Sackgassen |
| `bf708f3` | 2026-07-19 | widerlegter `tune=quality`-Kommentar |
| `4c63968` | 2026-07-20 | DCC-Puffer + Zwillings-GPUs |
| `a583cfd` | 2026-07-16 | Stereo-Router +6 dB, MoQ-Player als ehrlicher Zuhörer |
| `01925a9` | 2026-07-12 | Encode-GPU aus erstem Frame, Modifier taugt nicht als Signal |
| `707fff3` | 2026-07-12 | refcounted DRM_PRIME — AMD zero-copy |
| `398241d`, `1cdffe9`, `9f55d8e` | 2026-07-21 | drei Review-Runden: Leaks, Hänger, Protokoll-Parität |
| `409251c` | 2026-07-11 | EGLImage-Cache pro Buffer |
| `b087b28` | 2026-07-11 | echte HW-Codec-Probe |
| `d1a486d` | 2026-07-11 | Rot/Blau-Tausch, Blit vs. CopyImageSubData |
| `ecb1afe` | 2026-07-10 | A/V-Sync über gemeinsame Wanduhr (GSR-Modell) |
| `6277015` | 2026-07-10 | DMABUF-Modifier-Verhandlung, DONT_FIXATE-Tanz |
| `9ae7f71` | 2026-07-10 | Zero-Copy-DMABUF→NVENC, CUDA-Registrierungsfalle |
