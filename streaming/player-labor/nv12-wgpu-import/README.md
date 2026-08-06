# Probe: dekodierte D3D11-NV12-Textur ohne Hauptspeicher-Umweg in wgpu

Beantwortet **eine** Frage, nachprüfbar: kommt der Inhalt einer geteilten
D3D11-NV12-Textur unverändert in einem wgpu-Renderdurchgang an?

Davon hängt Zero-Copy im `pulse-player` ab. Heute nimmt jedes Bild den Weg
GPU → Hauptspeicher → GPU zurück; was das kostet, steht in
`streaming/testbench/profiles/player-2026-08-06-*.json` (1,5 ms je Bild bei
1080p8, 5,3 ms bei 1440p10).

## Warum eigenständig und nicht im `win-hq-labor`

Die Probe braucht **wgpu 30**; der Player steht auf 29.0.4 und das Labor hat
wgpu gar nicht. Sie hier anzuhängen hieße, dort eine Abhängigkeit aufzunehmen,
die mit dem Produkt nichts zu tun hat. Deshalb eine eigene Crate, **kein**
Workspace-Mitglied — sie berührt kein Bauziel des Produkts, und ein Fehlschlag
hier kann nichts brechen.

## Bauen und laufen lassen

```
cd streaming/player-labor/nv12-wgpu-import
cargo build --release
./target/release/nv12-import
```

Braucht kein FFmpeg, kein libclang, keinen Server — nur Rust und Windows.
Rückgabewert 0 = der Weg trägt, sonst siehe Urteil in der Ausgabe.

Schalter (alle über die Umgebung, Vorgabe in Klammern):

| | |
|---|---|
| `SPIKE_MUTEX` (`1`) | `0` = `NTHANDLE\|SHARED` statt `NTHANDLE\|KEYEDMUTEX` |
| `SPIKE_ZUSTAND` (`general`) | `resource` \| `uninit` — der `initial_state` für wgpu |
| `SPIKE_PRUEFSCHICHT` (`0`) | `1` = Vulkan-Prüfschicht an |
| `SPIKE_GEGENRICHTUNG` (`0`) | `1` = zusätzlich aus Vulkan schreiben und mit D3D11 lesen |

## Stand 2026-08-06 (RTX 5080, Vulkan)

Stufen 1–3 gelingen: NV12 und externer Speicher sind da, der Import läuft in
0,09–0,18 ms, die Ebenen-Ansichten `Plane0`/`Plane1` als R8/Rg8 passen **genau**
auf den vorhandenen Shader des Players — der müsste sich nicht ändern.

**Stufe 4 kommt schwarz.** Alle 4096 Bildpunkte null, während die Rückprobe über
D3D11 den Inhalt jedes Mal vollständig in der Textur findet. Durchgespielt wurde
die volle Matrix — zwei Teilungsarten × drei Anfangszustände × wgpu 29 und 30 —
ausnahmslos schwarz.

**Eine Erklärung ist dabei widerlegt worden**, und das ist der Grund, warum die
Schalter stehen bleiben: wgpu 29 trägt jede eingehängte Textur als
`UNINITIALIZED` ein (`wgpu-core/src/device/resource.rs:1253`), das wird zu
`VK_IMAGE_LAYOUT_UNDEFINED` (`wgpu-hal vulkan/conv.rs:218`), und ein Übergang
von dort darf den Inhalt verwerfen. Das schien die Ursache. wgpu 30 lässt den
Zustand ausdrücklich angeben — und es ändert **nichts**. Die Vermutung war
falsch; wer sie erneut aufgreift, kostet sich einen Abend.

Übrig bleibt der Verdacht, den die Akte `vulkan-2026-08-01-d3d11-import-zerocopy`
nahelegt: der Speichertyp muss zu **Bild UND Handle** passen
(`vkGetMemoryWin32HandlePropertiesKHR`, dort `0x1111`). wgpus Helfer nimmt nur
die Anforderungen des Bildes plus `DEVICE_LOCAL`
(`wgpu-hal vulkan/device.rs:578`). Jene Probe hat den Import **erfolgreich**
gemacht — mit rohem Vulkan, nicht über wgpu.

## Was auf einer AMD-Karte als Erstes zu tun ist

Die geglückte Messung vom 1. August lief auf einer **Radeon 780M**, die
gescheiterte hier auf **NVIDIA**. Es ist also offen, ob der Befund am Treiber
hängt oder an wgpu.

1. Die Probe unverändert laufen lassen. Kommt Stufe 4 grün, ist es ein
   NVIDIA-Befund und der Weg über wgpus Helfer steht auf AMD offen.
2. Kommt sie ebenfalls schwarz, ist es wgpu — dann ist der Weg der, den das
   Labor schon gegangen ist: Import von Hand (Speichertyp aus der Schnittmenge),
   danach `texture_from_raw` + `create_texture_from_hal(initial_state)`.

Beides bitte in eine Messakte, nicht nur in die Erinnerung.

## Was diese Probe NICHT zeigt

* **Synchronisierung.** Hier wird einmal geschrieben und danach nur gelesen. Im
  Betrieb schreibt der Decoder, während gezeichnet wird.
* **Der Decoder liefert ein Textur-ARRAY** (eine Schicht je Bild), nicht wie
  hier eine Einzeltextur. Für den Player ist das der bequemere Fall — er liest
  nur, und FFmpeg reicht den Schichtindex in `AVFrame.data[1]` mit —, geprüft
  ist es trotzdem nicht.
* **10 bit (P010)** ist ein anderes Format und hier ungeprüft. Der Speicher-
  Import dafür ist in der Akte vom 1. August belegt, der Abtastweg nicht.
