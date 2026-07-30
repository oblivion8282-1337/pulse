# Übergabe an die AMD-Maschine: Linux-Sendeweg optimieren

**Stand 2026-07-29.** Alle Messwerte dieser Messreihe sind auf einer **RTX 5080**
entstanden. Für AMD ist die Kette **unvermessen** — nicht falsch, sondern
unbekannt. Dieses Dokument sagt, was dort ohne Zutun gilt, was neu erarbeitet
werden muss, wie man es belegt und welche Fallen unterwegs stehen.

Es geht ausdrücklich um **Electron-Streaming** (Chromium empfängt und stellt dar,
im Browser wie in der Desktop-App). Der native Player ist nicht Teil des
Auftrags — er profitiert später automatisch, weil der Sender beiden Wegen
gemeinsam ist.

## Was zu klonen ist

**EIN Repo, seit 2026-07-29:** `github.com/oblivion8282-1337/pulse`, Branch
`main`. Encoder-Code unter `streaming/linux-hq-sidecar/`, Prüfstand unter
`streaming/testbench/`.

Der Absatz „warum zwei Repos" ist erledigt — das Zusammenlegen ist vollzogen
(`53aa1e23`), das Quell-Repo `pulse-linux-hq-sidecar` steht nur noch als Archiv
und trägt die Messbegründungen in seiner Historie. Der Prüfstand liegt seit
`7b9ab6a6` ebenfalls auf `main`, nicht mehr auf `feat/native-hq-player`.

## Bauumgebung auf einer frischen Maschine (Fedora, geprüft 2026-07-30)

```
sudo dnf install rust cargo clang-devel ffmpeg-free-devel pipewire-devel
```

`clang-devel` ist Pflicht, nicht optional: `pipewire-sys` und `ffmpeg-sys-next`
erzeugen ihre Bindings mit bindgen, das braucht `libclang.so`. Der Build läuft
danach ohne Zutun durch (1m06s, keine Warnung).

**Und dann ist da eine Falle, die Stunden kostet, wenn man sie nicht kennt:**
Fedoras Mesa liefert **keine patentbehafteten Codecs**. `vainfo` zeigt auf einem
Standard-Fedora als Encode-Fähigkeit ausschließlich
`VAProfileAV1Profile0 : VAEntrypointEncSlice` — **kein H.264, kein HEVC**.
`h264_vaapi` ist in FFmpeg vorhanden, der Treiber bietet es nur nicht an, und
der Fehler kommt erst beim Encoder-Open. Abhilfe:

```
sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm
sudo dnf install mesa-va-drivers-freeworld
```

Der Treiber landet in `/usr/lib64/dri-freeworld/`, das libva von sich aus zuerst
probiert — es wird nichts ersetzt, und `dnf remove` stellt den Ausgangszustand
wieder her. Die Mesa-Version muss exakt passen (hier 26.1.5 gegen 26.1.5).

**Zweite Hälfte derselben Falle, und die ist subtiler:** `ffmpeg-free` baut mit
`--disable-decoder='h264,hevc,vc1,vvc'`, lässt die *Encoder* aber aktiviert.
VAAPI-Decode ist in FFmpeg **kein Decoder**, sondern ein *hwaccel*, der sich in
den nativen Software-Decoder einhängt — fehlt der, gibt es keinen Andockpunkt.
Folge: `-hwaccel vaapi` auf H.264 scheitert **lautlos**, FFmpeg nimmt
`libopenh264` und rechnet auf der CPU, Exit-Code 0. Wer dort Decode-Last misst,
bekommt eine CPU-Zahl und hält sie für eine Hardware-Zahl. AV1-Decode ist davon
nicht betroffen (nativer `av1`-Decoder vorhanden, hwaccel greift). Wer H.264 in
Hardware dekodieren muss, braucht `libavcodec-freeworld` — **das zieht x264 und
x265 (GPL) vor die LGPL-libavcodec in den Loader-Pfad**, siehe die
Lizenz-Auflagen in der Wurzel-`CLAUDE.md`. Für Sender-Arbeit ist es nicht nötig.

## Was auf AMD schon gilt — nur gegenprüfen

Vier Verbesserungen sind **encoder-unabhängig** und sollten dort ohne Änderung
wirken. Sie sitzen im Muxer und im Ton-Pfad:

| Änderung | Ort | Wirkung (NVIDIA) |
|---|---|---|
| `max_interleave_delta` auf 10 ms | `encode/mod.rs` | 99,8 → 82,3 ms |
| Ton-Rückstand aufholen (2. Schwelle 15 ms) | `encode/audio.rs` | 33,5 → 17,4 ms |
| 5-ms-Opus statt 20 | `encode/audio.rs`, `capture/` | Bild wird nicht mehr gebündelt |
| `tcp_nodelay=1` | RTMPS-Ausgang | 3,6 ms |

Die erste ist die wichtigste und am wenigsten offensichtliche: Der Muxer gibt ein
Bild erst frei, wenn Ton mit mindestens so großem Zeitstempel vorliegt — der
Rückstand des Tons ist damit 1:1 Bild-Latenz.

## Was NEU erarbeitet werden muss

Zwei Verbesserungen stehen **ausschließlich im NVENC-Zweig** von
`encode/opts.rs::vendor_opts`. Der AMD/Intel-Zweig setzt heute `rc_mode=CBR`,
`async_depth=3`, `coder=cabac`.

**1. Encoder-Vorlauf abschalten.** Auf NVENC war das der größte Einzelposten der
Latenzkette: Der Encoder gab ein Paket erst heraus, wenn zwei weitere Bilder
eingeschoben waren — 33,3 ms bei 60 fps, exakt zwei Bildabstände. Abgeschaltet
mit `zerolatency=1` + `delay=0`: **33,4 → 2,9 ms**.

Bei VAAPI gibt es diese Optionen nicht. **Verdächtig ist `async_depth=3`** — der
Name deutet auf drei Bilder Tiefe, was demselben Problem entspräche. Das ist eine
Vermutung anhand des Namens, **keine Messung**. Zu klären: Hat VAAPI einen
vergleichbaren Vorlauf, und was schaltet ihn ab?

**2. Qualitätsstufe.** `preset=p2` bringt auf NVENC **rund 40 % weniger
Encoder-Last bei gleicher Bildqualität** (die ganze Leiter p1–p7 liegt innerhalb
von 1,3 VMAF). VAAPI hat andere Stufen; das Gegenstück ist zu finden und zu
messen.

## Wie man es belegt

Der Prüfstand fährt einen echten Stream ohne App und ohne Klick.

**Sender-Messungen** (brauchen keinen Zuschauer, Hauptteil für Encoder-Arbeit):
Der Sidecar protokolliert je Sekunde die Encode-Latenz („Einschieben bis Paket"),
die Zeitachse (`duplicates`/`pts_gaps`/`pts_clamps`) und beim Start den
gesetzten `max_interleave_delta`. Zusätzlich: `PULSE_MUX_LATENCY_LOG=1` meldet
den Ton-Rückstand im Muxer — das misst die **Ursache**, sieht den Deckel aber
NICHT. Wer den Deckel bewerten will, misst Ende zu Ende.

**Ende-zu-Ende** (`real-harness.py --e2e`): Das Bild trägt die Uhrzeit als
Klotzmuster, der Empfänger liest sie zurück. Zeitstempel im Bitstrom taugen
nicht, weil FLV/RTMP/MediaMTX/WebRTC sie umschreiben. **Achtung:** Der Prüfstand
nutzt dafür den nativen Player als Messgerät, und ob der auf AMD überhaupt läuft,
ist ungetestet (s. u.).

**Vergleichszahlen** liegen in `streaming/testbench/profiles/` (append-only).
Einstieg: `latenz-2026-07-27-*.json`, `bild-2026-07-27-av1.json` (Encoder-Preset),
`ruckeln-2026-07-28-geloest.json`.

## Fallen, die schon zugeschlagen haben

- **Die Prüfvorlage entscheidet über den Befund.** `synth10.mkv` ist mit
  av1_nvenc-Datei-Defaults kodiert und trägt Alt-Ref-Struktur, die der
  Live-Sidecar nie erzeugt. Damit entstanden ein reproduzierbarer
  Decoder-Absturz und 87 OBU-Fehler je Lauf, die es live gar nicht gibt.
  **Immer `live-vorlage.py` erzeugen und `PULSE_HARNESS_SOURCE` darauf setzen.**
- **Eine Störung, die nichts tut, sieht wie ein gutes Ergebnis aus.**
  `netem loss 5% 50%` (Korrelationsschreibweise) verwirft NACHWEISLICH gar
  nichts. `netz-harness.py` liest deshalb die tatsächlich verworfenen Pakete aus
  den tc-Zählern und meldet sie bei jedem Lauf. Nie ohne diese Kontrolle deuten.
- **Die Störung darf nicht an der Wurzel von `lo` hängen** — sie trifft sonst den
  RTMP-Push mit, und dann ist offen, welche Seite schwächelt. `--nur-empfang`
  benutzen.
- **Einzelmessungen bei schwankenden Größen beweisen nichts.** Erst das Rauschen
  messen (dieselbe Einstellung mehrfach), dann Unterschiede beurteilen. Ein
  vermeintlicher Fix von 33,5 → 21,4 ms war über je fünf Läufe 22,5 gegen 21,3.
- **Vor „das Bild steht" erst `duplicates` gegen echte Bewegung prüfen.** Wayland
  liefert nur bei Bildänderung ein neues Bild; der Sender füllt mit
  Wiederholungen auf. Bei ruhigem Desktop sind 100+ von 145 Bildern Duplikate —
  das ist normal.
- **Der Bildschirm muss wach sein.** Schlafende Monitore ergeben Schwarzbild ohne
  Zeitmuster. Bei Messreihen `systemd-inhibit --what=idle:sleep` setzen.

## Ungetestet auf AMD

- **Der Player-Decoder.** Er probiert `av1_cuvid`, `av1_qsv`, `av1_vaapi`, dann
  Software. **Teil-Antwort vom 2026-07-30:** AV1-Decode über VAAPI läuft auf dem
  780M — `vainfo` führt `VAProfileAV1Profile0 : VAEntrypointVLD`, und FFmpeg
  wählt für `-hwaccel vaapi` sichtbar den nativen `av1`-Decoder („Selecting
  decoder 'av1' because of requested hwaccel method vaapi") und lädt den
  Treiber. Der Weg ist also vorhanden. **Offen bleibt**, ob VAAPI genauso vier
  Bilder zurückhält wie der NVIDIA-Decoder (dort mit `AV_CODEC_FLAG_LOW_DELAY`
  behoben, 82,3 → 33,5 ms) und was er unter Paketverlust tut — dafür braucht es
  den Player, und der ist nicht auf `main`.

- **Es gibt kein Beispielprogramm für die volle VAAPI-Kette.**
  `examples/capture_encode_smoke.rs` lehnt AMD ausdrücklich ab („dieses Smoke
  testet den NVENC-Import; VAAPI-Import folgt separat"). Wer Portal → DMABUF →
  `hwmap` → `scale_vaapi` → Encoder am Stück fahren will, nimmt stattdessen
  `streaming/testbench/datei-harness.py`: das treibt den echten `start`-Op mit
  einem **Dateipfad** als `channel.push_url` (`url_format_hint` liefert dafür
  `None`, der Muxer schreibt eine Datei) und braucht damit weder MediaMTX noch
  Redis noch den Player.
- **Der TempDelim-Patch im MediaMTX-Fork** (`infra/mediamtx-fork/patches/0001-`)
  existiert ausschließlich für AMD-VAAPI-AV1: Diesen Strömen fehlen
  `OBU_TEMPORAL_DELIMITER`-Einheiten, und der Stream friert beim Zuschauer nach
  Sekunden ein. Zu prüfen, ob das noch gilt.
- **Der webrtc-Patchzweig liegt nur auf der NVIDIA-Maschine**
  (`~/Dokumente/webrtc-rs-pulse`, v0.17.2 + 24 Zeilen, via `[patch.crates-io]`
  eingebunden). Er wird nur für den FlexFEC-**Empfang** im Player gebraucht — für
  Sender-Arbeit nicht nötig, aber ein Player-Build auf AMD braucht ihn erreichbar.

## Was NICHT Teil des Auftrags ist

WHIP als Sendeweg, Intra-Refresh, die Vollbild-Weiterleitung im Server, FlexFEC,
der native Player selbst. Alles bewusst aus `perf/sendeweg-latenz-und-gpu`
herausgehalten — der Schnitt liegt vor den WHIP-Commits.
