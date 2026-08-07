# Probe: teilen sich CUDA und Vulkan denselben Speicher? (Linux/NVIDIA)

Beantwortet zwei Fragen, nachprüfbar, in zwei Stufen:

1. **Puffer** — kommt ein Inhalt, den CUDA in einen von Vulkan exportierten
   Speicher schreibt, dort unverändert an?
2. **Bild** — kann CUDA in ein exportiertes `VkImage` schreiben (NV12 und
   P010), oder muss eine Puffer→Bild-Kopie dazwischen?

Davon hängt Zero-Copy im `pulse-player` unter **Linux/NVIDIA** ab. Heute nimmt
jedes Bild den Weg GPU → Hauptspeicher → GPU zurück: `av1_cuvid` liefert seine
Bilder in den Hauptspeicher (`decode.rs`, Modulkopf), der Renderer lädt sie
wieder hoch. Was das kostet, steht in
`streaming/testbench/profiles/player-2026-08-06-bildweg-kosten.json` — 5,26 ms
je Bild bei 1440p60 10 bit, also 32 Prozent des Budgets.

## Warum das nicht die Windows-Probe von nebenan ist

`../nv12-wgpu-import` prüft **D3D11 → Vulkan** über geteilte NT-Handles. Unter
Linux gibt es kein D3D11; dort läuft NVDEC über CUDA, und der Übergabeweg ist
`VK_KHR_external_memory_fd` gegen `cuImportExternalMemory`. Das ist eine andere
Schnittstelle mit anderem Ausgang — die Windows-Reihe endete auf NVIDIA schwarz,
diese hier trägt.

## Warum diese Richtung

Für den Player muss **CUDA schreiben und Vulkan lesen**, nicht andersherum: der
Decoder-Frame liegt in CUDA-Speicher, den FFmpeg mit `cuMemAlloc` anlegt — und
der ist **nicht exportierbar**. Exportieren kann nur, wer beim Anlegen das Flag
setzt, und das ist die Vulkan-Seite. Der Weg im Player wäre also: Vulkan legt das
Ziel an, CUDA bekommt es eingehängt, der fertige Decoder-Frame wird GPU-lokal
hineinkopiert. Keine Nullkopie im Wortsinn, aber die Kopie bleibt auf der Karte
statt über PCIe zu laufen.

## Warum ohne wgpu

Diese Stufe fragt nur, ob Treiber und CUDA sich einig sind. Käme wgpu dazu, wäre
ein Fehlschlag nicht mehr eindeutig zuzuordnen — auf der Windows-Seite ist genau
diese Verwechslung passiert (es sah nach wgpu aus und war der Treiber).

## Bauen und laufen lassen

```bash
cd streaming/player-labor/cuda-vulkan-import
cargo build --release
./target/release/cuda-vulkan-import              # Stufe 1: Puffer
SPIKE_MODUS=bild ./target/release/cuda-vulkan-import   # Stufe 2: Bild
```

Braucht kein CUDA-Toolkit (`libcuda.so.1` kommt mit dem Treiber), kein FFmpeg,
keinen Server, kein Fenster. Rückgabewert 0 = der geprüfte Weg trägt.

| Schalter | |
|---|---|
| `SPIKE_MODUS` (`puffer`) | `bild` schaltet auf Stufe 2 |
| `SPIKE_BYTES` (`3686400`) | Größe des geteilten Speichers, nur Stufe 1 |
| `SPIKE_BREITE` / `SPIKE_HOEHE` (`2560`/`1440`) | Bildgröße, nur Stufe 2 |
| `SPIKE_DEDIZIERT` (`1`) | `0` = ohne `VkMemoryDedicatedAllocateInfo` |
| `SPIKE_SURFACE_LDST` (`0`) | `1` setzt `CUDA_ARRAY3D_SURFACE_LDST` |
| `SPIKE_OHNE_SCHREIBEN` (`0`) | **Gegenprobe**, Urteil ist umgedreht |
| `SPIKE_DEDI_FEHLANPASSUNG` (`0`) | **Gegenprobe**, gibt Befund statt Urteil |

**Beim Nachfahren einer Matrix gilt die Kopfzeile des Laufs als Beleg, nicht die
eigene Beschriftung.** Jeder Lauf gibt aus, mit welcher Auflösung und
Schalterstellung er tatsächlich lief. Der Grund steht unter „Was die Probe
absichert" — ein nicht greifender Schalter hat hier schon einmal drei Zeilen
einer Matrix entwertet.

## Was die Probe absichert

Nichts davon ist Selbstzweck — jedes fängt eine Fehlerklasse, die in diesem
Labor schon falsche Befunde erzeugt hat.

**Beim Start:**

* **Struct-Layouts gegen `cuda.h`.** Die Beschreibungen werden von Hand
  nachgebaut; ein falscher Feld-Versatz erzeugt keinen Fehler, sondern stille
  Falschergebnisse. Die Größen werden geprüft, und die Sollwerte stammen aus
  einem **kompilierten** `sizeof`/`offsetof` gegen `/opt/cuda/include/cuda.h` —
  nicht aus der Doku und nicht von Hand gerechnet.
* **UUID-Abgleich.** Vulkan und CUDA müssen dieselbe Karte meinen. Auf einer
  Maschine mit zwei GPUs schlüge der Import sonst aus einem Grund fehl, der mit
  der Sache nichts zu tun hat.

**In der Bild-Stufe, je Ebene:**

* **Kontrolle A — ist der Weg überhaupt messbar?** Das Bild wird vor dem
  CUDA-Zugriff flächendeckend mit `0x5A` gefüllt und sofort zurückgelesen. Kommt
  der Wert nicht unverändert an, ist der Vulkan-eigene Bildweg kaputt; die Probe
  bricht dann ab, statt eine Zahl über CUDA zu liefern, die keine ist.
* **Kontrolle B — meint CUDA dasselbe Bild?** `cuArrayGetDescriptor` fragt
  zurück, was eingehängt wurde. Stimmt es nicht mit der Beschreibung überein,
  prüft der Vergleich brav die falsche Sache.
* **Kontrolle C — ein verfälschtes Byte muss auffallen.** Ohne sie wäre „alles
  stimmt" nicht von „die Prüfung vergleicht nichts" zu unterscheiden.

**Zwei Gegenproben, die den Ablauf absichtlich sabotieren:**

* `SPIKE_OHNE_SCHREIBEN=1` lässt `cuMemcpy2D` aus. **Das ist die schärfste
  Kontrolle der Probe:** ein Erfolg im Hauptlauf heißt nur dann etwas, wenn ein
  Nicht-Schreiben zuverlässig als Misserfolg herauskommt. Das Urteil ist hier
  umgedreht, damit die Gegenprobe nicht von Hand ausgelegt werden muss — eine
  Gegenprobe, deren Ergebnis man selbst deuten muss, wird beim nächsten Mal
  falsch gedeutet.
* `SPIKE_DEDI_FEHLANPASSUNG=1` setzt das Dedicated-Flag auf einer Seite falsch
  (in beiden Richtungen prüfbar). Laut NVIDIA-Forum 278691 gäbe das senkrechte
  Streifen ohne Fehlermeldung. **Auf dieser Karte tritt das nicht ein** — der
  Lauf kommt fehlerfrei durch. Als Empfindlichkeitsnachweis taugt diese
  Gegenprobe deshalb nicht; diese Rolle trägt allein die erste.

Das Prüfmuster ist positionsabhängig und bewusst nicht gleichförmig: ein Weg,
der versetzt liest, nur den Anfang trifft oder eine falsche Zeilenlänge annimmt,
käme sonst als fehlerfrei durch. Genau dieser Fehler ist auf der Windows-Seite
beim Textur-Stapel aufgetreten. Bei einer Abweichung wird zusätzlich die
Verteilung über die Zeilen ausgegeben — senkrechte Streifen und ein Lochmuster
sind zwei verschiedene bekannte Ursachen und sehen unterschiedlich aus.

## Ergebnis

Messakten:
`streaming/testbench/profiles/player-2026-08-06-cuda-vulkan-linux.json` (Puffer)
und `player-2026-08-07-cuda-vulkan-bild-import.json` (Bild).

**Stufe 1 (Puffer): der Weg trägt** — in beiden Richtungen, über alle geprüften
Größen bis 4K-P010, mit und ohne dedizierte Allokation, fünf Wiederholungen
stabil.

**Stufe 2 (Bild): der Weg trägt ebenfalls, mit einer Einschränkung.**

| | |
|---|---|
| NV12 als **zwei** Bilder (R8 + R8G8) | trägt, jedes Byte |
| P010 als **zwei** Bilder (R16 + R16G16) | trägt, jedes Byte |
| NV12/P010 als **ein** mehrplaniges `VkImage` | abgewiesen, `CUDA_ERROR_INVALID_VALUE` |

Geprüft über 720p, 1080p, 1440p und 4K, mit und ohne dedizierte Allokation, mit
und ohne `SURFACE_LDST`, fünf Wiederholungen stabil. **Eine Puffer→Bild-Kopie
ist damit nicht nötig.**

Der Ein-Bild-Weg scheitert erst bei `cuExternalMemoryGetMappedMipmappedArray` —
Anlegen, Exportieren und `cuImportExternalMemory` gehen durch. Der Grund liegt
also in der Beschreibung des Bildes: `CUDA_ARRAY3D_DESCRIPTOR` kennt nur **ein**
Format und **eine** Kanalzahl, NV12 hat aber zwei Ebenen mit unterschiedlicher
Größe und Kanalzahl. Dass `cuda.h` trotzdem ein `CU_AD_FORMAT_NV12` führt, war
der Anlass, es zu messen statt zu erschließen. Die Probe versucht es weiterhin
bei jedem Lauf und würde es melden, wenn ein künftiger Treiber es annimmt.

Getrennte Ebenen sind ohnehin die Form, in der ein Shader sie am liebsten
abtastet — die Einschränkung kostet nichts.

**Nebenbefund, der beim Umbau zählt:** ein `VkImage` belegt mehr Speicher als
die dichte Bildgröße, zwischen 0,74 und 18,5 Prozent über den geprüften Fällen,
ohne einfache Regel. Die Zahl ist beim Treiber zu **erfragen** und in den
CUDA-Import durchzureichen; sie aus Breite mal Höhe zu rechnen, geht bis zu
18,5 Prozent daneben.

## Wo wir stehen (Stand 2026-08-07, Abend)

Zweig `feat/zero-copy-player-linux`.

**Die Kette ist geschlossen, und sie traegt.** Der Renderer nimmt das CUDA-Bild
direkt: Vulkan legt das Zielbild auf **wgpus** Geraet an, CUDA bekommt es ueber
einen Dateideskriptor eingehaengt, der fertige Decoder-Frame wird mit
`cuMemcpy2D` GPU-lokal hineinkopiert, wgpu uebernimmt es mit `texture_from_raw`.
Der Code liegt in `streaming/pulse-player/src/zerocopy/linux/`, die Einhaengung
in `src/render/fremdbild.rs`.

Gemessen (Messakte
`streaming/testbench/profiles/player-2026-08-07-zerocopy-linux-im-player.json`),
1440p60 AV1 10 bit ueber die echte Kette, fuenfzehn Laeufe je Arm in drei
Reihen, Arme abwechselnd:

| | Weg ueber den Hauptspeicher | neuer Weg |
|---|---|---|
| **Ende-zu-Ende** (aus dem gemalten Zeitmuster) | 77,98 ms | **73,32 ms** |
| Bild-bis-Schirm | 63,08 ms | 59,65 ms |
| dasselbe, Takt festgenagelt | 64,00 ms | 59,68 ms |
| Dekodierzeit je Bild | 4,42 ms | 1,11 ms |
| Bildrate | 57,1 | 56,9 |
| Grafikspeicher des Prozesses | 651 MiB | 795 MiB |

**In keiner dieser Kennzahlen ueberlappen die Arme.** Bei sechs gegen sechs
Werten hat eine vollstaendige Trennung durch Zufall eine Wahrscheinlichkeit von
1 zu 924.

Vier Dinge dazu, die man beim Weiterlesen wissen muss:

* **Die Ende-zu-Ende-Zahl ist erst messbar geworden, weil die Sonde umgebaut
  wurde.** Sie las ihr Balkenmuster aus der Luma-Ebene im Hauptspeicher, und die
  gibt es auf diesem Weg nicht mehr — sie war also genau bei der Zahl blind, an
  der der Umbau zu messen ist. Jetzt kopiert sie die vier Musterzeilen aus der
  eingehaengten GPU-Textur (`render/musterprobe.rs`, Bauart nach `render/abdruck.rs`).
  **Der Zeitstempel wird beim Aufzeichnen genommen, nicht beim Abholen**: der
  Abholverzug von ein bis zwei Bildern laege sonst einseitig zu Lasten des neuen
  Weges, und zwar in genau der Groessenordnung des gesuchten Gewinns.
* **Der neue Weg gewinnt MIT einem Handicap.** Die Sonde kostet dort eine
  zusaetzliche Kopie je Bild; auf dem Bezugsarm liest sie die ohnehin
  vorhandenen Hauptspeicher-Ebenen und kostet nichts.
* **Die 144 MiB Grafikspeicher sind die schaerfste Kontrolle der Reihe.** Sie
  belegen unabhaengig vom Log, dass der Ring wirklich angelegt wurde, und sie
  decken sich mit der Vorausrechnung fuer zwoelf Plaetze bei 1440p10.
* **Der Rueckfall ist einmal wirklich eingetreten**, und er hat getan, was er
  soll: ein fehlender `cuCtxSetCurrent` beim Ringbau liess
  `cuImportExternalMemory` scheitern — Ergebnis war ein langsameres Bild samt
  einer Logzeile, kein schwarzes Fenster.

Was offen bleibt: der **VAAPI**-Weg auf Linux (AMD, Intel) hat weiterhin keine
Bruecke, er braeuchte DMA-BUF statt eines CUDA-Imports. Der Gleichlauf laeuft
ueber `cuCtxSynchronize` statt ueber ein Semaphor — begruendet im Modulkopf von
`zerocopy/linux/`, aber nicht gegen einen Semaphor-Weg gemessen. Und ein
Aufloesungswechsel im laufenden Strom ist nie ausgeloest worden.

Der Abschnitt darunter (Stand 2026-08-07, Nacht) bleibt als Historie stehen; die
dort unter Punkt 3 gefuehrte Aufgabe ist damit erledigt.

## Wie es dahin kam (Stand 2026-08-07, Nacht)

Zweig `feat/zero-copy-player-linux`.

**Die Kette steht jetzt an beiden Enden.** Zum bisherigen Stand (unten) ist der
Anfang dazugekommen — und er trug die groesste Unsicherheit:

**`av1_cuvid` gibt seine Bilder sehr wohl als CUDA-Speicher heraus.** Beide
cuvid-Decoder bieten `AV_PIX_FMT_CUDA` an; gewaehlt wird es, sobald am
Decoder-Kontext ein CUDA-Geraet haengt. Ein eigener `get_format`-Rueckruf ist
nicht noetig. **Der Modulkopf von `decode.rs` war also nicht falsch beobachtet,
aber falsch begruendet:** die Bilder landen im Hauptspeicher, *weil der Player
kein Geraet anhaengt* — nicht, weil cuvid es nicht anders koennte.

Probe: `../cuvid-cuda-ausgabe`, Messakte
`streaming/testbench/profiles/player-2026-08-07-cuvid-cuda-ausgabe.json`.
Gemessen bei festgenageltem GPU-Takt (Streuung 1 bis 2 Prozent), vier Runden,
Arme abwechselnd:

| Fall | Bezugsarm | CUDA-Ausgabe | gespart je Bild |
|---|---|---|---|
| 1080p60 AV1 8 bit | 1,18 ms | 0,85 ms | 0,33 ms |
| 1080p60 AV1 10 bit | 1,36 ms | 0,77 ms | 0,59 ms |
| 1440p60 AV1 10 bit | 2,26 ms | 1,23 ms | **1,03 ms** |
| 1080p60 H.264 8 bit | 0,85 ms | 0,52 ms | 0,33 ms |

Prozessorzeit je Bild bei 1440p10: **0,854 auf 0,039 ms**. Die Ersparnis ist
**zusaetzlich** zu den 5,26 ms aus `player-2026-08-06-bildweg-kosten.json` — die
enthielten die Rueckholung nicht, weil sie unsichtbar in `send_packet` steckte.

Die schaerfste Kontrolle dazu: ein dritter Arm mit CUDA-Ausgabe **und**
ausdruecklichem Zurueckholen jedes Bildes landet in allen vier Faellen exakt auf
dem Bezugsarm. Der Gewinn ist damit nachweislich die eingesparte Kopie und
nicht bloss vorauseilende Arbeit.

**Erledigt: die Grundfrage, der Bild-Import und die Anbindung an wgpu 29.**
CUDA und Vulkan teilen sich auf Linux/NVIDIA denselben Speicher, CUDA schreibt
direkt in exportierte Vulkan-Bilder (NV12 wie P010, als getrennte Ebenen), und
**wgpu 29.0.4 übernimmt so ein Bild mitsamt Inhalt** — schon beim ersten
Zugriff, über 720p bis 4K, und über 20 aufeinanderfolgende CUDA-Schreibrunden
in die bereits eingehängte Textur.

Die Probe dafür liegt in `../wgpu-cuda-import` (eigene Kiste, Begründung in
ihrer README), die Messakte in
`streaming/testbench/profiles/player-2026-08-07-wgpu29-vkimage-import.json`.

**Damit entfällt der Fassungssprung.** Der Verdacht, wgpu 29 trage eingehängte
Texturen als `UNINITIALIZED` ein und ein Übergang aus `VK_IMAGE_LAYOUT_UNDEFINED`
verwerfe den Inhalt, ist am Quelltext bestätigt (`device/resource.rs:1253`,
`vulkan/conv.rs:218`) — die **Folge** tritt auf dieser Karte aber nicht ein.
„Darf verwerfen" ist keine Zusage zu verwerfen. Die Kette wgpu 30 →
`egui-wgpu`/`egui-winit` 0.36 → Rust 1.95 wird für diesen Zweck nicht gebraucht.

Die Reihenfolge, die hier stand, ist damit abgearbeitet:

1. ~~Bild-Import in reinem Vulkan~~ — erledigt.
2. ~~Anbindung mit wgpu 29~~ — **erledigt, trägt.**
3. ~~Sprung auf wgpu 30~~ — **entfällt** (bleibt eine Option aus anderen
   Gründen; für den Bild-Import ist er unbegründet).

**Was jetzt ansteht, in dieser Reihenfolge:**

1. ~~**`av1_cuvid`**~~ — **erledigt, die Antwort ist JA** (s. oben), und der Weg
   ist seit dem 2026-08-07 **im echten Player eingebaut**: `Hwaccel::Cuda` in
   `decode.rs`, `Pixel::CUDA` in `drain`, Notausgang
   `PULSE_PLAYER_CUDA_AUSGABE=0`. Gemessen in der echten Kette (WHEP über den
   lokalen MediaMTX): dasselbe Bild, kein Unterschied in Dekodierzeit,
   Ende-zu-Ende-Latenz oder gezeichneten Bildern — **und das ist der
   Erfolgsfall**, weil der Renderer das Bild weiterhin herunterholt. Belegt,
   dass der Schalter wirkt, ist es über den Grafikspeicher des Player-Prozesses
   (651 gegen 639 MiB, dreimal ohne Überlappung). Messakte
   `streaming/testbench/profiles/player-2026-08-07-cuvid-cuda-im-player.json`.
   Dabei sind
   vier Dinge angefallen, die der Umbau braucht und die man sonst erst im
   Fehlerfall bemerkt:
   * **Der CUDA-Kontext.** `av_hwdevice_ctx_create` mit Flag
     `AV_CUDA_USE_CURRENT_CONTEXT` (Bit 1) ist der Weg — FFmpeg uebernimmt dann
     den Kontext, den der Player fuer die Vulkan-Einhaengung ohnehin haelt.
     `AV_CUDA_USE_PRIMARY_CONTEXT` (Bit 0) **scheitert genau in dieser Lage**
     (`Primary context already active with incompatible flags`, 16 von 16
     Laeufen), und ohne Flag haette der Prozess zwei Kontexte auf einer Karte.
     Das erspart zugleich den Nachbau von `AVCUDADeviceContext` — dafuer gibt
     es in `ffmpeg-sys-next` **keine** Bindung.
   * **`decode.rs::drain` prueft auf `VAAPI | D3D11`.** `Pixel::CUDA` steht dort
     nicht. Wer nur das Geraet anhaengt, bekommt ein **weisses Fenster**, weil
     `convert` jedes Bild ablehnt — derselbe Fehler wie beim D3D11-Weg am
     2026-08-04, und er sieht nach nichts aus.
   * **Der Quell-Zeilenabstand ist `linesize[i]`, nicht Breite mal Tiefe.**
     NVDEC fuellt auf: 1080p NV12 2048 statt 1920, 1080p P010 4096 statt 3840.
     Bei 1440p sind beide zufaellig gleich — dort faellt der Fehler nicht auf.
   * **Bilder festhalten ist unbedenklich.** Bis 256 gleichzeitig gehaltene
     Bilder faellt der Durchsatz nicht (FFmpegs CUDA-Vorrat waechst dynamisch);
     der Preis sind rund 12 MiB Grafikspeicher je Bild bei 1440p10.
2. ~~**Synchronisierung**~~ — **erledigt, beide Bauarten tragen.**
   `cuImportExternalSemaphore` nimmt ein über `VK_KHR_external_semaphore_fd`
   exportiertes Vulkan-Semaphor an, binär (`OPAQUE_FD`) wie als Zeitlinie
   (`TIMELINE_SEMAPHORE_FD`); keine ist die schwächere, die Zeitlinie ist
   trotzdem die naheliegendere (kein Buchhalten über signalisiert/nicht
   signalisiert, und wgpu-hal fordert `VK_KHR_timeline_semaphore` ohnehin an).
   Probe `../semaphor-kopplung`, Messakte
   `streaming/testbench/profiles/player-2026-08-07-semaphor-kopplung.json`.

   Drei Dinge daran zählen für den Umbau:
   * **Der Aufbauschritt bleibt.** wgpu 29 fordert die Erweiterung nicht an;
     ohne eigenes `VkDevice` führt das Gerät 6 statt 7 Erweiterungen und der
     Weg ist gar nicht erst prüfbar (ausdrücklich gegengeprobt). Der Handweg
     über `hal::vulkan::Adapter::device_from_raw` trägt — **kürzer ist
     `Adapter::open_with_callback`** (`adapter.rs:2834`), dessen Rückruf die
     Erweiterungsliste vor `vkCreateDevice` ergänzen darf.
   * **Die Gegenprobe schlägt an**, und darauf kommt es an: ohne Semaphor sind
     im selben Aufbau 16,9 bis 21,2 Prozent der gelesenen Bytes veraltet, in
     jeder Wiederholung, nie null. Ein sauberer Lauf mit Semaphor heißt deshalb
     wirklich etwas.
   * **Die Rückrichtung ist NICHT belegt.** Dass CUDA auf ein von Vulkan
     signalisiertes Semaphor wartet, ist ein Funktionsnachweis; dass dieses
     Warten ein verfrühtes Überschreiben eines recycelten Puffers verhindert,
     ist es nicht. Wer sie scharf schaltet, baut die Empfindlichkeitsstufe dafür
     nach.

3. **Der Renderer-Umbau (Stück 3)** — Vulkan legt das Zielbild an, CUDA bekommt
   es eingehängt, `cuMemcpy2D` aus `data[i]`/`linesize[i]`, das Bild geht an
   wgpu. Erst hier fällt die Rückholung wirklich weg; alles davor bereitet nur
   vor.

Zwei weitere Auflagen, die zum Umbau gehören und leicht vergessen werden:

* **Die Einfrier-Erkennung verliert ihre Bildpunkte**, sobald die Ebenen nicht
  mehr im Hauptspeicher liegen. Der Fingerabdruck müsste in einen
  Compute-Shader (Reduktion über die Y-Ebene, Rückkanal von 8 Byte, ein bis
  zwei Bilder Verzug — bei 2,5 s Stillstandsschwelle bedeutungslos). Steht als
  Auflage schon in `player-2026-08-06-nv12-wgpu-import.json`.
* **Die Allokationsgröße vom Treiber erfragen**, nicht rechnen (s.o.).

Gemessen ist am **Import** bisher Korrektheit, nicht Tempo. Am **Decoder** ist
das Tempo inzwischen gemessen (1,03 ms je Bild bei 1440p10, s. oben) — dass der
Umbau darüber hinaus auch die 5,26 ms des Bildwegs einspart, ist begründet
erwartet, aber nicht belegt. Ein Lauf mit dem ganzen Player gegen einen echten
Sender hat noch nicht stattgefunden.

Danach steht als eigenes Thema **HDR für Linux/NVIDIA** an (10 bit liegt
bereits vor).
