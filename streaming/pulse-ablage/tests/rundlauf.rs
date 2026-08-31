//! Der Rundlauf beider Enden, ohne Betriebssystem.
//!
//! Dieser Test ist der Beleg fuer die eine Zusicherung, um derentwillen die
//! ganze Kiste so gebaut ist: **beim Kopieren geht kein Inhalt hinaus.**

use pulse_ablage::beobachter::Beobachter;
use pulse_ablage::eigentum::Eigentum;
use pulse_ablage::format::{Grund, Rahmen};
use pulse_ablage::pruefstand::TestAblage;
use pulse_ablage::sitzung::{Ankuendiger, Empfaenger, Fortschritt};

/// Eine Seite: eigene Ablage, eigener Ankuendiger, eigener Empfaenger.
struct Seite {
    ablage: TestAblage,
    ank: Ankuendiger,
    emp: Empfaenger,
}

impl Seite {
    fn neu() -> Seite {
        Seite { ablage: TestAblage::neu(), ank: Ankuendiger::neu(), emp: Empfaenger::neu() }
    }

    /// Der Nutzer kopiert. Liefert, was daraufhin hinausgeht.
    fn kopiert(&mut self, text: &str) -> Vec<Rahmen> {
        self.ablage.setzen(text);
        if self.ablage.geaendert() { vec![self.ank.geaendert()] } else { Vec::new() }
    }

    /// Ein Rahmen der Gegenseite. Liefert, was zurueckgeht.
    fn empfaengt(&mut self, r: &Rahmen) -> Vec<Rahmen> {
        match r {
            Rahmen::Neu { .. } => {
                if self.emp.angekuendigt(r) {
                    self.ablage.beanspruchen().expect("Testdoppel scheitert nie");
                }
                Vec::new()
            }
            Rahmen::Hol { .. } => {
                let inhalt = self.ablage.inhalt();
                self.ank.beantworte(r, inhalt.as_deref())
            }
            Rahmen::Stueck { .. } | Rahmen::Leer { .. } => {
                match self.emp.eingang(r) {
                    Fortschritt::Fertig(t) => self.ablage.liefern(&t),
                    Fortschritt::Leer(_) => self.ablage.liefern(""),
                    Fortschritt::Warten => {}
                }
                Vec::new()
            }
        }
    }

    /// Der Nutzer fuegt ein.
    fn fuegt_ein(&mut self, jetzt_ms: u64) -> Vec<Rahmen> {
        self.emp.abrufen(jetzt_ms).into_iter().collect()
    }
}

/// Rahmen so lange hin und her reichen, bis nichts mehr fliesst. Liefert alles,
/// was insgesamt ueber die Leitung ging.
fn austauschen(a: &mut Seite, b: &mut Seite, start: Vec<Rahmen>) -> Vec<Rahmen> {
    let mut alle = Vec::new();
    let mut nach_b = start;
    let mut nach_a: Vec<Rahmen> = Vec::new();
    while !nach_b.is_empty() || !nach_a.is_empty() {
        let mut neu_a = Vec::new();
        for r in &nach_b {
            alle.push(r.clone());
            neu_a.extend(b.empfaengt(r));
        }
        let mut neu_b = Vec::new();
        for r in &nach_a {
            alle.push(r.clone());
            neu_b.extend(a.empfaengt(r));
        }
        nach_b = neu_b;
        nach_a = neu_a;
    }
    alle
}

#[test]
fn beim_kopieren_geht_kein_inhalt_hinaus() {
    let mut a = Seite::neu();
    let mut b = Seite::neu();

    let hinaus = a.kopiert("streng geheim");
    let alle = austauschen(&mut a, &mut b, hinaus);

    assert_eq!(alle.len(), 1, "genau ein Rahmen: die Ankuendigung");
    assert!(matches!(alle[0], Rahmen::Neu { .. }));
    for r in &alle {
        let j = serde_json::to_string(&r.nach_json()).expect("serialisierbar");
        assert!(!j.contains("geheim"), "Inhalt in einem Rahmen gefunden: {j}");
    }
    assert!(b.ablage.beansprucht(), "B haelt jetzt einen Anspruch, aber keine Daten");
    assert_eq!(b.ablage.geliefert(), None, "B hat nichts geliefert bekommen");
}

#[test]
fn erst_das_einfuegen_holt_den_inhalt() {
    let mut a = Seite::neu();
    let mut b = Seite::neu();

    let hinaus = a.kopiert("streng geheim");
    austauschen(&mut a, &mut b, hinaus);

    let hol = b.fuegt_ein(0);
    assert_eq!(hol.len(), 1);
    // Achtung Richtung: der `hol` geht von B nach A, die Antwort zurueck.
    let alle = austauschen(&mut b, &mut a, hol);

    assert!(alle.iter().any(|r| matches!(r, Rahmen::Stueck { .. })), "Inhalt muss geflossen sein");
    assert_eq!(b.ablage.geliefert().as_deref(), Some("streng geheim"));
}

#[test]
fn ein_zwischenzeitliches_kopieren_macht_den_abruf_veraltet() {
    let mut a = Seite::neu();
    let mut b = Seite::neu();

    let hinaus = a.kopiert("alt");
    austauschen(&mut a, &mut b, hinaus);

    // B beginnt den Abruf …
    let hol = b.fuegt_ein(0);
    // … waehrenddessen kopiert A etwas anderes.
    a.kopiert("neu");

    let alle = austauschen(&mut b, &mut a, hol);
    assert!(
        alle.iter().any(|r| matches!(r, Rahmen::Leer { grund: Grund::Veraltet, .. })),
        "der Abruf muss als veraltet abgelehnt werden, nicht mit dem neuen Inhalt beantwortet"
    );
    assert_ne!(b.ablage.geliefert().as_deref(), Some("neu"), "NIE ein anderer als der angekuendigte Inhalt");
}

#[test]
fn langer_text_kommt_vollstaendig_an() {
    let mut a = Seite::neu();
    let mut b = Seite::neu();
    let text = "Zeile mit Umlauten: Größe µ\n".repeat(600);

    let hinaus = a.kopiert(&text);
    austauschen(&mut a, &mut b, hinaus);
    let hol = b.fuegt_ein(0);
    austauschen(&mut b, &mut a, hol);

    assert_eq!(b.ablage.geliefert().as_deref(), Some(text.as_str()));
}
