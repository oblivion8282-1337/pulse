//! Die Schlusszeile: ein Urteil, kein Zahlenhaufen.
//!
//! **Drei Ausgaenge, und der dritte ist der wichtigste:** bestanden,
//! durchgefallen — und **ungueltig**. Ein ungueltiger Lauf sagt nichts ueber den
//! Injektor; ihn als „durchgefallen" zu melden schickt die Fehlersuche ans
//! falsche Ende. Genau das ist im Windows-Labor am 2026-08-12 mehrfach
//! passiert, bevor die Obenauf-Pruefung da war.

use crate::protokoll::{Aufzeichnung, Protokoll};
use crate::ziele::{self, Treffer};

/// Was ein Lauf erreichen musste.
pub struct Sollwerte {
    pub klicks: usize,
    pub raeder: usize,
    /// Die gesendeten Scancodes, in der Reihenfolge. Leer = nicht geprueft.
    pub scancodes: Vec<u16>,
    /// Die erwarteten Klickstaende, in der Reihenfolge. Leer = nicht geprueft.
    ///
    /// **Der eine Wert, den es auf Windows gar nicht zu pruefen gibt:** dort
    /// zaehlt das System Doppelklicks selbst, hier muss der Injektor es tun
    /// (gemessen, Messung 2 der Messakte). Ohne diese Zeile im Soll bliebe der
    /// Klickzaehler des Sidecars von jedem Nachweislauf unberuehrt.
    pub klickstaende: Vec<i64>,
}

pub enum Urteil {
    Bestanden,
    Durchgefallen(Vec<String>),
    Ungueltig(String),
}

impl Urteil {
    pub fn schluessel(&self) -> &'static str {
        match self {
            Urteil::Bestanden => "bestanden",
            Urteil::Durchgefallen(_) => "durchgefallen",
            Urteil::Ungueltig(_) => "ungueltig",
        }
    }

    /// Der Rueckgabewert des Programms: 0 bestanden, 1 durchgefallen,
    /// **2 ungueltig** — dieselbe Belegung wie im Windows-Treiber.
    pub fn ruecksprung(&self) -> i32 {
        match self {
            Urteil::Bestanden => 0,
            Urteil::Durchgefallen(_) => 1,
            Urteil::Ungueltig(_) => 2,
        }
    }
}

/// Faellt das Urteil.
///
/// **Zwei verschiedene Arten von „ungueltig", und der Unterschied zaehlt:**
///
/// * `aufbau` ist ein Fehler am Messmittel (kein Fenster, kein Abgriff, keine
///   Geometrie). Er sticht immer — es liegt gar keine Messung vor.
/// * `verdeckung` ist ein fremdes Fenster ueber einem Pruefpunkt. Es sticht
///   **nur einen Fehlschlag**: was sauber durchkam, gilt; was nicht durchkam,
///   gilt als ungueltig statt als durchgefallen. Begruendung samt Messung s.
///   `crate::fenster::Ergebnis::verdeckung`.
pub fn urteilen(
    aufbau: &Result<(), String>,
    verdeckung: Option<&String>,
    treffer: &[Treffer],
    daten: &Aufzeichnung,
    soll: &Sollwerte,
) -> Urteil {
    if let Err(grund) = aufbau {
        return Urteil::Ungueltig(grund.clone());
    }
    let mut maengel = Vec::new();
    if let Err(grund) = ziele::maus_urteil(treffer) {
        maengel.push(format!("Maus: {grund}"));
    }
    if daten.klicks.len() != soll.klicks {
        maengel.push(format!("Klicks: {} statt {}", daten.klicks.len(), soll.klicks));
    }
    if !soll.klickstaende.is_empty() {
        let ist: Vec<i64> = daten.klicks.iter().map(|k| k.klickstand).collect();
        if ist != soll.klickstaende {
            maengel.push(format!(
                "Klickstaende: empfangen {ist:?}, erwartet {:?}",
                soll.klickstaende
            ));
        }
    }
    if daten.raeder.len() != soll.raeder {
        maengel.push(format!("Rad: {} statt {}", daten.raeder.len(), soll.raeder));
    }
    if !soll.scancodes.is_empty() {
        let ist = empfangene_scancodes(daten);
        if ist != soll.scancodes {
            maengel.push(format!(
                "Scancodes: empfangen {ist:04x?}, gesendet {:04x?}",
                soll.scancodes
            ));
        }
    }
    // Ereignisse, die keine Lage tragen konnten, sind kein „daneben", sondern
    // ein Loch im Messmittel — sie muessen im Urteil auftauchen, sonst deckt
    // eine falsch ermittelte Geometrie sich selbst zu.
    //
    // **`ohne_fenster` gehoert ausdruecklich NICHT hierher.** Diese Ereignisse
    // tragen sehr wohl eine richtige Lage, nur gegen den Hauptschirm statt
    // gegen das Fenster gerechnet (s. `crate::ereignisse`). Sie stehen in der
    // Zusammenfassung als Zahl, weil sie verraten, dass das Fenster nicht mehr
    // vorn stand — aber sie sind kein Mangel.
    if daten.ohne_geometrie > 0 {
        maengel.push(format!("{} Ereignisse vor bekannter Geometrie", daten.ohne_geometrie));
    }
    match (maengel.is_empty(), verdeckung) {
        (true, _) => Urteil::Bestanden,
        (false, Some(v)) => Urteil::Ungueltig(format!("{v}; Maengel: {}", maengel.join(" / "))),
        (false, None) => Urteil::Durchgefallen(maengel),
    }
}

/// Die Scancodes der **Runter**-Ereignisse, in der Reihenfolge — wie im
/// Windows-Treiber. Unbenennbare Virtualcodes fallen dabei heraus und wuerden
/// den Vergleich kippen; das ist Absicht, eine Taste ohne Namen ist ein Befund.
pub fn empfangene_scancodes(daten: &Aufzeichnung) -> Vec<u16> {
    daten
        .tasten
        .iter()
        .filter(|t| t.runter)
        .filter_map(|t| t.scancode)
        .collect()
}

/// Schreibt die Zusammenfassung als letzte JSON-Zeile.
pub fn schreiben(
    protokoll: &mut Protokoll,
    urteil: &Urteil,
    treffer: &[Treffer],
    daten: &Aufzeichnung,
    skalierung: f64,
) {
    let ziele_json: Vec<serde_json::Value> = treffer
        .iter()
        .map(|t| {
            serde_json::json!({
                "ziel": [t.ziel.0, t.ziel.1],
                "ist": t.ist.map(|i| vec![i.0, i.1]),
                "abweichung_punkte": t.abweichung,
            })
        })
        .collect();
    protokoll.zeile(
        "zusammenfassung",
        serde_json::json!({
            "urteil": urteil.schluessel(),
            "grund": match urteil {
                Urteil::Bestanden => Vec::new(),
                Urteil::Durchgefallen(m) => m.clone(),
                Urteil::Ungueltig(g) => vec![g.clone()],
            },
            "ziele": ziele_json,
            // **`null`, nicht 0, wenn ein Ziel ohne Ereignis blieb** — s.
            // `crate::ziele`. Ein Auswerter, der hier eine 0 sieht, darf sich
            // darauf verlassen, dass wirklich gemessen wurde.
            "groesste_abweichung_punkte": ziele::groesste_abweichung(treffer),
            "ziele_ohne_ereignis": ziele::ohne_ereignis(treffer),
            "skalierung": skalierung,
            "bewegungen": daten.bewegungen.len(),
            "klicks": daten.klicks.iter().map(|k| serde_json::json!({
                "knopf": k.knopf, "runter": k.runter, "klickstand": k.klickstand,
            })).collect::<Vec<_>>(),
            "raeder": daten.raeder.iter().map(|r| serde_json::json!({
                "dy": r.dy, "dx": r.dx, "roll_dy": r.roll_dy, "roll_dx": r.roll_dx, "fein": r.fein,
            })).collect::<Vec<_>>(),
            "scancodes_empfangen": empfangene_scancodes(daten),
            "tasten": daten.tasten.len(),
            "ohne_geometrie": daten.ohne_geometrie,
            "ohne_fenster": daten.ohne_fenster,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protokoll::Taste;

    fn leer() -> Aufzeichnung {
        Aufzeichnung::default()
    }

    fn soll() -> Sollwerte {
        Sollwerte { klicks: 0, raeder: 0, scancodes: Vec::new(), klickstaende: Vec::new() }
    }

    fn treffer_alle_genau() -> Vec<Treffer> {
        let z = ziele::ziele_fuer((0.0, 0.0), 1000.0, 800.0);
        ziele::auswerten(&z, &z)
    }

    /// Ein Fehler am Messmittel sticht alles — auch lauter genaue Treffer.
    /// (Er kann in Wahrheit nicht zusammen mit ihnen auftreten; der Test haelt
    /// die Rangfolge fest, damit sie beim Umbauen nicht kippt.)
    #[test]
    fn ein_aufbaufehler_sticht_alles() {
        let u = urteilen(&Err("kein Abgriff".into()), None, &treffer_alle_genau(), &leer(), &soll());
        assert!(matches!(u, Urteil::Ungueltig(_)));
        assert_eq!(u.ruecksprung(), 2);
    }

    /// **Der Kern der Verdeckungs-Regel.** Ohne Ereignisse und OHNE Verdeckung
    /// ist es durchgefallen; dieselbe Lage MIT Verdeckung ist ungueltig. Der
    /// Unterschied ist die ganze Aussage: einmal ist der Injektor schuld,
    /// einmal weiss es niemand.
    ///
    /// Mutationsprobe: eine Fassung, die die Verdeckung ignoriert, meldet
    /// beide Male „durchgefallen" und faellt in der zweiten Haelfte.
    #[test]
    fn verdeckung_trennt_durchgefallen_von_ungueltig() {
        let z = ziele::ziele_fuer((0.0, 0.0), 1000.0, 800.0);
        let ohne = ziele::auswerten(&z, &[]);

        let u = urteilen(&Ok(()), None, &ohne, &leer(), &soll());
        match &u {
            Urteil::Durchgefallen(m) => assert!(m[0].contains("8 von 8"), "{m:?}"),
            andere => panic!("erwartet Durchgefallen, war {}", andere.schluessel()),
        }
        assert_eq!(u.ruecksprung(), 1);

        let stoerer = "Kurznotiz-Ecke".to_string();
        let u = urteilen(&Ok(()), Some(&stoerer), &ohne, &leer(), &soll());
        match &u {
            Urteil::Ungueltig(g) => assert!(g.contains("Kurznotiz"), "{g}"),
            andere => panic!("erwartet Ungueltig, war {}", andere.schluessel()),
        }
        assert_eq!(u.ruecksprung(), 2);
    }

    /// **Und die Gegenrichtung, die genauso wichtig ist:** eine Verdeckung
    /// allein wirft einen sauberen Lauf NICHT weg. Gemessen am 2026-08-23 —
    /// die Kurznotiz-Ecke legte sich ueber das Eckziel und schluckte trotzdem
    /// nichts.
    ///
    /// Mutationsprobe: eine Fassung, die jede Verdeckung fuer sich schon als
    /// ungueltig wertet (die Windows-Regel), faellt hier.
    #[test]
    fn eine_verdeckung_wirft_einen_sauberen_lauf_nicht_weg() {
        let stoerer = "Kurznotiz-Ecke".to_string();
        let u = urteilen(&Ok(()), Some(&stoerer), &treffer_alle_genau(), &leer(), &soll());
        assert!(matches!(u, Urteil::Bestanden), "{}", u.schluessel());
    }

    /// Ein perfekter Maus-Lauf besteht — sonst waere das Urteil nie erreichbar
    /// und jeder Test darauf wertlos.
    #[test]
    fn ein_sauberer_lauf_besteht() {
        let u = urteilen(&Ok(()), None, &treffer_alle_genau(), &leer(), &soll());
        assert!(matches!(u, Urteil::Bestanden), "{}", u.schluessel());
        assert_eq!(u.ruecksprung(), 0);
    }

    /// Fehlt eine Taste, faellt der Lauf durch — auch wenn die Maus stimmt.
    #[test]
    fn eine_fehlende_taste_kippt_den_lauf() {
        let mut daten = leer();
        for vk in [0x00u16, 0x01] {
            daten.tasten.push(Taste {
                virtualcode: vk,
                scancode: crate::tasten::scancode(vk),
                runter: true,
                umschalt: 0,
            });
        }
        let s = Sollwerte { scancodes: vec![0x1e, 0x1f, 0x20], ..soll() };
        let u = urteilen(&Ok(()), None, &treffer_alle_genau(), &daten, &s);
        assert!(matches!(u, Urteil::Durchgefallen(_)));
    }

    /// **Hoch-Ereignisse zaehlen nicht mit.** Ohne den Runter-Filter waere die
    /// empfangene Folge doppelt so lang wie die gesendete, und der Vergleich
    /// schluege bei jedem gesunden Lauf fehl.
    #[test]
    fn nur_runter_ereignisse_gehen_in_den_vergleich() {
        let mut daten = leer();
        for (vk, runter) in [(0x00u16, true), (0x00, false), (0x01, true), (0x01, false)] {
            daten.tasten.push(Taste {
                virtualcode: vk,
                scancode: crate::tasten::scancode(vk),
                runter,
                umschalt: 0,
            });
        }
        assert_eq!(empfangene_scancodes(&daten), vec![0x1e, 0x1f]);
        let s = Sollwerte { scancodes: vec![0x1e, 0x1f], ..soll() };
        assert!(matches!(urteilen(&Ok(()), None, &treffer_alle_genau(), &daten, &s), Urteil::Bestanden));
    }

    /// Ereignisse ohne Lage sind ein Loch im Messmittel und muessen sichtbar
    /// werden — sonst deckt eine falsch ermittelte Geometrie sich selbst zu.
    #[test]
    fn ereignisse_ohne_lage_kippen_den_lauf() {
        let mut daten = leer();
        daten.ohne_geometrie = 3;
        assert!(matches!(
            urteilen(&Ok(()), None, &treffer_alle_genau(), &daten, &soll()),
            Urteil::Durchgefallen(_)
        ));
    }

    /// **Der Klickstand muss stimmen, nicht nur die Zahl der Klicks.** Ein
    /// Sidecar ohne Klickzaehler liefert vier Klicks mit lauter Einsen — die
    /// Anzahl passt, der Doppelklick fehlt trotzdem, und zwar ohne dass
    /// irgendetwas fehlschlaegt.
    ///
    /// Mutationsprobe: den Klickstand-Vergleich entfernt, und dieser Test
    /// faellt — die Zahl der Klicks stimmt in beiden Faellen.
    #[test]
    fn lauter_einsen_sind_kein_doppelklick() {
        let mut daten = leer();
        for (runter, stand) in [(true, 1), (false, 1), (true, 1), (false, 1)] {
            daten.klicks.push(crate::protokoll::Klick {
                knopf: 0,
                runter,
                klickstand: stand,
                lage: None,
            });
        }
        let s = Sollwerte { klicks: 4, klickstaende: vec![1, 1, 2, 2], ..soll() };
        match urteilen(&Ok(()), None, &treffer_alle_genau(), &daten, &s) {
            Urteil::Durchgefallen(m) => {
                assert!(m.iter().any(|z| z.contains("Klickstaende")), "{m:?}")
            }
            andere => panic!("erwartet Durchgefallen, war {}", andere.schluessel()),
        }
    }
}
