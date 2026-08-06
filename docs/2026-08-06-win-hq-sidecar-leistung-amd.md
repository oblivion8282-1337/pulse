# Leistung des Windows-HQ-Sidecars auf AMD — eine Code-Durchsicht

**Datum:** 2026-08-06 · **Zweig:** `feat/hdr-windows-amd` · **Bereich:** Sendeseite
(`streaming/win-hq-sidecar/`), Aufnahme bis Paketabgabe. Der Zuschauer
(`streaming/pulse-player/`) ist hier nicht Gegenstand.

**Maschine, um die es geht:** Windows 11, Radeon 780M (integriert, teilt sich die
Leistungsaufnahme mit der CPU), Treiber 32.0.31035.1003, HDR am Schirm an.

> **Nachtrag vom selben Tag, abends: Befund 1 und 2 sind behoben und gemessen.**
> Bei stehendem Bild entfällt die Wandlung jetzt vollständig (3D-Einheit des
> Senders **14,2 → 0,4 %**, drei Paare abwechselnd), in der laufenden Kette
> sinkt sie um rund **18 %**. Der Chroma-Durchgang mittelt in linearem Licht und
> rechnet den Farbweg einmal statt viermal; farblich ist das auf Flächen, Text,
> Grau und Spitzlichtern **bitgleich** und weicht nur an gesättigten Farbkanten
> ab (Rot gegen Blau: 28,7 von 1023 Codewerten). **Der in §3 benannte
> ungeprüfte Fallstrick war echt** — `av_frame_new_side_data` hängt an, statt zu
> ersetzen; ohne Abhilfe wären die Begleitdaten bei stehendem Bild unbegrenzt
> gewachsen. Zahlen, Verfahren und Vorbehalte:
> `streaming/testbench/profiles/leistung-2026-08-06-vier-befunde.json`.
> Die drei überholten Behauptungen aus §9 sind ebenfalls berichtigt; §5 (die
> fp16-Zwischenkopie) und §6.1 stehen weiter offen — nach der Messung ist §5
> jetzt der größte verbliebene Posten.

## Was diese Durchsicht ist — und was sie ausdrücklich nicht ist

Der Auftrag lautete zunächst auf Messungen und wurde während der Arbeit geändert:
**die GPU sollte nicht belastet werden.** Es ist deshalb **kein einziger Stream
gelaufen**, weder über Netz noch in eine Datei; der Sidecar wurde nicht gestartet.
Grundlage sind ausschließlich der Quelltext, die Begründungen an den Werten und
die vorhandenen Messakten unter `streaming/testbench/profiles/`.

Daraus folgt eine Regel für dieses Dokument, die für jeden einzelnen Punkt gilt:

* **Übernommene Zahl** — steht mit Quelle (Messakte oder Code-Kommentar) dabei.
* **Gerechnete Zahl** — Bytezählung aus Formaten und Auflösungen, als
  „gerechnet" gekennzeichnet. Sie sagt, wie viel Speicherverkehr entsteht, und
  **nicht**, wie viele Millisekunden das kostet.
* **Geschätzte Zahl** — gibt es hier nicht. Wo etwas unbekannt ist, steht
  „ungemessen", nicht eine Hausnummer.

Die Unterscheidung ist keine Förmlichkeit: eine geschätzte Zahl, die wie eine
gemessene aussieht, ist in diesem Projekt schon zweimal teuer geworden.

## Kurzfassung

Die Verzögerung der Sendeseite wird von **zwei** Posten beherrscht, und beide
sind bekannt und belegt: AMF hält ein Bild zurück (rund ein Bildabstand,
17,2 ms bei 60 fps), und der Taktgeber lässt ein fertiges Aufnahmebild bis zum
nächsten Tick liegen (0 bis 16,7 ms, im Mittel 8,3). Zusammen sind das etwa
25 ms, bevor das erste Byte den Encoder verlässt. **An beiden ist mit einer
kleinen Änderung nichts zu holen** — der einzige belegte Hebel auf beide ist die
**Bildrate**.

Die **Last** dagegen trägt zwei Posten, die man am Code sieht und die beide reine
Verschwendung sind:

1. **Bei stehendem Bild wird jedes Bild neu umgerechnet**, obwohl sich die Quelle
   nicht geändert hat und das Ergebnis bitgleich ist. Betrifft HDR und SDR
   gleichermaßen.
2. **Der HDR-Shader rechnet den kompletten Farbweg zweimal je Bildpunkt** — der
   Chroma-Durchgang wiederholt exakt die Arbeit, die der Luma-Durchgang an
   denselben vier Stellen schon getan hat.

Beides ist klein zu beheben, beides ist am Code belegt, und beides zahlt auf
einer integrierten Grafikeinheit doppelt.

**Der billigste nächste Schritt ist trotzdem keine Änderung, sondern eine
Ablesung** — s. Abschnitt „Was zuerst zu tun ist".

---

## 1. Wohin die Zeit geht

Die Kette eines Bildes, von der Aufnahme bis zum abgegebenen Paket:

| Stufe | Wo im Code | Beitrag | Herkunft der Zahl |
|---|---|---|---|
| WGC liefert das Bild | `capture/wgc_hw.rs::on_frame_arrived` | ungemessen | — |
| Kopie in den Aufnahme-Pool | `wgc_hw.rs::copy_into_pool` | ungemessen (asynchroner GPU-Befehl) | — |
| **Warten auf den nächsten Tick** | `pipeline_hw/mod.rs:331-341` | **0 … 16,7 ms, im Mittel 8,3** | folgt aus der festen Kadenz, s.u. |
| Farbwandlung / Verkleinerung | `encode/hdr_wandler.rs` bzw. `d3d11_scale.rs` | **ungemessen** (HDR-Weg), im Monitor als `conv` sichtbar | — |
| **AMF hält ein Bild zurück** | `encode/encoder_hw.rs::send_avframe` | **17,2 ms** bei 60 fps, 8,9 bei 120 | `encode/codec.rs::amd_forces_d3d12`, Messung 2026-07-30 |
| Einreihen an den Abgabe-Faden | `encode/senke_writer.rs` | ~0, sonst Rückstau | Bauart: eigener Faden |
| Paketieren + Senden | `whip/mod.rs`, `whip/av1.rs` | nicht im Taktfaden | Bauart |

**Der Tick-Wartepunkt, hergeleitet.** Der Taktfaden schläft bis `next_tick`,
holt dann alle wartenden Aufnahmebilder ab und behält nur das neueste
(`pipeline_hw/mod.rs:349-378`). Ein Bild, das eine Haarspitze nach einem Tick
fertig wird, liegt bis zum nächsten — einen vollen Bildabstand. Ein Bild, das
kurz davor fertig wird, geht sofort. Über die Zeit ist das gleichverteilt, also
ein halber Bildabstand im Mittel. Das ist kein Fehler, sondern der Preis der
festen Kadenz, und die feste Kadenz ist nötig, weil WGC änderungsgetrieben ist
(bei stehendem Bild liefert es gar nichts, und ohne eigenen Takt stünde der
Strom still).

**Die AMF-Zurückhaltung ist der größte Einzelposten und bewusst gekauft.** Der
frühere Weg `h264_d3d12va` war mit 6,8 ms zweieinhalbmal latenzärmer; er wurde am
2026-08-04 zugunsten eines einzigen Encode-Weges aufgegeben. Die Begründung steht
an `amd_forces_d3d12` in `encode/codec.rs` und ist tragfähig, aber sie hat einen
Preis, und der ist heute rund **10 ms**.

**Für den HDR-Fall gibt es diese Wahl allerdings gar nicht** — und das ist ein
Punkt, der beim Abwägen leicht untergeht:

* `av1_d3d12va` liefert auf dieser Hardware einen Bitstrom, den kein Decoder
  liest (`pipeline_d3d12::run`).
* HDR verlangt 10 Bit, 10 Bit verlangt AV1 (`codec.rs::supports_ten_bit`), und
  HDR trägt heute allein `av1_amf` bis in den Strom (`encode/hdr.rs::traegt_hdr`).

Wer über HDR spricht, spricht also über AMF, und die 17,2 ms sind dort keine
Entscheidung, sondern eine Randbedingung. Zur Disposition steht der D3D12-Weg
allein bei **H.264 ohne HDR** — dort wären 10 ms zu holen, gegen rund die
zweieinhalbfache Last der Video-Engine (25,4 gegen 10,5 Prozent, dieselbe
Messung; die Last-Zahl trägt dort den Vorbehalt, dass sie vor dem
Einzeltextur-Fix entstand).

**Der einzige Hebel auf beide großen Posten ist die Bildrate.** Bei 120 statt
60 fps sinkt die AMF-Zurückhaltung auf 8,9 ms und der mittlere Tick-Wartepunkt
auf 4,2 ms — zusammen rund **12 ms weniger**, ohne eine Zeile Umbau. Bezahlt wird
das mit der doppelten Zahl an Encode- und Wandlungsvorgängen je Sekunde. Auf
einer integrierten Grafikeinheit ist das nicht umsonst; die beiden Befunde unter
Punkt 3 und 4 unten würden einen Teil davon wieder hereinholen.

## 2. Wohin die Last geht

Die folgenden Zahlen sind **gerechnet**, nicht gemessen: sie ergeben sich aus
Bildformat, Auflösung und der Zahl der Durchgänge im Code. Beispiel ist der Fall,
mit dem auch die vorhandenen Messakten arbeiten — Aufnahme 2560×1440, Ausgabe
1920×1080, 60 fps.

Ein Bildpunkt der Aufnahme ist bei HDR **8 Byte** (`Rgba16F`, scRGB) statt
4 (`Bgra8`) — s. `capture/mod.rs::bildformat`. Ein Aufnahmebild ist damit
29,5 MB statt 14,7. Das Encoder-Bild (P010, 1080p) ist 6,2 MB.

| Durchgang | Lesen | Schreiben | wo |
|---|---|---|---|
| Kopie in den Aufnahme-Pool | 29,5 MB | 29,5 MB | `wgc_hw.rs::copy_into_pool` |
| Luma-Durchgang des Shaders | ~29,5 MB | 4,1 MB | `hdr_wandler.rs::ps_luma` |
| **Chroma-Durchgang des Shaders** | **~29,5 MB** | 2,1 MB | `hdr_wandler.rs::ps_chroma` |
| Encoder liest das Bild | 6,2 MB | — | AMF |
| **Summe je Bild** | **~95 MB** | **~36 MB** | |

Rund **130 MB je Bild**, bei 60 Bildern also grob **7,8 GB/s** Speicherverkehr —
auf einer integrierten Einheit über denselben Bus, an dem die CPU hängt.

Zum Vergleich, gleiche Auflösungen in SDR (Kopie 29,5 MB, Video-Prozessor liest
14,7 und schreibt 8,3, Encoder liest 8,3): rund **60 MB je Bild**, also
**3,6 GB/s**. **Der HDR-Weg kostet damit rund das 2,2-fache an Bandbreite** — je
zur Hälfte aus dem doppelt so breiten Aufnahmeformat und aus dem zweiten
Shader-Durchgang.

Die Rechnung ist eine obere Schranke für die Texturseiten: der Texturcache
bedient benachbarte Bildpunkte mehrfach, die tatsächlichen Zugriffe auf den
Speicher liegen darunter. Die Größenordnung und vor allem das **Verhältnis**
zwischen den Zeilen bleiben davon unberührt, und darauf kommt es hier an.

---

## 3. Befund 1 — bei stehendem Bild wird jedes Bild neu umgerechnet

**Der größte Einzelposten, der sich am Code zeigen lässt.**

**Wo.** `streaming/win-hq-sidecar/src/pipeline_hw/mod.rs`, Zeilen 421-441.

Der Taktfaden zählt in `captured`, wie viele frische Aufnahmebilder dieser Tick
gebracht hat. Bringt er keines (stehendes Bild — WGC ist änderungsgetrieben und
liefert dann gar nichts), bleibt `last_frame` unverändert stehen; das ist die
gewollte Bild-Duplizierung. **Die Vorstufe läuft trotzdem:**

```rust
if let Some(frame) = last_frame.as_mut() {
    match &mut *scaler {
        Some(s) => {
            let mut scaled = s.verarbeiten(frame, |ziel| encoder.vor_dem_schreiben(ziel))?;
            encoder.send_hw(&mut scaled, pts)?;
        }
        None => encoder.send_hw(frame, pts)?,   // ← der Weg OHNE Vorstufe macht es richtig
    }
```

`captured` steht zu diesem Zeitpunkt schon fest und wird nicht gefragt. Aus einer
unveränderten Quelltextur entsteht also ein bitgleiches Zielbild — jedes Mal neu.

**Was das kostet.** Bei HDR der ganze Shader: rund **65 MB Speicherverkehr je
Tick** (gerechnet, s. Abschnitt 2) plus die Rechenarbeit, für ein Ergebnis, das
schon dalag. Bei SDR mit Verkleinerung derselbe Sachverhalt über den
Video-Prozessor — billiger, aber nicht umsonst. Der Weg **ohne** Vorstufe
(native Auflösung, 8 Bit) macht es bereits richtig: er schickt schlicht dasselbe
Bild noch einmal.

Wie oft das eintritt, hängt am Inhalt. Ein stehendes Menü, ein pausiertes Spiel,
eine Folie: dort ist es **jeder** Tick. Der Sidecar zählt das bereits mit —
`dup-frames` in der Zwei-Sekunden-Zusammenfassung des `TickMonitor`
(`tick_monitor.rs::flush_summary`).

**Sicherheit: hoch.** Der Sachverhalt ist unmittelbar am Kontrollfluss ablesbar,
er hängt an keiner Annahme über Treiber oder Hardware.

**Was eine Behebung kostet.** Klein: das zuletzt gewandelte Bild behalten und bei
`captured == 0` erneut abschicken, statt neu zu wandeln. Etwa zehn Zeilen in
`pipeline_hw/mod.rs`. **Drei Dinge müssen dabei mit bedacht werden**, sonst tauscht
man einen sichtbaren Gewinn gegen einen unsichtbaren Fehler:

1. **Das behaltene Bild geht nicht in den Pool zurück**, solange es gehalten wird.
   Der Pool wächst um genau eines — auf dem Einzeltextur-Weg (AMD, P010) ist das
   folgenlos, weil er ohnehin bis zur Arbeitsmenge wächst
   (`hwctx.rs::HwPoolConfig::pool_size`).
2. **Der Encoder bekäme dieselbe Textur zweimal.** Genau das tut der Weg ohne
   Vorstufe seit jeher, der Fall ist also nicht neu — aber er ist auf dem
   Vorstufen-Weg neu, und AMF hält ein Bild zurück. Vor dem Übernehmen gehört
   dazu eine Sichtprüfung an einem Dateimitschnitt.
3. **Die HDR-Begleitdaten hängen am Bild, nicht am Encoder**
   (`encode/hdr.rs::metadaten_anhaengen`, je Bild zwei
   `av_frame_new_side_data`). Heute ist das harmlos, weil jeder Tick ein
   frisches `AVFrame` aus dem Pool zieht. Wird dasselbe `AVFrame` mehrfach
   verwendet, ist zu prüfen, ob die Begleitdaten **anwachsen** — FFmpegs
   `av_frame_new_side_data` hängt an, und ob es bei diesen beiden Arten vorher
   räumt, ist hier **nicht** nachgesehen worden. Ein unbemerktes Anwachsen wäre
   ein langsam wachsender Speicherbedarf über die Laufzeit eines Streams.

## 4. Befund 2 — der HDR-Shader rechnet den Farbweg doppelt

**Wo.** `streaming/win-hq-sidecar/src/encode/hdr_wandler.rs`, `SHADER_HLSL`,
`ps_luma` (Z. 148-150) und `ps_chroma` (Z. 152-163).

Der Shader läuft in zwei Zeichendurchgängen. Der erste schreibt die Luma-Ebene in
voller Auflösung und ruft dafür je Bildpunkt einmal `farbe()`. Der zweite schreibt
die Chroma-Ebene in halber Höhe und Breite und ruft **je Bildpunkt viermal**
`farbe()` — an genau den vier Luma-Stellen, die der erste Durchgang bereits
gerechnet hat.

Damit ist die Zahl der `farbe()`-Aufrufe:

* Luma-Durchgang: `N` (N = Bildpunkte des Ziels)
* Chroma-Durchgang: `N/4 × 4 = N`
* **Summe: 2N** — für ein Bild mit N Bildpunkten.

`farbe()` ist nicht billig: eine Texturabtastung, eine 3×3-Matrix und **PQ**,
und PQ sind zwei `pow` je Farbkanal, also **sechs `pow` je Aufruf**. Bei 1080p
sind das 12,4 Millionen `pow` je Durchgang, in Summe 24,9 Millionen je Bild — die
Hälfte davon ist eine Wiederholung. Transzendente Befehle laufen auf RDNA mit
einem Bruchteil der Rate der übrigen Rechenwerke; es ist der teuerste Teil des
Shaders.

**Und die Begründung im Code trägt den Code nicht.** Dort steht (Z. 154-156):

> „Vor der Matrix zu mitteln waere farblich richtiger, kostet aber vier
> Matrixdurchlaeufe; danach zu mitteln ist der uebliche Weg […]"

Der Code macht aber **schon jetzt** vier Matrixdurchläufe — er ruft `nach_ycbcr`
viermal auf, und davor viermal `farbe()`. Vor der Matrix zu mitteln wäre also
nicht teurer, sondern **billiger** (ein Matrixdurchlauf statt vier). Das
Kostenargument der Begründung stimmt nicht; die Wahl mag aus anderen Gründen
richtig sein, aber nicht aus diesem.

**Sicherheit: hoch** für die Verdopplung (unmittelbar am Shader ablesbar).
**Ungemessen** ist, was der Shader insgesamt in Millisekunden kostet — und damit
auch, wie viel eine Halbierung bringt. Die Bandbreiten-Rechnung aus Abschnitt 2
sagt: der Chroma-Durchgang ist rund **1,8 GB/s** an Lesezugriffen bei 60 fps.

**Was eine Behebung kostet.** Es gibt drei Wege, und sie unterscheiden sich stark:

| Weg | Ersparnis an `farbe()` | Aufwand | Haken |
|---|---|---|---|
| **(a) Eine bilineare Abtastung in der Mitte des 2×2-Blocks** statt vier | 2N → 1,25N (**−37 %**) | ~6 Zeilen Shader | ändert die Farbmittelung: gemittelt wird dann in **linearem Licht vor** der Kurve statt danach. Das ist der farblich richtigere Weg (die Begründung im Code sagt es selbst), weicht aber vom D3D12-Wandler ab. Braucht eine Sichtprüfung an einem Bild aus der Mitte, nicht an Bild 0. |
| **(b) Nur vor der Matrix mitteln** (vier `farbe()`, ein `nach_ycbcr`) | keine (die `pow` bleiben) | ~4 Zeilen | spart nur die Matrix, also den billigen Teil. Lohnt kaum. |
| **(c) Ein Compute-Shader, der beide Ebenen in einem Durchgang schreibt** (ein Faden je 2×2-Block: vier `farbe()`, vier Luma- und ein Chroma-Wert) | 2N → N (**−50 %**) | deutlich größer: UAV-Ansichten auf die P010-Ebenen, andere Bindung, eigener Ablauf | erhält die heutige Farbmittelung **exakt**. Der saubere Weg, wenn man die Farben nicht anfassen will. |

Empfehlung, wenn etwas gemacht wird: **(a) probieren, mit Sichtprüfung**, weil es
die kleinste Änderung mit dem größten Verhältnis ist. **(c)** ist der Weg, falls
sich (a) farblich als Rückschritt zeigt.

## 5. Befund 3 — die Zwischenkopie in fp16 (größer, mit echtem Risiko)

**Wo.** `capture/wgc_hw.rs::copy_into_pool` (Z. 350-374), gerufen aus
`on_frame_arrived` (Z. 256 und 312).

Jedes von WGC gelieferte Bild wird zunächst per `CopySubresourceRegion` in eine
Pool-Textur kopiert. Das ist bei SDR seit jeher so und hat einen guten Grund: die
WGC-Textur ist nur innerhalb des Rückrufs gültig, der Taktfaden holt sie aber
später ab.

Bei HDR kostet diese Kopie **59 MB je aufgenommenem Bild** (29,5 lesen,
29,5 schreiben — gerechnet), und sie fällt für **jedes** aufgenommene Bild an,
auch für die, die der Taktfaden gleich wieder verwirft. Verworfen wird
regelmäßig: die Aufnahme ist auf `0,9/fps` gedeckelt
(`capture/mod.rs::min_interval_settings`), liefert also rund 11 Prozent mehr
Bilder, als der Takt verbraucht.

**Der denkbare Weg:** die Farbwandlung in den Aufnahme-Rückruf ziehen, also aus
der WGC-Textur direkt nach P010 schreiben. Dann entfiele die fp16-Kopie ganz, der
Pool führte P010 (6,2 statt 29,5 MB je Textur), und verworfene Bilder kosteten
nur noch den Shader statt Shader **und** Kopie. Zusammen mit Befund 1 wäre das
auch die saubere Lösung für stehende Bilder — bei `captured == 0` läge das
gewandelte Bild schon fertig vor.

**Warum das hier trotzdem nicht als Empfehlung steht.** Drei Gründe, und der
dritte wiegt:

1. Der Shader liefe dann auf dem WGC-Rückruf-Faden. Bleibt er dort zu lange,
   verwirft WGC Bilder — und dieser Verlust erscheint in **keinem** Zähler
   (`capture_drops` kennt nur Pool-Erschöpfung und Rückstau).
2. Der `HdrWandler` müsste aus `pipeline_hw` in `capture` wandern; die
   Zuständigkeiten der beiden Dateien verschöben sich spürbar.
3. **Es ist ein Umbau auf Verdacht.** Was die Kopie wirklich kostet, ist
   ungemessen. Befund 1 und 2 sind kleiner, belegter und billiger — sie gehören
   zuerst gemacht, und danach kann man neu fragen, ob hier noch etwas liegt.

**Was nebenbei geprüft und ausgeschlossen wurde:** ein schmaleres Aufnahmeformat
gibt es nicht. `windows-capture` 2.0.0 bietet in `ColorFormat` genau drei Werte —
`Rgba16F`, `Rgba8`, `Bgra8` (nachgesehen in der Quelle der Kiste). Ein
10-Bit-Format wie `R10G10B10A2` ist nicht darunter; es zu bekommen hieße, die
Kiste zu ändern. **Ob WGC darüber überhaupt ein brauchbares HDR-Bild lieferte,
ist ungeprüft** und wäre eine eigene Untersuchung — die Behauptung, das halbiere
die Bandbreite, wäre heute unbelegt.

## 6. Kleinere Befunde am Code

Alle drei sind eindeutig, alle drei sind vermutlich klein. Sie stehen hier, damit
sie nicht verlorengehen, nicht weil sie dringend wären.

**6.1 Die Quell-Ansicht bleibt nach dem Zeichnen gebunden.**
`hdr_wandler.rs::zeichnen` hängt am Ende sorgfältig das Ziel ab
(`OMSetRenderTargets(None, None)`, Z. 351) — die Quell-Ansicht in
`PSSetShaderResources` bleibt aber gebunden. Der Aufnahme-Faden schreibt kurz
darauf per `CopySubresourceRegion` in Pool-Texturen; der Pool umfasst wenige
Texturen und wird reihum benutzt, also trifft er regelmäßig genau die noch
gebundene. In eine gebundene Ansicht zu schreiben ist unter D3D11 nicht verboten,
zwingt den Treiber aber zu einer Auflösung dieser Überschneidung und meldet sich
im Debug-Layer. **Behebung: eine Zeile** (`PSSetShaderResources(0, [None])`
hinter dem Zeichnen), gleiche Sorgfalt wie beim Ziel eine Zeile darüber.

**6.2 `pool_size` ist auf dem HDR-Weg ein wirkungsloses Argument.**
`vorstufe::bauen` übergibt `16` an `HdrWandler::new` (Z. 88). Weil das
Pool-Format `P010LE` ist, wählt `HwContext::new` zwingend die Einzeltextur-Bauart
(`hwctx.rs:319-323`), und in der ist `pool_size` ausdrücklich wirkungslos. Kein
Fehler, aber ein Wert, den ein Leser für eine Stellschraube hält.

**6.3 `vorstufe::bauen` verwirft auf dem HDR-Zweig `dst_format` und `geteilt`.**
Der HDR-Zweig (Z. 73-91) kehrt zurück, bevor die beiden Parameter gelesen werden;
`HdrWandler` legt sein Format selbst fest. Heute stimmt beides überein, weil HDR
zwingend 10 Bit bedeutet und `pool_wahl` dann P010 liefert. Meldet sich aber je
ein fremder Encode-Weg mit eigenem Pool-Format an, ginge dessen Wunsch auf dem
HDR-Weg **wortlos** unter. Eine Zeile Prüfung mit Abbruch wäre hier dieselbe
Haltung, die dieselbe Funktion am Ende schon zeigt (Z. 130-143: sie bricht ab,
statt stillschweigend weiterzumachen).

## 7. Was ausdrücklich nichts bringt

Ehrlichkeit auch in die andere Richtung — an diesen Stellen wurde nachgesehen und
nichts gefunden:

* **Die Encoder-Optionen sind ausgereizt.** `usage=ultralowlatency` senkt die
  Video-Engine gemessen von 23,9 auf 9,4 Prozent (`encode/opts.rs`, Messung
  2026-07-30) und ist gesetzt. `async_depth=1` ist gesetzt und ändert auf dieser
  Hardware gemessen nichts; `quality` ist bei `av1_amf` gemessen byte-wirkungslos.
  Beide stehen mit dieser Begründung im Code — sie sind bekannte Attrappen, keine
  übersehenen Hebel.
* **Auf `EAGAIN` beim Abholen zu warten bringt nichts.** Am 2026-07-30 gemessen:
  0,02 ms Unterschied (`encoder_hw.rs::drain_video`). Der Verdacht ist erledigt.
* **Die Abgabe hängt nicht am Taktfaden.** Muxer wie eigener Sendeweg laufen auf
  eigenen Fäden mit begrenzter Warteschlange (`mux_writer.rs`,
  `senke_writer.rs`); der Taktfaden reiht nur ein. Der Weg, der 2026-05-20 einmal
  ~17 übersprungene Bilder je Keyframe verursacht hat, ist zu.
* **Keine Umgebungsvariable wird je Bild gelesen.** Geprüft über alle
  `env::flag`/`std::env::var`-Aufrufe: alle liegen im Aufbau oder hinter einem
  `OnceLock`.
* **Die Ansichten-Zwischenspeicher tun, was sie sollen.** `d3d11_scale` und
  `hdr_wandler` legen Ansichten je Pool-Textur genau einmal an; im laufenden
  Betrieb gibt es dort keine Treiber-Aufrufe mehr.
* **Der Aufnahme-Deckel ist bereits gesetzt.** `min_interval_settings` deckelt
  seit dem 2026-08-05 auf `0,9/fps`; die frühere Ausnahme für 60 fps, die auf
  einem 280-Hz-Schirm viereinhalb Bilder je Takt abholen ließ, ist weg.
* **Die COM-Kopien je Bild im Shader** (fünf `clone()`-Aufrufe in `zeichnen`)
  sind atomare Zählerschritte, keine Arbeit. Nachgesehen und für unerheblich
  befunden.

## 8. Was zuerst zu tun ist

**Der billigste Schritt ist eine Ablesung, keine Änderung.** Der Sidecar erhebt
bereits alles, was die Frage „Last oder Verzögerung?" entscheidet — es wird nur
im gesunden Fall nicht ausgegeben. Zwei Schalter, und man muss den Unterschied
kennen, sonst greift man zum falschen:

* **`PULSE_ENC_LATENCY_LOG=1`** — gibt die Zwei-Sekunden-Zusammenfassung auch
  dann aus, wenn das Fenster sauber war. **Im sauberen Fall enthält sie nur
  Tickzahl und Encode-Latenz** (`tick_monitor.rs::flush_summary`, Zweig „sauber");
  `dup-frames` und `max conv` stehen ausschließlich in der Zeile für ein
  auffälliges Fenster. Der Schalter beantwortet also „wie groß ist die
  Encode-Latenz" und „gibt es Auffälligkeiten", sonst nichts.
* **`PULSE_HQ_TRACE=<pfad>`** — schreibt **je Tick** eine JSONL-Zeile mit
  `captured`, `conv_us`, `send_us`, `iter_us`, `pts_delta` und `drops`. Das ist
  der Schalter für die beiden Befunde oben, denn nur er liefert `captured == 0`
  (Befund 1) und `conv_us` (Befund 2) auch dann, wenn alles ruhig läuft. Er
  kostet eine gepufferte Zeile je Bild, keine GPU-Arbeit.

Daraus liest man ohne jeden Messaufbau ab:

* **viele Ticks mit `captured: 0`** (Trace) → Befund 1 greift oft, seine
  Behebung lohnt.
* **`conv_us` nennenswert gegen das Budget von 16 700 µs** (Trace) → der
  HDR-Shader ist ein echter Posten, Befund 2 lohnt.
* **`enc avg` nahe 17 ms und `slow`/`pts-gaps` bei null** → die Sendeseite ist
  gleichmäßig, und was der Nutzer spürt, ist die Verzögerung aus Abschnitt 1
  (oder sie liegt beim Zuschauer). Dann ist an dieser Seite mit kleinen
  Änderungen nichts zu holen, und die ehrliche Antwort lautet: Bildrate hoch oder
  Weg wechseln.
* **`slow` und `pts-gaps` ungleich null** → dann ist es Last, und die Reihenfolge
  ist Befund 1, dann Befund 2.

Danach, nach erwarteter Wirkung geordnet:

| # | Befund | Wirkung | Aufwand | Sicherheit |
|---|---|---|---|---|
| 1 | Umwandlung bei stehendem Bild überspringen (§3) | ganze Vorstufe entfällt auf duplizierten Ticks | ~10 Zeilen + Sichtprüfung | hoch |
| 2 | Chroma-Durchgang entdoppeln (§4, Weg a) | −37 % Shader-Arbeit im HDR-Weg | ~6 Zeilen + Sichtprüfung | hoch für die Verdopplung, ungemessen für den Zeitgewinn |
| 3 | Quell-Ansicht abhängen (§6.1) | Treiber-Überschneidung weg | 1 Zeile | hoch, Wirkung klein |
| 4 | fp16-Zwischenkopie einsparen (§5) | −59 MB je aufgenommenem Bild | Umbau, echtes Risiko | Rechnung sicher, Nutzen ungemessen |
| 5 | Bildrate auf 120 (§1) | −12 ms Verzögerung | Einstellung | hoch, kostet Last |

## 9. Nebenbefund — drei überholte Behauptungen im Code

Nicht Leistung, aber sie stehen mitten in den Dateien, die man für eine
Leistungsentscheidung liest, und sie beschreiben die Encode-Wege **falsch**. Nach
der Regel in `CLAUDE.md` gehört jede von ihnen berichtigt und die alte Aussage
als widerlegt stehengelassen. **Auf diesem Zweig wurde nichts davon geändert** —
der Auftrag war ausdrücklich, den Quelltext nicht anzufassen.

Alle drei stammen aus derselben Umstellung: seit dem 2026-08-04 geht **AMD mit
jedem Codec über AMF**, vorher ging H.264/HEVC über D3D12.

1. **`encode/codec.rs`, Doku zu `encode_path`** — die Aufzählung führt weiter
   „**AMD, H.264/HEVC** → D3D12" und begründet es mit der Latenz. Der Code
   zwanzig Zeilen darunter tut das Gegenteil und begründet es dort auch. Zwei
   Aussagen in **einer** Doku, die einander widersprechen.
2. **`encode/codec.rs`, Doku zu `supports_ten_bit`** — „H.264 läuft auf AMD über
   D3D12 (`encode_path`) und damit an diesem Pool vorbei". Gilt nicht mehr.
3. **`encode/auffrischung.rs`, Doku zu `encoder_name`** — „bei AMD je Codec ein
   anderer (AV1 über AMF, H.264 über D3D12)". Gilt nicht mehr.

Dazu eine vierte, aus der HDR-Arbeit dieses Zweigs:

4. **`capture/wgc.rs`, Doku zu `CaptureConfig::hdr`** — „Die Umrechnung nach
   PQ/BT.2020 macht der Farbwandler davor dem Encoder (`encode::d3d11_scale`)".
   Seit dem 2026-08-06 macht das `encode::hdr_wandler`, und zwar gerade **weil**
   `d3d11_scale` es auf diesem Treiber nicht kann.
