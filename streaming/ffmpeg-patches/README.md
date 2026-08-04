# FFmpeg-Patches des Labors

Zwei, und beide haben denselben Zweck: **Intra-Refresh auf AMD zugänglich
machen.** Die Hardware kann es auf beiden Betriebssystemen — es fehlt jeweils
nur die Durchreichung in FFmpeg.

| Patch | Für | Betrifft |
|---|---|---|
| `0001-vaapi_encode-…` | Linux, AMD/Intel (`*_vaapi`) | H.264 **und** AV1 |
| `0002-amfenc_av1-…` | Windows, AMD (`av1_amf`) | **nur** AV1 |

**Windows braucht ihn nur für AV1.** `h264_amf` reicht sein Gegenstück
(`intra_refresh_mb`) upstream durch — und mehr noch: unter
`usage=ultralowlatency`, das der Sidecar ohnehin setzt, frischt der Encoder von
sich aus auf. H.264 auf AMD/Windows braucht also **gar nichts**. `*_nvenc` hat
die Option auf beiden Betriebssystemen upstream.

**Und `0002` ist nicht durch ein neueres FFmpeg zu ersetzen.** Hier stand am
2026-08-04 zwischenzeitlich, die Optionen gäbe es ab 8.1.2 — das war falsch und
kam daher, dass das selbstgebaute FFmpeg des Labors sie hatte. Es hatte sie,
weil dieser Patch drin war. Wer das prüft, prüft an einem **ungepatchten**
Bau.

## 0001 — Intra-Refresh für den VAAPI-Encoder

Er ist der Grund, warum die Umstellung auf Intra-Refresh nicht auf
NVIDIA-Sender beschränkt bleiben muss.

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

Nicht von Hand — dafür gibt es `bootstrap-ffmpeg.sh` daneben:

```bash
scripts/hq-bauen.sh          # FFmpeg + Sidecar + Player, in einem
```

Das Skript holt denselben FFmpeg-Commit, den auch das Flatpak pinnt, patcht
ihn, baut LGPL (kein `--enable-gpl`, kein libx264) nach
`~/.cache/pulse/ffmpeg-intra-refresh/prefix` und prüft am Ende nach, dass die
Option wirklich da ist. Das System-FFmpeg wird nicht angefasst: Sidecar und
Player bekommen einen RPATH auf diesen Bau, sonst sieht ihn nichts.

Voraussetzungen: `libva-devel`, `libdrm-devel`, `opus-devel`, `openssl-devel`
und `nasm` (Fedora; auf Debian/Ubuntu die `-dev`-Namen).

**Zwei Fallen beim Bauen von Hand**, falls es doch jemand tut:

* `--enable-shared` ist Pflicht. Sidecar und Player linken gegen die
  Bibliothek; ein statischer Standardbau nützt ihnen nichts.
* **Das gebaute `ffmpeg`-Binary hat keinen RPATH auf seine eigenen
  Bibliotheken.** Ruft man es ohne `LD_LIBRARY_PATH` auf, lädt der Loader das
  libavcodec der Distribution aus `/usr/lib64` — die Gegenprobe befragt dann
  das falsche FFmpeg und meldet, der Patch habe nicht gegriffen, obwohl der
  Bau in Ordnung ist. Genau so ist es hier am 2026-08-03 einmal passiert:

  ```bash
  LD_LIBRARY_PATH=<prefix>/lib <prefix>/bin/ffmpeg -h encoder=av1_vaapi | grep intra_refresh
  ```

## Auslieferung

Der Patch muss **mitgeliefert** werden, sonst haben Nutzer auf AMD und Intel
kein Intra-Refresh, egal was der Sidecar kann — er bricht den Start dann ab
(`encode/opts.rs::intra_refresh_pruefen`), statt still Keyframes zu fahren.

* **Entwicklung:** `scripts/hq-bauen.sh`, s.o. Steht.
* **Linux-Auslieferung:** das Flatpak baut sein FFmpeg ohnehin selbst
  (`packaging/com.howispulse.Pulse.yml`, Modul `ffmpeg`, Tag `n8.1.1`) — der
  Patch kommt dort als weitere `type: patch`-Quelle dazu, wie die drei
  GSR-Patches. Gegen `n8.1.1` geprüft: greift sauber.
* **Upstream einreichen** bleibt wünschenswert (spart die Pflege), ist aber
  kein Ersatz: es gibt keine Zusage und keinen Termin, und Bestandssysteme
  hätten ihn erst mit dem nächsten Distributions-FFmpeg.

macOS braucht `0001` nicht — dort steht der Fall noch offen
(`videotoolbox` hat in FFmpeg keine einschlägige Stelle), siehe
`streaming/hq-labor/UEBERGABE-WINDOWS-MACOS.md`.

**Hier stand, Windows brauche keinen Patch, weil AMD dort über `*_d3d12va`
laufe. Beides ist widerlegt** (2026-08-04): der d3d12va-Encoder nimmt die
Option an und tut nichts damit, und AMD läuft unter Windows seither über AMF.
Was Windows braucht, steht als `0002` unten.

## 0002 — Intra-Refresh für `av1_amf` (Windows)

**Dieselbe Lücke, andere Schnittstelle.** Die AMF-Laufzeit kann rollenden
Intra-Refresh für AV1 genauso wie für H.264 — beide Eigenschaften werden
angenommen, überleben `Init()` und verändern den Bitstrom. Der FFmpeg-Wrapper
reicht sie nur für H.264 durch (`intra_refresh_mb`); der AV1-Wrapper hat sie
noch nie durchgereicht, in **keiner** Fassung.

Der Patch fügt `av1_amf` zwei Optionen hinzu:

| Option | Bedeutung |
|---|---|
| `intra_refresh_mode` | `disabled` · `gop_aligned` · `continuous` |
| `intra_refresh_stripes` | Streifen je Umlauf — AMF frischt einen Streifen je Bild auf, `N` Streifen heißen also ein voller Umlauf alle `N` Bilder |

Gemessen auf einer Radeon 780M (Treiber 32.0.31035.1003, FFmpeg n8.1.2): mit
`-intra_refresh_mode gop_aligned -intra_refresh_stripes <fps>` und `-g 60`
enthält ein 300-Bilder-Lauf **ein** Vollbild statt fünf, die Bitmenge bleibt
gleich und die Intra-Last verteilt sich, statt in Stößen anzufallen. Gilt für
8 wie für 10 Bit. Herleitung:
`streaming/testbench/profiles/amf-2026-08-02-intra-refresh-doch.json`.

`continuous` nimmt der Treiber an und tut auf dieser Hardware nichts damit; die
Betriebsart steht trotzdem im Patch, weil sie zum AMF-Enum gehört.

### Auslieferung — offen

Anders als auf Linux gibt es unter Windows **keinen** Bau aus Quelltext: der
Sidecar linkt gegen ein fertiges Paket (`ffmpeg-dist/n8.1-lgpl-shared`, geholt
von `scripts/fetch-ffmpeg.ps1`). Ein gepatchtes FFmpeg auszuliefern heißt
deshalb, dieses Paket selbst zu bauen statt es von BtbN zu übernehmen — eine
Entscheidung, die noch niemand getroffen hat.

**Bis dahin trägt Windows die Betriebsart nur mit H.264** (dort braucht es
nichts). Der Sidecar meldet das ehrlich und bricht bei AV1 mit einer Meldung
ab, die hierher zeigt (`encode/auffrischung.rs`).
