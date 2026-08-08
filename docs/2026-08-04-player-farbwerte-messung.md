# Was der native Player wirklich ausgibt — gemessen statt nachgerechnet (2026-08-04)

Maschine: Radeon 780M (RADV PHOENIX), Vulkan, KWin/Wayland, Mesa 26.1.5.
Werkzeug: `pulse-player --stufen` (neu, `streaming/pulse-player/src/messen/`).
Quelle: `dec_cbr8M_10bit.yuv` — das Graustufen-Testbild
(`streaming/testbench/graustufen-testbild.py`) durch die echte 10-bit-Kette.

## Anlass: eine Zahl, die nicht gemessen war

In der Nacht davor stand als Befund im Raum, der Player gebe „41 von 41 Stufen"
durch, auf einer 8-bit-Oberfläche wären „nur 13 übrig geblieben". Beide Zahlen
stammten aus einer numpy-Nachrechnung, die **nur die Farbmatrix** nachbildete.
Der Shader hat aber vier Stufen:

```
YUV -> RGB  ->  Deband  ->  (Ausgabe)  ->  Dither
```

Deband (Vorgabe **0.6**) und Dither (Vorgabe **an**, beides `proto.rs`) fehlten
in der Rechnung. Gemessen war damit eine Einstellung, die der Player nie fährt.

Konsequenz für den Prüfstand: Der Messpfad benutzt **dieselbe** Pipeline wie das
Fenster — `render::setup::build_graphics`, derselbe `shader.wgsl`, derselbe
Uniform-Block, nur ohne Swapchain. Ein Nachbau hätte den Nachbau gemessen.

## Ergebnis 1: die Behauptung stimmt nur für eine Einstellung, die es nicht gibt

Band 4 des Testbilds (flacher Verlauf, volle 10-bit-Feinheit): 41 Luma-Werte.

| Ausgabe | Einstellung | Stufen | Spaltenmittel | max. Sprung |
|---|---|---:|---:|---:|
| Rgb10a2Unorm | roh (kein Deband/Dither) | 41 | 41 | 2,00 LSB |
| Bgra8Unorm | roh | **12** | 12 | 4,01 LSB |
| Rgb10a2Unorm | **Vorgabe** (0.6 / an) | 48 | 144 | 0,69 LSB |
| Bgra8Unorm | **Vorgabe** | 14 | **158** | 1,24 LSB |

*Stufen* = verschiedene Codewerte. *Spaltenmittel* = verschiedene Spaltenmittel
über 100 Zeilen, auf 1/4096 gerundet — das, was das Auge über die Fläche
integriert, und der einzige der drei Werte, der Dither richtig bewertet.
*max. Sprung* zwischen benachbarten Spaltenmitteln, in 10-bit-Stufen; das ist
die Größe einer sichtbaren Kante.

Zwei Korrekturen an der alten Aussage:

* **„13" war 12.** Die Nachrechnung kam auf 13, gemessen sind es 12. Die
  Differenz führte auf einen echten Fehler (s. u.), nicht auf Rundung.
* **Der Vergleich war der falsche.** Ohne Dither springt eine 8-bit-Oberfläche
  in Vierer-Schritten (4,01 LSB) — sichtbares Banding. **Mit** Dither, also so,
  wie der Player zeichnet, bleibt sie bei 1,24 LSB und trägt sogar mehr
  verschiedene Spaltenmittel als die 10-bit-Oberfläche (158 gegen 144). Der
  Gewinn der 10 bit ist der **halb so große Sprung** (0,69 gegen 1,24 LSB) und
  dass er ohne Rauschen zustande kommt — nicht „41 statt 13 Stufen".

Die Wahl `Rgb10a2Unorm` vor `Bgra8Unorm` bleibt richtig. Nur ist ihr Gewinn
kleiner und anders begründet, als bisher aufgeschrieben.

## Ergebnis 2: zwei echte Fehler im Shader, gefunden über die Differenz

Die 12 gegen 13 ließ sich nicht wegrunden. Kontrollversuch mit drei bekannten
Luma-Werten und Chroma auf 511 / 512 / 513 (512 = neutral):

| Chroma | gemessene Rot-Codes | Deutung |
|---|---|---|
| 511 | 482, 507, 529 | ein Chroma-Code = ~1,9 Stufen Rot |
| **512 (neutral)** | **484, 508, 531** | müsste bei neutralem Chroma auf dem Luma-Wert liegen |
| 513 | 486, 510, 533 | |

Bei neutralem Chroma war die Ausgabe also nicht neutral. Ursache:

1. **Der Chroma-Nullpunkt war 0.5.** Neutral ist aber Code 128 von 255
   (= 0,50196), in 10 bit Code 512 von 1023 (= 0,50049) — ein **halber
   Chroma-Code** daneben. Auf Grau ergab das (BT.709) R +0,9, G −0,37,
   B +1,06 Stufen: ein durchgehender leichter Blaustich über die ganze Fläche.
2. **Die Luma-Konstanten waren 8-bit-Konstanten.** `(y − 16/255) × 255/219`
   stimmt für 8 bit; bei 10 bit ist Schwarz 64/1023 = 0,062561, nicht
   16/255 = 0,062745. Am Weißpunkt fehlten dadurch 3 von 1023 Stufen.

Beides ist derselbe Wurzelfehler — 8-bit-Konstanten auf anders normierte
Abtastwerte —, und beides verschwindet mit einem Maßstab im Uniform-Block:
`u.output.z` = wieviele **8-bit-äquivalente Codewerte** auf normiert 1.0 gehen
(255 bei 8-bit-Texturen, 255,75 bei planarem 10 bit, 255,996 bei P010;
`render::code_scale`, direkt neben `sample_scale`, weil es dieselbe Fallunter-
scheidung ist).

Gegenprobe an den Eckpunkten des begrenzten Wertebereichs (10-bit-Quelle,
Ausgabe `Rgb10a2Unorm`):

| Luma | Soll | vorher | nachher |
|---|---:|---:|---:|
| 64 (Schwarz) | 0 | 0 | **0** |
| 502 (Mitte) | 511,5 | 510 | **511** |
| 940 (Weiß) | 1023 | 1020 | **1023** |

Und mit neutralem Chroma liegt Rot jetzt exakt auf dem Luma-Wert (Y=479 →
`(479−64)/876 × 1023` = 484,6 → gemessen 485; vorher 484 bei einem
Rechenwert von 483,0 — die alte Messung lag durch die zwei Fehler zufällig
näher an der falschen Zahl als an der richtigen).

**Für 8-bit-Quellen ändert sich Luma nicht** (dort ist der Maßstab 255, die
Formel damit identisch); es verschwindet nur der Blaustich. Betroffen ist also
jeder Stream — GSR liefert NV12.

## Was der Befund NICHT ändert

* Die Kette davor bleibt, wie sie war: die Bildschirmaufnahme gibt 8 bit heraus
  (KWin liefert `XR24`, gemessen 2026-08-04), der AMD-VAAPI-Encoder trägt 10 bit
  (41 Werte gegen 11 im 8-bit-Lauf).
* `TEXTURE_FORMAT_16BIT_NORM` ist auf dieser Karte vorhanden — 10-bit-Quellen
  werden nicht beim Hochladen gekappt. Das war richtig und ist jetzt am
  zurückgelesenen Bildpunkt belegt statt an einer Feature-Abfrage.

## Die echte Swapchain — nachgereicht am selben Tag

Die Tabellen oben entstehen offscreen. Die Frage, ob KWin dem Fenster
tatsächlich mehr als 8 bit gibt, ist danach separat geprüft: Player mit einer
nicht erreichbaren URL starten, das Format wird beim Fensteraufbau verhandelt
und protokolliert, bevor irgendeine Verbindung steht.

```
pulse-player: Oberflaechenformat Rgb10a2Unorm
  (angeboten: [Rgba8UnormSrgb, Bgra8UnormSrgb, Rgb10a2Unorm,
               Rgba8Unorm, Bgra8Unorm, Rgba16Unorm, Rgba16Float])
```

Gewöhnliche SDR-Sitzung, **HDR ausgeschaltet**. KWin bietet sieben Formate an,
drei davon über 8 bit; die Wahl fällt auf `Rgb10a2Unorm`. Damit trägt die
Anzeigekette durchgehend 10 bit — Decoder (P010) → 16-Bit-Texturen → Shader →
Oberfläche.

Nebenbefund, der die Begründung des ganzen Players stützt: Chromium legt seinen
Wayland-Puffer als `ABGR8888` an (gemessen 2026-07-26), **obwohl daneben drei
präzisere Formate angeboten werden**. Das ist Chromiums Wahl, nicht die Grenze
des Systems — jetzt mit der Angebotsliste belegt statt nur behauptet.

## Offen

* **Gemessen wird bis zur Textur bzw. bis zur Oberfläche, nicht bis zum Schirm.**
  Was der Compositor danach mit einem `Rgb10a2Unorm`-Puffer macht — eigener
  Scanout-Weg oder Zusammensetzen in einen 8-Bit-Puffer —, steht hier nicht drin.
* **Die Aufnahme in HDR ist ungeprüft.** Der Versuch lief am 2026-08-04 an: HDR
  war eingeschaltet und `capture_smoke` gebaut, der Portal-Dialog braucht aber
  einen Klick, und der Durchlauf wurde vorher abgebrochen (HDR danach wieder
  ausgeschaltet). Die Frage bleibt damit die vom 2026-07-26: gibt KWins
  ScreenCast 10 bit heraus, wenn es 10 bit HAT? Der Befund vom 2026-08-04
  („KWin gibt kein 10 bit heraus") ist gegen einen SDR-Desktop entstanden, also
  gegen eine Lage, in der 8 bit die richtige Antwort ist — er unterscheidet
  **nicht** zwischen „kann nicht" und „hatte nichts anzubieten".
* **Nur AMD/RADV.** Auf NVIDIA ungeprüft; der Aufruf kostet ein Kommando.
* **Verstärkung und Nullpunkt ließen sich auf der CPU vorberechnen.** Der
  Shader rechnet `128.0/k` und `*k` je Aufruf, und `yuv_to_rgb` läuft fünfmal
  je Bildpunkt (einmal direkt, viermal aus `deband`). Vier fertige Zahlen im
  Uniform-Block sparen die Division und zwei Verzweigungen — der Shader würde
  damit billiger als vor dieser Änderung. **Bewusst nicht gemacht:** der
  Zuwachs liegt unter einem Prozent des Shader-Budgets (daneben stehen 15
  Texturabtastungen und 3 `sin` je Bildpunkt), und die Farbkonstanten stünden
  dann nicht mehr dort, wo sie erklärt sind.
* **Der Weg über `PULSE_PLAYER_SURFACE=bgra8srgb`** ist weiterhin
  doppelt-kodiert: `surface_is_linear` nennt nur `Rgba16Float`, bei einem
  `*UnormSrgb`-Ziel kodiert aber zusätzlich die Hardware. Das Format steht
  nicht in `FORMAT_PREFERENCE`, ist also nur über die Diagnose-Variable
  erreichbar — unangetastet gelassen, aber es ist eine Falle.

  **Erledigt am 2026-08-08** (Befund 29 des vierten Bughunts): `surface_is_linear`
  liefert jetzt auch für `*_SRGB` `true`, der Shader linearisiert also und die
  ROP kodiert genau einmal. Gemessen wurde die Falle vorher am Graukeil —
  Luma-Code 200 (10 bit) landete nach `Bgra8Unorm` bei 0,1569, nach
  `Bgra8UnormSrgb` bei 0,4314 = `srgb_kodieren(0,1553)`. Der Nachweis steht als
  `messen::farbwerte::tests::repro_29_srgb_ziel_wird_doppelt_kodiert` im Baum.

## Nachgetragen am 2026-08-06: derselbe Prüfstand trägt jetzt auch HDR

Der Messpfad hat hier ausdrücklich SDR gefahren, mit der Begründung, ein
HDR-Lauf brauche eine eigene Fragestellung (welche **Helligkeiten** kommen an,
nicht welche Codewerte) und eine PQ-Quelle. Beides ist am 2026-08-06 eingelöst:
`pulse-player --farbwerte` bringt seine PQ-Quelle mit und prüft beide Ausgänge
gegen unabhängig aus den Normen gerechnete Sollwerte
(`streaming/testbench/profiles/player-2026-08-06-hdr-farbweg.json`). Die
Farbwelt steckt seither im `Lauf`, nicht mehr fest im Messstand — die
Stufenmessung hier bleibt davon unberührt und liefert dieselben Zahlen.

## Reproduzieren

```bash
cd streaming/pulse-player
cargo build
./target/debug/pulse-player --stufen <datei.yuv> --breite 2560 --hoehe 1440 --bild 50 [--werte]
./target/debug/pulse-player --farbwerte     # HDR-Farbweg, braucht keine Datei
```

Die Datei ist ein roher `yuv420p10le`-Strom
(`ffmpeg -i … -pix_fmt yuv420p10le -f rawvideo …`). Das passende Testbild
erzeugt `streaming/testbench/graustufen-testbild.py`.
