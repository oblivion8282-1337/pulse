# Windows-HQ-Sidecar — Latenz-Check (2026-07-30)

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
