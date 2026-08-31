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
nie — und er trägt **kein AV1**. Der Rückkanal ist beim heutigen
Vollbild-Abstand von **60 s** Voraussetzung und nicht Zubehör: ein beitretender
Zuschauer wartete sonst bis zu eine Minute auf sein erstes Bild.

*(Bis zum 2026-08-21 stand die Begründung auf Intra-Refresh — so ein Strom hatte
nach dem Start überhaupt kein Vollbild mehr, und AV1 war auf AMD der einzige
Codec, der die Betriebsart trug. Die Betriebsart ist aus Pulse entfernt. Die
beiden Mängel des Muxers bleiben, sie werden jetzt vom gestreckten
Vollbild-Abstand allein getragen.)*

Dieselbe Fassung wie im Linux-Sidecar. **`http(s)://` schickt jeden Hersteller
auf den eigenen Sender** — `encode_path` prüft die URL, bevor es den Hersteller
ansieht (`encode/codec.rs`); ffmpegs Muxer bleibt damit dem RTMPS-Weg
vorbehalten, und dort ist der Rückkanal ohnehin nicht vorgesehen.

## Stack

- **Capture:** `windows-capture` v2 (WGC, ID3D11-Texture-Output) — **gepatchter
  Zweig** unter `vendor/windows-capture/` (gitignored,
  `scripts/bootstrap-windows-capture.sh` stellt ihn her): die Crate reicht die
  WGC-Session einmal an den Handler durch (`on_session_ready`), damit das
  Cursor-Echo der Fernsteuerung den Host-Cursor zur Laufzeit aus dem Stream
  nehmen kann (`capture/cursorsteuerung.rs`).
- **Audio:** `wasapi` (Desktop-Loopback + Mikrofon). Der **„Desktop"**-Modus nutzt
  WASAPI-Process-Loopback im **EXCLUDE-Modus** über den Pulse-Prozess-Tree
  (`new_application_loopback_client(pid, include_tree=false)` →
  `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`), damit Pulses eigener Ton —
  v. a. die Wiedergabe der anderen Voice-Teilnehmer — nicht als Echo in den Stream
  läuft. `pid` = Electron-Main-PID via `PULSE_SELF_PID` (gesetzt in
  `desktop/electron/sidecar.ts`); fehlt sie, Fallback auf den simplen
  Render-Loopback. Linux-Äquivalent: `-a app-inverse:Pulse` (`gsr-sidecar/profiles.py`).
- **Encode/Mux:** `ffmpeg-next` 8.1, gelinkt gegen ein **unverändertes** LGPL-shared-
  Fertigpaket unter `ffmpeg-dist/n8.1-lgpl-shared/` (Pfad via `.cargo/config.toml`
  `FFMPEG_DIR`; `build.rs` kopiert die DLLs neben die exe) — s. „Das FFmpeg" unten.
- MediaMTX-Build für lokales Testen unter `mediamtx-dist/v1.18.1/mediamtx.exe`.

## Drei Encode-Pfade

Dispatch über `VideoCodec::encode_path` (`encode/codec.rs` — die EINE Stelle für die
Regel), ausgewertet in `src/stream_controller.rs::run_pipeline`: **`nvidia` und `amd` →
`pipeline_hw`** (D3D11-Zero-Copy, alle Codecs — NVENC bzw. AMF), sonst (Intel) →
`run_cpu_pipeline`. `PULSE_HQ_DISABLE_ZERO_COPY=1` zwingt jeden Vendor auf den CPU-Pfad
(für AMD = `h264_amf` mit Software-NV12), `PULSE_HQ_AMD_D3D12=1` holt für AMD-H.264/HEVC
den `pipeline_d3d12`-Weg als Gegenprobe zurück.

**Bis 2026-08-04 stand hier die alte Aufteilung** — H.264/HEVC auf AMD über
`pipeline_d3d12`, nur AV1 über AMF. Sie war je Codec begründet (D3D12 latenzärmer, AMF
sparsamer) und ist einer Vereinheitlichung gewichen: ein Weg statt zwei. Der Preis steht
am Schalter `amd_forces_d3d12` in `encode/codec.rs` — rund 10 ms, exakt ein Bildabstand,
weil AMF codec-unabhängig ein Bild zurückhält.

**Wer eine Encoder-Eigenschaft abfragt, muss den Encoder meinen, der bei dieser
Kombination WIRKLICH läuft** — nicht den, den die Optionstabelle nahelegt. Genau diese
Aufteilung ist der Grund: derselbe Codec landet je nach Hersteller und Schalter bei einem
anderen ffmpeg-Encoder. Übrig davon ist `encode/auffrischung.rs::braucht_selbsttakt`:
`h264_amf` frischt unter `usage=ultralowlatency` von sich aus auf und verschluckt damit
den bestellten Vollbild-Takt, seine Vollbilder kommen deshalb aus `keyframe::Selbsttakt`.

*(Bis zum 2026-08-21 stand hier stattdessen die Fähigkeitsmeldung
`health.gsr.intra_refresh` samt `encoder_name` — sie beantwortete dieselbe Frage für die
Betriebsart rollender Intra-Refresh, deren Musterfall `h264_d3d12va` war: der nimmt die
Option an und tut nichts damit. Betriebsart, Meldung und Startverweigerung sind entfallen;
die Lehre, am echten Encoder zu fragen, ist geblieben.)*

### HDR (seit 2026-08-06)

`overrides.hdr` schaltet ihn ein, `health.gsr.hdr` meldet, ob diese Maschine ihn
überhaupt liefern kann. Belegt ist er heute für **AV1 über AMF** (AMD,
2026-08-06) und **AV1 über NVENC** (NVIDIA, 2026-08-11) — Tabelle je Encoder in
`encode/hdr.rs`, Messungen in `docs/2026-08-06-hdr-windows-amd.md` und
`docs/2026-08-11-hdr-windows-nvidia.md`. *(Hier stand bis zum 2026-08-11
„allein AV1 über AMF; NVIDIA ist ungemessen" — das ist eingelöst.)*

**Die HDR10-Mastering-Angaben sind auf beiden Herstellern mangelhaft, und zwar
verschieden.** Auf AMD stehen sie im Strom, aber mit falscher Skalierung (AMF
rechnet die HDR10-Nenner nicht in die AV1-Festkommaformate um; bewusst nicht
vorkompensiert). Auf NVIDIA fehlen sie ganz — NVENCs AV1-Encoder schreibt auf
Treiber 610.47 kein `OBU_METADATA`, obwohl FFmpeg sie ihm übergibt; belegt
gegen `hevc_nvenc`, das sie über dieselbe Codestelle schreibt. Der Sidecar sagt
das beim Start an (`hdr::mastering_fehlt`). Die **Signalisierung** — Kurve,
Primärvalenzen, Matrix, Bittiefe — ist in beiden Fällen vollständig, und nur an
ihr hängt die Bilddeutung.

**Vier Bedingungen, alle notwendig** — Bildschirm läuft in HDR, Encode-Weg ist
der über D3D11, Encoder trägt es, und es wird in 10 bit encodiert (das schaltet
HDR selbst ein, PQ in 8 bit wäre in jedem Verlauf geringelt). Fehlt eine,
**verweigert der Start** mit einer Meldung, die die Abhilfe nennt — anders als
beim 10-bit-Wunsch, der still zurückfällt. Der Unterschied ist Absicht: 10 bit
weniger als bestellt sieht man höchstens an einem Verlauf, SDR statt HDR am
ganzen Bild.

Der Weg unterscheidet sich an zwei Stellen vom SDR-Weg, und beide sind nicht
offensichtlich:

* **Die Aufnahme läuft in `Rgba16F` (scRGB)** statt BGRA (`capture::bildformat`).
  In BGRA gibt WGC einen bereits auf SDR heruntergerechneten Desktop heraus —
  was dort verlorengeht, holt keine spätere Stufe zurück.
* **Die Farbwandlung macht ein eigener Shader** (`encode/hdr_zeichner.rs`), nicht
  der Video-Prozessor. Der kann auf dieser AMD-Karte kein PQ: von 32 geprüften
  Kombinationen sind zwei möglich, keine davon mit PQ, und 16-Bit-Fließkomma
  wird am Eingang grundsätzlich abgelehnt. Nachfahrbar mit
  `cargo test -- --ignored --nocapture wandlungen_dieses_treibers`.
* **Und er läuft seit dem 2026-08-07 schon im Aufnahme-Rückruf**, direkt aus der
  WGC-Textur nach P010 (`capture/aufnahmeziel.rs`). Damit entfällt die
  fp16-Zwischenkopie, die es vorher je Bild gab; gemessen halbiert das die
  3D-Last des Senders (21,2 → 10,6 %). Zurück auf den alten Weg:
  `PULSE_HQ_HDR_ZWISCHENKOPIE=1`. Voraussetzung war ein Zähler für WGC-seitig
  verworfene Bilder (`capture/rueckruf.rs`) — ohne ihn tauschte man messbare
  Last gegen unsichtbaren Bildverlust. Messakte:
  `streaming/testbench/profiles/leistung-2026-08-07-wandlung-im-rueckruf.json`.

Vollständige Messung samt der beiden Nebenbefunde (Mastering-Metadaten kommen
mit falschen Zahlen an; der 10-bit-SDR-Weg hat sich bis dahin als PQ ausgegeben):
`docs/2026-08-06-hdr-windows-amd.md`.

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

**Pool-Bauart hängt am Vendor UND am Format**: NVIDIA nutzt in 8 bit das klassische
D3D11VA-Texture-Array (`initial_pool_size` Scheiben in EINER Textur), **Einzeltexturen**
(`initial_pool_size=0`, libavutil `d3d11va_alloc_single`) bekommen AMD und jeder
P010-Pool. Zwei getrennte Gründe:
- **AMD, jedes Format** (2026-07-30): die AMF-Runtime liest aus dem Array falsch
  (zerrissenes Bild, codec-unabhängig; Standbild-A/B am Wert in `hwctx.rs`).
- **P010, jeder Vendor** (2026-08-04): NVIDIA lehnt ein P010-Texture-Array ab
  (`CreateTexture2D` → `E_INVALIDARG`), womit **jeder 10-bit-Stream vor dem
  Encoder-Open starb**, während `health` die Fähigkeit meldete.

**Auf NVIDIA trägt der 10-bit-Weg echte 10 bit — unabhängig bestätigt am
2026-08-11** (RTX 5080, Treiber 610.47), an beiden Enden geprüft:
`high_bitdepth = 1` im AV1-Sequenzkopf UND dekodierte Bildpunkte zwischen den
8-bit-Stufen (Anteil auf Rest 0: 14,6 / 14,6 / 33,3 % über drei Läufe, gegen
100,0 % im 8-bit-Lauf desselben Aufbaus). **`av1_nvenc` bekommt dafür KEINE
Bittiefen-Option** — die Tiefe folgt dem Pool-Format; `bitdepth=10` ist eine
AMF-Eigenheit (`encode/opts.rs`). Werkzeug
`win-hq-labor/testbench/nvidia-zehnbit-nachweis.ps1`, Messakte
`streaming/testbench/profiles/nvidia-2026-08-11-windows-zehnbit.json`.

Messschalter: `PULSE_HQ_D3D11_SINGLE_TEX=1|0` übersteuert beides.

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
`src/capture/wgc.rs` + `src/encode/codec.rs` → `run_cpu_pipeline`.

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
via D3D11`), und AV1 läuft seit 2026-07-30 standardmäßig genau so.

**Seit 2026-08-04 läuft H.264/HEVC ebenfalls über AMF** (Nutzer-Entscheidung: ein Weg
statt zwei). Eine Maschine bleibt kein Beleg, deshalb zwei Vorkehrungen: das
Auffangnetz in `bildencoder.rs` gibt bei einem gescheiterten D3D11-Open an
`pipeline_d3d12` ab, und `PULSE_HQ_AMD_D3D12=1` stellt den alten Weg ohne Neubau her.

Hier stand bis dahin „deshalb bleibt AMD-H.264/HEVC auf dem D3D12-Zweig". Die
Latenzzahl dahinter gilt unverändert — D3D12 ist um das Zweieinhalbfache latenzärmer
(6,8 gegen 17,2 ms) —, sie wiegt die zwei Encode-Wege nur nicht mehr auf.

**Dispatch-Detail:** die Regel steht einmal in `VideoCodec::encode_path`
(`encode/codec.rs`) und wird **zweimal ausgewertet** — im Dispatcher
(`stream_controller::run_pipeline`) auf `select_adapter()`, das auf Multi-GPU den
`HIGH_PERFORMANCE`-Slot (dGPU) liefert und nicht zwingend die Display-/Capture-GPU;
und noch einmal in `pipeline_hw::run` auf der ECHTEN WGC-D3D11-Device-GPU
(`system::dxgi::device_vendor`). Passt die Kombination dort nicht, delegiert
`pipeline_hw` selbst weiter — an `pipeline_d3d12` oder den CPU-Pfad, je nachdem,
was `encode_path` sagt.

## Fernsteuerung — Eingabe-Injektion (`src/remote_input/`)

Der Sidecar ist der **Host** des Eingabe-Wire-Protokolls **v2** (verbindlich:
`docs/plans/2026-08-12-input-wire-protokoll-v2.md`). Der Steuernde erzeugt die
Frames, der chat-gateway reicht sie unangetastet durch, hier werden sie geparst
und per `SendInput` gespielt. Zwei Operationen:

```jsonc
{"op":"remote_input", "id":7, "slot":0, "session_id":"…", "host_active":false, "frames":["AAI=","AwAB"]}
// → {"ok":true, "processed":2, "state":"live"}
{"op":"remote_input_end", "id":8}
// → {"ok":true, "state":"ended", "released":0}
```

`state` ist neben `live` auch `unknown_slot` (kein Stream auf diesem Platz),
`unresolved_source` (Quelle weg), `masked` (Sichtschutz schwärzt gerade) oder
`host_active` (**Vorrang des Hosts**, s. unten) — alle vier verwerfen still,
**geben aber alles Gedrückte frei** und lassen die Sitzung stehen.

`host_active` in der ANFRAGE ist etwas anderes als in der Antwort: es meldet,
dass ein **anderer** Stream-Platz dieses Rechners gerade Vorrang meldet. Die
Wache sitzt je Sidecar-Prozess, und ein Prozess sieht die anderen nicht — nur
der Renderer des Hosts kennt alle Plätze. Fehlt das Feld, gilt „kein fremder
Vorrang"; es kann die Eingabe ausschließlich einschränken.

**Vorrang des Hosts** (`remote_input/wache.rs`, die Übergänge selbst seit dem
2026-08-23 plattformfrei in `pulse-fernsteuerung/src/sitzung/vorrang.rs`): Regt
sich der Host körperlich an Maus oder Tastatur, wird die Fremdeingabe für 5 s verworfen
(gleitend, `PULSE_FERN_VORRANG_MS`). Erkannt über einen systemweiten
Low-Level-Hook; die eigene Injektion trägt dafür `PULSE_MARKE` in
`dwExtraInfo`. Lässt sich der Hook nicht anmelden, **verweigert der Handschlag
die Sitzung**. Solange der Vorrang gilt, wird er einmal je Sekunde als
`{"ev":"remote_state","state":"host_active","hold_ms":…}` wiederholt — der
Renderer reicht das an den Steuernden weiter, dessen Client daran das Ende
erkennt und sein Gehaltenes nachzieht. `ended` heißt: der Prozess fährt herunter, die Sitzung ist
endgültig zu. `ok:false` heißt **fail-closed**: die Sitzung ist stillgelegt, es
kommt zusätzlich ein `{"ev":"remote_state","state":"input_error"}`, und weiter
geht es erst nach `remote_input_end`.

Drei Dinge, die man beim Lesen sucht:

- **Der Slot** benennt einen der gleichzeitig laufenden Streams, nicht einen
  Monitor. Auf Windows liegt je Platz ein **eigener Sidecar-Prozess**
  (`desktop/electron/sidecar.ts::getSidecar`), innerhalb eines Prozesses gibt es
  genau einen Stream. Nennt die `start`-Anfrage ein `slot`-Feld, nimmt der Stream
  nur diesen Platz an; ohne das Feld trägt er jeden bis zur Schranke
  (`SLOT_MAX = 98`, dieselbe wie `sidecar.ts::MAX_STREAM_SLOTS`). Ein
  **missgeformter** Platz (`-1`, `1.5`, `"0"`) ist ein Protokollfehler und wird
  nicht auf 0 zurechtgebogen; ein Platz **außerhalb** des Bereichs ist nur
  „unbekannt". Seit dem 2026-08-23 plattformfrei in
  `pulse-fernsteuerung/src/slot.rs` (die Schranke) und
  `pulse-fernsteuerung/src/huelle.rs` (die Missgeformt-Regel samt
  Altfehler-Begründung); `src/remote_input/ziel.rs` behält nur noch die
  Auflösung auf einen laufenden Stream (`bindung_fuer_slot`).
- **Das Ziel kommt von der Aufnahme.** Welches Fenster bzw. welcher Bildschirm
  gemeint ist, meldet die Aufnahme selbst (`capture/wgc*` →
  `ziel::ziel_gebunden`); die Fernsteuerung löst die Quelle **nicht** ein zweites
  Mal auf. Sonst liefen beide Antworten auseinander (exklusives Vollbild,
  Titel-Treffer) und die Eingabe zielte dorthin, wo der Zuschauer nichts sieht.
- **DPI-Pflicht.** `main.rs` setzt `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`
  als allererstes. Ohne das sind alle Koordinaten-Schnittstellen bei Skalierung
  ≠ 100 % virtualisiert und jede Injektion trifft systematisch daneben.
- **Nichts verlässt das Quell-Rechteck** (`pulse-fernsteuerung/src/ausfuehrung.rs`). Der
  Sidecar führt die zuletzt von ihm gesetzte Zeigerlage mit; sie ist immer
  geklemmt. **Auch die relative Bewegung** rechnet darauf und wird geklemmt
  **absolut** gesetzt — die Windows-Beschleunigung fällt damit weg, weil ein
  Delta sich sonst nicht klemmen ließe (`GetCursorPos` nach `SendInput` trägt
  nicht: die Rohreingabe wird asynchron verarbeitet). **Knopf und Rad tragen
  keine Position** und feuern deshalb nur mit gültiger Lage im aktuellen
  Rechteck, die sie vorher noch einmal behaupten. Ohne beides genügten zwei
  Frames (`0x02` mit `dx=dy=-32768`, dann `0x03`) für einen Klick irgendwo auf
  dem Desktop des Hosts. **Ausnahme:** das Hoch-Ereignis eines von uns
  gedrückten Knopfes geht immer durch, sonst klemmt eine Maustaste.
- **Alles loslassen beim Ende.** Gedrückte Tasten und Knöpfe werden mitgeführt und
  bei jedem Ende freigegeben: `remote_input_end`, Sitzungswechsel (andere
  `session_id` — **auch eine fehlende**), jedes **weitere Hello** („neuer
  Eingabestrom"), fail-closed, Sichtschutz, Prozessende — **und bei jeder
  verworfenen Nachricht** (unbekannter Slot, unauflösbare Quelle). Es genügt,
  dass der Host sein gestreamtes Fenster minimiert; ohne die Freigabe liefe die
  Taste am fremden Rechner weiter.
- **Der Handschlag ist Sitzungszustand, keine Eingabe.** Ein Hello gilt auch
  dann, wenn die Frames derselben Nachricht verworfen werden (Slot unbekannt,
  Quelle nicht auflösbar, Sichtschutz). Sonst tötete ein Hello, das in eine
  Verwerf-Lage fällt — Stream läuft gerade an, Sidecar nach `stop` neu
  gestartet —, die Sitzung eine Nachricht später mit „Eingabe vor dem
  Hello-Handschlag".

## Fernsteuerung — geteilte Zwischenablage (`src/ablage/`)

Entwurf: `docs/superpowers/specs/2026-08-31-fernsteuerung-zwischenablage-design.md`.
Der Mechanismus ist **verzögertes Rendern** und liegt vollständig in
`streaming/pulse-ablage` (Rahmenformat, Stückelung, Zustandsführung, Fristen);
hier steht nur die Windows-Hälfte. Eine Operation:

```jsonc
{"op":"ablage", "id":9, "params":{"data":{"anstoss":"beginn"}}}
{"op":"ablage", "id":9, "params":{"data":{"rahmen":{"t":"neu","gen":1,"typ":"text"}}}}
// → {"ok":true}
```

Was hinausgeht, kommt **als Ereignis** (`{"ev":"ablage","data":{…}}`), nicht als
Antwort: ein `hol` wird beantwortet, sobald der Lesevorgang durch ist, und die
Abruf-Frist meldet sich Takte später.

Vier Dinge, die man beim Lesen sucht:

- **Der Rückruf blockiert, und deshalb liegt er auf einem eigenen Faden.**
  `WM_RENDERFORMAT` muss mit `SetClipboardData` beantwortet werden, bevor er
  zurückkehrt — in dieser Zeit wartet das einfügende Programm auf einen
  Netz-Umlauf. Er darf weder auf dem Dispatch-Faden liegen noch auf dem
  **Hook-Faden der Vorrang-Wache**: Windows hängt einen Hook, dessen Faden nicht
  binnen `LowLevelHooksTimeout` (300 ms) antwortet, stillschweigend ab.
- **Es sind zwei eigene Fäden.** Der Takt (`ablage/mod.rs`) läuft nicht auf dem
  Fensterfaden, weil er weiterlaufen muss, *während* der in `WM_RENDERFORMAT`
  steht: die Abruf-Frist ist es, die dem wartenden Programm die leere Antwort
  zustellt. Ein Faden, der auf sich selbst wartet, hängt.
- **`beginn` ist die Trägerwahl.** Je Stream-Platz läuft ein eigener
  Sidecar-Prozess, die Zwischenablage ist maschinenweit; beanspruchten alle,
  überschrieben sie sich gegenseitig. Gewählt wird im Renderer des Hosts
  (`web/src/lib/remote/ablageTraeger.ts`) — dieselbe Auflösung wie beim Vorrang.
  Ein Sidecar ohne diesen Anstoß stellt kein Fenster auf und rührt die Ablage
  nicht an.
- **Jedes Prozessende schreibt den Vorbestand zurück** (`beenden_endgueltig`,
  aus `main.rs` auf beiden Wegen). Der Sidecar ist per-Stream: endet der
  Träger-Stream, stirbt der Prozess — als Eigentümer eines verzögerten
  Rendervorgangs. Ohne das Zurückschreiben hielte Windows danach ein leeres
  Fach, und was der Nutzer vor der Sitzung kopiert hatte, wäre still weg.

**Was geprüft ist und was nicht.** Die Rechnung darüber steht in
`streaming/pulse-ablage` (80 Tests) und läuft in jedem Gate. Die Buchführung
über eigene und fremde Änderungen (`ablage/geteilt.rs`, 6 Tests) enthält keinen
Win32-Aufruf und läuft **hier**, also in `cargo test` dieses Crates — und das
fährt nur, wer auf Windows sitzt (`gate-rust.sh` nimmt den Sidecar
ausdrücklich nicht, er baut auf Linux nicht). Beim Bau von Plan 1b-2 wurden sie
über ein Wegwerf-Crate auf der Linux-Maschine gefahren; **im Repo hängen sie an
keinem Gate**. Die Win32-Aufrufe selbst sind nur **übersetzt**, gegen
`x86_64-pc-windows-msvc`. Echtes Kopieren über zwei Maschinen bleibt
Handarbeit.

## Env-Overrides (Test/Debug)

**Für alle Schalter gilt dieselbe Auslegung** (`src/env.rs`): nicht gesetzt =
Vorgabe · leer oder `0` = aus · jeder andere Wert (`1`, `true`, `yes`, …) = an.
Variablen, die einen *Wert* tragen (Pfade, Zahlen, Optionslisten), sind unten
einzeln beschrieben.

- `PULSE_FERN_VORRANG_MS=<zahl>` — wie lange die Fremdeingabe nach einer Regung
  des Hosts verworfen wird (Vorgabe 5000, geklemmt auf 100…60000). Gedacht für
  den Zwei-Geräte-Test, wo fünf Sekunden je Durchgang die Messung beherrschen.
- `PULSE_HQ_FERN_TICKRASTER=1` — Notausgang: im Fern-Modus wieder starr takten
  statt bei Ankunft zu senden (A/B gegen den Latenzgewinn).
- `PULSE_HQ_ADAPTER_VENDOR=nvidia|amd|intel` — Adapter-Filter statt
  DXGI-`HIGH_PERFORMANCE`-Default. Auf Multi-GPU (dGPU+iGPU) der einzige Weg, einen
  bestimmten Vendor-Pfad zu validieren, ohne den Default umzustellen.
- `PULSE_HQ_DISABLE_ZERO_COPY=1` — erzwingt den CPU-Pfad für **jeden** Vendor (NVIDIA wie
  AMD). Für A/B-Debugging; auf AMD = Fallback auf `h264_amf` (Software-NV12-Input).
  **Teuer:** bei 1440p→1080p60 gemessen rund eine volle CPU-Kerne.
- `PULSE_HQ_AMD_D3D12=1` — schickt AMD mit H.264/HEVC zurück auf `h264_d3d12va`
  statt auf AMF. **Der Gegenprobe-Schalter, seit AMF der Regelweg ist** (2026-08-04;
  bis dahin hieß er `PULSE_HQ_AMD_D3D11` und wirkte andersherum). Auf AV1 hat er
  keine Wirkung — `av1_d3d12va` gibt keine brauchbare extradata heraus.
  D3D12 ist latenzärmer (6,8 statt 17,2 ms — AMF hält codec-unabhängig ein Bild
  zurück), kennt dafür kein `usage` und liegt fest bei rund 25 % Video-Engine.
  Herleitung: `docs/plans/2026-07-30-amd-windows-messung.md`.
- `PULSE_HQ_D3D11_SINGLE_TEX=1|0` — übersteuert die Pool-Bauart des D3D11-Pfads
  (Einzeltexturen statt Texture-Array; Vorgabe: Einzeltexturen bei AMD **und** bei
  jedem P010-Pool, sonst Array). `0` reproduziert das zerrissene AMF-Bild auf AMD
  und den P010-Fehlschlag auf NVIDIA, `1` misst Einzeltexturen auf NVIDIA in 8 bit.
  Begründung am Wert in `encode/hwctx.rs`.
- *(`PULSE_INTRA_REFRESH=1` gab es bis zum 2026-08-21 und gibt es nicht mehr:
  rollender Intra-Refresh statt periodischer Vollbilder, mit Startverweigerung,
  wenn der Encoder die Betriebsart nicht trug. Die Betriebsart ist aus Pulse
  entfernt — die Variable wird nicht mehr gelesen, auf Windows so wenig wie auf
  Linux. Der Vollbild-Abstand steht durchgehend auf 60 s,
  `PULSE_KEYFRAME_SECONDS` verstellt ihn.)*
- `PULSE_WHIP_PACING=0` — schaltet die Verteilung der RTP-Pakete eines Bildes über
  die Zeit AB (zurück zum Schwall-Senden). **AN als Vorgabe seit 2026-08-14**, seit
  dem Neubau mit absoluten Zeitpunkten und Paketgruppen; die erste Fassung war
  gemessen schlechter und deshalb aus (Zahlen und beide Fassungen in
  `src/whip/pacer.rs`).
- `PULSE_LABOR_EINGABE_OHNE_STREAM=1` — lässt die Fernsteuerung **ohne laufenden
  Stream** injizieren; Quell-Rechteck ist dann der primäre Bildschirm. Nur zum
  Messen, ob eine gesendete Koordinate am Host auf dem Punkt ankommt
  (`streaming/win-hq-labor/testbench/eingabe-pruefziel.ps1`), ohne dafür einen
  echten Bildschirm-Push aufbauen zu müssen. **Kein Produktweg** — angeschaltet
  fällt die Kopplung „du kannst nur dorthin klicken, wo du auch hinsiehst" weg;
  nichts im ausgelieferten Pfad setzt die Variable.
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

## Das FFmpeg — ein unverändertes Fertigpaket

Unter `ffmpeg-dist/n8.1-lgpl-shared/` liegt BtbNs LGPL-shared-Bau von FFmpeg 8.1,
**ohne jeden Pulse-Patch**.

- **Holen:** `pwsh scripts/fetch-ffmpeg.ps1`. Es lädt eine eingefrorene, selbst
  gespiegelte Kopie (`howispulse.com/downloads/vendor/…-2026-06-16.zip`) und prüft
  den SHA256. Selbst gespiegelt, weil BtbNs `latest` ein rollendes Tag ist: dessen
  Artefakte werden laufend neu hochgeladen, ein gepinnter Hash wird dabei stale, und
  CI scheitert dann mit „SHA256 mismatch". Beim Anheben gilt `$Url` und
  `$ExpectedSha` **gemeinsam** setzen, nie ein stiller Wechsel.
- **Lizenz bleibt LGPL:** kein `--enable-gpl`, kein `--enable-nonfree`, kein
  libx264/libx265. Die DLLs liegen dynamisch gelinkt neben der `.exe`.
- **Ein Auslieferungs-Bump gehört dazu:** Änderungen unter
  `streaming/win-hq-sidecar/**` erreichen Bestandsclients nur mit einem
  `version`-Bump in `desktop/package.json` (electron-updater ignoriert eine
  erneut veröffentlichte gleiche Version wortlos).

**Vom 2026-08-05 bis zum 2026-08-21 stand hier das Gegenteil**, und zwar
ausführlich: „selbst gebaut, seit 2026-08-04", ein eigenes Bauskript
`scripts/build-ffmpeg-patched.ps1` (FFmpeg n8.1.2 + MSYS2/mingw64), ein
zugeschnittener Satz Fremdbibliotheken (48 statt 250 MB), ein von Hand auf den VPS
gelegtes Zip samt `$PatchedUrl`/`$PatchedSha`, und eine Erkennung im Fetch-Skript,
ob das vorliegende Paket gepatcht ist. Der einzige Grund dafür war **ein** Patch:
`av1_amf` hatte die Optionen `intra_refresh_mode`/`intra_refresh_stripes` in keiner
FFmpeg-Fassung, weder in 8.1 noch in `master`. Mit der Betriebsart rollender
Intra-Refresh ist der Patch entfallen und mit ihm der ganze Apparat — **Bauskript,
Zip-Erkennung und die beiden `$Patched*`-Variablen sind gelöscht**, nicht bloß
ungenutzt. Wer sie in einer alten Anleitung findet, sucht vergeblich.

**Nach einem Austausch des Pakets muss `build.rs` einmal laufen**, sonst liegen
neben der `.exe` weiter die alten DLLs — Windows sucht dort zuerst, und
`ffmpeg.exe -h` zeigt dann das Neue, während das Programm mit dem Alten läuft:

```
(Get-Item build.rs).LastWriteTime = Get-Date
cargo build --release --bins --examples
```

**Daran muss man selbst denken** — bis zum 2026-08-21 stand hier, das Bauskript
stupse `build.rs` an; dieses Skript gibt es nicht mehr, und `fetch-ffmpeg.ps1` tut
es nicht.

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
