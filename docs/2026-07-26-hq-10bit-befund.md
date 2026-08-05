# 10-bit-HQ-Streaming: Befunde und der Weg dorthin

Gemessen am 2026-07-26 auf der Dev-Maschine (RTX 5080, CachyOS, KWin 6.7.3,
MediaMTX 1.19.1, FFmpeg 8.1). Alles hier ist **nachgemessen**, nicht abgeleitet.

## Was heute passiert

Pulse sendet ausschliesslich **8 bit**. Zwei Ursachen, unabhaengig voneinander:

1. `web/src/lib/stream/settings.svelte.ts` bietet nur `h264` und `av1` an. Die
   10-bit-/HDR-Varianten versteht der Python-Sidecar, sie werden aber bewusst
   nicht angeboten (der Flatpak-GSR-Build bringt nur h264 + av1 mit).
2. Der Rust-Sidecar encodiert grundsaetzlich 8 bit — unabhaengig vom Codec-Wert.

## Der wichtigste Befund: 10 bit hilft, obwohl die Quelle 8 bit ist

Der Compositor liefert per Screencast **nur 8 bit**. Belegt an zwei
unabhaengigen Programmen:

```
# Rust-Sidecar, mit vorangestellten 10-bit-Formaten:
INFO pipewire: Format fixiert format=VideoFormat::BGRx …

# GSR im 10-bit-Modus (-k av1_10bit -v yes):
gsr info: pipewire:    Format: 8 (Spa:Enum:VideoFormat:BGRx)
```

**Trotzdem war 10-bit-Encoding sichtbar besser.** Im Vergleich derselben Szene,
mit abgeschaltetem Debanding im Player:

| Quelle des Stroms | dekodiertes Format | Bild |
|---|---|---|
| GSR `-k av1` | `NV12` (8 bit) | deutliches Banding im Testbild |
| GSR `-k av1_10bit` | `P010LE` (10 bit) | glatt |

Der Gewinn kommt also **nicht** aus zusaetzlicher Bildinformation, sondern aus
der Rechengenauigkeit des Encoders: Ein 8-bit-Encoder erzeugt in flachen
Verlaeufen durch Quantisierung und Transformationsrundung selbst neue Stufen,
ein 10-bit-Encoder bleibt mit seinen Rundungsfehlern darunter. Dazu kommt, dass
feines Dither-Rauschen der Quelle eine 10-bit-Kompression ueberlebt und von
einer 8-bit-Kompression weggebuegelt wird.

Das ist gaengige Praxis (10-bit-Encoding von 8-bit-Material gegen Banding) und
heisst fuer uns: **Der Umbau lohnt sich, ohne dass die Capture angefasst werden
muss.**

## Warum der Umbau nicht trivial ist

Der NVENC-Weg des Rust-Sidecars ist bewusst RGB-basiert und spart damit die
Farbraumwandlung:

```
DMABUF → EGLImage → GL-Textur → glBlitFramebuffer → RGBA8-Staging
       → cuMemcpy2D → ffmpeg-CUDA-Frame (sw_format RGB0) → NVENC
```

NVENC nimmt RGB direkt an und wandelt selbst nach YUV. Bei 10 bit gibt es
diesen Komfort nicht:

| Format | von `av1_nvenc` akzeptiert | vom CUDA-Frame-Pool akzeptiert |
|---|---|---|
| `x2bgr10le` / `x2rgb10le` | ja | **nein** (`av_hwframe_ctx_init` rc=-38) |
| `p010le` | ja | ja |
| `rgb0` (heute) | ja | ja |

Das sind zwei verschiedene Formatlisten — der Encoder kann mehr als der Pool.
`scale_cuda` hilft auch nicht: `Unsupported conversion: rgb0 -> semiplanar10`.

Es fuehrt also kein Weg an einer **eigenen RGB→YUV-Wandlung** vorbei. GSR hat
sie als GL-Shader (`src/color_conversion.c`, rund 800 Zeilen, zwei
Zieltexturen fuer Y und UV).

## Konkreter Plan fuer den Umbau

Betrifft nur `pulse-linux-hq-sidecar` (eigenes Repo), Datei
`src/encode/nv_import.rs` plus eine Zeile in `src/stream_controller.rs`.
**Der 8-bit-Weg bleibt unangetastet** — der Shader-Pfad wird nur betreten,
wenn 10 bit angefordert sind.

1. GL-Funktionszeiger fuer den Shader-Pfad laden (Programm/Shader/Uniform/
   DrawArrays/Viewport/VAO — rund 20 Stueck, per `eglGetProcAddress` wie die
   vorhandenen).
2. Zwei Staging-Texturen statt einer: Y als `GL_R16` in voller, UV als
   `GL_RG16` in halber Aufloesung.
3. Den `glBlitFramebuffer` durch zwei Render-Durchgaenge ersetzen (Pass 0
   schreibt Luma, Pass 1 Chroma), Vollbild-Dreieck ohne Vertexpuffer.
4. Zwei CUDA-Registrierungen und zwei `cuMemcpy2D` in die beiden Ebenen des
   P010-Frames.
5. `sw_format` in `stream_controller.rs` auf `AV_PIX_FMT_P010LE`.

Der Wert normalisiert in eine 16-bit-Textur geschrieben trifft P010 (10 Bit in
den oberen Bits) bis auf 0,06 % genau — `round(v*65535)` gegen
`round(v*1023)<<6`, also deutlich unter einer 10-bit-Stufe.

### Matrix: BT.709, nicht BT.2020

GSRs `RGB_TO_P010_*`-Matrizen sind **BT.2020** und fuer HDR gedacht. Unsere
Stroeme sind BT.709 (am dekodierten Bild abgelesen), und der heutige 8-bit-Weg
ueberlaesst die Wandlung NVENC, das ebenfalls BT.709 nimmt. Zu uebernehmen ist
deshalb GSRs `RGB_TO_NV12_LIMITED` (BT.709, begrenzter Wertebereich):

```glsl
const mat4 RGBtoYUV = mat4(0.180353, -0.096964,  0.429412, 0.000000,
                           0.609765, -0.327830, -0.385927, 0.000000,
                           0.060118,  0.429412, -0.038049, 0.000000,
                           0.062745,  0.500000,  0.500000, 1.000000);
```

Mit BT.2020 waeren die Farben gegenueber dem 8-bit-Weg verschoben.

## HDR

Waere ein weiterer Schritt auf derselben Struktur: nur Matrix (dann BT.2020),
Transferfunktion (PQ) und die Signalisierung im Bitstrom wechseln.

Der offene Punkt davor: Unsere Messung, dass der Compositor nur `BGRx` liefert,
lief im **SDR-Modus**. Mit eingeschaltetem HDR bietet KWin fuer Screencast
sehr wahrscheinlich ein 10-bit-Format an — dann kaeme echte zusaetzliche
Bildinformation an, nicht nur Encoder-Genauigkeit. Das ist ungemessen.

## Nebenbefunde

* **Der Dev-MediaMTX lief auf 1.17.1, obwohl der Tag `1.19.1-pulse` lautete** —
  beide Tags zeigten lokal auf denselben Digest. Der Container meldete
  `v1.17.1-dirty`, und dessen ICE-Fehler (`deadline exceeded while waiting
  connection`) liess WHEP-Verbindungen sporadisch scheitern. Nach dem echten
  Update: 3 von 3 Verbindungen erfolgreich. **Dem Tag nicht glauben, die erste
  Zeile von `docker logs streaming-mediamtx` lesen.**
* **GSR meldet im 8-bit-Pfad `BT470BG` (BT.601) als Farbraum, im 10-bit-Pfad
  `BT709`.** Der native Player folgt deshalb der Angabe des Stroms statt einen
  Farbraum anzunehmen.
* **Ein Testbild zum Nachpruefen** erzeugt `streaming/pulse-player/testbild.py`
  (vier Baender, abwechselnd auf 8 bit gerastert und in voller Aufloesung).
  Ohne so ein Bild ist der Unterschied an normalem Material nicht zu sehen.
