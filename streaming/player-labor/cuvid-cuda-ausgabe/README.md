# Probe: gibt `av1_cuvid` seine Bilder als CUDA-Speicher heraus?

Die Frage, an der der ganze Zero-Copy-Umbau im `pulse-player` haengt. Die
Nachbarproben haben die zweite Haelfte der Kette belegt — CUDA schreibt direkt
in ein exportiertes `VkImage` (`../cuda-vulkan-import`), und wgpu 29 uebernimmt
so ein Bild mitsamt Inhalt (`../wgpu-cuda-import`). Was fehlte, war der Anfang:
**liegt das dekodierte Bild ueberhaupt auf der Karte?**

Der Modulkopf von `pulse-player/src/decode.rs` sagt bis heute nein („die
cuvid-Decoder liefern ihre Frames in den Hauptspeicher"), und die Kostenmessung
`streaming/testbench/profiles/player-2026-08-06-bildweg-kosten.json` hat das
bestaetigt — ohne die Ursache zu klaeren.

## Bauen und laufen lassen

```bash
cd streaming/player-labor/cuvid-cuda-ausgabe
cargo build --release

# Bezugsarm — Byte fuer Byte der Weg, den pulse-player heute geht
SPIKE_DATEI=/pfad/1440p10.mkv SPIKE_HWCTX=0 ./target/release/cuvid-cuda-ausgabe

# der geprueste Weg
SPIKE_DATEI=/pfad/1440p10.mkv SPIKE_HWCTX=1 ./target/release/cuvid-cuda-ausgabe

# ganze Matrix, Arme abwechselnd, drei Runden
RUNDEN=3 BILDER=900 python3 matrix.py /pfad/zum/material
```

Braucht kein CUDA-Toolkit (`libcuda.so.1` kommt mit dem Treiber), keinen
Server, kein Fenster. Rueckgabewert 0 = alle Kontrollen bestanden.

| Schalter | |
|---|---|
| `SPIKE_DATEI` | **Pflicht.** Eine Datei mit AV1- oder H.264-Video. |
| `SPIKE_HWCTX` (`1`) | `0` = kein `hw_device_ctx`, also der heutige Player-Weg |
| `SPIKE_FORMATWAHL` (`roh`) | `standard` / `cuda` — eigener `get_format`-Rueckruf |
| `SPIKE_PRIMAERKONTEXT` (`0`) | `1` = `AV_CUDA_USE_PRIMARY_CONTEXT` |
| `SPIKE_ABHOLEN` (`0`) | **Kontrolle**, jedes Bild ausdruecklich zurueckholen |
| `SPIKE_VERGLEICH` (`0`) | **Kontrolle B**, beide Arme, Inhalte verglichen |
| `SPIKE_ABSTAND_FALSCH` (`0`) | **Gegenprobe**, Urteil ist umgedreht |
| `SPIKE_DECODER` | Decodername erzwingen (sonst nach Codec) |
| `SPIKE_BILDER` (`600`) / `SPIKE_AUFWAERMEN` (`120`) | Messstrecke |
| `SPIKE_LOW_DELAY` (`1`) | wie im Player (`AV_CODEC_FLAG_LOW_DELAY`) |

**Die Kopfzeile des Laufs gilt als Beleg, nicht die eigene Beschriftung.** Jeder
Durchgang gibt aus, mit welcher Schalterstellung er tatsaechlich lief und was
dabei herauskam — Grund unten.

## Was die Probe absichert

Jede Kontrolle faengt eine Fehlerklasse, die in diesem Labor schon einen
falschen Befund erzeugt hat.

* **Kontrolle A — kann der Zeigertest ueberhaupt anschlagen?** Er klassifiziert
  vor jedem Lauf zwei Adressen, deren Lage feststeht: echten Grafikspeicher aus
  `cuMemAlloc` und einen gewoehnlichen `Vec<u8>`. Kommen beide gleich heraus,
  bricht die Probe ab. Ohne sie waere „liegt im Hauptspeicher" nicht von „der
  Test erkennt Grafikspeicher gar nicht" zu unterscheiden.
* **Zwei unabhaengige Quellen, die uebereinstimmen muessen.** Das Pixelformat
  (`cuda` gegen `p010le`) ist FFmpegs eigene Auskunft ueber sich selbst;
  `cuPointerGetAttribute` ist die Auskunft des **Treibers**. Widersprechen sie
  sich, bricht die Probe ab, statt sich eine auszusuchen.
* **Nagelprobe zum Zeiger.** Dass eine Adresse auf der Karte liegt, heisst noch
  nicht, dass `data[0]` und `linesize[0]` als Quelle eines CUDA-Kopierbefehls
  taugen — und genau das braucht der Umbau. Die Probe liest die Y-Ebene
  zeilenweise per `cuMemcpyDtoH` mit dem angegebenen Zeilenabstand aus und
  vergleicht sie Byte fuer Byte mit `av_hwframe_transfer_data`.
* **Gegenprobe dazu:** `SPIKE_ABSTAND_FALSCH=1` verstellt den Zeilenabstand um
  64 Byte. Der Vergleich MUSS dann scheitern. Eine Pruefung, die immer
  zustimmt, ist keine Pruefung.
* **Kontrolle B — haben beide Arme denselben Inhalt?** `SPIKE_VERGLEICH=1`
  faehrt beide nacheinander und vergleicht die ersten Bilder ueber einen
  positionsabhaengigen Fingerabdruck. Eine Adresse auf der Karte, hinter der
  kein Bild steht, waere kein Ergebnis.
* **Kontrolle C — aendert ein gekipptes Bit den Fingerabdruck?** Ohne sie waere
  „alle Abdruecke gleich" nicht von „der Abdruck vergleicht nichts" zu
  unterscheiden.
* **Die schaerfste Kontrolle beim Tempo: `SPIKE_ABHOLEN=1`.** Ein CUDA-Arm, der
  seine Bilder nie anfasst, koennte allein deshalb schneller aussehen, weil
  NVDEC im Hintergrund weiterlaeuft und die Schleife vorauseilt — dann waere der
  Gewinn eine Verschiebung und keine Ersparnis. Mit dem Schalter macht der
  CUDA-Arm genau die Arbeit, die der Bezugsarm ohnehin tut. Landet er dann
  wieder bei dessen Zahlen, ist die Differenz nachweislich die Kopie.
* **`Formatwahl=standard` ist ein Messarm ohne Messung**, naemlich die Trennung
  zweier Ursachen: ein eigener `get_format`-Rueckruf, der die Entscheidung an
  `avcodec_default_get_format` zurueckgibt, darf sich von `roh` nicht
  unterscheiden. Tut er es doch, kaeme ein Befund aus `Formatwahl=cuda` vom
  Rueckruf und nicht von der Formatwahl.
* **Jeder Lauf ein eigener Prozess** (`matrix.py`), Arme abwechselnd,
  Reihenfolge je Runde gedreht, GPU-Takt mitgeschrieben. Der Takt gehoert dazu,
  weil diese Karte laut der Kostenmessung vom 2026-08-06 in einen Sparzustand
  faellt und sich damit alle Posten um ein Vielfaches verschieben.

## Ergebnis

Messakte:
`streaming/testbench/profiles/player-2026-08-07-cuvid-cuda-ausgabe.json`.

**Ja — und es kostet eine Zeile.** `av1_cuvid` und `h264_cuvid` bieten
`AV_PIX_FMT_CUDA` an; gewaehlt wird es, sobald am Decoder-Kontext ein
CUDA-Geraet haengt. Ein eigener `get_format`-Rueckruf ist dafuer **nicht**
noetig. Der Modulkopf von `decode.rs` ist damit ueberholt: die cuvid-Decoder
liefern in den Hauptspeicher, **weil der Player ihnen kein Geraet gibt** — nicht,
weil sie es nicht anders koennten.
