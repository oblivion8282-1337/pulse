# pulse-player — nativer HQ-Stream-Player

Zeigt einen HQ-Stream (WHEP von MediaMTX) in einem **eigenen Fenster** an, statt
ihn durch Chromiums Compositor zu schicken. Gesteuert wird er von Electron ueber
dasselbe stdio-JSON-RPC wie die HQ-Capture-Sidecars.

**Er ist additiv.** Browser-Nutzer und jede Installation ohne dieses Binary
bekommen den Stream unveraendert ueber `web/src/lib/stream/components/WhepPlayer.svelte`
im `<video>`-Element. Der Player ist ein Opt-in fuer die Electron-App.

## Warum es ihn gibt

Gemessen am 2026-07-26 auf der Dev-Maschine (RTX 5080, CachyOS, KWin 6.7.3):

| Befund | Messung |
|---|---|
| Chromium legt seinen Wayland-Puffer immer als `ABGR8888` an | 8 bit pro Kanal — in SDR, mit `--force-color-profile=scrgb-linear`, **und** mit aktivem HDR |
| Im HDR-Fall signalisiert Chromium PQ, liefert aber weiter 8 bit | `set_tf_named(11)` bei `AB24`-Puffer |
| KWin bietet daneben hoehere Formate an | Scanout-Ebene lief auf `AB30` (10 bit) bzw. `AB4H` (fp16) |
| Chromium nutzt auf Linux/NVIDIA kein NVDEC | `nvidia-smi dmon` zeigte `dec` durchgehend 0 %, auch mit VA-API-Flags; ~4,6 s CPU-Zeit in 10 s |

Die 8 bit sind also Chromiums Wahl, nicht die Grenze des Systems. Dieser Player
trifft beide Entscheidungen — Pufferformat und Decoder — selbst.

Verwandter Bug im Chromium-Tracker: *Severe banding on Wayland with HDR enabled*
(Issue 503402063). Titel passt zum Befund; Inhalt und Status waren ohne Login
nicht einsehbar.

## Was er kann

- **WHEP** wie der Browser-Client: nicht-Trickle, `POST` mit `application/sdp`,
  Resource-URL aus `Location`, `DELETE` beim Abbau. Die URL traegt bereits
  `?token=` und wird unveraendert durchgereicht.
- **AV1 und H.264**, Hardware-Decoder zuerst (`av1_cuvid`, `h264_cuvid`, `*_qsv`,
  `*_vaapi`), Software als Rueckfall.
- **Ausgabe mit mehr als 8 bit**, wenn der Compositor es anbietet: bevorzugt
  `Rgba16Float`, dann `Rgb10a2Unorm`, sonst 8 bit. Das tatsaechlich verhandelte
  Format steht in `stats.surface_format` — damit ist von aussen belegbar, was
  anliegt.
- **Debanding** im Shader. Wirkt auch bei 8-bit-Quellen und ist damit der
  staerkste Bildhebel, ohne die Encode-Kette anzufassen.
- **Einstellbarer Jitter-Puffer.** Die Fernsteuerungs-Messung ergab, dass 5-15 ms
  reichen; Chromiums WebRTC-Puffer laesst sich nicht dorthin zwingen.
- **Zoom und Pan** aus dem dekodierten Vollbild, nicht aus einem bereits
  herunterskalierten Fensterinhalt.
- **Standbild ohne Verbindungsabbruch** (`paused`): die Sitzung laeuft weiter.
- **Tonausgabe**: Opus wird dekodiert, auf die Rate des Ausgabegeraets gebracht
  und ueber cpal ausgegeben. `volume` wirkt inklusive Verstaerkung ueber 100 %,
  `av_offset_ms` als Ziel-Fuellstand des Ausgabepuffers. Laesst sich kein Geraet
  oeffnen, laeuft die Wiedergabe stumm weiter statt zu scheitern.
- **Mitschnitt ohne Neukodierung** (`record`/`stop_record`): der ankommende
  Bitstrom wird direkt nach Matroska gemuxt — Bild und Ton in einer Datei.
- **Clip der letzten Sekunden** (`clip`): ein Ringpuffer haelt 60 s vor, auch
  wenn nicht aufgenommen wird. Der Schnitt beginnt am letzten Keyframe davor,
  sonst waere der Anfang unbrauchbar.
- **Ehrliche Statistik**: empfangene, verlorene, umsortierte und doppelte Pakete,
  dekodierte und verworfene Frames, Pufferfuellstand, gewaehlter Decoder,
  Hardware ja/nein, Oberflaechenformat, dazu Ton-Unterlaeufe und Puffer-Stand
  sowie Aufnahmezustand und verfuegbare Clip-Sekunden.

## Was er noch NICHT kann

Ehrlich benannt, damit niemand danach sucht:

- **Keine echte A/V-Synchronisierung.** Bild und Ton laufen getrennt: das Bild
  wird gezeigt, sobald es dekodiert ist, der Ton so schnell, wie das Geraet ihn
  abholt. `av_offset_ms` verschiebt nur den Fuellstand des Ausgabepuffers. Eine
  saubere Kopplung braeuchte eine gemeinsame Uhr aus den RTP-Zeitstempeln
  (`clock_rate` liegt dafuer schon bereit). Wie weit das in der Praxis
  auseinanderlaeuft, ist ungemessen.
- **Kein Standbild-Export.** Der Frame liegt vor, ein PNG-Encoder fehlt noch.
- **Kein zero-copy.** Die cuvid-Decoder liefern in den Hauptspeicher, von dort
  wird in GPU-Texturen hochgeladen. Ein direkter Weg NVDEC -> Vulkan-Textur
  braeuchte `hw_frames_ctx` samt Interop.
- **Nur unter Linux getestet.** Die Crate ist plattformneutral geschrieben
  (winit/wgpu/FFmpeg), Windows und macOS sind aber ungeprueft.
- **AV1-Depacketisierung ist nur durch Unit-Tests abgesichert**, nicht gegen
  einen echten Stream. Siehe unten.

## Aufbau

```
src/
├── main.rs        Einstiegspunkt: Fensterschleife (winit) + Tokio-Laufzeit
├── app/           Fenster- und Sitzungsverwaltung
│   ├── mod.rs     Sitzungen anlegen/schliessen, winit-Ereignisse
│   └── requests.rs  was die einzelnen RPC-Operationen bedeuten
├── rpc.rs         stdio-Transport (stdin lesen, stdout schreiben)
├── proto.rs       Protokolltypen, Optionen, Grenzen
├── whep.rs        WHEP-Aushandlung, liefert rohe RTP-Pakete
├── jitter.rs      Umsortieren nach Sequenznummer + zeitgesteuerte Freigabe
├── depacket/      Zusammensetzen von Zugriffseinheiten
│   ├── mod.rs     H.264 (ueber das rtp-Crate) und Opus
│   └── av1.rs     AV1 — SELBST GESCHRIEBEN, s. u.
├── decode.rs      FFmpeg, Hardware zuerst
├── audio.rs       Opus-Decode + cpal-Ausgabe auf eigenem Thread
├── recorder.rs    Matroska-Mux ohne Neukodierung + Clip-Ringpuffer
├── mediasink.rs   buendelt Ton und Mitschnitt je Einheit
├── render/        wgpu-Darstellung
│   ├── mod.rs     Texturen, Uniform-Werte, Zeichnen
│   ├── setup.rs   Geraet, Pipeline, Wahl des Oberflaechenformats
│   ├── uniforms.rs  Uniform-Block als Bytes
│   └── shader.wgsl  YUV->RGB, Deband, Dither, Zoom
└── session.rs     verbindet alles je Sitzung
```

Die Reihenfolge WHEP -> Jitter -> Depacket -> Decode ist bewusst so aufgetrennt.
`webrtc::media::SampleBuilder` haette Umsortieren und Zusammensetzen in einem
Schritt erledigt, versteckt dabei aber genau die Pufferentscheidung, die hier
einstellbar sein soll.

### AV1: eigener Depacketizer

Das `rtp`-Crate (0.17) liefert fuer AV1 nur einen *Payloader*, keinen
Depacketizer. Da AV1 der Standard-Codec ist (`settings.svelte.ts` waehlt AV1,
sobald die GPU es encodieren kann), fuehrt kein Weg daran vorbei.

`depacket/av1.rs` implementiert den Aggregation-Header (Z/Y/W/N), das
Zusammensetzen ueber Paketgrenzen und — der unangenehme Teil — das
Wiedereinsetzen der `obu_has_size_field`-Groessenfelder, die das RTP-Format
weglaesst und FFmpeg erwartet.

Acht Unit-Tests decken das ab (einzelne OBUs, Fragmentierung, W=0 gegen W>0,
Temporal Delimiter, vorhandene Groessenfelder, verlorene Fortsetzungen).
**Gegen einen echten AV1-Stream ist es nicht geprueft** — das ist der erste
Punkt fuer den naechsten Testlauf.

## Bauen und testen

```
cd streaming/pulse-player
cargo test          # 36 Tests, keine Hardware noetig
cargo build --release
```

Rauchtest ohne Stream (oeffnet kein Fenster):

```
printf '{"op":"health","id":1}\n{"op":"shutdown","id":2}\n' | ./target/release/pulse-player
```

Mit echtem Stream (oeffnet ein Fenster):

```
printf '{"op":"open","id":1,"url":"https://…/whep/…?token=…"}\n' | ./target/release/pulse-player
```

## Lizenz

Die Crate selbst faellt unter die Client-Lizenz des Repos (PolyForm Perimeter,
siehe `../LICENSE`). Fuer Abhaengigkeiten gilt:

- **Kein GPL-Code** darf hier hineingelinkt werden. Das kollidiert hart mit der
  Client-Lizenz.
- **FFmpeg muss LGPL-konfiguriert und dynamisch gelinkt sein.** Die System-FFmpeg
  vieler Distributionen ist mit `--enable-gpl` gebaut (auf der Dev-Maschine
  meldet das Arch-Paket GPL-3.0-only) und taugt deshalb **nur zur lokalen
  Entwicklung**. Ausgelieferte Builds folgen dem Vorbild der bestehenden
  Sidecars: `win-hq-sidecar` nutzt die vendorte BtbN-LGPL-Distribution,
  `mac-hq-sidecar` ein selbst gebautes LGPL-FFmpeg.
- `wgpu`, `winit`, `webrtc-rs`, `cpal`: MIT/Apache-2.0. `dav1d`: BSD.
  Ueber `webrtc-rs` kommt zwingend `rustls` und damit `aws-lc-rs`/`aws-lc-sys`
  (ISC, Apache-2.0, MIT, BSD-3-Clause — alle permissiv).

Alles Ausgelieferte gehoert nach `THIRD-PARTY-NOTICES.md` und auf die
Drittanbieter-Seite im Web.

## Naechste Schritte

1. Gegen einen echten Stream testen — zuerst AV1, dort ist das Risiko am
   groessten. Dabei gleich die Lippensynchronitaet pruefen: Bild kommt aus
   diesem Player, Ton weiterhin aus dem Browser-Pfad.
2. Lippensynchronitaet messen: Ton laeuft jetzt durch den Player, aber die
   Synchronisierung ist eine Puffer-Naeherung, keine Zeitstempel-Kopplung.
3. Die Render-Etappe messen: Glass-to-Glass durch diesen Player gegen den
   `<video>`-Weg. Das ist die Zahl, die in
   `docs/2026-07-21-remote-control-latenz-messung.md` §2.4 noch als Schaetzung
   steht, und sie entscheidet, ob der Player auch fuer die Fernsteuerung
   der richtige Weg ist.
4. Windows und macOS bauen und pruefen.
