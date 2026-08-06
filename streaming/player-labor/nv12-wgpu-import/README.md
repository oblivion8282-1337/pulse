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

## Stand 2026-08-06, morgens (Radeon 780M, Vulkan): **es trägt**

Die offene Frage von oben — Treiber oder wgpu — ist entschieden: **es ist der
Treiber.** Auf der Radeon 780M kommt der Inhalt vollständig an, 4096 von 4096
Bildpunkten, und zwar in **allen sechs** Läufen der Matrix (beide Teilungsarten,
alle drei Anfangszustände, dazu die Gegenrichtung). Auf NVIDIA war dieselbe
Matrix ausnahmslos schwarz. Import in 0,65–0,74 ms. Probe unverändert
übernommen, kein Codeeingriff. Messakte
`streaming/testbench/profiles/player-2026-08-06-nv12-wgpu-import-amd.json`.

**Der aussagekräftigste Einzelfall ist `SPIKE_ZUSTAND=uninit`.** Genau dieser
Zustand stand auf NVIDIA im Zentrum der widerlegten Erklärung — ein Übergang aus
`UNDEFINED` *darf* den Inhalt verwerfen. Auf AMD verwirft er ihn nicht, auch
wenn man es ausdrücklich anfordert. Das Verhalten ist also erlaubt, aber nicht
vorgeschrieben, und die beiden Treiber entscheiden es verschieden. Die
Widerlegung bleibt damit richtig, ihr Grund wird nur klarer: der Zustand ist
überhaupt nicht die entscheidende Größe.

Was daraus folgt, ist unbequemer als ein einfaches „geht":

* **Auf AMD** steht der Weg über wgpus eigenen Helfer offen. Kein Eigenbau,
  kein Speichertyp aus der Schnittmenge, kein rohes Vulkan.
* **Auf NVIDIA** bleibt es offen. Der nächste Schritt dort ist der Eigenbau-
  Import aus `vulkan-2026-08-01-d3d11-import-zerocopy` — nicht mehr die
  Zustands-Frage.
* **Der Player müsste also beides können**: importieren, wo es geht, und
  herunterladen, wo nicht. Das ist mehr Arbeit als „einmal umbauen", aber es ist
  die Lage und keine Entscheidung.

**Falle beim Nachstellen:** PowerShell meldet den geglückten Bau als Fehler
(Rückgabewert 255) — Windows PowerShell 5.1 wertet jede stderr-Zeile eines
nativen Programms als Fehlerdatensatz, und zwei harmlose cargo-Warnungen
genügen. Über die Bash starten, oder den Rückgabewert getrennt prüfen.

## Was diese Probe NICHT zeigt

* **Synchronisierung.** Hier wird einmal geschrieben und danach nur gelesen. Im
  Betrieb schreibt der Decoder, während gezeichnet wird.
* **Der Decoder liefert ein Textur-ARRAY** (eine Schicht je Bild), nicht wie
  hier eine Einzeltextur. Für den Player ist das der bequemere Fall — er liest
  nur, und FFmpeg reicht den Schichtindex in `AVFrame.data[1]` mit —, geprüft
  ist es trotzdem nicht.
* **10 bit (P010)** ist ein anderes Format und hier ungeprüft. Der Speicher-
  Import dafür ist in der Akte vom 1. August belegt, der Abtastweg nicht.
