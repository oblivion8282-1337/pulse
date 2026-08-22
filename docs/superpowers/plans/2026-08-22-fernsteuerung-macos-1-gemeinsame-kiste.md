# Fernsteuerung macOS, Plan 1: Die gemeinsame Kiste — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Den plattformfreien Kern der Fernsteuerung aus dem Windows-Sidecar und dem Player in eine gemeinsame Kiste `streaming/pulse-fernsteuerung` ziehen — ohne jede Verhaltensänderung —, damit der mac-Sidecar in Plan 2 nur noch seine Plattform-Hälfte beisteuern muss.

**Architecture:** Die Kiste ist abhängigkeitsfrei und ohne globalen Zustand. Sie enthält Frame-Format (bauen und parsen), Gedrückt-Menge, Base64, Klemmrechnung, Bewegungsschwelle, Ausführung und die Sitzungs-Zustandsmaschine. Der Plattform-Schnitt sind drei Traits — `Injektor`, `Wache`, `Umgebung` —, die die Sitzung als `&'static dyn` hält. Windows und Player behalten ihre Aufrufstellen über Re-Export-Einzeiler, genau wie bei `pulse-zeitbasis`.

**Tech Stack:** Rust (edition 2024), keine Abhängigkeiten in der neuen Kiste. Bestehende Kisten: `streaming/win-hq-sidecar` (nur auf Windows baubar), `streaming/pulse-player` (baut auf diesem Mac), `streaming/zwillinge` (Prüfnetz, baut überall).

## Global Constraints

- **Verhalten darf sich nicht ändern.** Zustandsnamen (`live`, `unknown_slot`, `unresolved_source`, `masked`, `host_active`, `ended`), Fehlermeldungen, Reihenfolge der Prüfungen und Testnamen bleiben wortgleich. Bricht ein Test, ist der Code kaputt, nicht der Test.
- **Die neue Kiste hat KEINE Abhängigkeiten** (`[dependencies]` leer), wie `streaming/pulse-zeitbasis/Cargo.toml`. Begründung dort: sie wird von mehreren Programmen eingebunden und darf deren Bauwege nicht beschweren.
- **Kein `git push` ohne ausdrückliche Freigabe des Nutzers.** Task 9 braucht genau eine.
- **Der Windows-Sidecar lässt sich auf diesem Mac nicht übersetzen.** Kein `cargo check --target x86_64-pc-windows-msvc` — das scheitert an C-Abhängigkeiten (`lib.exe` fehlt). Einzige Windows-Prüfung ist der CI-Lauf in Task 9.
- **Rust-Kanten:** edition 2024, `publish = false`, Version `0.1.0` — wie alle `pulse-*`-Kisten.
- **Kommentare und Doc-Kommentare auf Deutsch mit echten Umlauten**, wie im umgebenden Code. Keine Emojis.
- **Kein Changelog-Eintrag in diesem Plan** — es ändert sich nichts, was ein Nutzer bemerkt.

## Dateien

Neu:

| Datei | Verantwortung |
|---|---|
| `streaming/pulse-fernsteuerung/Cargo.toml` | Paket, ohne Abhängigkeiten |
| `streaming/pulse-fernsteuerung/src/lib.rs` | Modulbaum, Kopfdoku |
| `streaming/pulse-fernsteuerung/src/format.rs` | Opcodes, Längen, Fassung, Knopf-Nummern, Raste, erlaubte Scancodes |
| `streaming/pulse-fernsteuerung/src/rahmen.rs` | Parser (Empfängerseite) |
| `streaming/pulse-fernsteuerung/src/bauen.rs` | Frame-Bau (Senderseite) |
| `streaming/pulse-fernsteuerung/src/base64.rs` | Base64-Dekodierung |
| `streaming/pulse-fernsteuerung/src/zuordnung.rs` | `Rechteck`, Anteil→Punkt, Klemmen, Mitte |
| `streaming/pulse-fernsteuerung/src/bewegung.rs` | Bewegungsschwelle der Wache |
| `streaming/pulse-fernsteuerung/src/plattform.rs` | Die drei Traits + `Zielsuche` |
| `streaming/pulse-fernsteuerung/src/druck.rs` | Gedrückt-Menge (braucht `Injektor`) |
| `streaming/pulse-fernsteuerung/src/ausfuehrung.rs` | Was injiziert wird, Orts-Tor |
| `streaming/pulse-fernsteuerung/src/sitzung.rs` | Zustandsmaschine, Vorrang-Übergänge |
| `streaming/pulse-fernsteuerung/src/pruefstand.rs` | Test-Plattform (`#[cfg(test)]`) |

Geändert: `streaming/win-hq-sidecar/{Cargo.toml,src/remote_input/*}`, `streaming/win-hq-sidecar/src/ops/remote_input{,_end}.rs`, `streaming/pulse-player/{Cargo.toml,src/fernsteuerung/rahmen.rs}`, `.github/workflows/{win-build,mac-build,flatpak}.yml`, `packaging/com.howispulse.Pulse.yml`.

---

### Task 1: Die Kiste mit dem Frame-Format beider Richtungen

Das Format steht heute zweimal im Baum — der Player baut Frames, der Sidecar parst sie —, und kein Test hält die beiden zusammen. Diese Aufgabe legt die Kiste an und macht den Hin-und-zurück-Test möglich, den es bisher nicht geben konnte.

**Files:**
- Create: `streaming/pulse-fernsteuerung/Cargo.toml`
- Create: `streaming/pulse-fernsteuerung/src/lib.rs`
- Create: `streaming/pulse-fernsteuerung/src/format.rs`
- Create: `streaming/pulse-fernsteuerung/src/rahmen.rs`
- Create: `streaming/pulse-fernsteuerung/src/bauen.rs`

**Interfaces:**
- Consumes: nichts.
- Produces:
  - `format::{PROTOKOLL_VERSION: u8, OP_HELLO, OP_MAUS_ABS, OP_MAUS_REL, OP_MAUS_KNOPF, OP_MAUS_RAD, OP_TASTE: u8, RASTE: i32, Knopf}`
  - `format::knopf_bekannt(btn: u8) -> bool`
  - `format::scancode_gueltig(scan: u16) -> bool`
  - **Nicht** `SATZ1_TASTEN` — die Vokabelliste entsteht erst in Task 7, wo sie gefüllt wird. Eine leere Konstante hier hätte einen Test nach sich gezogen, der über nichts iteriert und damit nichts prüft.
  - `rahmen::{InputFrame, ParseError}`, `InputFrame::parse(&[u8]) -> Result<InputFrame, ParseError>`
  - `bauen::{Rahmen, hello, maus_abs, maus_rel, maus_knopf, maus_rad, taste, anteil_zu_u16, Rastensammler, ...}`

- [ ] **Step 1: Paket anlegen**

`streaming/pulse-fernsteuerung/Cargo.toml`:

```toml
[package]
name = "pulse-fernsteuerung"
version = "0.1.0"
edition = "2024"
publish = false
description = "Plattformfreier Kern der Pulse-Fernsteuerung — Frame-Format, Sitzung, Klemmrechnung"

# Ohne Abhaengigkeiten — diese Kiste wird vom Windows- und vom mac-Sidecar und
# vom Player eingebunden und darf deren Bauwege nicht beschweren. Dieselbe
# Regel wie in `pulse-zeitbasis/Cargo.toml`.
[dependencies]
```

- [ ] **Step 2: `format.rs` schreiben — die eine Stelle, an der das Format steht**

```rust
//! Das Format der Leitung — Zahlen, die BEIDE Seiten kennen muessen.
//!
//! Verbindlich ist `docs/plans/2026-08-12-input-wire-protokoll-v2.md`.
//!
//! **Warum das ein eigenes Modul ist.** Bis zum 2026-08-22 stand es zweimal im
//! Baum: der Player baute Frames aus seinen Konstanten, der Sidecar parste sie
//! mit seinen. Kein Zwillings-Test hielt die beiden zusammen — genau die Lage,
//! aus der der Zeigerbild-Fehler entstand (Sender und Empfaenger aus zwei
//! getrennten Vorstellungen geschrieben, beide Testnetze gruen). Seit die
//! Zahlen hier stehen, ist der Hin-und-zurueck-Test moeglich, und die Frage
//! „passen die beiden Seiten zusammen?" ist eine Uebersetzung und keine
//! Durchsicht.

/// Fassung im Hello-Frame. **2** seit dem Serverweg; v1 hat nie ausgeliefert.
pub const PROTOKOLL_VERSION: u8 = 2;

pub const OP_HELLO: u8 = 0x00;
pub const OP_MAUS_ABS: u8 = 0x01;
pub const OP_MAUS_REL: u8 = 0x02;
pub const OP_MAUS_KNOPF: u8 = 0x03;
pub const OP_MAUS_RAD: u8 = 0x04;
pub const OP_TASTE: u8 = 0x05;

/// Eine Windows-Raste am Mausrad (`WHEEL_DELTA`).
pub const RASTE: i32 = 120;

/// Knopf-Nummern der Leitung. **Nicht** die von winit und nicht die von
/// JavaScript.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Knopf {
    Links = 0,
    Rechts = 1,
    Mitte = 2,
    X1 = 3,
    X2 = 4,
}

/// Kennt die Leitung diese Knopf-Nummer? Ein unbekannter Knopf ist
/// fail-closed — der Host beendet die Sitzung, statt zu raten.
///
/// **Hier und nicht in der Plattform**, weil es eine Aussage ueber das
/// Protokoll ist und nicht ueber das Betriebssystem: 0..4 sind die Nummern,
/// die ein Sender schicken darf, egal wer sie spaeter einspielt.
pub fn knopf_bekannt(btn: u8) -> bool {
    btn <= Knopf::X2 as u8
}

/// Ist der Scancode so, wie Satz 1 ihn kennt?
///
/// Satz 1 hat genau zwei Formen: `0x00xx` (Grundtaste) und `0xE0xx`
/// (erweiterte Taste). **Alles andere darf nicht eingespielt werden.** Auf
/// Windows traegt `wScan` nur das niederwertige Byte: `0xE11D` (der
/// `0xE1`-Praefix der Pause-Taste) kaeme dort als **linke Strg-Taste** an — und
/// bliebe, weil das Hoch-Ereignis unter demselben missgeformten Code gemerkt
/// wird, am fremden Rechner gedrueckt.
pub fn scancode_gueltig(scan: u16) -> bool {
    matches!(scan >> 8, 0x00 | 0xE0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knopf_nummern_null_bis_vier() {
        for btn in 0..=4u8 {
            assert!(knopf_bekannt(btn), "btn={btn}");
        }
        assert!(!knopf_bekannt(5));
        assert!(!knopf_bekannt(255));
    }

    /// `0xE11D` ist der Fall, der ohne diese Pruefung als linke Strg-Taste
    /// eingespielt wuerde — und dann gedrueckt bliebe.
    #[test]
    fn nur_satz_1_scancodes_sind_gueltig() {
        assert!(scancode_gueltig(0x001D)); // linke Strg-Taste
        assert!(scancode_gueltig(0x0000));
        assert!(scancode_gueltig(0xE01D)); // rechte Strg-Taste
        assert!(scancode_gueltig(0xE04B)); // Pfeil links
        assert!(!scancode_gueltig(0xE11D)); // Pause-Praefix
        assert!(!scancode_gueltig(0x011D)); // erfundener Praefix
        assert!(!scancode_gueltig(0xFFFF));
    }

}
```

- [ ] **Step 3: `rahmen.rs` aus dem Windows-Sidecar holen**

```bash
cp streaming/win-hq-sidecar/src/remote_input/rahmen.rs \
   streaming/pulse-fernsteuerung/src/rahmen.rs
```

Dann in der Kopie **genau vier** Änderungen:

1. Den Absatz über `PROTOKOLL_VERSION` (Zeilen „Protokoll-Version im Hello-Frame …" samt der Konstante) löschen — sie steht jetzt in `format`.
2. Oben einfügen: `use crate::format::*;`
3. Die Opcode-Literale im `match` durch die Konstanten ersetzen: `0x00 =>` wird `OP_HELLO =>`, `0x01 =>` wird `OP_MAUS_ABS =>`, und so weiter für `OP_MAUS_REL`, `OP_MAUS_KNOPF`, `OP_MAUS_RAD`, `OP_TASTE`. (Rust erlaubt Konstanten als Match-Muster.)
4. Im Test `hello_v1_ist_wohlgeformt_aber_alt` bleibt `PROTOKOLL_VERSION` gültig, weil es über `format::*` hereinkommt — nichts zu tun.

Die Modul-Doku bleibt sonst **wortgleich**; der Verweis „`streaming/win-hq-sidecar/src/remote_input.rs`" wird zu „der Injektor der jeweiligen Plattform".

- [ ] **Step 4: `bauen.rs` aus dem Player holen**

```bash
cp streaming/pulse-player/src/fernsteuerung/rahmen.rs \
   streaming/pulse-fernsteuerung/src/bauen.rs
```

Dann in der Kopie:

1. Die Konstanten-Blöcke löschen (`PROTOKOLL_VERSION`, `OP_*`, `RASTE`, `enum Knopf`) — sie stehen in `format`.
2. Oben einfügen: `use crate::format::*;`
3. Sonst nichts. `hello()`, `maus_abs()`, `maus_rel()`, `maus_knopf()`, `maus_rad()`, `taste()`, `anteil_zu_u16()`, `Rastensammler`, `Rahmen` und alle Tests bleiben wortgleich.

- [ ] **Step 5: `lib.rs` schreiben**

Der Modulbaum wächst über die Tasks 1 bis 5; hier stehen nur die drei Module dieser Aufgabe.

```rust
//! Der plattformfreie Kern der Pulse-Fernsteuerung.
//!
//! **Warum es diese Kiste gibt.** Bis zum 2026-08-22 lag der ganze Kern im
//! Windows-Sidecar, und der Player fuehrte seine eigene Fassung des
//! Frame-Formats. Mit dem mac-Sidecar als zweitem Host waeren daraus drei
//! Kopien geworden — darunter die Sitzungs-Zustandsmaschine, an der die
//! Sicherheitszusagen der Fernsteuerung haengen („alles loslassen beim Ende",
//! fail-closed, Hello heisst Neuanfang). Eine Kopie davon liefe still
//! auseinander, und der Schaden waere eine klemmende Taste auf einem fremden
//! Rechner.
//!
//! **Was hier NICHT steht:** alles, was ein Betriebssystem kennt. Der Schnitt
//! sind die drei Traits in `plattform` — Injektion, Wache, Umgebung. Wer eine
//! neue Plattform anschliesst, schreibt genau diese drei und sonst nichts.
//!
//! **Kein globaler Zustand.** Die Sitzung traegt ihre Plattform als Feld. Das
//! ist nicht Geschmack: die Tests brauchen dadurch keine prozessweite
//! Reihenfolge-Sperre, jeder bekommt eine frische Sitzung mit eigenem
//! Pruefstand.

pub mod bauen;
pub mod format;
pub mod rahmen;
```

- [ ] **Step 6: Den Hin-und-zurück-Test schreiben — der Grund für diese Aufgabe**

Ans Ende von `streaming/pulse-fernsteuerung/src/lib.rs`:

```rust
/// Sender und Empfaenger gegeneinander: was [`bauen`] erzeugt, muss [`rahmen`]
/// wieder auseinandernehmen koennen — und dasselbe herausbekommen.
///
/// **Diesen Test konnte es bis zum 2026-08-22 nicht geben.** Das Format stand
/// in zwei Kisten, die einander nicht sehen. Der Zeigerbild-Fehler vom
/// 2026-08-17 ist genau so entstanden: die eine Seite hielt eine Kurzform
/// fest, die andere verlangte Pflichtfelder, beide Testnetze gruen, und
/// niemand sah ueber die Grenze.
#[cfg(test)]
mod hin_und_zurueck {
    use crate::bauen;
    use crate::format::{Knopf, PROTOKOLL_VERSION};
    use crate::rahmen::InputFrame;

    fn zurueck(r: bauen::Rahmen) -> InputFrame {
        InputFrame::parse(r.as_slice()).expect("was der Sender baut, muss der Host lesen koennen")
    }

    #[test]
    fn hello() {
        assert_eq!(
            zurueck(bauen::hello()),
            InputFrame::Hello { version: PROTOKOLL_VERSION }
        );
    }

    #[test]
    fn maus_abs_ueber_den_ganzen_bereich() {
        for (x, y) in [(0u16, 0u16), (1, 2), (32767, 32768), (65535, 65535)] {
            assert_eq!(
                zurueck(bauen::maus_abs(x, y)),
                InputFrame::MouseMoveAbs { x, y },
                "({x},{y})"
            );
        }
    }

    #[test]
    fn maus_rel_mit_vorzeichen() {
        for (dx, dy) in [(0i16, 0i16), (1, -1), (i16::MIN, i16::MAX)] {
            assert_eq!(
                zurueck(bauen::maus_rel(dx, dy)),
                InputFrame::MouseMoveRel { dx, dy },
                "({dx},{dy})"
            );
        }
    }

    /// Die Knopf-Nummern muessen auf beiden Seiten dieselben sein — hier
    /// entstuende sonst ein Rechtsklick aus einem Linksklick.
    #[test]
    fn jeder_knopf_kommt_als_derselbe_an() {
        for (knopf, nr) in [
            (Knopf::Links, 0u8),
            (Knopf::Rechts, 1),
            (Knopf::Mitte, 2),
            (Knopf::X1, 3),
            (Knopf::X2, 4),
        ] {
            for runter in [true, false] {
                assert_eq!(
                    zurueck(bauen::maus_knopf(knopf, runter)),
                    InputFrame::MouseButton { btn: nr, down: runter },
                    "{knopf:?} runter={runter}"
                );
            }
        }
    }

    #[test]
    fn rad_mit_vorzeichen() {
        for (dv, dh) in [(120i16, 0i16), (0, -120), (-360, 240)] {
            assert_eq!(
                zurueck(bauen::maus_rad(dv, dh)),
                InputFrame::MouseWheel { dv, dh },
                "({dv},{dh})"
            );
        }
    }

    /// Der Erweiterungs-Praefix `0xE0` muss den ganzen Weg ueberleben.
    #[test]
    fn tasten_samt_erweiterungs_praefix() {
        for scan in [0x0000u16, 0x001E, 0x001D, 0xE01D, 0xE04B, 0x00FF] {
            for runter in [true, false] {
                assert_eq!(
                    zurueck(bauen::taste(scan, runter)),
                    InputFrame::Key { scan, down: runter },
                    "{scan:#06x} runter={runter}"
                );
            }
        }
    }

    /// Jeder gebaute Frame hat genau die Laenge, die der Parser verlangt — zu
    /// lang ist dort so ungueltig wie zu kurz.
    #[test]
    fn jede_gebaute_laenge_wird_angenommen() {
        let alle = [
            bauen::hello(),
            bauen::maus_abs(1, 2),
            bauen::maus_rel(1, 2),
            bauen::maus_knopf(Knopf::Links, true),
            bauen::maus_rad(120, 0),
            bauen::taste(0x1E, true),
        ];
        for r in alle {
            assert!(
                InputFrame::parse(r.as_slice()).is_ok(),
                "Opcode {:#04x} mit {} Byte",
                r.opcode(),
                r.as_slice().len()
            );
        }
    }
}
```

- [ ] **Step 7: Tests laufen lassen**

Run: `cd streaming/pulse-fernsteuerung && cargo test`
Expected: PASS — die mitgewanderten Parser-Tests (11), die Bau-Tests aus dem Player, die drei `format`-Tests und die sieben Hin-und-zurück-Tests.

- [ ] **Step 8: Nachweisen, dass der Parser unverändert ist**

Run:

```bash
diff <(git show HEAD:streaming/win-hq-sidecar/src/remote_input/rahmen.rs) \
     streaming/pulse-fernsteuerung/src/rahmen.rs
```

Expected: **nur** die vier in Step 3 genannten Änderungen — der gelöschte Konstanten-Block, das `use crate::format::*;`, die sechs Match-Muster, der eine Doku-Verweis. Steht dort mehr, ist versehentlich Verhalten mitgeändert worden.

Dasselbe für den Bauer:

```bash
diff <(git show HEAD:streaming/pulse-player/src/fernsteuerung/rahmen.rs) \
     streaming/pulse-fernsteuerung/src/bauen.rs
```

Expected: nur der gelöschte Konstanten-Block und das `use`.

- [ ] **Step 9: Committen**

```bash
git add streaming/pulse-fernsteuerung
git commit -m "feat(fernsteuerung): gemeinsame Kiste mit dem Frame-Format beider Richtungen

Das Format stand zweimal im Baum — der Player baute Frames, der Sidecar parste
sie —, und kein Zwillings-Test hielt die beiden zusammen. Genau die Lage, aus
der der Zeigerbild-Fehler entstand. Jetzt steht es einmal, und der
Hin-und-zurueck-Test prueft beide Richtungen gegeneinander."
```

---

### Task 2: Die reinen Rechnungen — Base64, Zuordnung, Bewegungsschwelle

Drei Module ohne jeden Plattformbezug. `zuordnung` verliert dabei seinen Windows-Typ.

**Files:**
- Create: `streaming/pulse-fernsteuerung/src/base64.rs`
- Create: `streaming/pulse-fernsteuerung/src/zuordnung.rs`
- Create: `streaming/pulse-fernsteuerung/src/bewegung.rs`
- Modify: `streaming/pulse-fernsteuerung/src/lib.rs`

**Interfaces:**
- Consumes: nichts aus Task 1.
- Produces:
  - `base64::dekodiere(&str) -> Result<Vec<u8>, String>` (Signatur wie heute im Windows-Sidecar)
  - `zuordnung::Rechteck { links: i32, oben: i32, rechts: i32, unten: i32 }` — `Copy`, `Debug`, `PartialEq`, `Eq`
  - `zuordnung::anteil_auf_punkt(x: u16, y: u16, r: &Rechteck) -> Option<(i32, i32)>`
  - `zuordnung::klemmen(px: i32, py: i32, r: &Rechteck) -> Option<(i32, i32)>`
  - `zuordnung::mitte(r: &Rechteck) -> Option<(i32, i32)>`
  - `bewegung::Bewegung`, `bewegung::Bewegung::neu()`, `bewegung::zaehlt(&mut Bewegung, jetzt_ms: u64, x: i32, y: i32, eigen: bool) -> bool`
  - `bewegung::{SCHWELLE_PX: u32, FENSTER_MS: u64}`

- [ ] **Step 1: `base64.rs` verbatim übernehmen**

```bash
cp streaming/win-hq-sidecar/src/remote_input/base64.rs \
   streaming/pulse-fernsteuerung/src/base64.rs
```

Keine inhaltliche Änderung. Falls die Datei `use super::…` enthält, entfällt das — sie ist eigenständig.

- [ ] **Step 2: `zuordnung.rs` anlegen — mit `Rechteck` statt `RECT`**

Die Datei entsteht aus `streaming/win-hq-sidecar/src/remote_input/zuordnung.rs`, aber **nur die obere Hälfte** wandert: `anteil_auf_punkt`, `klemmen`, `mitte` und ihre Tests. `VirtualDesktop`, `virtueller_desktop()` und `punkt_auf_absolut()` bleiben im Windows-Sidecar — die 0..65535-Normierung ist eine `SendInput`-Eigenheit, macOS bekommt Punkte direkt.

Kopf der neuen Datei:

```rust
//! Koordinaten-Zuordnung — Bildanteil auf einen Punkt im Quell-Rechteck.
//!
//! Der Steuernde schickt `u,v` als 0..65535, bezogen auf das **Videobild** —
//! nicht auf seinen eigenen Bildschirm und nicht auf den Desktop des Hosts.
//! Anteile statt Pixel, weil Pixelwerte verlangten, dass beide Seiten die
//! Geometrie des Hosts kennen und einig sind; bei Monitorwechsel oder
//! Aufloesungsstufe muesste das neu abgeglichen werden, und jede Verzoegerung
//! dabei setzt Klicks falsch.
//!
//! **Die Einheit des Ergebnisses gehoert der Plattform.** Auf Windows sind es
//! physische Bildpunkte (der Prozess ist DPI-bewusst), auf macOS Punkte im
//! globalen Anzeigeraum. Die Rechnung hier kennt den Unterschied nicht und
//! muss ihn nicht kennen: sie rechnet Anteile in ein Rechteck, das ihr die
//! Plattform gibt.
//!
//! Die Umrechnung auf `SendInput`-Absolutkoordinaten steht NICHT hier, sondern
//! im Windows-Sidecar (`remote_input/zuordnung.rs`) — sie gilt nur dort.

/// Das Quell-Rechteck, halboffen: rechte und untere Kante gehoeren dem
/// Nachbarn.
///
/// **Eigener Typ statt des Plattform-Typs.** Windows liefert `RECT`, macOS
/// `CGRect` (Ursprung plus Groesse, Fliesskomma). Beide werden von ihrer
/// Plattform hierher umgerechnet; die Klemm-Zusage der Spezifikation wird
/// genau einmal umgesetzt, nicht je Betriebssystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rechteck {
    pub links: i32,
    pub oben: i32,
    pub rechts: i32,
    pub unten: i32,
}
```

Danach die drei Funktionen wortgleich aus der Windows-Fassung, mit `rect.left` → `rect.links`, `rect.right` → `rect.rechts`, `rect.top` → `rect.oben`, `rect.bottom` → `rect.unten`. Die Doc-Kommentare (samt der Panik-Begründung zum entarteten Rechteck) bleiben **unverändert**; nur der Verweis auf `DwmGetWindowAttribute` bekommt den Zusatz, dass macOS für ein geschlossenes Fenster ebenso ein leeres Rechteck liefern kann.

Die mitwandernden Tests: `ecken_treffen_die_raender`, `mitte_bleibt_mitte`, `geklemmt_bleibt_im_rechteck`, `entartetes_rechteck_wird_abgewiesen`, `klemmen_haelt_das_rechteck_halboffen`. Die lokale Hilfsfunktion wird:

```rust
fn rect(l: i32, t: i32, r: i32, b: i32) -> Rechteck {
    Rechteck { links: l, oben: t, rechts: r, unten: b }
}
```

Die Tests `die_umkehrung_gilt_bis_zur_spannweite_32770`, `absolut_spannt_den_ganzen_virtuellen_desktop`, `punkte_ausserhalb_des_desktops_bleiben_im_bereich` und `absolut_rechnet_sich_zurueck` bleiben im Windows-Sidecar.

- [ ] **Step 3: `bewegung.rs` anlegen**

Aus `streaming/win-hq-sidecar/src/remote_input/wache.rs` wandern: die Konstanten `BEWEGUNGS_SCHWELLE_PX` und `BEWEGUNGS_FENSTER_MS`, die Struktur `Bewegung`, die Funktion `bewegung_zaehlt` und ihre sieben Tests. Umbenannt wird nur der Zugang: `bewegung::zaehlt` statt `bewegung_zaehlt`, `bewegung::SCHWELLE_PX`, `bewegung::FENSTER_MS`.

```rust
//! Zaehlt eine Zeigerlage als gewollte Bewegung des Hosts?
//!
//! Die reine Haelfte der Wache: der Weg zur vorigen Lage summiert sich ueber
//! ein Zeitfenster, und erst die Schwelle loest aus. Ohne Betriebssystem
//! pruefbar — die Haken (Windows) bzw. der Ereignis-Abgriff (macOS) liegen
//! bei der jeweiligen Plattform und reichen nur Zahlen herein.

/// Wie weit der Zeiger des Hosts wandern muss, damit es als Absicht zaehlt.
///
/// Ohne Schwelle genuegte ein angestossener Tisch oder ein Handballen auf dem
/// Touchpad, um den Steuernden fuenf Sekunden auszusperren. Knopf und Taste
/// tragen keine solche Schwelle — die drueckt niemand versehentlich.
pub const SCHWELLE_PX: u32 = 8;

/// In welchem Zeitfenster sich die Schwelle summieren darf. Danach beginnt die
/// Summe von vorn, damit ein ueber Minuten kriechender Zeiger (Sensorrauschen)
/// sie nie erreicht.
pub const FENSTER_MS: u64 = 250;

#[derive(Clone, Copy)]
pub struct Bewegung {
    /// Zuletzt gesehene Zeigerlage, `None` = noch keine.
    lage: Option<(i32, i32)>,
    /// Summierter Weg im laufenden Fenster.
    summe: u32,
    /// Wann das Fenster begann.
    seit_ms: u64,
}

impl Bewegung {
    pub const fn neu() -> Self {
        Self { lage: None, summe: 0, seit_ms: 0 }
    }
}

impl Default for Bewegung {
    fn default() -> Self {
        Self::neu()
    }
}
```

Danach `pub fn zaehlt(b: &mut Bewegung, jetzt_ms: u64, x: i32, y: i32, eigen: bool) -> bool` mit dem Rumpf und dem vollständigen Doc-Kommentar aus `wache.rs` (die Begründung zu `eigen` — „`MSLLHOOKSTRUCT.pt` ist die absolute Zeigerlage" — wird zu „die gemeldete Zeigerlage ist absolut", weil sie jetzt für beide Plattformen gilt).

Die sieben Tests wandern wortgleich mit: `erste_lage_zaehlt_nicht`, `zittern_unter_der_schwelle_loest_nicht_aus`, `gewollte_bewegung_loest_aus`, `sprung_loest_sofort_aus`, `kriechen_ueber_die_zeit_erreicht_die_schwelle_nie`, `nach_dem_ausloesen_beginnt_die_summe_von_vorn`, `eigene_injektion_traegt_die_lage_nach_ohne_zu_zaehlen`, `eigene_injektion_loescht_den_weg_des_hosts_nicht`. Ihre Aufrufe werden von `bewegung_zaehlt(...)` auf `zaehlt(...)` umgestellt und `frisch()` auf `Bewegung::neu()`.

- [ ] **Step 4: `lib.rs` erweitern**

```rust
pub mod base64;
pub mod bauen;
pub mod bewegung;
pub mod format;
pub mod rahmen;
pub mod zuordnung;
```

- [ ] **Step 5: Tests laufen lassen**

Run: `cd streaming/pulse-fernsteuerung && cargo test`
Expected: PASS, darunter die fünf Zuordnungs-Tests und die acht Bewegungs-Tests.

- [ ] **Step 6: Committen**

```bash
git add streaming/pulse-fernsteuerung
git commit -m "feat(fernsteuerung): Base64, Klemmrechnung und Bewegungsschwelle in die gemeinsame Kiste

Die Klemmrechnung bekommt ein eigenes Rechteck statt des Windows-RECT — die
Zusage 'nur dorthin klicken, wo man auch hinsehen darf' wird damit einmal
umgesetzt und nicht je Betriebssystem. Die SendInput-Normierung bleibt beim
Windows-Sidecar, sie gilt nur dort."
```

---

### Task 3: Der Plattform-Schnitt und die Gedrückt-Menge

**Files:**
- Create: `streaming/pulse-fernsteuerung/src/plattform.rs`
- Create: `streaming/pulse-fernsteuerung/src/druck.rs`
- Create: `streaming/pulse-fernsteuerung/src/pruefstand.rs`
- Modify: `streaming/pulse-fernsteuerung/src/lib.rs`

**Interfaces:**
- Consumes: `zuordnung::Rechteck`, `format::knopf_bekannt`.
- Produces:
  - `plattform::{Injektor, Wache, Umgebung, Zielsuche}`
  - `druck::Druck` mit `knopf`, `taste`, `knopf_ist_unten`, `anzahl`, `loslassen(&dyn Injektor) -> usize`, `knoepfe_unten() -> Vec<u8>`
  - `pruefstand::{PruefInjektor, PruefWache, PruefUmgebung, Ereignis}` (nur `#[cfg(test)]`)

- [ ] **Step 1: `plattform.rs` schreiben**

```rust
//! Der Schnitt zwischen Kern und Betriebssystem — drei Traits, sonst nichts.
//!
//! Wer eine neue Plattform anschliesst, schreibt genau diese drei und sonst
//! nichts. Umgekehrt gilt: was hier nicht steht, kennt der Kern nicht — und
//! darf ihn deshalb auch nicht beeinflussen.
//!
//! **`Sync`, weil die Sitzung von mehreren Faeden gerufen wird:** vom
//! Dispatch-Faden (eingehende Nachrichten) und vom Wecker der Wache
//! (Vorrang-Uebergaenge).

use crate::druck::Druck;
use crate::zuordnung::Rechteck;

/// Was die Plattform mit dem Betriebssystem macht.
///
/// **Alles hier ist Ausfuehrung ohne Entscheidung.** Ob ueberhaupt injiziert
/// wird, entscheidet [`crate::ausfuehrung`]; wohin, die
/// [`crate::zuordnung`]. Ein Injektor, der selbst entscheidet, waere eine
/// zweite Meinung an einer Stelle, an der es nur eine geben darf.
pub trait Injektor: Sync {
    /// Den Zeiger **absolut** auf `punkt` setzen.
    ///
    /// `gedrueckt` sagt, welche Maustasten gerade unten sind. Windows braucht
    /// das nicht; **macOS schon**: eine Bewegung bei gedruecktem Knopf ist
    /// dort ein eigener Ereignistyp (`LeftMouseDragged` statt `MouseMoved`),
    /// und ohne diese Unterscheidung zieht in vielen Programmen nichts.
    fn maus_setzen(&self, punkt: (i32, i32), gedrueckt: &Druck);

    /// Eine Maustaste. `btn` ist bereits gegen
    /// [`crate::format::knopf_bekannt`] geprueft — hier wird nicht mehr
    /// entschieden, hier wird abgefeuert.
    fn maus_knopf(&self, btn: u8, down: bool);

    /// Das Mausrad in Windows-Rastschritten (120 = eine Raste), `dv`
    /// senkrecht, `dh` waagerecht, Windows-Vorzeichen (`dv > 0` = vom Nutzer
    /// weg). Nie beide null — das siebt der Aufrufer aus.
    fn maus_rad(&self, dv: i16, dh: i16);

    /// Eine Taste per Scancode Satz 1. `scan` ist bereits gegen
    /// [`crate::format::scancode_gueltig`] geprueft.
    fn taste(&self, scan: u16, down: bool);
}

/// Sitzt der **Host** gerade selbst an Maus und Tastatur?
pub trait Wache: Sync {
    /// Die Wache aufstellen. Idempotent.
    ///
    /// **`Err` heisst: die Zusage ist auf diesem System nicht zu halten.** Der
    /// Host hat zugestimmt, weil ihm zugesagt ist, dass er jederzeit mit einer
    /// Handbewegung uebernimmt. Laesst sich das nicht durchsetzen, verweigert
    /// der Handschlag die Sitzung, statt still etwas Schwaecheres unter
    /// demselben Etikett zu liefern (dieselbe Linie wie bei HDR).
    fn starten(&self) -> Result<(), String>;

    /// Die Wache abbauen. Idempotent, und **ohne auf einen Faden zu warten**:
    /// dieser Weg laeuft auch beim Prozessende und unter der Sitzungssperre.
    fn stoppen(&self);

    fn host_regt_sich(&self) -> bool;

    /// Wie lange der Vorrang noch gilt (0 = keiner). Geht als Zahl an den
    /// Steuernden, damit er „noch 4 s" sehen kann statt nur „gesperrt".
    fn rest_ms(&self) -> u64;
}

/// Alles Uebrige, was der Kern von aussen braucht.
pub trait Umgebung: Sync {
    /// Welches Rechteck meint dieser Platz gerade?
    ///
    /// **Jedes Mal frisch** — Fenster bewegen sich. Der Aufrufer haelt das
    /// Ergebnis fuer die Dauer EINER Nachricht, nicht fuer die Sitzung.
    fn ziel(&self, slot: u64) -> Zielsuche;

    /// Host-Zeiger in die Aufnahme zurueck (`true`) oder heraus (`false`) —
    /// das Cursor-Echo. Ohne laufende Aufnahme folgenlos.
    ///
    /// Laeuft bei JEDER Nachricht, deren letzter Frame die Fuehrung wechselt,
    /// und bei jedem Vorrang-Uebergang. Was nur ans Sitzungsende gehoert, hat
    /// hier nichts zu suchen — dafuer gibt es [`Self::sitzung_beendet`].
    fn host_zeiger_zeigen(&self, zeigen: bool);

    /// Die Sitzung ist vorbei — was die Plattform an sitzungsgebundenen
    /// Merkern fuehrt, wird geraeumt.
    ///
    /// **Eigener Weg, obwohl das Sitzungsende auch `host_zeiger_zeigen(true)`
    /// ausloest.** Auf Windows raeumt das den Merker der gemeldeten
    /// Zeigerform; haenge man es an `host_zeiger_zeigen`, liefe es zusaetzlich
    /// bei jedem Wechsel von absoluter auf relative Mausfuehrung und bei jedem
    /// Vorrang-Uebergang — der Sidecar hielte die Form dann fuer unbekannt und
    /// schickte sie erneut. Das waere eine Verhaltensaenderung, und zwar eine
    /// mit Kosten auf der Leitung.
    fn sitzung_beendet(&self);

    /// Laeuft gerade eine Fernsteuerung? Der Aufnahme-Takt haengt daran.
    fn fern_aktiv_setzen(&self, aktiv: bool);

    /// Vorrang beginnt oder endet — geht als `remote_state` nach vorn.
    fn vorrang_melden(&self, gilt: bool, hold_ms: u64);

    /// fail-closed — geht als `remote_state` mit `input_error` nach vorn.
    fn fehler_melden(&self, grund: &str);
}

/// Was die Aufloesung eines Platzes ergeben hat.
pub enum Zielsuche {
    /// Ein Stream traegt diesen Platz.
    ///
    /// `rechteck` ist `None`, wenn die Quelle gerade nicht aufloesbar ist
    /// (Fenster zu, Bildschirm abgesteckt) — dann wird die Bewegung verworfen
    /// und die gemerkte Zeigerlage entwertet. `sichtbar = false` heisst
    /// Sichtschutz: der Steuernde sieht Schwarzbild und darf nicht blind
    /// klicken.
    Gefunden { rechteck: Option<Rechteck>, sichtbar: bool },
    /// Kein Stream auf diesem Platz → still verwerfen, Sitzung bleibt stehen.
    ///
    /// **Die eine Ausnahme von fail-closed.** Streams enden asynchron, ein
    /// Platz kann zwischen Absenden und Ankunft verschwinden. Das ist ein
    /// Rennen, kein Angriff.
    KeinStrom,
    /// Stream da, Quelle aber nicht aufloesbar → auch verwerfen, aber mit
    /// Begruendung in der Diagnose.
    NichtAufloesbar(String),
}
```

- [ ] **Step 2: `druck.rs` übernehmen — mit durchgereichtem Injektor**

Aus `streaming/win-hq-sidecar/src/remote_input/druck.rs`, mit zwei Änderungen: die Sichtbarkeiten werden `pub` statt `pub(in crate::remote_input)`, und `loslassen` bekommt den Injektor.

```rust
//! Die Menge dessen, was gerade **physisch unten** ist — und ihre Freigabe.
//!
//! Eigener Typ, weil daran die wichtigste Zusage der Fernsteuerung haengt:
//! „Alles loslassen beim Ende." Wer drueckt, muss vermerken; sonst bleibt beim
//! Sitzungsende, beim Verwerfen, beim Hello oder beim Prozessende etwas unten,
//! und die W-Taste laeuft im Spiel des fremden Rechners weiter.
//!
//! Wer freigibt, entscheidet die Sitzung ([`crate::sitzung`]) — hier steht
//! nur, **wie** freigegeben wird.

use std::collections::HashSet;

use crate::plattform::Injektor;

#[derive(Default)]
pub struct Druck {
    /// Gedrueckte Maustasten (btn-Code).
    knoepfe: HashSet<u8>,
    /// Gedrueckte Tasten (voller Scancode inkl. `0xE0`-Praefix).
    tasten: HashSet<u16>,
}

impl Druck {
    pub fn knopf(&mut self, btn: u8, down: bool) {
        vermerken(&mut self.knoepfe, btn, down);
    }

    pub fn taste(&mut self, scan: u16, down: bool) {
        vermerken(&mut self.tasten, scan, down);
    }

    /// Haben **wir** diesen Knopf unten? Nur dann darf sein Hoch-Ereignis das
    /// Orts-Tor umgehen (s. [`crate::ausfuehrung`]) — sonst klemmte eine
    /// Maustaste am fremden Rechner, sobald das Quell-Rechteck wegfaellt.
    pub fn knopf_ist_unten(&self, btn: u8) -> bool {
        self.knoepfe.contains(&btn)
    }

    /// Welche Maustasten gerade unten sind.
    ///
    /// **Fuer den Injektor, nicht fuer den Kern.** macOS muss eine Bewegung
    /// bei gedruecktem Knopf als Zieh-Ereignis abfeuern und braucht dafuer zu
    /// wissen, welcher Knopf zieht. Sortiert, damit die Antwort nicht von der
    /// Streuung der Menge abhaengt — sonst zoege ein Injektor mit zwei
    /// gedrueckten Knoepfen mal den einen, mal den anderen.
    pub fn knoepfe_unten(&self) -> Vec<u8> {
        let mut v: Vec<u8> = self.knoepfe.iter().copied().collect();
        v.sort_unstable();
        v
    }

    pub fn anzahl(&self) -> usize {
        self.knoepfe.len() + self.tasten.len()
    }

    /// Alles Gedrueckte freigeben. Liefert, wie viel es war.
    ///
    /// **Der Injektor kommt herein, statt hier zu stehen.** Vorher rief dieses
    /// Modul den Windows-Injektor direkt — damit war die Gedrueckt-Menge an
    /// ein Betriebssystem gebunden, obwohl sie nichts davon weiss.
    pub fn loslassen(&mut self, injektor: &dyn Injektor) -> usize {
        let n = self.anzahl();
        let knoepfe = std::mem::take(&mut self.knoepfe);
        let tasten = std::mem::take(&mut self.tasten);
        for btn in knoepfe {
            injektor.maus_knopf(btn, false);
        }
        for scan in tasten {
            injektor.taste(scan, false);
        }
        n
    }
}

/// Druckzustand nachfuehren: runter merkt sich die Taste, hoch vergisst sie.
fn vermerken<T: Eq + std::hash::Hash>(menge: &mut HashSet<T>, was: T, down: bool) {
    if down {
        menge.insert(was);
    } else {
        menge.remove(&was);
    }
}
```

**Achtung, ein Verhaltensdetail:** Die Windows-Fassung siebte beim Loslassen über `injektion::tasten_ereignis(btn, false)` und ließ einen unbekannten Knopf still fallen. In die Menge kommt aber nur, was `ausfuehrung` vorher gegen `format::knopf_bekannt` geprüft hat — die Siebung war unerreichbar. Sie entfällt hier ersatzlos; die Prüfung steht weiterhin genau einmal, nur eine Ebene höher.

- [ ] **Step 3: `pruefstand.rs` schreiben — die Test-Plattform**

```rust
//! Die Plattform fuer Tests: statt zu injizieren wird mitgeschrieben.
//!
//! **Warum das eine ausdrueckliche Plattform ist.** Vorher fing der
//! Windows-Injektor sich im Testbau selbst ab (`#[cfg(not(test))]` um den
//! echten `SendInput`-Aufruf). Das funktionierte, war aber unsichtbar: wer die
//! Datei las, sah nicht, dass die Tests etwas anderes ausfuehren als der
//! Auslieferbau. Als Trait-Umsetzung steht es da.
//!
//! Kein globaler Zustand: jeder Test baut sich seinen eigenen Pruefstand.
//! Deshalb braucht diese Kiste auch keine prozessweite Reihenfolge-Sperre —
//! die gab es im Windows-Sidecar nur, weil Sitzung, Wache und
//! Strom-Registrierung dort prozessweit lagen.

use std::sync::Mutex;

use crate::druck::Druck;
use crate::plattform::{Injektor, Umgebung, Wache, Zielsuche};
use crate::zuordnung::Rechteck;

/// Was ohne Testlauf ans Betriebssystem gegangen waere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ereignis {
    Setzen { punkt: (i32, i32), zieht: bool },
    Knopf { btn: u8, down: bool },
    Rad { dv: i16, dh: i16 },
    Taste { scan: u16, down: bool },
}

#[derive(Default)]
pub struct PruefInjektor {
    spur: Mutex<Vec<Ereignis>>,
}

impl PruefInjektor {
    /// Die Spur abholen und leeren.
    pub fn nimm(&self) -> Vec<Ereignis> {
        std::mem::take(&mut self.spur.lock().unwrap())
    }

    fn schreibe(&self, e: Ereignis) {
        self.spur.lock().unwrap().push(e);
    }
}

impl Injektor for PruefInjektor {
    fn maus_setzen(&self, punkt: (i32, i32), gedrueckt: &Druck) {
        // `zieht` haelt fest, ob der Injektor die Zieh-Unterscheidung
        // ueberhaupt treffen KANN — das ist der macOS-Fall, und ein Test darf
        // belegen, dass die Menge ankommt.
        self.schreibe(Ereignis::Setzen { punkt, zieht: !gedrueckt.knoepfe_unten().is_empty() });
    }
    fn maus_knopf(&self, btn: u8, down: bool) {
        self.schreibe(Ereignis::Knopf { btn, down });
    }
    fn maus_rad(&self, dv: i16, dh: i16) {
        self.schreibe(Ereignis::Rad { dv, dh });
    }
    fn taste(&self, scan: u16, down: bool) {
        self.schreibe(Ereignis::Taste { scan, down });
    }
}

/// Eine Wache, die sich stellen laesst.
#[derive(Default)]
pub struct PruefWache {
    /// Regt sich der Host gerade?
    pub regung: Mutex<bool>,
    /// Laesst sich die Wache ueberhaupt aufstellen? `false` prueft die
    /// Startverweigerung.
    pub aufstellbar: Mutex<bool>,
    pub steht: Mutex<bool>,
}

impl PruefWache {
    pub fn neu() -> Self {
        Self { regung: Mutex::new(false), aufstellbar: Mutex::new(true), steht: Mutex::new(false) }
    }
    pub fn regen(&self, ja: bool) {
        *self.regung.lock().unwrap() = ja;
    }
}

impl Wache for PruefWache {
    fn starten(&self) -> Result<(), String> {
        if !*self.aufstellbar.lock().unwrap() {
            return Err("Pruefstand: Wache nicht aufstellbar".to_string());
        }
        *self.steht.lock().unwrap() = true;
        Ok(())
    }
    fn stoppen(&self) {
        *self.steht.lock().unwrap() = false;
    }
    fn host_regt_sich(&self) -> bool {
        *self.regung.lock().unwrap()
    }
    fn rest_ms(&self) -> u64 {
        if self.host_regt_sich() { 5_000 } else { 0 }
    }
}

/// Eine Umgebung, deren Zielauskunft sich stellen laesst.
pub struct PruefUmgebung {
    pub ziel: Mutex<ZielAntwort>,
    pub zeiger_sichtbar: Mutex<bool>,
    pub fern_aktiv: Mutex<bool>,
    pub meldungen: Mutex<Vec<String>>,
    /// Wie oft das Sitzungsende gemeldet wurde. Zaehler statt Schalter, damit
    /// ein Test belegen kann, dass es NICHT bei jedem Zeigerwechsel laeuft.
    pub beendet: Mutex<u32>,
}

/// Was [`PruefUmgebung::ziel`] antworten soll — `Zielsuche` selbst ist nicht
/// `Clone`, deshalb diese kleine Bauanleitung daneben.
#[derive(Clone, Copy)]
pub enum ZielAntwort {
    Gefunden { rechteck: Option<Rechteck>, sichtbar: bool },
    KeinStrom,
    NichtAufloesbar,
}

impl Default for PruefUmgebung {
    fn default() -> Self {
        Self {
            ziel: Mutex::new(ZielAntwort::Gefunden {
                rechteck: Some(Rechteck { links: 100, oben: 200, rechts: 1100, unten: 800 }),
                sichtbar: true,
            }),
            zeiger_sichtbar: Mutex::new(true),
            fern_aktiv: Mutex::new(false),
            meldungen: Mutex::new(Vec::new()),
            beendet: Mutex::new(0),
        }
    }
}

impl Umgebung for PruefUmgebung {
    fn ziel(&self, _slot: u64) -> Zielsuche {
        match *self.ziel.lock().unwrap() {
            ZielAntwort::Gefunden { rechteck, sichtbar } => {
                Zielsuche::Gefunden { rechteck, sichtbar }
            }
            ZielAntwort::KeinStrom => Zielsuche::KeinStrom,
            ZielAntwort::NichtAufloesbar => {
                Zielsuche::NichtAufloesbar("Pruefstand".to_string())
            }
        }
    }
    fn host_zeiger_zeigen(&self, zeigen: bool) {
        *self.zeiger_sichtbar.lock().unwrap() = zeigen;
    }
    fn sitzung_beendet(&self) {
        *self.beendet.lock().unwrap() += 1;
    }
    fn fern_aktiv_setzen(&self, aktiv: bool) {
        *self.fern_aktiv.lock().unwrap() = aktiv;
    }
    fn vorrang_melden(&self, gilt: bool, hold_ms: u64) {
        self.meldungen.lock().unwrap().push(format!("vorrang={gilt} hold={hold_ms}"));
    }
    fn fehler_melden(&self, grund: &str) {
        self.meldungen.lock().unwrap().push(format!("fehler={grund}"));
    }
}
```

- [ ] **Step 4: Einen Test für die Gedrückt-Menge schreiben**

Ans Ende von `druck.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::pruefstand::{Ereignis, PruefInjektor};

    #[test]
    fn vermerken_fuehrt_den_druckzustand() {
        let mut d = Druck::default();
        d.knopf(0, true);
        d.taste(0x1E, true);
        assert_eq!(d.anzahl(), 2);
        assert!(d.knopf_ist_unten(0));
        d.knopf(0, false);
        assert!(!d.knopf_ist_unten(0));
        assert_eq!(d.anzahl(), 1);
    }

    /// Die wichtigste Zusage: was gedrueckt ist, wird beim Loslassen
    /// **abgefeuert** — sonst laeuft die W-Taste am fremden Rechner weiter.
    #[test]
    fn loslassen_feuert_jedes_hoch_ereignis_ab() {
        let inj = PruefInjektor::default();
        let mut d = Druck::default();
        d.knopf(1, true);
        d.taste(0xE01D, true);
        assert_eq!(d.loslassen(&inj), 2);
        assert_eq!(d.anzahl(), 0);
        let spur = inj.nimm();
        assert!(spur.contains(&Ereignis::Knopf { btn: 1, down: false }), "{spur:?}");
        assert!(spur.contains(&Ereignis::Taste { scan: 0xE01D, down: false }), "{spur:?}");
    }

    /// Zweimal loslassen feuert nicht zweimal — sonst kaeme bei jedem
    /// Verwerf-Pfad ein weiteres Hoch-Ereignis heraus.
    #[test]
    fn loslassen_ist_idempotent() {
        let inj = PruefInjektor::default();
        let mut d = Druck::default();
        d.taste(0x11, true);
        assert_eq!(d.loslassen(&inj), 1);
        let _ = inj.nimm();
        assert_eq!(d.loslassen(&inj), 0);
        assert!(inj.nimm().is_empty());
    }

    /// Die Reihenfolge der gedrueckten Knoepfe darf nicht von der Streuung
    /// der Menge abhaengen — sonst zoege ein macOS-Injektor mal den einen,
    /// mal den anderen.
    #[test]
    fn knoepfe_unten_ist_sortiert() {
        let mut d = Druck::default();
        for btn in [4u8, 0, 2] {
            d.knopf(btn, true);
        }
        assert_eq!(d.knoepfe_unten(), vec![0, 2, 4]);
    }
}
```

- [ ] **Step 5: `lib.rs` erweitern**

```rust
pub mod base64;
pub mod bauen;
pub mod bewegung;
pub mod druck;
pub mod format;
pub mod plattform;
pub mod rahmen;
pub mod zuordnung;

#[cfg(test)]
mod pruefstand;
```

- [ ] **Step 6: Tests laufen lassen**

Run: `cd streaming/pulse-fernsteuerung && cargo test`
Expected: PASS, darunter die vier neuen Druck-Tests.

- [ ] **Step 7: Committen**

```bash
git add streaming/pulse-fernsteuerung
git commit -m "feat(fernsteuerung): Plattform-Schnitt und Gedrueckt-Menge

Drei Traits statt eines Betriebssystems: Injektor, Wache, Umgebung. Die
Gedrueckt-Menge bekommt den Injektor hereingereicht, statt ihn zu kennen — sie
weiss nichts von SendInput und soll nichts davon wissen."
```

---

### Task 4: Die Ausführung — was injiziert wird

**Files:**
- Create: `streaming/pulse-fernsteuerung/src/ausfuehrung.rs`
- Modify: `streaming/pulse-fernsteuerung/src/lib.rs`

**Interfaces:**
- Consumes: `rahmen::InputFrame`, `zuordnung::{Rechteck, anteil_auf_punkt, klemmen, mitte}`, `druck::Druck`, `plattform::Injektor`, `format::{knopf_bekannt, scancode_gueltig}`.
- Produces:
  - `ausfuehrung::Tat { zeiger: Option<(i32, i32)>, druck: Druck }` — der fortgeschriebene Teil des Sitzungszustands, `pub(crate)`. **Heißt von Anfang an `Tat`**, damit Task 5 nichts umbenennen muss: die Sitzung führt ihren eigenen `Zustand` und hält eine `Tat` darin.
  - `ausfuehrung::einspielen(t: &mut Tat, injektor: &dyn Injektor, rechteck: Option<Rechteck>, frame: InputFrame) -> Result<(), String>`

- [ ] **Step 1: `ausfuehrung.rs` aus dem Windows-Sidecar übernehmen**

```bash
cp streaming/win-hq-sidecar/src/remote_input/ausfuehrung.rs \
   streaming/pulse-fernsteuerung/src/ausfuehrung.rs
```

Die Modul-Doku bleibt **vollständig und wortgleich** — sie trägt die Begründung der Klemm-Zusage und die drei Fälle, die daran hängen. Nur zwei Sätze werden allgemein: „Die Spezifikation will für den Zeigerfang `MOUSEEVENTF_MOVE` ohne `ABSOLUTE`" wird zu „Die Spezifikation will für den Zeigerfang eine rohe Relativbewegung, damit das System seine Beschleunigung auflegt"; und „`SendInput` arbeitet die Warteschlange in Reihenfolge ab" wird zu „die Einspielung arbeitet die Warteschlange in Reihenfolge ab".

- [ ] **Step 2: Die Windows-Bezüge ersetzen**

Sechs Stellen, sonst nichts:

1. Die `use windows::…`-Zeilen entfallen. Neu:

```rust
use crate::druck::Druck;
use crate::format;
use crate::plattform::Injektor;
use crate::rahmen::InputFrame;
use crate::zuordnung::{self, Rechteck};
```

2. `rechteck: Option<RECT>` wird `rechteck: Option<Rechteck>`, ebenso `rect: &RECT` in `relatives_ziel` und `tat_ort`.

3. Die Signatur bekommt den Injektor und den Zustand aus dieser Kiste:

```rust
/// Der Teil des Sitzungszustands, den die Ausfuehrung fortschreibt.
///
/// Die Sitzung fuehrt ihn (sie entscheidet ueber Handschlag, Stilllegung und
/// Ende); hier wird er nur geschrieben. Deshalb ein eigener Typ und nicht der
/// ganze Sitzungszustand: die Ausfuehrung soll `stillgelegt` und `geschlossen`
/// gar nicht sehen koennen.
#[derive(Default)]
pub(crate) struct Tat {
    /// Wo dieser Prozess den Zeiger zuletzt SELBST hingesetzt hat — geklemmt
    /// und damit nachweislich im Quell-Rechteck. `None` = unbekannt, dann
    /// feuert kein Knopf und kein Rad.
    pub(crate) zeiger: Option<(i32, i32)>,
    /// Alles, was gerade physisch unten ist — fuers Loslassen.
    pub(crate) druck: Druck,
}

pub(crate) fn einspielen(
    z: &mut Tat,
    injektor: &dyn Injektor,
    rechteck: Option<Rechteck>,
    frame: InputFrame,
) -> Result<(), String> {
```

Alle weiteren `Zustand`-Nennungen in der kopierten Datei (Signaturen von `bewegen` und `tat_ort`, die Testhilfe `zustand()`) werden ebenfalls `Tat`.

4. Der Knopf-Zweig prüft gegen das Format statt gegen die Windows-Tabelle, und feuert über den Injektor:

```rust
        InputFrame::MouseButton { btn, down } => {
            // Unbekannter Knopf ist fail-closed, und zwar **vor** allem
            // anderen: ein Frame, den wir nicht deuten koennen, ist ein Fehler
            // oder ein Angriff — unabhaengig davon, wo der Zeiger steht.
            if !format::knopf_bekannt(btn) {
                return Err(format!("unbekannte Maustaste: {btn}"));
            }
            let ort = tat_ort(z, rechteck);
            // Loslassen eines von uns gedrueckten Knopfes: immer, sonst klemmt er.
            let freigabe = !down && z.druck.knopf_ist_unten(btn);
            if ort.is_none() && !freigabe {
                return Ok(());
            }
            if let Some(ort) = ort {
                injektor.maus_setzen(ort, &z.druck);
            }
            injektor.maus_knopf(btn, down);
            z.druck.knopf(btn, down);
        }
```

5. Der Rad- und der Tasten-Zweig entsprechend:

```rust
        InputFrame::MouseWheel { dv, dh } => {
            if dv == 0 && dh == 0 {
                return Ok(());
            }
            let Some(ort) = tat_ort(z, rechteck) else {
                return Ok(());
            };
            injektor.maus_setzen(ort, &z.druck);
            injektor.maus_rad(dv, dh);
        }
        InputFrame::Key { scan, down } => {
            if !format::scancode_gueltig(scan) {
                return Err(format!(
                    "missgeformter Scancode {scan:#06x} — Satz 1 kennt nur 0x00xx und 0xE0xx"
                ));
            }
            injektor.taste(scan, down);
            z.druck.taste(scan, down);
        }
```

**Wichtig:** Das Rad feuerte auf Windows getrennt für senkrecht und waagerecht (zwei `SendInput`-Aufrufe). Der Trait nimmt beides in einem Aufruf — die Aufteilung ist eine Windows-Eigenheit und gehört in dessen Injektor. Die Bedingung `if dv != 0` / `if dh != 0` wandert damit dorthin.

6. `bewegen` und `absolut_setzen` werden zusammengelegt, weil die Absolut-Normierung Windows-eigen ist:

```rust
/// Den Zeiger auf einen geklemmten Punkt setzen und ihn merken. `None` = die
/// Bewegung war nicht ausfuehrbar (kein oder entartetes Rechteck): dann wird
/// **auch die gemerkte Lage ungueltig**, denn wo der Zeiger jetzt steht, weiss
/// niemand — und ein Klick darf dort nicht feuern.
fn bewegen(z: &mut Tat, injektor: &dyn Injektor, punkt: Option<(i32, i32)>) {
    if let Some(p) = punkt {
        injektor.maus_setzen(p, &z.druck);
    }
    z.zeiger = punkt;
}
```

- [ ] **Step 3: Die zwölf Tests umstellen**

Die Testnamen bleiben **unverändert**: `relative_bewegung_verlaesst_das_rechteck_nie`, `relative_bewegung_ohne_brauchbares_rechteck`, `relative_bewegung_wird_geklemmt_gesetzt`, `knopf_feuert_nicht_ohne_gueltige_lage`, `knopf_feuert_nicht_ausserhalb_des_rechtecks`, `verworfene_bewegung_entwertet_die_lage`, `knopf_feuert_mit_gueltiger_lage`, `loslassen_geht_auch_ohne_lage_durch`, `fremdes_loslassen_faellt_unter_das_tor`, `unbekannter_knopf_ist_fail_closed`, `rad_feuert_nicht_ohne_gueltige_lage`, `missgeformter_scancode_ist_fail_closed`, `taste_braucht_keine_zeigerlage`.

Der Testkopf wird:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::pruefstand::{Ereignis, PruefInjektor};

    fn rect(l: i32, t: i32, r: i32, b: i32) -> Rechteck {
        Rechteck { links: l, oben: t, rechts: r, unten: b }
    }

    /// Ein Quell-Rechteck, das mit Sicherheit nicht den ganzen Desktop fuellt —
    /// sonst pruefte die Klemmung nichts.
    const QUELLE: Rechteck = Rechteck { links: 100, oben: 200, rechts: 1100, unten: 800 };

    fn zustand(zeiger: Option<(i32, i32)>) -> Tat {
        Tat { zeiger, ..Tat::default() }
    }

    fn setz_ereignisse(spur: &[Ereignis]) -> usize {
        spur.iter().filter(|e| matches!(e, Ereignis::Setzen { .. })).count()
    }
```

Die Zählungen ändern sich dabei an drei Stellen, weil ein `Setzen` jetzt EIN Ereignis ist statt eines normierten `Maus`-Aufrufs:

- `knopf_feuert_mit_gueltiger_lage`: `assert_eq!(setz_ereignisse(&spur), 1)` plus `assert!(spur.contains(&Ereignis::Knopf { btn: 0, down: true }))`.
- `rad_feuert_nicht_ohne_gueltige_lage`, zweiter Teil: `setz_ereignisse == 1` und **ein** `Ereignis::Rad { dv: 120, dh: -120 }` statt zweier getrennter Aufrufe.
- `relative_bewegung_wird_geklemmt_gesetzt`: prüft direkt auf `Ereignis::Setzen { punkt: (QUELLE.links, QUELLE.oben), .. }`; die `punkt_auf_absolut`-Rechnung entfällt hier und bleibt im Windows-Sidecar.

`loslassen_geht_auch_ohne_lage_durch` zählt statt `maus_ereignisse` jetzt `Ereignis::Knopf { btn: 1, down: false }`.

- [ ] **Step 4: `lib.rs` erweitern**

`mod ausfuehrung;` (nicht `pub`) ergänzen.

- [ ] **Step 5: Tests laufen lassen**

Run: `cd streaming/pulse-fernsteuerung && cargo test`
Expected: PASS, darunter die dreizehn Ausführungs-Tests.

- [ ] **Step 6: Nachweisen, dass die Entscheidungen unverändert sind**

Run:

```bash
diff <(git show HEAD:streaming/win-hq-sidecar/src/remote_input/ausfuehrung.rs) \
     streaming/pulse-fernsteuerung/src/ausfuehrung.rs
```

Expected: Änderungen ausschließlich an den in Step 2 und 3 genannten Stellen. Insbesondere dürfen **keine** Zeilen in `tat_ort`, `relatives_ziel` und der Reihenfolge der Prüfungen abweichen — daran hängt die Klemm-Zusage.

- [ ] **Step 7: Committen**

```bash
git add streaming/pulse-fernsteuerung
git commit -m "feat(fernsteuerung): die Ausfuehrung in die gemeinsame Kiste

Was injiziert wird und was nicht — samt Orts-Tor fuer Knopf und Rad und der
Ausnahme fuer das Loslassen. Das Rad geht als EIN Aufruf an den Injektor; die
Aufteilung in senkrecht und waagerecht ist eine Windows-Eigenheit und gehoert
dorthin."
```

---

### Task 5: Die Sitzung — die Zustandsmaschine mit ihren Zusagen

Das Herzstück. Achtzehn Tests, die heute nur auf Windows laufen, laufen danach hier.

**Files:**
- Create: `streaming/pulse-fernsteuerung/src/sitzung.rs`
- Create: `streaming/pulse-fernsteuerung/src/sitzung_tests.rs`
- Modify: `streaming/pulse-fernsteuerung/src/lib.rs`

**Interfaces:**
- Consumes: alles aus den Tasks 1 bis 4.
- Produces:
  - `sitzung::Sitzung::neu(injektor: &'static dyn Injektor, wache: &'static dyn Wache, umgebung: &'static dyn Umgebung) -> Sitzung`
  - `sitzung::Sitzung::frames(&self, slot: u64, sitzungs_id: Option<&str>, frames: &[Vec<u8>], fremder_vorrang: bool) -> Result<Bericht, String>`
  - `sitzung::Sitzung::beenden(&self) -> usize`
  - `sitzung::Sitzung::beenden_endgueltig(&self) -> usize`
  - `sitzung::Sitzung::protokollfehler(&self, grund: String) -> String`
  - `sitzung::Sitzung::vorrang_tick(&self)` — vom Wecker der Plattform gerufen
  - `sitzung::Bericht { verarbeitet: usize, zustand: &'static str }`

- [ ] **Step 1: `sitzung.rs` aus `remote_input/mod.rs` und `vorrang.rs` zusammenführen**

```bash
cp streaming/win-hq-sidecar/src/remote_input/mod.rs \
   streaming/pulse-fernsteuerung/src/sitzung.rs
```

Die Modul-Doku mit ihren fünf Zusagen („Alles loslassen beim Ende", „Fail-closed", „Der Handschlag ist Sitzungszustand", „Der Host hat Vorrang", „Keine Panik nimmt die Freigabe mit") wandert **wortgleich** mit. Sie ist der Grund für diese Kiste.

Die Modul-Deklarationen (`pub mod ausfuehrung;` usw.) und `pruefstand()` am Dateiende entfallen — sie gehören zur alten Baumstruktur.

- [ ] **Step 2: Die Struktur umbauen**

```rust
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use crate::ausfuehrung;
use crate::druck::Druck;
use crate::format::PROTOKOLL_VERSION;
use crate::plattform::{Injektor, Umgebung, Wache, Zielsuche};
use crate::rahmen::InputFrame;

/// Was aus einer Nachricht wurde — geht als Antwortfelder zurueck an den
/// Aufrufer und ist damit das, woran die Abnahme misst.
pub struct Bericht {
    pub verarbeitet: usize,
    /// `live` · `unknown_slot` · `unresolved_source` · `masked` · `host_active`
    /// · `ended`
    pub zustand: &'static str,
}

/// Die eine Fernsteuer-Sitzung eines Sidecar-Prozesses.
///
/// Eine reicht: der Consent bestaetigt genau ein Gegenueber, und ein Sidecar
/// faehrt genau einen Stream. Alles steht hinter **einer** Sperre — Injektion
/// und Zustandsfuehrung duerfen nicht auseinanderlaufen, sonst liegt zwischen
/// dem physischen Druck und dem Vermerk darueber ein Fenster, in dem ein
/// Sitzungsende die Taste am Host haengen laesst.
///
/// **Die Plattform ist ein Feld, kein Singleton.** Dadurch braucht diese Kiste
/// keinen globalen Zustand: jeder Test baut sich eine eigene Sitzung mit
/// eigenem Pruefstand, und es gibt keine Reihenfolge zwischen Tests zu
/// verwalten. Der Sidecar-Prozess haelt seine eine Sitzung selbst.
pub struct Sitzung {
    inner: Mutex<Zustand>,
    injektor: &'static dyn Injektor,
    wache: &'static dyn Wache,
    umgebung: &'static dyn Umgebung,
    /// Wecker seit der letzten Vorrang-Meldung (s. [`WIEDERHOLUNG_TAKTE`]).
    seit_meldung: AtomicU64,
}

#[derive(Default)]
pub(crate) struct Zustand {
    /// Die Kennung der laufenden Sitzung — wechselt sie, ist es eine neue
    /// Sitzung: alles Gedrueckte der alten wird freigegeben.
    id: Option<String>,
    /// Hello empfangen? Der erste Frame MUSS eines sein.
    begruesst: bool,
    /// Nach einem Protokollfehler stillgelegt.
    stillgelegt: bool,
    /// Endgueltig zu (Prozess faehrt herunter).
    geschlossen: bool,
    /// Hat der Host gerade Vorrang? Gespiegelt aus der Wache, damit die
    /// Uebergaenge genau **einmal** laufen und nicht bei jeder Nachricht.
    vorrang: bool,
    /// Zeigerlage und Gedruecktes — fuehrt die Ausfuehrung fort.
    pub(crate) tat: ausfuehrung::Tat,
}
```

`ausfuehrung::Tat` steht seit Task 4 bereit — hier ist nichts umzubenennen. Alle Zugriffe in der kopierten `mod.rs` auf `z.druck` und `z.zeiger` werden zu `z.tat.druck` und `z.tat.zeiger`; der Aufruf `ausfuehrung::einspielen(&mut z, rechteck, andere)` wird `ausfuehrung::einspielen(&mut z.tat, self.injektor, rechteck, andere)`.

- [ ] **Step 3: Die Methoden umstellen**

Sechs Änderungen gegenüber der Windows-Fassung, sonst nichts:

1. `Sitzung::singleton()` entfällt; stattdessen:

```rust
impl Sitzung {
    pub fn neu(
        injektor: &'static dyn Injektor,
        wache: &'static dyn Wache,
        umgebung: &'static dyn Umgebung,
    ) -> Self {
        Self {
            inner: Mutex::new(Zustand::default()),
            injektor,
            wache,
            umgebung,
            seit_meldung: AtomicU64::new(0),
        }
    }
```

2. `sperre()` bleibt **wortgleich**, samt der Begründung für die übernommene vergiftete Sperre.

3. `frames(...)` liefert `Result<Bericht, String>` statt `anyhow::Result<Bericht>`. Die beiden `anyhow!`-Aufrufe werden zu `String`. Die Slot-Auflösung geht über die Umgebung:

```rust
        let (rechteck, sichtbar) = match self.umgebung.ziel(slot) {
            Zielsuche::Gefunden { rechteck, sichtbar } => (rechteck, sichtbar),
            Zielsuche::KeinStrom => {
                return self.nur_handschlag(&mut z, frames, "unknown_slot");
            }
            Zielsuche::NichtAufloesbar(grund) => {
                eprintln!(
                    "[remote-input] Slot {slot}: Quelle nicht aufloesbar ({grund}) → verworfen"
                );
                return self.nur_handschlag(&mut z, frames, "unresolved_source");
            }
        };
        // Sichtschutz: solange geschwaerzt wird, sieht der Steuernde nichts und
        // darf auch nichts tun — **saemtliche** Eingabe faellt weg.
        if !sichtbar {
            return self.nur_handschlag(&mut z, frames, "masked");
        }
```

4. `fern_abschalten()` wird eine Methode und ruft die Plattform:

```rust
    /// Was ein Sitzungsende nach AUSSEN bedeutet: Host-Zeiger zurueck in den
    /// Stream, Aufnahme-Takt zurueck auf sein glaettendes Raster, Wache
    /// abgebaut.
    ///
    /// **An einer Stelle, weil das zusammengehoert.** Es gibt drei
    /// Ausstiegswege ([`Self::beenden`], [`Self::beenden_endgueltig`] und
    /// fail-closed in [`Self::stilllegen`]); einer, der nur die Haelfte taete,
    /// liesse entweder den Zeiger fuer alle Zuschauer aus dem Bild verschwunden
    /// oder den Stream dauerhaft im ungeglaetteten Fern-Takt.
    ///
    fn fern_abschalten(&self) {
        self.umgebung.host_zeiger_zeigen(true);
        self.umgebung.fern_aktiv_setzen(false);
        // Was die Plattform an sitzungsgebundenen Merkern fuehrt — auf Windows
        // die zuletzt gemeldete Zeigerform. Ausdruecklich NICHT in
        // `host_zeiger_zeigen`, das auch bei jedem Fuehrungswechsel und jedem
        // Vorrang-Uebergang laeuft.
        self.umgebung.sitzung_beendet();
        // Die Wache hoert systemweit mit; sie hat nur zu stehen, solange
        // wirklich jemand steuert. Wartet NICHT auf ihren Faden — dieser Weg
        // laeuft auch unter der Sitzungssperre und beim Prozessende.
        self.wache.stoppen();
    }
```

5. `handschlag`, `nur_handschlag` und `stilllegen` werden Methoden (sie brauchen Injektor, Wache und Umgebung). Ihre Doc-Kommentare bleiben **wortgleich**. `z.druck.loslassen()` wird überall `z.tat.druck.loslassen(self.injektor)`. Der `emit`-Aufruf in `stilllegen` wird `self.umgebung.fehler_melden(&grund)`.

6. Das Cursor-Echo am Ende von `frames` geht über die Umgebung:

```rust
        match cursor_wunsch {
            Some(true) => self.umgebung.host_zeiger_zeigen(false),
            Some(false) => self.umgebung.host_zeiger_zeigen(true),
            None => {}
        }
```

Und im Handschlag: `self.umgebung.fern_aktiv_setzen(true);` statt `FERN_AKTIV.store(true, …)`, sowie `self.wache.starten()` statt `wache::starten()`.

- [ ] **Step 4: Den Vorrang aus `vorrang.rs` einarbeiten**

`nachfuehren` und `tick` werden Methoden auf `Sitzung`. Ihre Doc-Kommentare — samt der Begründung für `WIEDERHOLUNG_TAKTE` und für `try_lock` statt `lock` — wandern **wortgleich** mit.

```rust
/// Wie oft ein geltender Vorrang **wiederholt** gemeldet wird, gezaehlt in
/// Weckern à 100 ms — also einmal je Sekunde.
///
/// (vollstaendiger Doc-Kommentar aus `vorrang.rs` uebernehmen)
const WIEDERHOLUNG_TAKTE: u64 = 10;

impl Sitzung {
    fn vorrang_nachfuehren(&self, z: &mut Zustand) -> bool {
        let jetzt = self.wache.host_regt_sich();
        if z.vorrang == jetzt {
            return jetzt;
        }
        z.vorrang = jetzt;
        if jetzt {
            z.tat.druck.loslassen(self.injektor);
            z.tat.zeiger = None;
            self.umgebung.host_zeiger_zeigen(true);
        }
        eprintln!(
            "[remote-input] Vorrang des Hosts {}",
            if jetzt { "beginnt — Fremdeingabe wird verworfen" } else { "endet" }
        );
        self.vorrang_melden(jetzt);
        jetzt
    }

    fn vorrang_melden(&self, gilt: bool) {
        self.seit_meldung.store(0, Ordering::Relaxed);
        self.umgebung.vorrang_melden(gilt, self.wache.rest_ms());
    }

    /// Der Wecker der Wache (alle 100 ms, aus ihrem eigenen Faden).
    ///
    /// (vollstaendiger Doc-Kommentar aus `vorrang::tick` uebernehmen)
    pub fn vorrang_tick(&self) {
        let gilt = {
            let mut z = match self.inner.try_lock() {
                Ok(z) => z,
                Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => return,
            };
            self.vorrang_nachfuehren(&mut z)
        };
        if !gilt {
            return;
        }
        if self.seit_meldung.fetch_add(1, Ordering::Relaxed) + 1 >= WIEDERHOLUNG_TAKTE {
            self.vorrang_melden(true);
        }
    }
}
```

- [ ] **Step 5: Die achtzehn Sitzungs-Tests übernehmen**

```bash
cp streaming/win-hq-sidecar/src/remote_input/tests.rs \
   streaming/pulse-fernsteuerung/src/sitzung_tests.rs
```

In `sitzung.rs` ans Ende: `#[cfg(test)] mod sitzung_tests;` — oder die Tests direkt als `#[cfg(test)] mod tests { … }` einfügen; beides ist gleichwertig, der Plan nutzt die eigene Datei, damit `sitzung.rs` unter der 350-Zeilen-Grenze bleibt.

Die Testnamen bleiben **unverändert** (alle achtzehn: `unbekannter_slot_beendet_die_sitzung_nicht`, `verworfene_nachricht_gibt_trotzdem_frei`, `zweites_hello_gibt_alles_frei_und_beginnt_leer`, `hello_mit_fremder_fassung_wird_abgewiesen`, `handschlag_gilt_auch_wenn_die_eingabe_verworfen_wird`, `handschlag_ueberlebt_den_unbekannten_slot`, `nachricht_ohne_kennung_erbt_die_vorgaengersitzung_nicht`, `protokollfehler_der_huelle_gibt_frei_und_legt_still`, `nach_endgueltigem_schluss_wird_nichts_mehr_eingespielt`, `vergiftete_sperre_verhindert_die_freigabe_nicht`, `beenden_ist_idempotent`, `vorrang_verwirft_die_eingabe_und_gibt_frei`, `nach_dem_vorrang_laeuft_die_eingabe_weiter`, `hello_gilt_auch_unter_vorrang`, `vorrang_entwertet_die_zeigerlage`, `fremder_vorrang_verwirft_auch_ohne_eigene_regung`, `der_uebergang_laeuft_nur_einmal`, `vermerken_fuehrt_den_druckzustand`).

`vermerken_fuehrt_den_druckzustand` steht bereits in Task 3 in `druck.rs` — hier entfällt es, damit es nicht doppelt läuft.

Der Testkopf ersetzt `pruefstand()` durch eine frische Sitzung je Test:

```rust
//! Die Sitzungs-Tests. Bis zum 2026-08-22 liefen sie nur auf Windows; seit die
//! Zustandsmaschine hier liegt, laufen sie auf jeder Maschine.

use crate::pruefstand::{Ereignis, PruefInjektor, PruefUmgebung, PruefWache, ZielAntwort};
use crate::sitzung::Sitzung;

/// Ein vollstaendiger Pruefstand samt Sitzung.
///
/// **`Box::leak` mit Absicht.** Die Sitzung haelt ihre Plattform als
/// `&'static dyn` — im Sidecar ist das ein echtes `static`, im Test ein
/// bewusst preisgegebener Kasten. Er lebt bis zum Prozessende, und ein
/// Testlauf hat davon ein paar Dutzend: unmessbar, und dafuer braucht kein
/// Test eine Lebensdauer zu verwalten.
struct Stand {
    sitzung: Sitzung,
    inj: &'static PruefInjektor,
    wache: &'static PruefWache,
    umg: &'static PruefUmgebung,
}

fn stand() -> Stand {
    let inj: &'static PruefInjektor = Box::leak(Box::new(PruefInjektor::default()));
    let wache: &'static PruefWache = Box::leak(Box::new(PruefWache::neu()));
    let umg: &'static PruefUmgebung = Box::leak(Box::new(PruefUmgebung::default()));
    Stand { sitzung: Sitzung::neu(inj, wache, umg), inj, wache, umg }
}

/// Ein Hello-Frame, roh.
fn hello() -> Vec<u8> {
    crate::bauen::hello().as_slice().to_vec()
}

/// Eine gedrueckte Taste, roh.
fn taste_runter(scan: u16) -> Vec<u8> {
    crate::bauen::taste(scan, true).as_slice().to_vec()
}
```

Danach werden in den achtzehn Tests die Aufrufe umgestellt: `Sitzung::singleton()` → `s.sitzung`, `wache::pruefhilfe::regung()` → `s.wache.regen(true)`, `wache::pruefhilfe::ruhe()` → `s.wache.regen(false)`, `injektion::pruefspur::nimm()` → `s.inj.nimm()`, `ziel::strom_gestartet(...)`/`strom_beendet()` → `*s.umg.ziel.lock().unwrap() = ZielAntwort::…`. Die Zeile `let _sperre = crate::remote_input::pruefstand();` entfällt ersatzlos — es gibt keinen geteilten Zustand mehr.

- [ ] **Step 6: `lib.rs` auf den vollen Modulbaum bringen**

```rust
// (Kopfdoku aus Task 1, unveraendert)

pub mod base64;
pub mod bauen;
pub mod bewegung;
pub mod druck;
pub mod format;
pub mod plattform;
pub mod rahmen;
pub mod sitzung;
pub mod zuordnung;

mod ausfuehrung;

#[cfg(test)]
mod pruefstand;
```

In `sitzung.rs` ans Dateiende: `#[cfg(test)] mod sitzung_tests;`

- [ ] **Step 7: Tests laufen lassen**

Run: `cd streaming/pulse-fernsteuerung && cargo test`
Expected: PASS. Die Ausgabe muss die siebzehn Sitzungs-Tests namentlich zeigen — sie sind der Beleg, dass die Zustandsmaschine die Umschichtung unverändert überstanden hat.

- [ ] **Step 8: Nachweisen, dass die Zusagen unverändert sind**

Run:

```bash
diff <(git show HEAD:streaming/win-hq-sidecar/src/remote_input/mod.rs) \
     streaming/pulse-fernsteuerung/src/sitzung.rs
```

Expected: Änderungen nur an den in Step 2 bis 4 genannten Stellen. Die fünf Zusagen im Modulkopf, die Reihenfolge der Prüfungen in `frames` (geschlossen → Sitzungswechsel → stillgelegt → Vorrang → Ziel → Sichtschutz → Frames) und die Doc-Kommentare zu `handschlag`, `nur_handschlag` und `stilllegen` dürfen **nicht** abweichen.

- [ ] **Step 9: Committen**

```bash
git add streaming/pulse-fernsteuerung
git commit -m "feat(fernsteuerung): die Sitzungs-Zustandsmaschine in die gemeinsame Kiste

Siebzehn Tests, die bis heute nur auf Windows liefen, laufen jetzt auf jeder
Maschine — das ist der eigentliche Ertrag: die Auslagerung ist belegt, bevor
ein Windows-Rechner sie gesehen hat.

Die Sitzung traegt ihre Plattform als Feld statt als Prozess-Singleton. Damit
hat die Kiste keinen globalen Zustand, und die Reihenfolge-Sperre, die die
Tests im Sidecar brauchten, faellt ersatzlos weg."
```

---

### Task 6: Den Windows-Sidecar auf die Kiste umstellen

Die einzige Aufgabe, die auf diesem Mac **nicht** übersetzbar ist. Deshalb so mechanisch wie möglich und mit Diff-Nachweis.

**Files:**
- Modify: `streaming/win-hq-sidecar/Cargo.toml`
- Modify: `streaming/win-hq-sidecar/src/remote_input/mod.rs` (wird zum Plattform-Aufsatz)
- Modify: `streaming/win-hq-sidecar/src/remote_input/{injektion,wache,ziel,zuordnung}.rs`
- Delete: `streaming/win-hq-sidecar/src/remote_input/{rahmen,druck,base64,ausfuehrung,vorrang,tests}.rs`
- Modify: `streaming/win-hq-sidecar/src/ops/{remote_input,remote_input_end}.rs`

**Interfaces:**
- Consumes: alles aus den Tasks 1 bis 5.
- Produces: `crate::remote_input::sitzung() -> &'static Sitzung` — der eine Zugang, den `ops` und `main.rs` benutzen.

- [ ] **Step 1: Abhängigkeit eintragen**

In `streaming/win-hq-sidecar/Cargo.toml`, bei den anderen `pulse-*`-Einträgen:

```toml
# Plattformfreier Kern der Fernsteuerung, seit 2026-08-22 gemeinsam mit dem
# mac-Sidecar und dem Player in einer eigenen Kiste. Hier bleibt die
# Windows-Haelfte: SendInput, die Low-Level-Haken, die Rechteck-Aufloesung, die
# SendInput-Normierung und die Zeigerform.
pulse-fernsteuerung = { path = "../pulse-fernsteuerung" }
```

- [ ] **Step 2: Die gewanderten Dateien löschen**

```bash
git rm streaming/win-hq-sidecar/src/remote_input/rahmen.rs \
       streaming/win-hq-sidecar/src/remote_input/druck.rs \
       streaming/win-hq-sidecar/src/remote_input/base64.rs \
       streaming/win-hq-sidecar/src/remote_input/ausfuehrung.rs \
       streaming/win-hq-sidecar/src/remote_input/vorrang.rs \
       streaming/win-hq-sidecar/src/remote_input/tests.rs
```

- [ ] **Step 3: `remote_input/mod.rs` durch den Plattform-Aufsatz ersetzen**

```rust
//! Fernsteuerung, Windows-Haelfte.
//!
//! Der Kern liegt seit dem 2026-08-22 gemeinsam in `pulse-fernsteuerung`:
//! Frame-Format, Sitzungs-Zustandsmaschine, Klemmrechnung, Bewegungsschwelle,
//! Ausfuehrung. **Nicht wieder hierher zurueckkopieren** — „synchron halten"
//! ist die falsche Anweisung, die Dateien existieren nur noch einmal.
//!
//! Was hier bleibt, kennt Windows: [`injektion`] (`SendInput`, die eigene
//! Marke, das DPI-Bewusstsein), [`wache`] (die Low-Level-Haken samt Faden und
//! Wecker), [`ziel`] (Slot → Aufnahmequelle → Rechteck), [`zuordnung`] (die
//! Normierung auf den virtuellen Desktop) und [`zeigerform`] samt
//! [`zeigerpixel`]/[`zeigerpunkte`].

pub mod injektion;
pub mod wache;
mod zeigerform;
mod zeigerpixel;
mod zeigerpunkte;
pub mod ziel;
pub mod zuordnung;

use pulse_fernsteuerung::druck::Druck;
// `Zielsuche` heisst hier UND in `ziel` so — der Kern kennt das Ergebnis, das
// Windows-Modul den Weg dorthin. Umbenannt statt eines der beiden zu
// verschieben: `ziel::Zielsuche` traegt eine Windows-`Bindung`, die im Kern
// nichts zu suchen hat.
use pulse_fernsteuerung::plattform::{Injektor, Umgebung, Wache, Zielsuche as KernZiel};
use pulse_fernsteuerung::sitzung::Sitzung;
use pulse_fernsteuerung::zuordnung::Rechteck;

pub use pulse_fernsteuerung::sitzung::Bericht;

/// Laeuft gerade eine Fernsteuerung? Fuer den Pacing-Loop (`pipeline_hw`).
///
/// Atomar statt ueber die Sitzungssperre, weil der Pacing-Loop das bis zu
/// 60-mal je Sekunde liest und dafuer nicht die Eingabe-Sperre anfassen soll.
static FERN_AKTIV: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn fern_aktiv() -> bool {
    FERN_AKTIV.load(std::sync::atomic::Ordering::Relaxed)
}

struct WinInjektor;
struct WinWache;
struct WinUmgebung;

static INJEKTOR: WinInjektor = WinInjektor;
static WACHE: WinWache = WinWache;
static UMGEBUNG: WinUmgebung = WinUmgebung;

/// Die eine Sitzung dieses Prozesses.
pub fn sitzung() -> &'static Sitzung {
    static INSTANZ: std::sync::OnceLock<Sitzung> = std::sync::OnceLock::new();
    INSTANZ.get_or_init(|| Sitzung::neu(&INJEKTOR, &WACHE, &UMGEBUNG))
}

impl Injektor for WinInjektor {
    fn maus_setzen(&self, punkt: (i32, i32), _gedrueckt: &Druck) {
        // Windows braucht die Gedrueckt-Menge nicht: eine absolute Bewegung
        // waehrend eines Knopfdrucks zieht dort von selbst. Auf macOS ist das
        // ein eigener Ereignistyp — deshalb steht sie im Trait.
        let vd = zuordnung::virtueller_desktop();
        let (nx, ny) = zuordnung::punkt_auf_absolut(punkt.0, punkt.1, &vd);
        injektion::maus(
            nx,
            ny,
            0,
            windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_MOVE
                | windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_ABSOLUTE
                | windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_VIRTUALDESK,
        );
    }

    fn maus_knopf(&self, btn: u8, down: bool) {
        // `btn` ist gegen `format::knopf_bekannt` geprueft — `None` ist
        // unerreichbar, und still nichts zu tun ist hier richtiger als eine
        // Panik im Dispatch-Faden.
        if let Some((flag, daten)) = injektion::tasten_ereignis(btn, down) {
            injektion::maus(0, 0, daten, flag);
        }
    }

    fn maus_rad(&self, dv: i16, dh: i16) {
        use windows::Win32::UI::Input::KeyboardAndMouse::{MOUSEEVENTF_HWHEEL, MOUSEEVENTF_WHEEL};
        // Zwei Aufrufe, weil Windows je Achse ein eigenes Ereignis verlangt.
        // Der Kern schickt beides in einem Aufruf; die Aufteilung ist eine
        // Windows-Eigenheit und gehoert deshalb hierher.
        if dv != 0 {
            injektion::maus(0, 0, dv as i32, MOUSEEVENTF_WHEEL);
        }
        if dh != 0 {
            injektion::maus(0, 0, dh as i32, MOUSEEVENTF_HWHEEL);
        }
    }

    fn taste(&self, scan: u16, down: bool) {
        injektion::taste(scan, down);
    }
}

impl Wache for WinWache {
    fn starten(&self) -> Result<(), String> {
        wache::starten()
    }
    fn stoppen(&self) {
        wache::stoppen();
    }
    fn host_regt_sich(&self) -> bool {
        wache::host_regt_sich()
    }
    fn rest_ms(&self) -> u64 {
        wache::rest_ms()
    }
}

impl Umgebung for WinUmgebung {
    fn ziel(&self, slot: u64) -> KernZiel {
        match ziel::bindung_fuer_slot(slot) {
            ziel::Zielsuche::Gefunden(b) => KernZiel::Gefunden {
                rechteck: b.ziel.screen_rect().map(|r| Rechteck {
                    links: r.left,
                    oben: r.top,
                    rechts: r.right,
                    unten: r.bottom,
                }),
                sichtbar: !b.wacht.is_some_and(|w| !w.is_source_visible()),
            },
            ziel::Zielsuche::KeinStrom => KernZiel::KeinStrom,
            ziel::Zielsuche::NichtAufloesbar(g) => KernZiel::NichtAufloesbar(g),
        }
    }

    fn host_zeiger_zeigen(&self, zeigen: bool) {
        if zeigen {
            crate::capture::cursorsteuerung::zeigen();
        } else {
            crate::capture::cursorsteuerung::verbergen();
        }
    }

    fn sitzung_beendet(&self) {
        // Die gemeldete Zeigerform gehoert der Sitzung, die gerade endet — die
        // naechste beginnt mit leerem Merker. Genau wie vorher: nur hier, nicht
        // bei jedem Zeigerwechsel.
        zeigerform::zuruecksetzen();
    }

    fn fern_aktiv_setzen(&self, aktiv: bool) {
        FERN_AKTIV.store(aktiv, std::sync::atomic::Ordering::Relaxed);
    }

    fn vorrang_melden(&self, gilt: bool, hold_ms: u64) {
        crate::events::emit(serde_json::json!({
            "ev": "remote_state",
            "state": if gilt { "host_active" } else { "live" },
            "hold_ms": hold_ms,
        }));
    }

    fn fehler_melden(&self, grund: &str) {
        crate::events::emit(serde_json::json!({
            "ev": "remote_state",
            "state": "input_error",
            "reason": grund,
        }));
    }
}
```

**Warum `zeigerform::zuruecksetzen()` in `sitzung_beendet` steht und nicht in `host_zeiger_zeigen`:** Beide werden beim Sitzungsende gerufen, aber `host_zeiger_zeigen(true)` laeuft zusaetzlich bei jedem Wechsel von absoluter auf relative Mausfuehrung und bei jedem Vorrang-Uebergang. Dort den Merker zu raeumen hiesse, dass der Sidecar die Zeigerform fuer unbekannt haelt und sie erneut schickt — eine Verhaltensaenderung mit Kosten auf der Leitung, und die Global Constraint verbietet sie.

- [ ] **Step 4: `wache.rs` auf die gemeinsame Bewegungsschwelle umstellen**

Löschen: `BEWEGUNGS_SCHWELLE_PX`, `BEWEGUNGS_FENSTER_MS`, `struct Bewegung`, `impl Bewegung`, `fn bewegung_zaehlt` und dessen acht Tests (sie stehen jetzt in der Kiste).

Ergänzen: `use pulse_fernsteuerung::bewegung::{self, Bewegung};`

Der Hook-Rückruf ruft `bewegung::zaehlt(&mut b, jetzt_ms(), daten.pt.x, daten.pt.y, eigen)`.

Der Wecker ruft statt `super::vorrang::tick()` jetzt `super::sitzung().vorrang_tick()`.

Das Modul `pruefhilfe` entfällt — es diente den Tests, die jetzt in der Kiste laufen.

- [ ] **Step 5: `zuordnung.rs` auf den Rest eindampfen**

In `streaming/win-hq-sidecar/src/remote_input/zuordnung.rs` bleiben nur `VirtualDesktop`, `virtueller_desktop()`, `punkt_auf_absolut()` und deren vier Tests. `anteil_auf_punkt`, `klemmen`, `mitte`, der `RECT`-Import und die fünf zugehörigen Tests entfallen.

Kopf anpassen:

```rust
//! Die `SendInput`-Normierung — Bildschirmpunkt auf 0..65535 ueber den
//! **gesamten** virtuellen Desktop.
//!
//! Die Anteilsrechnung und die Klemmung stehen seit dem 2026-08-22 gemeinsam
//! in `pulse_fernsteuerung::zuordnung`. Was hier bleibt, gilt nur fuer
//! Windows: `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK` normiert auf den
//! gesamten virtuellen Desktop, nicht auf den Primaermonitor — das ist die
//! Erkenntnis aus dem M0-Pruefling.
```

- [ ] **Step 6: `injektion.rs` entrümpeln**

`scancode_gueltig` und `tasten_ereignis`s `None`-Zweig bleiben, aber die Gültigkeitsprüfung wandert: `scancode_gueltig` wird gelöscht (steht in `format`), ebenso ihr Test `nur_satz_1_scancodes_sind_gueltig`. Die `#[cfg(test)] mod pruefspur` und der `abfeuern`-Umweg entfallen ersatzlos — die Tests laufen jetzt gegen den Prüfstand der Kiste, und `abfeuern` wird wieder ein direkter `SendInput`-Aufruf:

```rust
/// Ein fertiges `INPUT` an Windows geben.
fn abfeuern(input: INPUT) {
    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
}
```

Die verbleibenden Tests `nur_e0_ist_erweitert`, `unbekannte_maustaste_hat_kein_ereignis` und `x_knoepfe_trennen_sich_ueber_mousedata` bleiben; `testlauf_schreibt_mit_statt_zu_injizieren` entfällt (es prüfte den Umweg, den es nicht mehr gibt).

- [ ] **Step 7: Die beiden Ops umstellen**

In `streaming/win-hq-sidecar/src/ops/remote_input.rs`:

- `use crate::remote_input::{Sitzung, base64};` wird `use crate::remote_input::sitzung; use pulse_fernsteuerung::base64;`
- `let sitzung = Sitzung::singleton();` wird `let sitzung = sitzung();`
- `sitzung.protokollfehler(grund)` liefert jetzt `String` → `return Err(anyhow::anyhow!(sitzung.protokollfehler(grund)));`
- `sitzung.frames(...)?` wird `sitzung.frames(...).map_err(|e| anyhow::anyhow!(e))?`
- In den Tests: `crate::remote_input::pruefstand()` entfällt, `Sitzung::singleton().beenden()` wird `sitzung().beenden()`. Die Tests bleiben sonst wortgleich — sie prüfen die Hülle, nicht den Kern.

In `streaming/win-hq-sidecar/src/ops/remote_input_end.rs`: `Sitzung::singleton().beenden()` wird `crate::remote_input::sitzung().beenden()`.

- [ ] **Step 8: `main.rs` und `lib.rs` nachziehen**

Run: `grep -rn "remote_input::Sitzung\|remote_input::pruefstand\|Sitzung::singleton" streaming/win-hq-sidecar/src/`
Expected: nur noch Treffer in `main.rs` (Prozessende) und `lib.rs`. Diese auf `crate::remote_input::sitzung()` umstellen; `beenden_endgueltig()` bleibt gleich.

- [ ] **Step 9: Formatierung prüfen**

Run: `cd streaming/win-hq-sidecar && cargo fmt --check`
Expected: keine Ausgabe. (`cargo build` geht auf diesem Mac nicht — s. Global Constraints.)

- [ ] **Step 10: Committen**

```bash
git add streaming/win-hq-sidecar
git commit -m "refactor(win-sidecar): Fernsteuerung auf die gemeinsame Kiste umgestellt

Der Kern liegt jetzt in pulse-fernsteuerung; hier bleibt die Windows-Haelfte —
SendInput, die Low-Level-Haken, die Rechteck-Aufloesung, die
SendInput-Normierung und die Zeigerform. Kein Verhalten geaendert.

Auf diesem Mac nicht uebersetzbar; der Nachweis ist der CI-Lauf."
```

---

### Task 7: Den Player auf die Kiste umstellen

Anders als Task 6 ist das hier **lokal prüfbar** — der Player baut auf diesem Mac.

**Files:**
- Modify: `streaming/pulse-player/Cargo.toml`
- Modify: `streaming/pulse-player/src/fernsteuerung/rahmen.rs`
- Modify: `streaming/pulse-player/src/fernsteuerung/tasten.rs`
- Modify: `streaming/pulse-fernsteuerung/src/format.rs`

**Interfaces:**
- Consumes: `bauen::*`, `format::*` aus Task 1.
- Produces: `format::SATZ1_TASTEN` gefüllt.

- [ ] **Step 1: Abhängigkeit eintragen**

In `streaming/pulse-player/Cargo.toml`, bei `pulse-zeigerbild`/`pulse-bildmarke`:

```toml
# Frame-Format der Fernsteuerung, seit 2026-08-22 gemeinsam mit den Sidecars.
# Der Sender baute die Frames bis dahin aus eigenen Konstanten, der Empfaenger
# parste sie mit eigenen, und kein Test hielt die beiden zusammen.
pulse-fernsteuerung = { path = "../pulse-fernsteuerung" }
```

- [ ] **Step 2: `fernsteuerung/rahmen.rs` zum Re-Export machen**

Die Datei wird — wie `zeitbasis.rs` in den Sidecars — auf einen Einzeiler eingedampft:

```rust
//! Das Frame-Format der Fernsteuerung liegt seit dem 2026-08-22 gemeinsam in
//! `pulse-fernsteuerung`. Dieses Modul bleibt als Re-Export bestehen, damit die
//! Aufrufstellen (`super::rahmen::…`) unveraendert bleiben.
//!
//! **Nicht wieder hierher zurueckkopieren.** Der Sender baute die Frames
//! vorher aus eigenen Konstanten, der Empfaenger parste sie mit eigenen — und
//! kein Zwillings-Test hielt die beiden zusammen.

pub use pulse_fernsteuerung::bauen::*;
pub use pulse_fernsteuerung::format::*;
```

- [ ] **Step 3: `SATZ1_TASTEN` aus der Spielertabelle füllen**

Run:

```bash
grep -o '=> 0x[0-9a-fA-F]\{2,4\}' streaming/pulse-player/src/fernsteuerung/tasten.rs \
  | sed 's/=> //' | sort -u | tr '\n' ' '
```

Die Ausgabe ist die Liste der Scancodes, die der Player erzeugen kann. Damit wird die Konstante in `streaming/pulse-fernsteuerung/src/format.rs` **neu angelegt** — sie entsteht erst hier, weil sie erst hier einen Inhalt hat:

```rust
/// Jeder Scancode, den ein Sender ueberhaupt erzeugen darf — das Vokabular der
/// Leitung.
///
/// **Wozu die Liste.** Sie ist der Pruefstein zwischen den Enden: der Player
/// prueft, dass er nur daraus sendet (`fernsteuerung/tasten.rs`), und jeder
/// Injektor prueft, dass er zu jedem Eintrag ein Ziel hat. Damit ist „kann
/// diese Plattform alles einspielen, was ein Steuernder schicken kann?" ein
/// Test und keine Durchsicht. Gebraucht wird sie erstmals vom mac-Injektor
/// (Plan 2); sie steht hier, weil sie zum Format gehoert und nicht zu einer
/// Plattform.
///
/// Aufsteigend sortiert, damit eine neue Taste an ihrem Platz landet und der
/// Unterschied im Diff eine Zeile ist.
pub const SATZ1_TASTEN: &[u16] = &[
    // die Ausgabe des grep-Befehls, aufsteigend sortiert
];
```

Dazu der Gueltigkeits-Test, der jetzt etwas zu pruefen hat — ans Ende des Test-Moduls in `format.rs`:

```rust
    /// Das Vokabular darf nichts fuehren, was kein Injektor annehmen darf —
    /// sonst behauptete es ein Ziel fuer einen Code, der fail-closed ist.
    #[test]
    fn das_vokabular_ist_durchweg_gueltig() {
        assert!(!SATZ1_TASTEN.is_empty());
        for &scan in SATZ1_TASTEN {
            assert!(scancode_gueltig(scan), "{scan:#06x} steht im Vokabular");
        }
    }

    /// Aufsteigend und ohne Doppelung — eine Doppelung waere ein Eintrag, den
    /// die Vollstaendigkeitspruefung drueben zweimal verlangt.
    #[test]
    fn das_vokabular_ist_sortiert_und_doppelungsfrei() {
        assert!(
            SATZ1_TASTEN.windows(2).all(|p| p[0] < p[1]),
            "SATZ1_TASTEN muss aufsteigend und doppelungsfrei sein"
        );
    }
```

- [ ] **Step 4: Die vorhandene Tastenliste heben**

`streaming/pulse-player/src/fernsteuerung/tasten.rs` führt im Test `keine_doppelten_scancodes` bereits die vollständige Liste aller abgebildeten Tasten als lokales `let codes = [...]`. Diese Liste wird — unverändert, dieselbe Reihenfolge, dieselben Einträge — aus der Testfunktion herausgehoben und zur Modul-Konstanten des Test-Moduls:

```rust
    /// Jede Taste, die [`super::scancode`] abbildet.
    ///
    /// Bis zum 2026-08-22 stand sie im Rumpf von
    /// [`keine_doppelten_scancodes`]. Herausgehoben, weil sie jetzt zwei Tests
    /// traegt: die Doppelungspruefung und den Abgleich mit dem gemeinsamen
    /// Vokabular. Waechst `scancode` um eine Taste, ohne dass sie hier
    /// dazukommt, faellt das in `keine_doppelten_scancodes` NICHT auf — dafuer
    /// sorgt der Vokabel-Abgleich unten, denn dann fehlt der Scancode auch im
    /// Vokabular.
    const ALLE_TASTEN: &[KeyCode] = &[
        // wortgleich der bisherige Inhalt von `let codes = [...]`
    ];
```

`keine_doppelten_scancodes` benutzt danach `ALLE_TASTEN` statt `codes`; sein Rumpf ändert sich sonst nicht (`for code in ALLE_TASTEN` liefert Referenzen, also `scancode(*code)`).

- [ ] **Step 5: Den Prüfstein-Test schreiben**

Im selben Test-Modul:

```rust
    /// **Der Pruefstein kommt vom Sender.** Alles, was diese Tabelle erzeugen
    /// kann, muss im gemeinsamen Vokabular stehen — daran prueft jeder
    /// Injektor, ob er vollstaendig ist.
    ///
    /// Die Lehre vom Zeigerbild (2026-08-17): wer eine Pruefung testet,
    /// schreibt die Faelle aus derselben Vorstellung auf, aus der er die
    /// Pruefung geschrieben hat. Ein Test beim Empfaenger allein faende die
    /// Luecke nie.
    #[test]
    fn jeder_gesendete_scancode_steht_im_vokabular() {
        for code in ALLE_TASTEN {
            let scan = scancode(*code).unwrap_or_else(|| panic!("{code:?} fehlt in der Tabelle"));
            assert!(
                pulse_fernsteuerung::format::SATZ1_TASTEN.contains(&scan),
                "{code:?} sendet {scan:#06x}, das nicht im Vokabular steht"
            );
        }
    }

    /// Und umgekehrt: das Vokabular darf nichts fuehren, was kein Sender
    /// erzeugt — sonst muesste jeder Injektor Ziele fuer Codes vorhalten, die
    /// nie kommen, und die Vollstaendigkeitspruefung drueben waere strenger
    /// als noetig.
    #[test]
    fn das_vokabular_fuehrt_nichts_ueberfluessiges() {
        let erzeugbar: std::collections::BTreeSet<u16> =
            ALLE_TASTEN.iter().filter_map(|c| scancode(*c)).collect();
        for scan in pulse_fernsteuerung::format::SATZ1_TASTEN {
            assert!(
                erzeugbar.contains(scan),
                "{scan:#06x} steht im Vokabular, wird aber von niemandem gesendet"
            );
        }
    }
```

Der zweite Test ist zugleich die Gegenprobe auf Step 3: hat der `grep`-Befehl einen Scancode aufgesammelt, den die Tabelle gar nicht erzeugt (etwa aus einem Kommentar), wird er hier rot.

- [ ] **Step 6: Bauen und testen**

Run:

```bash
cd streaming/pulse-player && PKG_CONFIG_PATH=$HOME/src/ffmpeg-openssl/lib/pkgconfig cargo test
```

Expected: PASS. Ohne `PKG_CONFIG_PATH` zieht der Bau die zu neue System-FFmpeg und `ffmpeg-next` bricht an nicht abgedeckten Enum-Werten ab — auf dem Mac gibt es das Verzeichnis `ffmpeg-dist/` aus der Linux-Anleitung **nicht**.

- [ ] **Step 7: Committen**

```bash
git add streaming/pulse-player streaming/pulse-fernsteuerung
git commit -m "refactor(player): Frame-Format aus der gemeinsamen Kiste

Der Sender baut die Frames nicht mehr aus eigenen Konstanten. Dazu das
Vokabular der Leitung: jeder Scancode, den der Player erzeugen kann, steht
jetzt an einer Stelle, gegen die jeder Injektor pruefen kann, ob er
vollstaendig ist."
```

---

### Task 8: Bau-Auslöser und Flatpak-Manifest

Die neue Kiste liegt außerhalb der Programmordner. Fehlt sie in einer der Listen, **bricht nichts** — der Bau läuft einfach nicht, und das Ausgelieferte trägt still den alten Stand. Genau dafür gibt es die beiden Prüftests.

**Files:**
- Modify: `.github/workflows/win-build.yml`
- Modify: `.github/workflows/mac-build.yml`
- Modify: `.github/workflows/flatpak.yml`
- Modify: `packaging/com.howispulse.Pulse.yml`

**Interfaces:**
- Consumes: die `Cargo.toml`-Einträge aus Task 6 und 7.
- Produces: nichts für spätere Tasks.

- [ ] **Step 1: Die Prüftests laufen lassen und die Befunde lesen**

Run: `cd streaming/zwillinge && cargo test`
Expected: **FAIL** in `bau_ausloeser` und `flatpak_kisten` — sie melden namentlich, welche Liste `pulse-fernsteuerung` vermisst. Die Meldung ist die Arbeitsanweisung für die nächsten Schritte; nichts aus dem Gedächtnis nachtragen.

- [ ] **Step 2: `win-build.yml` ergänzen**

Bei den anderen `streaming/pulse-*`-Einträgen unter `on.push.paths`:

```yaml
      - 'streaming/pulse-fernsteuerung/**'
```

- [ ] **Step 3: `mac-build.yml` ergänzen**

`mac-build.yml` führt die fünf bisherigen Kisten bereits (Zeilen 49 bis 53) und baut den Player mit (Zeile 58). Eine Zeile dazu, bei den anderen:

```yaml
      - 'streaming/pulse-fernsteuerung/**'
```

- [ ] **Step 4: `flatpak.yml` ergänzen**

`pulse-player` wird im Flatpak gebaut und linkt seit Task 7 gegen die neue Kiste:

```yaml
      - 'streaming/pulse-fernsteuerung/**'
```

- [ ] **Step 5: Das Flatpak-Manifest ergänzen**

In `packaging/com.howispulse.Pulse.yml`, beim Modul des Players, zu den anderen `type: dir`-Quellen:

```yaml
      - type: dir
        path: ../streaming/pulse-fernsteuerung
        dest: streaming/pulse-fernsteuerung
```

(Die genaue Einrückung und das `dest`-Muster von den vorhandenen `pulse-*`-Quellen übernehmen — der Flatpak baut in einem leeren Ordner und `cargo --offline`, eine fehlende Quelle zeigt ins Leere.)

- [ ] **Step 6: Die Prüftests erneut laufen lassen**

Run: `cd streaming/zwillinge && cargo test`
Expected: PASS — alle vier Testdateien.

- [ ] **Step 7: Committen**

```bash
git add .github/workflows packaging/com.howispulse.Pulse.yml
git commit -m "ci: pulse-fernsteuerung in die Bau-Ausloeser und ins Flatpak-Manifest

Eine fehlende Kiste bricht nichts — der Bau laeuft einfach nicht und liefert
still den alten Stand aus. Die beiden Pruefnetze in streaming/zwillinge haben
die Luecken genannt."
```

---

### Task 9: Der Windows-Bau in der CI

Der einzige Nachweis, dass Task 6 stimmt. **Braucht eine ausdrückliche Push-Freigabe des Nutzers.**

**Files:** keine.

**Interfaces:**
- Consumes: die Tasks 1 bis 8.
- Produces: nichts.

- [ ] **Step 1: Den Nutzer um die Push-Freigabe bitten**

Wörtlich fragen, nicht voraussetzen: der Zweig `feat/fernsteuerung-macos` soll nach `origin` gepusht werden, damit `win-build.yml` per „Run workflow" darauf laufen kann. Ohne Freigabe endet der Plan hier und Task 6 bleibt unbelegt.

- [ ] **Step 2: Zweig pushen**

```bash
git push -u origin feat/fernsteuerung-macos
```

- [ ] **Step 3: Den Windows-Bau anstoßen**

Über die GitHub-Oberfläche: Actions → win-build → „Run workflow" → Branch `feat/fernsteuerung-macos`.

Der Ablauf lädt nur bei `github.ref == 'refs/heads/main'` hoch; ein Lauf auf dem Zweig baut und archiviert nur. Nichts wird überschrieben.

- [ ] **Step 4: Auf das Ergebnis warten und es lesen**

Erwartet: grün. Bricht der Bau, ist die Meldung der Befund — insbesondere fehlende Einfuhren in `remote_input/mod.rs`, `wache.rs` oder den beiden Ops.

**Nicht selbst pollen.** Ein Subagent mit frischem Kontext wartet auf den Lauf und meldet das Ergebnis zurück.

- [ ] **Step 5: Den mac-Bau ebenso anstoßen**

Actions → mac-build → „Run workflow" → derselbe Branch. Er belegt, dass der Player mit der neuen Kiste auch im Auslieferbau übersetzt (Task 7 hat ihn nur lokal geprüft).

---

### Task 10: Die drei Messungen für Plan 2

Sie ändern den Entwurf des mac-Injektors und gehören deshalb vor dessen Umsetzung. Ergebnis ist ein Dokument, kein Code.

**Files:**
- Create: `docs/plans/2026-08-22-macos-eingabe-messungen.md`

**Interfaces:**
- Consumes: nichts.
- Produces: die Antworten, aus denen Plan 2 geschrieben wird.

- [ ] **Step 1: Den TCC-Prüfling schreiben und bauen**

Im Kritzelverzeichnis, nicht im Repo — er wird nicht ausgeliefert.

`tcc-probe.swift`:

```swift
// Wem ordnet macOS die Accessibility-Freigabe zu — der App oder dem
// Kindprozess? Schreibt in eine Datei statt nach stdout, weil er im zweiten
// Durchgang als Sidecar-Ersatz laeuft und dessen stdio nicht sprechen soll.
import ApplicationServices
import Foundation

let prompt = CommandLine.arguments.contains("--fragen")
let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
let vertraut = AXIsProcessTrustedWithOptions(opts)

let zeile = "vertraut=\(vertraut) pid=\(getpid()) ppid=\(getppid()) " +
            "pfad=\(CommandLine.arguments[0]) fragen=\(prompt)\n"
FileHandle.standardError.write(zeile.data(using: .utf8)!)
if let f = FileHandle(forWritingAtPath: "/tmp/tcc-probe.log") {
    f.seekToEndOfFile()
    f.write(zeile.data(using: .utf8)!)
} else {
    try? zeile.write(toFile: "/tmp/tcc-probe.log", atomically: true, encoding: .utf8)
}
// Offen bleiben, damit der Prozess in den Systemeinstellungen sichtbar wird.
if !prompt { exit(0) }
Thread.sleep(forTimeInterval: 120)
```

Run: `swiftc -O tcc-probe.swift -o tcc-probe`
Expected: baut ohne Fehler.

- [ ] **Step 2: Messung 1 — die TCC-Zuordnung, zwei Durchgänge**

Durchgang A, direkt aus dem Terminal:

```bash
rm -f /tmp/tcc-probe.log && ./tcc-probe --fragen
```

Beobachten: Welcher Name steht im Dialog „… möchte diesen Computer steuern"? Erscheint danach in Systemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen ein Eintrag für **Terminal** oder für **tcc-probe**?

Durchgang B, als Kindprozess der gepackten App:

```bash
PULSE_HQ_SIDECAR=$PWD/tcc-probe open -n /Applications/Pulse.app
```

Dann in der App etwas auslösen, das den Sidecar startet (Streaming-Einstellungen öffnen — das ruft `health`). Danach:

```bash
cat /tmp/tcc-probe.log
```

Zu beantworten und wörtlich festzuhalten: Steht in Durchgang B `vertraut=true`, wenn zuvor **Pulse** (nicht der Prüfling) freigegeben war? Erscheint im Systemdialog der Name „Pulse" oder ein Binärname? Erbt der Kindprozess also die Freigabe der App?

**Warum es darauf ankommt:** Ist die Antwort „eigener Eintrag", muss der Nutzer ein Binärprogramm mit kryptischem Namen freigeben, und `systemPreferences.isTrustedAccessibilityClient()` im Electron-Hauptprozess gibt die **falsche** Auskunft für den Sidecar — dann wandert die Abfrage in den Sidecar und der Entwurf §7.2 ändert sich.

- [ ] **Step 3: Den Eingabe-Prüfling schreiben und bauen**

`eingabe-probe.swift`:

```swift
// Drei Fragen an CGEventPost, die der Entwurf offen laesst.
// Voraussetzung: Terminal (oder was diesen Prozess startet) hat die
// Accessibility-Freigabe — sonst passiert wortlos nichts.
import CoreGraphics
import Foundation

/// Dieselbe Marke wie im Windows-Sidecar (`PULSE_MARKE`, "PULS" in ASCII) —
/// hier nur, um den Weg schon einmal zu gehen.
let MARKE: Int64 = 0x5055_4C53
let quelle = CGEventSource(stateID: .hidSystemState)

func stempeln(_ e: CGEvent) {
    e.setIntegerValueField(.eventSourceUserData, value: MARKE)
    e.post(tap: .cghidEventTap)
}

func maus(_ typ: CGEventType, _ p: CGPoint, klicks: Int64) {
    guard let e = CGEvent(mouseEventSource: quelle, mouseType: typ,
                          mouseCursorPosition: p, mouseButton: .left) else { return }
    e.setIntegerValueField(.mouseEventClickState, value: klicks)
    stempeln(e)
}

func taste(_ code: CGKeyCode, _ runter: Bool, flags: CGEventFlags = []) {
    guard let e = CGEvent(keyboardEventSource: quelle, virtualKey: code,
                          keyDown: runter) else { return }
    e.flags = flags
    stempeln(e)
}

/// Wohin geklickt wird — ueber das Wort im Zielfenster. Von Hand anpassen.
let ort = CGPoint(x: 600, y: 400)

switch CommandLine.arguments.dropFirst().first ?? "hilfe" {
case "klick-ungezaehlt":
    // Zwei Klicks im Doppelklick-Abstand, clickState bleibt bei 1.
    for _ in 0..<2 {
        maus(.leftMouseDown, ort, klicks: 1)
        maus(.leftMouseUp, ort, klicks: 1)
        usleep(80_000)
    }
case "klick-gezaehlt":
    // Der Vergleichsfall: zweiter Klick mit clickState 2.
    maus(.leftMouseDown, ort, klicks: 1); maus(.leftMouseUp, ort, klicks: 1)
    usleep(80_000)
    maus(.leftMouseDown, ort, klicks: 2); maus(.leftMouseUp, ort, klicks: 2)
case "kopieren-ohne-flags":
    // Cmd runter, C runter, C hoch, Cmd hoch — ohne die Flags selbst zu setzen.
    taste(0x37, true)   // kVK_Command
    usleep(20_000)
    taste(0x08, true)   // kVK_ANSI_C
    taste(0x08, false)
    taste(0x37, false)
case "kopieren-mit-flags":
    // Der Vergleichsfall: die Cmd-Kennzeichnung ausdruecklich gesetzt.
    taste(0x37, true)
    usleep(20_000)
    taste(0x08, true, flags: .maskCommand)
    taste(0x08, false, flags: .maskCommand)
    taste(0x37, false)
case "rollen":
    guard let e = CGEvent(scrollWheelEvent2Source: quelle, units: .line,
                          wheelCount: 1, wheel1: 1, wheel2: 0, wheel3: 0) else { break }
    stempeln(e)
default:
    print("klick-ungezaehlt | klick-gezaehlt | kopieren-ohne-flags | kopieren-mit-flags | rollen")
}
```

Run: `swiftc -O eingabe-probe.swift -o eingabe-probe`
Expected: baut ohne Fehler.

- [ ] **Step 4: Messung 2 — Doppelklick**

TextEdit öffnen, ein Wort tippen, `ort` im Prüfling auf dessen Bildschirmlage setzen (Bildschirmkoordinaten mit Ursprung **oben links**, nicht die von `NSScreen`), neu bauen.

```bash
./eingabe-probe klick-ungezaehlt   # wird das Wort markiert?
./eingabe-probe klick-gezaehlt     # und so?
```

Zu beantworten: Markiert schon der ungezählte Lauf das Wort — dann führt der WindowServer die Klickzahl selbst, und der Zähler aus Entwurf §4 entfällt. Markiert nur der gezählte, wird er gebraucht.

- [ ] **Step 5: Messung 2b — Umschalttasten**

In TextEdit Text markieren, dann:

```bash
pbcopy </dev/null && ./eingabe-probe kopieren-ohne-flags && sleep 1 && pbpaste
```

Ist die Zwischenablage danach gefüllt, trägt das C-Ereignis die Cmd-Kennzeichnung von selbst. Ist sie leer, den Vergleichsfall fahren:

```bash
pbcopy </dev/null && ./eingabe-probe kopieren-mit-flags && sleep 1 && pbpaste
```

Zu beantworten: Muss der Injektor `CGEventSetFlags` aus der eigenen Gedrückt-Menge füllen, oder nicht?

- [ ] **Step 6: Messung 3 — Rad-Vorzeichen und natürliches Scrollen**

Ein langes Dokument öffnen (TextEdit oder Safari), Zeiger darüber, dann:

```bash
./eingabe-probe rollen
```

Beobachten, in welche Richtung der Inhalt springt. Danach Systemeinstellungen → Trackpad bzw. Maus → „Natürliche Scrollrichtung" umschalten und **denselben** Befehl wiederholen.

Zu beantworten: Entspricht `wheel1 = +1` der Windows-Richtung `dv > 0` (vom Nutzer weg)? Kehrt die Systemeinstellung injizierte Ereignisse um — und muss der Injektor sie folglich auslesen und gegenrechnen?

- [ ] **Step 7: Die Befunde aufschreiben**

`docs/plans/2026-08-22-macos-eingabe-messungen.md` mit je einem Abschnitt pro Messung: was gemessen wurde, auf welcher macOS-Fassung, das Ergebnis, und was daraus für den Entwurf folgt. Wo eine Messung nicht eindeutig ausfällt, das ausdrücklich schreiben — eine unklare Messung ist ein Ergebnis, eine geratene Antwort nicht.

- [ ] **Step 8: Den Entwurf nachziehen**

Widerspricht ein Ergebnis dem Entwurf, `docs/superpowers/specs/2026-08-22-fernsteuerung-macos-design.md` an der betroffenen Stelle berichtigen — mit dem Datum und dem Verweis auf die Messung. Ein Entwurf, der eine widerlegte Annahme weiterträgt, ist schlimmer als keiner.

- [ ] **Step 9: Committen**

```bash
git add docs/plans/2026-08-22-macos-eingabe-messungen.md \
        docs/superpowers/specs/2026-08-22-fernsteuerung-macos-design.md
git commit -m "docs(fernsteuerung): Messungen zur macOS-Eingabe

Drei Fragen, die den Entwurf des Injektors aendern: wem TCC die
Accessibility-Freigabe zuordnet, ob der WindowServer Doppelklicks und
Umschalttasten selbst fuehrt, und wie sich injiziertes Scrollen zur
Systemeinstellung verhaelt."
```

---

## Danach

Plan 2 (Der Mac als Host) wird aus den Befunden von Task 10 geschrieben. Er umfasst: Injektor, Tastentabelle Satz 1 auf `kVK_*`, Wache über `CGEventTap`, Slot-Auflösung über `CGDisplayBounds`/`SCWindow.frame`, die beiden Ops, die Fähigkeitsabfrage in `health`, den Berechtigungs-Ablauf und die beiden Renderer-Gates. Plan 3 (Der Zeiger) folgt darauf.
