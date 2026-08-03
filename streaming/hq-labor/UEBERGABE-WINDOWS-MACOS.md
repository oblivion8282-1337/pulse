# Intra-Refresh auf Windows und macOS — Übergabe

Linux ist durch (NVIDIA am 2026-07-31, AMD am 2026-08-01). Dieses Blatt ist
der Einstieg für die beiden fehlenden Plattformen. **Es ist am Quelltext
belegt, nicht geraten** — aber nichts davon ist auf der jeweiligen Maschine
nachgemessen. Genau das ist die Aufgabe.

## Der gemeinsame Hebel

Alle drei Sidecars encodieren über **FFmpeg als Bibliothek** — Linux und
Windows mit `ffmpeg-next 8.1`, macOS mit 8.0. Die Frage ist deshalb überall
dieselbe: **bietet der jeweilige Encoder eine Intra-Refresh-Option an?**
Geprüft im FFmpeg-8.1.2-Quellbaum:

| Encoder | Intra-Refresh | Option |
|---|---|---|
| `*_nvenc` (h264, hevc, **av1**) | **ja, upstream** | `-intra-refresh 1` (+ `-forced-idr 1`) |
| `*_d3d12va` (h264, hevc, **av1**) | **ja, upstream** | `-intra_refresh_mode row_based` |
| `h264_amf` | ja | `-intra_refresh_mb N` |
| `av1_amf`, `hevc_amf` | **nein** | — |
| `hevc_qsv` | ja | `-int_ref_type` / `-int_ref_cycle_size` |
| `h264_qsv`, `av1_qsv` | **nein** | — |
| `*_vaapi` | **nein upstream** | unser Patch, `streaming/ffmpeg-patches/` |
| `*_videotoolbox` | **nein, gar nichts** | — |

## Windows — die gute Nachricht

**Beide Vendor sind ohne Patch erreichbar.**

* **NVIDIA**: `av1_nvenc`/`h264_nvenc` haben `intra-refresh` seit jeher. Genau
  das läuft auf Linux+NVIDIA schon.
* **AMD**: Der Windows-Sidecar nutzt für AMD ohnehin **nicht** AMF, sondern den
  D3D12-Pfad (`d3d12va_name()` in `encode/encoder.rs`, wegen der AMF-Laufzeit
  und deren D3D11-Surface-Absturz, Issue #455) — und `av1_d3d12va` ist dort
  bereits eingetragen. FFmpeg treibt den Refresh-Zyklus im D3D12-Encoder
  **selbst** (`intra_refresh_frame_index` in `d3d12va_encode.c`), es braucht
  also nicht die Welle von Hand wie bei VAAPI.
* **Intel**: über denselben D3D12-Pfad (der ist vendor-unabhängig) statt QSV,
  wo nur HEVC die Option hat.

**Wo der Schalter hingehört:** `vendor_encoder_opts(vendor)` in
`win-hq-sidecar/src/encode/encoder.rs:507` — das Gegenstück zu
`linux-hq-sidecar/src/encode/opts.rs::vendor_defaults`. Auf Linux heißt der
vendor-neutrale Schalter `PULSE_INTRA_REFRESH=1`; dieselbe Variable dort
einzuführen hält die Prüfstand-Skripte plattformgleich.

**Zuerst zu tun, in dieser Reihenfolge:**

1. `ffmpeg -h encoder=av1_d3d12va` und `-h encoder=av1_nvenc` gegen das
   **gebündelte** FFmpeg laufen lassen (`ffmpeg-dist/n8.1-lgpl-shared/`, s.
   `FFMPEG_DIR` in `.cargo/config.toml`) — nicht gegen irgendein FFmpeg im
   PATH. Steht die Option da, ist der Rest Verdrahtung.
2. Eine Datei encodieren und die Keyframes zählen (`ffprobe … key_frame`):
   ohne Intra-Refresh viele, mit einem. Das ist der billigste Beweis, dass der
   Schalter etwas tut.
3. Erst dann die Live-Kette.

## macOS — der offene Fall

`videotoolbox` hat in FFmpeg **keine einzige** Intra-Refresh-Stelle. Damit ist
der Weg, der auf allen anderen Plattformen funktioniert, dort versperrt.

Zu klären ist, ob **VideoToolbox selbst** es kann — FFmpeg reicht viele
VT-Eigenschaften nicht durch. Konkret nachzusehen in
`VTCompressionProperties.h` des SDK nach einem Schlüssel für Intra-Refresh
bzw. „forced intra rows". Findet sich einer, ist es dieselbe Art Patch wie bei
VAAPI. Findet sich keiner, **kann macOS es nicht**, und dann ist die
Produktentscheidung fällig: Intra-Refresh als plattformabhängige Betriebsart
ausliefern, oder auf allen Plattformen bei Keyframes bleiben.

**Das ist der Punkt, an dem „das Feature kann erst raus, wenn alles fertig ist"
kippen könnte** — nicht an Aufwand, sondern an einer Schnittstelle, die es
vielleicht nicht gibt. Deshalb gehört macOS zuerst geprüft, nicht zuletzt.

## Wie dort gemessen wird

Der Prüfstand (`streaming/testbench/`) ist **Linux-gebunden**: Portal-Capture,
`tc`, `tcpdump`, Zeitmuster über PySide6. Zwei Wege:

* **Datei-Vergleich auf der Zielmaschine** — encodieren, Keyframes zählen,
  VMAF gegen den Rohmitschnitt. Beantwortet „wirkt der Schalter" und „was
  kostet er", nicht „was bringt er unter Verlust".
* **Sender dort, Zuschauer hier** — der Windows-Sidecar pusht auf den
  Labor-Server, der Linux-Player misst mit den vorhandenen Werkzeugen. Das ist
  der Weg für die Verlustreihe; `fern-referenz.py` zeigt das Muster
  (Sender fern, Messung lokal), muss dafür aber angepasst werden.

## Die Fallen, die auf Linux Zeit gekostet haben

1. **Der Zustand der Maschine gehört vor jeden Lauf.** Sechs vergessene
   `mpv`-Prozesse haben anderthalb Stunden lang jede Messung verfälscht und
   ZWEI falsche Befunde erzeugt. `gemeinsam.zustand_pruefen()` fängt das jetzt
   — auf Windows gibt es das nicht, dort also von Hand: läuft noch ein Sender,
   ein Player, ein Browser mit Video?
2. **Der Schalter muss im Protokoll stehen.** Eine Variante über eine
   Umgebungsvariable zu fahren, die nirgends auftaucht, ist nicht
   nachweisbar — und „kein Unterschied" hat dann die naheliegendste Erklärung:
   es lief zweimal dasselbe.
3. **Die Fähigkeitsprobe muss dieselben Einstellungen benutzen wie der Betrieb.**
   Auf Linux fiel H.264 still aus der Codec-Liste, weil die Probe die B-Bilder
   nicht abschaltete, die der Live-Pfad abschaltet.
4. **Ein Lauf je Variante trägt nichts**, und eine Fehlermeldung am Ende eines
   Logs ist kein Befund. Beides ist hier trotzdem passiert.
