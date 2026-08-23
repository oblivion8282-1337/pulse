# macOS-Eingabe: drei Messungen für den Fernsteuer-Injektor

Datum: 2026-08-23
Maschine: MacBook, macOS 15.7.3 (24G419), Apple Silicon
Prüflinge: `tcc-probe.swift` und `eingabe-probe.swift` (Swift, `CGEventPost` auf
`kCGHIDEventTapLocation`, jedes Ereignis mit `kCGEventSourceUserData =
PULSE_MARKE` gestempelt — dieselbe Marke, die auf Windows in `dwExtraInfo`
steht).

Diese drei Fragen standen als offen in `docs/superpowers/specs/2026-08-22-fernsteuerung-macos-design.md` §9. Sie
ändern je einen Teil des Injektor-Entwurfs und gehörten deshalb **vor** Plan 2.
Alle drei sind beantwortet.

---

## Messung 1 — Wem ordnet macOS die Accessibility-Freigabe zu?

**Frage:** Braucht der Sidecar einen eigenen Eintrag in den Bedienungshilfen,
oder erbt er die Freigabe des Programms, das ihn startet? Davon hängt ab, ob
ein Nutzer „Pulse" freigibt oder einen kryptischen Binärnamen suchen muss —
und ob `systemPreferences.isTrustedAccessibilityClient()` im Electron-Haupt­prozess
überhaupt die richtige Auskunft für den Sidecar gibt.

**Aufbau:** `tcc-probe` ruft `AXIsProcessTrustedWithOptions`. Gestartet als
Kindprozess der Shell im Terminal.

**Ergebnis:**

| Schritt | Beobachtung |
|---|---|
| vor der Freigabe | `vertraut=false` |
| Dialog mit `--fragen` | nannte **das Terminal**, nicht `tcc-probe` |
| Freigabe erteilt (Schalter für Terminal) | — |
| Prüfling erneut, **ohne eigenen Eintrag** in der Liste | `vertraut=true` |

**Befund: der Kindprozess erbt die Freigabe des verantwortlichen Programms.**
Ein eigener Eintrag ist weder nötig noch entsteht einer.

**Folge für den Entwurf:** §7.2 trägt. Der Nutzer gibt **Pulse** frei, der
Sidecar erbt es, und die Abfrage darf im Electron-Hauptprozess sitzen (dort
heisst der Eintrag „Pulse" statt eines Binärnamens).

**Was noch offen bleibt:** Der Gegenversuch mit `Pulse.app` als Elternprozess
statt des Terminals ist nicht gefahren. Der **Mechanismus** ist derselbe
(verantwortlicher Prozess), aber `Pulse.app` ist nur ad-hoc signiert; das
betrifft die **Haltbarkeit** der Freigabe über ein Update hinweg (§11), nicht
die Zuordnung. Sollte beim ersten echten Aufbau nachgeprüft werden.

---

## Messung 2 — Zählt der WindowServer Doppelklicks selbst?

**Frage:** Muss der Injektor `kCGMouseEventClickState` selbst hochzählen, oder
erkennt macOS zwei schnell aufeinanderfolgende Klicks von allein als
Doppelklick? Auf Windows zählt das System selbst.

**Aufbau:** Zwei Klicks im Abstand von 80 ms auf ein Wort in TextEdit; einmal
mit `clickState = 1` für beide, einmal mit `clickState = 2` für den zweiten.

**Ergebnis:**

| Lauf | Beobachtung |
|---|---|
| `clickState` bleibt 1 | nur die Einfügemarke — **kein** Doppelklick |
| zweiter Klick mit `clickState = 2` | das Wort wird markiert |

**Befund: macOS zählt NICHT selbst. Der Injektor muss zählen.**

**Folge für den Entwurf:** Der Doppelklick-Zähler aus §4 wird gebraucht — ein
kleiner reiner Zähler über Zeit- und Ortsfenster, neben dem Injektor. Ohne ihn
fehlt beim Fernsteuern jedes Doppelklick-Markieren, **ohne dass irgendetwas
fehlschlägt oder eine Meldung erzeugt**. Genau die Sorte Fehler, die man der
Leitung zuschreibt statt dem Injektor.

---

## Messung 2b — Füllt der WindowServer die Umschalttasten-Kennzeichnung?

**Frage:** Trägt ein Tastenereignis die Cmd-Kennzeichnung von selbst, wenn
zuvor ein echtes Cmd-Runter injiziert wurde? Auf Windows entsteht der
Modifikator-Zustand im System.

**Aufbau:** Text in TextEdit markiert, Zwischenablage auf einen Merkwert
gesetzt, dann die Folge Cmd-runter, C-runter, C-hoch, Cmd-hoch — einmal ohne
`CGEventSetFlags`, einmal mit `.maskCommand` auf den C-Ereignissen.

**Ergebnis:**

| Lauf | Zwischenablage danach |
|---|---|
| ohne gesetzte Flags | unverändert (`ZWISCHENABLAGE-LEER`) |
| mit `.maskCommand` | `Hallo` — das markierte Wort |

**Befund: der Injektor muss die Flags selbst setzen.**

**Folge für den Entwurf — und das ist eine Lücke im heutigen Trait:**
`Injektor::maus_setzen(punkt, &Druck)` bekommt die Gedrückt-Menge bereits mit
(wegen der Zieh-Ereignisse). **`Injektor::taste(scan, down)` bekommt sie
nicht** — für die Flags bräuchte er sie genauso. Zwei Wege:

* `taste` bekommt ebenfalls `&Druck` (symmetrisch zu `maus_setzen`, und die
  Sitzung führt die Menge ohnehin);
* oder der mac-Injektor führt seine eigene Modifikator-Buchführung aus den
  Scancodes, die er sieht.

Der erste Weg ist vorzuziehen: die zweite Buchführung wäre eine Kopie dessen,
was `Druck` schon weiss, und müsste bei jedem Sitzungsende gesondert geräumt
werden. **Zu beachten bei der Reihenfolge:** `ausfuehrung` ruft heute erst
`injektor.taste(...)` und schreibt danach `z.druck.taste(...)` fort — beim
Cmd-Runter selbst wäre die Taste also noch nicht in der Menge. Ob ein
Cmd-Runter-Ereignis seine eigene Kennzeichnung tragen muss, ist **nicht
gemessen**.

---

## Messung 3 — Wirkt „natürliches Scrollen" auf injizierte Ereignisse?

**Frage:** Kehrt die Systemeinstellung die Richtung injizierter Radereignisse
um? Wenn ja, müsste der Sidecar sie auslesen und gegenrechnen — sonst scrollt
ein Steuernder verkehrt herum, sobald er sie anders eingestellt hat als der
Host, und beide hielten es für ein Problem des jeweils anderen.

**Aufbau:** Textdatei mit 200 nummerierten Zeilen in TextEdit, Zeiger über dem
Text. `CGEventCreateScrollWheelEvent2` mit Zeileneinheit und `wheel1 = +1` —
das Vorzeichen, das auf Windows „vom Nutzer weg" bedeutet. Beobachtet wurde die
oberste sichtbare Zeilennummer.

**Ergebnis:**

| `com.apple.swipescrolldirection` | Eingabe | oberste Zeile |
|---|---|---|
| `0` (natürlich **aus**) | 1 Raste | 062 → **061** |
| `1` (natürlich **an**) | 1 Raste | 061 → 061 (keine Bewegung) |
| `1` (natürlich **an**) | 5 Rasten | 061 → **058** |

**Befund: die Einstellung wirkt NICHT auf injizierte Ereignisse.** Die Richtung
ist in beiden Stellungen dieselbe — kleinere Zeilennummer, also Inhalt nach
unten. Das entspricht der Windows-Bedeutung von `dv > 0`; die Vorzeichen passen
**ohne Umrechnung**.

**Folge für den Entwurf:** §4 braucht keine Gegenrechnung. Der Sidecar schickt
unverändert, Host und Steuernder dürfen die Einstellung beliebig verschieden
haben.

**Randbeobachtung, ungeklärt:** Die Umrechnung Raste → Zeile ist nicht glatt
1:1. Bei ausgeschaltetem „natürlich" bewegte eine Raste genau eine Zeile, bei
eingeschaltetem bewegten fünf Rasten nur drei. Für die **Richtung** ohne
Belang, für das Scrollgefühl womöglich nicht. Zu messen, wenn Plan 2 das Rad
baut — eine Windows-Raste (120) soll dort einer Zeile entsprechen.

---

## Was sich am Entwurf ändert

| Entwurf | Stand nach der Messung |
|---|---|
| §4 Doppelklick-Zähler „unschädlich, falls der WindowServer es doch tut" | **wird gebraucht** — er tut es nicht |
| §4 Umschalttasten „sollte der WindowServer füllen; tut er es nicht, aus der Gedrückt-Menge" | **er tut es nicht** — und der Trait gibt sie `taste` heute gar nicht |
| §4 Rad-Vorzeichen und natürliches Scrollen | **keine Gegenrechnung nötig** |
| §7.2 Berechtigungs-Abfrage im Electron-Hauptprozess | **trägt** — der Kindprozess erbt |

Alle drei Messungen sprechen für den Entwurf, mit **einer** echten Lücke: die
fehlende Gedrückt-Menge in `Injektor::taste`. Sie ist beim Schreiben von Plan 2
zu schliessen.

---

# Nachträge — am gebauten Injektor gemessen (2026-08-23, Aufgabe 4)

Die Messungen oben liefen über Swift-Prüflinge, **vor** dem Code. Die folgenden
laufen über den gebauten `MacInjektor` selbst: `streaming/mac-hq-sidecar/examples/probe_injektor/`,
zu fahren mit `cargo run --example probe_injektor -- <lauf>` (dieselbe
Bedienungshilfen-Freigabe wie oben; der Prüfling bricht ab, statt einen leeren
Befund zu melden, wenn sie fehlt). Ziel ist jedes Mal ein eigenes
TextEdit-Fenster auf einer eigenen Datei unter `$TMPDIR`, das Ergebnis wird aus
der Zwischenablage oder über die Bedienungshilfen zurückgelesen — nicht
angeschaut.

Maschine unverändert: MacBook, macOS 15.7.3 (24G419), Apple Silicon.

## Nachtrag 1 — muss ein Cmd-**Runter** seine eigene Kennzeichnung tragen?

Die offene Frage aus Messung 2b und aus dem Doc-Kommentar von
`Injektor::taste`. `pulse_fernsteuerung::ausfuehrung` ruft den Injektor **vor**
dem Nachtrag in `Druck` — beim eigenen Runter-Ereignis steht die Taste also noch
nicht in der Menge, das Cmd-Runter geht ohne `.maskCommand` hinaus.

**Aufbau:** Wort per Doppelklick markiert, Zwischenablage auf einen Merkwert
gesetzt, dann Cmd-runter, C-runter, C-hoch, Cmd-hoch über den `MacInjektor`.
Zweiter Lauf mit `--eigen`: dort wird `Druck` **vor** dem Injektor-Aufruf
fortgeschrieben, das Cmd-Runter trägt seine Kennzeichnung dann selbst.

| Lauf | Zwischenablage danach |
|---|---|
| Reihenfolge wie in `ausfuehrung` (Cmd-Runter ohne eigene Kennzeichnung) | `Hallo` |
| `--eigen` (Cmd-Runter mit eigener Kennzeichnung) | `Hallo` |

**Befund: nein.** Ein Cmd-Runter braucht seine eigene Kennzeichnung nicht. Die
Reihenfolge in `ausfuehrung` trägt, und sie muss für macOS nicht gedreht werden.

**Die Kehrseite gleich mitgemessen**, weil dieselbe Reihenfolge sie erzeugt: das
Cmd-**Hoch** trägt bei dieser Reihenfolge noch `.maskCommand`, obwohl es das
Ende von Cmd meldet — `Druck` wird erst danach fortgeschrieben. Bleibt Cmd
dadurch hängen, wäre die nächste gewöhnliche Taste ein Tastenkürzel. Geprüft mit
„e" (als Text ersetzt es die Auswahl, als Cmd+E tut es nichts Sichtbares): in
**beiden** Läufen stand danach `e Welt Pulse Fernsteuerung` in der Datei. **Cmd
hängt nicht.**

## Nachtrag 2 — der Klickzähler am eigenen Code

Messung 2 oben belegte den Befund an einem Swift-Prüfling. Hier dasselbe durch
den gebauten Zähler, mit Gegenprobe: `--ohne-zaehler` gibt dem zweiten Klick
einen **frischen** Injektor, dessen Kette leer ist — sein Klick trägt damit
`clickState = 1`, ohne dass am Zähler etwas verstellt werden müsste.

| Lauf | Auswahl danach |
|---|---|
| Klickzähler an | `Hallo` — das Wort ist markiert |
| `--ohne-zaehler` | nichts markiert |

**Befund: der Zähler ist tragend**, und zwar im gebauten Code, nicht nur im
Entwurf.

## Nachtrag 3 — die Kennzeichnung gilt für **Maus**-Ereignisse genauso

Messung 2b prüfte nur die Tastatur. Der Entwurf verlangt die Kennzeichnung auch
auf Maus-Ereignissen („ein Cmd-Klick ist so verbreitet wie ein Cmd-C") — das war
bis hierher unbelegt.

**Aufbau:** Klick an eine Stelle, 900 ms warten (damit der zweite Klick nicht als
Doppelklick zählt), Umschalttaste runter, Klick 90 Punkte weiter rechts,
Umschalttaste hoch, Cmd+C. Umschalt+Klick erweitert in TextEdit die Auswahl.
Gegenprobe `--ohne-flags`: `maus_setzen` bekommt eine **leere** Gedrückt-Menge,
obwohl die Umschalttaste körperlich unten ist.

| Lauf | Auswahl danach |
|---|---|
| Kennzeichnung auf dem Maus-Ereignis | `llo Welt Pulse` |
| `--ohne-flags` | nichts markiert |

**Befund: der WindowServer füllt die Kennzeichnung auch für Maus-Ereignisse
nicht.** Sie muss auf Bewegung, Knopf und Rad genauso mit.

Nebenbei belegt das den Umweg im Injektor: `Injektor::maus_knopf` bekommt gar
keine Gedrückt-Menge, die Kennzeichnung kommt dort aus dem gemerkten Stand des
letzten Aufrufs, der eine hatte (`maus_setzen`/`taste`). Dieser Umweg trägt —
weil `ausfuehrung` vor jedem Knopf-Runter und jedem Rad-Ereignis die Zeigerlage
noch einmal behauptet.

## Nachtrag 4 — Ziehen: der Typ überlebt, der behauptete Schaden ist unbelegt

Der Entwurf begründet den eigenen Zieh-Ereignistyp mit „sonst zieht in vielen
Programmen nichts". Zwei Gegenproben mit `MouseMoved` bei gedrücktem Knopf:

| Ziel | mit Zieh-Typ | mit `MouseMoved` |
|---|---|---|
| Textauswahl in TextEdit | `llo Welt P` | `llo Welt P` — **zieht auch** |
| TextEdit-Fenster an der Titelleiste verschieben | (213,75) → (333,125) | (213,75) → (333,125) — **zieht auch** |

Damit stand die Frage im Raum, ob der WindowServer den Typ selbst berichtigt.
Direkt gemessen an den Ereigniszählern des HID-Systems
(`CGEventSourceCounterForEventType`, Lauf `zieh-typ`), je zehn Bewegungen:

| Lauf | `MouseMoved` | `LeftMouseDragged` |
|---|---|---|
| leere Gedrückt-Menge | **+10** | +0 |
| linker Knopf gedrückt | +0 | **+10** |

**Befund: der WindowServer berichtigt nichts** — der Typ geht so hinaus und
kommt so an. Die beiden geprüften Ziele sind bloss tolerant: AppKits
Verfolgungsschleifen nehmen `MouseMoved` mit.

**Was daraus folgt:** der Zieh-Typ bleibt richtig und bleibt eingebaut (er ist
der Typ, den Apples Ereignismodell für diesen Fall vorsieht). Aber die
**Schadensaussage** des Entwurfs ist an diesem Rechner **nicht belegt**. Sie
gilt für Programme, die streng auf `NSEventMaskLeftMouseDragged` hören (Spiele,
Qt, Chromium), und dafür fehlt hier ein Ziel. Wer sie belegen will, braucht ein
Programm ausserhalb von AppKit.

## Nachtrag 5 — das Rad: Richtung bestätigt, Weite gemessen

Messung 3 klärte die Richtung, liess die Umrechnung Raste → Zeile aber offen
(„Randbeobachtung, ungeklärt"). Der Entwurf setzt eine Windows-Raste (120) auf
eine Zeile; so ist es gebaut. Gemessen am sichtbaren Zeichenbereich der
TextEdit-Textfläche (`AXVisibleCharacterRange`, durch die feste Zeilenlänge
geteilt), Datei mit 400 nummerierten Zeilen:

| Eingabe | oberste Zeile | Schritt |
|---|---|---|
| Start (nach 40 Rasten abwärts) | 31 | — |
| +1 Raste | 31 | 0 Zeilen |
| +5 Rasten | 27 | **−4 Zeilen** |
| −1 Raste | 27 | 0 Zeilen |
| −5 Rasten | 31 | **+4 Zeilen** |

**Richtung bestätigt** — positive Rasten machen die Zeilennummer kleiner, also
die Windows-Bedeutung von `dv > 0`, ohne Gegenrechnung.

**Weite: rund 0,75 bis 0,8 Zeilen je Raste**, nicht eine. Fünf Rasten bewegten
vier Zeilen, vierzig Rasten dreissig. macOS legt auf ein Zeilen-Rollereignis
noch seine eigene Beschleunigungskurve; einzelne Rasten verschwinden dabei im
Rest (deshalb die Nullschritte oben — die Textfläche rollt in Bildpunkten, die
Zeilennummer springt erst beim Überlaufen).

**Offen, und bewusst nicht in Aufgabe 4 entschieden:** Windows rollt je Raste
standardmässig **drei** Zeilen (`SPI_GETWHEELSCROLLLINES`). Gegenüber dem, was
der Steuernde von seinem eigenen Rechner kennt, rollt der ferngesteuerte Mac
damit rund viermal träger. Das ist eine Frage des Scrollgefühls, keine der
Richtigkeit — und eine, die gemessen gehört statt geraten.

**Eine Falle für spätere Messungen:** `scroll bar 1 of scroll area 1 of window 1`
ist bei TextEdit der **waagerechte** Rollbalken. Sein Wert steht still, egal wie
weit gerollt wird. Ein Lauf, der ihn abliest, meldet „das Rad tut nichts" — und
das sah zwischenzeitlich wie ein echter Befund aus. Der sichtbare
Zeichenbereich ist eindeutig.

## Was in Aufgabe 4 **nicht** gemessen werden konnte

* **Waagerechtes Rollen.** `wheel2` ist symmetrisch zum senkrechten gebaut, aber
  die Richtung ist ungemessen — TextEdit im Umbruchmodus rollt nicht waagerecht.
  **Kein neutrales „ungemessen": ein begründeter Verdacht auf Vorzeichenumkehr**
  (Befund 4 der Prüfung vom 2026-08-23, nachgetragen 2026-08-24). macOS'
  `wheel2`-Vorzeichen und Windows' `WM_MOUSEHWHEEL` zeigen in jeder
  Werkzeugkiste, die zwischen beiden abbildet, in entgegengesetzte Richtungen —
  Qt und Chromium kehren `deltaX` auf macOS eigens um. Wer das misst, sucht
  zuerst nach einer Vorzeichenumkehr, nicht nach einer beliebigen Abweichung.
* **Cmd+Tab, Mission Control, sichere Eingabefelder.** Als Grenzen im Modulkopf
  von `injektion.rs` dokumentiert, nicht nachgestellt.
* **Ob der Doppelklick-Abstand (500 ms) passt.** Die Nutzereinstellung wird nicht
  ausgelesen (bräuchte AppKit); ob jemand die feste Frist als zu träge oder zu
  hastig empfindet, sagt keine Messung.
* **Der rechte Mausknopf.** Nachtrag 6 fuhr Knopf 0 (links) und Knopf 3
  (Seitenknopf), nicht Knopf 1. Er läuft durch denselben Zweig; belegt ist er
  nicht.

---

## Nachtrag 6 — überlebt der Stempel den WindowServer? (Vorarbeit zu Aufgabe 5)

Die Offen-Liste oben führte den Stempel als unbelegt: gesetzt wird er, aber ob
`kCGEventSourceUserData` unverändert bis zu einem Mithörer durchläuft, konnte
Aufgabe 4 nicht zeigen. **Daran hängt die Wache aus Aufgabe 5** — erkennt sie
die eigene Spur nicht wieder, hält sie die Fremdeingabe für den Host, löst den
Vorrang aus und sperrt den Steuernden mit seiner ersten Mausbewegung dauerhaft
aus.

**Aufbau:** `examples/pruef_stempel.rs` (Wegwerf-Prüfling) injiziert über den
echten `MacInjektor` alle Ereignisarten und liest sie an **zwei** hörenden
Abgriffen (`CGEventTapCreate`, ListenOnly) zurück.

**Und der zweite Abgriff ist der ganze Punkt.** Injiziert wird auf
`kCGHIDEventTapLocation`. Ein Abgriff an *derselben* Stelle sieht das Ereignis,
**bevor** der WindowServer es angefasst hat — er beantwortet die gestellte
Frage also gar nicht. Die erste Fassung des Prüflings hing genau dort und sah
13 von 13 Marken; das sah nach einem Beleg aus und war keiner. Die Wache soll
laut Plan auf `kCGSessionEventTap` sitzen, also **dahinter**. Gemessen wurde
deshalb an beiden Stellen gleichzeitig, im selben Lauf.

**Ergebnis:**

| Ereignis (CGEventType) | HID (davor) | Session (dahinter) |
|---|---|---|
| LeftMouseDown/Up (1, 2) | 2/2 mit Marke | **2/2 mit Marke** |
| MouseMoved (5) | 1/1 | **1/1** |
| LeftMouseDragged (6) | 1/1 | **1/1** |
| KeyDown/Up (10, 11) | 2/2 | **2/2** |
| FlagsChanged (12) | 2/2 | **2/2** |
| ScrollWheel (22) | 1/1 | **1/1** |
| OtherMouseDown/Up (25, 26) | 2/2 | **2/2** |
| OtherMouseDragged (27) | 1/1 | **1/1** |

**Befund: der Stempel übersteht den WindowServer.** 13 von 13 injizierten
Ereignissen tragen `PULSE_MARKE` auch an der Session-Position — einschliesslich
der beiden Arten, die macOS selbst umformt (`FlagsChanged` aus einem
Tastencode, `*Dragged` aus einer Bewegung bei gedrücktem Knopf).

Das einzige markenlose Ereignis ist ein `NullEvent` (Typ 0), das an **beiden**
Stellen gleich auftaucht — Fremdrauschen, keine verlorene Marke.

**Folge für Aufgabe 5:** Die Erkennung `kCGEventSourceUserData == PULSE_MARKE`
trägt an der vorgesehenen Stelle. Kein Ausweichen auf einen zweiten Merkmalsweg
nötig.

**Eine Falle für spätere Prüflinge:** wer eigene Injektion mit einem Abgriff an
der Injektionsstelle prüft, misst den Stempel gegen sich selbst. Die Stelle des
Mithörers muss die des echten Verbrauchers sein, sonst ist ein grünes Ergebnis
wertlos.
