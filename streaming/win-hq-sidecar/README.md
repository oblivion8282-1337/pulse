# Windows-HQ-Sidecar

Rust-Bin (Cargo, Edition 2024) — der Windows-Gegenpart zum Linux-GSR-Sidecar
(`streaming/gsr-sidecar/`). Spricht **dasselbe stdio-JSON-RPC-Protokoll** (gleiche
Ops/Events, gleiche Response-Shapes — auch wo's unter Windows keinen GSR gibt:
`health.gsr.source="builtin"` statt Binary-Pfad). Protokoll-Details: `streaming/README.md`.

Electron spawnt ihn lazy beim ersten `gsr:call`; Path-Resolver in
`desktop/electron/sidecar.ts`: `$PULSE_HQ_SIDECAR` → Walk-up auf
`target/release|debug/pulse-win-hq-sidecar.exe` → `%LOCALAPPDATA%\Pulse\hq-sidecar\pulse-win-hq-sidecar.exe`.
Kein Python — die Rust-Bin ist standalone (FFmpeg-DLLs neben der exe).

## Zwei Sendewege

**RTMPS geht an ffmpegs Muxer, `http(s)://` an den eigenen WebRTC-Sender**
(`src/whip/`, seit 2026-08-04; angemeldet in `main.rs`, eingehängt über
`encode::senke`). ffmpegs WHIP-Muxer wäre für den zweiten Fall der naheliegende
Weg und kann zwei Dinge nicht, die hier zählen: er hat **keinen Rückkanal** zur
Anwendung — eine Vollbild-Anforderung des Zuschauers erreicht den Encoder also
nie — und er trägt **kein AV1**. Beides ist bei Intra-Refresh entscheidend: so
ein Strom hat nach dem Start kein Vollbild mehr, und AV1 ist auf AMD der Codec,
der die Betriebsart überhaupt trägt.

Dieselbe Fassung wie im Linux-Sidecar. Der CPU-Weg (Intel) benutzt weiter
ffmpegs Muxer — folgenlos, solange Intel Intra-Refresh ohnehin nicht trägt.

## Stack

- **Capture:** `windows-capture` v2 (WGC, ID3D11-Texture-Output).
- **Audio:** `wasapi` (Desktop-Loopback + Mikrofon). Der **„Desktop"**-Modus nutzt
  WASAPI-Process-Loopback im **EXCLUDE-Modus** über den Pulse-Prozess-Tree
  (`new_application_loopback_client(pid, include_tree=false)` →
  `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`), damit Pulses eigener Ton —
  v. a. die Wiedergabe der anderen Voice-Teilnehmer — nicht als Echo in den Stream
  läuft. `pid` = Electron-Main-PID via `PULSE_SELF_PID` (gesetzt in
  `desktop/electron/sidecar.ts`); fehlt sie, Fallback auf den simplen
  Render-Loopback. Linux-Äquivalent: `-a app-inverse:Pulse` (`gsr-sidecar/profiles.py`).
- **Encode/Mux:** `ffmpeg-next` 8.1, gelinkt gegen die **vendored** BtbN-LGPL-Shared-
  Distribution unter `ffmpeg-dist/n8.1-lgpl-shared/` (Pfad via `.cargo/config.toml`
  `FFMPEG_DIR`; `build.rs` kopiert die DLLs neben die exe).
- MediaMTX-Build für lokales Testen unter `mediamtx-dist/v1.18.1/mediamtx.exe`.

## Drei Encode-Pfade

Dispatch über `VideoCodec::encode_path` (`encode/encoder.rs` — die EINE Stelle für die
Regel), ausgewertet in `src/stream_controller.rs::run_pipeline`: `nvidia` → `pipeline_hw`
(D3D11-Zero-Copy, alle Codecs), `amd` + **AV1** → ebenfalls `pipeline_hw` (`av1_amf`; AV1
kann der d3d12va-Encoder nicht, s.u.), `amd` + H.264/HEVC → `pipeline_d3d12`
(D3D12VA-Zero-Copy), sonst (Intel) → `run_cpu_pipeline`. **Beide GPU-Pfade sind by default
aktiv** — `PULSE_HQ_DISABLE_ZERO_COPY=1` zwingt jeden Vendor auf den CPU-Pfad (für AMD =
Fallback auf das funktionierende `h264_amf` mit Software-NV12).

**Für Intra-Refresh entscheidet genau diese Aufteilung mit**, und nicht die
Optionstabelle des Encoders: `h264_d3d12va` — der Regelweg für H.264 auf AMD —
nimmt die Option an und tut nichts damit. Getragen wird die Betriebsart auf AMD
von AV1 über `av1_amf`, also vom D3D11-Weg. Deshalb hängt `health.gsr.intra_refresh`
am Encoder, der bei dieser Kombination **wirklich** läuft (`encode/auffrischung.rs`
::`encoder_name`) — am Herstellernamen zu fragen meldete `h264_amf` und liefe
`h264_d3d12va`.

### D3D11 Zero-Copy (NVENC / AMF)
`src/pipeline_hw.rs` + `src/capture/wgc_hw.rs` + `src/encode/encoder_hw.rs` + `src/encode/hwctx.rs`.

WGC liefert `ID3D11Texture2D`-Frames; im Capture-Callback `CopySubresourceRegion`
GPU-intern in einen D3D11VA-Pool (`av_hwframe_get_buffer`), NVENC liest
`AV_PIX_FMT_D3D11` mit `sw_format=BGRA` direkt — Swizzle + NV12-Convert auf der GPU.
Kein PCIe-Roundtrip, kein `Vec<u8>`-Alloc im Hot-Path.

**ffmpeg-next bindet `hwcontext_d3d11va.h` nicht** → das `AVD3D11VADeviceContext`-Layout
ist in `hwctx.rs` hand-gespiegelt + CRITICAL_SECTION als `lock`/`unlock`-Callback
(FFmpeg serialisiert intern darüber den D3D11-Device-Zugriff; der Capture-Callback
hält denselben Lock manuell für `CopySubresourceRegion`). Aktiv für NVIDIA (alle
Codecs) und AMD (AV1 via `av1_amf`).

**Pool-Bauart ist vendor-abhängig** (2026-07-30): NVIDIA nutzt das klassische
D3D11VA-Texture-Array (`initial_pool_size` Scheiben in EINER Textur), AMD bekommt
**Einzeltexturen** (`initial_pool_size=0`, libavutil `d3d11va_alloc_single`) — die
AMF-Runtime liest aus dem Array falsch (zerrissenes Bild, codec-unabhängig; Standbild-A/B
und Herleitung am Wert in `hwctx.rs::HwContext::new`). Messschalter:
`PULSE_HQ_D3D11_SINGLE_TEX=1|0` übersteuert die Vendor-Regel.

### AMD Zero-Copy H.264/HEVC (D3D12VA) — 2026-05-21
`src/pipeline_d3d12.rs` + `src/capture/wgc_d3d12.rs` + `src/encode/d3d12_convert.rs` +
`src/encode/encoder_d3d12.rs` (+ `extradata.rs`).

Historischer Anlass: `h264_amf` stürzte auf D3D11-Surface-Input ab (AMF #455, s.u.),
FFmpeg 8.1 hat aber native **`*_d3d12va`-Encoder** über Microsofts D3D12 Video Encode
API — die umgehen die AMF-Runtime komplett. Heute trägt der Zweig H.264/HEVC, weil er
um das Zweieinhalbfache latenzärmer ist als AMF (6,8 gegen 17,2 ms); **AV1 läuft NICHT
hier** (`av1_d3d12va` erzeugt einen Bitstrom, den kein Decoder liest — Messung in
`pipeline_d3d12::run`), sondern über den D3D11-Pfad oben. Pfad nach der Capture
komplett D3D12-only:
- WGC liefert weiterhin `ID3D11Texture2D`/BGRA (Windows hat keine D3D12-Capture) →
  `wgc_d3d12.rs` bridged jede Textur per **Shared-NT-Handle** D3D11→D3D12 (BGRA cross-API).
- `d3d12_convert.rs`: **D3D12-Compute-Shader** BGRA→NV12 (BT.709), schreibt direkt in den
  UAV-fähigen Encoder-Pool-Frame — kein CPU-swscale.
- `encoder_d3d12.rs`: `h264_d3d12va` / `hevc_d3d12va` / `av1_d3d12va` (Map `d3d12va_name()`).
  **Sonderfall:** der d3d12va-Encoder liefert keine `extradata` → `write_header` ist bis
  zum ersten Keyframe verzögert, avcC/SPS/PPS kommt aus dem Bitstream (`extradata.rs`).
- `AVD3D12VA*`-Structs sind wie bei NVIDIA in `encoder_d3d12.rs` hand-gespiegelt
  (ffmpeg-sys bindet die D3D12VA-Header nicht).

Kein PCIe-Roundtrip, kein CPU-swscale: conv-Zeit 17 ms → 2,9 ms, stabile 60 fps.

### CPU-Fallback (Intel/QSV + Kill-Switch)
`src/capture/wgc.rs` + `src/encode/encoder.rs` → `run_cpu_pipeline`.

BGRA via `frame.buffer().as_nopadding_buffer()` → CPU `Vec<u8>` → swscale BGRA→NV12 →
QSV/AMF. Aktiv für **Intel** sowie für jeden Vendor unter `PULSE_HQ_DISABLE_ZERO_COPY=1`.
Hat zusätzlich einen **NVIDIA-„BGR-direct"-Fastpath** (BGRA-Bytes 1:1 in den NVENC-Frame
ohne swscale).

## AMF-Issue #455 — historischer Anlass für den D3D12-Zweig

`h264_amf` stürzte auf **D3D11**-Surface-Input reproduzierbar mit
Integer-Divide-by-Zero in der AMF-Runtime ab (`SubmitInput`, Frame 0) —
AMF-Issue [#455](https://github.com/GPUOpen-LibrariesAndSDKs/AMF/issues/455).
Bind-Flags, Auflösung und NV12-vs-BGRA wurden damals als Ursache ausgeschlossen
(Probe `examples/probe_d3d11.rs`). **Das war der Grund, den D3D12VA-Zweig zu bauen.**

**Auf einer Radeon 780M mit dem Treiber vom Juli 2026 ist der Absturz nicht mehr
reproduzierbar** — AMF initialisiert über D3D11 sauber (`AMF initialisation succeeded
via D3D11`), und AV1 läuft seit 2026-07-30 standardmäßig genau so. Eine Maschine ist
kein Beleg, deshalb bleibt AMD-H.264/HEVC auf dem D3D12-Zweig: dort läuft es, und er
ist um das Zweieinhalbfache latenzärmer (6,8 gegen 17,2 ms).

**Dispatch-Detail:** die Regel steht einmal in `VideoCodec::encode_path`
(`encode/encoder.rs`) und wird **zweimal ausgewertet** — im Dispatcher
(`stream_controller::run_pipeline`) auf `select_adapter()`, das auf Multi-GPU den
`HIGH_PERFORMANCE`-Slot (dGPU) liefert und nicht zwingend die Display-/Capture-GPU;
und noch einmal in `pipeline_hw::run` auf der ECHTEN WGC-D3D11-Device-GPU
(`system::dxgi::device_vendor`). Passt die Kombination dort nicht, delegiert
`pipeline_hw` selbst weiter — an `pipeline_d3d12` oder den CPU-Pfad, je nachdem,
was `encode_path` sagt.

## Env-Overrides (Test/Debug)

**Für alle Schalter gilt dieselbe Auslegung** (`src/env.rs`): nicht gesetzt =
Vorgabe · leer oder `0` = aus · jeder andere Wert (`1`, `true`, `yes`, …) = an.
Variablen, die einen *Wert* tragen (Pfade, Zahlen, Optionslisten), sind unten
einzeln beschrieben.

- `PULSE_HQ_ADAPTER_VENDOR=nvidia|amd|intel` — Adapter-Filter statt
  DXGI-`HIGH_PERFORMANCE`-Default. Auf Multi-GPU (dGPU+iGPU) der einzige Weg, einen
  bestimmten Vendor-Pfad zu validieren, ohne den Default umzustellen.
- `PULSE_HQ_DISABLE_ZERO_COPY=1` — erzwingt den CPU-Pfad für **jeden** Vendor (NVIDIA wie
  AMD). Für A/B-Debugging; auf AMD = Fallback auf `h264_amf` (Software-NV12-Input).
  **Teuer:** bei 1440p→1080p60 gemessen rund eine volle CPU-Kerne.
- `PULSE_HQ_AMD_D3D11=1` — schickt AMD auch mit H.264/HEVC über den D3D11-Weg
  (`h264_amf`) statt über `h264_d3d12va`. **Messschalter für die Gegenprobe auf
  fremder AMD-Hardware**, nicht für den Regelbetrieb: das ist die Konstellation aus
  AMF-Issue #455. Auf einer Radeon 780M (Treiber 07/2026) läuft sie sauber, kostet
  aber Latenz — 17,2 statt 6,8 ms — bei dafür deutlich niedrigerer Video-Engine-Last
  (10,5 % statt 25,4 %). Herleitung: `docs/plans/2026-07-30-amd-windows-messung.md`.
- `PULSE_HQ_D3D11_SINGLE_TEX=1|0` — übersteuert die vendor-abhängige Pool-Bauart des
  D3D11-Pfads (Einzeltexturen statt Texture-Array; Vorgabe: AMD=Einzeltexturen,
  NVIDIA=Array). `0` reproduziert das zerrissene AMF-Bild auf AMD, `1` misst
  Einzeltexturen auf NVIDIA. Begründung am Wert in `encode/hwctx.rs`.
- `PULSE_INTRA_REFRESH=1` — rollender Intra-Refresh statt periodischer Vollbilder,
  wenn die Oberfläche nichts sagt (`overrides.intra_refresh` sticht). **Heißt auf
  Linux genauso**, damit die Prüfstand-Skripte plattformgleich bleiben. Trägt der
  Encoder die Betriebsart nicht, **bricht der Start ab** — ein Keyframe-Strom unter
  diesem Etikett wäre keine Messung, die scheitert, sondern eine, die täuscht.
  Welcher Encoder sie trägt und warum, steht in `src/encode/auffrischung.rs`; die
  Kurzfassung: AMD nur mit AV1 (`av1_amf`), NVIDIA immer, Intel nie, und
  `h264_d3d12va` nimmt die Option an, ohne etwas zu tun.
- `PULSE_WHIP_PACING=1` — verteilt die RTP-Pakete eines Bildes über die Zeit, statt
  sie als Schwall zu senden. **Aus als Vorgabe**: in dieser Fassung gemessen
  schlechter, nicht besser (Zahlen in `src/whip/pacer.rs`).
- `PULSE_HQ_FFMPEG_DEBUG=1` — FFmpegs eigenes Log auf `Debug` hochdrehen.
- `PULSE_HQ_SIDECAR=<pfad>` — Override für den Resolver in `desktop/electron/sidecar.ts`.
- `PULSE_HQ_NO_AV_OFFSET=1` — schaltet die QPC-A/V-Verankerung ab (reine Wall-clock,
  Verhalten vor der Offset-Korrektur).
- `PULSE_HQ_AV_OFFSET_MS=<ms>` — **Fallback** für den konstanten A/V-Trim (>0 = Ton
  später). Quelle der Wahrheit ist das UI-Feld „Ton-Versatz" (Windows-only, reist als
  `av_offset_ms` im `start`-Request mit, `src/encode/audio.rs`); die Env-Var greift nur,
  wenn der UI-Wert 0 ist.

### Latenz messen und drehen (2026-07-30)

- `PULSE_ENC_LATENCY_LOG=1` — gibt die 2-Sekunden-Zusammenfassung des
  `TickMonitor` auch dann aus, wenn das Fenster sauber war (sonst schweigt sie).
  Die Zeile traegt `enc avg=/max= (n)`: die **Encode-Latenz** vom Einschieben
  eines Bildes bis zu seinem Paket. Das ist NICHT `send` — `send` ist die Dauer
  des Submit-Aufrufs und bleibt bei einem Encoder mit Vorlauf nahe null,
  waehrend das Paket zwei Bilder spaeter herausfaellt. Gegenprobe auf der
  RTX 5080 (2026-07-30): Vorgabe 1,8 ms, mit `PULSE_ENCODER_OPTS=delay=2`
  16,8 ms — exakt ein Bildabstand bei 60 fps, bei unveraendertem `send`.
- `PULSE_ENCODER_OPTS="k=v,k=v"` — beliebige Encoder-Optionen, ueberschreibt die
  Vendor-Vorgaben. Damit faehrt ein Messlauf eine ganze Reihe ohne Neubau; das
  ist das Werkzeug fuer den offenen AMD-Teil (`async_depth`, `usage`). Schluessel,
  die der Encoder nicht kennt, werden vor dem Open gemeldet — ffmpeg verwirft sie
  sonst **stillschweigend**, und eine wirkungslose Messvariante ist von einer
  wirksamen nicht zu unterscheiden.
- `PULSE_MUX_INTERLEAVE_US=<us>` — `max_interleave_delta` (Default 10000).
  Groesser = der Muxer haelt Bilder laenger fuer den Ton zurueck; zu klein toetet
  den Stream (`write_interleaved: Invalid argument`), s. `src/encode/output.rs`.
- `PULSE_OPUS_FRAME_MS=5|10|20|40|60` — Laenge eines Opus-Pakets (Default 5).
  **Dreht am Bild, nicht am Ton:** der FLV-Muxer gibt Bilder in Ton-Buendeln
  frei. Das Aufnahme-Raster zieht automatisch mit.
- `PULSE_MUX_LATENCY_LOG=1` — meldet je Sekunde, wie weit die Ton-Zeitlinie
  hinter der Wanduhr herlaeuft. Jede Millisekunde davon haelt der Muxer als
  Bild-Latenz fest. Auf dieser Maschine gemessen: -7 bis +4 ms ohne Trend, also
  kein anhaltender Rueckstand (anders als auf Linux, wo der PipeWire-Null-Sink
  27-29 ms einbrachte und eine Korrektur noetig war).
- `PULSE_TCP_NODELAY=0` — Nagle wieder an (Vergleichsmessung).

## TLS/RTMPS-Fußnote

FFmpegs Schannel-Backend auf Windows ist strict-verify by default — `tls_verify=0`
MUSS gesetzt sein, wenn MediaMTX self-signed nutzt (Pulse-Default, Token in URL ist
die echte Auth). Sonst killt FFmpeg den Push nach dem TLS-Handshake mit „Writing
encrypted data to socket failed" (sieht aus wie ein Network-Bug, ist aber
Cert-Verification — `encode/output.rs::open_output` setzt das automatisch bei
`rtmps://`).

## Tests

`cargo build --release` baut + DLL-Copy. Smoke via `examples/test_driver.rs`:

```
cargo run --release --example test_driver -- health|video_only|audio_mux|av1_mux|hevc_mux [rtmp_url]
```

Erwartet MediaMTX auf `rtmp://localhost:1935/<path>` (lokal:
`mediamtx-dist/v1.18.1/mediamtx.exe mediamtx-dist/v1.18.1/mediamtx.yml`). `video_only`
läuft Capture + Encode + Push 10s, validiert `state=live` + ≥1 `fps`-Event;
`audio_mux` zusätzlich Opus-Spur. Logs → `target/test-driver-<scenario>-<unix-ts>.log`.

**Achtung:** DLL-Copy schlägt fehl, wenn ein laufender Sidecar die alten DLLs hält —
der Build kennt die exe-Lock-Datei, gibt aber nur eine Warning auf die DLLs (Build
läuft trotzdem fertig, nur die kopierten DLLs sind dann stale).

> Hintergrund-Recherche zum Pfad-Entscheid (Capture/Audio/Encode-Crate-Wahl,
> Lizenz-Fallen, Aufwandsschätzung): `WINDOWS_HQ_SIDECAR.md` im Repo-Root.
