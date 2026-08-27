//! Gruppen (Megolm).
//!
//! Megolm ersetzt Olm nicht, es sitzt darauf: die Nachricht wird EINMAL mit
//! dem Gruppenschluessel verschluesselt, und der Gruppenschluessel wird ueber
//! die 1:1-Sitzungen aus `sitzung.rs` an jedes Geraet verteilt. Ohne diesen
//! Aufbau waeren es bei 20 Mitgliedern mit je zwei Geraeten 40 Kopien PRO
//! Nachricht.
//!
//! Megolm hat schwaechere Vorwaertssicherheit als Olm: wer einen
//! Gruppenschluessel erbeutet, liest alles, was damit noch verschluesselt
//! wird. Deshalb wechselt ihn die Anwendungsschicht regelmaessig und bei
//! jeder Aenderung der Mitgliederliste — diese Kiste erzwingt das nicht, sie
//! ermoeglicht es nur.
//!
//! `GroupSession::session_key()` liefert den Schluessel NICHT ab Index 0,
//! sondern ab dem aktuellen Ratchet-Stand (nachgesehen in
//! vodozemac-0.10.0/src/megolm/group_session.rs: `session_key()` baut aus
//! `self.ratchet`, und `encrypt()` ruft `self.ratchet.advance()` NACH dem
//! Verschluesseln). Ein Megolm-Ratchet laesst sich nur vorwaerts rechnen, nie
//! zurueck — ein `Gruppenempfang`, der aus einem spaeteren Verteilschluessel
//! entsteht, kann deshalb keine fruehere Nachricht entschluesseln. Genau das
//! traegt die Zusicherung „wer spaeter dazukommt, liest den Verlauf davor
//! nicht" — ohne einen Umweg ueber `InboundGroupSession::export_at`.

use vodozemac::megolm::{
    GroupSession, GroupSessionPickle, InboundGroupSession, MegolmMessage, SessionConfig,
    SessionKey,
};

use crate::fehler::KryptoFehler;

/// Was beim Entschluesseln herauskommt.
pub struct Gruppennachricht {
    pub klartext: Vec<u8>,
    /// Laufende Nummer innerhalb der Sitzung. Die Anwendungsschicht erkennt
    /// daran ein Wiedereinspielen — dieselbe Nummer zweimal ist ein Angriff
    /// oder ein Fehler, nie normaler Betrieb.
    pub zaehler: u32,
}

/// Die Sendeseite: gehoert dem Absender, einer je Gruppe und Schluesselstand.
pub struct Gruppensitzung {
    session: GroupSession,
}

impl Gruppensitzung {
    pub fn neu() -> Self {
        Self { session: GroupSession::new(SessionConfig::version_1()) }
    }

    /// Der Schluessel, der ueber die 1:1-Sitzungen an die Mitglieder geht.
    /// Nie loggen, nie unverschluesselt uebertragen.
    pub fn verteilschluessel(&self) -> String {
        self.session.session_key().to_base64()
    }

    pub fn verschluesseln(&mut self, klartext: &[u8]) -> String {
        self.session.encrypt(klartext).to_base64()
    }

    pub fn nachrichtenzaehler(&self) -> u32 {
        self.session.message_index()
    }

    pub fn einfrieren(&self, schluessel: &[u8; 32]) -> Result<String, KryptoFehler> {
        Ok(self.session.pickle().encrypt(schluessel))
    }

    pub fn auftauen(gefroren: &str, schluessel: &[u8; 32]) -> Result<Self, KryptoFehler> {
        let pickle = GroupSessionPickle::from_encrypted(gefroren, schluessel)
            .map_err(|_| KryptoFehler::AuftauenFehlgeschlagen)?;
        Ok(Self { session: GroupSession::from_pickle(pickle) })
    }
}

/// Die Empfangsseite: eine je Gruppe und Absender-Schluesselstand.
pub struct Gruppenempfang {
    session: InboundGroupSession,
}

impl Gruppenempfang {
    pub fn aus_verteilschluessel(schluessel: &str) -> Result<Self, KryptoFehler> {
        let key = SessionKey::from_base64(schluessel)
            .map_err(|_| KryptoFehler::SchluesselUnlesbar)?;
        Ok(Self { session: InboundGroupSession::new(&key, SessionConfig::version_1()) })
    }

    pub fn entschluesseln(&mut self, nachricht: &str) -> Result<Gruppennachricht, KryptoFehler> {
        let msg = MegolmMessage::from_base64(nachricht)
            .map_err(|_| KryptoFehler::UmschlagUnlesbar)?;
        let entschluesselt = self
            .session
            .decrypt(&msg)
            .map_err(|_| KryptoFehler::EntschluesselnFehlgeschlagen)?;
        Ok(Gruppennachricht {
            klartext: entschluesselt.plaintext,
            zaehler: entschluesselt.message_index,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wer_den_verteilschluessel_hat_liest_mit() {
        let mut senderin = Gruppensitzung::neu();
        let schluessel = senderin.verteilschluessel();
        let nachricht = senderin.verschluesseln(b"hallo Gruppe");

        let mut empfaenger =
            Gruppenempfang::aus_verteilschluessel(&schluessel).expect("empfang");
        let gelesen = empfaenger.entschluesseln(&nachricht).expect("entschluesseln");
        assert_eq!(gelesen.klartext, b"hallo Gruppe");
        assert_eq!(gelesen.zaehler, 0);
    }

    #[test]
    fn wer_spaeter_dazukommt_liest_das_alte_nicht() {
        // Genau die Zusicherung, auf der die Mitgliedschaftsregel der Spec
        // beruht: ein neues Mitglied bekommt den Schluessel ab SEINEM Stand.
        // Ohne diesen Test faellt ein Rueckschritt hier nicht auf.
        let mut senderin = Gruppensitzung::neu();
        let frueh = senderin.verschluesseln(b"vorher");

        let schluessel_danach = senderin.verteilschluessel();
        let spaet = senderin.verschluesseln(b"nachher");

        let mut neuling =
            Gruppenempfang::aus_verteilschluessel(&schluessel_danach).expect("empfang");
        assert!(neuling.entschluesseln(&frueh).is_err());
        assert_eq!(
            neuling.entschluesseln(&spaet).expect("entschluesseln").klartext,
            b"nachher"
        );
    }

    #[test]
    fn zaehler_steigt_und_erlaubt_wiedereinspiel_erkennung() {
        let mut senderin = Gruppensitzung::neu();
        let schluessel = senderin.verteilschluessel();
        let eins = senderin.verschluesseln(b"eins");
        let zwei = senderin.verschluesseln(b"zwei");

        let mut e = Gruppenempfang::aus_verteilschluessel(&schluessel).expect("empfang");
        assert_eq!(e.entschluesseln(&eins).expect("eins").zaehler, 0);
        assert_eq!(e.entschluesseln(&zwei).expect("zwei").zaehler, 1);
    }

    #[test]
    fn gruppensitzung_ueberlebt_das_einfrieren() {
        let senderin = Gruppensitzung::neu();
        let schluessel = senderin.verteilschluessel();
        let gefroren = senderin.einfrieren(&[3u8; 32]).expect("einfrieren");
        let mut wieder = Gruppensitzung::auftauen(&gefroren, &[3u8; 32]).expect("auftauen");

        let nachricht = wieder.verschluesseln(b"nach dem Neustart");
        let mut e = Gruppenempfang::aus_verteilschluessel(&schluessel).expect("empfang");
        assert_eq!(
            e.entschluesseln(&nachricht).expect("entschluesseln").klartext,
            b"nach dem Neustart"
        );
    }
}
