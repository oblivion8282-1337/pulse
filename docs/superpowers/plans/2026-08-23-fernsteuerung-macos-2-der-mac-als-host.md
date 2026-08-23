# Fernsteuerung macOS, Plan 2: Der Mac als Host — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein macOS-Rechner lässt sich fernsteuern — Maus, Tastatur, Rad, mit Vorrang des Hosts. Nach diesem Plan kann jemand im Sprachkanal die Übernahme eines Macs anfragen, der Host stimmt zu, und die Eingabe kommt an.

**Architecture:** Der plattformfreie Kern liegt seit den Etappen 2 und 2b in `streaming/pulse-fernsteuerung` (146 Tests). Der mac-Sidecar setzt die drei Traits um — `Injektor` über `CGEventPost`, `Wache` über einen hörenden `CGEventTap`, `Umgebung` über `CGDisplayBounds`/`SCWindow.frame` — und beantwortet zwei neue stdio-Ops. Der Renderer schaltet von „ist das Windows?" auf „kann dieser Rechner es?".

**Tech Stack:** Rust (edition 2024), `objc2-core-graphics` (bereits Abhängigkeit, drei Merkmale zuzuschalten), `streaming/pulse-fernsteuerung`. Der mac-Sidecar **baut auf dieser Maschine** — anders als der Windows-Sidecar ist hier alles wirklich prüfbar.

**Nicht in diesem Plan:** der Zeiger (Cursor-Echo, Form, Bild) und das Standplatz-Gerät. Beide sind eigene Etappen, beide für sich prüfbar und für sich zu landen. Ohne sie funktioniert die Fernsteuerung; der Steuernde sieht nur den Host-Zeiger im Bild statt seines eigenen.

## Was schon gemessen ist

`docs/plans/2026-08-23-macos-eingabe-messungen.md` — an der echten Maschine, macOS 15.7.3. **Diese vier Befunde sind Tatsachen, keine Annahmen:**

| Befund | Folge für diesen Plan |
|---|---|
| macOS zählt Doppelklicks **nicht** selbst | Der Injektor braucht einen Klickzähler (Task 4) |
| Die Umschalttasten-Kennzeichnung wird **nicht** gefüllt | Der Injektor muss `CGEventSetFlags` selbst setzen — **und `Injektor::taste` bekommt die Gedrückt-Menge dafür heute nicht** (Task 1) |
| „Natürliches Scrollen" wirkt **nicht** auf injizierte Ereignisse | Keine Gegenrechnung beim Rad |
| Der Kindprozess **erbt** die Accessibility-Freigabe | Die Abfrage darf im Electron-Hauptprozess sitzen; der Nutzer gibt „Pulse" frei |

## Global Constraints

- **Testwerte müssen richtig und falsch trennen — und das ist zu belegen, nicht zu behaupten.** In den Etappen 2 und 2b waren **fünf** Tests grün, weil ihre Werte bei der falschen Umsetzung dasselbe lieferten; keiner fiel beim Lesen auf, alle fünf bei Mutationsproben. **Jede Aufgabe dieses Plans fährt ihre eigenen Mutationsproben und schreibt die Ergebnisse in den Bericht.** Seit das im Auftrag des Umsetzenden steht statt nur beim Prüfer, kommen die Aufgaben deutlich sauberer durch.
- **Der mac-Sidecar baut hier.** `cd streaming/mac-hq-sidecar && cargo test` — es gibt keine Ausrede, etwas nur zu lesen. Braucht `PKG_CONFIG_PATH=$HOME/src/ffmpeg-openssl/lib/pkgconfig`.
- **Der Windows-Sidecar baut hier NICHT.** Task 1 fasst ihn an; Nachweis ist der zeilenweise Vergleich plus ein `win-build`-Lauf auf dem Zweig.
- Die Kiste `pulse-fernsteuerung` darf `serde_json` und Pfad-Abhängigkeiten auf Schwesterkisten haben — **keine weitere Abhängigkeit ohne Rückfrage**. `objc2-core-graphics` steht bereits in `mac-hq-sidecar`; dort sind nur Merkmale zuzuschalten, das ist keine neue Abhängigkeit.
- **Verhalten der bestehenden Plattformen darf sich nicht ändern.** Task 1 ist die einzige Aufgabe, die Windows berührt.
- Kommentare auf Deutsch, im Schriftbild der jeweiligen Datei. Keine Emojis. Commit-Nachrichten mit echten Umlauten (ä/ö/ü/ß).
- Quelldateien ≤ 350 Zeilen (hart 500), Tests ausgenommen.
- Kein `git push` und **kein Merge** ohne Freigabe.

## Dateien

Neu unter `streaming/mac-hq-sidecar/src/`: `remote_input/{mod,injektion,tasten,klickzaehler,wache,ziel}.rs`, `ops/remote_input.rs`, `ops/remote_input_end.rs`, `berechtigung.rs`.
Geändert: `streaming/pulse-fernsteuerung/src/{plattform,ausfuehrung}.rs` (Task 1), `streaming/win-hq-sidecar/src/remote_input/mod.rs` (Task 1), `streaming/mac-hq-sidecar/{Cargo.toml,src/{lib,dispatch,main}.rs,src/ops/{mod,health}.rs,src/stream_controller.rs}`, `web/src/lib/remote/{darfStandplatzSein.ts,session.svelte.ts}`, `desktop/electron/{main,preload}.ts`, `web/src/lib/platform/pulse.d.ts`.

---

### Task 1: Die Gedrückt-Menge an `Injektor::taste`

Die Messung hat eine Lücke im Trait aufgedeckt, die beim Entwerfen nicht auffiel. Sie wird geschlossen, **bevor** der mac-Injektor entsteht — sonst baut er sich eine zweite Buchführung, die niemand räumt.

**Files:**
- Modify: `streaming/pulse-fernsteuerung/src/plattform.rs`, `.../src/ausfuehrung.rs`, `.../src/pruefstand.rs`
- Modify: `streaming/win-hq-sidecar/src/remote_input/mod.rs`

**Interfaces:**
- Produces: `Injektor::taste(&self, scan: u16, down: bool, gedrueckt: &Druck)`

- [ ] **Step 1: Den Grund an die Trait-Methode schreiben**

Nachgemessen am 2026-08-23: nach einem echten Cmd-Runter bleibt die Zwischenablage bei Cmd+C **unverändert**; erst mit `.maskCommand` auf den C-Ereignissen kommt der Text an. macOS füllt die Kennzeichnung also nicht selbst, und der Injektor braucht dafür dieselbe Menge, die `maus_setzen` schon bekommt.

Der Doc-Kommentar muss das tragen — samt der Warnung vor der Alternative: eine eigene Modifikator-Buchführung im Injektor wäre eine Kopie dessen, was `Druck` schon weiss, und müsste bei jedem Sitzungsende gesondert geräumt werden.

- [ ] **Step 2: Die Reihenfolge prüfen und festhalten**

`ausfuehrung` ruft heute erst `injektor.taste(...)` und schreibt **danach** `z.druck.taste(...)` fort. Beim Cmd-Runter selbst ist die Taste also noch **nicht** in der Menge, wenn der Injektor sie sieht.

**Ob ein Cmd-Runter-Ereignis seine eigene Kennzeichnung tragen muss, ist ungemessen.** Ändere die Reihenfolge **nicht** — sie ist gewollt (der Injektor sieht den Zustand *vor* seiner eigenen Wirkung, wie bei `maus_setzen`). Halte die offene Frage stattdessen als Kommentar fest; Task 4 misst sie.

- [ ] **Step 3: Tests der Kiste anpassen, nicht abschwächen**

Der Prüfstand zeichnet `Ereignis::Taste { scan, down }` auf. Nimm die Gedrückt-Menge in die Aufzeichnung mit auf (etwa als `mods: Vec<u16>`), damit ein Test belegen kann, dass sie beim Injektor **ankommt** — sonst ist die Trait-Änderung von keinem Test gedeckt.

Mutationsprobe: leere Menge statt der echten übergeben. Muss rot werden.

- [ ] **Step 4: Windows nachziehen**

`WinInjektor::taste` ignoriert die Menge (Windows füllt die Kennzeichnung selbst — das ist der Unterschied, der die Trait-Änderung überhaupt nötig macht). Ein `_gedrueckt` mit einem Satz Begründung.

- [ ] **Step 5: Abnahme und Commit**

`cd streaming/pulse-fernsteuerung && cargo test && cargo doc --no-deps`. Der Windows-Nachweis kommt in Task 9.

---

### Task 2: Tastentabelle Satz 1 → `kVK_*`

**Files:** Create `streaming/mac-hq-sidecar/src/remote_input/tasten.rs`

**Interfaces:** Produces `tasten::virtualcode(scan: u16) -> Option<u8>`

- [ ] **Step 1: Den Prüfstein zuerst schreiben**

`pulse_fernsteuerung::format::SATZ1_TASTEN` führt **jeden** Scancode, den ein Sender erzeugen darf — 104 Einträge, gefüllt aus der Spielertabelle. Der Test steht **vor** der Tabelle:

```rust
    /// **Der Prüfstein kommt vom Sender.** Zu jedem Scancode, den ein
    /// Steuernder schicken kann, muss dieser Injektor ein Ziel haben — sonst
    /// verschluckt der Mac stillschweigend Tasten, die auf Windows ankommen.
    #[test]
    fn jeder_gesendete_scancode_hat_ein_ziel() {
        for &scan in pulse_fernsteuerung::format::SATZ1_TASTEN {
            assert!(
                virtualcode(scan).is_some(),
                "{scan:#06x} steht im Vokabular, hat hier aber kein Ziel"
            );
        }
    }

    /// Und keine zwei Scancodes dürfen auf denselben Virtualcode zeigen — eine
    /// Doppelung wäre eine Taste, die als eine andere ankommt, und das fällt
    /// beim Lesen nicht auf.
    #[test]
    fn kein_virtualcode_doppelt() {
        let mut gesehen = std::collections::BTreeMap::new();
        for &scan in pulse_fernsteuerung::format::SATZ1_TASTEN {
            let vk = virtualcode(scan).expect("Ziel vorhanden");
            if let Some(anderer) = gesehen.insert(vk, scan) {
                panic!("{vk:#04x} doppelt: {anderer:#06x} und {scan:#06x}");
            }
        }
    }
```

- [ ] **Step 2: Fehlschlag belegen**

Run: `cd streaming/mac-hq-sidecar && cargo test tasten`
Expected: FAIL — die Tabelle gibt es noch nicht.

- [ ] **Step 3: Die Tabelle schreiben**

Satz 1 → `kVK_*` (Carbon `HIToolbox/Events.h`). Die Erweiterungs-Scancodes (`0xE0xx`) sind der Teil, an dem geraten wird: Pfeiltasten, rechte Umschalttasten, Ziffernblock-Enter, Pos1/Ende/Bild. Schreib zu jedem `0xE0`-Eintrag den Tastennamen als Kommentar dahinter.

**Nicht abbildbare Codes liefern `None`** und werden vom Injektor still verworfen — nicht geraten. Aber: der Prüfstein aus Step 1 verlangt, dass **jeder** Eintrag des Vokabulars ein Ziel hat; ein `None` dort ist ein Befund, kein Freibrief.

- [ ] **Step 4: Grün, dann committen**

---

### Task 3: Die Berechtigung

**Files:** Create `streaming/mac-hq-sidecar/src/berechtigung.rs`; Modify `.../src/ops/health.rs`

**Interfaces:** Produces `berechtigung::darf_einspielen() -> bool`

- [ ] **Step 1: Die Abfrage**

`AXIsProcessTrustedWithOptions` mit `kAXTrustedCheckOptionPrompt = false`. **Nie mit `true`** — ein Sidecar, der beim Gesundheitscheck einen Systemdialog aufwirft, ist eine Zumutung; der Anstoß gehört in den Electron-Hauptprozess (Task 8).

`ApplicationServices` ist nicht in `objc2-core-graphics`; deklariere die Funktion als `extern "C"` und verlinke das Framework — dasselbe Muster, das `capture/mod.rs` schon für `CFRelease` und `getppid` benutzt.

- [ ] **Step 2: `health` meldet die Fähigkeit — live, nicht fest**

Der Windows-Sidecar meldet `"remote_input": true` **fest**, weil das Op zu seinem Programm gehört. Auf dem Mac ist das falsch: die Freigabe kann jederzeit entzogen werden. Also:

```rust
        // **Live geprüft, nicht behauptet.** Anders als auf Windows haengt die
        // Faehigkeit hier an einer Freigabe, die der Nutzer jederzeit
        // zurueckziehen kann. Ein festes `true` liesse einen Mac als
        // fernsteuerbar erscheinen, dessen zugestimmte Sitzung beim ersten
        // Frame wortlos stuerbe.
        "remote_input": crate::berechtigung::darf_einspielen(),
```

- [ ] **Step 3: Was hier NICHT getestet werden kann, und was doch**

Der Rückgabewert hängt am Zustand der Maschine — ein Test darauf wäre eine Wette auf die Entwicklermaschine. **Testbar ist das Drumherum:** dass `health` das Feld überhaupt führt, und dass es ein Bool ist. Schreib beides, und schreib in den Test, warum der Wert selbst nicht geprüft wird.

- [ ] **Step 4: Committen**

---

### Task 4: Der Injektor

Das Kernstück. Drei der vier Messbefunde landen hier.

**Files:** Create `streaming/mac-hq-sidecar/src/remote_input/{injektion,klickzaehler}.rs`; Modify `streaming/mac-hq-sidecar/Cargo.toml`

**Interfaces:**
- Produces: `MacInjektor` (setzt `pulse_fernsteuerung::plattform::Injektor` um)
- Produces: `klickzaehler::Klickzaehler` mit `zaehle(&mut self, punkt, jetzt_ms) -> i64`

- [ ] **Step 1: Merkmale zuschalten**

In `streaming/mac-hq-sidecar/Cargo.toml` bei `objc2-core-graphics` die Merkmale `CGEvent`, `CGEventSource`, `CGEventTypes` ergänzen. **Keine neue Abhängigkeit** — die Kiste steht bereits da, es fehlen nur die Bindungen.

- [ ] **Step 2: Der Klickzähler zuerst, als reine Rechnung**

**Gemessen:** macOS zählt nicht selbst. Ohne `kCGMouseEventClickState = 2` beim zweiten Klick bleibt es bei der Einfügemarke.

Reine Funktion, ohne CoreGraphics, damit sie prüfbar ist:

```rust
    /// Der wievielte Klick ist das? macOS zaehlt **nicht** selbst (gemessen
    /// 2026-08-23) — ohne diese Zahl gibt es kein Doppelklick-Markieren, und
    /// zwar ohne dass irgendetwas fehlschlaegt.
    ///
    /// Zwei Fenster, wie das System sie fuer echte Maeuse benutzt: ein
    /// zeitliches (`NSEvent.doubleClickInterval`, Vorgabe 500 ms) und ein
    /// oertliches — ein Klick weit weg vom vorigen beginnt neu, auch wenn er
    /// schnell kommt.
    pub fn zaehle(&mut self, punkt: (i32, i32), jetzt_ms: u64) -> i64
```

Tests, und **die Werte müssen trennen**:

```rust
    #[test] fn der_erste_klick_ist_einer() { … }
    #[test] fn zwei_schnelle_am_selben_ort_sind_zwei() { … }
    #[test] fn nach_der_frist_beginnt_es_von_vorn() { … }
    /// Der Fall, den ein Zeitfenster allein nicht traegt: schnell, aber
    /// woanders. Ohne Orts-Fenster zaehlte ein Zieh-und-Klick als Doppelklick.
    #[test] fn schnell_aber_weit_weg_ist_wieder_einer() { … }
    /// Und die Kette bricht nicht bei zwei ab.
    #[test] fn drei_schnelle_sind_drei() { … }
```

**Mutationsproben, die zu fahren sind:** Orts-Fenster weglassen; Zeitfenster weglassen; bei 2 deckeln. Alle drei müssen rot werden.

- [ ] **Step 3: Der Injektor**

Eine `CGEventSource` einmal (`kCGEventSourceStateHIDSystemState`), jedes Ereignis mit `kCGEventSourceUserData = PULSE_MARKE` gestempelt, abgefeuert auf `kCGHIDEventTapLocation`.

Die drei Stellen, an denen macOS von Windows abweicht:

**Ziehen ist ein eigener Ereignistyp.** `maus_setzen` bekommt die Gedrückt-Menge; ist ein Knopf unten, geht die Bewegung als `LeftMouseDragged`/`RightMouseDragged`/`OtherMouseDragged`, sonst als `MouseMoved`. Bei mehreren gedrückten Knöpfen entscheidet der **kleinste** — `Druck::knoepfe_unten()` liefert sortiert, genau dafür.

**Der Klickzähler** aus Step 2 setzt `kCGMouseEventClickState`.

**Die Umschalttasten-Kennzeichnung** (gemessen: wird nicht gefüllt) baut sich aus der Gedrückt-Menge, die `taste` seit Task 1 bekommt: Scancodes der Umschalttasten → `CGEventFlags`. Setz sie auf **Tasten- und Maus**-Ereignisse; ein Cmd-Klick ist so verbreitet wie ein Cmd-C.

**Das Rad** (gemessen: keine Gegenrechnung nötig) über `CGEventCreateScrollWheelEvent2` mit Zeileneinheit, eine Windows-Raste (120) = eine Zeile.

- [ ] **Step 4: Die offene Frage aus Task 1 messen**

Trägt ein Cmd-**Runter**-Ereignis seine eigene Kennzeichnung? Bau den Prüfling, miss es, schreib das Ergebnis in `docs/plans/2026-08-23-macos-eingabe-messungen.md` als Nachtrag. Danach steht im Code, was gemessen ist — nicht, was plausibel wirkt.

- [ ] **Step 5: Grenzen dokumentieren**

Gegenstück zu Strg+Alt+Entf auf Windows: Cmd+Tab und Mission Control gehen an den WindowServer; ein sicheres Eingabefeld (`EnableSecureEventInput`) sperrt die Tastatur aus. Das gehört in den Modulkopf, nicht in ein Ticket.

- [ ] **Step 6: Abnahme und Commit**

---

### Task 5: Die Wache

**Files:** Create `streaming/mac-hq-sidecar/src/remote_input/wache.rs`

- [ ] **Step 1: Der Tap**

`CGEventTapCreate` **hörend** (`kCGEventTapOptionListenOnly`) auf `kCGSessionEventTap`, eigener Faden mit eigener CFRunLoop, gestoppt über `CFRunLoopStop`. Beobachtet: Bewegung, alle Maustasten, Rad, Tastendrücke, Flag-Wechsel.

Die eigene Spur wird an `kCGEventSourceUserData == PULSE_MARKE` erkannt — das exakte Gegenstück zu `dwExtraInfo`. **Ohne diese Erkennung sperrt sich die Fernsteuerung mit ihrer ersten Mausbewegung selbst aus.**

**Fremde** Injektion gilt bewusst als Host, wie auf Windows: ein Fehlalarm kostet fünf Sekunden und heilt von selbst, ein verpasster Alarm kostet den Host die zugesagte Übernahme seines Rechners.

- [ ] **Step 2: Die Bewegungsschwelle kommt aus der Kiste**

`pulse_fernsteuerung::bewegung::zaehlt` — **nicht neu schreiben.** Die Falle, die dort im Kommentar steht, gilt auf macOS genauso: die eigene Injektion muss die Vergleichslage **nachtragen, ohne zu zählen**, sonst misst die Schwelle den Abstand zwischen zwei Zeigern und jeder Tischstoß löst aus.

- [ ] **Step 3: Der Vorteil gegenüber Windows — und er ist zu nutzen**

macOS meldet das Abhängen eines zu langsamen Taps als `kCGEventTapDisabledByTimeout` **im Rückruf**; `CGEventTapEnable` stellt ihn wieder her. Windows sagt es nie — dort steht im Code „ein Restrisiko bleibt und ist hier notiert statt weggeschwiegen". Hier lässt es sich schließen. Tu es, und schreib hin, dass es der Unterschied zu Windows ist.

- [ ] **Step 4: Der Wecker**

Die Plattform muss `Sitzung::vorrang_tick()` alle 100 ms treiben (`pulse_fernsteuerung::frist::WECKER_MS`) — der Vertrag steht im `Wache`-Trait. **Auf einem eigenen Faden**, nicht im Tap-Rückruf: die Folgen eines Übergangs sind kein Nichts, und ein beschäftigter Rückruf wird abgehängt.

- [ ] **Step 5: Ohne Freigabe keine Wache, ohne Wache keine Sitzung**

`CGEventTapCreate` scheitert ohne Accessibility. `Wache::starten()` liefert dann `Err`, und der Handschlag verweigert die Sitzung — dieselbe Linie wie bei HDR: unerfüllbar heisst Startverweigerung, nicht still etwas Schwächeres. **Kein Zusatzcode nötig**, aber ein Test, der belegt, dass der Fehler wirklich durchgereicht wird.

- [ ] **Step 6: Abnahme und Commit**

---

### Task 6: Ziel und Stream-Registrierung

**Files:** Create `streaming/mac-hq-sidecar/src/remote_input/ziel.rs`; Modify `.../src/stream_controller.rs`, `.../src/ops/start.rs`

- [ ] **Step 1: Punkte, nicht Pixel**

Die Aufnahme läuft in Pixeln, `CGEventPost` will **Punkte** im globalen Anzeigeraum (Ursprung oben links der Hauptanzeige — **nicht** die AppKit-Rechnung von unten links). Das Quell-Rechteck kommt deshalb aus `CGDisplayBounds` bzw. `SCWindow.frame`, **nie** aus der Aufnahmegröße. Die Anteilsrechnung der Kiste rettet den Rest.

Schreib die beiden Koordinatensysteme in den Modulkopf. Wer sie verwechselt, bekommt Klicks, die vertikal gespiegelt sind — und das sieht aus wie ein Fehler in der Klemmung.

- [ ] **Step 2: Die Slot-Regeln kommen aus der Kiste**

`pulse_fernsteuerung::slot::{SLOT_MAX, im_bereich, traegt_slot}`. Der mac-`start` liest heute keinen `slot`; damit gilt die Regel „ein Stream ohne erklärten Platz trägt jeden Platz" — dieselbe wie auf Windows, aus demselben Grund.

- [ ] **Step 3: Registrierung an den Lebenszyklus hängen**

`StreamController::start` meldet den Strom an, das Ende meldet ihn ab. **Achtung, anders als Windows:** der mac-Sidecar bleibt zwischen Streams warm (kein frischer Prozess je Stream). Ein vergessenes Abmelden lässt die Fernsteuerung auf einen Stream zielen, den es nicht mehr gibt — auf Windows räumt das der Prozesswechsel nebenbei ab, hier nicht.

Schreib einen Test, der genau das belegt: anmelden, abmelden, und die Auflösung muss danach „kein Strom" liefern.

- [ ] **Step 4: Abnahme und Commit**

---

### Task 7: Die beiden Ops

**Files:** Create `streaming/mac-hq-sidecar/src/ops/remote_input{,_end}.rs`; Modify `.../src/dispatch.rs`, `.../src/ops/mod.rs`, `.../src/remote_input/mod.rs`, `.../src/main.rs`

- [ ] **Step 1: Die Hülle kommt aus der Kiste**

`pulse_fernsteuerung::huelle` — Grenzen, Slot-Prüfung, Frames. **Nicht neu schreiben:** darin stecken zwei Fehler, die im Projekt schon einmal passiert sind (`slot: "0"` lief still auf Platz 0; kaputtes Base64 legte die Sitzung nicht still).

Beim Sidecar bleibt nur `handle()` — Sitzung holen, Fehler hüllen, Antwortkarte bauen. Zehn Zeilen.

- [ ] **Step 2: Die Sitzung als Prozess-Singleton**

`Sitzung::neu(&INJEKTOR, &WACHE, &UMGEBUNG)` in einem `OnceLock`, wie im Windows-Sidecar. Und **das Prozessende muss `beenden_endgueltig()` rufen** (`main.rs`) — sonst stirbt der Prozess mit einer physisch gedrückten Taste, und niemand ist mehr da, der sie löst.

- [ ] **Step 3: Abnahme und Commit**

---

### Task 8: Renderer und Berechtigungs-Ablauf

**Files:** Modify `web/src/lib/remote/darfStandplatzSein.ts`, `web/src/lib/remote/session.svelte.ts`, `desktop/electron/{main,preload}.ts`, `web/src/lib/platform/pulse.d.ts`

- [ ] **Step 1: Fähigkeit statt Plattform**

`darfStandplatzSein.ts` prüft `window.pulse?.os === 'win32'`, `session.svelte.ts` prüft `isWindows()`. Beides wird durch die **Fähigkeit** ersetzt (`stream.fernsteuerbar`, gespeist aus `health.gsr.remote_input`), nicht um `'darwin'` erweitert.

Der Grund steht im Kopf von `darfStandplatzSein.ts` und gilt weiter: ein Rechner, der sich als „bereit" meldet und jede Übernahme ins Leere laufen lässt, ist schlimmer als gar keiner — der Fehler wird dann im Server gesucht. Auf dem Mac ist die Fähigkeit zusätzlich **wechselhaft**: die Freigabe kann entzogen werden.

- [ ] **Step 2: Der Anstoß zur Freigabe**

`systemPreferences.isTrustedAccessibilityClient(prompt)` im Electron-Hauptprozess, über eine neue IPC hinter `window.pulse`. **Gemessen:** der Kindprozess erbt die Freigabe des startenden Programms — der Dialog nennt also „Pulse" und nicht einen Binärnamen.

`preload.ts` und `pulse.d.ts` **synchron halten** — das steht so in CLAUDE.md.

- [ ] **Step 3: Der Text muss den ganzen Weg nennen**

Die Freigabe hängt an der Code-Signatur, und das mac-DMG ist nur ad-hoc signiert. Nach einem Update gilt sie nicht mehr — **und der Haken bleibt dabei sichtbar stehen.** Der Text muss deshalb sagen: Eintrag entfernen **und neu hinzufügen**, nicht nur „Freigabe erteilen". Wer das nicht weiss, klickt den bestehenden Haken an und wundert sich.

- [ ] **Step 4: `pnpm check` und `pnpm test:unit`, dann Commit**

---

### Task 9: Abnahme

- [ ] **Step 1: Das Prüfziel**

Ein Vollbild-Fenster, das empfangene Ereignisse protokolliert, plus der Labor-Schalter `PULSE_LABOR_EINGABE_OHNE_STREAM` (Gegenstück zum Windows-Labor). Messlatte wie dort am 2026-08-12: **0 px auf 8 Zielen, Scancodes identisch.**

**Die Windows-Lehre kommt mit:** das Prüfziel muss **positiv** prüfen, dass es obenauf liegt. Dort schluckte ein Systemdialog jede Injektion, und der Lauf sah aus wie „Injektor tot".

- [ ] **Step 2: Der Windows-Nachweis für Task 1**

`gh workflow run win-build.yml --ref <zweig>`, grün abwarten. Task 1 ist die einzige Aufgabe, die Windows berührt.

- [ ] **Step 3: Zwei-Geräte-Test**

Nach `docs/plans/2026-08-12-zwei-geraete-test-aufbau.md`, diesmal mit dem Mac als Host. Das ist der erste Lauf, bei dem wirklich jemand einen Mac fernsteuert.

- [ ] **Step 4: Changelog**

**Jetzt ist einer fällig** — anders als bei den Etappen 2 und 2b ändert sich hier etwas, das ein Nutzer bemerkt: Macs lassen sich fernsteuern. Sachlich, ohne Emojis, mit echten Umlauten, Stil vom Nutzer wählen lassen.

- [ ] **Step 5: Version-Bump**

**Hier ja** — anders als bei den reinen Umschichtungen. Der Windows-Installer liefert `pulse-fernsteuerung` mit, und Task 1 ändert daran etwas, das Bestandsclients erreichen soll. `desktop/package.json`.

## Danach

Etappe 4 (der Zeiger: Echo, Form, Bild, Rückfall) und Etappe 5 (Standplatz-Gerät). Beide sind eigene Pläne.
