# Intra-Refresh auf Windows und macOS — Übergabe

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


Linux ist durch (NVIDIA am 2026-07-31, AMD am 2026-08-01). Dieses Blatt war
der Einstieg für die beiden fehlenden Plattformen.

> **Windows ist inzwischen durch, und dieses Blatt lag an zwei Stellen falsch.**
> Am 2026-08-02 auf einer Radeon 780M nachgemessen, am 2026-08-04 ausgeliefert
> (`streaming/win-hq-sidecar/src/encode/auffrischung.rs` und `src/whip/`):
>
> 1. **AMD läuft nicht über D3D12, sondern über AMF.** Die Tabelle unten sagt
>    „`av1_amf` kann kein Intra-Refresh" — falsch. Die Option heißt dort nur
>    anders: `intra_refresh_mode gop_aligned` (plus `intra_refresh_stripes`).
>    Gemessen wurde `-intra_refresh`, und der Treiber nimmt einen Optionsnamen
>    an, den er nicht kennt; daher die byte-identischen Ströme, aus denen der
>    Fehlschluss kam.
> 2. **Der D3D12-Weg ist unbrauchbar, nicht der bequeme.** `av1_d3d12va` bricht
>    mit Intra-Refresh sofort ab, und `h264_d3d12va` nimmt die Option an,
>    ändert den Strom um 0,47 Prozent und setzt weder
>    `constrained_intra_pred_flag` noch einen recovery point. Der Satz „es
>    braucht nicht die Welle von Hand wie bei VAAPI" stimmt technisch und führt
>    trotzdem in die Irre.
>
> Und ein Punkt fehlte ganz: **der Rückkanal.** Ein Intra-Refresh-Strom hat
> nach dem Start kein Vollbild mehr; ohne einen Sender, der die Anforderung des
> Zuschauers empfängt, kommt niemand mehr ins Bild. Unter Windows hieß das,
> ffmpegs WHIP-Muxer zu ersetzen — die Encoder-Option allein war nur die halbe
> Aufgabe.
>
> Der Rest des Blatts bleibt stehen: **macOS ist weiter offen**, und die
> Abschnitte „Wie dort gemessen wird" und „Die Fallen" gelten unverändert.
> Was hier widerlegt ist, steht als Widerlegung da statt zu verschwinden — der
> Fehlschluss ist naheliegend genug, dass ihn jemand ein zweites Mal zieht.

**Es ist am Quelltext belegt, nicht geraten** — aber nichts davon ist auf der
jeweiligen Maschine nachgemessen. Genau das ist die Aufgabe.

## Der gemeinsame Hebel

Alle drei Sidecars encodieren über **FFmpeg als Bibliothek** — Linux und
Windows mit `ffmpeg-next 8.1`, macOS mit 8.0. Die Frage ist deshalb überall
dieselbe: **bietet der jeweilige Encoder eine Intra-Refresh-Option an?**
Geprüft im FFmpeg-8.1.2-Quellbaum:

| Encoder | Intra-Refresh | Option |
|---|---|---|
| `*_nvenc` (h264, hevc, **av1**) | **ja, upstream** | `-intra-refresh 1` (+ `-forced-idr 1`) |
| `*_d3d12va` (h264, hevc, **av1**) | **ja, upstream** | `-intra_refresh_mode row_based` |
| `h264_amf` | ja — und `usage=ultralowlatency` frischt ohnehin schon auf | `-intra_refresh_mb N` |
| ~~`av1_amf`~~ | **doch, s. Kasten oben** | `-intra_refresh_mode gop_aligned` + `-intra_refresh_stripes` |
| `hevc_amf` | ungemessen | — |
| `hevc_qsv` | ja | `-int_ref_type` / `-int_ref_cycle_size` |
| `h264_qsv`, `av1_qsv` | **nein** | — |
| `*_vaapi` | **nein upstream** | unser Patch, `streaming/ffmpeg-patches/` — am 2026-08-21 gelöscht |
| `*_videotoolbox` | **nein, gar nichts** | — |

## Windows — erledigt am 2026-08-04

Ausgeliefert. Was hier ursprünglich stand, ist im Kasten oben berichtigt; der
tatsächliche Stand in einer Tabelle:

| Karte | Encoder | Betriebsart |
|---|---|---|
| NVIDIA, alle Codecs | `*_nvenc` | `intra-refresh` + `no-scenecut`, upstream. **Am 2026-08-04 auf einer RTX 5080 nachgemessen**: 1 statt 10 Vollbilder bei gleicher Datenrate, H.264 wie AV1, plus 9 recovery points gegen 0. Braucht kein gepatchtes FFmpeg. Messakte `nvidia-2026-08-04-windows-intra-refresh.json`, am 2026-08-21 gelöscht. |
| AMD, AV1 | `av1_amf` | `intra_refresh_mode=gop_aligned` + `intra_refresh_stripes`. Gemessen: ein Vollbild statt sechs, 8 wie 10 Bit. **Brauchte unseren FFmpeg-Patch** (`streaming/ffmpeg-patches/0002-…`, am 2026-08-21 gelöscht) — die Optionen gibt es in keiner FFmpeg-Fassung. |
| AMD, H.264 | `h264_amf` | trägt sie **ohne jede Option**: `usage=ultralowlatency`, das der Sidecar ohnehin setzt, frischt von sich aus auf. Kein Patch nötig. |
| Intel | `*_qsv` | nein, die Option gibt es dort nur bei HEVC. |

> **Diese Tabelle sagte bis 2026-08-04 etwas anderes** — H.264 auf AMD laufe
> über `h264_d3d12va`, trage die Betriebsart nicht, und `PULSE_HQ_AMD_D3D11=1`
> hole den AMF-Weg zurück. Das galt genau 29 Minuten: seit demselben Tag geht
> AMD mit **jedem** Codec über AMF, und der Gegenprobe-Schalter heißt
> `PULSE_HQ_AMD_D3D12=1` und wirkt andersherum. `PULSE_HQ_AMD_D3D11` gibt es im
> Quelltext nicht mehr.

**Wo der Schalter saß:** `win-hq-sidecar/src/encode/auffrischung.rs`, das
Gegenstück zu den `intra_refresh_*`-Funktionen in
`linux-hq-sidecar/src/encode/opts.rs`. Der vendor-neutrale Schalter hieß auf
beiden Plattformen `PULSE_INTRA_REFRESH=1`, damit die Prüfstand-Skripte gleich
blieben; aus der Oberfläche kam `overrides.intra_refresh`. **Am 2026-08-21 ist
das alles entfallen** — die Umgebungsvariable, das Feld im `start`-Auftrag und
die `intra_refresh_*`-Funktionen der Linux-Seite. `auffrischung.rs` gibt es im
Windows-Sidecar weiter, aber mit anderer Aufgabe (es kennt nur noch die
Encoder, die von sich aus auffrischen und deshalb den bestellten
Vollbild-Takt verschlucken).

**Der Unterschied zu Linux, und er ist der Kern:** dort genügt die Frage, ob
das gelinkte FFmpeg die Option kennt — wo sie da ist, wirkt sie auch. Hier
nicht. `h264_d3d12va` kennt sie und tut nichts damit. Eine Abfrage der
Optionstabelle sagte also „ja" und läge falsch. Deshalb entscheidet auf Windows
eine Tabelle aus Messungen statt einer Abfrage — und verweigert den Start,
statt still Keyframes unter dem Etikett „Intra-Refresh" zu fahren.

**Der Rückkanal war die andere Hälfte.** Ein Intra-Refresh-Strom hat nach dem
Start kein Vollbild mehr; ohne einen Sender, der die Anforderung des Zuschauers
empfängt, kommt niemand mehr ins Bild. ffmpegs WHIP-Muxer hat keinen und kann
kein AV1 — also ist die Linux-Fassung des eigenen WebRTC-Sendewegs mit
portiert (`win-hq-sidecar/src/whip/`, eingehängt über `encode::senke`).

## macOS — der offene Fall, und wie er ausgegangen ist

> **Am 2026-08-21 entschieden — auf allen Plattformen bei Vollbildern bleiben.**
> Die unten offen gelassene Produktentscheidung ist damit gefallen, und zwar
> gegen Intra-Refresh. Der Absatz darunter ist Historie.

`videotoolbox` hat in FFmpeg **keine einzige** Intra-Refresh-Stelle. Damit war
der Weg, der auf allen anderen Plattformen funktionierte, dort versperrt.

Zu klären war, ob **VideoToolbox selbst** es kann — FFmpeg reicht viele
VT-Eigenschaften nicht durch. Nachzusehen wäre in
`VTCompressionProperties.h` des SDK nach einem Schlüssel für Intra-Refresh
bzw. „forced intra rows" gewesen. **Nachgesehen hat es nie jemand**, und die
Produktentscheidung ist am 2026-08-21 ohne diese Antwort gefallen: nicht
plattformabhängig ausliefern, sondern überall bei Vollbildern bleiben.

**Das war der Punkt, an dem „das Feature kann erst raus, wenn alles fertig ist"
kippen konnte** — nicht an Aufwand, sondern an einer Schnittstelle, die es
vielleicht nicht gibt. Genau so ist es gekommen; die Lehre bleibt: **die
Plattform mit der unsichersten Schnittstelle gehört zuerst geprüft, nicht
zuletzt.**

## Wie dort gemessen wird

Der Prüfstand (`streaming/testbench/`) ist **Linux-gebunden**: Portal-Capture,
`tc`, `tcpdump`, Zeitmuster über PySide6. Zwei Wege:

* **Datei-Vergleich auf der Zielmaschine** — encodieren, Keyframes zählen,
  VMAF gegen den Rohmitschnitt. Beantwortet „wirkt der Schalter" und „was
  kostet er", nicht „was bringt er unter Verlust".
* **Sender dort, Zuschauer hier** — der Windows-Sidecar pusht auf den
  Labor-Server, der Linux-Player misst mit den vorhandenen Werkzeugen. Das ist
  der Weg für die Verlustreihe; `fern-referenz.py` zeigt das Muster
  (Sender fern, Messung lokal), muss dafür aber angepasst werden.

## Die Fallen, die auf Linux Zeit gekostet haben

1. **Der Zustand der Maschine gehört vor jeden Lauf.** Sechs vergessene
   `mpv`-Prozesse haben anderthalb Stunden lang jede Messung verfälscht und
   ZWEI falsche Befunde erzeugt. `gemeinsam.zustand_pruefen()` fängt das jetzt
   — auf Windows gibt es das nicht, dort also von Hand: läuft noch ein Sender,
   ein Player, ein Browser mit Video?
2. **Der Schalter muss im Protokoll stehen.** Eine Variante über eine
   Umgebungsvariable zu fahren, die nirgends auftaucht, ist nicht
   nachweisbar — und „kein Unterschied" hat dann die naheliegendste Erklärung:
   es lief zweimal dasselbe.
3. **Die Fähigkeitsprobe muss dieselben Einstellungen benutzen wie der Betrieb.**
   Auf Linux fiel H.264 still aus der Codec-Liste, weil die Probe die B-Bilder
   nicht abschaltete, die der Live-Pfad abschaltet.
4. **Ein Lauf je Variante trägt nichts**, und eine Fehlermeldung am Ende eines
   Logs ist kein Befund. Beides ist hier trotzdem passiert.
