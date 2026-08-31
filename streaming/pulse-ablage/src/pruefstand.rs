//! Ein Testdoppel beider Traits — eine Zwischenablage im Speicher.
//!
//! Muster und Begruendung wie `pulse-fernsteuerung/src/pruefstand.rs`: der
//! Ablauf soll ohne Betriebssystem fahrbar sein, sonst laesst sich genau das
//! nicht pruefen, worauf es ankommt (dass beim Kopieren nichts hinausgeht).

use crate::beobachter::Beobachter;
use crate::eigentum::Eigentum;

#[derive(Default)]
pub struct TestAblage {
    inhalt: Option<String>,
    /// Zaehlt wie `NSPasteboard.changeCount` — die Nachbildung ist Absicht.
    stand: u64,
    gesehen: u64,
    beansprucht: bool,
    geliefert: Option<String>,
    vorbestand: Option<String>,
}

impl TestAblage {
    pub fn neu() -> TestAblage {
        TestAblage::default()
    }

    /// Der Nutzer kopiert etwas.
    pub fn setzen(&mut self, text: &str) {
        self.inhalt = Some(text.to_string());
        self.stand += 1;
        self.beansprucht = false;
    }

    pub fn inhalt(&self) -> Option<String> {
        self.inhalt.clone()
    }

    pub fn beansprucht(&self) -> bool {
        self.beansprucht
    }

    /// Was ein Einfuegevorgang bekommen haette.
    pub fn geliefert(&self) -> Option<String> {
        self.geliefert.clone()
    }

    /// Der gemerkte Vorbestand, den `freigeben` zurueckschreiben wuerde.
    pub fn vorbestand(&self) -> Option<String> {
        self.vorbestand.clone()
    }
}

impl Beobachter for TestAblage {
    fn geaendert(&mut self) -> bool {
        let neu = self.stand != self.gesehen;
        self.gesehen = self.stand;
        neu
    }

    fn lesen(&self) -> Option<String> {
        self.inhalt.clone()
    }
}

impl Eigentum for TestAblage {
    fn beanspruchen(&mut self) -> Result<(), String> {
        // Genau die Falle, gegen die `freigeben(zurueck)` gebaut ist: der
        // Anspruch loescht den Vorbestand.
        self.vorbestand = self.inhalt.take();
        self.beansprucht = true;
        Ok(())
    }

    fn liefern(&mut self, text: &str) {
        self.geliefert = Some(text.to_string());
    }

    fn freigeben(&mut self, zurueck: Option<&str>) {
        self.beansprucht = false;
        if let Some(t) = zurueck {
            self.inhalt = Some(t.to_string());
        }
    }
}
