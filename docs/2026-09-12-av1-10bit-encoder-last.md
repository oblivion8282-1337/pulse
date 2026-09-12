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

## 6. Nachtrag 2026-09-12 (abends): die Messung aus §4 ist gefahren

Aufbau: RTX 4090 (Treiber 610.57.04), Prüfstand `streaming/testbench/real-harness.py`
(echtes Sidecar, Portal-Restore-Token, ffplay-Testbild als Bewegtbild auf dem
erfassten Monitor), 2560x1440, Ton aus, 25 s je Lauf, dmon-Mittel ohne die
zwei Warmup-Proben (`gpuload.py`). Damit der Direktpfad überhaupt ans Netz
konnte, wurden zwei Bauteile neu: (a) ein aus der Quelle gebautes FFmpeg n8.1
mit dem Allowlist-Patch als Handport von Upstream `2cf3f4d6`
(`streaming/pulse-player/scripts/build-ffmpeg-linux.sh`; die BtbN-Distribution
hat die Wand noch, Upstream-Release erst ab 9.1), (b) der Rgb10-Direktpfad im
Sidecar (`PULSE_NVENC_TEN_BIT_RGB=1`, `encode/nv_import.rs::StagingFormat::Rgb10`).

| Variante (2560x1440@60) | sm % mittel | enc % mittel | kbps mittel |
|---|---|---|---|
| AV1 8 bit (RGB0-Pfad, Referenz) | 11,7 | 5,8 | ~24.900 |
| AV1 10 bit, P010-Shader (Ist-Zustand) | 11,8 | 5,4 | ~19.200 |
| AV1 10 bit, P010-Shader, --fps 144 angefordert (lastgrenze klemmt auf 60, s. u.) | 11,9 | 5,5 | ~23.100 |

**Befunde:**

1. **NVENC kodiert 10 bit nicht messbar teurer als 8 bit** — enc liegt in
   allen Varianten bei 5,4–6,0 %, innerhalb der dmon-Auflösung identisch.
   Die offene Frage aus §1/§4 („ob NVENC selbst in 10 bit langsamer kodiert")
   ist damit bei 1440p60 beantwortet: kein messbarer Aufpreis.
2. **Der P010-Shader kostet nichts Messbares** — sm 11,8 % gegen 11,7 % im
   8-bit-Referenzlauf, beides gleich dem Desktop-Grundrauschen auf diesem
   Schirm. H2 (Shader-Pässe zusammenlegen) ist damit gegenstandslos: es gibt
   keine nennenswerte Wandlungslast.
3. **Der Rgb10-Direktpfad (H1) ist an Treiberwänden gestorben**, alle drei
   am Code bzw. Log nachlesbar: (a) CUDA registriert GL_RGB10_A2-Texturen
   nicht (`cuGraphicsGLRegisterImage` → INVALID_VALUE, stand schon im
   nv_import-Kommentar); (b) das gepackte 10-bit-Leseformat
   (GL_RGBA + GL_UNSIGNED_INT_2_10_10_10_REV aus GL_RGB10_A2) läuft im
   NVIDIA-GL-Treiber auf einen CPU-Fallback — konstant ~430–450 ms je Bild
   bei 2560x1440, mit und ohne PBO, gemessen per `PULSE_RGB10_TIMING=1`
   (map/copy/sync bleiben je unter 1 ms); (c) die einstige Pool-Wand ist
   seit dem Patch offen, nützt aber ohne schnellen Leseweg nichts. Der
   Rgb10-Code bleibt als umschaltbarer Pfad liegen, damit die Wände
   dokumentiert sind; fahren tut der P010-Shader-Pfad.

Vorbehalt: Einer der ersten Rgb10-Läufe kam mit vollem Durchsatz zustande
(kbps ~21.500, gesunde GPU-Zahlen) und ließ sich trotz identischen Codes
nicht reproduzieren; jeder spätere Lauf zeigte den 430-ms-Fallback. Bis zur
Klärung gilt der Messsatz oben mit drei Wiederholungen pro Richtung.

**Fazit:** An diesem Betriebspunkt (1440p60, RTX 4090) gibt es keinen
messbaren Sender-seitigen 10-bit-Aufpreis — weder im Encoder-Block noch in
der Wandlung. H1 und H2 sind damit nicht „später anzugehen", sondern
gegenstandslos. Offen bleiben alle anderen Betriebsarten: getestet ist ausschließlich
2560x1440 bei effektiv 60 Bildern/s — die mit 144 Bildern/s angesetzten
Läufe klemmte `lastgrenze.rs` selbst auf 60 (Log: „10 bit bei 2560x1440:
Bildrate auf 60 Bilder/s begrenzt"), ein Nebeneffekt, der den Deckel nebenbei
als funktionierend belegt. Ob 1080p, echte 144 Bilder/s (nur 8 bit) oder 4K
anders messen, ist unbeantwortet; bei 4K greift der 300-Mpix/s-Deckel
(Decoder-Last, §5) ohnehin zuerst. Die Deckel bleiben, was sie sind.

Nebenprodukt der Messung: Der Prüfstand brauchte für die Klick-freie
Quellwahl eine KDE-Portal-Zuordnung (`~/.config/xdg-desktop-portal/kde-portals.conf`,
ScreenCast → kde-Backend; das generische `portals.conf` dieser Maschine ist
auf niri/GNOME-Backend gestellt und deckt KDE nicht ab).

**Nachtrag später am Abend — zweiter Betriebspunkt: 1920x1080@144.** Der
einzige Punkt, an dem 10 bit mit voller Bildrate laufen darf (298,6 Mpix/s,
haarscharf unter dem 300-Mpix/s-Deckel; Log bestätigt: Encoder öffnet mit
fps=144, keine Begrenzung). Je zwei Durchgänge, gleicher Aufbau:

| Variante (1920x1080@144) | sm % mittel | enc % mittel | kbps mittel |
|---|---|---|---|
| AV1 8 bit | 15,0 / 15,2 | 7,4 / 7,3 | ~25.000 |
| AV1 10 bit, P010-Shader | 15,0 / 14,9 | 7,3 / 7,5 | ~23.500 |

Auch hier: **kein messbarer Unterschied zwischen 8 und 10 bit** (enc
7,3–7,5 % in allen Läufen). Interessant am Rande: 1080p144 kostet den
Encoder-Block mehr als 1440p60 (7,4 gegen 5,4–5,8 %) — die Last folgt dem
Durchsatz (299 gegen 221 Mpix/s), nicht der Bittiefe.

**Nachtrag nochmals später — Ende-zu-Ende im echten App-Betrieb** (zwei
Dev-Instanzen: Instanz 1 sendet per App-UI, Instanz 2 empfängt im nativen
Player; beide auf der RTX-4090-Maschine). Auffälligkeit des App-Wegs: Der
Sender publishet per **WHIP/WebRTC** (nicht RTMPS wie im Prüfstand) — damit
existiert der Rückkanal, Join-Bilder kommen sofort; der Prüfstand braucht
dafür `--keyframe-on-gap`. Gemessen 45 s je Runde, `dmon` + `pmon`
(pro-Prozess, korrekte Spalten: sm/enc/dec):

| Variante (1920x1080@60, AV1, 4000 kbit/s) | Sender enc % | Sender sm % | Player dec % | Player sm % |
|---|---|---|---|---|
| 10 bit | 2,8 | 2,6 | 2,9 | 3,0 |
| 8 bit | 2,7 | 2,4 | 4,8 | 0,5 |

Bittiefe der Läufe per HLS-Zugriff verifiziert (10 bit vorher, nach dem
Wechsel `yuv420p` + `bt470bg` — die erwartete BT.601/limited-Markierung des
RGB-Eingangswegs). Player dekodiert in beiden Runden mit 59–60 Bildern/s.

**Befunde:** (1) Sender-Seite identisch — bestätigt die Prüfstands-Messung
im echten App-Betrieb. (2) Der NVDEC-Dekoder zeigt für 10 bit **keinen
höheren** Utilization-Wert als für 8 bit (Richtung sogar umgekehrt; innerhalb
der dmon-Granulierung Rauschen). Die 1,5–2×-Schätzung aus dem
`lastgrenze`-Kopf trifft auf einen modernen NVDEC bei 1080p60 **nicht** zu —
sie stützt sich auf den AMD-Vorfall vom 2026-08-20 und bleibt als Schutz für
schwache Zuschauer-Hardware sinnvoll, belastet den Sender aber nicht.

Nebenbefund: Der Dev-Player linkt gegen das System-FFmpeg 9 (`libavcodec
.so.63`), das Dev-Sidecar gegen die n8.1-Distribution (`.so.62`) — die
beiden Streaming-Komponenten teilen sich die FFmpeg-Version nicht; für die
Messwerte hier ohne Bedeutung, für künftige FFmpeg-Bumps aber wissenswert.

**Direktes 8/10-bit-Paar am Deckelrand (1920x1080@144, App-Betrieb):** Die
298,6 Mpix/s liegen haarscharf unter dem 300-Mpix/s-Deckel — `lastgrenze`
greift nicht, beide Läufe liefen mit vollen fps=144 (Encoder-Log, neuer
Publish-Pfad je Wechsel). 45 s je Runde, dmon + pmon:

| Variante (1920x1080@144, AV1, 4000 kbit/s) | Sender enc % | Sender sm % | Player dec % | Player sm % |
|---|---|---|---|---|
| 10 bit | 7,7 | 11,8 | 7,9 | 5,5 |
| 8 bit | 7,7 | 6,4 | 7,9 | 4,1 |

**enc und dec sind mit 7,7 bzw. 7,9 % zifferngleich** zwischen 8 und 10 bit —
weder NVENC noch NVDEC unterscheiden sich an diesem Betriebspunkt. Die
sm-Werte des Senders schwanken mit der Desktop-Aktivität (KWin 6,5 gegen
10,8 % in den Runden), die Summe bleibt konstant (~29–30 %). Damit auch am
höchsten getesteten Durchsatz: kein 10-bit-Aufpreis bei Sender noch Empfänger
(moderner NVDEC). Der `lastgrenze`-Deckel bleibt als Schutz gegen
fehleranfällige 10-bit-Dekoder-Pfade (AMD-Vorfall 2026-08-20: dedizierte
Radeon mit 16 GB VRAM — Video-Ring-Kernel-Reset bei 1440p144 in 10 bit,
8 bit lief; ein Dekoder-Bug, kein Kapazitätsproblem — die +112 MiB VRAM
aus der Messung oben sind auf 16 GB bedeutungslos) und schlägt bei 4K
ohnehin zu, bevor der Sender an Grenzen kommt.

**Nachtrag Abend — die Speicher-Messung (VRAM), App-Betrieb 1920x1080@144:**
Nach dem Format-Wechsel im laufenden App-Betrieb (derselbe Sidecar-Prozess,
Stream startet darin neu; Player-Prozess unverändert) je 12 VRAM-Proben +
30 s dmon:

| 1920x1080@144 (AV1) | 8 bit | 10 bit | Delta |
|---|---|---|---|
| Sidecar-VRAM (Prozess gesamt) | 484 MiB | 506 MiB | **+22 MiB** |
| Player-VRAM (Prozess gesamt) | 735 MiB | 825 MiB | **+90 MiB** |
| dmon mem % (Bandbreite) | 3,0 | 4,0 | +1,0 |
| enc / dec / sm % | 9,0 / 9,0 / 30,6 | 9,0 / 9,0 / 31,2 | ±0 |

Passung zur Theorie: Ein 1080p-Bild belegt als NV12 3,1 MB, als P010
6,2 MB (16-Bit-Wörter) — der Sidecar-Pool (~8 Frames) erklärt die +22 MiB,
der Dekoder-Surface-Pool des Players die +90 MiB. Die Compute-Einheiten
bleiben exakt gleich (enc/dec ±0), die Bandbreite zeigt die fette P010
deutlich (+1 Prozentpunkt, 144 Bilder/s). Einzige Korrektur zur Fassung
„+50 %": P010 legt jeden 10-bit-Wert in ein 16-Bit-Wort — der
Speicherverkehr verdoppelt sich gegenüber NV12 (P010 wäre als gepacktes
NV15 +25 %, hat aber keine Hardware-Unterstützung; SDK 13.1 fügt NV16/P210
für 4:2:2 hinzu, die AV1 als Profil fehlt). P010 bleibt damit das einzige
und leichteste 10-bit-Eingabeformat von NVENC für AV1 (volle Enum-Liste aus
nvEncodeAPI.h SDK 13.1 geprüft: NV12/YV12/IYUV/YUV444/YUV420_10BIT/
YUV444_10BIT/ARGB/ARGB10/AYUV/ABGR/ABGR10/U8/NV16/P210).

**Nachtrag spät — Browser-Zuschauer von 10-bit-Strömen (Wunsch: „Browser
bekämen dann eben 8 bit"): getestet und abgelehnt von Chromium selbst.**
Aufbau: Sidecar-Stream 10 bit via RTMPS, Chromium mit der 1:1-WHEP-Testseite
(`whep-page.html`), periodische Vollbild-Anforderung per Sender-RPC.
MediaMTX bestätigt die Track-Übergabe („1 track (AV1)"), aber Chromiums Log
zeigt pro Dekodier-Versuch: `Dav1dDecoder::Decode unhandled bit depth: 10` —
libwebracs dav1d-Integration gibt nur 8-bit-Frames heraus und verwirft
10-bit-Frames komplett (Schwarzbild, keine Fehlermeldung im Seiten-UI).
Damit: Ein Browser-Zuschauer bekommt heute **gar kein Bild** von einem
10-bit-Strom (nicht: ein 8-bit-Bild) — ein automatischer Tiefe-Abbau
existiert im Weg nicht (MediaMTX transkodiert nicht), und ein echter
8-bit-Zweitstrom wäre eine Transkodierungsfunktion (zweiter Encode), keine
Einstellung. HQ bleibt damit nativer-Player-only, bis libwebrtc
High-Bitdepth-AV1-Dekodierung zulässt (dav1d kann es, die Integration
verweigert es) oder eine Transkodierstufe gebaut wird.

**Status des Experiment-Codes (12.09., spät):** Der Rgb10-Pfad und seine
Schalter sind aus dem Code wieder entfernt (Commit nach `dc1c6e60`, in der
Git-Historie abrufbar) — er löste ein Problem, das die Messung als
nicht-existent belegt hat (die P010-Umrechnung ist lastmäßig frei), und
hing am NVIDIA-Leseweg (CPU-Fallback). Die Befunde dieses Abschnitts bleiben
unverändert gültig. Der Wieder-Einstieg ist über die Git-Historie und die
Wand-Dokumentation im nv_import-Modulkommentar jederzeit möglich.
