//! Ein Gespraech zu zweit (Olm, Double Ratchet).

use vodozemac::olm::{OlmMessage, Session, SessionPickle};

use crate::{fehler::KryptoFehler, umschlag::Umschlag};

pub struct Sitzung {
    pub(crate) session: Session,
}

impl Sitzung {
    /// Kennung des Gespraechs — stabil auf beiden Seiten, damit der Klient
    /// eine eingehende Nachricht der richtigen Sitzung zuordnen kann.
    pub fn kennung(&self) -> String {
        self.session.session_id()
    }

    pub fn verschluesseln(&mut self, klartext: &[u8]) -> Result<Umschlag, KryptoFehler> {
        // vodozemacs `encrypt` hat zwar eine `Result`-Signatur, das
        // Fehlschlagen kommt aber nur ueber Aufrufer zustande, die
        // `AsRef<[u8]>` selbst kaputt implementieren — bei `&[u8]` nie.
        let nachricht: OlmMessage = self
            .session
            .encrypt(klartext)
            .map_err(|_: vodozemac::olm::EncryptionError| KryptoFehler::VerschluesselnFehlgeschlagen)?;
        Ok(Umschlag::aus_olm(&nachricht))
    }

    pub fn entschluesseln(&mut self, umschlag: &Umschlag) -> Result<Vec<u8>, KryptoFehler> {
        let nachricht: OlmMessage = umschlag.zu_olm()?;
        self.session.decrypt(&nachricht).map_err(|_| KryptoFehler::EntschluesselnFehlgeschlagen)
    }

    pub fn einfrieren(&self, schluessel: &[u8; 32]) -> Result<String, KryptoFehler> {
        Ok(self.session.pickle().encrypt(schluessel))
    }

    pub fn auftauen(gefroren: &str, schluessel: &[u8; 32]) -> Result<Self, KryptoFehler> {
        let pickle = SessionPickle::from_encrypted(gefroren, schluessel)
            .map_err(|_| KryptoFehler::AuftauenFehlgeschlagen)?;
        Ok(Self { session: Session::from_pickle(pickle) })
    }
}

#[cfg(test)]
mod tests {
    use crate::{Identitaet, Sitzung, Umschlag, Umschlagart};

    /// Baut ein Paar auf, wie es im Betrieb entsteht: Bob veroeffentlicht
    /// seine Schluessel, Alice holt sie und schreibt zuerst.
    fn paar() -> (Identitaet, Identitaet, Sitzung, Umschlag) {
        let alice = Identitaet::neu();
        let mut bob = Identitaet::neu();
        let einmal = bob.einmalschluessel_erzeugen(1).remove(0);
        bob.als_veroeffentlicht_markieren();

        let mut sitzung = alice
            .sitzung_ausgehend(&bob.schluessel().curve25519, &einmal)
            .expect("ausgehende Sitzung");
        let erster = sitzung.verschluesseln(b"hallo").expect("verschluesseln");
        (alice, bob, sitzung, erster)
    }

    #[test]
    fn erste_nachricht_ist_ein_sitzungsaufbau() {
        let (_, _, _, erster) = paar();
        assert_eq!(erster.art, Umschlagart::Sitzungsaufbau);
    }

    #[test]
    fn hin_und_zurueck() {
        let (alice, mut bob, mut alice_sitzung, erster) = paar();

        let (mut bob_sitzung, klartext) = bob
            .sitzung_eingehend(&alice.schluessel().curve25519, &erster)
            .expect("eingehende Sitzung");
        assert_eq!(klartext, b"hallo");

        // Rueckweg — und ab jetzt sind es laufende Nachrichten.
        let antwort = bob_sitzung.verschluesseln(b"auch hallo").expect("antwort");
        assert_eq!(antwort.art, Umschlagart::Laufend);
        assert_eq!(
            alice_sitzung.entschluesseln(&antwort).expect("entschluesseln"),
            b"auch hallo"
        );
    }

    #[test]
    fn eingehender_sitzungsaufbau_mit_falschem_absenderschluessel_schlaegt_fehl() {
        // Name korrigiert (Bughunt 2026-08-28): geprueft wird der Sitzungs-
        // AUFBAU, nicht das Entschluesseln mit einer fremden Sitzung — der
        // alte Name behauptete Letzteres. `sitzung_eingehend` prueft den
        // mitgegebenen Absenderschluessel gegen den, der im Sitzungsaufbau
        // (PreKey) selbst steckt (X3DH); ein falscher Absenderschluessel
        // laesst schon DIESEN Schritt scheitern, es entsteht gar keine
        // Sitzung, an der man ueberhaupt entschluesseln koennte.
        let (_, _, _, erster) = paar();
        let mut fremd = Identitaet::neu();
        let alice2 = Identitaet::neu();
        assert!(fremd.sitzung_eingehend(&alice2.schluessel().curve25519, &erster).is_err());
    }

    #[test]
    fn manipulierter_geheimtext_wird_abgelehnt() {
        // Olm-Nachrichten tragen ein MAC — ein gekipptes Bit muss beim
        // Entschluesseln auffliegen, nicht stillschweigend falschen
        // Klartext liefern. Per Sonde nachgewiesen (Bughunt 2026-08-28),
        // aber bislang ohne Test — ein vodozemac-Versionswechsel koennte
        // das lautlos verschweigen.
        let (alice, mut bob, mut alice_sitzung, erster) = paar();
        let (mut bob_sitzung, _) = bob
            .sitzung_eingehend(&alice.schluessel().curve25519, &erster)
            .expect("eingehende Sitzung");

        let mut manipuliert =
            alice_sitzung.verschluesseln(b"unversehrt").expect("verschluesseln");
        let mut bytes = vodozemac::base64_decode(&manipuliert.daten).expect("base64");
        let letztes_byte = bytes.len() - 1;
        bytes[letztes_byte] ^= 0xFF;
        manipuliert.daten = vodozemac::base64_encode(&bytes);

        assert!(bob_sitzung.entschluesseln(&manipuliert).is_err());
    }

    #[test]
    fn wiedereingespielte_nachricht_wird_abgelehnt() {
        // Dieselbe laufende Nachricht ein zweites Mal vorgelegt darf nicht
        // wieder denselben Klartext liefern — der Ratchet ist nach dem
        // ersten Entschluesseln bereits weitergedreht. Per Sonde
        // nachgewiesen (Bughunt 2026-08-28), aber bislang ohne Test.
        let (alice, mut bob, mut alice_sitzung, erster) = paar();
        let (mut bob_sitzung, _) = bob
            .sitzung_eingehend(&alice.schluessel().curve25519, &erster)
            .expect("eingehende Sitzung");

        let nachricht =
            alice_sitzung.verschluesseln(b"nur einmal gueltig").expect("verschluesseln");
        assert_eq!(
            bob_sitzung.entschluesseln(&nachricht).expect("erstes Mal"),
            b"nur einmal gueltig"
        );
        assert!(
            bob_sitzung.entschluesseln(&nachricht).is_err(),
            "ein Wiedereinspielen haette abgelehnt werden muessen"
        );
    }

    #[test]
    fn sitzung_ueberlebt_das_einfrieren() {
        let (alice, mut bob, mut alice_sitzung, erster) = paar();
        let (bob_sitzung, _) = bob
            .sitzung_eingehend(&alice.schluessel().curve25519, &erster)
            .expect("eingehende Sitzung");

        let gefroren = bob_sitzung.einfrieren(&[9u8; 32]).expect("einfrieren");
        let mut wieder = Sitzung::auftauen(&gefroren, &[9u8; 32]).expect("auftauen");

        let zweiter = alice_sitzung.verschluesseln(b"danach").expect("verschluesseln");
        assert_eq!(wieder.entschluesseln(&zweiter).expect("entschluesseln"), b"danach");
    }
}
