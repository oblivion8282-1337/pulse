# Probe: dekodierte D3D11-NV12/P010-Textur ohne Hauptspeicher-Umweg in wgpu

Beantwortet **eine** Frage, nachprüfbar: kommt der Inhalt einer geteilten
D3D11-Textur unverändert in einem wgpu-Renderdurchgang an — **auf dem Backend
und in der wgpu-Fassung, die der `pulse-player` wirklich fährt**?

Davon hängt Zero-Copy im Player ab. Heute nimmt jedes Bild den Weg
GPU → Hauptspeicher → GPU zurück; was das kostet, steht in
`streaming/testbench/profiles/player-2026-08-06-*.json`.

## Fassung und Backend — der wichtigste Absatz

**Hier stand bis zum 2026-08-06 „die Probe braucht wgpu 30" und sie maß
ausschließlich über Vulkan. Beides ist für die Frage, um die es geht, falsch**,
und der Fehler hat bereits einen Anlauf gekostet:

* Der Player steht auf **wgpu 29.0.4**, nicht 30.
* Der Player fährt unter Windows seit dem 2026-08-06 **D3D12**
  (`render/setup.rs::backends`) — und zwar zwingend, weil sich nur dort der
  HDR-Farbraum des Fensters anmelden lässt.
* `texture_from_d3d11_shared_handle` gibt es in wgpu-hal 29.0.4 **ausschließlich**
  im Vulkan-Backend. Auf D3D12 führt der Weg über `ID3D12Device::OpenSharedHandle`
  plus `wgpu_hal::dx12::Device::texture_from_raw` — ein anderer Weg, kein
  Umbenennen.

Die frühere Begründung für wgpu 30 (dort nimmt `create_texture_from_hal` einen
`initial_state` entgegen) **ist widerlegt**: die volle Matrix aus zwei
Teilungsarten × drei Anfangszuständen × wgpu 29 und 30 hat gezeigt, dass der
Zustand überhaupt nicht die entscheidende Größe ist — auf AMD kommt der Inhalt
selbst bei ausdrücklich angefordertem `UNINITIALIZED` an, auf NVIDIA in keiner
Variante. Der Schalter `SPIKE_ZUSTAND` ist deshalb weggefallen; wer die
Zustandsfrage erneut aufgreift, kostet sich einen Abend.

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
| `SPIKE_BACKEND` (`dx12`) | `vulkan` = der Vergleichsarm |
| `SPIKE_FORMAT` (`nv12`) | `p010` = 10 bit |
| `SPIKE_SCHICHTEN` (`1`) | Größe des Textur-Stapels (1 = Einzeltextur) |
| `SPIKE_SCHICHT` (letzte) | welche Schicht abgetastet wird |
| `SPIKE_MUTEX` (`1`) | `0` = `NTHANDLE\|SHARED` statt `NTHANDLE\|KEYEDMUTEX` |
| `SPIKE_DECODER` (`0`) | `1` = `BIND_DECODER` auch bei Einzeltextur (FFmpegs Bauart) |
| `SPIKE_WIEDERHOLT` (`3`) | Runden mit neuem Inhalt nach dem Einhängen (Stufe 4b) |
| `SPIKE_PRUEFSCHICHT` (`0`) | `1` = Prüfschicht an |
| `SPIKE_GEGENRICHTUNG` (`0`) | `1` = zusätzlich aus wgpu schreiben und mit D3D11 lesen |

**Die Vorgabe ist jetzt D3D12**, nicht mehr Vulkan: ein nackter Lauf soll die
Lage des Produkts messen, nicht die einer Nebenstraße. `SPIKE_SCHICHT` zeigt
weiter auf die **letzte** Schicht — ein Weg, der immer Schicht 0 liest, fiele
sonst nicht auf.

## Stand 2026-08-06, nachmittags (Radeon 780M, D3D12, wgpu 29)

Messakte `streaming/testbench/profiles/player-2026-08-06-zerocopy-d3d12-amd.json`.

**Die Einzeltextur trägt, in jeder geprüften Bauart.** NV12 und P010, mit und
ohne Schlüssel-Mutex, mit und ohne `BIND_DECODER`: 0 von 4096 Bildpunkten
abweichend. Import in 0,46–0,73 ms. Ebenen als `Plane0`/`Plane1` — der Shader
des Players müsste sich nicht ändern.

**Der Betriebsfall trägt auch.** Neu in dieser Fassung ist Stufe 4b: die
D3D11-Textur wird nach dem Einhängen dreimal mit neuem Inhalt überschrieben und
jedes Mal erneut durch wgpu abgetastet. Alle Runden fehlerfrei, auf beiden
Backends. Damit ist ausgeschlossen, dass der Import eine Momentaufnahme hält —
die Sorte Fehler, die im Player als eingefrorenes erstes Bild erschiene.

**Der Textur-Stapel trägt auf D3D12 nicht, und zwar härter als auf Vulkan.**
`OpenSharedHandle` auf eine geteilte NV12- oder P010-Textur mit `ArraySize > 1`
gibt `DXGI_ERROR_DEVICE_REMOVED` (0x887A0005) zurück — das Gerät ist danach weg.
Geprüft mit 2 und 4 Schichten, beide Formate. Auf Vulkan war derselbe Fall
still falsch (Schicht 0 gut, jede weitere um den Schichtabstand daneben); hier
stirbt der Kontext. **Ein Player darf das also nicht einmal versuchen** — ein
Fehlschlag ist hier nicht abfangbar wie ein falsches Bild.

## Der Weg, den die frühere Akte empfahl, gibt es nicht

`player-2026-08-06-p010-und-stapel` empfahl als „wahrscheinlich kürzesten Weg",
den Stapel zu vermeiden: FFmpegs D3D11VA-Pool könne mit `initial_pool_size = 0`
je Bild eine eigene Textur anlegen (`d3d11va_alloc_single`). **Das gilt für den
Encoder-Pool des Sidecars, nicht für den Decoder.** Nachgesehen in FFmpeg n8.1
(`libavcodec/dxva2.c`):

* `d3d11va_create_decoder`, Zeile 482: `if (!frames_hwctx->texture) { "AVD3D11VAFramesContext.texture not set."; return AVERROR(EINVAL); }` — ohne
  Array-Textur legt der Decoder gar nicht erst an.
* `get_surface`, Zeile 761: jedes Bild wird gegen `sctx->d3d11_texture`
  geprüft und über `frame->data[1]` in `d3d11_views[]` indiziert. Einzeltexturen
  ergäben je Bild ein anderes `data[0]` → „get_buffer frame is invalid!".

**Folge für den Player:** er bekommt zwingend einen Stapel, und den darf er
nicht teilen. Der gangbare Weg ist deshalb nicht „den Decoder-Pool teilen",
sondern: die Schicht des dekodierten Bildes GPU-intern per
`CopySubresourceRegion` in eine **eigene, einschichtige, geteilte** Textur
kopieren und diese in wgpu einhängen. Genau die Bauart, die diese Probe als
tragend misst — und genau die, die `streaming/win-hq-sidecar/src/capture/wgc_d3d12.rs`
für die Aufnahmerichtung bereits fährt. Kein PCIe-Rückweg, keine CPU-Kopie.

## Frühere Stände (Vulkan) — gelten weiter, aber nur für Vulkan

* **2026-08-06, RTX 5080:** Stufen 1–3 gelingen, **Stufe 4 kommt schwarz**, in
  der ganzen Matrix. Übrig bleibt der Verdacht aus
  `vulkan-2026-08-01-d3d11-import-zerocopy`: der Speichertyp muss zu **Bild UND
  Handle** passen, wgpus Helfer nimmt nur die Anforderungen des Bildes plus
  `DEVICE_LOCAL`.
* **2026-08-06, Radeon 780M:** es trägt, 4096 von 4096, in allen sechs Läufen.
  Der Unterschied ist also der **Treiber**, nicht wgpu.
* **2026-08-06, P010 und Stapel:** P010 trägt; der Stapel nicht — Schicht 0 gut,
  jede weitere um den Schichtabstand verschoben.

Auf NVIDIA ist damit weiterhin **beides** offen: der Vulkan-Weg ist dort
schwarz, der D3D12-Weg ungemessen (keine NVIDIA-Karte an dieser Maschine). Der
Player braucht den Rückfall auf das Rücklesen ohnehin.

## Was diese Probe NICHT zeigt

* **Nebenläufige Synchronisierung.** Stufe 4b schreibt und liest abwechselnd auf
  EINEM Thread. Im Betrieb schreibt der Decoder, während gezeichnet wird.
* **NVIDIA und Intel.** Nur auf einer Radeon 780M gemessen.

**Falle beim Nachstellen:** PowerShell meldet den geglückten Bau als Fehler
(Rückgabewert 255) — Windows PowerShell 5.1 wertet jede stderr-Zeile eines
nativen Programms als Fehlerdatensatz, und zwei harmlose cargo-Warnungen
genügen. Über die Bash starten, oder den Rückgabewert getrennt prüfen.
