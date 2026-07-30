# Windows-HQ-Sidecar — Latenz-Check (2026-07-30)

> **Stand 2026-07-30, abends — Schritt 1 und 2 sind umgesetzt** (Branch
> `perf/win-sidecar-latenz`, auf einer RTX 5080 unter Windows geprüft). Was
> unten als „zu tun" steht, gilt nur noch für Schritt 3 (AMD). Die Korrekturen
> und die Messwerte stehen im Abschnitt [Was daraus geworden
> ist](#was-daraus-geworden-ist) am Ende — der Text davor ist der Stand VOR der
> Umsetzung und wird bewusst nicht umgeschrieben, damit die Erwartung neben dem
> Ergebnis stehenbleibt.

Schreibtisch-Prüfung, **keine einzige Messung**. Entstanden auf der
Linux/AMD-Maschine unmittelbar nach der VAAPI-Messreihe (`508e53e4`), mit der
Frage: lohnt es sich, den Windows-Sidecar anzufassen — für NVIDIA wie für AMD?

**Kurzantwort: ja, aber der größte Posten ist nicht der Encoder, und die erste
Änderung darf keine Optimierung sein.**

## Was hier belegt ist und was nicht

Sauber getrennt, weil der Unterschied auf diesem Zweig gerade das Thema ist:

- **Aus dem Quelltext belegt** — alles unter „Befunde" mit Datei:Zeile.
- **Aus den echten AVOption-Tabellen belegt**: `h264_amf`/`av1_amf` sind in das
  FFmpeg dieser Fedora-Maschine einkompiliert, `ffmpeg -h encoder=…` liest
  deshalb dieselbe Tabelle, die auch unter Windows gilt (die Optionen kommen
  aus `libavcodec/amfenc*.c`, plattformunabhängig; nur die AMF-Laufzeit
  dahinter ist Windows-only).
- **Nicht prüfbar gewesen**: die `*_d3d12va`-Encoder — die gibt es nur im
  Windows-Build. Deren Optionstabelle ist unbekanntes Gelände.
- **Nirgends gemessen**: die tatsächliche Wirkung. Jede Zahl unten stammt aus
  dem Linux-Zweig und ist eine *Erwartung*, keine Windows-Messung.

## NVIDIA: Encoder-Optionen sind fertig

`src/encode/encoder.rs:516` setzt `preset=p2`, `tune=ull`, `rc=cbr`,
`zerolatency=1`, `delay=0`. Das ist der Stand, den Linux erst am 2026-07-26/27
erreicht hat — Windows hatte ihn „seit jeher", und `tune=ull` ist strenger als
Linux' `ll`. **Hier ist nichts zu holen.** `b_ref_mode=0` fehlt gegenüber Linux,
ist aber gegenstandslos: `ull` schaltet B-Bilder ohnehin ab.

## AMD: derselbe Verdacht wie `async_depth=3`, nur größer

`vendor_encoder_opts("amd")` (`src/encode/encoder.rs:522`) setzt
`usage=transcoding`, `quality=balanced`, `rc=cbr`. Aus der Optionstabelle:

```
-async_depth   Set maximum encoding parallelism.
               Higher values increase output latency.   (1..42, default 16)
```

**`async_depth` wird nicht gesetzt, der Default ist 16.** Auf Linux kostete
derselbe Schalter bei Wert **3** bereits 33,6 ms. Dass FFmpeg die Latenzwirkung
selbst in den Hilfetext schreibt, macht das zu einem dokumentierten Verdacht
statt zu einer Vermutung. **Offen bleibt**, ob AMF den Vorlauf wie VAAPI als
(n-1) Bildabstände aufbaut — das ist bei VAAPI gemessen, bei AMF nicht.

Drei weitere Werte zeigen in dieselbe Richtung:

| gesetzt | verfügbar | Anmerkung |
|---|---|---|
| `usage=transcoding` | `ultralowlatency`, `lowlatency` | „Generic Transcoding" ist das Bündel für Offline-Umkodierung |
| `quality=balanced` | `speed` | |
| — | `latency` (bool) | ungesetzt, Default auto |
| — | `preanalysis` | Default auto; Voranalyse ist Lookahead, also Vorlauf |

**Wichtige Einschränkung — dieser Zweig ist nicht der Standardweg.** Für AMD
läuft H.264/HEVC über `h264_d3d12va` (zero-copy), und der bekommt ausschließlich
`rc_mode=CBR` (`src/encode/encoder_d3d12.rs:410`). Der AMF-Zweig greift im
CPU-Pfad — und **AV1 landet dort immer**: `src/pipeline_d3d12.rs:59` schiebt AV1
mangels extradata auf den CPU-Pfad zurück, also Software-NV12 plus PCIe-Rückweg
*und* `async_depth=16`. Das Standardprofil ist H.264 (`src/profiles.rs:37`), AV1
ist eine Nutzerwahl im HQ-Panel.

## Der größere Posten: die vier encoder-unabhängigen Punkte fehlen komplett

Auf Linux waren diese zusammen mehr wert als der Encoder-Vorlauf. Auf Windows
ist **keiner** davon vorhanden — und sie gelten für **beide** Hersteller, der
fertig optimierte NVIDIA-Zweig hängt also hinter demselben Muxer:

| Punkt | Zustand auf Windows | Wirkung auf Linux |
|---|---|---|
| `max_interleave_delta` | nirgends gesetzt → FFmpeg-Default | 99,8 → 82,3 ms (größter Einzelposten) |
| Opus-Framegröße | **20 ms** (`OPUS_FRAME_SAMPLES = 960`, `src/encode/audio.rs:23`) | 5 ms; die *richtige* Schraube, weil FLV eine Zeitleiste ist |
| Ton-Rückstand aufholen | nicht vorhanden | 33,5 → 17,4 ms |
| `tcp_nodelay` | nicht gesetzt | 3,6 ms |

## Was zuerst gemacht werden muss, und das ist keine Optimierung

**Der Windows-Sidecar hat keinerlei Latenz-Instrumentierung** — kein
„Encode-Latenz"-Log, keine Zeitachsen-Zähler, nichts. Auf Linux war genau das
die Grundlage der ganzen Messreihe. Ohne sie ist jede Änderung unbelegbar, und
man landet in der Falle, vor der `docs/plans/2026-07-29-amd-linux-uebergabe.md`
warnt: eine Zahl, die plausibel aussieht und nichts beweist.

Dazu kommt der Fund aus `d8ad59d1`: FFmpeg verwirft unbekannte Encoder-Optionen
**stillschweigend**. `usage=ultralowlatency` könnte auf dem d3d12va-Pfad
wirkungslos verpuffen, ohne dass es irgendwo auffällt. Die `warn_unknown`-Prüfung
aus dem Linux-Sidecar gehört deshalb mit portiert, bevor irgendetwas gedreht wird.

**Vorgeschlagene Reihenfolge:**

1. Instrumentierung + `warn_unknown` portieren (`streaming/linux-hq-sidecar/src/encode/{mod,opts}.rs` als Vorlage).
2. Die vier encoder-unabhängigen Punkte — billig, herstellerunabhängig, auf Linux belegt.
3. Dann erst `async_depth` und `usage` auf AMD messen.

## Was das kostet

- Braucht eine **Windows-Maschine mit AMD- und NVIDIA-Karte**. Auf dieser
  Maschine ist nichts davon prüfbar.
- Jeder Windows-Release braucht einen **Version-Bump in `desktop/package.json`**,
  sonst erreicht er keinen Bestandsclient (electron-updater ignoriert eine
  erneut publizierte gleiche Version stillschweigend).
- Der d3d12va-Pfad ist der Standardweg für AMD und zugleich der, über dessen
  Optionen hier **nichts** bekannt ist. Der erste Schritt dort ist eine
  Bestandsaufnahme (`ffmpeg -h encoder=h264_d3d12va` auf der Windows-Maschine),
  keine Änderung.


## Was daraus geworden ist

Umgesetzt am 2026-07-30 auf einer Windows-Maschine mit **RTX 5080**. AMD war
hier nicht verfügbar — Schritt 3 bleibt offen.

### Eine Behauptung oben war falsch

„Der Windows-Sidecar hat **keinerlei** Latenz-Instrumentierung — kein
Encode-Latenz-Log, keine Zeitachsen-Zähler, nichts." Das stimmt so nicht:
`src/tick_monitor.rs` misst pro Tick `wake_jitter`, `capture_drain`, `convert`,
`send`, `mux`, `iter`, zählt `pts_gaps`/`dups`/`capture_drops`, fasst alle 2 s
zusammen und schreibt mit `PULSE_HQ_TRACE=<pfad>` eine JSONL-Zeile pro Tick.

Gefehlt hat **genau eine** Größe, und die ist die entscheidende: `send` ist die
Dauer des Submit-Aufrufs. Bei einem Encoder mit Vorlauf ist sie nahe null,
während das Paket zwei Bilder später herausfällt — der Vorlauf war darin
unsichtbar. Schritt 1 war deshalb eine Metrik in einem vorhandenen Monitor, kein
Neubau.

### Was jetzt drin ist

| Punkt | Zustand |
|---|---|
| Encode-Latenz (Einschieben → Paket) | `src/encode/latency.rs`, in allen drei Encodern, im `TickMonitor` sichtbar |
| `warn_unknown_opts` | portiert, läuft vor jedem Encoder-Open |
| `PULSE_ENCODER_OPTS` | portiert — Messreihe ohne Neubau |
| `max_interleave_delta` | 10 ms (`src/encode/output.rs`) |
| Opus-Framegröße | 20 → **5 ms**, Aufnahme-Raster zieht mit (240 statt 1024 Frames) |
| `tcp_nodelay` | gesetzt |
| Ton-Rückstand aufholen | **nicht** übernommen, s. u. |

### Die Encode-Latenz ist jetzt belegt — und die Metrik ist geeicht

NVENC auf der RTX 5080, 1440p60, H.264, Ton an: **1,8 bis 2,4 ms** im Mittel
(Maximum 2,6 bis 4,4 ms). Der NVIDIA-Zweig hat also wirklich keinen Vorlauf, wie
oben vermutet — jetzt gemessen statt gelesen.

Die Gegenprobe zeigt, dass die Zahl misst, was sie soll: mit
`PULSE_ENCODER_OPTS=delay=2` springt sie auf **16,8 ms** — exakt ein Bildabstand
bei 60 fps — während `send` bei 2,6 ms bleibt. Das ist dieselbe Arithmetik wie
auf Linux (dort zwei Bildabstände ohne `delay=0`), und es ist der Beweis, dass
die neue Größe genau den Posten sieht, den `async_depth` auf AMD verändern soll.

Die Unbekannt-Warnung greift ebenfalls: `PULSE_ENCODER_OPTS=async_depth=3` meldet
sofort „'h264_nvenc' kennt die Option 'async_depth=3' nicht" (NVENC hat sie
nicht — das ist eine AMF/VAAPI/D3D12VA-Option).

### Der Ton-Rückstand wird gemessen, aber nicht korrigiert

Und das ist Absicht. Der Linux-Zweig holt einen anhaltenden Rückstand am Encoder
ein, weil dort der PipeWire-Null-Sink feste 27-29 ms einbrachte. **Windows
korrigiert an der Quelle:** `src/audio/wasapi.rs` führt ein Sample-Budget gegen
die Wanduhr, schiebt fehlende Chunks als Stille ein und verwirft reale Chunks,
die mehr als 100 ms vorauslaufen.

Gemessen (`PULSE_MUX_LATENCY_LOG=1`, zwei Läufe à 10 s): die Ton-Zeitlinie liegt
zwischen **-6,8 und +4,0 ms** um die Wanduhr, ohne Trend. Es gibt hier keinen
anhaltenden Rückstand — eine zweite Korrektur einzubauen wäre eine Änderung
gewesen, deren Wirkung man hinterher nicht mehr von der ersten hätte trennen
können.

### Ein Fund derselben Klasse wie `coder=cabac` auf Linux

`vendor_encoder_opts("intel")` setzte `look_ahead=0` unbedingt. Die Option gibt
es bei `h264_qsv` und `hevc_qsv` — bei **`av1_qsv` nicht** (gegen die
Optionstabellen des mitgelieferten FFmpeg n8.1 geprüft). Sie wurde bei jedem
AV1-QSV-Stream still verworfen. Folgenlos (der Default ist ohnehin `false`),
aber sie hätte die neue Warnung bei jedem gesunden AV1-Stream feuern lassen —
und eine Warnung, die im gesunden Fall feuert, erzieht dazu, Warnungen zu
überlesen. Jetzt auf H.264/HEVC begrenzt.

### Die d3d12va-Optionstabelle ist kein unbekanntes Gelände mehr

Oben stand, die `*_d3d12va`-Encoder seien nicht prüfbar. Das war ein Irrtum über
die Werkzeuglage, nicht über die Sache: die Tabelle ist in das mitgelieferte
Windows-FFmpeg einkompiliert und hängt nicht an der verbauten Karte
(`ffmpeg-dist/n8.1-lgpl-shared/bin/ffmpeg.exe -h encoder=h264_d3d12va`):

```
General capabilities: dr1 delay hardware
-async_depth   Maximum processing parallelism.  (from 1 to 64) (default 2)
-b_depth       Maximum B-frame reference depth  (default 1)
```

Der Encoder meldet die Verzögerung selbst als Fähigkeit (`delay`), und
`async_depth` steht auf 2. Wichtiger als der Wert: `*_d3d12va` sitzt auf
FFmpegs gemeinsamem `hw_base_encode`-Gerüst — **demselben, über das VAAPI
läuft**, also genau dem Code, aus dem der auf Linux gemessene
(n-1)-Bildabstand kommt. Der Linux-Befund überträgt sich damit über den
gemeinsamen Quelltext und nicht nur über die Namensähnlichkeit: erwartbar ein
Bildabstand, 16,7 ms bei 60 fps.

Gesetzt wurde er trotzdem **nicht** — das gehört auf eine AMD-Maschine gemessen,
und `PULSE_ENCODER_OPTS=async_depth=1` macht das jetzt ohne Neubau möglich.

### Was Schritt 3 als Nächstes braucht

1. Eine Windows-Maschine mit AMD-Karte. `PULSE_ENC_LATENCY_LOG=1` +
   `PULSE_ENCODER_OPTS=async_depth=1|2|4` auf dem d3d12va-Pfad, dann `usage` und
   `async_depth` auf dem AMF-Pfad (Default dort **16**).
2. Die Byte-Identitätsprobe aus dem Linux-Zweig ist auch hier das saubere
   Qualitätsargument: liefert eine reine Pipelining-Änderung denselben Bitstrom,
   kann sich die Bildqualität nicht ändern, und man braucht kein VMAF dafür.
3. **Ende zu Ende ist auf Windows weiterhin ungemessen.** Was von Schritt 2
   (Muxer/Ton) beim Zuschauer ankommt, sagt keine dieser Zahlen — dafür braucht
   es einen echten Push gegen MediaMTX und einen Empfänger, wie ihn
   `streaming/testbench/real-harness.py --e2e` auf Linux fährt.
