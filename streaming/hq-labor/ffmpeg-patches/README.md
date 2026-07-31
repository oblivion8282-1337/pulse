# FFmpeg-Patches des Labors

Derzeit einer: **Intra-Refresh für den VAAPI-Encoder**. Er ist der Grund, warum
die Umstellung auf Intra-Refresh nicht auf NVIDIA-Sender beschränkt bleiben
muss.

## Warum es ihn gibt

Intra-Refresh gewinnt auf Linux+NVIDIA in jeder Kennzahl (Messakten in
`streaming/testbench/profiles/`). Für AMD stand die Frage im Raum, ob der Weg
überhaupt existiert — `av1_vaapi` bietet keine `intra-refresh`-Option an. Die
naheliegende Vermutung war, dass die Hardware es nicht kann und deshalb nur
`h264_amf` bliebe (AMDs eigene Schnittstelle, die Intra-Refresh nur für H.264
kann, nicht für AV1) — also H.264 statt AV1 auf AMD plus ein zweiter
Encoder-Pfad.

**Die Vermutung ist widerlegt.** Gemessen am 2026-08-01 auf Radeon 780M
(Phoenix/VCN 4, Mesa 26.1.5): Treiber und Hardware können Intra-Refresh, für
AV1 genauso wie für H.264. Es fehlte allein die Durchreichung in FFmpeg — in
**jeder** Version, auch in `master`. Volle Beweiskette in der Messakte
`streaming/testbench/profiles/amd-2026-08-01-intra-refresh.json`.

## Was der Patch macht

Zwei Optionen für alle VAAPI-Encoder, umgesetzt für **H.264 und AV1**:

| Option | Bedeutung |
|---|---|
| `intra_refresh` | schaltet die rollende Auffrischung ein und die periodischen Keyframes ab |
| `intra_refresh_period` | Bilder je vollem Umlauf (0 = der Keyframe-Abstand) |

Ein *angeforderter* Keyframe (PLI vom Zuschauer, `-force_key_frames`) wird
weiterhin kodiert und setzt den Umlauf zurück — der Einstieg neuer Zuschauer
bleibt also, wie er ist.

**Der nicht offensichtliche Teil:** anders als NVENC, wo der Treiber die Welle
selbst laufen lässt, sobald eine Periode gesetzt ist, erwartet VA-API in
**jedem** Bild die Position des aufzufrischenden Streifens. Mesa setzt den
Modus zu Beginn jedes Bildes auf `NONE` zurück (`frontends/va/picture.c`) —
wer den Parameter nur einmal schickt, frischt genau ein Bild lang auf und
merkt es nirgends.

**Die Falle, die im ersten Wurf zugeschlagen hat:** 1080p sind in Superblöcken
nur **17 Zeilen**. Rundet man „Blöcke je Bild" auf mindestens 1 auf, dauert
jeder Umlauf 17 Bilder — egal, ob 120 verlangt waren. Der Fehler ist nicht
sichtbar: es gibt keine Warnung, der Strom läuft, nur der Intra-Anteil je Bild
ist siebenfach zu hoch. Aufgefallen ist er, weil drei Umlaufdauern (120/60/30)
**byte-gleiche** Dateien ergaben. Deshalb trägt der Patch den Rest der Division
von Bild zu Bild weiter (`ir_debt`), statt zu runden.

HEVC ist **absichtlich ausgespart**: dort bestimmt der Encoder die CTB-Größe,
die Treiber zählen aber in unterschiedlichen Einheiten, und eine Abweichung
scheitert nicht — sie frischt still nur einen Teil des Bildes auf. Wer HEVC
braucht, misst es vorher.

## Bauen

```bash
curl -O https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz
tar xf ffmpeg-8.1.2.tar.xz && cd ffmpeg-8.1.2
git apply .../0001-vaapi_encode-rollender-intra-refresh.patch   # oder patch -p1
./configure --prefix=/pfad/nach/wohin --enable-vaapi --enable-shared --disable-static \
            --disable-doc --disable-debug
make -j$(nproc) && make install
```

Braucht `libva-devel` (Fedora) bzw. `libva-dev` (Debian/Ubuntu) und `nasm`.
`--enable-shared` ist nötig, damit der Sidecar (der gegen die Bibliothek linkt)
das gepatchte FFmpeg benutzen kann; für reine Datei-Versuche reicht das
statische Standard-Bauen.

Gegenprobe, dass der Patch wirklich greift:

```bash
./ffmpeg -h encoder=av1_vaapi | grep intra_refresh
```

## Was der Patch NICHT löst

**Die Auslieferung.** Sidecar und Labor linken dynamisch gegen das FFmpeg des
Systems, und dort ist der Patch nicht drin. Drei Wege, alle offen und alle eine
Nutzer-Entscheidung:

1. **Upstream einreichen.** Sauber, kostet nichts an Wartung — aber es gibt
   keine Zusage und keinen Termin, und Bestandssysteme haben ihn erst mit dem
   nächsten Distributions-FFmpeg.
2. **Eigenes FFmpeg ins Flatpak bündeln.** Wir kontrollieren die
   Linux-Auslieferung selbst. Lizenzlage beachten: ohne `--enable-gpl` ist
   FFmpeg LGPL, dynamisch gelinkt — das ist die Bedingung aus dem Wurzel-`CLAUDE.md`
   und bleibt damit eingehalten. Kostet Bauzeit und Pflege im Manifest.
3. **Nur im Labor.** Für Messungen reicht der lokale Bau; für Nutzer ändert
   sich nichts.

Bis einer davon steht, muss der Sidecar den Unterschied **merken und sagen** —
still auf Keyframes zurückzufallen wäre genau die Art Fehler, die hier schon
mehrfach Messreihen entwertet hat.
