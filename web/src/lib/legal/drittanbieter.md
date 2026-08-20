# Drittanbieter-Software

> **Hinweis:** Diese Seite listet die Drittanbieter-Bibliotheken, die in den
> Pulse-Client-Anwendungen (Desktop unter Windows/macOS/Linux) gebündelt oder
> dynamisch eingebunden werden, sowie die damit verbundenen Lizenzpflichten.
> Keine Rechtsberatung. Für den Server-Betrieb gilt die separate
> [`LICENSE-SERVER.md`](https://github.com/oblivion8282-1337/pulse/blob/main/LICENSE-SERVER.md)
> im Quellcode-Repository.

Der Pulse-Client selbst steht unter der Pulse Client License 1.0 (siehe
`LICENSE-CLIENT.md` im Repository) — nutzen und einsehen erlaubt, ändern und
weitergeben nicht. Einige seiner Bestandteile für das
HQ-Bildschirm-Streaming stammen jedoch von Drittanbietern und bringen eigene
Lizenzbedingungen mit. Für **LGPL-lizenzierte Komponenten** (FFmpeg) erfüllen
wir die Lizenzpflichten wie folgt:

- Die Komponente wird **dynamisch verlinkt** (als eigene DLL/Dylib/Shared-Object
  neben der Pulse-Anwendung), nicht statisch in Pulse einkompiliert.
- Die Datei ist **austauschbar**: Wer eine eigene, kompatible Version der
  Bibliothek bauen möchte, kann die ausgelieferte Datei ersetzen.
- Der **Quellcode** der jeweils verwendeten Version ist über die unten
  verlinkten öffentlichen Quellen erhältlich. Wo Pulse ihn **ändert**, ist das
  in der jeweiligen Tabelle vermerkt, und die Änderung selbst liegt als
  Patch-Datei im öffentlichen Quellcode-Repository — das betrifft das FFmpeg
  der Linux- **und** der Windows-Fassung (jeweils ein Patch, siehe dort). Die
  macOS-Fassung wird unverändert gebaut.

## Windows

| Komponente | Version / Pin | Lizenz | Einbindung |
|---|---|---|---|
| [FFmpeg](https://ffmpeg.org/) | n8.1.2, eigener Build vom 2026-08-05, **mit einem Pulse-Patch** | LGPL 2.1 (Build ohne `--enable-gpl`/`--enable-nonfree`/libx264/libx265) | Dynamisch verlinkt: als separate `.dll`-Dateien neben `pulse-win-hq-sidecar.exe` ausgeliefert |
| [nv-codec-headers](https://github.com/FFmpeg/nv-codec-headers) | n13.0.19.0 | MIT | Nur zur Build-Zeit für NVENC-Unterstützung verwendet, nicht als eigene Datei ausgeliefert |

**Das FFmpeg der Windows-Fassung ist seit dem 5. August 2026 von Pulse
verändert.** Hier stand vorher, Pulse ändere den Quellcode für diesen Pfad
nicht und verwende die unveränderte Distribution von BtbN — das trifft nicht
mehr zu. Der Patch gibt dem AV1-Encoder für AMD-Karten den rollenden
Intra-Refresh frei; ohne ihn steht diese Betriebsart AMD-Nutzern unter Windows
gar nicht zur Verfügung. Die Lizenzpflichten sind erfüllt: geändert werden nur
LGPL-lizenzierte Dateien, der Patch steht selbst unter der LGPL und nicht unter
der Pulse-Lizenz, die Bibliotheken bleiben dynamisch eingebunden und
austauschbar, und der Patch liegt offen im Quellcode-Repository unter
[`streaming/ffmpeg-patches/`](https://github.com/oblivion8282-1337/pulse/tree/main/streaming/ffmpeg-patches).
Dem ausgelieferten Paket liegen zusätzlich der Lizenztext (`LICENSE.txt`) und
ein Änderungshinweis (`PULSE-AENDERUNGEN.txt`) bei.

Die FFmpeg-DLLs enthalten u. a. NVENC/AMF/QSV-Hardware-Encoder, Muxer für
FLV/MPEGTS/WHIP und die TLS-Anbindung über SChannel für den verschlüsselten
RTMPS-Push. Neben ihnen liefert dieser Build die Bibliotheken mit, gegen die er
gebaut ist — jede als eigene, austauschbare Datei:

| Bibliothek | Lizenz |
|---|---|
| [libopus](https://opus-codec.org/) (Audio) | BSD-3-Clause |
| [dav1d](https://code.videolan.org/videolan/dav1d) (AV1-Dekodierung) | BSD-2-Clause |
| [SRT](https://github.com/Haivision/srt) | MPL-2.0 |
| [OpenSSL 3](https://www.openssl.org/) | Apache-2.0 |
| [Intel VPL](https://github.com/intel/libvpl) | MIT |
| GNU libiconv | LGPL-2.1 |
| zlib, xz/liblzma, bzip2, winpthreads | Zlib, 0BSD, BSD, MIT |
| GCC-Laufzeit (`libgcc`, `libstdc++`) | GPL-3.0 **mit GCC Runtime Library Exception** — diese Ausnahme erlaubt das Mitliefern ausdrücklich auch neben Programmen unter anderer Lizenz |

## macOS

| Komponente | Version / Pin | Lizenz | Einbindung |
|---|---|---|---|
| [FFmpeg](https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz) | 8.0.1, eigener Build | LGPL (Build ohne `--enable-gpl`/libx264/libx265) | Dynamisch verlinkt: als `.dylib`-Dateien neben der App gebündelt |
| [dav1d](https://code.videolan.org/videolan/dav1d) (AV1-Dekodierung) | seit 2026-08-20 | BSD-2-Clause | Dynamisch verlinkt, dieselbe `.dylib`-Auslieferung wie oben |

Für macOS wird FFmpeg aus dem unveränderten offiziellen Quell-Tarball selbst
gebaut (statt Homebrews Standard-Build zu verwenden, der GPL-lizenziert wäre),
mit VideoToolbox-Hardware-Encoding, OpenSSL für TLS/RTMPS und
[libopus](https://opus-codec.org/) (BSD-3-Clause) für Audio. Der Quellcode ist
unverändert und über den obigen Link direkt vom FFmpeg-Projekt erhältlich. Seit
dem 2026-08-20 bindet dieser Build zusätzlich [dav1d](https://code.videolan.org/videolan/dav1d)
(BSD-2-Clause) ein: FFmpegs eigener `av1`-Decoder ist ein reiner
Hardware-Stub, und VideoToolbox kann AV1 erst ab der M3-Generation dekodieren
— ohne dav1d könnte der native HQ-Player auf M1/M2-Macs gar kein AV1
anzeigen. dav1d berührt die LGPL-Aufstellung oben nicht, es ist eine eigene
BSD-2-Clause-Datei, dynamisch eingebunden wie die übrigen.

Der native HQ-Player (`streaming/pulse-player/`, siehe unten) linkt seit
Version 0.1.69 gegen dieselben `.dylib`-Dateien wie der Streaming-Sidecar —
`scripts/bundle-dylibs.sh` baut für beide Programme ein gemeinsames Bündel.

## Linux (Flatpak)

| Komponente | Version / Pin | Lizenz | Einbindung |
|---|---|---|---|
| [Electron](https://www.electronjs.org/) | 43.0.0 | MIT | Offizielles Release-Binary, unverändert gebündelt (`/app/electron/`) |
| [FFmpeg](https://github.com/FFmpeg/FFmpeg) | Tag `n8.1.1`, **mit einem Pulse-Patch** | LGPLv3 (Build ohne `--enable-gpl`/libx264/libx265) | Aus Quellcode im Flatpak-Sandbox gebaut, dynamisch verlinkt |
| [gpu-screen-recorder](https://repo.dec05eba.com/gpu-screen-recorder) | gepinnter Commit, mit 3 Pulse-Patches | GPL-3.0-or-later | Aus Quellcode gebaut, als **separates Programm** im Paket enthalten (kein Linking gegen Pulse) |

**Das FFmpeg der Linux-Fassung ist von Pulse verändert.** Hier stand bis zum
5. August 2026 „aus unverändertem Quellcode gebaut" — das trifft nicht mehr zu.
Angewendet wird ein Patch, der den rollenden Intra-Refresh der
VAAPI-Encoder freilegt; ohne ihn steht diese Betriebsart AMD- und
Intel-Grafikkarten nicht zur Verfügung. Was die LGPL dafür verlangt, ist
erfüllt: die Änderung betrifft ausschließlich LGPL-lizenzierte Dateien
(`libavcodec/vaapi_encode*`), sie steht selbst unter der LGPL und nicht unter
der Pulse-Lizenz, die Bibliothek bleibt dynamisch eingebunden und
austauschbar, und der Patch liegt im öffentlichen Quellcode-Repository unter
[`streaming/ffmpeg-patches/`](https://github.com/oblivion8282-1337/pulse/tree/main/streaming/ffmpeg-patches)
mit eigener Lizenzdatei. Die Windows- und macOS-Fassungen enthalten diesen
Patch **nicht**.

Electrons eigene Drittanbieter-Hinweise (Chromium, Node.js u. a.) liegen
bereits als Teil des offiziellen Electron-Release-Archivs bei und werden hier
nicht dupliziert.

Die drei Patches, mit denen Pulse `gpu-screen-recorder` für den eigenen
Anwendungsfall anpasst, verändern ausschließlich dessen Quellcode und sind
damit selbst als Bearbeitung eines GPL-3.0-or-later-Werks lizenziert — Details
und der Patch-Quellcode liegen unter `streaming/patches/` im Repository
(eigene `LICENSE`-Datei dort). `gpu-screen-recorder` wird als eigenständiges,
zur Build-Zeit bezogenes Programm ausgeliefert, nicht mit Pulse verlinkt.

## Nativer HQ-Player (Desktop, optional)

Die Desktop-App kann HQ-Streams in einem eigenen Fenster darstellen statt im
eingebauten Browser-Player — unter Linux (Flatpak), seit Version 0.1.42 auch
unter Windows, und seit Version 0.1.69 auch unter macOS. Ist die Komponente
nicht vorhanden, läuft die Wiedergabe
unverändert im eingebauten Player weiter. Sie bindet die folgenden Bibliotheken
**statisch** ein; sie sind hier aufgeführt, weil auch freizügige Lizenzen eine
Nennung verlangen.

| Komponente | Version | Lizenz |
|---|---|---|
| [webrtc-rs](https://github.com/webrtc-rs/webrtc) (**von Pulse geändert**, siehe unten) | 0.17.2 | MIT oder Apache-2.0 |
| [wgpu](https://github.com/gfx-rs/wgpu) | 29.0.4 | MIT oder Apache-2.0 |
| [winit](https://github.com/rust-windowing/winit) | 0.30.13 | Apache-2.0 |
| [egui](https://github.com/emilk/egui) (mit `egui-wgpu`, `egui-winit`, `egui_extras`) | 0.35.0 | MIT oder Apache-2.0 |
| [resvg](https://github.com/linebender/resvg) / usvg (Symbol-Zeichner) | 0.45.1 | Apache-2.0 oder MIT |
| [tiny-skia](https://github.com/linebender/tiny-skia) | 0.11.4 | BSD-3-Clause |
| [cpal](https://github.com/RustAudio/cpal) | 0.17.3 | Apache-2.0 |
| [ffmpeg-next](https://github.com/zmwangx/rust-ffmpeg) (nur Anbindung) | 8.1.0 | WTFPL |
| [rustls](https://github.com/rustls/rustls) | 0.23.42 | Apache-2.0, ISC oder MIT |
| [aws-lc-rs](https://github.com/aws/aws-lc-rs) | 1.17.3 | ISC, Apache-2.0, MIT, BSD-3-Clause |
| [webpki-root-certs](https://github.com/rustls/webpki-roots) (Wurzelzertifikate) | 1.0.9 | CDLA-Permissive-2.0 |
| [self_cell](https://github.com/Voultapher/self_cell) | 1.3.0 | Apache-2.0 oder GPL-2.0 — Pulse nutzt **Apache-2.0** |
| [ICU4X](https://github.com/unicode-org/icu4x) (`icu_*`, `zerovec`, `tinystr` u. a.) | 2.2.0 | Unicode-3.0 |
| [tokio](https://tokio.rs/) | 1.53.1 | MIT |
| [reqwest](https://github.com/seanmonstar/reqwest) | 0.13.4 | MIT oder Apache-2.0 |

### Eingebettete Schriften und Symbole

Diese liegen fest im Programm, nicht als eigene Dateien daneben — auch dafür
gilt die Nennungspflicht:

| Bestandteil | Herkunft | Lizenz |
|---|---|---|
| Plus Jakarta Sans (Regular, SemiBold) | [tokotype/PlusJakartaSans](https://github.com/tokotype/PlusJakartaSans), Copyright 2020 The Plus Jakarta Sans Project Authors | SIL Open Font License 1.1 |
| Standardschriften von egui (`epaint_default_fonts`, u. a. Ubuntu und Emoji) | [egui](https://github.com/emilk/egui) | SIL Open Font License 1.1 und Ubuntu Font Licence 1.0 |
| Symbole | [Lucide](https://lucide.dev) — Teile stammen aus Feather, Copyright Cole Bemis 2013–2022 (MIT); übrige Copyright Lucide Contributors 2022 | ISC |

### Änderung an webrtc-rs

Pulse verändert zwei Stellen der Fassung 0.17.2 und liefert das Ergebnis
statisch eingebunden aus. Betroffen sind `webrtc/src/dtls_transport/mod.rs`
(Lesezugriff auf Datenströme, deren Kennung zu keiner angemeldeten Spur passt —
dort liegen die Pakete zur Verlustkorrektur) und der NACK-Generator unter
`interceptor/src/nack/generator/`. Dieser Hinweis erfüllt Apache-2.0 §4(b); die
Patch-Dateien liegen mitsamt eigener Lizenzdatei im öffentlichen
Quellcode-Repository unter
[`streaming/pulse-player/patches/`](https://github.com/oblivion8282-1337/pulse/tree/main/streaming/pulse-player/patches).

Für die eigentlichen FFmpeg-Bibliotheken gilt auch hier, was oben steht: Es wird
ein LGPL-Build dynamisch eingebunden und als eigene, austauschbare Datei
ausgeliefert.

---

Stand: 20. August 2026
