# Drittanbieter-Software

> **Hinweis:** Diese Seite listet die Drittanbieter-Bibliotheken, die in den
> Pulse-Client-Anwendungen (Desktop unter Windows/macOS/Linux) gebündelt oder
> dynamisch eingebunden werden, sowie die damit verbundenen Lizenzpflichten.
> Keine Rechtsberatung. Für den Server-Betrieb gilt die separate
> [`LICENSE-SERVER.md`](https://github.com/oblivion8282-1337/pulse/blob/main/LICENSE-SERVER.md)
> im Quellcode-Repository.

Der Pulse-Client selbst steht unter der PolyForm-Perimeter-Lizenz (siehe
`LICENSE-CLIENT.md` im Repository). Einige seiner Bestandteile für das
HQ-Bildschirm-Streaming stammen jedoch von Drittanbietern und bringen eigene
Lizenzbedingungen mit. Für **LGPL-lizenzierte Komponenten** (FFmpeg) erfüllen
wir die Lizenzpflichten wie folgt:

- Die Komponente wird **dynamisch verlinkt** (als eigene DLL/Dylib/Shared-Object
  neben der Pulse-Anwendung), nicht statisch in Pulse einkompiliert.
- Die Datei ist **austauschbar**: Wer eine eigene, kompatible Version der
  Bibliothek bauen möchte, kann die ausgelieferte Datei ersetzen.
- Der **Quellcode** der jeweils verwendeten Version ist unverändert und über
  die unten verlinkten öffentlichen Quellen erhältlich.

## Windows

| Komponente | Version / Pin | Lizenz | Einbindung |
|---|---|---|---|
| [FFmpeg](https://ffmpeg.org/) (BtbN-Distribution) | n8.1, LGPL-shared-Build vom 2026-06-16 | LGPL (Build ohne libx264/libx265) | Dynamisch verlinkt: als separate `.dll`-Dateien neben `pulse-win-hq-sidecar.exe` ausgeliefert |
| [nv-codec-headers](https://github.com/FFmpeg/nv-codec-headers) | n13.0.19.0 | MIT | Nur zur Build-Zeit für NVENC-Unterstützung verwendet, nicht als eigene Datei ausgeliefert |

Die FFmpeg-DLLs enthalten u. a. NVENC/AMF/QSV-Hardware-Encoder, Muxer für
FLV/MPEGTS, [libopus](https://opus-codec.org/) (BSD-3-Clause) für die
Audio-Kodierung und die TLS-Anbindung über SChannel für den verschlüsselten
RTMPS-Push. Pulse ändert den FFmpeg-Quellcode für diesen Pfad nicht — es wird
die unveränderte, von [BtbN](https://github.com/BtbN/FFmpeg-Builds) gebaute
Distribution verwendet, deren Ursprung wiederum das öffentliche
[FFmpeg-Projekt](https://github.com/FFmpeg/FFmpeg) ist.

## macOS

| Komponente | Version / Pin | Lizenz | Einbindung |
|---|---|---|---|
| [FFmpeg](https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz) | 8.0.1, eigener Build | LGPL (Build ohne `--enable-gpl`/libx264/libx265) | Dynamisch verlinkt: als `.dylib`-Dateien neben der App gebündelt |

Für macOS wird FFmpeg aus dem unveränderten offiziellen Quell-Tarball selbst
gebaut (statt Homebrews Standard-Build zu verwenden, der GPL-lizenziert wäre),
mit VideoToolbox-Hardware-Encoding, OpenSSL für TLS/RTMPS und
[libopus](https://opus-codec.org/) (BSD-3-Clause) für Audio. Der Quellcode ist
unverändert und über den obigen Link direkt vom FFmpeg-Projekt erhältlich.

## Linux (Flatpak)

| Komponente | Version / Pin | Lizenz | Einbindung |
|---|---|---|---|
| [Electron](https://www.electronjs.org/) | 43.0.0 | MIT | Offizielles Release-Binary, unverändert gebündelt (`/app/electron/`) |
| [FFmpeg](https://github.com/FFmpeg/FFmpeg) | Tag `n8.1.1` | LGPLv3 (Build ohne `--enable-gpl`/libx264/libx265) | Aus unverändertem Quellcode im Flatpak-Sandbox gebaut, dynamisch verlinkt |
| [gpu-screen-recorder](https://repo.dec05eba.com/gpu-screen-recorder) | gepinnter Commit, mit 3 Pulse-Patches | GPL-3.0-or-later | Aus Quellcode gebaut, als **separates Programm** im Paket enthalten (kein Linking gegen Pulse) |

Electrons eigene Drittanbieter-Hinweise (Chromium, Node.js u. a.) liegen
bereits als Teil des offiziellen Electron-Release-Archivs bei und werden hier
nicht dupliziert.

Die drei Patches, mit denen Pulse `gpu-screen-recorder` für den eigenen
Anwendungsfall anpasst, verändern ausschließlich dessen Quellcode und sind
damit selbst als Bearbeitung eines GPL-3.0-or-later-Werks lizenziert — Details
und der Patch-Quellcode liegen unter `streaming/patches/` im Repository
(eigene `LICENSE`-Datei dort). `gpu-screen-recorder` wird als eigenständiges,
zur Build-Zeit bezogenes Programm ausgeliefert, nicht mit Pulse verlinkt.

---

Stand: 26. Juli 2026

## Nativer HQ-Player (Desktop, optional)

Die Desktop-App kann HQ-Streams optional in einem eigenen Fenster darstellen
statt im eingebauten Browser-Player. Diese Komponente bindet die folgenden
Bibliotheken statisch ein; sie sind hier aufgeführt, weil auch ihre freizügigen
Lizenzen eine Nennung verlangen.

| Komponente | Version | Lizenz |
|---|---|---|
| [webrtc-rs](https://github.com/webrtc-rs/webrtc) | 0.17.2 | MIT oder Apache-2.0 |
| [wgpu](https://github.com/gfx-rs/wgpu) | 29.0.4 | MIT oder Apache-2.0 |
| [winit](https://github.com/rust-windowing/winit) | 0.30.13 | Apache-2.0 |
| [egui](https://github.com/emilk/egui) (mit `egui-wgpu`, `egui-winit`) | 0.35.0 | MIT oder Apache-2.0 |
| [cpal](https://github.com/RustAudio/cpal) | 0.17.3 | Apache-2.0 |
| [ffmpeg-next](https://github.com/zmwangx/rust-ffmpeg) (nur Anbindung) | 8.1.0 | WTFPL |
| [rustls](https://github.com/rustls/rustls) | 0.23.42 | Apache-2.0, ISC oder MIT |
| [aws-lc-rs](https://github.com/aws/aws-lc-rs) | 1.17.3 | ISC, Apache-2.0, MIT, BSD-3-Clause |
| [tokio](https://tokio.rs/) | 1.53.1 | MIT |
| [reqwest](https://github.com/seanmonstar/reqwest) | 0.13.4 | MIT oder Apache-2.0 |

Für die eigentlichen FFmpeg-Bibliotheken gilt auch hier, was oben steht: Es wird
ein LGPL-Build dynamisch eingebunden und als eigene, austauschbare Datei
ausgeliefert.
