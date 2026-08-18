# pulse-linux-hq-sidecar

Rust-Neubau des Pulse **Linux HQ-Streaming-Sidecars** — ersetzt den Python-`gsr-sidecar`
(`pulse/streaming/gsr-sidecar/`), der das externe `gpu-screen-recorder`-Binary spawned.
Wie die Windows/macOS-Rust-Sidecars: **FFmpeg als Bibliothek** (kein zweites Programm),
gleiches stdio-JSON-RPC-Protokoll wie `gsr-sidecar/control.py`.

**Das ist der ausgelieferte Aufnahmeweg** — seit 2026-07-17 der Standard unter Linux
(der Python-GSR-Sidecar ist nur noch Auffangnetz), gebaut vom Flatpak-Manifest nach
`/app/bin/pulse-linux-hq-sidecar`. Wer am experimentellen Sendeweg misst (eigener
WebRTC/WHIP-Push, AV1-Paketierer, FEC), arbeitet **nicht hier**, sondern in
`streaming/hq-labor/` — ein eigenes Binary, das diesen Code als Bibliothek einbindet.

## Stack
- **Capture**: xdg-desktop-portal ScreenCast → PipeWire-DMABUF, zero-copy in den Encoder.
- **Encode**: VAAPI (AMD/Intel) / NVENC (Nvidia) via `ffmpeg-next` 8.1 gegen den
  **gepatchten FFmpeg-Eigenbau n8.1.1** (`scripts/hq-bauen.sh`, per pkg-config gefunden,
  RPATH auf `~/.cache/pulse/ffmpeg-intra-refresh/prefix`) — nicht gegen das der Distribution. Codecs: **nur H264 + AV1** (kein HEVC). Die Encoder-Optionen gehen auf GSR
  zurück, sind aber **nicht mehr 1:1** — maßgeblich ist `encode/opts.rs`, dort steht an
  jedem Wert die Messung (etwa VAAPI `async_depth=1` statt GSRs 3: der Vorlauf kostete
  zwei Bildabstände, 33,6 → 5,3 ms).
- **Push**: FLV-Mux → RTMPS an MediaMTX (`tls_verify=0`, **OpenSSL**-Backend —
  `--enable-openssl` im Eigenbau, der Sidecar meldet es als `health.gsr.tls_backend`). Viewer holen per WHEP.
- **Threading**: `std::thread` + `mpsc`, kein Tokio im Main-Loop (nur scoped für die
  Portal-Verhandlung via `ashpd`).

## Stand

Die volle Kette läuft und wird ausgeliefert: Portal-Dialog → PipeWire-DMABUF →
zero-copy in den Encoder (NVENC via CUDA-GL-Interop, VAAPI via `hwmap`+`scale_vaapi`)
→ FLV-Mux mit Ton → RTMPS. Dazu Auflösungs-Skalierung auf der GPU, Audio-Modi
(Desktop / einzelne App / Mikrofon) und A/V-Anker über eine gemeinsame Wanduhr.

Zwei Dinge, die man beim Lesen der Ausgabe kennen muss:

- **10 bit gibt es nur mit AV1.** Ein 10-bit-Wunsch mit H.264 wird still auf 8 bit
  zurückgeschoben — `High 10` kann NVENC zwar, aber kein Browser dekodiert es, und der
  WHEP-Rückfall im Web ist ein `<video>`.
- **Dieser Sidecar sendet über WHIP kein AV1** — die Grenze liegt am ffmpeg-WHIP-Muxer,
  nicht an WHIP oder WebRTC. `ops/start.rs` weicht deshalb auf H.264 aus, und damit
  zugleich auf 8 bit. Betrifft app-gehostete Instanzen (`MEDIAMTX_PUSH_PROTOCOL=whip`);
  der Cloud-Weg ist RTMPS und nicht betroffen.
  **Mit eigenem Paketierer geht es sehr wohl:** `streaming/hq-labor/` sendet AV1 10 bit
  über WHIP und war damit am 2026-07-28 gemessen 18,7 ms schneller als RTMPS, bei
  achtmal kleinerer Streuung. Nur ist dieser Weg (noch) nichts, was ausgeliefert wird —
  deshalb steht er dort und nicht hier.

Offen: die **Aufnahme** selbst ist weiterhin 8 bit (der Compositor liefert `XRGB8888`);
10-bit-Encode nutzt trotzdem etwas gegen Banding, ist aber keine echte 10-bit-Quelle.
VAAPI hat keinen 10-bit-Zweig. „Desktop + Mikrofon" mischt bisher nur Desktop.

Die Herleitung der Encoder- und Puffer-Werte mit den zugehörigen Messungen steht in
`CLAUDE.md` in diesem Verzeichnis — dort ist auch festgehalten, welche Wege gemessen
und **verworfen** wurden, damit sie niemand erneut aufgreift.

## Lokales Test-MediaMTX
```bash
docker compose -f test/docker-compose.yml up -d   # RTMPS :11936, API :9997
# Self-signed Cert erzeugen:
mkdir -p test/certs && openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout test/certs/key.pem -out test/certs/cert.pem -days 3650 -subj "/CN=localhost"
```

## Build
```bash
cargo build --release
echo '{"op":"health","id":1}' | ./target/release/pulse-linux-hq-sidecar
cargo run --release --example tls_probe -- rtmps://localhost:11936/test
cargo run --release --example encode_smoke -- /tmp/smoke.mp4 h264 1280 720 30 120
cargo run --release --example capture_smoke 5   # öffnet den Portal-Dialog
```

System-Voraussetzungen: FFmpeg 8.1 (`--enable-gnutls --enable-libdrm --enable-nvenc`),
libpipewire-0.3, libclang (für ffmpeg-sys bindgen).
