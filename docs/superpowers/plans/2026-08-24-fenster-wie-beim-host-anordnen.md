# Fenster wie beim Host anordnen — Umsetzungsplan (Teil 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Knopf im Menü am Griff legt die offenen Player-Fenster so auf den eigenen Schirm, wie die Bildschirme beim ferngesteuerten Rechner hängen.

**Architecture:** Die Anordnung der Host-Monitore liegt seit Teil 2 im Player vor. Eine reine Rechnung passt ihr Hüllrechteck in die Arbeitsfläche des eigenen Bildschirms ein und liefert je Fenster Lage und Grösse; die Fensterschleife setzt sie. Einmalig auf Knopfdruck, kein Dauerzustand.

**Tech Stack:** Rust (`pulse-player`, winit 0.30.13, egui)

**Spec:** `docs/superpowers/specs/2026-08-24-mehrere-host-bildschirme-design.md` (Teil 4)

## Global Constraints

- **Unter Wayland ist `Window::set_outer_position` ein stiller Leerlauf** (winit 0.30.13, `platform_impl/linux/wayland/window/mod.rs:273-275`, wörtlich `// Not possible on Wayland.`). Der Knopf darf dort **nicht** angeboten werden oder muss sagen, dass es nicht geht — sonst drückt man ihn und nichts passiert. Das ist die wichtigste Anforderung dieses Teils.
- **Grössen-Policy** (Richtwert 350, hart 500): `streaming/pulse-player/src/overlay/mod.rs` steht bei **578** und ist damit schon über der harten Grenze — dort kommt **nichts** dazu. `app/mod.rs` steht bei 1667 (ebenfalls vorbestehend über der Grenze) — dort so wenig wie möglich.
- Deutsch in neuen Kommentaren, Stil der Umgebung, **keine Emojis**.
- **Version-Bump und Changelog gehören NICHT in diesen Plan** — Teil 4 wird gemeinsam mit 1, 2, 3 und 5 ausgeliefert.
- Testbefehl: `cd streaming/pulse-player && FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo test --bins` (auf macOS stattdessen `PKG_CONFIG_PATH=$HOME/src/ffmpeg-openssl/lib/pkgconfig`).
- Arbeitszweig: der bestehende `feat/ziehen-ueber-die-fenstergrenze`.

---

## File Structure

| Datei | Verantwortung |
|---|---|
| **Neu:** `streaming/pulse-player/src/app/anordnen.rs` | Reine Rechnung: Host-Monitore + Zielfläche → Lage und Grösse je Fenster. Ohne winit, mit Tests. |
| `streaming/pulse-player/src/overlay/typen.rs` | neue `OverlayAction`-Variante |
| `streaming/pulse-player/src/overlay/fernbedienung.rs` | der Knopf, samt Wayland-Riegel |
| `streaming/pulse-player/src/app/mod.rs` | fängt die Aktion auf und setzt die Fenster |

---

## Task 1: Die Rechnung

**Files:**
- Create: `streaming/pulse-player/src/app/anordnen.rs`
- Modify: `streaming/pulse-player/src/app/mod.rs` — **nur** die Modulzeile

**Interfaces:**
- Produces:
  - `pub struct Schirmlage { pub index: u32, pub x: i32, pub y: i32, pub breite: u32, pub hoehe: u32 }`
  - `pub struct Fensterlage { pub index: u32, pub x: i32, pub y: i32, pub breite: u32, pub hoehe: u32 }`
  - `pub fn anordnen(schirme: &[Schirmlage], flaeche: (i32, i32, u32, u32)) -> Vec<Fensterlage>`
    — `flaeche` ist Lage und Grösse der Zielfläche auf dem eigenen Schirm (x, y, Breite, Höhe).

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

Datei `streaming/pulse-player/src/app/anordnen.rs`, Testmodul am Ende. Die Regeln, die die Tests festhalten müssen:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn s(index: u32, x: i32, y: i32, breite: u32, hoehe: u32) -> Schirmlage {
        Schirmlage { index, x, y, breite, hoehe }
    }

    /// Zwei gleich grosse Schirme nebeneinander landen nebeneinander, gleich
    /// gross, und fuellen die Flaeche in der Breite aus.
    #[test]
    fn zwei_nebeneinander_bleiben_nebeneinander() {
        let schirme = [s(1, 0, 0, 1920, 1080), s(2, 1920, 0, 1920, 1080)];
        let raus = anordnen(&schirme, (0, 0, 1920, 1080));
        assert_eq!(raus.len(), 2);
        assert!(raus[0].x < raus[1].x, "die Reihenfolge bleibt erhalten");
        assert_eq!(raus[0].breite, raus[1].breite, "gleich grosse Schirme, gleich grosse Fenster");
        assert_eq!(raus[0].y, raus[1].y, "auf gleicher Hoehe");
    }

    /// **Das Seitenverhaeltnis bleibt.** Ein Hochkant-Monitor steht hochkant,
    /// sonst waere die Karte eine Luege ueber die Anordnung.
    #[test]
    fn hochkant_bleibt_hochkant() {
        let schirme = [s(1, 0, 0, 1920, 1080), s(2, 1920, 0, 1080, 1920)];
        let raus = anordnen(&schirme, (0, 0, 1600, 900));
        let quer = &raus[0];
        let hoch = &raus[1];
        assert!(quer.breite > quer.hoehe, "der quere bleibt quer");
        assert!(hoch.hoehe > hoch.breite, "der hochkante bleibt hochkant");
    }

    /// **Negative Lagen sind gueltig** — ein Monitor links vom Hauptbildschirm.
    /// Das Ergebnis muss trotzdem vollstaendig INNERHALB der Zielflaeche liegen.
    #[test]
    fn negative_lagen_landen_in_der_flaeche() {
        let schirme = [s(1, -1920, 0, 1920, 1080), s(2, 0, 0, 1920, 1080)];
        let raus = anordnen(&schirme, (100, 50, 1600, 900));
        for f in &raus {
            assert!(f.x >= 100, "links vom Rand: {}", f.x);
            assert!(f.y >= 50, "ueber dem Rand: {}", f.y);
            assert!(f.x + f.breite as i32 <= 100 + 1600, "rechts hinaus: {}", f.x);
            assert!(f.y + f.hoehe as i32 <= 50 + 900, "unten hinaus: {}", f.y);
        }
        assert!(raus[0].x < raus[1].x, "der linke bleibt links");
    }

    /// Ein Schirm ueber dem anderen bleibt darueber.
    #[test]
    fn uebereinander_bleibt_uebereinander() {
        let schirme = [s(1, 0, -1080, 1920, 1080), s(2, 0, 0, 1920, 1080)];
        let raus = anordnen(&schirme, (0, 0, 1600, 900));
        assert!(raus[0].y < raus[1].y);
        assert_eq!(raus[0].x, raus[1].x, "gleiche Spalte");
    }

    /// Ein einzelner Schirm fuellt die Flaeche, ohne durch Null zu teilen.
    #[test]
    fn ein_einzelner_schirm_teilt_nicht_durch_null() {
        let raus = anordnen(&[s(1, 0, 0, 2560, 1440)], (0, 0, 1280, 720));
        assert_eq!(raus.len(), 1);
        assert!(raus[0].breite > 0 && raus[0].hoehe > 0);
        assert!(raus[0].breite <= 1280 && raus[0].hoehe <= 720);
    }

    /// **Ein Schirm ohne brauchbare Groesse faellt heraus**, statt die Rechnung
    /// zu verderben — eine Null im Nenner machte alle anderen unbrauchbar.
    #[test]
    fn schirm_ohne_groesse_faellt_heraus() {
        let schirme = [s(1, 0, 0, 0, 0), s(2, 0, 0, 1920, 1080)];
        let raus = anordnen(&schirme, (0, 0, 1600, 900));
        assert_eq!(raus.len(), 1);
        assert_eq!(raus[0].index, 2);
    }

    /// Gar nichts Brauchbares ergibt gar nichts — und keinen Absturz.
    #[test]
    fn ohne_brauchbare_schirme_kommt_nichts() {
        assert!(anordnen(&[], (0, 0, 1600, 900)).is_empty());
        assert!(anordnen(&[s(1, 0, 0, 0, 0)], (0, 0, 1600, 900)).is_empty());
        assert!(anordnen(&[s(1, 0, 0, 1920, 1080)], (0, 0, 0, 0)).is_empty());
    }
}
```

- [ ] **Step 2: Laufen lassen und scheitern sehen**

```bash
cd streaming/pulse-player
FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo test --bins anordnen
```

Erwartet: Übersetzungsfehler, `anordnen` gibt es nicht.

- [ ] **Step 3: Die Rechnung schreiben**

Kopf der Datei, im Stil der Nachbarn (`fernsteuerung/nachbarn.rs`, `fernsteuerung/bildlage.rs`):

```rust
//! Die Player-Fenster so legen, wie die Bildschirme beim Host haengen.
//!
//! Reine Rechnung, ohne winit: Huellrechteck der Host-Monitore, massstabsgetreu
//! in die Zielflaeche eingepasst, daraus je Fenster Lage und Groesse.
//!
//! **Warum massstabsgetreu und nicht ausgefuellt:** die Anordnung ist der ganze
//! Zweck. Ein Hochkant-Monitor, der breit gezogen wird, oder ein Abstand, der
//! verschwindet, macht aus der Hilfe eine Falschaussage.
//!
//! **Nicht geholte Schirme lassen ihre Luecke stehen** — der Aufrufer uebergibt
//! nur die Schirme, die wirklich ein Fenster haben, aber die Einpassung rechnet
//! ueber deren echte Lagen. Zusammenzuschieben hiesse, eine andere Anordnung zu
//! behaupten als die, die drueben besteht.
```

Vorgehen: Hüllrechteck über alle brauchbaren Schirme, Massstab `min(flaeche.breite / huelle.breite, flaeche.hoehe / huelle.hoehe)`, Ergebnis mittig in die Fläche gesetzt. Rundung so, dass nichts über den Rand rutscht (die Tests prüfen das).

Brauchbar heisst: `breite > 0 && hoehe > 0`. Ist die Zielfläche entartet oder bleibt kein Schirm übrig, kommt eine leere Liste zurück — der Aufrufer tut dann nichts.

- [ ] **Step 4: Modul anmelden und Tests**

In `app/mod.rs` die Modulzeile ergänzen (**nur** diese eine Zeile — die Datei ist mit 1667 Zeilen weit über der Grenze).

```bash
cd streaming/pulse-player
FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo test --bins
```

Erwartet: alle grün, inklusive der sieben neuen.

- [ ] **Step 5: Commit**

```bash
git add streaming/pulse-player/src/app/anordnen.rs streaming/pulse-player/src/app/mod.rs
git commit -m "feat(player): Rechnung fuers Anordnen der Fenster nach Host-Bild

Reine Einpassung: Huellrechteck der Host-Monitore massstabsgetreu in
eine Zielflaeche, daraus Lage und Groesse je Fenster. Ohne winit, mit
Tests — noch ruft sie niemand.

Seitenverhaeltnis und Reihenfolge bleiben erhalten, negative Lagen sind
gueltig, und ein Schirm ohne brauchbare Groesse faellt heraus statt die
Rechnung zu verderben.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Der Knopf, der Riegel und das Setzen

**Files:**
- Modify: `streaming/pulse-player/src/overlay/typen.rs` (neue `OverlayAction`-Variante)
- Modify: `streaming/pulse-player/src/overlay/fernbedienung.rs` (Knopf + Riegel)
- Modify: `streaming/pulse-player/src/app/mod.rs` (Aktion auffangen, Fenster setzen)

**Interfaces:**
- Consumes: `anordnen()` aus Task 1; die Host-Monitore aus Teil 2 (`overlay::Schirm` mit `x`, `y`, `width`, `height`)
- Produces: `OverlayAction::FensterAnordnen`

- [ ] **Step 1: Der Wayland-Riegel**

**Das ist der wichtigste Schritt dieser Aufgabe.** `set_outer_position` ist unter Wayland ein stiller Leerlauf — kein Fehler, keine Meldung, es passiert einfach nichts. Ein Knopf, der dort nichts tut, ist schlimmer als kein Knopf.

Bau eine kleine Auskunft mit zwei `cfg`-Fassungen, nach dem Muster von `skalierung_taugt` in `app/mod.rs` (dort wurde derselbe Umgang schon einmal gewählt):

```rust
/// Kann diese Oberflaeche Fenster ueberhaupt setzen?
///
/// **Unter Wayland nicht.** `Window::set_outer_position` ist dort ein stiller
/// Leerlauf (winit 0.30.13, `platform_impl/linux/wayland/window/mod.rs:273-275`,
/// woertlich „Not possible on Wayland") — ein Klient darf seine Fenster dort
/// nicht selbst platzieren. Der Knopf wird deshalb gar nicht erst angeboten;
/// einer, der wortlos nichts tut, ist schlimmer als keiner.
```

Auf Linux muss die Antwort **zur Laufzeit** fallen (derselbe Bau läuft unter X11 **und** Wayland). Ein `cfg(target_os)` genügt hier also **nicht** — frag winit, welche Oberfläche vorliegt. Ein gangbarer Weg ist `raw_window_handle`/`raw_display_handle` am Fenster: `RawDisplayHandle::Wayland(..)` heisst nein, `RawDisplayHandle::Xlib(..)`/`Xcb(..)` heisst ja. Prüf im Repo, ob `raw-window-handle` schon als Abhängigkeit vorliegt (wgpu zieht es), und nimm sonst einen anderen belegbaren Weg — **rate nicht.**

- [ ] **Step 2: Die Aktion und der Knopf**

`OverlayAction` (`overlay/typen.rs:63-70`) um eine Variante erweitern. In `fernbedienung.rs`, im Abschnitt „Bildschirme", einen Knopf **unter** der Karte — Beschriftung etwa „Fenster wie drüben anordnen". Er erscheint nur, wenn:

- mehr als ein Schirm offen ist (bei einem gibt es nichts anzuordnen), **und**
- die Oberfläche es kann (Step 1).

Stil wie die bestehenden Knöpfe daneben (`egui::Button` mit `theme::GRUPPE_BG`, `theme::RADIUS_MD`, `theme::font_xs()`).

- [ ] **Step 3: Auffangen und setzen**

In `app/mod.rs` neben `OverlayAction::RemoteScreen` (heute L1207-1212) auffangen. Ablauf:

1. Zielfläche bestimmen: der Bildschirm, auf dem das **auslösende** Fenster liegt (`window.current_monitor()`), dessen `position()` und `size()`.
2. Die Host-Monitore der offenen Fenster einsammeln — **nur die Fenster derselben Fernsteuerungs-Sitzung**, wie beim Zielen in Teil 1.
3. `anordnen()` rufen.
4. Ergebnis setzen: `set_outer_position` und `request_inner_size` je Fenster.

**Der Borrow-Checker wird sich melden:** die Liste muss **vor** einer veränderlichen Ausleihe der Sitzungen entstehen, genau wie beim Einsammeln der Nachbarschaft in Teil 1 (`app/mod.rs`, Kommentar dort). Kopiert werden nur Zahlen.

**Einmalig, kein Dauerzustand.** Nach dem Setzen merkt sich niemand etwas; wer die Fenster danach von Hand verschiebt, behält seine Anordnung.

- [ ] **Step 4: Tests und Grössen**

```bash
cd streaming/pulse-player
FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo test --bins
FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo build 2>&1 | grep "^warning" || echo "keine Warnungen"
wc -l src/app/*.rs src/overlay/*.rs
```

Erwartet: alle Tests grün; keine **neuen** Warnungen; `overlay/mod.rs` **nicht gewachsen**; `anordnen.rs` und `fernbedienung.rs` unter 350.

Das Setzen selbst ist **nicht per Test abgedeckt** — es braucht echte Fenster. Das gehört so in den Bericht.

- [ ] **Step 5: Commit**

```bash
git add streaming/pulse-player/src/
git commit -m "feat(player): Knopf legt die Fenster wie die Bildschirme drueben

Einmalig auf Knopfdruck, kein Dauerzustand — eine bleibende
Zwangsanordnung stritte mit der Fensterverwaltung des Nutzers.

Unter Wayland wird der Knopf GAR NICHT angeboten: set_outer_position
ist dort ein stiller Leerlauf, und ein Knopf der wortlos nichts tut ist
schlimmer als keiner. Die Entscheidung faellt zur Laufzeit, nicht per
cfg — derselbe Bau laeuft unter X11 und Wayland.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Bekannte Kanten

- **Drei oder vier Host-Monitore auf einen eigenen Schirm gelegt ergibt kleine Fenster.** Das ist die Natur der Sache; wer gross will, legt von Hand um.
- **Der Massstab richtet sich nach dem eigenen Bildschirm**, nicht nach dem Host — die Fenster sind nicht so gross wie drüben, nur so **angeordnet**.
- **Nur einer der eigenen Bildschirme wird bespielt.** Alles andere wäre eine Anordnungs-Verwaltung, und die hat das Betriebssystem.
- **Wayland bleibt aussen vor**, bis Teil 5 dort greift — und selbst dann bleibt das Setzen von Fensterlagen unmöglich; Teil 5 löst das Ziehen, nicht das Anordnen.

## Selbstprüfung gegen den Entwurf

| Entwurf, Teil 4 | Task |
|---|---|
| Hüllrechteck massstäblich in die Arbeitsfläche | 1 |
| Lücken nicht geholter Schirme bleiben stehen | 1 |
| Einmalig auf Knopfdruck | 2 |
| Wayland: Knopf nicht anbieten | 2 (Step 1) |
| Nur der eigene Bildschirm, auf dem das Menü liegt | 2 |
