# Fernsteuerung macOS, Plan 1b: Der zweite Schnitt — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die rund 560 Zeilen plattformfreier Logik, die nach Plan 1 im Windows-Sidecar liegen geblieben sind, in `streaming/pulse-fernsteuerung` nachziehen — ohne Verhaltensänderung —, damit der mac-Sidecar sie nicht ein zweites Mal schreibt.

**Architecture:** Dieselbe Methode wie Plan 1: bewegen statt neu schreiben, Tests wandern mit und laufen danach auf jeder Maschine, der Windows-Teil bleibt ein dünner Aufsatz. Wo eine Plattform-Schnittstelle im Weg steht, wandert nur die Entscheidung in die Kiste und der Aufruf bleibt draußen.

**Tech Stack:** Rust (edition 2024). `streaming/pulse-fernsteuerung` (heute 146 Tests, zwei Abhängigkeiten — `serde_json` und die Schwesterkiste `pulse-zeigerbild`, s. Task 4/5), `streaming/win-hq-sidecar` (auf der Entwicklungsmaschine **nicht** übersetzbar), `streaming/zwillinge` (Prüfnetz).

## Warum dieser Plan existiert

Die Schlussprüfung von Plan 1 hat die Windows-Seite nach der Auslagerung Datei für Datei durchgesehen. Der Entwurf hatte behauptet, `zeigerform.rs` bleibe „vollständig plattformeigen" — tatsächlich sind dort vier Funktionen echt Windows und rund 500 von 634 Zeilen Format- und Zustandsführung. Insgesamt:

| Wo | Umfang | Was ein zweiter Sidecar neu schriebe |
|---|---|---|
| `ops/remote_input.rs` | ~180 Z., **kein** Windows-Aufruf | Op-Hülle: Grenzen 32/1024, `slot_aus` ohne Zurechtbiegen, `sitzungs_id_aus`, `frames_aus`, Fehler über `protokollfehler` |
| `remote_input/zeigerform.rs` | ~500 von 634 Z. | Buchführung: `Merker`, beide Zähler, `MAX_BEKANNT` + Überlaufregel, `meldung_faellig`, `bild_vollstaendig`, `bekannt_aufnehmen`, `bildfeld`, Prüfstein gegen `zeigerbild-formen.json` |
| `remote_input/wache.rs` | ~100 von 376 Z. | `VORRANG_FRIST_MS`, `WECKER_MS`, `frist_ms` mit `PULSE_FERN_VORRANG_MS` samt Klemmgrenzen, `rest_ms`, Wecker-Laufnummer |
| `remote_input/ziel.rs` | ~80 von 372 Z. | `SLOT_MAX = 98`, `traegt_slot`, Ablauf von `bindung_fuer_slot` |
| `capture/cursorsteuerung.rs` | ~90 Z., **eine** WinRT-Zeile | `basis_sichtbar`, Zustandsfilter, asymmetrische Fehlerbehandlung |

**Mindestens fünf dieser Stellen tragen einen bereits einmal gemachten Fehler als Kommentar** — `slot_aus` („`-1`, `1.5` und `"0"` liefen still auf Platz 0"), `frames_aus` („die Zusage galt nur meistens"), `bekannt_aufnehmen` („der erste Zweig ist der Fund"), die asymmetrische Fehlerbehandlung in `cursorsteuerung` und die Kurzform-Falle im Zeigerbild. Diese Begründungen hängen heute an der Windows-Fassung. Ein zweiter Autor schreibt sie nicht mit.

## Global Constraints

- **Verhalten darf sich nicht ändern.** Zustandsnamen, Fehlermeldungen (wortgleich, sie gehen über die Leitung), Testnamen, Reihenfolge der Prüfungen. Bricht ein Test, ist der Code kaputt, nicht der Test.
- **Der Windows-Sidecar lässt sich auf dieser Maschine nicht übersetzen.** Kein `cargo build`/`check`, auch nicht mit `--target x86_64-pc-windows-msvc`. Einzige Windows-Prüfung ist der CI-Lauf (Task 6). `cargo fmt` ist nicht installiert und läuft in keinem Gate.
- **Die Kiste bleibt schlank.** Bis Task 4 ist `[dependencies]` leer; über die eine mögliche Ausnahme entscheidet Task 4 ausdrücklich (s. dort). Keine weitere Abhängigkeit ohne Rückfrage.
- Kommentare auf Deutsch, **im Schriftbild der jeweiligen Datei**. Keine Emojis. Commit-Nachrichten mit echten Umlauten.
- Quelldateien ≤ 350 Zeilen (hart 500), Tests ausgenommen.
- Kein `git push` und **kein Merge** ohne ausdrückliche Freigabe.
- **Getrennter Zweig von Plan 1**, mit eigenem CI-Lauf: zwei ungeprüfte Windows-Umbauten übereinander machen den ersten Bruch teuer zu finden.

## Dateien

Neu in `streaming/pulse-fernsteuerung/src/`: `frist.rs`, `slot.rs`, `zeigerschalter.rs`, `huelle.rs` (Task 4), `zeigerbuch.rs` (Task 5).
Geändert: `streaming/win-hq-sidecar/src/remote_input/{wache,ziel,zeigerform}.rs`, `.../capture/cursorsteuerung.rs`, `.../ops/remote_input.rs`, `streaming/pulse-fernsteuerung/src/lib.rs`.

---

### Task 1: Frist und Wecker

Die Zeitrechnung des Host-Vorrangs. Reine Arithmetik plus eine Umgebungsvariable, die eine **projektweite Zusage** trägt (`PULSE_FERN_VORRANG_MS` steht in `CLAUDE.md`) — genau die Sorte Wert, die auf einer zweiten Plattform mit einer anderen Grenze wieder auftauchen würde.

**Files:**
- Create: `streaming/pulse-fernsteuerung/src/frist.rs`
- Modify: `streaming/pulse-fernsteuerung/src/lib.rs`, `streaming/win-hq-sidecar/src/remote_input/wache.rs`

**Interfaces:**
- Produces: `frist::{VORRANG_FRIST_MS, WECKER_MS, frist_ms() -> u64, rest_ms(letzte_regung_ms: u64, jetzt_ms: u64) -> u64, host_regt_sich(letzte_regung_ms: u64, jetzt_ms: u64) -> bool}`

- [ ] **Step 1: Den Schnitt festlegen**

Aus `wache.rs` wandern: `VORRANG_FRIST_MS`, `WECKER_MS`, `frist_ms()` (samt `PULSE_FERN_VORRANG_MS` und der Klemmung auf 100..60000) und die Rechnung aus `rest_ms()`.

**Was NICHT wandert:** `jetzt_ms()` (hängt an einem prozessweiten `OnceLock<Instant>`) und `LETZTE_REGUNG_MS` (prozessweites Atomic). Beide bleiben plattformseitig; die Kiste bekommt die Zahlen **als Argumente**. Damit wird die Rechnung ohne Uhr prüfbar, und das ist der eigentliche Gewinn: heute lässt sich `rest_ms` nur gegen die laufende Uhr testen.

- [ ] **Step 2: Den fehlenden Test zuerst schreiben**

`rest_ms` hat heute genau einen Test (`ohne_regung_kein_vorrang`), und der prüft nur den Nullfall. Die Grenzfälle sind ungedeckt. In `frist.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// `0` heisst „noch nie geregt" — nicht „vor sehr langer Zeit".
    #[test]
    fn ohne_regung_kein_vorrang() {
        assert_eq!(rest_ms(0, 10_000), 0);
        assert!(!host_regt_sich(0, 10_000));
    }

    /// Die Frist laeuft ab, sie springt nicht.
    #[test]
    fn die_frist_laeuft_linear_ab() {
        let f = frist_ms();
        assert_eq!(rest_ms(1_000, 1_000), f);
        assert_eq!(rest_ms(1_000, 1_000 + f / 2), f - f / 2);
        assert_eq!(rest_ms(1_000, 1_000 + f), 0);
        assert_eq!(rest_ms(1_000, 1_000 + f + 1), 0, "danach bleibt sie bei null");
    }

    /// **Eine rueckwaerts laufende Uhr darf keinen ewigen Vorrang erzeugen.**
    /// `saturating_sub` faengt es ab; ohne diese Zusage liefe `jetzt < letzte`
    /// auf einen Unterlauf und der Host behielte sein Geraet fuer immer.
    #[test]
    fn eine_rueckwaerts_laufende_uhr_verlaengert_nicht() {
        assert!(rest_ms(5_000, 4_000) <= frist_ms());
        assert!(host_regt_sich(5_000, 4_000), "noch innerhalb der Frist");
    }

    /// Die Grenzen der Umgebungsvariablen sind eine Zusage, kein Vorschlag.
    #[test]
    fn die_frist_bleibt_in_ihren_grenzen() {
        let f = frist_ms();
        assert!((100..=60_000).contains(&f), "frist_ms() = {f}");
    }
}
```

- [ ] **Step 3: Lauf die Tests, sie müssen fehlschlagen**

Run: `cd streaming/pulse-fernsteuerung && cargo test frist`
Expected: FAIL — `frist.rs` gibt es noch nicht.

- [ ] **Step 4: Den Code aus `wache.rs` herüberholen**

Die vier Elemente aus Step 1, mit ihren Doc-Kommentaren **wortgleich**. `rest_ms` und `host_regt_sich` bekommen die beiden Zeitwerte als Argumente statt sie zu lesen.

- [ ] **Step 5: Tests laufen lassen**

Run: `cd streaming/pulse-fernsteuerung && cargo test`
Expected: PASS, 109 + 4 Tests.

- [ ] **Step 6: `wache.rs` umstellen**

`use pulse_fernsteuerung::frist;`, die vier Elemente löschen, `host_regt_sich()`/`rest_ms()` als dünne Weiterleitungen stehen lassen (sie lesen die prozessweiten Werte und rufen die Kiste). `WECKER_MS` in `wecker_starten` auf `frist::WECKER_MS`.

- [ ] **Step 7: Nachweisen und committen**

```bash
diff <(git show HEAD:streaming/win-hq-sidecar/src/remote_input/wache.rs) \
     streaming/win-hq-sidecar/src/remote_input/wache.rs
```

Expected: nur Löschungen der gewanderten Elemente plus die Weiterleitungen.

---

### Task 2: Die Slot-Regeln

`SLOT_MAX = 98` hängt bereits an zwei anderen Stellen im Repo (`desktop/electron/sidecar.ts::MAX_STREAM_SLOTS`, `_SLOT_MAX` im chat-gateway). Eine dritte Kopie je Plattform ist genau die Sorte Zahl, die auseinanderläuft.

**Files:**
- Create: `streaming/pulse-fernsteuerung/src/slot.rs`
- Modify: `streaming/pulse-fernsteuerung/src/lib.rs`, `streaming/win-hq-sidecar/src/remote_input/ziel.rs`

**Interfaces:**
- Produces: `slot::{SLOT_MAX: u64, traegt_slot(erklaert: Option<u32>, angefragt: u64) -> bool, im_bereich(slot: u64) -> bool}`

- [ ] **Step 1: Die Tests zuerst**

Aus `ziel.rs` wandern `slot_regeln` und der Bereichsteil von `platz_jenseits_der_schranke_ist_unbekannt` mit. Dazu neu:

```rust
    /// Die Schranke gilt auch jenseits von `u32` — hier wurde frueher gekappt,
    /// und ein `slot: 5_000_000_000` landete auf dem einen Strom des
    /// Prozesses.
    #[test]
    fn jenseits_der_schranke_ist_ausserhalb() {
        assert!(im_bereich(0));
        assert!(im_bereich(SLOT_MAX));
        assert!(!im_bereich(SLOT_MAX + 1));
        assert!(!im_bereich(5_000_000_000));
    }
```

- [ ] **Step 2: Fehlschlag belegen, dann `slot.rs` schreiben, dann grün**

Run vor dem Code: `cd streaming/pulse-fernsteuerung && cargo test slot` → FAIL.
Danach dieselbe Zeile → PASS.

Der Doc-Kommentar zu `SLOT_MAX` nennt die beiden anderen Fundstellen im Repo weiterhin **namentlich** — das ist der einzige Faden zwischen ihnen.

- [ ] **Step 3: `ziel.rs` umstellen und nachweisen**

`traegt_slot` und `SLOT_MAX` löschen, `bindung_fuer_slot` ruft `slot::im_bereich` und `slot::traegt_slot`. `diff` gegen `git show HEAD:` zeigt nur das.

- [ ] **Step 4: Committen**

---

### Task 3: Der Zeiger-Schalter

`cursorsteuerung.rs` hat **eine** WinRT-Zeile (`SetIsCursorCaptureEnabled`) und ringsherum 90 Zeilen Zustandsführung — darunter die asymmetrische Fehlerbehandlung, die aus einem Bughunt stammt und deren Begründung nur dort steht.

**Files:**
- Create: `streaming/pulse-fernsteuerung/src/zeigerschalter.rs`
- Modify: `streaming/pulse-fernsteuerung/src/lib.rs`, `streaming/win-hq-sidecar/src/capture/cursorsteuerung.rs`

**Interfaces:**
- Produces: `zeigerschalter::{Schalter, Wirkung}` mit
  `Schalter::neu(basis_sichtbar: bool)`, `Schalter::setzen(&mut self, verbergen: bool) -> Wirkung`, `Schalter::gelungen(&mut self, verbergen: bool)`, `Schalter::gescheitert(&mut self, verbergen: bool) -> bool`
- `Wirkung`: `Nichts` (kein Cursor im Ausgangszustand, oder schon im Zielzustand) oder `Umschalten(bool)` (Argument für den Plattform-Aufruf).
- `gescheitert` liefert `true`, wenn der Platz zu **räumen** ist.

- [ ] **Step 1: Die Zusagen als Tests schreiben — sie sind heute ungetestet**

`cursorsteuerung.rs` hat genau einen Test („ohne Aufnahme sind beide Richtungen No-Ops"). Die drei eigentlichen Zusagen sind ungedeckt:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// **Nie ueber den Ausgangszustand hinaus.** Wer ohne Cursor streamt,
    /// bekommt ihn durch eine Fernsteuerung nicht untergeschoben.
    #[test]
    fn ohne_cursor_im_ausgangszustand_passiert_nichts() {
        let mut s = Schalter::neu(false);
        assert_eq!(s.setzen(true), Wirkung::Nichts);
        assert_eq!(s.setzen(false), Wirkung::Nichts);
    }

    /// Nur Zustandswechsel loesen einen Aufruf aus — bei bis zu 125
    /// Nachrichten je Sekunde waere ein WinRT-Aufruf je Nachricht
    /// vermeidbare Arbeit.
    #[test]
    fn nur_der_wechsel_loest_aus() {
        let mut s = Schalter::neu(true);
        assert_eq!(s.setzen(true), Wirkung::Umschalten(true));
        s.gelungen(true);
        assert_eq!(s.setzen(true), Wirkung::Nichts, "schon verborgen");
        assert_eq!(s.setzen(false), Wirkung::Umschalten(false));
        s.gelungen(false);
        assert_eq!(s.setzen(false), Wirkung::Nichts);
    }

    /// **Die asymmetrische Fehlerbehandlung, aus einem Bughunt.** Scheitert
    /// das VERBERGEN, wird der Platz geraeumt (sonst wiederholt sich der
    /// Fehlschlag samt Log-Zeile mit jeder Nachricht). Scheitert das ZEIGEN,
    /// bleibt er stehen — er ist die einzige Moeglichkeit, den Host-Cursor
    /// zurueckzuholen; geraeumt verloeren alle Zuschauer ihn bis zum
    /// Stream-Ende.
    #[test]
    fn scheitern_wirkt_in_beide_richtungen_verschieden() {
        let mut s = Schalter::neu(true);
        assert!(s.gescheitert(true), "verbergen gescheitert -> raeumen");
        let mut s = Schalter::neu(true);
        s.setzen(true);
        s.gelungen(true);
        assert!(!s.gescheitert(false), "zeigen gescheitert -> stehen lassen");
    }

    /// Und nach einem gescheiterten Zeigen bleibt ein weiteres Verbergen ein
    /// No-Op, bis das Zeigen glueckt — sonst entstuende die
    /// Wiederholungsflut auf dem anderen Weg.
    #[test]
    fn nach_gescheitertem_zeigen_verbirgt_nichts_erneut() {
        let mut s = Schalter::neu(true);
        s.setzen(true);
        s.gelungen(true);
        s.gescheitert(false);
        assert_eq!(s.setzen(true), Wirkung::Nichts);
    }
}
```

- [ ] **Step 2: Fehlschlag belegen, umsetzen, grün**

- [ ] **Step 3: `cursorsteuerung.rs` auf den Schalter umstellen**

`Platz` hält statt `basis_sichtbar`/`verborgen` einen `Schalter`. `setzen()` wird zu: Wirkung holen, bei `Umschalten(v)` die WinRT-Zeile rufen, bei `Ok` `gelungen()`, bei `Err` `gescheitert()` und ggf. räumen. Die Log-Zeilen bleiben wortgleich.

- [ ] **Step 4: Nachweisen und committen**

---

### Task 4: Entscheidung über `serde_json`, dann die Op-Hülle

**Diese Aufgabe beginnt mit einer Entscheidung, die der Mensch trifft.** Sie steht hier ausgeschrieben, damit sie nicht nebenbei fällt.

**Der Sachverhalt.** Die Op-Hülle (`ops/remote_input.rs`, ~180 Zeilen ohne einen Windows-Aufruf) liest JSON. Sie enthält zwei dokumentierte Altfehler, und **beide sitzen in der JSON-Typprüfung**: `slot_aus` bog `-1`, `1.5` und `"0"` still auf Platz 0 („ein Klick auf dem falschen Bildschirm, und niemand erfährt davon"), und `frames_aus` gab bei kaputtem Base64 ein nacktes `anyhow!` zurück, ohne stillzulegen und ohne freizugeben („die Zusage galt nur meistens").

**Die Kernbedingung der Kiste** lautet bisher: keine Abhängigkeiten, begründet mit „sie wird von mehreren Programmen eingebunden und darf deren Bauwege nicht beschweren".

**Nachgemessen:** `serde_json = "1"` steht bereits in `win-hq-sidecar`, `mac-hq-sidecar`, `linux-hq-sidecar` **und** `pulse-player`. Für dieses eine Paket trägt die Begründung also nicht — es beschwert keinen Bauweg, weil es überall schon da ist.

**Zwei Wege:**

* **(a) `serde_json` in die Kiste aufnehmen.** Die Hülle wandert als Ganzes, samt beider Altfehler-Begründungen und der Tests. Preis: die Kernbedingung wird von „keine Abhängigkeiten" zu „nur, was ohnehin überall steht" — und diese Aufweichung muss dann im Kopf der `Cargo.toml` stehen, sonst rutscht die nächste Abhängigkeit mit derselben Begründung hinein.
* **(b) Nur die Entscheidung wandert.** Die Kiste bekommt ein plattformfreies `SlotFeld { Fehlt, Ganzzahl(u64), Negativ, Bruch, Anderes(&str) }` und Funktionen darüber; jede Plattform bildet ihre JSON-Werte in ~8 Zeilen darauf ab. Preis: die JSON-Typprüfung — der Ort **beider** Altfehler — bleibt je Plattform eigen. Genau die Doppelung, die dieser Plan beseitigen soll, bliebe an ihrer heikelsten Stelle bestehen.

**Empfehlung: (a).** Der Zweck der Kiste ist, dass Regeln einmal existieren. Ein Weg, der die Regel teilt und die Prüfung doppelt lässt, verfehlt ihn dort, wo es am meisten kostet — und die genannte Begründung für die Abhängigkeitsfreiheit gilt für `serde_json` nachweislich nicht.

- [ ] **Step 1: Die Entscheidung einholen und im Kopf der `Cargo.toml` festhalten**

Ohne Antwort **nicht** weitermachen. Fällt sie auf (a), gehört in `streaming/pulse-fernsteuerung/Cargo.toml` über den Eintrag eine Begründung, die die Grenze zieht: `serde_json`, weil es in allen vier Verbrauchern bereits steht; alles Weitere braucht dieselbe Nachmessung und eine eigene Entscheidung.

- [ ] **Step 2: Die Hülle bewegen**

`ops/remote_input.rs` → `streaming/pulse-fernsteuerung/src/huelle.rs`: `MAX_FRAMES`, `MAX_BYTES`, `slot_aus`, `sitzungs_id_aus`, `frames_aus`, `huelle_lesen` und die Modul-Doku mit der Zustandstabelle. Die sechs Tests wandern mit.

**Was in Windows bleibt:** `handle()` — es holt die Sitzung, hüllt Fehler in `anyhow` und baut die Antwortkarte. Das sind zehn Zeilen und die einzige Stelle, die den Prozess kennt.

- [ ] **Step 3: Tests, Nachweis, Commit**

Run: `cd streaming/pulse-fernsteuerung && cargo test`
Expected: PASS. `diff` gegen `git show HEAD:...ops/remote_input.rs` zeigt nur die Trennung.

---

### Task 5: Die Zeigerform-Buchführung

Das größte Stück: rund 500 von 634 Zeilen. Vier Funktionen bleiben Windows (`abbildung`, `ermitteln`, `zu_name` und zwei Tests) — alles andere ist Format- und Zustandsführung, und **der Prüfstein gegen `streaming/zeigerbild-formen.json` gehört dazu.**

**Files:**
- Create: `streaming/pulse-fernsteuerung/src/zeigerbuch.rs`
- Modify: `streaming/win-hq-sidecar/src/remote_input/zeigerform.rs`, `streaming/pulse-fernsteuerung/src/lib.rs`

- [ ] **Step 1: Den Schnitt bestimmen und aufschreiben**

Erst lesen, dann schneiden. `zeigerform.rs` durchgehen und **jede** Funktion einer Seite zuordnen; das Ergebnis als Tabelle in den Bericht. Wandern sollen mindestens: `Merker`, `takte`/`bild_takte`, `MAX_BEKANNT` samt Überlaufregel, `meldung_faellig`, `bild_vollstaendig`, `bekannt_aufnehmen`, `buchen`, `bildfeld`, `zuruecksetzen`.

**Der Windows-Rest muss danach unter 350 Zeilen liegen** — die Datei ist heute bei 634 und damit über der harten Grenze; das ist eine der offenen Rechnungen, die dieser Schnitt nebenbei bezahlt.

- [ ] **Step 2: Den Prüfstein mitnehmen — er ist der Kern**

Der Test gegen `streaming/zeigerbild-formen.json` prüft, dass der **Sender** beide Ausprägungen erzeugt (Kurzform `{id}` und Vollform mit Maßen). Genau hier saß am 2026-08-17 der Fehler, der durch beide Testnetze rutschte. In der Kiste gilt er ab sofort für **jeden** Sender, nicht nur für Windows — das ist der eigentliche Ertrag dieser Aufgabe.

- [ ] **Step 3: Umstellen, Tests, Nachweis, Commit**

`cargo test` in der Kiste grün; `diff` gegen `git show HEAD:` zeigt nur die Trennung; die Windows-Datei unter 350 Zeilen.

---

### Task 6: Windows-Nachweis

- [ ] **Step 1: Auf Hinterlassenschaften suchen**

```bash
grep -rn "VORRANG_FRIST_MS\|WECKER_MS\|traegt_slot\|SLOT_MAX\|MAX_FRAMES\|MAX_BYTES\|\
slot_aus\|sitzungs_id_aus\|frames_aus\|MAX_BEKANNT\|meldung_faellig\|bild_vollstaendig\|\
bekannt_aufnehmen\|basis_sichtbar" streaming/win-hq-sidecar/src/
```

Expected: nur Treffer, die über `pulse_fernsteuerung::` gehen.

- [ ] **Step 2: `streaming/zwillinge` laufen lassen**

Expected: grün. Rot heißt, ein Bau-Auslöser oder eine Manifest-Quelle fehlt.

- [ ] **Step 3: Push-Freigabe einholen, pushen, `win-build` auf dem Zweig starten**

```bash
gh workflow run win-build.yml --ref <zweig>
gh run watch <id> --exit-status
```

Ein Lauf auf einem Zweig baut und archiviert nur.

- [ ] **Step 4: Erst nach grünem Windows-Bau zur Abnahme geben**

---

## Danach

Erst dann Plan 2 (der Mac als Host). Dessen erster Schritt bleiben die drei Messungen aus §9 des Entwurfs — sie brauchen die Hände des Nutzers und entscheiden über den Injektor-Entwurf.
