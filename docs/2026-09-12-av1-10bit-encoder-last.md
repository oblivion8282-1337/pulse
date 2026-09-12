# AV1 10 bit: Encoder-Last — Ist-Zustand, Hebel, Messplan (2026-09-12)

Ausgangsfrage: Ein 10-bit-AV1-Strom kostet den Sender mehr Encoder-Last als
8 bit. Wo genau entsteht die Mehr-Last, und lässt sie sich — zumindest auf
NVIDIA unter Linux — theoretisch minimieren?

Dieser Text ist der Anfang einer NEUEN Untersuchung. Eine frühere dazu ist im
Repo nicht auffindbar (2026-09-12 gesucht: docs/, streaming/, Branches,
Messakten). Er stellt fest, wie der Sidecar es heute löst — alles unten am
Code belegt, nicht abgeleitet —, trennt Gemessenes von Analyse, und benennt
die Messung, die als erste fehlt.

## 1. Ist-Zustand im Sidecar

Aktiv ist der Rust-`linux-hq-sidecar` (`streaming/linux-hq-sidecar/`); der
alte Python-gsr-sidecar existiert nur noch als `__pycache__`.

**10 bit ist an AV1 gebunden** (`stream_controller.rs:742`,
`ten_bit = params.ten_bit && codec == "av1"`): fällt der Codec auf H.264
zurück, fällt die Bittiefe mit. Angeboten werden nur h264 + av1 (HEVC ist eine
bewusste Nutzerentscheidung dagegen, `caps.rs`).

**Encoder-Wahl** (`encode/opts.rs::encoder_name`):

| Vendor | AV1 8 bit | AV1 10 bit |
|---|---|---|
| NVIDIA | `av1_nvenc`, CUDA-Pool `sw_format=RGB0` | `av1_nvenc`, CUDA-Pool P010 |
| AMD/Intel | `av1_vaapi` | `av1_vaapi`, `scale_vaapi=format=p010` |

**Der strukturelle Unterschied auf NVIDIA** (der Kern der ganzen Frage):

- **8 bit**: Die Capture (PipeWire-DMABUF → EGLImage) wird per
  `glBlitFramebuffer` in eine RGBA8-Staging-Textur kopiert (detiled + skaliert),
  CUDA-Interop, `cuMemcpy2D` in den ffmpeg-CUDA-Frame — **NVENC bekommt RGB und
  wandelt intern zu NV12, in Fixed-Function-Hardware, ohne eigene Last**
  (`encode/nv_import.rs`).
- **10 bit**: NVENC nimmt kein RGB mehr an. Zwei gemessene Blocker
  (2026-07-26, RTX 4090, FFmpeg 8.1, `encode/nv_p010.rs`-Kopf):
  1. der CUDA-Frame-Kontext lehnt 10-bit-RGB ab (`sw_format=x2bgr10le` →
     rc=-38, „Pixel format not supported") — P010 ist Pflicht;
  2. `scale_cuda` kann die Wandlung nicht (`Unsupported conversion:
     bgr0 -> semiplanar10`).
  Deshalb wandelt ein **eigener GL-Shader**: zwei Fragment-Durchgänge (Luma
  `R16` in voller, Chroma `RG16` in halber Größe, 2×2-Kastenmittel, BT.709
  limited, P010-Bitlage oben), CUDA registriert beide Ebenen, `cuMemcpy2D` in
  den P010-Pool. **Diese 1,5 Bildschirmdurchläufe auf der 3D-Engine plus
  Interop sind die einzige Stelle, an der 10 bit nachweislich Struktur-LAST
  zusätzlich erzeugt** — ob NVENC selbst in 10 bit langsamer kodiert, ist
  NICHT gemessen (s. §4).

## 2. Die Encoder-Optionen (bereits getunt)

`encode/opts.rs`, NVIDIA-Zweig: `preset=p2`, `tune=ull`, `rc=cbr`,
`b_ref_mode=0`, `forced-idr=1`, `zerolatency=1` + `delay=0` (letztere über
`PULSE_NVENC_LOW_DELAY=0` abschaltbar). Bewusst NICHT gesetzt: multipass, AQ,
rc-lookahead (≤ +1,84 VMAF für 40–50 % weniger Durchsatz — Messung
2026-07-19). VAAPI-Seite: `async_depth=1`, `low_power`/`compression_level`
bewusst weg (scheitert auf AMD bzw. +166 % GPU für null Gewinn).

Die p2-Messung (2026-07-27, RTX 5080, AV1) — der bislang einzige Last-Hebel,
der gezogen wurde: Encoder-Block live 11,0–11,9 % statt 17,3–18,0 % bei
1440p144 (4,0 statt 6,8 % bei 1440p60), VMAF praktisch gleich, Latenz
unverändert. Messakte: `streaming/testbench/profiles/bild-2026-07-27-av1.json`.

Abzugrenzen: `lastgrenze.rs` (300 Mpix/s-Fps-Deckel für 10-bit-Ströme, Vorfall
2026-08-20) ist **Decoder**-Last der Zuschauer, nicht Encoder-Last des Senders.

## 3. Die Hebel, geordnet

**H1 — Wandlung zurück in den Encoder legen (der theoretische, NVIDIA-spezifische).**
`av1_nvenc` führt `x2bgr10le` in seiner Pixel-Formatliste — der Encoder kann
10-bit-RGB mit interner Konvertierung fressen, exakt das, was der 8-bit-Pfad
gratis hat (`nv_p010.rs`-Kopf: „gilt nur für den Software-Frame-Weg"). Der
einzige Blocker ist der ffmpeg-CUDA-Pool, nicht NVENC. Wege:

- ffmpeg-Patch: `hwcontext_cuda` müsste `x2bgr10le` als `sw_format` akzeptieren.
  Upstream-Arbeit, deshalb „theoretisch" — aber der Hebel wäre komplett: der
  ganze GL-Shader-Pfad entfällt, die Staging-Textur wird nur noch als 10-bit-
  RGB angelegt.
- SW-Frame-Weg ohne Patch: braucht einen CPU-Roundtrip der Capture —
  kontraproduktiv, nicht verfolgen.

Vor jedem Patch klären (Doku-Lektüre, Video-Codec-SDK): wandelt NVENC ARGB10/
ABGR10 wirklich intern zu 10-bit-YUV, oder nimmt es das Format nur für
Verlustfreies/4:4:4 an? Falls nein, ist H1 tot und H2 ist alles, was bleibt.

**H2 — Zwei Shader-Pässe zu einem Compute-Dispatch zusammenziehen.**
Beide Ebenen in einem Durchlauf schreiben (Compute statt zweier Fragment-
Draws). Lokal machbar, ohne ffmpeg-Änderung; spart Draw-/Sync-Overhead, bleibt
aber auf derselben Engine — kein Strukturgewinn wie H1. Nur angehen, wenn die
Messung zeigt, dass die Shader-Last dominiert.

**Nicht-Hebel (damit sie niemand erneut prüft):** Die Quelle ist 8 bit —
10-bit-Capture brächte nichts (der Sinn von 10 bit ist Encode-Präzision gegen
Banding, Befund 2026-07-26, nicht Quell-Tiefe). `tiles` (VAAPI: +3 % GPU,
kein Gewinn, 2026-07-30) und `compression_level` (s. §2) sind gemessen
sackgassig. Ein CUDA-NPP-/scale_cuda-Ersatz des Shaders tauscht nur die
ausführende Engine.

## 4. Was fehlt: die Messung

Es gibt **keinen 8-gegen-10-bit-Lastvergleich auf Linux/NVIDIA** — weder in
`streaming/testbench/profiles/` (dort nur Windows-10bit-Akten) noch in docs/.
Die Messreihen bis jetzt betreffen Presets (§2), nicht Bittiefe.

Schritt 1 (Basiszahl, entscheidet über H1/H2):

- Gleicher Aufbau wie die p2-Messung (RTX 5080, echtes Bildschirmmaterial,
  1440p144 und 1440p60, feste Bitrate), zwei Varianten: AV1 8 bit (RGB0-Pfad)
  gegen AV1 10 bit (P010-Shader-Pfad).
- Getrennt ausweisen: **Encoder-Block-Last** (NVENC-Engine) und **3D/SM-Last**
  (Shader) — nur so lässt sich die Mehr-Last zuordnen. `nvidia-smi dmon -s u`
  trennt enc von sm.
- Messvariante 10-bit-mit-Shut-off gibt es nicht als Schalter — wer die
  Shader-Last isolieren will, vergleicht stattdessen 3D-Last im Idle-Encode
  gegen 8 bit (der Unterschied IST die Wandlung — die NVENC-interne CSC des
  8-bit-Pfads hat keine messbare 3D-Komponente).

Erwartung (Hypothese, zu prüfen): die Mehr-Last sitzt überwiegend in der
Wandlung, nicht im NVENC-Block — dann lohnt H1 und H2 ist die Ausweichgröße.
Sitzt sie im NVENC selbst, bleibt als Hebel nur die Lastgrenze bzw. kleinere
Auflösungen — dann ist dieser Punkt erledigt und dokumentiert.

## 5. SPIEGEL-Hinweis

`lastgrenze.rs` spiegelt seine Grenze nach `web/src/lib/stream/settingsCatalog.ts`
(`HQ_TEN_BIT_MAX_PIXELS_PER_SEC`, `fpsAllowed`). Diese Untersuchung hier ändert
keine Grenze — falls H1/H2 die Sender-Last senken, berührt das die Decoder-Last
der Zuschauer NICHT (10 bit bleibt für Decoder 1,5–2× so teuer pro Bildpunkt,
`lastgrenze.rs`-Kopf). Die Deckel bleiben, was sie sind.
