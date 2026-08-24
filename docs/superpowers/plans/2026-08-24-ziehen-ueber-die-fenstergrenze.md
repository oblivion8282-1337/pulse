# Ziehen über die Fenstergrenze — Umsetzungsplan (Teil 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mit gedrückter Maustaste aus einem Player-Fenster in ein anderes ziehen, sodass der gesteuerte Rechner eine durchgehende Zieh-Geste über seine Bildschirmgrenze sieht.

**Architecture:** Das Fenster, in dem gedrückt wurde, behält die Geste (das Betriebssystem hält den Zeigerfang dort) und **zielt um**: liegt der Zeiger über einem anderen Player-Fenster, rechnet es den Punkt in dessen Bild um und stempelt dessen Platznummer auf die Frames. Kein Übergeben zwischen Fenstern, kein zweiter Handschlag — ein Hello gäbe alles Gedrückte frei und zerrisse die Geste. Auf dem gesteuerten Rechner ändert sich nichts: er hat nur eine Maus, und die Platznummer sitzt schon heute in jeder Nachricht.

**Tech Stack:** Rust (`streaming/pulse-player`, winit 0.30.13, Tests im Modul) · TypeScript (`desktop/electron`, Nodes eingebauter Testläufer)

**Spec:** `docs/superpowers/specs/2026-08-24-mehrere-host-bildschirme-design.md` (Teil 1)

**Zuschnitt:** Dieser Plan deckt **nur Teil 1**. Die Teile 3, 2 und 4 des Entwurfs bekommen eigene Pläne — jeder Teil ist für sich auslieferbar, und ein Plan für Teil 2 müsste heute Feldnamen erfinden, die erst Teil 3 anlegt.

## Global Constraints

- **Player bauen und testen braucht FFmpeg-Pfade.** Linux: `FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared`. macOS: `PKG_CONFIG_PATH=$HOME/src/ffmpeg-openssl/lib/pkgconfig`. Ohne das zieht der Bau die zu neue System-FFmpeg und `ffmpeg-next` bricht ab.
- **`scripts/ship.sh` führt die Rust-Tests NICHT aus** (nur pytest, `pnpm check`, `pnpm build`, `web`- und `desktop`-`test:unit`). Die `cargo test`-Läufe dieses Plans müssen von Hand laufen.
- **Version-Bump ist Pflicht:** `desktop/package.json` steht auf `0.1.74` → auf `0.1.75`. Änderungen an `streaming/pulse-player/**` werden über den Windows-Installer ausgeliefert, und electron-updater ignoriert gleiche Versionen stillschweigend.
- **Changelog-Eintrag nötig** (`web/static/changelog.json`, neuester Eintrag oben, `id` = Datum). **Keine Emojis, echte Umlaute (ä/ö/ü/ß)** — in Changelog UND Commit-Nachrichten.
- **Grössen-Policy** (`PLAN.md` §12.1): Quelldateien ≤ 350 Zeilen (hart 500). `fernsteuerung/mod.rs` steht bei 403 — es darf **nicht weiter wachsen**; neue Logik gehört in eigene Module.
- **Refactoring darf Verhalten nicht ändern.** Bricht ein bestehender Test, ist der Code kaputt, nicht der Test.
- **Kein `git push`** ohne ausdrückliche Freigabe.
- Arbeitszweig: `feat/ziehen-ueber-die-fenstergrenze`, von frisch gepulltem `main`.

---

## File Structure

| Datei | Verantwortung |
|---|---|
| `streaming/pulse-player/src/fernsteuerung/nachbarn.rs` | **Neu.** Reine Rechnung: welcher Nachbar meint ein Punkt auf dem Desktop, und wo in dessen Bild. Ohne winit, ohne Zustand, voll testbar. |
| `streaming/pulse-player/src/fernsteuerung/mod.rs` | `Erfassung` bekommt ein **Ziel** getrennt vom eigenen Platz, und eine Abgabe, die ihren Platz mitträgt. |
| `streaming/pulse-player/src/fernsteuerung/strom.rs` | `einschalten` setzt das Ziel mit; `ausschalten` lässt es stehen (wie den Platz). |
| `streaming/pulse-player/src/fernsteuerung/tests.rs` | Hilfsfunktionen an die neue Abgabe angepasst, neue Tests für den Zielwechsel. |
| `streaming/pulse-player/src/app/eingabe.rs` | Abgabe-Schleife statt Einzelabholung; die Platznummer kommt aus der Abgabe. |
| `streaming/pulse-player/src/app/mod.rs` | Sammelt die Nachbarschaft ein, bevor die Sitzung veränderlich ausgeliehen wird; merkt sich das zuletzt fokussierte Fenster. |
| `desktop/electron/remoteInput.ts` | `verteilen` lässt fremde Plätze **derselben** Sitzung durch. |
| `desktop/test/remoteInput.test.ts` | Tests dafür, inklusive der Gegenprobe (fremde Sitzung bleibt verworfen). |

---

## Task 1: `nachbarn.rs` — die reine Rechnung

**Files:**
- Create: `streaming/pulse-player/src/fernsteuerung/nachbarn.rs`
- Modify: `streaming/pulse-player/src/fernsteuerung/mod.rs:17-26` (Modul anmelden und ausgeben)

**Interfaces:**
- Consumes: `super::Bildlage` (vorhanden, `bildlage.rs`; `Copy`, `anteil(x, y) -> Option<(f64, f64)>` liefert `None` ausserhalb des Bildes)
- Produces:
  - `pub struct Nachbar { pub id: u64, pub slot: u32, pub ursprung: (f64, f64), pub lage: Bildlage }` (`Debug + Clone + Copy + PartialEq`)
  - `pub fn vorrang(kandidaten: &mut [Nachbar], eigenes: u64, zuletzt_fokussiert: Option<u64>)`
  - `pub fn treffer(punkt: (f64, f64), kandidaten: &[Nachbar]) -> Option<(u32, (f64, f64))>`

- [ ] **Step 1: Modul anlegen mit den Typen und der Rechnung**

Datei `streaming/pulse-player/src/fernsteuerung/nachbarn.rs`:

```rust
//! Welches Player-Fenster meint ein Punkt auf dem Desktop — und wo in dessen
//! Bild?
//!
//! Wer mit gedrueckter Maustaste aus einem Fenster herauszieht, bekommt vom
//! Betriebssystem weiter alle Ereignisse in DIESEM Fenster zugestellt (winit
//! ruft `SetCapture`; X11, Wayland und macOS haben denselben impliziten
//! Zeigerfang). Die Koordinaten liegen dann ausserhalb — und genau dort faengt
//! diese Datei an: sie rechnet den Punkt in den Desktop-Raum, sucht das
//! Fenster, ueber dem er wirklich steht, und liefert dessen Platz samt Anteil
//! im Bild.
//!
//! **Rein und ohne winit**, damit die Zuordnung ohne Fenster pruefbar ist —
//! dasselbe Muster wie [`super::bildlage`] daneben.

use super::Bildlage;

/// Ein Player-Fenster, wie die Zuordnung es sieht.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Nachbar {
    /// Sitzungsnummer des Fensters (`app::Session`-Schluessel). Nur fuer den
    /// Vorrang — auf die Leitung geht sie nie.
    pub id: u64,
    /// Der Stream des Hosts, den dieses Fenster zeigt. DAS geht auf die
    /// Leitung, in der Huelle der Nachricht.
    pub slot: u32,
    /// Linke obere Ecke der Fensterinnenflaeche auf dem Desktop, physische
    /// Punkte. Bezugsgroesse fuer `Bildlage`, die fensterlokal rechnet.
    pub ursprung: (f64, f64),
    /// Wo im Fenster das Bild liegt und welcher Teil der Quelle darin steht.
    pub lage: Bildlage,
}

/// Reihenfolge, in der die Fenster befragt werden.
///
/// **Das eigene zuerst, danach das zuletzt fokussierte, danach der Rest.**
/// winit gibt die Stapelreihenfolge nicht heraus; der Fokus ist ihr
/// Stellvertreter, denn ein Fenster wird durch Anklicken zugleich fokussiert
/// und nach vorne geholt. Im Zieh-Fall stimmt das sogar per Bauart: das
/// ziehende Fenster IST das fokussierte, liegt also oben — und im
/// ueberlappenden Bereich sieht man genau dieses.
///
/// `sort_by_key` ist stabil: gleichrangige Fenster behalten ihre Reihenfolge,
/// damit dieselbe Lage nicht von Lauf zu Lauf ein anderes Ergebnis liefert.
pub fn vorrang(kandidaten: &mut [Nachbar], eigenes: u64, zuletzt_fokussiert: Option<u64>) {
    kandidaten.sort_by_key(|n| {
        if n.id == eigenes {
            0
        } else if Some(n.id) == zuletzt_fokussiert {
            1
        } else {
            2
        }
    });
}

/// Wen meint dieser Punkt? `None` heisst „kein Fenster" — dann wird nichts
/// gesendet, und der Zeiger des Hosts wartet an seiner letzten Stelle.
///
/// Der schwarze Rand eines Fensters zaehlt **nicht** als Treffer; das erledigt
/// [`Bildlage::anteil`], das ausserhalb des Bildinhalts `None` liefert. Ein
/// geklemmter Wert kaeme beim Host als Klick auf der Bildkante an, den niemand
/// ausgeloest hat.
pub fn treffer(punkt: (f64, f64), kandidaten: &[Nachbar]) -> Option<(u32, (f64, f64))> {
    for n in kandidaten {
        let lokal_x = punkt.0 - n.ursprung.0;
        let lokal_y = punkt.1 - n.ursprung.1;
        if let Some(anteil) = n.lage.anteil(lokal_x, lokal_y) {
            return Some((n.slot, anteil));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fenster und Quelle im selben Verhaeltnis: kein Rand, die Ecken sind
    /// dadurch exakt 0 und 1.
    fn fenster(id: u64, slot: u32, x: f64, y: f64) -> Nachbar {
        Nachbar {
            id,
            slot,
            ursprung: (x, y),
            lage: Bildlage::neu((1000, 1000), (1000, 1000), [0.0, 0.0, 1.0, 1.0]).expect("Lage"),
        }
    }

    #[test]
    fn punkt_im_eigenen_fenster() {
        let k = [fenster(1, 0, 0.0, 0.0), fenster(2, 1, 1000.0, 0.0)];
        let (slot, (u, v)) = treffer((500.0, 500.0), &k).expect("Treffer");
        assert_eq!(slot, 0);
        assert!((u - 0.5).abs() < 1e-9 && (v - 0.5).abs() < 1e-9, "{u},{v}");
    }

    #[test]
    fn punkt_im_nachbarn_traegt_dessen_platz() {
        let k = [fenster(1, 0, 0.0, 0.0), fenster(2, 1, 1000.0, 0.0)];
        let (slot, (u, v)) = treffer((1500.0, 500.0), &k).expect("Treffer");
        assert_eq!(slot, 1, "der Punkt liegt im zweiten Fenster");
        assert!((u - 0.5).abs() < 1e-9 && (v - 0.5).abs() < 1e-9, "{u},{v}");
    }

    /// Die Luecke zwischen den Fenstern gehoert niemandem. Wichtig, weil dort
    /// nichts gesendet werden darf — nicht etwa auf die Kante geklemmt.
    #[test]
    fn luecke_trifft_niemanden() {
        let k = [fenster(1, 0, 0.0, 0.0), fenster(2, 1, 1400.0, 0.0)];
        assert_eq!(treffer((1200.0, 500.0), &k), None);
        assert_eq!(treffer((-50.0, 500.0), &k), None);
        assert_eq!(treffer((500.0, 2000.0), &k), None);
    }

    /// Bei Ueberlappung gewinnt das eigene Fenster — es liegt oben, also sieht
    /// man dort genau dieses.
    #[test]
    fn bei_ueberlappung_gewinnt_das_eigene() {
        let mut k = [fenster(1, 0, 0.0, 0.0), fenster(2, 1, 500.0, 0.0)];
        vorrang(&mut k, 1, None);
        assert_eq!(treffer((700.0, 500.0), &k).expect("Treffer").0, 0);

        // Dasselbe Bild, anderes eigenes Fenster: dann gewinnt das andere.
        vorrang(&mut k, 2, None);
        assert_eq!(treffer((700.0, 500.0), &k).expect("Treffer").0, 1);
    }

    /// Gehoert keines der ueberlappenden Fenster einem selbst, entscheidet der
    /// Fokus.
    #[test]
    fn sonst_gewinnt_das_zuletzt_fokussierte() {
        let mut k = [fenster(1, 0, 0.0, 0.0), fenster(2, 1, 500.0, 0.0)];
        vorrang(&mut k, 99, Some(2));
        assert_eq!(treffer((700.0, 500.0), &k).expect("Treffer").0, 1);

        vorrang(&mut k, 99, Some(1));
        assert_eq!(treffer((700.0, 500.0), &k).expect("Treffer").0, 0);
    }

    /// Gleichrangige behalten ihre Reihenfolge — sonst waere dieselbe Lage von
    /// Lauf zu Lauf verschieden zugeordnet.
    #[test]
    fn vorrang_ist_stabil() {
        let mut k = [fenster(3, 2, 0.0, 0.0), fenster(4, 3, 0.0, 0.0), fenster(5, 4, 0.0, 0.0)];
        vorrang(&mut k, 99, None);
        assert_eq!(k.iter().map(|n| n.id).collect::<Vec<_>>(), vec![3, 4, 5]);
    }

    /// Der Briefkasten-Rand ist kein Treffer: 2000x1000-Fenster auf 16:9-Quelle
    /// laesst links und rechts je 111,1 Punkte schwarz.
    #[test]
    fn rand_ist_kein_treffer() {
        let n = Nachbar {
            id: 1,
            slot: 0,
            ursprung: (0.0, 0.0),
            lage: Bildlage::neu((2000, 1000), (1920, 1080), [0.0, 0.0, 1.0, 1.0]).expect("Lage"),
        };
        assert_eq!(treffer((50.0, 500.0), &[n]), None, "linker Rand");
        assert_eq!(treffer((1950.0, 500.0), &[n]), None, "rechter Rand");
        assert!(treffer((1000.0, 500.0), &[n]).is_some(), "Bildmitte");
    }
}
```

- [ ] **Step 2: Modul anmelden**

In `streaming/pulse-player/src/fernsteuerung/mod.rs` die Modulliste (Zeilen 17-22) und die Ausgaben (24-26) ergänzen:

```rust
mod bildlage;
mod nachbarn;
pub(crate) mod rahmen;
mod schlange;
mod strom;
mod tasten;
mod winit_abbild;

pub use bildlage::Bildlage;
pub use nachbarn::{vorrang, Nachbar};
pub use rahmen::Knopf;
pub use schlange::Abgabe;
```

- [ ] **Step 3: Tests laufen lassen — sie müssen bestehen**

```bash
cd streaming/pulse-player
FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo test --lib fernsteuerung::nachbarn
```

Erwartet: 6 Tests, alle grün. (Auf macOS statt `FFMPEG_DIR`: `PKG_CONFIG_PATH=$HOME/src/ffmpeg-openssl/lib/pkgconfig`.)

Schlägt der Bau mit `'libavutil/avutil.h' file not found` fehl, fehlt die Umgebungsvariable — nicht FFmpeg.

- [ ] **Step 4: Commit**

```bash
git add streaming/pulse-player/src/fernsteuerung/nachbarn.rs \
        streaming/pulse-player/src/fernsteuerung/mod.rs
git commit -m "feat(player): Zuordnung Desktop-Punkt zu Player-Fenster

Reine Rechnung, ohne winit und ohne Zustand: welcher Nachbar meint
einen Punkt, und wo in dessen Bild. Noch ruft sie niemand.

Das eigene Fenster hat Vorrang, danach das zuletzt fokussierte — winit
gibt die Stapelreihenfolge nicht heraus, und der Fokus ist ihr bester
Stellvertreter.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Die Abgabe trägt ihren Platz

Vorbereitung ohne Verhaltensänderung: Bis hierher ist `ziel_slot` immer gleich `slot`, es geht also genau dasselbe hinaus wie vorher. Ohne diesen Schritt könnte Task 3 die Frames nicht sauber trennen — ein Bündel trägt genau **einen** Platz.

**Files:**
- Modify: `streaming/pulse-player/src/fernsteuerung/mod.rs` (Felder, `abholen`, `raeumen`, neuer Typ)
- Modify: `streaming/pulse-player/src/fernsteuerung/strom.rs:70-77` (`einschalten`)
- Modify: `streaming/pulse-player/src/app/eingabe.rs:295-317` und `:324-349`
- Test: `streaming/pulse-player/src/fernsteuerung/tests.rs:41-51` (Hilfsfunktionen)

**Interfaces:**
- Consumes: `schlange::Abgabe` (`Nichts` / `Spaeter(Instant)` / `Jetzt(Vec<String>)`), `Schlange::raeumen() -> Option<Vec<String>>`
- Produces:
  - `pub enum Eingabeabgabe { Nichts, Spaeter(Instant), Jetzt { slot: u32, frames: Vec<String> } }`
  - `Erfassung::abholen(&mut self, jetzt: Instant) -> Eingabeabgabe` (geänderter Rückgabetyp)
  - `Erfassung::raeumen(&mut self) -> Vec<(u32, Vec<String>)>` (geänderter Rückgabetyp)
  - `Erfassung::ziel_slot(&self) -> u32`

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

In `streaming/pulse-player/src/fernsteuerung/tests.rs` ans Ende anfügen:

```rust
/// Solange niemand umzielt, traegt die Abgabe den eingeschalteten Platz.
#[test]
fn abgabe_traegt_den_eigenen_platz() {
    let mut e = Erfassung::neu();
    e.einschalten(3, false, Some(SITZUNG));
    let batches = e.raeumen();
    assert_eq!(batches.len(), 1, "das Hello sollte in einem Buendel stehen");
    assert_eq!(batches[0].0, 3, "Platz der Abgabe");
    assert_eq!(e.ziel_slot(), 3);
}
```

- [ ] **Step 2: Laufen lassen und scheitern sehen**

```bash
cd streaming/pulse-player
FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo test --lib fernsteuerung::tests::abgabe_traegt_den_eigenen_platz
```

Erwartet: Übersetzungsfehler — `ziel_slot` gibt es nicht, und `raeumen()` liefert `Option<Vec<String>>` statt einer Liste von Bündeln.

- [ ] **Step 3: `Eingabeabgabe` und die Felder einführen**

In `streaming/pulse-player/src/fernsteuerung/mod.rs`:

Nach der `Erfassung`-Struktur (hinter Zeile 87) den neuen Typ einfügen:

```rust
/// Was beim Abholen herauskommt — **mit dem Platz, zu dem die Frames gehoeren**.
///
/// Der Platz muss am BUENDEL haengen, nicht an der Erfassung: sobald ueber die
/// Fenstergrenze gezielt wird, koennen Frames zweier Plaetze kurz nacheinander
/// entstehen, und die Huelle traegt genau einen. Wer den Platz erst beim
/// Absetzen liest, schickte die letzte Bewegung des alten Bildschirms an den
/// neuen.
#[derive(Debug)]
pub enum Eingabeabgabe {
    Nichts,
    Spaeter(Instant),
    Jetzt { slot: u32, frames: Vec<String> },
}
```

In der `Erfassung`-Struktur zwei Felder ergänzen (direkt hinter `slot`, Zeile 43):

```rust
    /// Wohin die naechsten Frames gehen. Weicht vom eigenen `slot` ab, sobald
    /// der Zeiger ueber einem anderen Player-Fenster steht (s. `nachbarn`).
    ziel_slot: u32,
    /// Fertige Buendel, die noch ihren ALTEN Platz tragen — entstehen beim
    /// Zielwechsel und gehen vor allem anderen hinaus.
    ausstehend: Vec<(u32, Vec<String>)>,
```

In `Erfassung::neu()` (hinter `slot: 0,`, Zeile 99):

```rust
            ziel_slot: 0,
            ausstehend: Vec::new(),
```

Getter neben `slot()` (hinter Zeile 123):

```rust
    /// Wohin die naechsten Frames gehen. Gleich [`Self::slot`], solange nicht
    /// ueber die Fenstergrenze gezielt wird.
    pub fn ziel_slot(&self) -> u32 {
        self.ziel_slot
    }
```

`abholen` und `raeumen` ersetzen (Zeilen 389-399):

```rust
    /// Abholen, wenn es Zeit ist (s. [`Schlange::abholen`]).
    ///
    /// **Ausstehende Buendel gehen vor**: sie tragen einen alten Platz und
    /// duerfen sich nicht mit dem laufenden mischen. Der Aufrufer ruft in einer
    /// Schleife, bis nichts mehr kommt (s. `app::eingabe::eingaben_abgeben`).
    pub fn abholen(&mut self, jetzt: Instant) -> Eingabeabgabe {
        if !self.ausstehend.is_empty() {
            let (slot, frames) = self.ausstehend.remove(0);
            return Eingabeabgabe::Jetzt { slot, frames };
        }
        match self.warteschlange.abholen(jetzt) {
            Abgabe::Nichts => Eingabeabgabe::Nichts,
            Abgabe::Spaeter(t) => Eingabeabgabe::Spaeter(t),
            Abgabe::Jetzt(frames) => Eingabeabgabe::Jetzt { slot: self.ziel_slot, frames },
        }
    }

    /// Alles herausnehmen, ohne auf den Takt zu warten. Fuer den Abbau einer
    /// Sitzung: die Hoch-Ereignisse aus [`Self::ausschalten`] duerfen nicht mit
    /// dem Fenster verschwinden — und sie gehoeren dem Platz, der zuletzt
    /// gesteuert wurde, nicht dem, mit dem eingeschaltet wurde.
    pub fn raeumen(&mut self) -> Vec<(u32, Vec<String>)> {
        let mut alles = std::mem::take(&mut self.ausstehend);
        if let Some(frames) = self.warteschlange.raeumen() {
            alles.push((self.ziel_slot, frames));
        }
        alles
    }
```

- [ ] **Step 4: `einschalten` setzt das Ziel mit**

In `streaming/pulse-player/src/fernsteuerung/strom.rs`, in `einschalten` direkt hinter `self.slot = slot;` (Zeile 74):

```rust
        self.slot = slot;
        // Ein neuer Strom beginnt immer beim eigenen Bildschirm. Ein Ziel aus
        // dem vorigen Lauf zeigte auf ein Fenster, das es vielleicht nicht mehr
        // gibt.
        self.ziel_slot = slot;
```

**`ausschalten` fasst `ziel_slot` NICHT an** — aus demselben Grund, aus dem es dort schon keinen Platz entgegennimmt (Begründung `strom.rs:84-91`): die nachgereichten Hoch-Ereignisse gehören dem Stream, der gerade gesteuert wurde.

- [ ] **Step 5: Die Abgabe-Schleife in `app/eingabe.rs`**

`eingaben_abgeben` (Zeilen 303-315) ersetzen:

```rust
        for (id, session) in self.sessions.iter_mut() {
            // Schleife statt Einzelabholung: beim Zielwechsel koennen mehrere
            // Buendel mit verschiedenen Plaetzen bereitstehen, und jedes braucht
            // seine eigene Nachricht.
            loop {
                match session.eingabe.abholen(jetzt) {
                    Eingabeabgabe::Nichts => break,
                    Eingabeabgabe::Spaeter(t) => {
                        frueheste =
                            Some(frueheste.map_or(t, |f: std::time::Instant| f.min(t)));
                        break;
                    }
                    Eingabeabgabe::Jetzt { slot, frames } => {
                        // Zaehler fuers Statistik-Feld: was WIRKLICH hinausgeht.
                        session.eingabe_frames += frames.len() as u64;
                        stdout.send(&eingabe_ereignis(*id, slot, frames));
                    }
                }
            }
        }
```

Und in `eingabe_raeumen` (Zeilen 335-337):

```rust
        for (slot, frames) in session.eingabe.raeumen() {
            stdout.send(&eingabe_ereignis(id, slot, frames));
        }
```

Den Import oben in der Datei von `Abgabe` auf `Eingabeabgabe` umstellen (die Zeile findet `grep -n "use crate::fernsteuerung" streaming/pulse-player/src/app/eingabe.rs`).

- [ ] **Step 6: Die Test-Hilfsfunktionen anpassen**

In `streaming/pulse-player/src/fernsteuerung/tests.rs` die beiden Helfer (Zeilen 41-51) ersetzen:

```rust
fn rahmen_von(abgabe: Eingabeabgabe) -> Vec<Vec<u8>> {
    match abgabe {
        Eingabeabgabe::Jetzt { frames, .. } => frames.iter().map(|f| entziffern(f)).collect(),
        andere => panic!("Frames erwartet, bekam {andere:?}"),
    }
}

/// Alles herausholen, ohne auf den Bewegungstakt zu warten. Die Buendel werden
/// dabei zusammengelegt — wer die Plaetze auseinanderhalten will, nimmt
/// [`alles_mit_platz`].
fn alles(e: &mut Erfassung) -> Vec<Vec<u8>> {
    e.raeumen().into_iter().flat_map(|(_, f)| f).map(|s| entziffern(&s)).collect()
}

/// Wie [`alles`], aber je Buendel mit dem Platz, unter dem es hinausginge.
fn alles_mit_platz(e: &mut Erfassung) -> Vec<(u32, Vec<Vec<u8>>)> {
    e.raeumen()
        .into_iter()
        .map(|(slot, f)| (slot, f.iter().map(|s| entziffern(s)).collect()))
        .collect()
}
```

- [ ] **Step 7: Alle Erfassungs-Tests laufen lassen**

```bash
cd streaming/pulse-player
FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo test --lib fernsteuerung
```

Erwartet: alle bestehenden Tests weiter grün plus `abgabe_traegt_den_eigenen_platz`. **Bricht ein alter Test, ist die Umstellung falsch, nicht der Test** — bis hierher darf sich kein Verhalten geändert haben.

- [ ] **Step 8: Commit**

```bash
git add streaming/pulse-player/src/fernsteuerung/ streaming/pulse-player/src/app/eingabe.rs
git commit -m "refactor(player): die Eingabe-Abgabe traegt ihren Platz

Vorbereitung fuers Zielen ueber die Fenstergrenze, ohne Verhaltens-
aenderung: ziel_slot ist bis hierher immer gleich slot.

Der Platz muss am Buendel haengen, nicht an der Erfassung — sonst ginge
die letzte Bewegung des alten Bildschirms an den neuen. raeumen() gibt
deshalb Buendel je Platz zurueck, und die Abgabe-Schleife setzt jedes
als eigene Nachricht ab.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Umzielen über die Fenstergrenze

**Files:**
- Modify: `streaming/pulse-player/src/fernsteuerung/mod.rs` (Felder, `nachbarschaft_setzen`, `ziel_bestimmen`, `ziel_wechseln`, `zeigerposition`, `zeiger_im_bild`, `CursorLeft`)
- Test: `streaming/pulse-player/src/fernsteuerung/tests.rs`

**Interfaces:**
- Consumes: `nachbarn::{Nachbar, treffer}` aus Task 1; `Eingabeabgabe`, `ziel_slot()`, `raeumen()` aus Task 2
- Produces: `Erfassung::nachbarschaft_setzen(&mut self, ursprung: Option<(f64, f64)>, kandidaten: Vec<Nachbar>)`

- [ ] **Step 1: Die fehlschlagenden Tests schreiben**

In `streaming/pulse-player/src/fernsteuerung/tests.rs` ans Ende anfügen:

```rust
/// Zwei Fenster nebeneinander, jedes 1920 breit. Fenster A ist das eigene.
fn zwei_fenster() -> Vec<Nachbar> {
    vec![
        Nachbar { id: 1, slot: 0, ursprung: (0.0, 0.0), lage: lage() },
        Nachbar { id: 2, slot: 1, ursprung: (1920.0, 0.0), lage: lage() },
    ]
}

/// **Der Kern des Ganzen:** eine Bewegung, deren Punkt im NACHBARN liegt, geht
/// mit dessen Platz hinaus — obwohl sie in diesem Fenster erfasst wurde.
#[test]
fn bewegung_ueber_dem_nachbarn_traegt_dessen_platz() {
    let mut e = eingeschaltet();
    e.nachbarschaft_setzen(Some((0.0, 0.0)), zwei_fenster());
    // 2880 auf dem Desktop = Mitte des zweiten Fensters (1920 + 960).
    e.on_window_event(&zeiger_ereignis(2880.0, 540.0), Some(lage()), false);

    // `eingeschaltet()` hat die Warteschlange schon geleert — beim Zielwechsel
    // steht also nichts Altes mehr an, und es bleibt bei EINEM Buendel.
    let buendel = alles_mit_platz(&mut e);
    assert_eq!(buendel.len(), 1, "{buendel:?}");
    assert_eq!(buendel[0].0, 1, "die Bewegung gehoert Platz 1");
    assert_eq!(buendel[0].1[0][0], 0x01, "Opcode MouseMoveAbs");
    assert_eq!(e.ziel_slot(), 1);
}

/// Beim Zielwechsel muss das Liegengebliebene VORHER hinaus, mit dem alten
/// Platz. Ein Buendel traegt genau einen — sonst landete eine Bewegung des
/// einen Bildschirms auf dem anderen.
#[test]
fn zielwechsel_trennt_die_buendel() {
    let mut e = eingeschaltet();
    e.nachbarschaft_setzen(Some((0.0, 0.0)), zwei_fenster());
    // Erst im eigenen Fenster bewegen, dann in den Nachbarn.
    e.on_window_event(&zeiger_ereignis(100.0, 100.0), Some(lage()), false);
    e.on_window_event(&zeiger_ereignis(2880.0, 540.0), Some(lage()), false);

    let buendel = alles_mit_platz(&mut e);
    assert_eq!(buendel.len(), 2, "{buendel:?}");
    assert_eq!(buendel[0].0, 0, "das Liegengebliebene gehoert Platz 0");
    assert_eq!(buendel[1].0, 1, "das Neue gehoert Platz 1");
}

/// Der Zug endet im Nachbarn: das Loslassen geht an DESSEN Platz. Genau daran
/// haengt, ob das gezogene Fenster drueben abgelegt wird.
#[test]
fn loslassen_im_nachbarn_geht_an_dessen_platz() {
    let mut e = eingeschaltet();
    e.nachbarschaft_setzen(Some((0.0, 0.0)), zwei_fenster());
    e.on_window_event(&maus_ereignis(ElementState::Pressed, MouseButton::Left), Some(lage()), false);
    e.on_window_event(&zeiger_ereignis(2880.0, 540.0), Some(lage()), false);
    e.on_window_event(
        &maus_ereignis(ElementState::Released, MouseButton::Left),
        Some(lage()),
        false,
    );

    let buendel = alles_mit_platz(&mut e);
    let letztes = buendel.last().expect("Buendel");
    assert_eq!(letztes.0, 1, "Loslassen gehoert dem Nachbarn: {buendel:?}");
    let hoch = letztes.1.last().expect("Frame");
    assert_eq!(hoch[0], 0x03, "Opcode MouseButton");
    assert_eq!(hoch[2], 0, "runter=false");
}

/// Ein Punkt, der in keinem Fenster liegt (Luecke, eigener Desktop), sendet
/// nichts — und aendert das Ziel nicht.
#[test]
fn punkt_in_der_luecke_sendet_nichts() {
    let mut e = eingeschaltet();
    e.nachbarschaft_setzen(Some((0.0, 0.0)), zwei_fenster());
    e.on_window_event(&zeiger_ereignis(-500.0, 540.0), Some(lage()), false);
    assert!(alles(&mut e).is_empty(), "ausserhalb aller Fenster geht nichts hinaus");
    assert_eq!(e.ziel_slot(), 0, "das Ziel bleibt, wo es war");
}

/// Ohne bekannte Nachbarschaft (Wayland gibt keine Fensterlagen heraus) bleibt
/// alles beim Verhalten von vorher: eigenes Bild, eigener Platz.
#[test]
fn ohne_nachbarschaft_bleibt_es_beim_eigenen_bild() {
    let mut e = eingeschaltet();
    e.nachbarschaft_setzen(None, Vec::new());
    e.on_window_event(&zeiger_ereignis(960.0, 540.0), Some(lage()), false);
    let buendel = alles_mit_platz(&mut e);
    assert_eq!(buendel.len(), 1);
    assert_eq!(buendel[0].0, 0);
    assert_eq!(e.ziel_slot(), 0);
}
```

- [ ] **Step 2: Laufen lassen und scheitern sehen**

```bash
cd streaming/pulse-player
FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo test --lib fernsteuerung::tests
```

Erwartet: Übersetzungsfehler — `nachbarschaft_setzen` gibt es nicht.

- [ ] **Step 3: Die Felder und das Setzen**

In `streaming/pulse-player/src/fernsteuerung/mod.rs`, in der `Erfassung`-Struktur hinter `ausstehend` (aus Task 2):

```rust
    /// Linke obere Ecke der eigenen Fensterinnenflaeche auf dem Desktop.
    ///
    /// `None` heisst „Lage unbekannt" — unter Wayland gibt winit sie
    /// grundsaetzlich nicht heraus (`inner_position()` liefert dort
    /// `NotSupportedError`), und die Tests brauchen sie nicht. Dann bleibt es
    /// beim eigenen Bild und beim eigenen Platz.
    eigener_ursprung: Option<(f64, f64)>,
    /// Alle erfassenden Player-Fenster derselben Fernsteuerungs-Sitzung, in der
    /// Reihenfolge, in der sie befragt werden (s. `nachbarn::vorrang`).
    kandidaten: Vec<Nachbar>,
```

In `Erfassung::neu()`:

```rust
            eigener_ursprung: None,
            kandidaten: Vec::new(),
```

Und die Setz-Methode neben `zeigerfang()` (hinter Zeile 127):

```rust
    /// Wo dieses Fenster liegt und welche Fenster sonst noch erfassen.
    ///
    /// Vom Aufrufer VOR dem Ereignis gesetzt (`app::window_event`), weil nur
    /// dort alle Sitzungen zugleich sichtbar sind. Wird es nie gerufen, bleibt
    /// das Verhalten von vor dem 2026-08-24.
    pub fn nachbarschaft_setzen(
        &mut self,
        ursprung: Option<(f64, f64)>,
        kandidaten: Vec<Nachbar>,
    ) {
        self.eigener_ursprung = ursprung;
        self.kandidaten = kandidaten;
    }
```

- [ ] **Step 4: Die Zielbestimmung und der Wechsel**

Neben `zeiger_im_bild` einfügen (hinter Zeile 242):

```rust
    /// Welcher Platz ist gemeint, und wo in dessen Bild?
    ///
    /// Ohne bekannte eigene Fensterlage bleibt es beim eigenen Bild — dieselbe
    /// Antwort wie vor der Nachbarschaft, damit Wayland und die Tests
    /// unveraendert laufen.
    fn ziel_bestimmen(
        &self,
        lage: Option<Bildlage>,
        x: f64,
        y: f64,
    ) -> Option<(u32, (f64, f64))> {
        let Some((ux, uy)) = self.eigener_ursprung else {
            return lage?.anteil(x, y).map(|a| (self.slot, a));
        };
        nachbarn::treffer((ux + x, uy + y), &self.kandidaten)
    }

    /// Das Ziel wechseln — und dabei das Liegengebliebene sauber abtrennen.
    ///
    /// **Die Warteschlange gehoert noch dem alten Platz.** Sie muss als eigenes
    /// Buendel heraus, bevor der neue gilt: die Huelle traegt genau einen Platz,
    /// und die Reihenfolge ist bedeutungstragend (ein Klick, der seine
    /// Positionierung ueberholt, landet am falschen Ort).
    fn ziel_wechseln(&mut self, neu: u32) {
        if neu == self.ziel_slot {
            return;
        }
        if let Some(frames) = self.warteschlange.raeumen() {
            self.ausstehend.push((self.ziel_slot, frames));
        }
        self.ziel_slot = neu;
    }
```

- [ ] **Step 5: `zeigerposition` und `zeiger_im_bild` umstellen**

`zeigerposition` (Zeilen 309-316) ersetzen:

```rust
    /// Absolute Zeigerposition (physische Fensterpunkte). Ausserhalb jedes
    /// Bildrechtecks wird nichts gesendet — so verlangt es die Wire-Spec.
    pub fn zeigerposition(&mut self, lage: Bildlage, x: f64, y: f64) {
        if !self.aktiv {
            return;
        }
        let Some((slot, (u, v))) = self.ziel_bestimmen(Some(lage), x, y) else { return };
        self.ziel_wechseln(slot);
        let (x, y) = (rahmen::anteil_zu_u16(u), rahmen::anteil_zu_u16(v));
        self.bewegung_einreihen(rahmen::maus_abs(x, y));
    }
```

`zeiger_im_bild` (Zeilen 233-242) — die letzte Zeile ersetzen, damit Knopf und Rad auch über einem Nachbarn zählen:

```rust
        let Some((x, y)) = self.letzte_zeigerlage else { return false };
        self.ziel_bestimmen(lage, x, y).is_some()
```

`CursorLeft` (Zeile 175) ersetzen:

```rust
            // Zeiger aus dem Fenster: ohne Nachbarschaft sagt seine letzte Lage
            // nichts mehr. MIT Nachbarschaft sehr wohl — er kann ueber einem
            // anderen Player-Fenster stehen, und waehrend eines Zuges bekommt
            // dieses Fenster die Bewegungen weiter zugestellt (Zeigerfang des
            // Systems). Hier zu vergessen hiesse, den Zug an der Fenstergrenze
            // abzuschneiden.
            WindowEvent::CursorLeft { .. } => {
                if self.eigener_ursprung.is_none() {
                    self.letzte_zeigerlage = None;
                }
            }
```

- [ ] **Step 6: Tests laufen lassen**

```bash
cd streaming/pulse-player
FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo test --lib fernsteuerung
```

Erwartet: alle grün, inklusive der sechs neuen. Die alten Tests rufen `nachbarschaft_setzen` nie und laufen deshalb auf dem unveränderten Weg.

- [ ] **Step 7: Grössen-Policy prüfen**

```bash
wc -l streaming/pulse-player/src/fernsteuerung/mod.rs
```

Bleibt die Datei über 500 Zeilen, muss vor dem Commit etwas heraus (Vorschlag: `ziel_bestimmen`/`ziel_wechseln` samt Feldern in ein eigenes `ziel.rs`). Unter 500 ist es tragbar, unter 350 wäre es sauber.

- [ ] **Step 8: Commit**

```bash
git add streaming/pulse-player/src/fernsteuerung/
git commit -m "feat(player): ueber die Fenstergrenze zielen

Liegt der Zeiger ueber einem anderen Player-Fenster, rechnet dieses
Fenster den Punkt in dessen Bild um und stempelt dessen Platz auf die
Frames. Kein Uebergeben, kein zweites Hello — ein Hello gaebe alles
Gedrueckte frei und zerrisse die Zieh-Geste.

CursorLeft loescht die Zeigerlage nur noch ohne bekannte Nachbarschaft:
waehrend eines Zuges stellt das System die Bewegungen weiter diesem
Fenster zu, und der Zeiger steht dann sehr wohl irgendwo.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Die Nachbarschaft einsammeln

Die Verdrahtung. **Nicht durch Unit-Tests abgedeckt** — hier kommt winit ins Spiel, und ein Fenster lässt sich im Test nicht bauen. Geprüft wird durch Übersetzen und den Handlauf in Task 6.

**Files:**
- Modify: `streaming/pulse-player/src/app/mod.rs:1476-1511` (Nachbarschaft), `:166-215` (Feld auf `App`), `app/eingabe.rs:272-287` (Fokusmerker)

**Interfaces:**
- Consumes: `Erfassung::nachbarschaft_setzen` (Task 3), `nachbarn::{Nachbar, vorrang}` (Task 1)
- Produces: nichts für spätere Tasks

- [ ] **Step 1: Merker für das zuletzt fokussierte Fenster**

In `streaming/pulse-player/src/app/mod.rs` an der `App`-Struktur (dort, wo `sessions` und `by_window` stehen) ergänzen:

```rust
    /// Welches Fenster zuletzt den Tastaturfokus bekam.
    ///
    /// Stellvertreter fuer „liegt oben": winit gibt die Stapelreihenfolge nicht
    /// heraus, aber ein Fenster wird durch Anklicken zugleich fokussiert und
    /// nach vorne geholt. Entscheidet bei ueberlappenden Player-Fenstern, wer
    /// einen Punkt bekommt (s. `fernsteuerung::nachbarn::vorrang`).
    zuletzt_fokussiert: Option<u64>,
```

Im Konstruktor der `App` mit `None` initialisieren — die Stelle findet:

```bash
grep -n "by_window: " streaming/pulse-player/src/app/mod.rs
```

Der Konstruktor ist die Fundstelle, an der `by_window` **zugewiesen** wird (nicht die im Struct-Feld); dort `zuletzt_fokussiert: None,` danebensetzen.

In `streaming/pulse-player/src/app/eingabe.rs`, in `fokus_gewechselt` (Zeile 272) als erste Anweisung:

```rust
        if fokus {
            self.zuletzt_fokussiert = Some(id);
        }
```

- [ ] **Step 2: Die Nachbarschaft vor der veränderlichen Ausleihe einsammeln**

In `streaming/pulse-player/src/app/mod.rs::window_event`, zwischen Zeile 1476 (`let Some(&id) = ...`) und 1477 (`if let Some(session) = self.sessions.get_mut(&id)`) einfügen:

```rust
        // **VOR der veraenderlichen Ausleihe.** Die Nachbarschaft braucht alle
        // Sitzungen zugleich, `get_mut` gleich darunter genau eine — beides
        // zusammen lehnt der Borrow-Checker ab. Kopiert werden nur Zahlen.
        //
        // Nur erfassende Fenster kommen hinein: ein Fenster ohne Erfassung hat
        // beim Host keinen Handschlag, und Frames dorthin wuerden dort
        // verworfen. Das waere schlimmer als nichts zu tun — jede verworfene
        // Nachricht gibt beim Host ALLES Gedrueckte frei und risse die
        // Zieh-Geste ab.
        // **Nur wenn dieses Fenster ueberhaupt erfasst.** `window_event` laeuft
        // bei jeder Mausbewegung — bis zu 144-mal je Sekunde. Eine Liste zu
        // bauen und zu sortieren, waehrend die Fernsteuerung aus ist (die
        // Vorgabe), waere genau die Art Kosten, die der Kommentar weiter unten
        // ausdruecklich vermeidet („kostet das nur dieses `if`").
        let erfasst = self.sessions.get(&id).is_some_and(|s| s.eingabe.aktiv());
        let mut kandidaten: Vec<crate::fernsteuerung::Nachbar> = if !erfasst {
            Vec::new()
        } else {
            self
            .sessions
            .iter()
            .filter(|(_, s)| s.eingabe.aktiv())
            .filter_map(|(sid, s)| {
                // Wayland gibt Fensterlagen grundsaetzlich nicht heraus. Dann
                // gibt es keine Nachbarschaft, und alles bleibt beim eigenen
                // Bild — bewusst still, es ist kein Fehler, sondern eine
                // Eigenschaft der Oberflaeche.
                let pos = s.window.inner_position().ok()?;
                let fenster = s.window.inner_size();
                let lage = crate::fernsteuerung::Bildlage::neu(
                    (fenster.width, fenster.height),
                    (s.stats.width, s.stats.height),
                    render::zoom_ausschnitt(&s.options),
                )?;
                Some(crate::fernsteuerung::Nachbar {
                    id: *sid,
                    slot: s.eingabe.slot(),
                    ursprung: (f64::from(pos.x), f64::from(pos.y)),
                    lage,
                })
            })
            .collect()
        };
        crate::fernsteuerung::vorrang(&mut kandidaten, id, self.zuletzt_fokussiert);
        // Die eigene Lage getrennt: sie macht aus fensterlokalen Zeigerpunkten
        // Desktop-Punkte. Fehlt sie, bleibt die Nachbarschaft ungenutzt.
        let eigener_ursprung = kandidaten
            .iter()
            .find(|n| n.id == id)
            .map(|n| n.ursprung);
```

- [ ] **Step 3: An die Erfassung übergeben**

Im Block `if session.eingabe.aktiv() {` (Zeilen 1503-1511) direkt vor `session.eingabe.on_window_event(...)`:

```rust
                session.eingabe.nachbarschaft_setzen(eigener_ursprung, kandidaten);
                session.eingabe.on_window_event(&event, lage, antwort.verbraucht);
```

(`vorrang` und `Nachbar` sind seit Task 1 ausgegeben — hier ist nichts mehr an der Modulliste zu ändern.)

- [ ] **Step 4: Übersetzen**

```bash
cd streaming/pulse-player
FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo build
FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo test --lib fernsteuerung
```

Erwartet: Bau ohne Fehler und ohne Warnungen, alle Tests grün.

Meldet der Compiler „cannot borrow `self.sessions` as mutable", steht das Einsammeln noch nach `get_mut` — es muss davor.

- [ ] **Step 5: Commit**

```bash
git add streaming/pulse-player/src/app/
git commit -m "feat(player): die Nachbarschaft der Player-Fenster einsammeln

Vor der veraenderlichen Ausleihe der Sitzung, sonst lehnt der
Borrow-Checker ab. Nur erfassende Fenster kommen hinein: ein Fenster
ohne Handschlag wuerde beim Host verworfen, und jede verworfene
Nachricht gibt dort alles Gedrueckte frei.

Unter Wayland gibt winit keine Fensterlagen heraus (inner_position ist
dort NotSupportedError). Dann bleibt die Nachbarschaft leer und alles
beim Verhalten von vorher.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Electron lässt fremde Plätze derselben Sitzung durch

**Files:**
- Modify: `desktop/electron/remoteInput.ts:164-187` (`verteilen`)
- Test: `desktop/test/remoteInput.test.ts`

**Interfaces:**
- Consumes: `EingabeWeiche`, `buendeln`, `RemoteInputNachricht` (vorhanden)
- Produces: keine neuen Signaturen — `verteilen` behält `(ev: Record<string, unknown>) => RemoteInputNachricht[]`

- [ ] **Step 1: Die fehlschlagenden Tests schreiben**

In `desktop/test/remoteInput.test.ts` ans Ende anfügen:

```ts
test('ein fremder Platz DERSELBEN Sitzung geht durch — der Zug ueber die Fenstergrenze', () => {
  const w = new EingabeWeiche();
  w.anmelden(1, 'sit-a', 0);
  w.anmelden(2, 'sit-a', 1);
  // Fenster 1 zielt auf Platz 2 um, weil der Zeiger ueber Fenster 2 steht.
  const n = w.verteilen({ session: 1, slot: 1, frames: ['f0'] });
  assert.equal(n.length, 1);
  assert.equal(n[0].slot, 1, 'der Platz aus dem Ereignis gewinnt');
  assert.equal(n[0].session_id, 'sit-a');
});

test('ein Platz einer ANDEREN Sitzung bleibt verworfen', () => {
  const w = new EingabeWeiche();
  w.anmelden(1, 'sit-a', 0);
  w.anmelden(2, 'sit-b', 1);
  assert.deepEqual(w.verteilen({ session: 1, slot: 1, frames: ['f0'] }), []);
});

test('ein Platz, den kein Fenster angemeldet hat, bleibt verworfen', () => {
  const w = new EingabeWeiche();
  w.anmelden(1, 'sit-a', 0);
  assert.deepEqual(w.verteilen({ session: 1, slot: 7, frames: ['f0'] }), []);
});

test('ohne Platz im Ereignis gilt weiterhin der angemeldete', () => {
  const w = new EingabeWeiche();
  w.anmelden(1, 'sit-a', 3);
  const n = w.verteilen({ session: 1, frames: ['f0'] });
  assert.equal(n.length, 1);
  assert.equal(n[0].slot, 3);
});
```

- [ ] **Step 2: Laufen lassen und scheitern sehen**

```bash
cd desktop && pnpm test:unit
```

Erwartet: der erste neue Test scheitert (`n.length` ist 0 statt 1), die drei anderen bestehen schon.

- [ ] **Step 3: Die Prüfung lockern**

In `desktop/electron/remoteInput.ts` den Schluss von `verteilen` (Zeilen 185-186) ersetzen:

```ts
    // **Ein fremder Platz ist erlaubt, wenn ein anderes Fenster DERSELBEN
    // Sitzung ihn angemeldet hat** (seit 2026-08-24, Zug ueber die
    // Fenstergrenze): das Fenster, in dem gedrueckt wurde, behaelt die Geste
    // und zielt auf den Bildschirm um, ueber dem der Zeiger steht.
    //
    // Der Schutz von 2026-08-12 bleibt vollstaendig: dort war das Problem eine
    // 0 als VORGABEWERT, die an einen fremden, nie begruessten Strom ging. Ein
    // angemeldeter Platz derselben Sitzung ist per Definition begruesst — genau
    // die Eigenschaft, die damals fehlte. Alles andere wird weiter still
    // verworfen, wie bei einer unbekannten Sitzung.
    if (typeof ev.slot === 'number' && ev.slot !== zuordnung.slot) {
      const bekannt = [...this.zuordnungen.values()].some(
        (z) => z.sessionId === zuordnung.sessionId && z.slot === ev.slot,
      );
      if (!bekannt) return [];
      return buendeln(zuordnung.sessionId, ev.slot, frames);
    }
    return buendeln(zuordnung.sessionId, zuordnung.slot, frames);
```

Den überholten Absatz des Doc-Kommentars über `verteilen` (Zeilen 171-184) durch einen kurzen Verweis ersetzen, damit nicht zwei Begründungen nebeneinander stehen:

```ts
    // **Sitzung und Platz stammen aus DEMSELBEN `input_capture`.** Die Sitzung
    // gewinnt immer die angemeldete — Frames mit der Kennung der einen
    // Steuerung an den Bildschirm einer anderen zu schicken, waere ein Fehler.
    // Fuer den PLATZ gilt die Lockerung unten.
```

- [ ] **Step 4: Tests laufen lassen**

```bash
cd desktop && pnpm test:unit
```

Erwartet: alle grün, inklusive der vier neuen und aller bestehenden.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/remoteInput.ts desktop/test/remoteInput.test.ts
git commit -m "feat(desktop): fremde Plaetze derselben Sitzung durchlassen

Damit der Zug ueber die Fenstergrenze ankommt. Der Schutz von
2026-08-12 bleibt: dort war das Problem eine 0 als Vorgabewert an einen
nie begruessten Strom — ein angemeldeter Platz derselben Sitzung ist
per Definition begruesst. Fremde Sitzungen und unbekannte Plaetze
bleiben still verworfen.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Version, Changelog, Handlauf

**Files:**
- Modify: `desktop/package.json:3`
- Modify: `web/static/changelog.json`
- Modify: `docs/superpowers/specs/2026-08-24-mehrere-host-bildschirme-design.md` (Wayland-Grenze nachtragen)

- [ ] **Step 1: Version bumpen**

`desktop/package.json` Zeile 3: `"version": "0.1.74"` → `"version": "0.1.75"`.

Ohne diesen Schritt erreicht die Änderung **keinen einzigen Windows-Bestandsclient** — electron-updater vergleicht die Version und ignoriert gleiche stillschweigend.

- [ ] **Step 2: Changelog-Eintrag**

Als **obersten** Eintrag in `entries` von `web/static/changelog.json`. Keine Emojis, echte Umlaute.

**Die Kennung ist `2026-08-24.4`, nicht `2026-08-24`** — an diesem Tag stehen schon drei Einträge aus anderer Arbeit, der oberste ist `2026-08-24.3`. Vor dem Schreiben nachsehen und gegebenenfalls weiterzählen:

```bash
python3 -c "import json;print(json.load(open('web/static/changelog.json'))['entries'][0]['id'])"
```

```json
{
  "id": "2026-08-24.4",
  "date": "2026-08-24",
  "style": "Sachlich",
  "title": "Fernsteuerung: zwischen zwei Bildschirmen ziehen",
  "intro": "Wer einen Rechner mit mehreren Bildschirmen fernsteuert, kann jetzt mit gedrueckter Maustaste von einem Player-Fenster ins andere ziehen.",
  "items": [
    "Ein Fenster laesst sich vom einen Bildschirm des fernen Rechners auf den anderen ziehen.",
    "Dateien lassen sich zwischen Anwendungen auf verschiedenen Bildschirmen ablegen.",
    "Der Zeiger folgt dabei Ihrer eigenen Maus: sobald sie ueber dem anderen Fenster steht, springt er auf die passende Stelle des zugehoerigen Bildschirms."
  ],
  "outro": "Gilt fuer Windows und macOS als ferngesteuerten Rechner."
}
```

- [ ] **Step 3: Die Wayland-Grenze im Entwurf nachtragen**

Im Abschnitt „Teil 1 — Grenzen" von `docs/superpowers/specs/2026-08-24-mehrere-host-bildschirme-design.md` ergänzen:

```markdown
- **Als steuernde Seite braucht es Fensterlagen, und Wayland gibt sie nicht
  heraus.** `Window::inner_position()` liefert dort `NotSupportedError`
  (winit 0.30.13, `platform_impl/linux/wayland/window/mod.rs:268`). Auf einem
  Wayland-Sitz bleibt es deshalb beim Verhalten von vorher — kein Zug über die
  Fenstergrenze, aber auch kein Fehler. Windows, macOS und X11 können es.
  (**Für Teil 4 ist derselbe Umstand schärfer:** `set_outer_position` ist unter
  Wayland ein stiller Leerlauf. Der Knopf dort muss ausgeblendet werden oder
  sagen, dass es nicht geht — sonst drückt man ihn und nichts passiert.)
```

- [ ] **Step 4: Das volle Test-Gate**

```bash
cd /home/michael/Dokumente/pulse
FFMPEG_DIR=$PWD/streaming/pulse-player/ffmpeg-dist/n8.1-lgpl-shared \
  cargo test --manifest-path streaming/pulse-player/Cargo.toml --lib fernsteuerung
( cd desktop && pnpm test:unit )
( cd web && pnpm check && pnpm build && pnpm test:unit )
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud uv run --all-packages pytest -q
```

Alles muss grün sein. Den pytest-Lauf **nicht** neben einen schweren Build legen — unter Last hängt ein WS-Test bis ins Zeitlimit.

- [ ] **Step 5: Handlauf mit zwei echten Bildschirmen**

Nicht automatisierbar (LiveKit und zwei Monitore fehlen im Testaufbau). Der Reihe nach prüfen:

1. Zwei Bildschirme eines Windows- oder macOS-Hosts holen, beide Player-Fenster **nebeneinander** legen.
2. Ein Fenster am Titel greifen und nach Player B ziehen → es landet auf Bildschirm 2.
3. Eine Datei aus einer Anwendung auf Bildschirm 1 in eine auf Bildschirm 2 ziehen.
4. Maustaste **in der Lücke** zwischen den Fenstern loslassen → keine klemmende Taste am fernen Rechner (dort nachsehen).
5. Ein Fenster über das andere legen, im überlappenden Bereich ziehen → das obere gewinnt.
6. Gegenprobe: mit **einem** offenen Fenster arbeiten wie bisher — nichts darf sich geändert haben.

- [ ] **Step 6: Commit und Abschluss**

```bash
git add desktop/package.json web/static/changelog.json docs/
git commit -m "chore: Version 0.1.75 und Changelog fuers Ziehen ueber die Fenstergrenze

Der Bump ist Pflicht: die Aenderung liegt in streaming/pulse-player und
wird ueber den Windows-Installer ausgeliefert; electron-updater
ignoriert gleiche Versionen stillschweigend.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

Danach `code-simplifier` über die geänderten Dateien laufen lassen, Tests erneut grün ziehen, `bash .claude/hooks/simplify-stamp.sh`, committen — und erst **nach Freigabe** `bash scripts/ship.sh`.

---

## Bekannte Kanten — beim Handlauf mitprüfen

- **Abbau mit fremdem Ziel.** Wird ein Fenster geschlossen, während sein Ziel
  noch auf einen Nachbarn zeigt, gehen die nachgereichten Hoch-Ereignisse an
  dessen Platz. Ist der Nachbar zu diesem Zeitpunkt schon abgemeldet, verwirft
  `verteilen` sie — und beim Host bliebe eine Taste gedrückt. In der Praxis
  greift der Nachlauf von einer Sekunde (`ABMELDE_NACHLAUF_MS`,
  `remoteInput.ts:55`), der die Zuordnung so lange stehen lässt. Beim Handlauf
  ausdrücklich prüfen: mit gedrückter Maustaste in den Nachbarn ziehen und
  **dort** das Fenster schliessen.
- **Druck ohne vorangehende Bewegung.** `MouseInput` wechselt das Ziel nicht,
  es verlässt sich auf das letzte `CursorMoved`. Ein Klick ohne jede Bewegung
  davor ginge an das alte Ziel. Über einen Zeiger, der sich bewegt hat, kommt
  das nicht vor — bei einem Touchpad-Tipp ohne Bewegung theoretisch schon.
- **Rückzucker am Übertritt.** Die beiden Sidecar-Prozesse auf dem gesteuerten
  Rechner lesen aus getrennten Pipes; ein verspätetes Bild vom alten Bildschirm
  kann den Zeiger einmal kurz zurückziehen. Kosmetisch, die nächste Bewegung
  korrigiert es. Nicht wegzudesignen — nur zu erkennen, wenn es auffällt.

## Selbstprüfung gegen den Entwurf

| Entwurf, Teil 1 | Task |
|---|---|
| `nachbarn.rs`, reine Rechnung mit Tests | 1 |
| Eigenes Fenster hat Vorrang, dann zuletzt fokussiertes | 1 (`vorrang`), 4 (Merker) |
| Rand ist kein Treffer, Lücke sendet nichts | 1, 3 |
| `ziel_slot` getrennt vom eigenen Platz | 2 |
| Zielwechsel leert die Warteschlange vorher | 3 (`ziel_wechseln`) |
| `letzte_zeigerlage` trägt die Lage im gemeinten Bild | 3 (`zeiger_im_bild` über `ziel_bestimmen`) |
| `CursorLeft` löscht nicht mehr blind | 3 |
| `eingabe_ereignis` nimmt das Ziel | 2 |
| Nur Fenster mit aktiver Erfassung sind Nachbarn | 4 |
| `verteilen` lässt Plätze derselben Sitzung durch | 5 |
| Version-Bump und Changelog | 6 |
| Handlauf mit zwei Bildschirmen | 6 |
