# Fernsteuerung macOS, Etappe 4: Der Zeiger — Umsetzungsplan

Echo, Form, Bild, Rückfall. Grundlage: `docs/superpowers/specs/2026-08-22-fernsteuerung-macos-design.md` §6.

**Ausgangslage:** Etappe 1 hat die plattformfreie Hälfte schon herausgezogen — `pulse-fernsteuerung::zeigerschalter` (150 Z.) und `::zeigerbuch` (708 Z.), beide mit Tests, beide auf jeder Maschine lauffähig. Diese Etappe füllt die **Plattform-Hälfte** und zwei heute leere Trait-Funktionen. Sie schreibt keine Buchführung neu.

## Was schon entschieden und gemessen ist

Nicht neu verhandeln, es steht im Entwurf mit Messung:

- **`NSCursor.currentSystemCursor` trägt prozessübergreifend** (gemessen auf macOS 15.7.3: der Prüfling las den I-Balken des Terminals, 9×18, Aufhängepunkt 4,9) — ist aber **abgekündigt**; der Header sagt wörtlich, die Eigenschaft werde künftig immer `nil` liefern.
- **Die Namensübertragung ist auf macOS tot.** `+[NSCursor arrowCursor]` und `+[NSCursor IBeamCursor]` liefern **selbst `nil`** — es kommt gar nicht bis zum Bild. Ausgerechnet die beiden häufigsten Formen sind nicht wiedererkennbar. (Nachgemessen 2026-08-23; die frühere Formulierung „liefern Größe (0,0)" reproduzierte nicht.) **Der Mac schickt deshalb immer das BILD**, nie den Namen. Das dreht den Windows-Entwurf um, und zwar begründet.
- **Die private CGS-Schnittstelle ist verworfen** (§2.1) — vorhanden, wäre strukturell exakt der Windows-Weg, ist aber undokumentiert und bräche beim Nutzer statt beim Bau. Nicht wiederentdecken.
- **Einfache Auflösung, nicht doppelte.** winit skaliert eigene Zeiger nicht mit; ein 2x-Bild erschiene beim Steuernden doppelt groß, und der 5900-Byte-Trichter würde eng.

## Global Constraints

- **Testwerte müssen richtig und falsch trennen — und das ist zu belegen, nicht zu behaupten.** In Etappe 2 überlebten drei Mutationen, weil ihre Tests von der Hardware des Entwicklerrechners abhingen (16:9-Schirm, beide Freigaben erteilt). **Jede Aufgabe fährt ihre eigenen Mutationsproben und schreibt die Ergebnisse in den Bericht.** Wo eine Prüfung nur auf dieser Maschine grün wäre, gehört die Entscheidung in eine reine Funktion mit Argumenten.
- **Erst in den Zwillingen nachsehen.** Etappe 2 hat **drei** Fehler gefunden, die auf einer anderen Plattform längst behoben und im Code kommentiert waren (blockierter Strom-Platz, gestauchte Aufnahme, ignorierte Kurznamen). Wer hier etwas baut, das Windows schon hat, liest zuerst dessen Kommentare.
- **Keine neuen Fremdabhängigkeiten.** AppKit wird nur verlinkt, die zwei Selektoren gehen über den vorhandenen `objc2`-Laufzeitaufruf.
- Deutsche Kommentare (ae/oe/ue im mac-Sidecar, echte Umlaute in Commit-Nachrichten), **keine Emojis**, kein `git push`.

## Dateien

| Datei | |
|---|---|
| `mac-hq-sidecar/src/remote_input/zeigerform.rs` | **neu** — die Abfrage |
| `mac-hq-sidecar/src/remote_input/zeigerpunkte.rs` | **neu** — NSImage → RGBA |
| `mac-hq-sidecar/src/capture/cursorsteuerung.rs` | **neu** — `Schalter` + `updateConfiguration` |
| `mac-hq-sidecar/src/remote_input/mod.rs` | die zwei leeren Trait-Funktionen füllen |
| `mac-hq-sidecar/src/capture/mod.rs` | Zugriff auf den laufenden `SCStream` |
| `services/chat-gateway/.../ws_remote_handlers.py` | `_SIGNAL_KINDS` += `zeiger_im_bild` |
| `web/src/lib/ws/handlers/types.ts` | `RemoteSignalKind` |
| `web/src/lib/remote/zeigerform.ts` | das neue Signal weiterreichen |
| `pulse-player/src/app/eingabe.rs` | lokalen Zeiger ausblenden |

---

### Task 1: Das Echo — `showsCursor` am laufenden Strom

- [ ] `capture/cursorsteuerung.rs`: den `Schalter` aus der gemeinsamen Kiste halten und seine `Wirkung` in `SCStream.updateConfiguration:completionHandler:` übersetzen. `block2` ist bereits als Merkmal gesetzt.
- [ ] `Umgebung::host_zeiger_zeigen` in `remote_input/mod.rs` darauf verdrahten (heute ein dokumentiertes Nichts-Tun).

**Die Zusage, die der `Schalter` schon trägt und die nicht umgangen werden darf:** *nie über den Ausgangszustand hinaus.* Wer ohne Zeiger streamt, bekommt durch die Fernsteuerung keinen. Der Schalter kennt das als `basis_sichtbar`.

**Mutationsproben:** Wirkung `Nichts` trotzdem ausführen; `gescheitert` als Erfolg buchen; `basis_sichtbar=false` ignorieren. Alle drei müssen rot werden.

**Achtung — die Reihenfolge ist Windows abgeschaut:** gebucht wird erst, wenn der Plattform-Aufruf gelungen ist (`gelungen`), sonst hält der Sidecar den Zeiger für verborgen, während er im Bild steht.

### Task 2: Die Abfrage — `NSCursor.currentSystemCursor`

- [ ] `remote_input/zeigerform.rs`: zwei Selektoren über den vorhandenen `objc2`-Laufzeitaufruf, AppKit nur verlinkt.
- [ ] Gelesen wird am **Wecker der Wache**, kein eigener Faden — wie auf Windows.
- [ ] **Nie am Objekt festhalten.** Windows' Lehre gilt hier genauso: gemerkt wird nur das *Ergebnis* (Kennung → gebautes Bild), nie das Systemobjekt.

**Mutationsprobe:** Abfrage-Ergebnis zwischenspeichern statt frisch lesen. Muss rot werden.

### Task 3: Die Pixel — NSImage → `pulse-zeigerbild`

- [ ] `remote_input/zeigerpunkte.rs`: Bitmap in RGBA, **einfache** Auflösung.
- [ ] **Vorvervielfachung zurückrechnen.** Der Entwurf (§ zu `zeigerpunkte.rs`) hält fest, dass dieselbe Rechnung wie auf Windows gilt: CGImage-Zeigerbitmaps sind ebenso vorvervielfacht, winit verlangt das Gegenteil. Ohne Rückrechnung schmutzige Ränder. **`entvielfachen` steht schon in der Windows-Fassung** — erst dort nachsehen, ob es in die gemeinsame Kiste gehört.
- [ ] Kennung per FNV-1a über die Pixel, Bau der Läufe über `pulse-zeigerbild` (nicht neu schreiben).

**Mutationsproben:** Rückrechnung weglassen; doppelte statt einfache Auflösung; Alpha ignorieren. Alle rot.

**Der 5900-Byte-Trichter ist echt** — `MAX_LAEUFE_BYTE` steht im Format, nicht beim Sender, und was nicht passt, wird **gar nicht** geschickt.

### Task 4: Die Buchführung anbinden

- [ ] `Zeigerbuch` (gemeinsame Kiste) je Sitzung halten, am Wecker `nachricht(&Stand)` rufen und das Ergebnis als `remote_signal` `kind:"zeiger"` einreihen — **außerhalb der Sperre**.
- [ ] `Stand::Eigen(bild)` im Regelfall, `Stand::Name(VORGABE)` bei **Vorrang des Hosts** (wie Windows).
- [ ] Wiederholung je Sekunde: der Gateway-Deckel verwirft still, und ein verlorener Wechsel bliebe sonst für den Rest der Sitzung falsch.

**Nichts an `Zeigerbuch` ändern.** Wer hier etwas vermisst, prüft zuerst, ob es die Windows-Seite auch braucht.

### Task 5: Der Rückfall — `zeiger_im_bild`

Das Stück, das die Funktion **altern statt ausfallen** lässt, wenn Apple die Abfrage abschaltet.

- [ ] Liefert die Abfrage `nil` oder ein leeres Bild: `showsCursor = true` **und** ein neues Signal `kind:"zeiger_im_bild"` an den Steuernden.
- [ ] Dessen Player blendet daraufhin seinen **lokalen** Zeiger aus — der Host-Zeiger reitet im Video mit, ist von Natur aus formrichtig und läuft der Hand um die Strömungsverzögerung hinterher. Schlechter, nicht kaputt.
- [ ] **Drei Stellen synchron halten:** `_SIGNAL_KINDS` (`ws_remote_handlers.py:116`), `RemoteSignalKind` (`web/src/lib/ws/handlers/types.ts:30`), und der Player.

**Mutationsprobe:** Signal senden, ohne `showsCursor` zu setzen (und umgekehrt) — der Steuernde hätte dann gar keinen Zeiger oder zwei. Muss rot werden.

### Task 6: Aufräumen am Sitzungsende

- [ ] `Umgebung::sitzung_beendet` füllen: `Zeigerbuch::zuruecksetzen()`.
- [ ] **Nicht an `host_zeiger_zeigen` hängen** — dort liefe es zusätzlich bei jedem Führungswechsel und jedem Vorrang-Übergang, und der Sidecar schickte die Form erneut. Die Begründung steht am Trait; der getrennte Weg existiert genau dafür.

### Task 7: Der Prüfstein — durch die Bauweise bereits erfüllt

**Der Plan verlangte hier einen mac-seitigen Test gegen `streaming/zeigerbild-formen.json`. Der wäre redundant**, und das ist beim Bauen aufgefallen: der Prüfstein-Test ist in Etappe 1b in die gemeinsame Kiste gewandert (`zeigerbuch.rs::bildfeld_erzeugt_genau_die_formen_des_pruefsteins`, dort ausdrücklich begründet — „er gilt damit für JEDEN Sender, der diese Kiste nutzt, statt nur für den einen, bei dem er zufällig entstand"). Der mac-Sender geht durch `Zeigerbuch::nachricht`; beide Ausprägungen und ihre Abfolge sind dort mit sieben Tests belegt. Ein zweiter Test daneben prüfte dieselbe Kiste noch einmal.

- [x] **Stattdessen die eine Eigenschaft geprüft, die der Prüfstein NICHT sehen kann** (`zeigerpunkte_tests.rs::dieselben_punkte_ergeben_dieselbe_kennung`): dass derselbe Zeiger zweimal dieselbe Kennung ergibt.

  Wäre sie unstabil, entstünde die Kurzform **nie**. Jede Meldung trüge das volle Bild, der 5900-Byte-Trichter wäre bei jedem Wecker belastet, und beide Seiten meldeten Erfolg — kein Absturz, keine Meldung, nur zehnmal so viel auf der Leitung. Der Prüfstein kann das nicht fangen: er belegt, dass beide Ausprägungen richtig *gebaut* werden, nicht dass beide *vorkommen*.

  Die Gegenprobe gehört dazu (ein veränderter Zeiger muss eine andere Kennung bekommen) — eine Kennung, die sich nie ändert, bestünde die erste Hälfte und liesse den Steuernden dauerhaft den falschen Zeiger sehen.

**Warum ausgerechnet das:** am 2026-08-17 verlangte die Renderer-Prüfung die Masse als Pflichtfelder und verwarf damit **jede Kurzform**. Beide Testnetze waren grün — die Rust-Seite hielt die Kurzform fest, die TS-Seite verlangte sie mit, niemand sah über die Sprachgrenze. **Die Masse gehören zu den DATEN, nicht zur Kennung.** Ein Test auf der Empfängerseite allein hätte es nicht gefunden.

### Task 8: Abnahme

- [ ] Zwei-Geräte-Lauf: Linux steuert Mac, Zeiger wechselt über Textfeld, Fensterrand, Timeline.
- [ ] Rückfall künstlich auslösen (Abfrage auf `nil` zwingen) und prüfen, dass genau **ein** Zeiger sichtbar bleibt.
- [ ] Changelog (Stil vom Nutzer), Version-Bump — `pulse-player` ist betroffen.

## Rückwirkende Befunde über Windows (aus Task 1, gelesen — nicht gemessen)

Beim Lesen des Zwillings sind zwei **Netzlücken auf der Windows-Seite** aufgefallen. Sachlich ist dort nichts falsch; es fehlt Prüfbarkeit. Hier festgehalten, nicht behoben — Windows baut auf dieser Maschine nicht, und blind eingesetzte Windows-Änderungen sind in diesem Projekt schon teuer gewesen.

1. **Windows hat die Naht nicht.** Sein `setzen` ruft `SetIsCursorCaptureEnabled` direkt; die einzige plattformeigene Prüfung ist der Leerlauf-No-op. Genau die zwei Mutationen, die auf der macOS-Seite rot werden — `gelungen` in den Fehlerzweig schieben, `gelungen` **vor** den Aufruf ziehen —, blieben dort von der gesamten Testsuite unbemerkt: die Tests des gemeinsamen `zeigerschalter` prüfen den Schalter, nicht seinen **Gebrauch**. Dieselbe Naht (Verschluss statt direktem Plattform-Aufruf) wäre mit wenigen Zeilen zu haben.
2. **Die Durchreichung von `include_cursor` hat auf Windows gar kein Netz**, auch nicht im `win-hq-labor`. macOS hat dafür jetzt einen Prüfling, Windows nichts.

Wer das angeht, braucht einen Windows-Rechner oder einen CI-Lauf — nicht diese Etappe.

## Was diese Etappe NICHT tut

- **Kein „Fern-Modus"-Takt** (§2.1 verworfen).
- **Keine CGS-Schnittstelle.**
- **Kein Zeigerfang-Umbau** — der Player fängt den Zeiger schon.
