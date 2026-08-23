//! Ausführung eines geprüften Frames: **was** injiziert wird — und was nicht.
//!
//! Hier sitzt die Klemm-Zusage der Spezifikation: „Absolute Koordinaten werden
//! ins Quell-Rechteck geklemmt. Der Steuernde kann nur dorthin klicken, wo er
//! per Aufnahme auch hinsehen darf."
//!
//! ## Warum das mehr braucht als eine Klemmung auf `MouseMoveAbs`
//!
//! Zwei Frames trugen früher **keinen** Ortsbezug und liefen deshalb an der
//! Zusage vorbei:
//!
//! * `MouseMoveRel` ging ungeklemmt an den Injektor. Mehrfach `dx = dy = −32768`
//!   schiebt den Zeiger in die Ecke des Desktops — weit außerhalb des
//!   Gestreamten.
//! * `MouseButton` trägt gar keine Position; er feuert dort, wo der Zeiger
//!   steht. Nach der Bewegung oben also irgendwo. Ohne Angreifer derselbe
//!   Schaden: wird eine `MouseMoveAbs` verworfen (Fenster zu, entartetes
//!   Rechteck), stünde der Zeiger noch dort, wo der **Host-Nutzer** ihn hat, und
//!   der nachfolgende Klick landete in dessen Fenster.
//!
//! Dass der eigene Player brav ist, ist keine Durchsetzung — dieser Baustein ist
//! die fail-closed-Grenze gegen „Fehler oder Angriff".
//!
//! ## Die Mechanik: eine mitgeführte Zeigerlage, absolut gesetzt
//!
//! [`Tat::zeiger`] hält den Punkt, den **wir** zuletzt gesetzt haben
//! — geklemmt, also nachweislich im Quell-Rechteck. Daraus folgt alles Weitere:
//!
//! * `MouseMoveAbs` rechnet den Anteil ins Rechteck, setzt absolut, merkt sich
//!   den Punkt. Kein (oder ein entartetes) Rechteck → nichts gesetzt **und die
//!   gemerkte Lage entwertet**.
//! * `MouseMoveRel` addiert das Delta auf die gemerkte Lage, klemmt und setzt
//!   ebenfalls **absolut**.
//! * `MouseButton` (runter) und `MouseWheel` feuern nur mit gültiger Lage im
//!   aktuellen Rechteck — und behaupten sie vorher noch einmal, damit der Klick
//!   auch dann dort landet, wenn der Host-Nutzer seine Maus zwischendurch selbst
//!   bewegt hat (die Einspielung arbeitet die Warteschlange in Reihenfolge ab).
//!
//! **Warum relativ absolut wird.** Die Spezifikation will für den Zeigerfang
//! eine rohe Relativbewegung, damit das System seine Beschleunigung auflegt.
//! Genau diese Beschleunigung ist von hier aus aber nicht
//! vorhersagbar — ein Delta lässt sich damit nicht klemmen. Und die naheliegende
//! Rückmeldung (die Zeigerlage nach dem Setzen erneut abfragen) trägt nicht:
//! die Injektion arbeitet asynchron, die gelesene Lage kann noch die alte
//! sein; ein darauf gestütztes Tor verwürfe echte Klicks. Also: Beschleunigung
//! fällt weg, Klemmung gilt. Beschleunigung ist Bequemlichkeit, die Klemmung
//! ist die Sicherheitszusage. (Wenn ein Spiel später wirklich rohe
//! Relativ-Deltas braucht, ist der Weg zurück eine **belegte** Rückmeldung,
//! nicht eine ungeklemmte Injektion.)
//!
//! **Die eine Ausnahme:** das Loslassen eines Knopfes, den wir selbst gedrückt
//! haben, geht immer durch — auch ohne gültige Lage. Sonst klemmte eine
//! Maustaste am fremden Rechner, sobald das Rechteck einmal wegfällt.

use crate::druck::Druck;
use crate::format;
use crate::plattform::Injektor;
use crate::rahmen::InputFrame;
use crate::zuordnung::{self, Rechteck};

/// Der Teil des Sitzungszustands, den die Ausführung fortschreibt.
///
/// Die Sitzung führt ihn (sie entscheidet über Handschlag, Stilllegung und
/// Ende); hier wird er nur geschrieben. Deshalb ein eigener Typ und nicht der
/// ganze Sitzungszustand: die Ausführung soll `stillgelegt` und `geschlossen`
/// gar nicht sehen können.
#[derive(Default)]
pub(crate) struct Tat {
    /// Wo dieser Prozess den Zeiger zuletzt SELBST hingesetzt hat — geklemmt
    /// und damit nachweislich im Quell-Rechteck. `None` = unbekannt, dann
    /// feuert kein Knopf und kein Rad.
    pub(crate) zeiger: Option<(i32, i32)>,
    /// Alles, was gerade physisch unten ist — fürs Loslassen.
    pub(crate) druck: Druck,
}

/// Einen geprüften Frame ausführen. `rechteck` ist das Quell-Rechteck dieser
/// Nachricht (`None` = nicht auflösbar). `Err(grund)` = fail-closed.
pub(crate) fn einspielen(
    z: &mut Tat,
    injektor: &dyn Injektor,
    rechteck: Option<Rechteck>,
    frame: InputFrame,
) -> Result<(), String> {
    match frame {
        // Der Handschlag ist Sitzungszustand, nicht Ausführung — er wird eine
        // Ebene höher behandelt (`crate::sitzung::Sitzung::handschlag`).
        InputFrame::Hello { .. } => {}
        InputFrame::MouseMoveAbs { x, y } => {
            let punkt = rechteck.and_then(|r| zuordnung::anteil_auf_punkt(x, y, &r));
            bewegen(z, injektor, punkt);
        }
        InputFrame::MouseMoveRel { dx, dy } => {
            let punkt = rechteck.and_then(|r| relatives_ziel(z.zeiger, dx, dy, &r));
            bewegen(z, injektor, punkt);
        }
        InputFrame::MouseButton { btn, down } => {
            // Unbekannter Knopf ist fail-closed, und zwar **vor** allem
            // anderen: ein Frame, den wir nicht deuten können, ist ein Fehler
            // oder ein Angriff — unabhängig davon, wo der Zeiger steht.
            if !format::knopf_bekannt(btn) {
                return Err(format!("unbekannte Maustaste: {btn}"));
            }
            let ort = tat_ort(z, rechteck);
            // Loslassen eines von uns gedrückten Knopfes: immer, sonst klemmt er.
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
        InputFrame::MouseWheel { dv, dh } => {
            if dv == 0 && dh == 0 {
                return Ok(());
            }
            // Das Rad trägt so wenig Position wie der Knopf und gehört damit
            // unter dasselbe Tor — die Spezifikation sagt es ausdrücklich:
            // „Nicht nur die Bewegung, auch Knopf und Rad gehören ins Bild."
            let Some(ort) = tat_ort(z, rechteck) else {
                return Ok(());
            };
            injektor.maus_setzen(ort, &z.druck);
            injektor.maus_rad(dv, dh);
        }
        InputFrame::Key { scan, down } => {
            // Missgeformter Scancode → beenden statt raten (Spezifikation). Ein
            // `0xE11D` würde sonst als linke Strg-Taste injiziert, weil `wScan`
            // nur das niederwertige Byte trägt — und bliebe gedrückt.
            //
            // Kein Orts-Tor: die Tastatur geht an das Fenster mit dem Fokus,
            // nicht an eine Stelle des Bildschirms. Ein Tor über die Zeigerlage
            // wäre hier Theater.
            if !format::scancode_gueltig(scan) {
                return Err(format!(
                    "missgeformter Scancode {scan:#06x} — Satz 1 kennt nur 0x00xx und 0xE0xx"
                ));
            }
            // Reihenfolge bewusst so: der Injektor bekommt die Menge VOR
            // diesem Ereignis (s. `plattform::Injektor::taste`), genau wie
            // bei `bewegen` unten. Dass das eigene Runter-Ereignis dabei fehlt,
            // ist am 2026-08-23 gemessen worden und schadet nicht — Cmd+C wirkt
            // auch dann. **Belegt ist das fuer AppKits Tastenkuerzel-Abgleich**,
            // nicht fuer jede Art, wie ein Programm Modifikatoren liest —
            // Einschraenkung samt Gegenprobe im Doc-Kommentar der Trait-Methode.
            injektor.taste(scan, down, &z.druck);
            z.druck.taste(scan, down);
        }
    }
    Ok(())
}

/// Den Zeiger auf einen geklemmten Punkt setzen und ihn merken. `None` = die
/// Bewegung war nicht ausführbar (kein oder entartetes Rechteck): dann wird
/// **auch die gemerkte Lage ungültig**, denn wo der Zeiger jetzt steht, weiß
/// niemand — und ein Klick darf dort nicht feuern.
fn bewegen(z: &mut Tat, injektor: &dyn Injektor, punkt: Option<(i32, i32)>) {
    if let Some(p) = punkt {
        injektor.maus_setzen(p, &z.druck);
    }
    z.zeiger = punkt;
}

/// Wohin eine relative Bewegung führt: gemerkte Lage + Delta, ins Quell-Rechteck
/// geklemmt. `None` bei entartetem Rechteck.
///
/// Ohne gemerkte Lage (erster relativer Frame nach dem Hello — im Zeigerfang
/// schickt der Steuernde nie eine absolute Bewegung) wird von der **Mitte des
/// Quell-Rechtecks** aus gerechnet. Ein anderer Startpunkt wäre nicht
/// begründbar, und der Zeigerfang-Fall merkt davon nichts: dort liest das Spiel
/// Deltas, nicht die Lage des Zeigers.
fn relatives_ziel(
    zeiger: Option<(i32, i32)>,
    dx: i16,
    dy: i16,
    rect: &Rechteck,
) -> Option<(i32, i32)> {
    let (bx, by) = match zeiger {
        Some(p) => p,
        None => zuordnung::mitte(rect)?,
    };
    zuordnung::klemmen(bx.saturating_add(dx as i32), by.saturating_add(dy as i32), rect)
}

/// Darf an der gemerkten Zeigerlage gehandelt werden (Knopf runter, Rad)? Und
/// wenn ja, wo genau?
///
/// `None` heißt still verwerfen — nicht fail-closed: es ist kein Protokollfehler,
/// wenn das Fenster gerade zugeht oder wenn eine Bewegung verworfen wurde.
/// Verlangt wird eine Lage, die **im heutigen** Rechteck liegt; ist das Fenster
/// seit der letzten Bewegung weitergewandert, wird nicht etwa auf den neuen Rand
/// geklemmt (das klickte irgendwohin, wo niemand hingezeigt hat), sondern
/// abgewartet — der nächste Bewegungsframe kommt binnen eines Bildtakts.
fn tat_ort(z: &Tat, rechteck: Option<Rechteck>) -> Option<(i32, i32)> {
    let rect = rechteck?;
    let p = z.zeiger?;
    (zuordnung::klemmen(p.0, p.1, &rect) == Some(p)).then_some(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pruefstand::{Ereignis, PruefInjektor};

    fn rect(l: i32, t: i32, r: i32, b: i32) -> Rechteck {
        Rechteck { links: l, oben: t, rechts: r, unten: b }
    }

    /// Ein Quell-Rechteck, das mit Sicherheit nicht den ganzen Desktop füllt —
    /// sonst prüfte die Klemmung nichts.
    const QUELLE: Rechteck = Rechteck { links: 100, oben: 200, rechts: 1100, unten: 800 };

    fn zustand(zeiger: Option<(i32, i32)>) -> Tat {
        Tat { zeiger, ..Tat::default() }
    }

    /// **Der Fund (relativ):** `MouseMoveRel` ging ungeklemmt an `SendInput` —
    /// mehrfach `dx = dy = −32768` und der Zeiger stand irgendwo auf dem
    /// Desktop des Hosts. Egal wie oft und wie weit: er darf das Quell-Rechteck
    /// nicht verlassen.
    #[test]
    fn relative_bewegung_verlaesst_das_rechteck_nie() {
        for start in [None, Some((100, 200)), Some((1099, 799)), Some((600, 500))] {
            let mut lage = start;
            for (dx, dy) in [
                (-32768i16, -32768i16),
                (-32768, -32768),
                (32767, 32767),
                (32767, -32768),
                (1, 1),
                (0, 0),
            ] {
                lage = relatives_ziel(lage, dx, dy, &QUELLE);
                let (px, py) = lage.expect("gesundes Rechteck liefert immer einen Punkt");
                assert!(
                    (QUELLE.links..QUELLE.rechts).contains(&px)
                        && (QUELLE.oben..QUELLE.unten).contains(&py),
                    "aus {start:?} über ({dx},{dy}) heraus: {px},{py}"
                );
            }
        }
    }

    /// Entartetes Rechteck (gecloaktes Fenster) → kein Ziel, statt darin zu
    /// rechnen. Der Aufrufer entwertet dann die Lage.
    #[test]
    fn relative_bewegung_ohne_brauchbares_rechteck() {
        assert_eq!(relatives_ziel(Some((5, 5)), 1, 1, &rect(0, 0, 0, 0)), None);
        assert_eq!(relatives_ziel(None, 1, 1, &rect(500, 100, 500, 700)), None);
    }

    /// Und über die ganze Ausführung: die relative Bewegung wird **absolut**
    /// gesetzt (geklemmt, s. Modul-Doku) und die Lage bleibt im Rechteck.
    #[test]
    fn relative_bewegung_wird_geklemmt_gesetzt() {
        let inj = PruefInjektor::default();
        let mut z = zustand(Some((600, 500)));
        einspielen(&mut z, &inj, Some(QUELLE), InputFrame::MouseMoveRel { dx: -32768, dy: -32768 })
            .unwrap();
        assert_eq!(z.zeiger, Some((QUELLE.links, QUELLE.oben)));
        let spur = inj.nimm();
        assert_eq!(spur.len(), 1, "{spur:?}");
        match &spur[0] {
            Ereignis::Setzen { punkt, .. } => {
                assert_eq!(*punkt, (QUELLE.links, QUELLE.oben));
            }
            andere => panic!("Mausbewegung erwartet, war {andere:?}"),
        }
    }

    /// **Der Fund (Knopf):** `MouseButton` trägt keine Position und prüfte kein
    /// Rechteck — er feuerte, wo der Zeiger des HOST-Nutzers gerade stand. Ohne
    /// gültige, geklemmte Lage darf er gar nicht feuern.
    #[test]
    fn knopf_feuert_nicht_ohne_gueltige_lage() {
        let inj = PruefInjektor::default();
        let mut z = zustand(None);
        einspielen(&mut z, &inj, Some(QUELLE), InputFrame::MouseButton { btn: 0, down: true })
            .unwrap();
        assert!(inj.nimm().is_empty(), "ohne Lage darf nichts feuern");
        assert_eq!(z.druck.anzahl(), 0, "und nichts gemerkt worden sein");
    }

    /// Lage vorhanden, aber außerhalb des heutigen Rechtecks (Fenster
    /// weitergewandert) → ebenfalls nicht feuern.
    #[test]
    fn knopf_feuert_nicht_ausserhalb_des_rechtecks() {
        let inj = PruefInjektor::default();
        let mut z = zustand(Some((5000, 5000)));
        einspielen(&mut z, &inj, Some(QUELLE), InputFrame::MouseButton { btn: 0, down: true })
            .unwrap();
        assert!(inj.nimm().is_empty());
        // Auch ohne Rechteck überhaupt.
        let mut z = zustand(Some((600, 500)));
        einspielen(&mut z, &inj, None, InputFrame::MouseButton { btn: 0, down: true }).unwrap();
        assert!(inj.nimm().is_empty());
    }

    /// Der Alltagsfall ohne Angreifer: eine verworfene absolute Bewegung
    /// entwertet die Lage — sonst feuerte der nachfolgende Klick dort, wo der
    /// Host-Nutzer seinen Zeiger hat.
    #[test]
    fn verworfene_bewegung_entwertet_die_lage() {
        let inj = PruefInjektor::default();
        let mut z = zustand(Some((600, 500)));
        einspielen(&mut z, &inj, None, InputFrame::MouseMoveAbs { x: 32767, y: 32767 }).unwrap();
        assert_eq!(z.zeiger, None);
        let _ = inj.nimm();
        einspielen(&mut z, &inj, Some(QUELLE), InputFrame::MouseButton { btn: 0, down: true })
            .unwrap();
        assert!(inj.nimm().is_empty(), "Klick nach verworfener Bewegung");
    }

    /// Mit gültiger Lage feuert der Knopf — und behauptet die Lage vorher noch
    /// einmal, damit er auch dann dort landet, wenn der Host-Nutzer seine Maus
    /// zwischendurch bewegt hat.
    #[test]
    fn knopf_feuert_mit_gueltiger_lage() {
        let inj = PruefInjektor::default();
        let mut z = zustand(Some((600, 500)));
        einspielen(&mut z, &inj, Some(QUELLE), InputFrame::MouseButton { btn: 0, down: true })
            .unwrap();
        let spur = inj.nimm();
        assert_eq!(spur, vec![
            Ereignis::Setzen { punkt: (600, 500), zieht: false },
            Ereignis::Knopf { btn: 0, down: true },
        ], "erst Lage behaupten, dann feuern");
        assert!(z.druck.knopf_ist_unten(0), "der Druck muss vermerkt sein");
    }

    /// Die Ausnahme: ein von uns gedrückter Knopf wird **immer** losgelassen,
    /// auch ohne gültige Lage. Sonst klemmte die Maustaste am fremden Rechner,
    /// sobald das Rechteck einmal wegfällt.
    #[test]
    fn loslassen_geht_auch_ohne_lage_durch() {
        let inj = PruefInjektor::default();
        let mut z = zustand(None);
        z.druck.knopf(1, true);
        einspielen(&mut z, &inj, None, InputFrame::MouseButton { btn: 1, down: false }).unwrap();
        let spur = inj.nimm();
        assert_eq!(
            spur,
            vec![Ereignis::Knopf { btn: 1, down: false }],
            "nur das Hoch-Ereignis: {spur:?}"
        );
        assert!(!z.druck.knopf_ist_unten(1));
    }

    /// Ein Hoch-Ereignis für einen Knopf, den wir nie gedrückt haben, ist
    /// dagegen keine Freigabe — es fällt unter dasselbe Tor (es könnte einen
    /// Ziehvorgang des Host-Nutzers abschließen).
    #[test]
    fn fremdes_loslassen_faellt_unter_das_tor() {
        let inj = PruefInjektor::default();
        let mut z = zustand(None);
        einspielen(&mut z, &inj, None, InputFrame::MouseButton { btn: 1, down: false }).unwrap();
        assert!(inj.nimm().is_empty());
    }

    /// Unbekannter Knopf bleibt fail-closed — vor jedem Orts-Tor.
    #[test]
    fn unbekannter_knopf_ist_fail_closed() {
        let inj = PruefInjektor::default();
        let mut z = zustand(None);
        assert!(
            einspielen(&mut z, &inj, None, InputFrame::MouseButton { btn: 9, down: true }).is_err()
        );
    }

    /// Das Rad steht unter demselben Tor wie der Knopf.
    #[test]
    fn rad_feuert_nicht_ohne_gueltige_lage() {
        let inj = PruefInjektor::default();
        let mut z = zustand(None);
        einspielen(&mut z, &inj, Some(QUELLE), InputFrame::MouseWheel { dv: 120, dh: 0 }).unwrap();
        assert!(inj.nimm().is_empty());

        let mut z = zustand(Some((600, 500)));
        einspielen(&mut z, &inj, Some(QUELLE), InputFrame::MouseWheel { dv: 120, dh: -120 })
            .unwrap();
        let spur = inj.nimm();
        assert_eq!(spur, vec![
            Ereignis::Setzen { punkt: (600, 500), zieht: false },
            Ereignis::Rad { dv: 120, dh: -120 },
        ], "erst Lage behaupten, dann ein Rad-Aufruf");
    }

    /// Ein Scancode außerhalb von Satz 1 wird abgewiesen, statt als eine
    /// ANDERE Taste injiziert zu werden (`0xE11D` → linke Strg-Taste).
    #[test]
    fn missgeformter_scancode_ist_fail_closed() {
        let inj = PruefInjektor::default();
        let mut z = zustand(None);
        let fehler = einspielen(
            &mut z,
            &inj,
            Some(QUELLE),
            InputFrame::Key { scan: 0xE11D, down: true },
        )
        .expect_err("0xE11D darf nicht injiziert werden");
        assert!(fehler.contains("0xe11d"), "{fehler}");
        assert_eq!(z.druck.anzahl(), 0, "nichts darf gemerkt worden sein");
        assert!(inj.nimm().is_empty(), "und schon gar nichts injiziert");
    }

    /// Tasten hängen am Fokus, nicht am Ort — sie gehen ohne Zeigerlage durch.
    #[test]
    fn taste_braucht_keine_zeigerlage() {
        let inj = PruefInjektor::default();
        let mut z = zustand(None);
        einspielen(&mut z, &inj, None, InputFrame::Key { scan: 0x11, down: true }).unwrap();
        assert_eq!(inj.nimm(), vec![Ereignis::Taste { scan: 0x11, down: true, mods: vec![] }]);
        assert_eq!(z.druck.anzahl(), 1);
    }

    /// **Die Lücke, die Task 1 schließt:** der Injektor bekommt beim
    /// Tasten-Ereignis dieselbe Gedrückt-Menge wie bei einer Mausbewegung —
    /// macOS braucht sie, um Tastatur-Ereignisse mit `.maskCommand` &c. zu
    /// kennzeichnen, sonst bleibt Cmd+C wirkungslos (nachgemessen 2026-08-23,
    /// s. Doc-Kommentar von `plattform::Injektor::taste`). Hier steht schon
    /// eine Taste (Platzhalter für einen gehaltenen Modifikator), bevor
    /// `scan` gedrückt wird — der Injektor muss genau sie in `mods` sehen,
    /// **nicht** die neue Taste selbst, denn `ausfuehrung` schreibt
    /// `z.druck` erst NACH diesem Aufruf fort.
    #[test]
    fn taste_traegt_die_zuvor_gedrueckte_menge_an_den_injektor() {
        let inj = PruefInjektor::default();
        let mut z = zustand(None);
        z.druck.taste(0x1D, true); // bereits gehalten (Platzhalter fuer Cmd)
        einspielen(&mut z, &inj, None, InputFrame::Key { scan: 0x2E, down: true }).unwrap();
        assert_eq!(
            inj.nimm(),
            vec![Ereignis::Taste { scan: 0x2E, down: true, mods: vec![0x1D] }],
            "der Injektor muss die vorher gedrueckte Taste in `mods` sehen"
        );
        assert_eq!(z.druck.anzahl(), 2, "danach stehen beide im Druckzustand");
    }
}
