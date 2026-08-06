# HDR-Streaming auf Windows/AMD — was gebaut ist und was gemessen wurde

Maschine: AMD Radeon 780M, Treiber 32.0.31035.1003, Windows 11 26200,
HDR im System eingeschaltet. Schirm meldet 351 cd/m² Spitze, 0,2496 cd/m²
Schwarz, 8 bit je Kanal, Primärvalenzen weiter als BT.709.
Encoder `av1_amf`, FFmpeg n8.1.1 (der ausgelieferte Bau).
Alles hier ist **am fertigen Bitstrom** nachgesehen, nicht am Log des Senders.

## Ergebnis in einem Satz

Der Sidecar sendet HDR: der Strom trägt PQ, BT.2020 und beide HDR10-Metadaten,
und sein Inhalt reicht mit **275 cd/m²** über das hinaus, was SDR darstellen
kann. Der Player kann PQ dekodieren, auf einem HDR-Fenster ausgeben und auf
einem SDR-Schirm herunterrechnen — **die Ausgabe selbst ist noch nicht am
Bildschirm geprüft** (dafür muss jemand hinsehen).

## Die Kette und wo sie hing

| Stufe | Weg | Zustand |
|---|---|---|
| Aufnahme | WGC in `Rgba16F` (scRGB) | läuft |
| Farbwandlung | **eigener Shader**, nicht der Video-Prozessor | läuft |
| Encode | `av1_amf`, 10 bit, BT.2020/PQ | läuft |
| Metadaten | Mastering-Display + Content-Light je Bild | läuft, **Werte falsch** (s. u.) |
| Wiedergabe | PQ im Shader, scRGB-Fenster oder Tone-Mapping | gebaut, **ungeprüft am Schirm** |

## Befund 1: Der Video-Prozessor dieses Treibers kann kein PQ

Der Regelweg für Skalieren und Farbwandlung ist `ID3D11VideoProcessor`
(`encode/d3d11_scale.rs`). Für HDR fällt er aus. Gemessen über
`CheckVideoProcessorFormatConversion`, 32 Kombinationen
(`encode/farbraum.rs::tests::wandlungen_dieses_treibers`, nachfahrbar mit
`cargo test -- --ignored --nocapture wandlungen_dieses_treibers`):

| Eingang | Ausgang | |
|---|---|---|
| `RGBA16F`, **jeder** Farbraum | **jeder** Ausgang, auch SDR | nein |
| `RGB10A2`, sRGB | YCbCr BT.709 SDR | ja |
| `RGB10A2`, G22/BT.2020 | YCbCr BT.2020 SDR | ja |
| alles Übrige, insbesondere **jeder Ausgang mit PQ** | | nein |

Zwei von 32 Kombinationen sind möglich, **keine davon mit PQ**, und
16-Bit-Fließkomma wird am Eingang grundsätzlich abgelehnt. Ein Video-Prozessor,
der weder das Eingangsformat noch die Zielkurve annimmt, ist an dieser Stelle
kein Werkzeug mehr.

**Folge:** `encode/hdr_wandler.rs` rechnet selbst — ein HLSL-Shader, der scRGB
nach cd/m², dann nach BT.2020, dann durch die PQ-Kurve und schließlich nach
YCbCr in die beiden Ebenen von P010 schreibt. Verkleinern macht er gleich mit.
Dasselbe tut GSR auf Linux (`color_conversion.c`), aus demselben Grund.

**Warum das Ziel P010 sein muss und nicht etwas Einfacheres:** `av1_amf` nähme
auch `RGBAF16` oder `X2BGR10` an. Aber `amfenc_av1.c` reicht die
**Transferkurve** nur bei `NV12` oder `P010` an AMF weiter (Bedingung in
Zeile 274). Bei jedem anderen Eingangsformat stünde im Sequenzkopf
„Transferkurve unbekannt" — PQ-Werte ohne den Hinweis, dass es PQ ist.

## Befund 2: Der 10-bit-SDR-Weg hat sich als PQ ausgegeben

**Das war schon vor dieser Arbeit so und ist beim Vergleichslauf aufgefallen.**
Ein 10-bit-Stream ohne HDR meldete:

```
pix_fmt=yuv420p10le  space=bt709  transfer=smpte2084  primaries=unknown
```

Also **PQ**, obwohl gewöhnliches SDR drinsteckt. Ein Zuschauer, der die Angabe
befolgt, zeigt das Bild dadurch massiv zu dunkel.

Ursache: derselbe Zweig in `amfenc_av1.c` Zeile 274 hängt an
`avctx->color_primaries != UNSPECIFIED`. Der Sidecar setzte nur `colorspace`
und `color_range`, nicht die Primärvalenzen — der Zweig wurde übersprungen, und
AMF nimmt für 10 bit von sich aus PQ an. **Es genügt nicht, nichts zu
behaupten; man muss BT.709 ausdrücklich sagen.** Behoben in `encoder_hw.rs`;
seither meldet derselbe Lauf `transfer=bt709 primaries=bt709`.

Der 8-bit-Weg ist nicht betroffen (dort ist AMFs Vorgabe BT.709) und bewusst
unangetastet geblieben.

## Befund 3: Die Mastering-Metadaten kommen mit falschen Zahlen an

Sie sind **da** — beide Blöcke, an jedem Bild —, aber die Werte stimmen nicht:

| Feld | gesendet | im Strom | Faktor |
|---|---|---|---|
| Rot x | 0,6855 | 34277/65536 = 0,523 | 65536/50000 |
| Weißpunkt x | 0,3135 | 15673/65536 = 0,239 | 65536/50000 |
| Spitzenhelligkeit | 351,3 cd/m² | 3512764/256 = 13721 cd/m² | 256/10000 |
| Schwarzwert | 0,2496 cd/m² | 2496/16384 = 0,152 cd/m² | 16384/10000 |
| **MaxCLL** | **351** | **351** | **stimmt** |

Das Muster ist überall dasselbe: die Zahl, die in HDR10-Einheiten stimmt,
landet unverändert in einem AV1-Feld mit anderer Skala (AV1 nutzt 0.16- bzw.
24.8-Festkomma, HDR10 die Nenner 50 000 und 10 000). FFmpegs `amfenc` übergibt
korrekt nach AMFs Vertrag; **AMF rechnet beim Schreiben des AV1-Metadaten-OBU
nicht um.** Content-Light-Level ist nicht betroffen, weil es in beiden
Normen schlicht cd/m² sind.

**Bewusst NICHT vorkompensiert.** Man könnte unsere Werte vorher durch die
Faktoren teilen, damit sie nach AMFs Fehlinterpretation richtig landen. Dann
wären unsere Ströme aber genau in dem Moment falsch, in dem ein Treiber-Update
den Fehler behebt — und das würde niemandem auffallen. Die wichtige
Signalisierung (Kurve, Primärvalenzen, Matrix im Sequenzkopf) ist korrekt; die
Mastering-Angaben sind Hinweise für das Tone-Mapping des Zuschauers, kein
Bestandteil der Bilddeutung. Der eigene Player liest ohnehin zuerst MaxCLL
(`decode.rs::spitze_nits_von`), und das stimmt.

## Befund 4: Der Inhalt ist wirklich HDR, nicht nur so beschriftet

Das ist die Frage, an der die ganze Übung hängt — eine SDR-Aufnahme mit
PQ-Etikett sähe in jeder Kennzahl gesund aus. Gemessen an Bild 45 desselben
Bildschirminhalts, einmal ohne und einmal mit HDR (`signalstats`, 10-bit-Codes):

| | SDR-Lauf | HDR-Lauf |
|---|---:|---:|
| Y max | 968 | 601 |
| Y Mittel | 124,6 | 193,9 |
| Y min | 0 | 0 |

Der SDR-Lauf **klemmt oben an** (968 liegt über dem nominellen Weißpunkt 940).
Der HDR-Lauf tut das nicht: seine Spitze liegt bei Code 601, und durch die
PQ-Kurve zurückgerechnet sind das **275 cd/m²** — plausibel für diesen Schirm
(er meldet 351 als Maximum). Das Mittel entspricht 0,96 cd/m², also ein
überwiegend dunkler Desktop.

Wäre die PQ-Kurve nicht angewandt worden, läge die Spitze bei 940–1023. Sie
liegt bei 601. **Der Shader rechnet also wirklich.**

## Was der Player tut — gebaut, nicht am Schirm geprüft

* `decode.rs` liest Transferkurve, Primärvalenzen und Spitzenhelligkeit aus dem
  Strom (MaxCLL zuerst, Mastering-Display als Ersatz) statt sie zu raten.
* Der Shader bekam die BT.2020-Matrix (eigene Koeffizienten, nicht die von
  BT.709), die PQ-Kurve rückwärts, die Farbraumwandlung nach BT.709 und ein
  Tone-Mapping (erweitertes Reinhard, Bezug Diffusweiß 203 cd/m² nach
  ITU-R BT.2408).
* Das Fenster stellt auf `Rgba16Float` und meldet scRGB an, **wenn** der Strom
  HDR ist, das Format angeboten wird und der Schirm in HDR läuft. Sonst wird
  heruntergerechnet.
* **Der Player läuft unter Windows jetzt über D3D12 statt Vulkan.** Das ist
  Voraussetzung, keine Vorliebe: nur dort lässt sich der Farbraum des Fensters
  anmelden (`IDXGISwapChain3::SetColorSpace1`). Unter Vulkan ist er eine
  Eigenschaft der Swapchain, wird beim Anlegen gesetzt und ist von außen weder
  zu setzen noch zu prüfen. `PULSE_PLAYER_BACKEND=vulkan` holt den alten Weg
  zurück. Nachgesehen: das Fenster geht auf, D3D12 bietet `Rgba16Float` an.

## Befund 5: Das Gruen war KEIN Farbfehler — der Einfrier-Waechter war es

> **Der Abschnitt darunter ist die Fassung von vormittags, und seine Deutung war
> falsch.** Er bleibt stehen, weil der Weg dorthin lehrreich ist. Was wirklich
> los war, steht hier.

**Das Bild blieb stehen, dann lag eine halbtransparente gruene Flaeche darueber,
durch die der Inhalt noch zu sehen war. Danach verschwand sie, spaeter kam sie
wieder.** Diese Beschreibung ist die Signatur eines halb leeren Bildes: die
Helligkeitsebene traegt noch das alte Bild, die Farbebene steht auf null. Y
sichtbar, U und V null — das ergibt in JEDER Matrix kraeftiges Gruen, und weil
Y erhalten bleibt, wirkt es wie ein Schleier statt wie eine Flaeche.

**Der Ausloeser stand die ganze Zeit im Log**, in beiden Laeufen:

```
pulse-player: Decoder eingefroren (gleiches Bild trotz Daten)
              — leere ihn und fordere ein Vollbild an
```

Der Waechter schlaegt an, leert den Decoder und fordert ein Vollbild. Genau in
dieser Erholungsphase entsteht das halb leere Bild. Danach laeuft es weiter, bis
er wieder anschlaegt — „kommt und geht", wie beobachtet.

**Und der Fehlalarm ist auf `main` behoben, nur nicht in diesem Zweig gewesen:**
`f92bd8c4` („der Einfrier-Fehlalarm ist ein Einheitenfehler — das Fenster zaehlt
Bilder, der Takt laeuft in Sekunden") kam auf `main`, **nachdem** dieser Zweig
abgezweigt war. Am 2026-08-06 nachgeholt.

**Was daran lehrreich ist, ueber diesen Fall hinaus:**

* **Die Gegenprobe hat es entschieden, nicht die Vermutung.** Der SDR-Lauf mit
  denselben Einstellungen zeigte dasselbe Verhalten. Damit war HDR als Ursache
  aus, bevor eine einzige Zeile Shader-Code angesehen war.
* **Das Wort des Beobachters trug die Loesung.** „Gruenstichig" fuehrte zwei
  Runden lang in die Farbrechnung; „halbtransparente Flaeche, Inhalt noch
  sichtbar" fuehrte in einem Satz zur Ursache. Wer ein Bild beurteilt, soll
  beschreiben, WIE es falsch ist, nicht nur DASS.
* **Ein Zweig, der ueber Nacht entsteht, ist am naechsten Morgen veraltet.**
  Zwei Commits auf `main` genuegten, und einer davon war die Behebung genau des
  Fehlers, den wir dann suchten.

## Befund 5a (ueberholt): „Das Bild ist gruenstichig — und die Verrohrung ist es nicht"

Am 2026-08-06 zum ersten Mal angesehen (`testbench/hdr-ansehen.ps1`, Sender und
Player auf derselben Maschine ueber den Hetzner-Messstand). **Das Bild kommt
an, ist aber gruen eingefaerbt.**

**Was dabei NACHWEISLICH funktioniert** — das schraenkt die Suche stark ein:

```
pulse-player: Oberflaechenformat Rgb10a2Unorm auf AMD Radeon 780M (Dx12)
pulse-player: Decoder av1 (Hardware (D3D11VA))
pulse-player: Farbraum des Fensters: scRGB (lineares Licht, 1,0 = 80 cd/m²)
pulse-player: Farbwelt des Stroms HDR (PQ) -> Fenster HDR (Rgba16Float)
```

Also: der Formatwechsel zur Laufzeit, die Anmeldung des Farbraums ueber D3D12,
die Erkennung der PQ-Kurve am Strom und die Hardware-Dekodierung. Das waren die
unsicheren Stuecke, und sie tragen alle.

**Wo der Fehler NICHT sein kann:** in der Senderseite (am Bitstrom vermessen,
Befund 4) und im SDR-Weg des Players (unveraendert, seit Langem in Betrieb).
Es bleibt der neue Zweig im Player-Shader: PQ aufloesen, BT.2020 nach BT.709,
oder die scRGB-Skalierung.

**Was NICHT die Ursache sein kann, obwohl es naheliegt:** fehlendes Chroma. Das
ist die klassische Erklaerung fuer Gruen (Cb/Cr auf null statt neutral), passt
hier aber nicht: der Strom traegt UAVG 529,8 und VAVG 531,7 bei einem neutralen
Wert von 512 — Chroma ist also da und nahezu neutral. Und die drei Zeilen der
BT.2020-Matrix summieren sich je auf 1,0, ein neutraler Eingang bliebe damit
neutral.

**Die billigste Halbierung zuerst** (ein Kommando, kein Neubau):

```powershell
$env:PULSE_PLAYER_TRANSFER = 'sdr'   # Strom als SDR behandeln
```

Verschwindet der Gruenstich damit, sitzt der Fehler im neuen PQ-Zweig. Bleibt
er, liegt er davor — dann in der YUV-Matrix oder im Codewert-Massstab, und
`PULSE_PLAYER_MATRIX=709` grenzt weiter ein. Genau dafuer gibt es diese
Variablen.

**Offen bleibt ausserdem:** ob das Herunterrechnen auf einen SDR-Schirm
ordentlich wirkt. Ungeprueft, weil der erste Blick schon am HDR-Weg haengen
blieb.

## Nebenbefunde

* **ffprobes JSON-Ausgabe verschweigt die Begleitdaten.**
  `-show_entries frame=side_data_list -of json` liefert die Liste mit **leeren**
  Objekten — Typ und Werte fehlen. Das sieht aus wie „keine Metadaten im Strom"
  und hat hier einen Fehlalarm erzeugt. `-show_frames -of flat` zeigt alles.
* **Der Strom meldet 1082 statt 1080 Zeilen** — im SDR- wie im HDR-Lauf, also
  unabhängig von dieser Arbeit. Nicht verfolgt.
* **PowerShell-Skripte in diesem Repo müssen reines ASCII sein.** Windows
  PowerShell 5.1 liest `.ps1` ohne BOM als ANSI; ein UTF-8-Gedankenstrich wird
  dabei zu drei Zeichen, von denen das letzte ein typografisches
  Anführungszeichen ist — und das zählt für den Parser als Zeichenketten-Grenze.
  Der Fehler erscheint als „Zeichenfolge hat kein Abschlusszeichen" **am Ende
  der Datei**, also weit weg von der Ursache. Die bestehenden Skripte hier sind
  aus genau diesem Grund durchgehend ASCII.

## Reproduzieren

```powershell
cd streaming\win-hq-sidecar
cargo build --release --bins
cd ..\win-hq-labor\testbench
powershell -ExecutionPolicy Bypass -File .\hdr-nachweis.ps1
```

Läuft HDR im System nicht, verweigert der Sidecar den Start und sagt warum —
das ist der erwartete Ausgang, kein Fehler des Skripts.

Die Treiber-Tabelle aus Befund 1:

```powershell
cd streaming\win-hq-sidecar
cargo test -- --ignored --nocapture wandlungen_dieses_treibers
```

Was der eigene Schirm meldet:

```powershell
cargo test -- --ignored --nocapture schirm_der_maschine
```
