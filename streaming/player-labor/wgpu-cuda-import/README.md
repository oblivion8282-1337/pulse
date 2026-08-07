# Probe: nimmt wgpu 29 ein fremdes `VkImage` — und behält es dessen Inhalt?

Beantwortet genau eine Frage, nachprüfbar: kommt der Inhalt eines selbst
angelegten, von CUDA beschriebenen `VkImage` unverändert in einer
`wgpu::Texture` an — **in der wgpu-Fassung, die der Player wirklich fährt**
(29.0.4)?

Davon hängt ab, ob der Zero-Copy-Umbau des `pulse-player` unter Linux/NVIDIA
ohne Hauptversionssprung mitten im Renderer auskommt.

**Antwort: ja, uneingeschränkt.** Messakte
`streaming/testbench/profiles/player-2026-08-07-wgpu29-vkimage-import.json`.

## Wie sie sich zu den Nachbarproben verhält

| Probe | fragt |
|---|---|
| `../cuda-vulkan-import` | Teilen sich CUDA und Vulkan denselben Speicher? Kann CUDA in ein exportiertes `VkImage` schreiben? (**ohne** wgpu) |
| **diese** | Nimmt **wgpu 29** so ein Bild entgegen und behält es dessen Inhalt? |
| `../nv12-wgpu-import` (Zweig `feat/hdr-windows-amd`) | Dasselbe für Windows, aber über D3D11-Freigabe statt `VK_KHR_external_memory_fd` — andere Schnittstelle, anderer Ausgang |

**Warum eine eigene Kiste statt einer Erweiterung der Nachbarin.** Jene steht
ausdrücklich *ohne* wgpu, und das ist dort ihre Beweiskraft: ein Fehlschlag muss
eindeutig dem Treiber zuzuordnen sein. Käme wgpu hinzu, brauchte sie eine
wgpu-eigene Vulkan-Instanz und ein anderes Gerät — eine Wiederholung ihrer
Bild-Messung liefe dann nicht mehr auf demselben Aufbau wie ihre Messakte. Der
teure Teil wird trotzdem **nicht** verdoppelt: die von Hand nachgebauten
CUDA-Struct-Layouts kommen per `#[path]` aus der Nachbarkiste, samt ihrem
Selbsttest gegen ein kompiliertes `sizeof`/`offsetof`.

## Bauen und laufen lassen

```bash
cd streaming/player-labor/wgpu-cuda-import
cargo build --release
./target/release/wgpu-cuda-import
```

Braucht kein CUDA-Toolkit (`libcuda.so.1` kommt mit dem Treiber), kein FFmpeg,
keinen Server, kein Fenster. Rückgabewert 0 = der geprüfte Weg trägt.

| Schalter | |
|---|---|
| `SPIKE_BREITE` / `SPIKE_HOEHE` (`2560`/`1440`) | Bildgröße |
| `SPIKE_DEDIZIERT` (`1`) | `0` = ohne `VkMemoryDedicatedAllocateInfo` |
| `SPIKE_LAYOUT_UM` (`1`) | `0` = kein Layout-Wechsel um den CUDA-Zugriff |
| `SPIKE_RUNDEN` (`3`) | Betriebsrunden (Stufe F) |
| `SPIKE_OHNE_SCHREIBEN` (`0`) | **Gegenprobe**, Urteil ist umgedreht |
| `SPIKE_PRUEFSCHICHT` (`0`) | Vulkan-Prüfschicht an (braucht `vulkan-validation-layers`) |
| `SPIKE_VERSTOSS` (`0`) | **Kontrolle**: baut einen echten Regelverstoß ein, den die Schicht melden MUSS |

**Beim Nachfahren einer Matrix gilt die Kopfzeile des Laufs als Beleg, nicht die
eigene Beschriftung.** Sie gibt Auflösung *und* jede Schalterstellung aus. Der
Grund steht unten.

## Der geprüfte Weg

1. wgpu legt Instanz, Adapter und Gerät an (`Backends::VULKAN`).
2. Aus dem wgpu-Gerät werden die rohen Vulkan-Griffe entnommen
   (`as_hal::<Vulkan>`).
3. Auf **diesem** Gerät entsteht ein exportierbares `VkImage`; sein Speicher
   geht per `vkGetMemoryFdKHR` heraus.
4. CUDA hängt ihn ein und schreibt aus Gerätespeicher hinein.
5. Das Bild geht an wgpu: `texture_from_raw` → `create_texture_from_hal`.
6. Ein Compute-Shader tastet **jeden** Texel per `textureLoad` ab; jeder
   Codewert wird gegen den geschriebenen gehalten.

Das Bild muss auf wgpus Gerät entstehen — ein `VkImage` gehört unauflösbar zu
seinem `VkDevice`. Dass das geht, hängt an einer einzigen Zeile in wgpu-hal
29.0.4 (`vulkan/adapter.rs:1296`): dort wird `VK_KHR_external_memory_fd`
angefordert, *wenn* die Karte sie anbietet. Die Probe fragt sie am Gerät ab,
statt sie anzunehmen.

## Der Verdacht, den sie prüft

wgpu-core 29 trägt eine eingehängte Textur als `UNINITIALIZED` ein
(`device/resource.rs:1253`); der Vulkan-Unterbau bildet das auf
`VK_IMAGE_LAYOUT_UNDEFINED` ab (`vulkan/conv.rs:218`). Der erste Zugriff erzeugt
damit einen Übergang aus `UNDEFINED`, und der **darf** den Inhalt verwerfen.

Gemessen: der Mechanismus ist da, die Folge tritt auf dieser Karte nicht ein.
0 von 3686400 Texeln weichen schon beim **ersten** Zugriff ab. „Darf verwerfen"
ist keine Zusage zu verwerfen — und genau deshalb war es zu messen und nicht zu
erwarten.

## Was die Probe absichert

Jede Stufe trägt eine Kontrolle, die zeigt, dass sie *anschlagen kann*.

* **Stufe A** — der Vulkan-eigene Bildweg wird zuerst allein geprüft
  (flächendeckend `0x5A` hinein, sofort zurück). Scheitert er, sagt jede Zahl
  über wgpu nichts.
* **Stufe B** — der CUDA-Inhalt wird **vor** jedem wgpu-Zugriff an wgpu vorbei
  zurückgelesen. Damit kann ein späterer Fehlschlag nicht CUDA zur Last fallen.
* **Stufe C** — dieselbe Prüfung läuft zuerst an einer wgpu-**eigenen** Textur
  mit demselben Inhalt. Sie muss immer stimmen; sonst ist der Abtastweg kaputt.
* **Stufe E** — nach dem wgpu-Zugriff wird der Speicher erneut an wgpu vorbei
  gelesen. Das ist der Trennschnitt, falls Stufe D je schwarz wird: Inhalt weg
  = verworfen, Inhalt da = falscher Speicher gebunden.
* **Stufe F** — der Betriebsfall: CUDA schreibt wiederholt in die bereits
  eingehängte Textur. Selbst wenn das erste Bild verlorenginge, wäre der Weg
  brauchbar, sofern die späteren ankommen.
* **Verfälschter Sollwert** — ein gekipptes Byte muss auffallen.
* **Variante je Runde** — jede Runde schreibt ein anderes Muster und wird
  *zusätzlich* gegen die Erwartung der Vorrunde gehalten. Passte der Inhalt zu
  beiden, wäre der Vergleich blind, und die Probe bricht ab.
* **`SPIKE_OHNE_SCHREIBEN=1`** — CUDA schreibt nicht; das Urteil ist im Programm
  umgedreht, damit die Gegenprobe nicht von Hand ausgelegt werden muss.
* **`SPIKE_VERSTOSS=1`** — ein echter Regelverstoß für die Prüfschicht. Ohne
  ihn wäre „die Schicht meldet nichts" nicht von „niemand hört zu" zu
  unterscheiden.

## Zwei Werkzeugfehler, die dieser Lauf gemacht hat

**Die Schalter griffen nicht.** Drei Auflösungen der Matrix liefen in Wahrheit
alle auf 2560x1440 (ein Schleifen-Aufruf übergab das Paar als *ein* Wort).
Aufgefallen ist es nur an der mitprotokollierten Allokationsgröße, die sich
hätte ändern müssen. Deshalb gibt jeder Lauf seine Schalterstellung aus.

**Die Prüfschicht war stumm.** Erst gar nicht installiert, danach ohne
`log`-Empfänger — beides sah wie ein regelkonformer Lauf aus. Der eingebaute
Kontroll-Verstoß deckte dann einen *echten* Fehler in der Probe auf: Stufe E las
mit einem unzulässigen Layout aus und lieferte trotzdem richtige Zahlen. Ein
Werkzeug, das schweigt, hat drei mögliche Gründe — nur einer davon ist ein
Befund.

## Was daran ungeprüft bleibt

* **Nebenläufigkeit.** Hier wird geschrieben, gewartet, gelesen. Im Betrieb
  schreibt der Decoder, während gezeichnet wird — das verlangt Semaphoren über
  dieselbe Grenze (`VK_KHR_external_semaphore_fd` gegen
  `cuImportExternalSemaphore`). Ein Vorgriff darauf ist gemessen und steht als
  Zeile in jedem Lauf: **wgpu 29 fordert diese Erweiterung nicht an**, obwohl
  die Karte sie anbietet. Wer sie braucht, muss das `VkDevice` selbst anlegen
  und per `hal::vulkan::Adapter::device_from_raw` an wgpu übergeben. Dass der so
  gebaute Weg dann auch trägt, ist **nicht** gemessen —
  `cuImportExternalSemaphore` ist hier nie aufgerufen worden.
* **Der Decoder.** Der Inhalt kommt aus `cuMemAlloc`, nicht aus `av1_cuvid`.
  Ob der Decoder seine Bilder überhaupt als CUDA-Speicher herausgibt, ist eine
  getrennte offene Frage.
* **Tempo.** Gemessen ist Korrektheit. Dass der Umbau die 5,26 ms je Bild
  wirklich einspart, ist begründet erwartet, aber nicht belegt.
