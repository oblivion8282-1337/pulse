# pulse-player — nativer HQ-Stream-Player

Zeigt einen HQ-Stream (WHEP von MediaMTX) in einem **eigenen Fenster** an, statt
ihn durch Chromiums Compositor zu schicken. Das Fenster oeffnet **ohne
Aktivierung** (`with_active(false)`): Pulses Tastenkuerzel hoeren am Fenster der
Web-App zu und wirken nicht mehr, sobald ein anderes Fenster den Tastatur-Fokus
hat — beim Zuschauen soll man weiter in Pulse tippen koennen. Wer die Bedienung
im Fenster benutzt, nimmt ihm den Fokus zwangslaeufig; ein Klick zurueck in
Pulse stellt ihn wieder her. Gesteuert wird er von Electron ueber
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
  `Rgb10a2Unorm`, dann `Rgba16Float`, sonst 8 bit. Das tatsaechlich verhandelte
  Format steht in `stats.surface_format` — damit ist von aussen belegbar, was
  anliegt. Warum 10-bit-Unorm VOR fp16 steht, obwohl fp16 mehr Bits haette,
  steht in `render/setup.rs` (fp16 wird als lineares Licht gedeutet).
  **Was die zehn Bit wirklich bringen, ist gemessen** und kleiner als lange
  angenommen: `docs/2026-08-04-player-farbwerte-messung.md`, nachzustellen mit
  `pulse-player --stufen`.
- **Bedienoberflaeche IM Fenster** (`src/overlay.rs`, egui): Lautstaerke samt
  Verstaerkung ueber 100 %, Stumm, Vollbild (Knopf, Doppelklick, Esc) und ein
  Statistik-Feld (Auflösung, Bilder/s, Bitrate, Decoder samt Hardware-Angabe,
  **Ausgabeformat**, verworfene und uebersprungene Bilder, Paketverlust,
  Pufferstand, Ton-Aussetzer). Blendet sich nach drei Sekunden ohne
  Mausbewegung aus. Ob ohne neues Bild ueberhaupt ein Durchgang noetig ist,
  entscheidet `Overlay::wants_redraw` VOR dem egui-Aufbau — an GRUENDEN
  (Eingabe liegt an, neue Zahlen, Ausblenden), NICHT am Zustand `visible`: mit
  „sichtbar" als Grund hielt sich die Schleife selbst am Leben, weil jede
  Ausgabe den naechsten Durchlauf ausloest (gemessen 2500-3400 Ausgaben je
  Sekunde bei 144 ankommenden Bildern). Ob das Overlay in einem Durchgang
  MITgezeichnet wird, haengt dagegen an `visible` — sonst verschwaende es,
  sobald wieder Bilder flossen. Eingaben fordern **keinen** eigenen Durchgang
  an, solange Bilder fliessen (`FRAME_FLOW_WINDOW` in `app`): das naechste Bild
  zeichnet das Overlay mit, bei 144 fps also spaetestens nach 7 ms. Sonst
  bekaeme jede Mausbewegung ihren eigenen Durchgang — gemessen bis zu 900 je
  Sekunde, die Abtastrate der Maus. Was hier bedient wird, geht durch dieselbe Stelle wie
  ein `set_option` per RPC; eine Aenderung der Lautstaerke meldet der Player
  zusaetzlich als `player:option`-Ereignis nach vorne, damit Pulse den Wert je
  Streamer behalten kann.
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
  Bitstrom wird direkt gemuxt — Bild und Ton in einer Datei. Container je
  Codec, und das ist gemessen und nicht gewaehlt: **H.264 nach MPEG-TS**
  (nimmt Annex B nativ; Matroska verlangt dort `avcC` und Laengen-Praefixe und
  lehnt ab), **AV1 nach Matroska** (MPEG-TS traegt AV1 nicht, dort landet der
  Strom als `bin_data`; Matroska braucht den AV1CodecConfigurationRecord als
  `extradata`, der aus dem Sequence-Header des Stroms gebaut wird). Der
  benutzte Pfad kommt in der Antwort zurueck — die Endung kann von der
  angefragten abweichen.
- **Clip der letzten Sekunden** (`clip`): ein Ringpuffer haelt 60 s vor, auch
  wenn nicht aufgenommen wird. Der Schnitt beginnt am letzten Keyframe davor,
  sonst waere der Anfang unbrauchbar.
- **Ehrliche Statistik**: empfangene, verlorene, umsortierte und doppelte Pakete,
  dekodierte und verworfene Frames, Pufferfuellstand, gewaehlter Decoder,
  Hardware ja/nein, Oberflaechenformat, dazu Ton-Unterlaeufe und Puffer-Stand
  sowie Aufnahmezustand und verfuegbare Clip-Sekunden.

## AV1-Rundlauf-Test gegen echte Daten: Depacketizer ist sauber

`depacket/av1.rs` hat einen Rundlauf-Test (echter AV1-Strom ueber den
`Av1Payloader` des `rtp`-Crates in RTP-Pakete zerlegt, durch unseren
`Av1Assembler` zurueck, gegen mehrere MTUs inkl. Fragmentierung und
Paketverlust). Ein frueherer Versuch hatte hier faelschlich einen
"OFFENER FEHLER: AV1-Wiedergabe funktioniert nicht" vermerkt und die Tests
`#[ignore]`d — das war eine **Fehldiagnose**.

Die tatsaechliche Ursache: `rtp` 0.17.2s
`codecs::av1::leb128::{encode_leb128,put_leb128}` (nur fuer den
`Av1Payloader` benutzt, NICHT fuer unseren Depacketizer) kodiert jedes
Laengenfeld >=128 fehlerhaft — die Funktion packt jede 7-Bit-LEB128-Gruppe in
ein volles 8-Bit-Byte-Slot (`<<= 8`), liest beim Serialisieren aber mit `>>= 7`
wieder aus; die Fehlausrichtung erzeugt ein zusaetzliches Muellbyte statt
gueltigem Standard-LEB128 (`put_leb128(474)` schreibt z. B. 3 Byte
`[0x83,0xb4,0x03]` statt der korrekten 2 Byte `[0xda,0x03]`). Der Rundlauf-Test
fuetterte unseren (korrekten, standardkonformen) Assembler also mit bereits
kaputten Testdaten und meldete den Fehler des Generators als Fehler des
Depacketizers.

`depacket/av1.rs::tests::roundtrip` baut das jetzt in
`fix_rtp_crate_leb128_bug()` per Nachschlagetabelle gegen eine 1:1-Kopie von
`encode_leb128`/`put_leb128` zurecht (nur die Laengenfeld-Bytes werden
korrigiert, die eigentliche Fragmentierungs-Entscheidung des Payloaders bleibt
unangetastet und damit weiter der Pruefgegenstand). Mit dem Fix laufen alle
Rundlauf-Tests gruen — inkl. Ende-zu-Ende-Dekodierung per `ffprobe` (gleiche
Bildanzahl wie das Original) und Paketverlust-Erholung. `Av1Payloader` wird in
Pulse aktuell nirgends produktiv zum Senden genutzt (nur als Dev-Dependency
hier), der Bug hat also keinen bekannten Praxis-Impact — ist aber ein fuer
sich stehender, reproduzierbarer Fehler in einer Abhaengigkeit.

Reproduktion:
```
ffmpeg -f lavfi -i "testsrc2=s=320x180:r=30:d=2" -c:v libsvtav1 -preset 12 \
  -f obu fixture.obu
PULSE_PLAYER_AV1_FIXTURE=fixture.obu cargo test depacket::av1
```

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
- **Hier stand bis 2026-08-05 „Nur unter Linux getestet … Windows und macOS
  sind ungeprueft". Fuer Windows stimmt das nicht mehr.** Auf Windows + NVIDIA
  (RTX 5080) laeuft er mit Hardware-Dekodierung — `h264_cuvid` und `av1_cuvid`,
  8 wie 10 bit —, geprueft gegen die echte Kette (win-hq-sidecar -> eigener
  WHIP-Sendeweg -> gepatchtes MediaMTX -> Player) samt Ton und nachtraeglichem
  Einstieg in einen Intra-Refresh-Strom ohne periodische Vollbilder. Seither
  wird er auch im Windows-Installer mitgeliefert (`electron-builder.yml`,
  `win-build.yml`). **macOS bleibt ungeprueft** und wird nicht ausgeliefert.
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

### Mitschnitt: gegen echte Daten geprueft

Zwei Tests fahren einen echten Bitstrom durch den Rekorder und lesen die
erzeugte Datei wieder ein — sie pruefen Spur, Dauer und Dekodierbarkeit, nicht
nur die Dateigroesse. Sie brauchen eine Rohdatei und laufen sonst nicht:

```
ffmpeg -f lavfi -i testsrc2=s=640x360:r=30:d=3 -c:v libx264 \
  -bsf:v h264_mp4toannexb -f h264 fixture.h264
ffmpeg -f lavfi -i testsrc2=s=320x180:r=30:d=2 -c:v libsvtav1 \
  -preset 12 -f obu fixture.obu

PULSE_PLAYER_H264_FIXTURE=fixture.h264 cargo test h264_annexb -- --nocapture
PULSE_PLAYER_AV1_FIXTURE=fixture.obu   cargo test av1_obus   -- --nocapture
```

Diese Tests haben drei Fehler aufgedeckt, die kein Codelesen gefunden haette:
Matroska lehnte H.264 ohne `extradata` ab, AV1 landete in MPEG-TS als
unlesbares `bin_data`, und die Zeitstempel wurden nicht in die Zeitbasis des
Muxers umgerechnet — 90 Bilder landeten in 49 ms statt in drei Sekunden.

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

Die Crate selbst faellt unter die Client-Lizenz des Repos (**Pulse Client
License 1.0**, siehe `../LICENSE`). Hier stand bis 2026-08-04 „PolyForm
Perimeter" — das Projekt ist am 2026-07-29 auf eigene Lizenztexte gewechselt,
weil PolyForm ausdruecklich Aenderungen und Weitergabe erlaubt und damit genau
das gestattet haette, was hier untersagt sein soll. Fuer Abhaengigkeiten gilt:

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
4. macOS bauen und pruefen. **Windows ist am 2026-08-05 erledigt** — gebaut,
   gegen die echte Kette geprueft (H.264 und AV1, 8 und 10 bit, jeweils
   `*_cuvid` in Hardware) und im Installer. Hier stand vorher „Windows und
   macOS"; nur macOS ist offen.
