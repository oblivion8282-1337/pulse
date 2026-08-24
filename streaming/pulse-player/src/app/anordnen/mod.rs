//! Die Player-Fenster so legen, wie die Bildschirme beim Host haengen.
//!
//! **Zwei Dateien statt Abschnitten**, wie bei
//! [`crate::overlay::schirmkarte`]: hier steht die reine Rechnung ohne winit
//! (Huellrechteck, Einpassung, das Tor [`anordenbar`]) — pruefbar ohne
//! Fenster. Alles, was wirklich ein Fenster anfasst (Wayland-Auskunft,
//! Zielflaeche, Setzen), steht in [`anwenden`].
//!
//! **Warum massstabsgetreu und nicht ausgefuellt:** die Anordnung ist der ganze
//! Zweck. Ein Hochkant-Monitor, der breit gezogen wird, oder ein Abstand, der
//! verschwindet, macht aus der Hilfe eine Falschaussage.
//!
//! **Gerechnet wird ueber die GEHOLTEN Schirme, nicht ueber alle.** Der
//! Aufrufer uebergibt nur die Schirme, die wirklich ein Fenster haben; die
//! Einpassung rechnet ueber deren echte Lagen, Luecken ZWISCHEN ihnen bleiben
//! also stehen. Zusammenzuschieben hiesse, eine andere Anordnung zu behaupten
//! als die, die drueben besteht.
//!
//! **Am RAND weicht das bewusst von der Bildschirm-Karte ab.** Die Karte
//! ([`crate::overlay::schirmkarte`]) spannt ihr Huellrechteck ueber ALLE
//! Schirme mit Lage, hier ist es das der geholten. Bei drei Monitoren, von
//! denen zwei offen sind, zeigt die Karte die Aufteilung ueber drei, die
//! Fenster verteilen sich aber ueber die Huelle der zwei — sie stehen danach
//! weiter auseinander, als die Karte es zeigt. Das ist die bessere Haelfte der
//! Wahl: die Huelle aller drei zu nehmen hiesse, ein Drittel der Zielflaeche
//! fuer einen Bildschirm freizuhalten, der gar kein Fenster hat, und beide
//! vorhandenen Fenster dafuer kleiner zu machen. Was in BEIDEN Faellen stimmt,
//! ist die Anordnung untereinander: links bleibt links, oben bleibt oben,
//! Abstaende im Verhaeltnis.
//!
//! **Verwandt, aber bewusst nicht geteilt:** [`crate::overlay::schirmkarte`]
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
//!
//! **Geteilt ist dagegen [`ueberschneiden`]**: die Karte braucht dieselbe
//! Frage („liegen zwei Schirme uebereinander?") und dieselbe Antwort. Sie ist
//! ein Vergleich ohne Strategie und ohne Einheiten — genau das Gegenteil der
//! Einpassung oben.

mod anwenden;

pub(crate) use anwenden::fenster_setzen_moeglich;

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

/// Ueberschneiden sich zwei Rechtecke `(x, y, breite, hoehe)`?
///
/// **Warum Ueberschneidung und nicht Gleichheit.** Scheitert am Host die
/// Lage-Abfrage (`GetMonitorInfoW` auf Windows, `CGDisplayBounds` auf macOS),
/// melden die Sidecars `0/0` statt das Feld wegzulassen. Bei einem SEKUNDAEREN
/// Monitor ergibt das dieselbe Lage wie beim Primaerbildschirm, aber in aller
/// Regel eine andere Aufloesung — die beiden Rechtecke sind dann nicht
/// deckungsgleich, sondern ineinander geschoben. Dasselbe entsteht bei echter
/// Bildschirmspiegelung mit verschiedenen Aufloesungen (MacBook 2880x1800 auf
/// Beamer 1920x1080, beide bei `0/0`). Eine Pruefung auf Gleichheit liesse
/// genau diese Faelle durch.
///
/// Echte Desktop-Anordnungen ueberschneiden sich nie — Windows und macOS
/// legen Monitore luecken- und ueberlappungsfrei nebeneinander. Ein Treffer
/// hier heisst deshalb: die gemeldeten Lagen taugen nicht.
///
/// Halboffene Intervalle: zwei Monitore, die sich beruehren (`0..1920` und
/// `1920..3840`), ueberschneiden sich NICHT. Gerechnet in `i64`, damit
/// `x + breite` auch bei unsinnigen Zahlen aus der Leitung nicht ueberlaeuft.
pub(crate) fn ueberschneiden(a: (i32, i32, u32, u32), b: (i32, i32, u32, u32)) -> bool {
    let rechts = |r: (i32, i32, u32, u32)| i64::from(r.0) + i64::from(r.2);
    let unten = |r: (i32, i32, u32, u32)| i64::from(r.1) + i64::from(r.3);
    i64::from(a.0) < rechts(b)
        && i64::from(b.0) < rechts(a)
        && i64::from(a.1) < unten(b)
        && i64::from(b.1) < unten(a)
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

/// Das eine Tor, hinter dem sich Anzeige und Wirkung treffen — auf bereits
/// gefilterten Schirmen, damit [`anordnen`] nicht zweimal filtert.
fn taugt(brauchbar: &[&Schirmlage]) -> bool {
    if brauchbar.len() < 2 {
        return false;
    }
    for i in 0..brauchbar.len() {
        for j in (i + 1)..brauchbar.len() {
            let (a, b) = (brauchbar[i], brauchbar[j]);
            if ueberschneiden((a.x, a.y, a.breite, a.hoehe), (b.x, b.y, b.breite, b.hoehe)) {
                return false;
            }
        }
    }
    true
}

/// Wuerde [`anordnen`] ueberhaupt etwas ausrichten? **Genau diese Funktion
/// entscheidet auch, ob der Knopf im Menue erscheint** (ueber
/// `App::anordnen_moeglich`, das ihr dieselbe Schirmliste vorlegt, mit der
/// [`anordnen`] danach rechnet). Beides aus einer Quelle, weil es vorher zwei
/// unabhaengig formulierte Bedingungen waren und der Knopf dadurch in drei
/// Faellen sichtbar war, in denen er nachweislich nichts tun konnte.
///
/// Zwei Gruende sprechen dagegen:
///
/// * **Weniger als zwei Schirme mit Groesse.** Meldet der ferne Rechner keine
///   Lagen (aeltere Gegenstelle — direkt nach einer Auslieferung der
///   Normalfall) oder ist die Zuordnung Strom-zu-Bildschirm mehrdeutig, kommt
///   hier eine leere oder einelementige Liste an. Bei EINEM Schirm waere das
///   Ergebnis besonders irrefuehrend: er wuerde auf die volle Zielflaeche
///   gezogen, das zweite Fenster bliebe liegen — das sieht nach Fehlfunktion
///   aus, nicht nach Anordnung.
/// * **Zwei Schirme ueberschneiden sich** (s. [`ueberschneiden`]). Alle
///   Fenster laegen dann deckungsgleich uebereinander, jedes
///   bildschirmfuellend: der Nutzer sieht danach ein Fenster und haelt die
///   anderen fuer verschwunden. **Ein Rueckgaengig gibt es nicht.**
fn anordenbar(schirme: &[Schirmlage]) -> bool {
    taugt(&brauchbare(schirme))
}

/// Legt die Player-Fenster so an, wie die Schirme beim Host zueinander liegen.
///
/// `flaeche` ist `(x, y, breite, hoehe)` der Zielflaeche auf dem eigenen
/// Schirm. Das Huellrechteck aller brauchbaren `schirme` wird mit EINEM
/// Massstab fuer beide Achsen eingepasst (Seitenverhaeltnis und Anordnung
/// bleiben dadurch erhalten) und mittig in die Flaeche gesetzt.
///
/// Leere Liste, wenn die Zielflaeche entartet ist (`breite`/`hoehe` 0) oder
/// [`anordenbar`] nein sagt — der Aufrufer tut dann nichts.
pub fn anordnen(schirme: &[Schirmlage], flaeche: (i32, i32, u32, u32)) -> Vec<Fensterlage> {
    let (fx, fy, fw, fh) = flaeche;
    if fw == 0 || fh == 0 {
        return Vec::new();
    }
    let brauchbar = brauchbare(schirme);
    if !taugt(&brauchbar) {
        return Vec::new();
    }

    // Ab hier sind mindestens zwei Schirme mit Groesse groesser Null im Spiel;
    // die Spannweite auf beiden Achsen ist damit mindestens so gross wie der
    // groesste Einzelschirm — die Division kann nie durch Null gehen.
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

    /// **Ein einzelner Schirm wird NICHT angeordnet.** Frueher fuellte er die
    /// Zielflaeche — genau der Fall, in dem ein Fenster bildschirmfuellend
    /// wird und das andere liegen bleibt (der Gateway darf jede der vier
    /// Lagezahlen einzeln weglassen, dann bleibt genau einer uebrig). Der
    /// alte Zweck dieses Tests (keine Division durch Null) haengt jetzt am
    /// Tor selbst: unter zwei Schirmen wird gar nicht erst gerechnet.
    #[test]
    fn ein_einzelner_schirm_wird_nicht_angeordnet() {
        assert!(anordnen(&[s(1, 0, 0, 2560, 1440)], (0, 0, 1280, 720)).is_empty());
        assert!(!anordenbar(&[s(1, 0, 0, 2560, 1440)]));
    }

    /// **Ein Schirm ohne brauchbare Groesse faellt heraus**, statt die Rechnung
    /// zu verderben — eine Null im Nenner machte alle anderen unbrauchbar.
    /// Bleibt dadurch nur noch einer uebrig, wird gar nichts angeordnet.
    #[test]
    fn schirm_ohne_groesse_faellt_heraus() {
        let schirme = [s(1, 0, 0, 0, 0), s(2, 0, 0, 1920, 1080), s(3, 1920, 0, 1920, 1080)];
        let raus = anordnen(&schirme, (0, 0, 1600, 900));
        assert_eq!(raus.len(), 2);
        assert_eq!(raus[0].index, 2);
        assert!(anordnen(&[s(1, 0, 0, 0, 0), s(2, 0, 0, 1920, 1080)], (0, 0, 1600, 900)).is_empty());
    }

    /// Gar nichts Brauchbares ergibt gar nichts — und keinen Absturz.
    #[test]
    fn ohne_brauchbare_schirme_kommt_nichts() {
        assert!(anordnen(&[], (0, 0, 1600, 900)).is_empty());
        assert!(anordnen(&[s(1, 0, 0, 0, 0)], (0, 0, 1600, 900)).is_empty());
        let zwei = [s(1, 0, 0, 1920, 1080), s(2, 1920, 0, 1920, 1080)];
        assert!(anordnen(&zwei, (0, 0, 0, 0)).is_empty(), "entartete Zielflaeche");
    }

    // ── ueberschneiden / anordenbar ──────────────────────────────────────

    #[test]
    fn beruehrende_rechtecke_ueberschneiden_sich_nicht() {
        assert!(!ueberschneiden((0, 0, 1920, 1080), (1920, 0, 1920, 1080)));
        assert!(!ueberschneiden((0, 0, 1920, 1080), (0, 1080, 1920, 1080)));
        assert!(!ueberschneiden((0, 0, 1920, 1080), (-1024, 0, 1024, 768)));
    }

    #[test]
    fn ein_punkt_ueberlappung_zaehlt_schon() {
        assert!(ueberschneiden((0, 0, 1920, 1080), (1919, 1079, 1920, 1080)));
    }

    /// **Der Fall, der die Gleichheitspruefung durchliess:** zwei Monitore
    /// melden beide `0/0` (gescheiterte Lage-Abfrage am Host), haben aber
    /// verschiedene Aufloesungen. Deckungsgleich sind sie damit nicht —
    /// ineinander geschoben schon.
    #[test]
    fn gescheiterte_lage_abfrage_zweier_monitore_ist_nicht_anordenbar() {
        assert!(!anordenbar(&[s(1, 0, 0, 3840, 2160), s(2, 0, 0, 1920, 1080)]));
        assert!(anordnen(&[s(1, 0, 0, 3840, 2160), s(2, 0, 0, 1920, 1080)], (0, 0, 1600, 900))
            .is_empty());
    }

    /// Echte Bildschirmspiegelung: gleiche Lage, gleiche Groesse.
    #[test]
    fn spiegelung_ist_nicht_anordenbar() {
        assert!(!anordenbar(&[s(1, 0, 0, 1920, 1080), s(2, 0, 0, 1920, 1080)]));
    }

    /// **Anzeige und Wirkung sind dasselbe.** Der Knopf erscheint genau dann,
    /// wenn [`anordnen`] auch etwas liefert — die Bedingung war frueher an
    /// zwei Stellen unabhaengig formuliert, und kein Test verband sie.
    #[test]
    fn anzeige_und_wirkung_stimmen_ueberein() {
        let faelle: Vec<Vec<Schirmlage>> = vec![
            vec![],
            vec![s(1, 0, 0, 1920, 1080)],
            vec![s(1, 0, 0, 0, 0), s(2, 0, 0, 1920, 1080)],
            vec![s(1, 0, 0, 1920, 1080), s(2, 1920, 0, 1920, 1080)],
            vec![s(1, 0, 0, 1920, 1080), s(2, 0, 0, 1920, 1080)],
            vec![s(1, 0, 0, 3840, 2160), s(2, 0, 0, 1920, 1080)],
            vec![s(1, -1920, 0, 1920, 1080), s(2, 0, 0, 2560, 1440), s(3, 2560, 0, 1920, 1080)],
            vec![s(1, 0, 0, 1920, 1080), s(2, 1920, 0, 1920, 1080), s(3, 0, 0, 1920, 1080)],
        ];
        for fall in faelle {
            assert_eq!(
                anordenbar(&fall),
                !anordnen(&fall, (0, 0, 1600, 900)).is_empty(),
                "Anzeige und Wirkung laufen auseinander: {fall:?}"
            );
        }
    }
}
