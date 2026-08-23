//! Wie aus einem Frame-Bestandteil ein CoreGraphics-Ereignis wird — die reine
//! Abbildung, ohne einen einzigen Aufruf ins System.
//!
//! **Eigene Datei aus demselben Grund wie [`super::klickzaehler`]:** was hier
//! steht, laesst sich in einem Unit-Test festhalten. Was in
//! [`super::injektion`] steht, nicht — dort wird abgefeuert, und ob etwas
//! ankommt, weiss nur der WindowServer (dafuer gibt es den Pruefling
//! `examples/probe_injektor/`).
//!
//! Die drei Stellen, an denen macOS von Windows abweicht, liegen alle drei
//! hier: [`bewegungs_typ`] (Ziehen ist ein eigener Ereignistyp), [`flags_aus`]
//! (die Umschalttasten-Kennzeichnung wird nicht gefuellt) und — eine Ebene
//! weiter — der Klickzaehler nebenan.

use objc2_core_graphics::{CGEventFlags, CGEventType, CGMouseButton};
use pulse_fernsteuerung::druck::Druck;
use pulse_fernsteuerung::format::RASTE;

/// Scancode Satz 1 -> Umschalttasten-Kennzeichnung. `None` = keine.
///
/// **Die Feststelltaste (`0x3a`) bleibt bewusst draussen.** Sie ist eine
/// Verriegelung, keine gehaltene Taste: `Druck` fuehrt sie nur, solange sie
/// koerperlich unten ist (Bruchteil einer Sekunde), waehrend
/// `kCGEventFlagMaskAlphaShift` den DAUERZUSTAND meint. Wer sie hier
/// mitnaehme, kennzeichnete genau die Ereignisse als Grossschrift, waehrend die
/// Taste gedrueckt wird — und keines danach. Die Umkehrung dessen, was gemeint
/// ist.
fn flagge(scan: u16) -> Option<CGEventFlags> {
    Some(match scan {
        0x2a | 0x36 => CGEventFlags::MaskShift,
        0x1d | 0xe01d => CGEventFlags::MaskControl,
        0x38 | 0xe038 => CGEventFlags::MaskAlternate,
        0xe05b | 0xe05c => CGEventFlags::MaskCommand,
        _ => return None,
    })
}

/// Die Kennzeichnung fuer die gerade gehaltene Menge.
///
/// **Gemessen am 2026-08-23** (Messung 2b): macOS fuellt sie NICHT. Nach einem
/// echten Cmd-Runter blieb die Zwischenablage bei Cmd+C unveraendert; erst mit
/// `.maskCommand` auf den C-Ereignissen kam der Text an. Windows baut den
/// Modifikator-Zustand im System auf, hier muss der Injektor ihn mitschicken.
///
/// **Das gilt fuer Maus-Ereignisse genauso** (Nachtrag 3 der Messakte, am
/// eigenen Code gefahren): Umschalt+Klick erweiterte die Auswahl in TextEdit nur
/// mit gesetzter Kennzeichnung; ohne sie sprang bloss die Einfuegemarke. Ein
/// Cmd-Klick ist so verbreitet wie ein Cmd-C — deshalb geht die Kennzeichnung
/// auch auf Bewegung, Knopf und Rad hinaus, nicht nur auf die Tastatur.
///
/// **Und die offene Frage aus Aufgabe 1 ist beantwortet** (Nachtrag 1): ein
/// Cmd-**Runter** muss seine eigene Kennzeichnung NICHT tragen. Die Reihenfolge
/// in `pulse_fernsteuerung::ausfuehrung` (erst der Injektor, dann der Nachtrag
/// in `Druck`) traegt also — nachgemessen in beiden Ausfuehrungen, Cmd+C wirkte
/// beide Male. Auch die Kehrseite ist gemessen: das Cmd-**Hoch** traegt bei
/// dieser Reihenfolge noch `.maskCommand`, obwohl es das Ende meldet, und Cmd
/// bleibt trotzdem nicht haengen — die naechste gewoehnliche Taste kam als Text
/// an.
pub fn flags_aus(gedrueckt: &Druck) -> CGEventFlags {
    let mut flags = CGEventFlags::empty();
    for scan in gedrueckt.tasten_unten() {
        if let Some(f) = flagge(scan) {
            flags |= f;
        }
    }
    flags
}

/// btn-Code -> (Ereignistyp, Knopfnummer). `None` = unbekannt.
///
/// Der Aufrufer hat `btn` bereits gegen `format::knopf_bekannt` geprueft — hier
/// wird nicht mehr entschieden, hier wird abgefeuert. Still nichts zu tun ist
/// trotzdem richtiger als eine Panik im Dispatch-Faden.
///
/// Die Windows-Seitenknoepfe X1/X2 (3/4) sind auf macOS schlicht die
/// Knopfnummern 3 und 4 — `CGMouseButton` benennt nur die ersten drei, ist aber
/// ein durchgezaehlter Wert.
pub fn knopf_ereignis(btn: u8, down: bool) -> Option<(CGEventType, CGMouseButton)> {
    Some(match btn {
        0 => (
            if down { CGEventType::LeftMouseDown } else { CGEventType::LeftMouseUp },
            CGMouseButton::Left,
        ),
        1 => (
            if down { CGEventType::RightMouseDown } else { CGEventType::RightMouseUp },
            CGMouseButton::Right,
        ),
        2..=4 => (
            if down { CGEventType::OtherMouseDown } else { CGEventType::OtherMouseUp },
            CGMouseButton(u32::from(btn)),
        ),
        _ => return None,
    })
}

/// Welcher Ereignistyp traegt eine Bewegung?
///
/// **Die erste der drei Abweichungen von Windows:** eine Bewegung bei
/// gedruecktem Knopf gehoert als Zieh-Ereignis hinaus (`LeftMouseDragged` &c.),
/// nicht als `MouseMoved`. Genau dafuer bekommt `Injektor::maus_setzen` die
/// Gedrueckt-Menge.
///
/// **Wie weit das gemessen ist** (2026-08-23, Nachtrag 4 der Messakte): der
/// Unterschied ueberlebt die Leitung — an den Ereigniszaehlern des HID-Systems
/// abgelesen bleibt `MouseMoved` ein `MouseMoved`, der WindowServer berichtigt
/// den Typ **nicht**. Was NICHT gemessen ist, ist der Schaden: die beiden
/// Ziele, an denen es geprueft wurde (Textauswahl in TextEdit, Fenster an der
/// Titelleiste verschieben), zogen auch mit `MouseMoved` mit. Die Aussage
/// „sonst zieht in vielen Programmen nichts" aus dem Entwurf ist damit **nicht
/// belegt** — sie gilt fuer Programme, die streng auf
/// `NSEventMaskLeftMouseDragged` hoeren (Spiele, Qt, Chromium), und dafuer fehlt
/// hier ein Ziel. Der richtige Typ bleibt trotzdem der richtige Typ.
///
/// Bei mehreren gedrueckten Knoepfen entscheidet der **kleinste**.
/// `Druck::knoepfe_unten` liefert sortiert, und sein Kommentar sagt, warum:
/// sonst zoege der Injektor mal den einen, mal den anderen.
pub fn bewegungs_typ(gedrueckt: &Druck) -> (CGEventType, CGMouseButton) {
    match gedrueckt.knoepfe_unten().first() {
        None => (CGEventType::MouseMoved, CGMouseButton::Left),
        Some(0) => (CGEventType::LeftMouseDragged, CGMouseButton::Left),
        Some(1) => (CGEventType::RightMouseDragged, CGMouseButton::Right),
        Some(&btn) => (CGEventType::OtherMouseDragged, CGMouseButton(u32::from(btn))),
    }
}

/// Wie viele Zeilen dieser Injektor je Windows-Raste ([`RASTE`]) an
/// CoreGraphics uebergibt.
///
/// **Produktentscheidung, keine Richtigkeitsfrage — und offen** (Befund 5 der
/// Pruefung vom 2026-08-23). Nachgemessen kommen dabei effektiv 0,75 bis 0,8
/// Zeilen je Raste **an**, nicht eine (Nachtrag 5 der Messakte,
/// `docs/plans/2026-08-23-macos-eingabe-messungen.md`): macOS legt auf ein
/// Zeilen-Rollereignis noch seine eigene Beschleunigungskurve, dieser Wert
/// wird davor eingespeist. „Wie Windows" ist dabei gar kein wohldefiniertes
/// Ziel: Windows' DREI Zeilen je Raste (`SPI_GETWHEELSCROLLLINES`) sind eine
/// HOST-Einstellung, zu der macOS kein Gegenstueck hat — und die gemessenen
/// 0,75-0,8 sind an TextEdits Weichroll-Rundung abgelesen, nicht an einem
/// Systemfaktor. **Die Entscheidung faellt durch Nebeneinander-Benutzen,
/// nicht durch eine weitere Zahl** — deshalb bleibt der Wert hier bei 1.
const ZEILEN_JE_RASTE: i32 = 1;

/// Windows-Rastschritte -> Zeilen.
///
/// **Gemessen am 2026-08-23** (Messung 3): „natuerliches Scrollen" wirkt nicht
/// auf injizierte Ereignisse, die Richtung ist in beiden Stellungen dieselbe
/// und entspricht der Windows-Bedeutung von `dv > 0`. **Keine Gegenrechnung.**
///
/// Eine Windows-Raste ([`RASTE`]) ist [`ZEILEN_JE_RASTE`] Zeile(n) — s. dort
/// fuer die Begruendung des Werts. Der eigene Sender schickt immer ganze
/// Vielfache einer Raste (`pulse_fernsteuerung::bauen::Rastensammler` hebt
/// Bruchteile ueber Ereignisse hinweg auf); ein Bruchteil kann nur von einem
/// fremden Sender kommen und wird auf **eine** Zeile in seine Richtung
/// aufgerundet statt verschluckt — ein verschlucktes Rad sieht aus wie eine
/// tote Leitung.
pub fn zeilen(delta: i16) -> i32 {
    let ganze = delta as i32 / RASTE * ZEILEN_JE_RASTE;
    if ganze == 0 { delta.signum() as i32 } else { ganze }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn druck_mit(tasten: &[u16], knoepfe: &[u8]) -> Druck {
        let mut d = Druck::default();
        for &t in tasten {
            d.taste(t, true);
        }
        for &k in knoepfe {
            d.knopf(k, true);
        }
        d
    }

    /// Ohne gedrueckten Knopf ist eine Bewegung eine Bewegung.
    #[test]
    fn ohne_knopf_wird_bewegt() {
        let (typ, _) = bewegungs_typ(&druck_mit(&[], &[]));
        assert_eq!(typ, CGEventType::MouseMoved);
    }

    /// **Die Abweichung von Windows:** mit gedruecktem Knopf ist dieselbe
    /// Bewegung ein Zieh-Ereignis, je Knopf ein eigenes.
    #[test]
    fn mit_knopf_wird_gezogen() {
        for (btn, erwartet) in [
            (0u8, CGEventType::LeftMouseDragged),
            (1, CGEventType::RightMouseDragged),
            (2, CGEventType::OtherMouseDragged),
            (3, CGEventType::OtherMouseDragged),
            (4, CGEventType::OtherMouseDragged),
        ] {
            let (typ, knopf) = bewegungs_typ(&druck_mit(&[], &[btn]));
            assert_eq!(typ, erwartet, "btn={btn}");
            assert_eq!(knopf, CGMouseButton(u32::from(btn)), "btn={btn}");
        }
    }

    /// Bei mehreren gedrueckten Knoepfen entscheidet der kleinste — und zwar
    /// unabhaengig davon, in welcher Reihenfolge sie gedrueckt wurden. Sonst
    /// zoege der Injektor mal den einen, mal den anderen.
    #[test]
    fn bei_mehreren_knoepfen_zieht_der_kleinste() {
        for reihenfolge in [[4u8, 1, 2], [2, 4, 1], [1, 2, 4]] {
            let (typ, knopf) = bewegungs_typ(&druck_mit(&[], &reihenfolge));
            assert_eq!(typ, CGEventType::RightMouseDragged, "{reihenfolge:?}");
            assert_eq!(knopf, CGMouseButton::Right, "{reihenfolge:?}");
        }
    }

    /// Jede Umschalttaste, links wie rechts, ergibt ihre Kennzeichnung — und
    /// mehrere zusammen ergeben die Summe. Ohne das bleibt Cmd+C wirkungslos
    /// (gemessen, s. [`flags_aus`]).
    #[test]
    fn jede_umschalttaste_kennzeichnet() {
        for (scans, erwartet) in [
            (vec![0x2a], CGEventFlags::MaskShift),
            (vec![0x36], CGEventFlags::MaskShift),
            (vec![0x1d], CGEventFlags::MaskControl),
            (vec![0xe01d], CGEventFlags::MaskControl),
            (vec![0x38], CGEventFlags::MaskAlternate),
            (vec![0xe038], CGEventFlags::MaskAlternate),
            (vec![0xe05b], CGEventFlags::MaskCommand),
            (vec![0xe05c], CGEventFlags::MaskCommand),
            (
                vec![0xe05b, 0x2a],
                CGEventFlags::MaskCommand | CGEventFlags::MaskShift,
            ),
        ] {
            assert_eq!(flags_aus(&druck_mit(&scans, &[])), erwartet, "{scans:04x?}");
        }
    }

    /// Eine gewoehnliche Taste kennzeichnet nichts — sonst truege jedes
    /// Ereignis waehrend eines gehaltenen „A" eine erfundene Kennzeichnung.
    #[test]
    fn gewoehnliche_tasten_kennzeichnen_nicht() {
        assert_eq!(flags_aus(&druck_mit(&[0x1e, 0x2e], &[])), CGEventFlags::empty());
    }

    /// Die Feststelltaste bleibt draussen: sie ist eine Verriegelung, keine
    /// gehaltene Taste (s. [`flagge`]).
    #[test]
    fn feststelltaste_kennzeichnet_nicht() {
        assert_eq!(flags_aus(&druck_mit(&[0x3a], &[])), CGEventFlags::empty());
    }

    /// Runter und hoch sind verschiedene Ereignistypen, die Knopfnummer bleibt
    /// dieselbe — und die Seitenknoepfe trennen sich nur ueber sie.
    #[test]
    fn jeder_knopf_hat_runter_und_hoch() {
        for btn in 0..=4u8 {
            let (runter, k1) = knopf_ereignis(btn, true).expect("bekannter Knopf");
            let (hoch, k2) = knopf_ereignis(btn, false).expect("bekannter Knopf");
            assert_ne!(runter, hoch, "btn={btn}");
            assert_eq!(k1, k2, "btn={btn}");
            assert_eq!(k1, CGMouseButton(u32::from(btn)), "btn={btn}");
        }
        assert!(knopf_ereignis(5, true).is_none());
        assert!(knopf_ereignis(255, false).is_none());
    }

    /// Eine Raste ist eine Zeile, das Vorzeichen bleibt (gemessen, keine
    /// Gegenrechnung) — und ein Bruchteil wird nicht verschluckt.
    #[test]
    fn eine_raste_ist_eine_zeile() {
        assert_eq!(zeilen(120), 1);
        assert_eq!(zeilen(-120), -1);
        assert_eq!(zeilen(360), 3);
        assert_eq!(zeilen(0), 0);
        assert_eq!(zeilen(60), 1, "Bruchteil eines fremden Senders, nicht verschluckt");
        assert_eq!(zeilen(-1), -1);
    }
}
