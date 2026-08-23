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
