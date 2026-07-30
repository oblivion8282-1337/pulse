# CLAUDE.md — Linux-HQ-Sidecar

Projektanweisungen für Claude Code. Gilt für die Arbeit in diesem Verzeichnis
(`streaming/linux-hq-sidecar/` im Pulse-Repo).

**Lag bis 2026-07-29 in einem eigenen Repo** (`pulse-linux-hq-sidecar`, jetzt
Archiv). Dort stehen die Commits mit den Messbegründungen zu den Latenz- und
Encoder-Werten; wer wissen will, warum eine Zahl so gesetzt ist, findet die
Herleitung in der Historie des Archivs. Übernommen wurde `ba9cc48`.

## Was das ist
Rust-Neubau des Pulse **Linux HQ-Streaming-Sidecars**. Ersetzt den Python-`gsr-sidecar`
(im Pulse-Repo `pulse/streaming/gsr-sidecar/`), der das externe `gpu-screen-recorder`-
Binary als Subprocess spawned. Hier: **FFmpeg als Bibliothek** (wie die Windows/macOS-
Rust-Sidecars `pulse/streaming/{win,mac}-hq-sidecar/`), kein zweites Programm.

**Am Pulse-Repo (`/home/michael/Dokumente/pulse/`) wird nichts geändert** — nur dieser
Ordner. Vorbild/Vorlage ist `mac-hq-sidecar` (nächste Verwandtschaft: backendfrei +
ffmpeg-as-lib + kein Tokio im Main-Loop).

## Wire-Protokoll (heilig — nicht brechen)
stdio JSON-RPC über newline-delimited JSON, **byte-identisch** zu
`pulse/streaming/gsr-sidecar/control.py` (und win/mac). Siehe `streaming/README.md` im
Pulse-Repo für die Spec.
- Request: `{"op":"...","id":<num>?,"params"}` · Response: `{"id","ok","fields"}` (flach!)
  · Event: `{"ev":"..."}` (kein id/ok).
- Ops: `health, gpu_info, list_monitors, list_windows,
  list_application_audio, build_argv, start, stop, state`.
- States: `idle|starting|live|error|stopped`. Events: `state, fps, log, error, stopped`.
- Token in URLs (pass=/token=) wird in `argv`/Logs **redacted** (`***`).

Verbatim-portierte Dateien (nicht ohne Not anfassen): `proto.rs, dispatch.rs, events.rs,
main.rs, profiles.rs, encode/mux_writer.rs, ops/{stop,state}.rs`.

## Architektur-Entscheidungen (Nutzer-Vorgaben — einhalten)
- **System-FFmpeg** via pkg-config (Arch n8.1.2, `--enable-gnutls --enable-libdrm
  --enable-nvenc --enable-vulkan`). `ffmpeg-next = "8.1"`. Für Flatpak-Auslieferung:
  `org.freedesktop.Platform.ffmpeg`-Extension (System-FFmpeg ist GPL → **nicht bündeln**).
- **Encoder v1: VAAPI (AMD/Intel) + NVENC (Nvidia), beide Zero-Copy verbindlich.**
  Codecs **nur H264 + AV1** (kein HEVC — nicht anbieten, nicht proben, keine hevc_mux-Tests).
- **Screen-Picker (Portal/PipeWire-Capture) wird zuletzt gebaut** — zuerst Pipeline mit
  synthetischer Quelle (`capture::SyntheticSource`) zum Laufen bringen.
- **WHIP ist IN scope** (Kehrtwende 2026-07-12, User-Entscheid): `http(s)://`-push_url
  → ffmpeg-8.1-WHIP-Muxer (WebRTC-Ingest für Gäste auf App-gehosteten Instanzen;
  RTMPS bleibt Default/Cloud-Pfad). AV1 kann der WHIP-Muxer nicht → auto-Fallback
  auf H.264 in `ops/start.rs`. Plan: pulse-Repo `docs/plans/2026-07-12-whip-guest-publish.md`.
- Encoder-Settings gehen auf GSR zurück (`~/.cache/pulse/gsr/gpu-screen-recorder/src/main.cpp`,
  nutzt selbst `h264_nvenc`/`h264_vaapi` via av_dict) — aber **nicht mehr 1:1**. Maßgeblich ist
  `encode/opts.rs`, dort steht an jedem Wert die Messung. Der Stand nach 2026-07-30:
  NVENC `tune=ll/rc=cbr/b_ref_mode=0` **+ `preset=p2` + `zerolatency=1`/`delay=0`**,
  VAAPI `rc_mode=CBR` + **`async_depth=1`** (GSR: 3 — der Vorlauf kostete zwei Bildabstände,
  33,6 → 5,3 ms). `coder=cabac` **nur bei H.264**: bei `av1_nvenc`/`av1_vaapi` existiert die
  Option nicht, und AV1 ist der Standard-Codec — unbedingt gesetzt wurde sie bis 2026-07-30
  bei jedem AV1-Stream still verworfen. `low_power` bleibt ungesetzt (Intel-VDENC-Pfad; auf
  AMD scheitert der Encoder-Open damit hart).

## Tonraster bestimmt die Bild-Gleichmäßigkeit (gemessen 2026-07-26)

Wer hier am Ton dreht, dreht am **Bild** — nicht offensichtlich, deshalb hier:

FLV/RTMP ist EINE Zeitleiste. `av_interleaved_write_frame` gibt ein Videopaket
erst frei, wenn Ton mit passendem Zeitstempel vorliegt. Mit den üblichen
20-ms-Opus-Paketen und dem PipeWire-Standardraster (1024 Samples ≈ 21 ms)
verließen die Bilder den Sender also in 20-ms-Bündeln. Beim Zuschauer sah das
nach Totalgesundheit aus (Bildzahl, Bitrate, Paketverlust alle sauber) und
ruckelte trotzdem sichtbar.

Zwei Schrauben, und nur eine ist die richtige:

* **Richtig: an der Quelle.** `OPUS_FRAME_MS = 5` (`encode/audio.rs`) plus
  `node.latency = 240/48000` (`capture/audio.rs`). Wirkt bei JEDER Bildrate,
  die Schreibreihenfolge bleibt intakt.
* **Nicht ALLEIN: `max_interleave_delta` klein machen** — und nicht zu klein.
  Zu klein schreibt Bilder VOR dem Ton, die Reihenfolge kippt und der Muxer
  beendet den Stream (`write_interleaved: Invalid argument`). Delta 1 us starb
  sofort, Delta 2 ms lief bei 144 fps und starb bei 280 fps — eine Falle, die
  nur bei hohen Bildraten zuschnappt.

  **Der Wert steht seit 2026-07-27 auf 10 ms** (`DEFAULT_INTERLEAVE_US` in
  `encode/mod.rs`), nicht mehr auf 100. Hier stand bis 2026-07-30 noch „bewusst
  auf 100 ms und nur noch Notbremse" — das war der Stand VOR der Messreihe, die
  99,8 auf 82,3 ms geholt hat. 10 ms hält zur Kante Abstand (bei 280 fps
  dreimal über 16 s ohne Fehler), und 3 ms wie 1 ms brachten bei 60 fps nichts
  mehr. Die volle Begründung mit Tabelle steht am Konstanten-Docstring.

Ergebnis am Prüfstand (`streaming/testbench/` im Pulse-Repo), gezählt werden
Ausgabe-Abstände über dem doppelten Soll je Sekunde:

| Bildrate | vorher | nachher |
|---|---|---|
| 144 fps | 46-51 | 1-2 |
| 200 fps | 36-39 | 0 |
| 280 fps | Stream stirbt | läuft (Aufnahme am Anschlag, 16-34 doppelte Bilder/s) |

Merken: die Schwelle für sichtbares Ruckeln ist der **doppelte Bildabstand** —
13,9 ms bei 144 fps, aber nur 7,1 ms bei 280 fps. Ein Raster, das bei 60 fps
unauffällig ist, ist bei 280 fps grob.

## Encoder-Vorlauf: `zerolatency` + `delay=0` (gemessen 2026-07-26)

NVENC gab ein Paket ohne diese beiden Optionen erst heraus, wenn zwei weitere
Bilder eingeschoben waren — 33,4 ms bei 60 fps, 13,9 ms bei 144 fps, also exakt
zwei Bildabstaende. Mit ihnen: **2,9 ms**. Der Windows-Sidecar setzt beides fuer
denselben ffmpeg-Encoder seit immer; hier fehlte es.

**Aber:** beim Zuschauer kommen von den 30,5 ms nur **10** an (96 → 86 ms Ende zu
Ende, fuenf Laeufe). Rund 20 ms werden dahinter wieder aufgezehrt — von einer
Station, die nach Zeitstempeln ausgibt und nicht nach Ankunft. Wer hier weiter
Latenz sucht, sucht also am falschen Ende; der Verdacht liegt auf MediaMTX.

Zwei Dinge nicht vergessen:
* **Die Streuung steigt** (82-89 ms statt dreimal 96,1). Der feste Vorlauf hat
  sie mit versteckt. Auf die Gleichmaessigkeit der Ausgabe wirkt es nicht.
* **Der Einfluss auf die Bildqualitaet ist ungemessen.** Bei 4000 kbps auf 1440p
  ist der Spielraum klein. Dafuer fehlt eine verlustfreie Referenzaufnahme.

Rueckschalter: `PULSE_NVENC_LOW_DELAY=0`. Zahlen und Verfahren in
`streaming/testbench/profiles/` im Hauptrepo.

## Portal-Restore-Token

`PULSE_PORTAL_REUSE=1` lässt den Sidecar das Restore-Token des Portals in
`$XDG_STATE_HOME/pulse/portal-restore-token` ablegen und beim nächsten Start
einlösen — dann kommt **kein Dialog**. Für automatisierte Messungen gedacht.

**Standardmäßig aus, und das ist Absicht:** unter Wayland IST der Dialog die
Quellenauswahl. Überspringt man ihn still, hängt der Nutzer für immer an der
zuerst gewählten Quelle, ohne zu sehen warum. Ein Nutzer-Schalter („diese
Quelle merken") gehört an dieselbe Stelle, ist aber eine Produktentscheidung.
Das Portal gibt bei jeder Verhandlung ein FRISCHES Token aus und entwertet das
alte — deshalb wird nach jeder Verhandlung geschrieben, nicht nur beim ersten Mal.

## ffmpeg-next-Fallen (schon gelöst — nicht wieder reinlaufen)
- Enum-Varianten nur **qualifiziert** verwendbar: `AVPixelFormat::AV_PIX_FMT_CUDA`,
  `AVHWDeviceType::AV_HWDEVICE_TYPE_CUDA` (bare-Variante via `use ffi::*` geht NICHT).
- `AVFrame.format` ist `c_int` → `pix_fmt() as i32` casten. `AVHWFramesContext.format`
  ist `AVPixelFormat` (kein Cast).
- `set_max_b_frames(usize)` (nicht `set_b_frames`, nicht Option). `set_pts(Option<i64>)`.
  `Dictionary<'static>`-Lifetime bei owned Return ohne Input-Ref.
- `Pod::from_bytes` liefert `Option<&Pod>` (Pod ist unsized) → `params: [&Pod; N]`,
  die Byte-Vecs müssen bis zum `connect`/`update_params` leben.
- `Request::response()` ist **synchrone** Methode auf `ashpd::Request` (kein `.await`).

## Build & Test
Diagnose-Logging (`src/logging.rs`, `tracing`): geht auf **stderr** (stdout = nur
JSON-RPC), Pulse tee't das in `sidecar.log`. Stufen/Targets via `PULSE_HQ_LOG` (wie
`RUST_LOG`), Default `info` — z.B. `PULSE_HQ_LOG=info,pipewire=debug,nvenc=debug`. Targets:
`pipewire, nvenc, vaapi, audio, egl, stream, mux`. Token-Redaction: `src/redact.rs`.
```bash
cargo build --release
echo '{"op":"health","id":1}' | ./target/release/pulse-linux-hq-sidecar
cargo run --release --example tls_probe -- rtmps://localhost:11936/test
cargo run --release --example encode_smoke -- /tmp/smoke.mp4 h264 1280 720 30 120
cargo run --release --example capture_smoke 5     # Portal-Dialog — User wählt Quelle
```
Lokales MediaMTX: `docker compose -f test/docker-compose.yml up -d` (RTMPS :11936,
API :9997, HLS :8888). Self-signed Cert: `openssl req -x509 -newkey rsa:2048 -nodes
-keyout test/certs/key.pem -out test/certs/cert.pem -days 3650 -subj "/CN=localhost"`.
**`test/certs/` ist gitignored — Private Keys niemals committen.**

## Dev-Umgebung
- **NVIDIA RTX 4090 (Ada)** + **AMD Raphael-iGPU** (renderD129, im BIOS scharf), niri
  (Wayland), PipeWire 1.6.7. Beide Encode-Pfade live testbar: NVENC (H264+AV1),
  VAAPI (H264). AMD-Test erzwingen: `PULSE_HQ_VENDOR=amd` + im Portal den Monitor am
  iGPU-/Mainboard-Ausgang wählen (nur dessen Bild liegt in AMD-Speicher).
- xdg-desktop-Portal ScreenCast nutzt hier den **GNOME-Backend** (niri implementiert
  `org.gnome.Mutter.ScreenCast`); konfiguriert in `~/.config/xdg-desktop-portal/portals.conf`.
- libclang liegt als `/usr/lib/libclang.so` (kein pkg-config-File, aber bindgen findet es).
- Ports: 1936 ist durch `passt` belegt → RTMPS läuft auf **11936**; WebRTC-ICE-UDP auf 18189.

## Task 6 — Stand
Ex-Blocker **gelöst** (Commit `6277015`): Die SPA-Format-Verhandlung brauchte explizite
DRM-Modifier. `src/capture/egl_modifiers.rs` fragt sie via `eglQueryDmaBufModifiersEXT`
ab (dlopen libEGL, Device-Plattform), `pipewire_stream.rs` bietet sie als Choice-Enum
(`MANDATORY|DONT_FIXATE`) an und macht den Fixierungs-Tanz aus der PipeWire-DMABUF-Doku.
**Falle:** SPA stellt fixierte Werte als `Choice None` dar — wer nur `is_choice()` prüft,
re-announced endlos. Live verifiziert: BGRx 1920×1080, NVIDIA-Modifier
`0x0300000000606010`, DMABUF-Frames fließen (`capture_smoke`).
SPA_PARAM-ids: EnumFormat=3, Format=4, Buffers=5, Meta=6, Latency=15, Tag=17, Props=2.
**Zero-Copy-NVENC steht** (`src/encode/nv_import.rs` + `examples/capture_encode_smoke.rs`,
live verifiziert: Portal→DMABUF→EGLImage→GL-Staging→CUDA→NVENC→mp4, Farben korrekt):
DMABUF→`eglCreateImageKHR`→GL-Textur→`glCopyImageSubData` in eigene RGBA8-Staging-Textur
(CUDA kann EGLImage-Texturen NICHT registrieren → INVALID_VALUE; GSR kopiert genauso)
→`cuGraphicsGLRegisterImage` (einmalig auf Staging)→`cuMemcpy2D` ARRAY→DEVICE in
ffmpeg-CUDA-Frame sw_format **BGR0** (NVENC nimmt RGB direkt). FFmpeg-CUDA-Device MUSS
`AV_CUDA_USE_PRIMARY_CONTEXT` nutzen (hw.rs), sonst fremder CUcontext. Capture-Stop läuft
über `pw::channel` → `mainloop.quit()` (mpsc weckt den Mainloop nicht → hing ewig).
Compositor liefert Frames nur bei Damage (statischer Schirm = wenige Frames — kein Bug).

**StreamController auf echte Capture verdrahtet** (`start`-Op → Portal-Dialog → PipeWire-
DMABUF → Zero-Copy-NVENC → RTMPS): live über JSON-RPC verifiziert (`start`/`stop`,
MediaMTX `ready:true`, ~5 MB in 12 s). Getakteter Loop mit **Frame-Duplikation** hält
**konstante 60 fps** trotz Damage-getakteter Quelle; PTS = monotoner Frame-Zähler in
Encoder-Timebase 1/fps. `SyntheticSource` wird nicht mehr benutzt (Struct bleibt).
Streamt in **nativer Auflösung** (Resolution-Override ⇒ später GPU-Scale). Nur NVIDIA;
AMD/Intel geben klaren Fehler. Bekannt: `stop` während offenem Portal-Dialog blockt bis
zur Auswahl. Die FLV-"Failed to update header"-Warnings beim Stop sind harmlos (Live-RTMP
kann den Header nicht nachschreiben).

**Audio steht** (`src/capture/audio.rs` + `src/encode/audio.rs`): PipeWire-Sink-Monitor
(`STREAM_CAPTURE_SINK`, kein Portal nötig) → F32-Stereo-48k → libopus (Opus-in-FLV ist ab
FFmpeg ≥6.1 nativ, kein Patch) → 2-Stream-FLV. `MuxWriter::sender()` liefert einen
cloneable `MuxSender`; Audio läuft auf eigenem Encode-Thread, Muxer interleaved nach DTS.
`VideoEncoder::create_with_audio` fügt den Audio-Stream VOR `write_header` ein. Teardown:
Audio ZUERST stoppen (MuxSender droppt → Trailer kann schreiben), dann `enc.finish()`.
Live verifiziert: `start` mit `audio.mode!="Aus"`, MediaMTX-API zeigt `tracks
['H264','Opus']`. (ffmpegs klassischer RTMP-*Reader* zeigt nur Video — Opus-over-E-RTMP
parst er nicht; MediaMTX als echter Konsument sieht beide.) A/V-Anchoring noch offen
(`av_offset_ms` wird geloggt, nicht angewandt; Audio-pts startet bei 0 wie Video).

**VAAPI-Import (AMD/Intel) — auf AMD-Hardware verifiziert** (`src/encode/
va_import.rs`): DMABUF → `AV_PIX_FMT_DRM_PRIME`-Frame (aus `AVDRMFrameDescriptor`) →
Filtergraph `buffer → hwmap=derive_device=vaapi → scale_vaapi=format=nv12 → buffersink`.
`hwmap` importiert das DMABUF zero-copy in eine VAAPI-Surface, `scale_vaapi` (VPP) macht
BGRx→NV12 auf der GPU. Der Encoder bindet den NV12-Buffersink-Frames-Kontext. Nötig:
ffmpeg-next-Feature `filter`. `VideoEncoder::create_with_audio` nimmt jetzt
`(hw_pixel, frames_ctx)` statt `&HwContext` (entkoppelt NVENC/VAAPI). `run_stream`
verzweigt über ein `FrameImporter`-Enum (Nvenc/Vaapi). **Kern-Falle (gelöst): der
DRM_PRIME-Eingabe-Frame MUSS referenzgezählt sein (`frame->buf[0]` gesetzt, Deskriptor
heap-alloziert + `av_buffer_create`)** — sonst deep-kopiert buffersrc via
`av_hwframe_get_buffer`, was der DRM-Kontext nicht kann → `AVERROR(ENOMEM)`=-12 beim
ersten Frame (ohne jede VAAPI-Logzeile). NVIDIA-Regression nach dem Umbau OK
(tracks H264+Opus, 60 fps, bytes steigen).

**`test_driver`-Example** (`examples/test_driver.rs`, portiert aus win-hq-sidecar):
spawnt das Binary, redet JSON-RPC über stdin/stdout, tee't zeitgestempelt in
Konsole+Logfile. Szenarien: `protocol` (default, **nicht-interaktiv** — sweep über alle
Read-Ops + unknown-op + invalid-json, verifiziert Wire-Protokoll; grün in ~130 ms),
`health`, `video_only`/`audio_mux`/`av1_mux` (Portal-Dialog). `$PULSE_HQ_SIDECAR_BIN`
überschreibt den Bin-Pfad. Kein HEVC-Szenario (nur H264+AV1).

**A/V-Sync über gemeinsame Wanduhr** (GSR-Modell): Video- UND Audio-pts leiten aus
demselben `record_start`-Instant ab. Video-pts = `round((now-record_start)*fps)` (nicht
mehr simpler Zähler → kein Sleep-Drift), strikt monoton via `max(next_pts)`. Audio: der
erste Sample-Batch verankert die Zeitlinie an `(arrival-record_start)*sample_rate` (+
`av_offset_ms`). Kein fixer Encoder-Delay (wie GSRs `force_no_audio_offset` bei
Livestream). `av_offset_ms` ist jetzt funktionaler Feinabgleich (positiv = Ton später).
Verifiziert (RTSP-Aufnahme, Paket-PTS): beide Spuren enden nach 15 s auf **16 ms genau** →
kein Drift. (`start_time`-Diff in Mid-Stream-Aufnahmen = Keyframe-Artefakt, GOP=2s.)

**Restart-Fixes (2026-07-11):** (1) `reap_finished()` im StreamController — endet der
Worker von selbst (Ingest-Fehler/EOF), räumt der nächste `start`/`state` die tote Session
ab statt mit „ein Stream läuft bereits" zu blocken. (2) Portal nutzt eine **prozessweite**
Tokio-Runtime (`portal_runtime()`): die frühere Wegwerf-Runtime pro `open()` tötete den
zbus-I/O-Treiber der prozessweit gecachten Session-Bus-Verbindung → zweiter Stream hing
stumm im Portal-Dialog.

**Settings real umgesetzt (2026-07-11):** fps-Clamp 1..=1000 (war 120); `show_cursor`
→ `portal::open(bool)`; Resolution-Token (`Native/4K/1440p/1080p/720p/480p` + `WxH`,
Mapping wie Python `RESOLUTION_TARGETS`) → **GPU-Scale**: aspektwahrend in die Box, nie
Upscale, gerade Maße (`ResolutionRequest::target_for`) — NVENC skaliert per
FBO-Blit (LINEAR) EGLImage→Staging (`nv_import`, Staging hat IMMER Ausgabe-Größe),
VAAPI via `scale_vaapi=w:h:format=nv12` im selben VPP-Durchgang.

**Audio-Modi (2026-07-11, `capture/audio_router.rs`):** GSR-Modell — eigener Null-Sink
(`support.null-audio-sink`), App-Streams (`Stream/Output/Audio`) werden per
`link-factory` ZUSÄTZLICH auf ihn gelinkt, Capture hängt an dessen Monitor
(`target.object`-Literal — die pw::keys-Konstante ist feature-gegated). Modi:
`Desktop` = alle Apps außer Excludes (+ IMMER "Pulse", Echo-Schutz wie Python),
`App: <name>` = genau eine App (case-insensitive), `Mikrofon` = Default-Input ohne
Router. Registry wird live beobachtet (Apps, die mittendrin starten, werden
nachgelinkt). `list_application_audio` enumeriert real (`application.name`-Dedup).
"Desktop + Mikrofon" = vorerst nur Desktop (Warnung in `ops::start`).

**10-bit-Encode (2026-07-26, NVENC/AV1).** `overrides.bit_depth: 10` → `P010`-Pool →
10-bit-AV1. Gemeldet als `health.gsr.ten_bit` (Zusatzfeld ggü. Python/win/mac, `undefined`
= false lesen). Die nicht-offensichtlichen Punkte:
- **10 bit ist an AV1 gebunden.** H.264 kann NVENC hier zwar wirklich in `High 10`
  (nachgemessen: `profile_idc=110`, `bit_depth_luma=10`), aber **kein Browser dekodiert
  das** — und der WHEP-Rückfall im Web ist ein `<video>`. `ops::start` schiebt jeden
  10-bit-Wunsch ohne AV1 auf 8 bit zurück, inkl. der Fälle, in denen der Codec vorher
  selbst auf h264 zurückgefallen ist (fehlendes AV1, WHIP-Ziel).
- **Warum wir RGB→YUV selbst rechnen** (`encode/nv_p010.rs`, GL-Shader → `R16`-Luma +
  `RG16`-Chroma → CUDA → P010): im 8-bit-Pfad wandelt NVENC selbst, das geht für 10 bit
  NICHT. Zwei Sackgassen, beide gemessen, damit sie niemand erneut aufgreift:
  (1) FFmpegs CUDA-**Frame-Kontext** kennt kein 10-bit-RGB (`av_hwframe_ctx_init` mit
  `sw_format=x2bgr10le` → „Pixel format 'x2bgr10le' is not supported", rc=-38) — dass
  `av1_nvenc` `x2bgr10le` in seiner Formatliste führt, gilt nur für Software-Frames mit
  interner Konvertierung; (2) `scale_cuda` (der symmetrische Weg zu `scale_vaapi` im
  AMD-Pfad) kann es auch nicht: „Unsupported conversion: bgr0 -> semiplanar10".
  Ebenfalls verworfen: gepacktes `GL_RGB10_A2` als Staging — `cuGraphicsGLRegisterImage`
  gibt `CUDA_ERROR_INVALID_VALUE` (die CUDA-GL-Interop nimmt nur 8/16/32-bit-Komponenten,
  keine gepackten 10-bit-Formate). `R16`/`RG16` gehen dagegen.
- **P010 trägt die 10 Bit OBEN** im 16-bit-Wort; der Shader schreibt `code*64/65535`
  (bei `code ≤ 1023` in 16 bit exakt, untere 6 Bit null). Farbe: BT.709, begrenzter
  Bereich — und der Encoder signalisiert das **nur im 10-bit-Pfad**, weil im 8-bit-Pfad
  NVENC nach eigener Konvention wandelt (dort etwas zu behaupten würde einen verifiziert
  korrekten Pfad auf Verdacht verstellen).
- **Prüfen ohne Portal-Dialog:** `cargo run --release --example staging_format_probe` —
  registriert beide Staging-Varianten bei CUDA und rechnet Farbmatrix + Bit-Lage gegen
  eine unabhängige Referenz nach (`NvDmabufImporter::selftest_p010`). Das ersetzt das
  Prüfen-mit-dem-Auge, das hier schon zweimal Fehler durchgelassen hat (Rot/Blau
  getauscht, Faktor 64 zu dunkel). Volle Kette mit echter Capture:
  `capture_encode_smoke <out> av1 60 120 10` → Ausgabe muss `yuv420p10le` sein.
- **VAAPI hat keinen 10-bit-Zweig** (der Filtergraph wandelt fest auf NV12). Besitzt die
  aufnehmende Karte kein NVENC, verfällt der Wunsch mit Log-Zeile statt den Start zu
  verweigern — welche Karte den Puffer hält, steht erst beim Import fest.
- **Offen: die Aufnahme selbst ist weiter 8 bit.** Der Compositor liefert `XRGB8888`
  (`pipewire_stream.rs` bewirbt nur BGRx/BGRA). 10-bit-Encode eines 8-bit-Bildes bringt
  trotzdem etwas (keine zusätzliche Quantisierung im Encoder → weniger Banding in
  Verläufen), aber es ist keine echte 10-bit-Quelle. Für die bräuchte es
  `xBGR_210LE`/`ARGB_210LE` in der EnumFormat-Liste — ob niri/KWin das anbietet, ist
  ungeprüft. Der Shader-Pfad selbst bräuchte dafür KEINE Änderung (er sampelt
  normalisierte Floats).

**Als Nächstes:** VAAPI auf echter AMD/Intel-Hardware verifizieren; Mikrofon-Mix für
"Desktop + Mikrofon"; ggf. Audio-Silence-Insertion bei PipeWire-xruns (GSR macht das
gegen Drift).

## Memory / Plan
- Projekt-Memory: `~/.claude/projects/-home-michael-Dokumente-Linux-Rust-Sidecar/memory/`
  (`linux-rust-sidecar-rebuild.md` — vollständiger Stand/Phasen/Fällen).
- Plan: `~/.claude/plans/shiny-meandering-tide.md`.
