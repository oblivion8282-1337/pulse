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

## Wo wir stehen (Stand 2026-08-07, abends)

Zweig `feat/zero-copy-player-linux`.

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

1. **`av1_cuvid`**: gibt der Decoder seine Bilder als CUDA-Speicher heraus
   (`hwaccel_output_format cuda` / `AV_PIX_FMT_CUDA`) statt in den
   Hauptspeicher? Ohne das nützt der schönste Import nichts. Einstieg:
   `streaming/pulse-player/src/decode.rs`.
2. **Synchronisierung**: `VK_KHR_external_semaphore_fd` gegen
   `cuImportExternalSemaphore` — im Betrieb schreibt der Decoder, während
   gezeichnet wird. **Dazu ist schon etwas gemessen, und es kostet einen
   Aufbauschritt:** wgpu 29 fordert diese Erweiterung *nicht* an (anders als
   `VK_KHR_external_memory_fd`), obwohl die Karte sie anbietet. Der Player
   müsste sein `VkDevice` dafür selbst anlegen und per
   `hal::vulkan::Adapter::device_from_raw` an wgpu übergeben. Am hier
   gemessenen Bild-Import ändert das nichts. Einzelheiten unter
   `vorgriff_synchronisierung` in der wgpu-Messakte.

Zwei weitere Auflagen, die zum Umbau gehören und leicht vergessen werden:

* **Die Einfrier-Erkennung verliert ihre Bildpunkte**, sobald die Ebenen nicht
  mehr im Hauptspeicher liegen. Der Fingerabdruck müsste in einen
  Compute-Shader (Reduktion über die Y-Ebene, Rückkanal von 8 Byte, ein bis
  zwei Bilder Verzug — bei 2,5 s Stillstandsschwelle bedeutungslos). Steht als
  Auflage schon in `player-2026-08-06-nv12-wgpu-import.json`.
* **Die Allokationsgröße vom Treiber erfragen**, nicht rechnen (s.o.).

Gemessen ist bisher **Korrektheit, nicht Tempo** — dass der Umbau die 5,26 ms je
Bild wirklich einspart, ist begründet erwartet, aber nicht belegt.

Danach steht als eigenes Thema **HDR für Linux/NVIDIA** an (10 bit liegt
bereits vor).
