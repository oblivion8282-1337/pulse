# FFmpeg-Patches des Windows-Labors

> **Intra-Refresh ist am 2026-08-21 aus Pulse entfernt worden.** Die
> Betriebsart, um die es auf diesem Blatt streckenweise geht, gibt es nicht
> mehr: kein Kästchen, kein Health-Feld, keine Encoder-Optionen, keine
> FFmpeg-Patches. Gründe waren das sichtbar schlechtere H.264-Bild, dass macOS
> sie nie trug, und dass ein Vollbild-Strom sich nach Paketverlust selbst
> repariert — ein Intra-Refresh-Strom nicht. Die zugehörigen Messakten sind
> gelöscht, weil sie teils nie bestätigt und teils später widerlegt wurden.
>
> **Was hier über die Betriebsart steht, ist Historie und keine Anleitung.**
> Methodik, Aufbau und alles Übrige gelten weiter.


Das Labor linkt gegen ein **selbst gebautes** FFmpeg (`../ffmpeg-patched/`,
gitignored — Bau-Erzeugnis, rund 40 MB). Diese beiden Patches sind der Grund,
warum es nicht das ausgelieferte tut.

Grundlage: **FFmpeg n8.1.2** (`38b8833 Bump for 8.1.2`).

| Patch | Was ohne ihn fehlt |
|---|---|
| `0001-vulkan-encode-intra-refresh.patch` | `-intra_refresh` gibt es an `av1_vulkan`/`h264_vulkan` gar nicht — der Vulkan-Vergleichsarm wäre ohne den Patch nicht messbar |
| `0002-vulkan-encode-h264-tolerate-unparsable-feedback.patch` | `h264_vulkan` lässt sich mit einer Ziel-Bitrate nicht öffnen; nur fester QP geht |

## 0001 — Intra-Refresh durchreichen

FFmpeg reicht `VK_KHR_video_encode_intra_refresh` in **keiner** Version durch
(8.1 und master geprüft). Der Patch bringt `-intra_refresh` und
`-intra_refresh_period` an `av1_vulkan` und `h264_vulkan` und legt die
Vulkan-Strukturen dafür an.

**Der Patch ist seit dem 2026-08-02 nicht mehr die Voraussetzung für das Labor,
sondern nur noch für dessen Vergleichsarm.** Er ist mit der Begründung „AMF
ignoriert Intra-Refresh byte-identisch" entstanden (gemessen 2026-08-01) — und
die ist widerlegt: gemessen wurde ein Optionsname, den `av1_amf` nicht kennt, die
richtige heißt dort `intra_refresh_mode gop_aligned`. Der Standard-Encode-Weg ist
seither AMF; der Vulkan-Weg bleibt als nachfahrbarer Vergleich stehen, und dafür
bleibt auch dieser Patch. Herleitung: `../CLAUDE.md`, Abschnitt „Der Encode-Weg",
und `../../testbench/profiles/amf-2026-08-02-intra-refresh-doch.json`.

## 0002 — ein unlesbarer Parametersatz-Abzug darf den Encoder nicht töten

**Das Symptom:** `h264_vulkan` scheitert beim Öffnen, sobald irgendeine
bitratengesteuerte Betriebsart gesetzt ist (`-b:v`, `-rc_mode cbr`,
`-rc_mode vbr`). Mit festem QP läuft es, und `av1_vulkan` hat das Problem
überhaupt nicht — dieselbe Karte, derselbe Treiber.

```
[h264_vulkan] rbsp_stop_one_bit out of range: 0, but must be in [1,1].
[h264_vulkan] Failed to read unit 0 (type 7): Invalid data found when processing input.
[h264_vulkan] Unable to parse feedback units, bad drivers
```

**Die Ursache** ist zur Hälfte der Treiber und zur Hälfte FFmpeg. Beim Öffnen
holt FFmpeg vom Treiber einen Abzug der erzeugten Parametersätze und parst ihn
zurück. Verwendet wird das Ergebnis **nur**, wenn der Treiber meldet, er habe
etwas geändert. Auf einer Radeon 780M (Treiber 32.0.31035.1003) meldet er in
jedem Fall:

```
Feedback units written, overrides: 0 (SPS: 0 PPS: 0)
```

Also: nichts geändert. Direkt darunter steht in `vulkan_encode_h264.c` aber

```c
params_feedback.hasOverrides = 1;              /* fest verdrahtet */
h264_params_feedback.hasStdPPSOverrides = 1;   /* fest verdrahtet */

if (!params_feedback.hasOverrides)   /* damit unerreichbar */
    return 0;
```

— die Auskunft wird überschrieben, das Parsen läuft trotzdem, und mit
Bitratensteuerung liefert der Treiber ein SPS-Abbild mit `rbsp_stop_one_bit = 0`.
Der Encoder stirbt an einem Abzug, den er **nicht braucht**: den SPS, der
wirklich in den Strom geht, erzeugt FFmpeg selbst in `init_sequence_headers()`.

**Was der Patch tut:** ein Fehlschlag beim Parsen wird zur Warnung statt zum
Abbruch. Die defensive Absicht des Originals bleibt (es wird weiter geparst,
echte Overrides werden weiter übernommen) — nur bringt ein unlesbarer Abzug den
Encoder nicht mehr um.

**Was der Patch NICHT tut:** er repariert den Treiber nicht. Sollte der auch den
echten Strom verkorksen und nicht nur den Abzug, zeigt sich das beim Zuschauer.
Deshalb wird beides gemessen — „öffnet" und „kommt an" sind zwei Fragen.

Die naheliegendere Fassung, die beiden fest verdrahteten Zeilen zu streichen,
ist bewusst **nicht** gewählt: sie stehen vermutlich dort, weil Treiber ihre
Overrides unterberichten, und dann übersähe man eine echte Änderung.

## Anwenden

```bash
git clone --depth 1 --branch n8.1.2 https://git.ffmpeg.org/ffmpeg.git ffmpeg-src
cd ffmpeg-src
git apply .../ffmpeg-patches/0001-vulkan-encode-intra-refresh.patch
git apply .../ffmpeg-patches/0002-vulkan-encode-h264-tolerate-unparsable-feedback.patch
```

Bau unter MSYS2/mingw64 (`make` liegt in `/usr/bin`, die Übersetzer in
`/mingw64/bin` — **beide** in den PATH):

```bash
./configure --prefix=… --enable-amf --enable-vulkan \
            --enable-libdav1d --enable-libopus \
            --enable-shared --disable-static --disable-doc
make -j8 && make install
```

`libdav1d` ist der Decoder des Messwerks (ohne ihn fällt es auf eine reine
Hardware-Hülle zurück und meldet „0 Bilder" für einen gesunden Strom),
`libopus` ist der Ton des Vulkan-Wegs.

**Sieben MSYS2-Laufzeit-DLLs gehören mit nach `ffmpeg-patched/bin`**
(`libwinpthread-1`, `libgcc_s_seh-1`, `libstdc++-6`, `libiconv-2`, `zlib1`,
`libdav1d-7`, `libopus-0`) — ohne sie startet kein Binary, und zwar wortlos
(`0xC0000135`, bevor eine Zeile Code läuft).
