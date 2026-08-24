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
//!
//! **`anordnen()` selbst bleibt reine Rechnung ohne winit** — alles, was
//! wirklich ein Fenster anfasst (die Wayland-Auskunft
//! [`fenster_setzen_moeglich`], das Anwenden in [`App::fenster_anordnen`]),
//! steht in eigenen Funktionen darunter, damit die Rechnung selbst ohne
//! Fenster pruefbar bleibt.
//!
//! **Verwandt, aber bewusst nicht geteilt:** [`crate::overlay::schirmkarte::rechnung`]
//! passt dieselbe Art Rechteck ein — Huellrechteck, ein gemeinsamer Massstab,
//! Seitenverhaeltnis bleibt. Dort ist das Ziel eine `egui::Rect`-Zeichenflaeche,
//! die immer bei (0, 0) beginnt: kontinuierliche `f32`-Koordinaten, keine
//! Rundung, keine Ueberlauf-Gefahr. Hier ist das Ziel eine echte
//! Fensterflaeche mit eigenem Ursprung auf dem Desktop, und das Ergebnis sind
//! ganzzahlige Bildschirmpunkte fuer echte OS-Fenster — die muessen gerundet
//! werden, UND das Runden darf die Flaeche nie verlassen (Rand-Faelle mit
//! negativen Lagen eingeschlossen). Der ueberlappende Teil (Huellrechteck,
//! ein Massstab fuer beide Achsen) ist knapp zehn Zeilen; der Teil, der sich
//! unterscheidet (Ursprungs-Versatz, Zentrierung, Ganzzahl-Rundung mit
//! Kappung gegen genau dieses Ueberlaufen, Mindestgroesse 1 Punkt), ist der
//! groessere UND der, an dem die beiden Faelle nichts teilen. Eine gemeinsame
//! Funktion bräuchte deshalb einen Rundungs-Strategie-Parameter, der an jeder
//! Aufrufstelle wieder alles Wissen ueber die jeweiligen Regeln bräuchte — das
//! waere mehr Kopplung als die paar geteilten Zeilen wert sind.

use winit::dpi::{PhysicalPosition, PhysicalSize};
use winit::window::Window;

/// Lage und Groesse eines Bildschirms beim Host, physische Punkte.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Schirmlage {
    pub index: u32,
    pub x: i32,
    pub y: i32,
    pub breite: u32,
    pub hoehe: u32,
}

/// Lage und Groesse, die ein Player-Fenster fuer diesen Schirm bekommen soll —
/// bezogen auf denselben Ursprung wie die uebergebene Zielflaeche.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fensterlage {
    pub index: u32,
    pub x: i32,
    pub y: i32,
    pub breite: u32,
    pub hoehe: u32,
}

/// Nur Schirme mit einer Groesse groesser Null — einer ohne faellt heraus,
/// statt die Rechnung zu verderben (Nenner Null im Huellrechteck).
fn brauchbare(schirme: &[Schirmlage]) -> Vec<&Schirmlage> {
    schirme.iter().filter(|s| s.breite > 0 && s.hoehe > 0).collect()
}

/// Kleinstes umschliessendes Rechteck (`min_x, min_y, max_x, max_y`) ueber
/// alle brauchbaren Schirme.
fn huelle(brauchbar: &[&Schirmlage]) -> (i32, i32, i32, i32) {
    let erster = brauchbar[0];
    let mut ecken = (erster.x, erster.y, erster.x + erster.breite as i32, erster.y + erster.hoehe as i32);
    for s in &brauchbar[1..] {
        ecken.0 = ecken.0.min(s.x);
        ecken.1 = ecken.1.min(s.y);
        ecken.2 = ecken.2.max(s.x + s.breite as i32);
        ecken.3 = ecken.3.max(s.y + s.hoehe as i32);
    }
    ecken
}

/// Legt die Player-Fenster so an, wie die Schirme beim Host zueinander liegen.
///
/// `flaeche` ist `(x, y, breite, hoehe)` der Zielflaeche auf dem eigenen
/// Schirm. Das Huellrechteck aller brauchbaren `schirme` wird mit EINEM
/// Massstab fuer beide Achsen eingepasst (Seitenverhaeltnis und Anordnung
/// bleiben dadurch erhalten) und mittig in die Flaeche gesetzt.
///
/// Leere Liste, wenn die Zielflaeche entartet ist (`breite`/`hoehe` 0) oder
/// kein Schirm brauchbar ist — der Aufrufer tut dann nichts.
pub fn anordnen(schirme: &[Schirmlage], flaeche: (i32, i32, u32, u32)) -> Vec<Fensterlage> {
    let (fx, fy, fw, fh) = flaeche;
    if fw == 0 || fh == 0 {
        return Vec::new();
    }
    let brauchbar = brauchbare(schirme);
    if brauchbar.is_empty() {
        return Vec::new();
    }

    let (min_x, min_y, max_x, max_y) = huelle(&brauchbar);
    let huelle_breite = (max_x - min_x) as f64;
    let huelle_hoehe = (max_y - min_y) as f64;
    let massstab = (fw as f64 / huelle_breite).min(fh as f64 / huelle_hoehe);

    // Zentrierung: die Achse, die NICHT den Massstab bindet, hat Luft
    // uebrig — die wird zu gleichen Teilen links/rechts bzw. oben/unten
    // verteilt, statt die Anordnung an eine Ecke zu kleben.
    let versatz_x = fx as f64 + (fw as f64 - huelle_breite * massstab) / 2.0;
    let versatz_y = fy as f64 + (fh as f64 - huelle_hoehe * massstab) / 2.0;

    brauchbar
        .into_iter()
        .map(|s| {
            // Groesse zuerst abrunden (nie mehr, als der Massstab hergibt,
            // Mindestgroesse 1 Punkt statt eines unsichtbaren Fensters), dann
            // erst die Position runden UND gegen genau diese Groesse kappen —
            // so kann das Runden der Position nie ueber den Rand tragen, egal
            // wie die Gleitkomma-Reste fallen.
            let breite = ((s.breite as f64 * massstab).floor().max(1.0) as u32).min(fw);
            let hoehe = ((s.hoehe as f64 * massstab).floor().max(1.0) as u32).min(fh);
            let roh_x = versatz_x + (s.x - min_x) as f64 * massstab;
            let roh_y = versatz_y + (s.y - min_y) as f64 * massstab;
            let x = (roh_x.round() as i32).clamp(fx, fx + fw as i32 - breite as i32);
            let y = (roh_y.round() as i32).clamp(fy, fy + fh as i32 - hoehe as i32);
            Fensterlage { index: s.index, x, y, breite, hoehe }
        })
        .collect()
}

/// Kann diese Oberflaeche Fenster ueberhaupt setzen?
///
/// **Unter Wayland nicht.** `Window::set_outer_position` ist dort ein stiller
/// Leerlauf (winit 0.30.13, `platform_impl/linux/wayland/window/mod.rs:273-275`,
/// woertlich „Not possible on Wayland") — ein Klient darf seine Fenster dort
/// nicht selbst platzieren. Der Knopf wird deshalb gar nicht erst angeboten;
/// einer, der wortlos nichts tut, ist schlimmer als keiner.
///
/// **Nur unter Linux eine echte Frage.** Derselbe Bau laeuft dort unter X11
/// UND Wayland — ein `cfg(target_os)` allein kann die beiden nicht
/// unterscheiden, die Antwort muss zur LAUFZEIT fallen. Sie kommt ueber das
/// Anzeige-Handle (`RawDisplayHandle::Wayland` = nein, `Xlib`/`Xcb` = ja) —
/// genau das Muster, das `crate::tastensperre::wayland::aufbauen` fuer die
/// Tastenkuerzel-Sperre schon nutzt. Auf Windows und macOS gibt es kein
/// Wayland, dort ist die Antwort immer ja; ein zweites `cfg(target_os)`
/// erspart dort jede Laufzeit-Abfrage — dasselbe Muster wie
/// `super::skalierung_taugt`.
///
/// Ein fehlgeschlagenes Anzeige-Handle zaehlt als NEIN: lieber fehlt der
/// Knopf, als dass er auf einer ungeklaerten Oberflaeche wortlos nichts tut.
#[cfg(target_os = "linux")]
pub(crate) fn fenster_setzen_moeglich(fenster: &Window) -> bool {
    use raw_window_handle::{HasDisplayHandle, RawDisplayHandle};
    fenster.display_handle().is_ok_and(|h| !matches!(h.as_raw(), RawDisplayHandle::Wayland(_)))
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn fenster_setzen_moeglich(_fenster: &Window) -> bool {
    true
}

impl super::App {
    /// Knopf „Fenster wie drueben anordnen": legt alle offenen Fenster
    /// DIESER Fernsteuerungs-Sitzung auf dem Bildschirm, auf dem das
    /// AUSLOESENDE Fenster (`id`) liegt, so an, wie die Host-Monitore
    /// zueinander liegen.
    ///
    /// Einmalig — danach merkt sich niemand etwas, wer von Hand nachzieht,
    /// behaelt seine Anordnung (s. Modulkopf).
    pub(super) fn fenster_anordnen(&mut self, id: u64) {
        let Some(session) = self.sessions.get(&id) else { return };
        // Wayland: der Knopf war ohnehin nicht sichtbar (s.
        // `fenster_setzen_moeglich`) — hier nur die zweite, billige
        // Absicherung gegen einen veralteten Frame.
        if !fenster_setzen_moeglich(&session.window) {
            return;
        }
        // Zielflaeche: der Bildschirm DIESES Fensters. `current_monitor`
        // liefert `None`, wenn winit ihn nicht ermitteln kann — dann bleibt
        // nichts anderes uebrig, als nichts zu tun: es gibt keine Flaeche,
        // in die sich etwas einpassen liesse.
        let Some(monitor) = session.window.current_monitor() else { return };
        let pos = monitor.position();
        let size = monitor.size();
        let flaeche = (pos.x, pos.y, size.width, size.height);

        // Nur die EIGENE, aktive Fernsteuerungs-Sitzung zaehlt — dasselbe
        // Zielkriterium wie beim Einsammeln der Nachbarschaft in
        // `App::window_event` (Begruendung dort): Fenster- und Platznummern
        // wiederholen sich zwischen Sitzungen, die Sitzungskennung nicht.
        if !session.eingabe.aktiv() {
            return;
        }
        let Some(eigene_sitzung) = session.eingabe.sitzung().map(str::to_owned) else { return };

        // **Erst ALLE Schirme sammeln, dann rechnen** — und zwar nicht wegen
        // der Ausleihe (unten wird `self.sessions` ebenfalls nur gelesen, eine
        // Liste aus `&Session` uebersetzte hier also auch), sondern weil
        // `anordnen()` einen GEMEINSAMEN Massstab ueber alle Schirme legt: es
        // muss die gesamte Anordnung des Hosts kennen, bevor es das erste
        // Fenster setzen kann. Ein Durchlauf, der Fenster einzeln setzt,
        // waehrend er sie noch einsammelt, gibt es deshalb nicht.
        let schirme: Vec<Schirmlage> = self
            .sessions
            .values()
            .filter(|s| s.eingabe.aktiv() && s.eingabe.sitzung() == Some(eigene_sitzung.as_str()))
            .filter_map(|s| s.fern_schirme.iter().find(|schirm| schirm.dieses_fenster))
            .filter_map(|schirm| {
                Some(Schirmlage {
                    index: schirm.index,
                    x: schirm.x?,
                    y: schirm.y?,
                    breite: schirm.width?,
                    hoehe: schirm.height?,
                })
            })
            .collect();

        for lage in anordnen(&schirme, flaeche) {
            let ziel = self.sessions.values().find(|s| {
                s.eingabe.aktiv()
                    && s.eingabe.sitzung() == Some(eigene_sitzung.as_str())
                    && s
                        .fern_schirme
                        .iter()
                        .any(|schirm| schirm.dieses_fenster && schirm.index == lage.index)
            });
            let Some(ziel) = ziel else { continue };
            ziel.window.set_outer_position(PhysicalPosition::new(lage.x, lage.y));
            let _ = ziel.window.request_inner_size(PhysicalSize::new(lage.breite, lage.hoehe));
        }
    }
}

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
