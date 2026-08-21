# HDR-Streaming auf Windows/NVIDIA — was gemessen wurde und was fehlt

Maschine: GeForce RTX 5080, Treiber 610.47 (Windows-Fassung 32.0.16.1047),
Windows 11 26200. Primärbildschirm `\\.\DISPLAY2`, 2560x1440, HDR eingeschaltet;
DXGI meldet 530 cd/m² Spitze, 295 cd/m² über die volle Fläche, 0,0003 cd/m²
Schwarz, 10 bit je Kanal, Weißpunkt (0,3135, 0,3291).
Encoder `av1_nvenc`, FFmpeg n8.1 (der ausgelieferte Bau, ffnvcodec 13.0).
Alles hier ist **am fertigen Bitstrom** nachgesehen, nicht am Log des Senders.

Gegenstück zu `2026-08-06-hdr-windows-amd.md`. Was dort über die Kette **bis
zum Encoder** steht — WGC in scRGB/fp16, der eigene PQ-Shader statt des
Video-Prozessors, die Signalisierung über reine FFmpeg-Felder — gilt hier
unverändert und wird nicht wiederholt. Dieses Dokument handelt vom Encoder.

## Ergebnis in zwei Sätzen

**Der Sidecar sendet auf NVIDIA HDR.** Der AV1-Sequenzkopf trägt PQ, BT.2020,
BT.2020-Matrix, Studio-Bereich und 10 bit — vollständig und korrekt —, und der
Inhalt ist echtes PQ: bei einem HDR-Testbild reicht er bis **9678 cd/m²**, dem
Vierzigfachen dessen, was dieser Desktop als SDR-Weiß ablegt.

**Was fehlt, sind die HDR10-Mastering-Angaben.** In keinem gemessenen Strom
steht ein `OBU_METADATA`. Die Ursache ist eingegrenzt und liegt nicht bei uns:
derselbe Quellstrom, dasselbe FFmpeg und dieselbe Codestelle schreiben über
`hevc_nvenc` beide SEI-Nachrichten anstandslos, über `av1_nvenc` nichts.

> **In `encode/hdr.rs` stand bis zum 2026-08-11 „ungemessen, nicht
> ausgeschlossen" und ein Start-Verbot.** Das ist eingelöst — mit einer
> Einschränkung, die die alte Zeile nicht vorhergesehen hat und die deshalb
> jetzt beim Start angesagt wird.

## Befund 1: Die Signalisierung ist vollständig

Am Bitstrom mit `trace_headers` gelesen, nicht an einer Optionstabelle:

| Feld im Sequenzkopf | Wert | |
|---|---|---|
| `high_bitdepth` | 1 | 10 bit |
| `color_description_present_flag` | 1 | |
| `color_primaries` | 9 | BT.2020 |
| `transfer_characteristics` | **16** | SMPTE ST 2084 (PQ) |
| `matrix_coefficients` | 9 | BT.2020 non-constant luminance |
| `color_range` | 0 | Studio |

ffprobe am selben Strom: `pix_fmt=yuv420p10le color_space=bt2020nc
color_transfer=smpte2084 color_primaries=bt2020 color_range=tv`.

**Und die Gegenprobe stimmt auch.** Befund 2 der AMD-Akte war ein 10-bit-Strom
*ohne* HDR, der sich trotzdem als PQ ausgab — AMF nimmt für 10 bit von sich aus
PQ an, wenn man ihm nichts anderes sagt. Auf NVENC meldet derselbe Lauf sauber
`bt709/bt709/bt709`. `sdr_signalisieren` wirkt hier wie dort.

## Befund 2: Der Inhalt ist wirklich HDR — und diesmal mit echten Spitzlichtern

Das ist die Frage, an der die Übung hängt: eine SDR-Aufnahme mit PQ-Etikett
sähe in jeder Kennzahl gesund aus. Gemessen an Bild 45 (**nicht** Bild 0 — das
erste Bild ist das Vollbild und auch dann richtig, wenn alle folgenden es nicht
sind), `signalstats`, 10-bit-Codes.

**a) Gewöhnlicher Inhalt** (ffplay mit `testsrc2` im Vollbild, also ein
SDR-Programm auf einem HDR-Desktop):

| | SDR-Lauf | HDR-Lauf |
|---|---:|---:|
| Y max | 889 | **579** |
| Y Mittel | 507,1 | 465,5 |
| Y min | 98 | 209 |

Derselbe Bildschirminhalt liegt im HDR-Lauf 310 Codewerte tiefer. Der SDR-Lauf
klemmt oben an, der HDR-Lauf tut das nicht; durch die PQ-Kurve zurückgerechnet
sind 579 genau **217 cd/m²** — der SDR-Weißpunkt dieses Desktops. Wäre die
Kurve nicht angewandt worden, läge die Spitze wieder bei 889 bis 940. Derselbe
Schluss wie Befund 4 der AMD-Akte, auf anderer Hardware.

**b) Echte HDR-Spitzlichter.** Die AMD-Messung und die Intra-Refresh-Akte vom
2026-08-04 (`nvidia-2026-08-04-windows-intra-refresh.json`, am 2026-08-21
zusammen mit der Betriebsart gelöscht) hatten beide dieselbe Lücke: gemessen wurde an SDR-Inhalt auf einem
HDR-Desktop, und mehr als SDR-Weiß stand dort nirgends im Bild. Nachgeholt mit
einem selbst erzeugten PQ/BT.2020-Clip (waagerechte Rampe, `gradients` +
`setparams`, mit `av1_nvenc` nach mp4), abgespielt im VLC im Vollbild:

| | SDR-Lauf | HDR-Lauf |
|---|---:|---:|
| Y max | 946 | 937 → **9678 cd/m²** |
| Y Mittel | 483,6 | 411,5 → 31,3 cd/m² |

Werte weit oberhalb dessen, was SDR überhaupt darstellen kann, überstehen also
die ganze Kette: WGC in fp16, den PQ-Shader, P010 und den Encoder.

**Warum trotzdem beide Läufe.** Lauf b beantwortet die Klemm-Frage *nicht*: der
Inhalt reicht absichtlich bis ans obere Ende des PQ-Bereichs, damit liegen 946
und 937 beide knapp unter dem Weißpunkt 940 und sind nicht mehr zu trennen. Die
Klemm-Prüfung trennt scharf bei gewöhnlichem Inhalt — Lauf a trägt sie, Lauf b
trägt die Spitzlichter. Wer nur den spektakuläreren fährt, hat die Hälfte.

### Nebenbefund: welcher Abspieler überhaupt HDR ausgibt

Der erste Anlauf nahm Chrome und hätte die Messung fast entwertet — die Zahl
sah plausibel aus und war trotzdem nur SDR-Weiß. Derselbe Clip, derselbe
Bildindex, derselbe Aufbau:

| | Y max | | |
|---|---:|---:|---|
| VLC | 937 | 9678 cd/m² | reicht PQ durch |
| Chrome | 590 | 245 cd/m² | gibt SDR aus |
| Edge | 592 | 250 cd/m² | gibt SDR aus |

`--force-color-profile=scrgb-linear` und `--force-color-profile=hdr10` ändern
an Chrome nichts (590 bzw. 589). Die 245 cd/m² sind dabei nützlich: sie sind
der SDR-Weißpunkt dieses Desktops, und alles darunter ist kein Spitzlicht.

## Befund 3: Die Mastering-Angaben kommen nicht an — und woran es liegt

In 11,9 MB HDR-Strom (581 Bilder): 5 `OBU_SEQUENCE_HEADER`, 581
`OBU_TEMPORAL_DELIMITER`, 581 `OBU_FRAME`, **0 `OBU_METADATA`**. Am rohen
Byte-Strom ausgezählt, damit kein Werkzeug die Antwort fälschen kann.

Der Weg dorthin in vier Schritten, weil jeder einzelne für sich plausibel
aussah:

1. **Der Sidecar hängt die Nutzlasten an jedes Bild** (`hdr_metadaten::am_bild`).
   Für AMF ist das der richtige und einzige Weg. Trotzdem kam nichts an.
2. **Die Stelle in FFmpeg** ist `libavcodec/nvenc.c`, `nvenc_setup_av1_config`:

   ```c
   ctx->mdm = av1->outputMasteringDisplay = !!av_frame_side_data_get(
       avctx->decoded_side_data, avctx->nb_decoded_side_data,
       AV_FRAME_DATA_MASTERING_DISPLAY_METADATA);
   ```

   NVENC bekommt den Schalter **einmal beim Öffnen**, und FFmpeg macht ihn
   ausschließlich an `decoded_side_data` fest — den Begleitdaten am **Kontext**,
   nicht denen am Bild. Ist er aus, überspringt `nvenc_set_mastering_display_data`
   den Bild-Weg vollständig (`if (ctx->mdm || ctx->cll)`). Nichts daran schlägt
   fehl, nichts wird geloggt.
3. **Die Abhilfe ist gebaut** (`hdr_metadaten::am_kontext`) und wirkt
   nachweislich: zur Laufzeit steht `nb_decoded_side_data = 2`. Am Strom ändert
   sich nichts.
4. **Zwei Gegenproben grenzen es ein**, beide ohne unseren Code:
   - Ein Quellstrom, der die Metadaten nachweislich trägt, durch
     `ffmpeg -c:v av1_nvenc`. FFmpeg meldet für den *Ausgangsstrom*
     `Side data: Mastering display metadata … max_luminance=530.000000 /
     Content light level metadata: MaxCLL=530, MaxFALL=295` — der Schalter war
     also an. Im Ausgang: wieder 0 `OBU_METADATA`.
   - Derselbe Quellstrom, dasselbe FFmpeg, nur `-c:v hevc_nvenc`: **beide
     SEI-Nachrichten stehen im Strom**, mit den richtigen Zahlen.

**Damit ist es genau eine Aussage:** NVENCs AV1-Encoder schreibt die
Metadaten-OBUs auf diesem Treiber nicht, obwohl `outputMasteringDisplay` und
`outputMaxCll` gesetzt sind. Nicht FFmpeg, nicht unser Code, nicht der Codec im
Allgemeinen.

**`am_kontext` bleibt trotzdem im Code**, obwohl es heute nichts bewirkt: ohne
den Schalter am Kontext ginge es auch nach einem Treiber-Update nicht, und dann
suchte jemand die Ursache erneut. Auf AMD ist es folgenlos — `decoded_side_data`
kommt in `amfenc*.c` nicht vor.

### Warum das trotzdem `traegt_hdr → true` ist

Die Tabelle in `encode/hdr.rs` fragt, ob ein Encoder eine
HDR-**Signalisierung** bis in den Strom trägt, und die ist vollständig. Der
Fehler, gegen den es das Modul gibt, ist der Strom, der HDR behauptet und SDR
enthält — der liegt hier nicht vor. Was fehlt, sind Hinweise für das
Tone-Mapping des Zuschauers.

Und dieselbe Klasse von Mangel wird auf AMD seit dem 2026-08-06 ausgeliefert,
nur andersherum: dort **sind** die Zahlen da und **falsch skaliert** (351 cd/m²
gesendet, 13721 cd/m² im Strom, Befund 3 der AMD-Akte). Für einen Zuschauer,
der MaxCLL zuerst liest, ist „nichts" ehrlicher als „falsch": er nimmt dann
seinen benannten Ersatzwert, statt einer erfundenen Zahl zu glauben.

**Was es kostet, damit es niemand suchen muss:** ohne MaxCLL nimmt
`pulse-player` 1000 cd/m² an (`render/farbe.rs::ERSATZ_SPITZE_NITS`), während
dieser Schirm 530 meldet. Auf einem SDR-Fenster rechnet er das Bild dadurch
stärker herunter als nötig. Die Bilddeutung hängt nicht daran. Damit niemand
den Effekt beim Player sucht, sagt `hdr::mastering_fehlt` ihn beim Start an:

```
[hdr] NVENC schreibt auf diesem Treiber keine HDR10-Mastering-Angaben in den
      AV1-Strom … Die Farb-Signalisierung ist vollständig; Zuschauer ohne
      MaxCLL nehmen einen Ersatzwert fürs Tone-Mapping.
```

## Was offen bleibt

* **Ob ein neuerer Treiber die Metadaten schreibt.** Nicht prüfbar ohne einen
  zweiten Treiberstand; 610.47 ist der einzige hier vorhandene — derselbe wie
  in den Akten vom 2026-08-04 und vom 2026-08-11 zur Bittiefe.
* **Wie es am Bildschirm aussieht.** Gemessen wird bis zum Bitstrom. Dieselbe
  Grenze wie in der AMD-Akte.
* **Der Weg über die Leitung.** Alles hier ist am Dateimitschnitt gemessen.
  Dass die Signalisierung den WHIP/WHEP-Weg übersteht, ist auf AMD belegt
  (Befund 7 dort) und hängt nicht am Encoder — hier aber nicht wiederholt.

## Reproduzieren

```powershell
cd streaming\win-hq-sidecar
cargo build --release --bins
cd ..\win-hq-labor\testbench

# Lauf a — die Klemm-Frage, gewoehnlicher Inhalt
powershell -ExecutionPolicy Bypass -File .\hdr-nachweis.ps1

# Lauf b — echte Spitzlichter. Der Clip einmalig erzeugen:
#   ffmpeg -f lavfi -i "gradients=s=1920x1080:c0=black:c1=white:x0=0:y0=540:
#          x1=1919:y1=540:n=2:rate=30:d=30,format=yuv420p10le,
#          setparams=color_primaries=bt2020:color_trc=smpte2084:
#          colorspace=bt2020nc:range=tv"
#          -c:v av1_nvenc -pix_fmt p010le -b:v 20000k pq-testbild.mp4
powershell -ExecutionPolicy Bypass -File .\hdr-nachweis.ps1 -Inhalt pq-testbild.mp4
```

Läuft HDR im System nicht, verweigert der Sidecar den Start und sagt warum —
das ist der erwartete Ausgang, kein Fehler des Skripts.

Zahlen, Rohbefunde und die beiden Gegenproben im Detail:
`streaming/testbench/profiles/nvidia-2026-08-11-windows-hdr.json`.
