# Probe: teilen sich CUDA und Vulkan denselben Speicher? (Linux/NVIDIA)

Beantwortet **eine** Frage, nachprüfbar: kommt ein Inhalt, den CUDA in einen von
Vulkan exportierten Speicher schreibt, dort unverändert an — und umgekehrt?

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
./target/release/cuda-vulkan-import
```

Braucht kein CUDA-Toolkit (`libcuda.so.1` kommt mit dem Treiber), kein FFmpeg,
keinen Server, kein Fenster. Rückgabewert 0 = der Weg trägt.

| Schalter | |
|---|---|
| `SPIKE_BYTES` (`3686400`) | Größe des geteilten Speichers |
| `SPIKE_DEDIZIERT` (`1`) | `0` = ohne `VkMemoryDedicatedAllocateInfo` |

## Was die Probe absichert

Drei Dinge, die kein Selbstzweck sind — jedes fängt eine Fehlerklasse, die in
diesem Labor schon falsche Befunde erzeugt hat:

* **Struct-Layouts gegen `cuda.h`.** Die Beschreibungen werden von Hand
  nachgebaut; ein falscher Feld-Versatz erzeugt keinen Fehler, sondern stille
  Falschergebnisse. Die Größen werden beim Start geprüft.
* **UUID-Abgleich.** Vulkan und CUDA müssen dieselbe Karte meinen. Auf einer
  Maschine mit zwei GPUs schlüge der Import sonst aus einem Grund fehl, der mit
  der Sache nichts zu tun hat.
* **Ein absichtlich verfälschtes Byte muss auffallen.** Ohne diese Kontrolle
  wäre „alles stimmt" nicht von „die Prüfung vergleicht nichts" zu
  unterscheiden.

Das Prüfmuster ist positionsabhängig und bewusst nicht gleichförmig: ein Weg,
der versetzt liest oder nur den Anfang trifft, käme sonst als fehlerfrei durch.
Genau dieser Fehler ist auf der Windows-Seite beim Textur-Stapel aufgetreten.

## Ergebnis

Messakte: `streaming/testbench/profiles/player-2026-08-06-cuda-vulkan-linux.json`

Kurz: **der Weg trägt**, in beiden Richtungen, über alle geprüften Größen bis
4K-P010, mit und ohne dedizierte Allokation, fünf Wiederholungen stabil.

**Was er noch nicht zeigt:** Dies ist ein **Puffer**, keine Textur. Der Player
braucht ein `VkImage` (NV12/P010), das ein Shader abtastet. Ob CUDA direkt in
ein exportiertes Bild schreiben kann (`cuExternalMemoryGetMappedMipmappedArray`)
oder ob eine Puffer→Bild-Kopie dazwischen muss, ist die nächste Frage — und der
Unterschied ist eine GPU-lokale Kopie je Bild.

## Wo wir stehen (Stand 2026-08-06)

Zweig `feat/zero-copy-player-linux`, zwei Commits, **nicht gepusht**.

Erledigt: die Grundfrage. CUDA und Vulkan teilen sich auf Linux/NVIDIA denselben
Speicher — beide Richtungen, bis 4K-P010, fünf Wiederholungen stabil. Damit ist
Zero-Copy hier grundsätzlich möglich, anders als auf Windows/NVIDIA.

**Der nächste Schritt ist der Bild-Import**, und zwar wieder in reinem Vulkan:
ein `VkImage` mit NV12 bzw. P010 statt eines Puffers, exportiert, von CUDA
beschrieben, jeder Bildpunkt geprüft. Erst danach die Anbindung an wgpu.

Die Reihenfolge dahinter ist bewusst so gewählt und sollte nicht umgestellt
werden:

1. **Bild-Import in reinem Vulkan** — braucht kein wgpu, ein Fehlschlag ist
   damit eindeutig dem Treiber zuzuordnen.
2. **Anbindung mit dem heutigen wgpu 29** (`texture_from_raw`). Hält es den
   Inhalt, ist die ganze Update-Frage erledigt.
3. **Erst wenn 29 nachweislich scheitert:** der Sprung auf wgpu 30. Das ist
   eine Kette — wgpu 30 → `egui-wgpu`/`egui-winit` 0.36 → Rust 1.95 (diese
   Maschine hat 1.93.1); Zahlen in der Messakte. Sein Nutzen ist **unbelegt**:
   der einzige einschlägige Neuzugang (`initial_state`) wurde auf der
   Windows-Seite geprüft und als Ursache widerlegt.

Zwei Auflagen, die zum Umbau gehören und leicht vergessen werden:

* **Die Einfrier-Erkennung verliert ihre Bildpunkte**, sobald die Ebenen nicht
  mehr im Hauptspeicher liegen. Der Fingerabdruck müsste in einen
  Compute-Shader (Reduktion über die Y-Ebene, Rückkanal von 8 Byte, ein bis
  zwei Bilder Verzug — bei 2,5 s Stillstandsschwelle bedeutungslos). Steht als
  Auflage schon in `player-2026-08-06-nv12-wgpu-import.json`.
* **Synchronisierung ist ungeprüft.** Hier wird geschrieben, gewartet, gelesen;
  im Betrieb schreibt der Decoder, während gezeichnet wird. Das verlangt
  Semaphoren über dieselbe Grenze (`VK_KHR_external_semaphore_fd` gegen
  `cuImportExternalSemaphore`).

Offen und noch nicht angefasst: ob `av1_cuvid` seine Bilder überhaupt als
CUDA-Speicher herausgibt statt in den Hauptspeicher (FFmpeg-Frage,
`hwaccel_output_format cuda`). Ohne das nützt der schönste Import nichts.

Danach steht als eigenes Thema **HDR für Linux/NVIDIA** an (10 bit liegt
bereits vor).
