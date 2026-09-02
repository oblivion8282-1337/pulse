//! Die Identitaet eines Geraets: ein vodozemac-Account plus Einmalschluessel.
//!
//! An der Grenze gibt es nur Base64-Zeichenketten — dieselbe Grenze ueberquert
//! spaeter JavaScript ueber WASM und Kotlin ueber JNI.

use vodozemac::olm::Account;

use crate::fehler::KryptoFehler;

/// Die oeffentlichen Schluessel eines Geraets, beide Base64.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identitaetsschluessel {
    /// Zum Schluesselaustausch (Curve25519 alias X25519).
    pub curve25519: String,
    /// Zum Signieren.
    pub ed25519: String,
}

pub struct Identitaet {
    pub(crate) account: Account,
}

impl Identitaet {
    pub fn neu() -> Self {
        Self { account: Account::new() }
    }

    pub fn schluessel(&self) -> Identitaetsschluessel {
        let k = self.account.identity_keys();
        Identitaetsschluessel {
            curve25519: k.curve25519.to_base64(),
            ed25519: k.ed25519.to_base64(),
        }
    }

    /// Erzeugt `anzahl` neue Einmalschluessel und gibt die neuen zurueck.
    pub fn einmalschluessel_erzeugen(&mut self, anzahl: usize) -> Vec<String> {
        self.account
            .generate_one_time_keys(anzahl)
            .created
            .iter()
            .map(|k| k.to_base64())
            .collect()
    }

    /// Alle noch nicht veroeffentlichten Einmalschluessel.
    pub fn offene_einmalschluessel(&self) -> Vec<String> {
        self.account.one_time_keys().values().map(|k| k.to_base64()).collect()
    }

    /// Nach dem erfolgreichen Hochladen aufrufen — sonst bietet das Geraet
    /// denselben Schluessel erneut an und zwei Absender benutzen ihn.
    pub fn als_veroeffentlicht_markieren(&mut self) {
        self.account.mark_keys_as_published();
    }

    /// Der Rueckfallschluessel greift, wenn der Vorrat an Einmalschluesseln
    /// leer ist — sonst koennte niemand mehr an ein laenger ausgeschaltetes
    /// Geraet schreiben.
    ///
    /// **Falle, gegen die diese Funktion bewusst gebaut ist:** vodozemacs
    /// `Account::generate_fallback_key()` gibt den Rueckgabewert des
    /// *vorherigen* Rueckfallschluessels zurueck (nur fuer Logging gedacht),
    /// nicht den gerade neu erzeugten — der ist ausschliesslich ueber
    /// `Account::fallback_key()` erreichbar, solange er nicht als
    /// veroeffentlicht markiert wurde. Ein direktes Durchreichen von
    /// `generate_fallback_key()`s Rueckgabewert wuerde also entweder den alten
    /// Schluessel liefern oder (beim allerersten Aufruf, wenn es noch keinen
    /// vorherigen gibt) `None` — in beiden Faellen den falschen bzw. gar
    /// keinen Schluessel zum Veroeffentlichen.
    pub fn rueckfallschluessel_erzeugen(&mut self) -> Option<String> {
        self.account.generate_fallback_key();
        self.account.fallback_key().into_values().next().map(|k| k.to_base64())
    }

    // `einfrieren` gibt hier `Result` zurueck, obwohl `encrypt` nicht
    // fehlschlagen kann. Das ist Absicht — die Signatur soll sich nicht
    // aendern muessen, wenn spaeter ein fehlbarer Schritt dazukommt.
    pub fn einfrieren(&self, schluessel: &[u8; 32]) -> Result<String, KryptoFehler> {
        Ok(self.account.pickle().encrypt(schluessel))
    }

    pub fn auftauen(gefroren: &str, schluessel: &[u8; 32]) -> Result<Self, KryptoFehler> {
        let pickle = vodozemac::olm::AccountPickle::from_encrypted(gefroren, schluessel)
            .map_err(|_| KryptoFehler::AuftauenFehlgeschlagen)?;
        Ok(Self { account: Account::from_pickle(pickle) })
    }

    /// Baut die Sitzung auf, wenn WIR zuerst schreiben. Braucht die
    /// veroeffentlichten Schluessel der Gegenstelle.
    pub fn sitzung_ausgehend(
        &self,
        gegenstelle_curve25519: &str,
        einmalschluessel: &str,
    ) -> Result<crate::sitzung::Sitzung, KryptoFehler> {
        use vodozemac::Curve25519PublicKey;
        let gegenstelle = Curve25519PublicKey::from_base64(gegenstelle_curve25519)
            .map_err(|_| KryptoFehler::SchluesselUnlesbar)?;
        let einmal = Curve25519PublicKey::from_base64(einmalschluessel)
            .map_err(|_| KryptoFehler::SchluesselUnlesbar)?;
        let session = self
            .account
            .create_outbound_session(vodozemac::olm::SessionConfig::version_2(), gegenstelle, einmal)
            .map_err(|_| KryptoFehler::SitzungsaufbauFehlgeschlagen)?;
        Ok(crate::sitzung::Sitzung { session })
    }

    /// Baut die Sitzung auf, wenn die GEGENSTELLE zuerst geschrieben hat.
    /// Gibt die Sitzung und den Klartext der ersten Nachricht zurueck — der
    /// steckt bereits im Sitzungsaufbau und ginge sonst verloren.
    pub fn sitzung_eingehend(
        &mut self,
        absender_curve25519: &str,
        umschlag: &crate::umschlag::Umschlag,
    ) -> Result<(crate::sitzung::Sitzung, Vec<u8>), KryptoFehler> {
        use vodozemac::Curve25519PublicKey;
        use vodozemac::olm::OlmMessage;

        let absender = Curve25519PublicKey::from_base64(absender_curve25519)
            .map_err(|_| KryptoFehler::SchluesselUnlesbar)?;
        let OlmMessage::PreKey(vorschluessel) = umschlag.zu_olm()? else {
            return Err(KryptoFehler::FalscheUmschlagart);
        };
        let ergebnis = self
            .account
            .create_inbound_session(
                vodozemac::olm::SessionConfig::version_2(),
                absender,
                &vorschluessel,
            )
            .map_err(|_| KryptoFehler::SitzungsaufbauFehlgeschlagen)?;
        Ok((crate::sitzung::Sitzung { session: ergebnis.session }, ergebnis.plaintext))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn einmalschluessel_ueberleben_das_einfrieren() {
        // Der Sitzungszustand muss einen App-Neustart ueberstehen. Wird er
        // falsch eingefroren, faellt das erst auf, wenn ein Nutzer die App
        // schliesst — also nie in einem fluechtigen Test.
        let schluessel = [7u8; 32];
        let mut ich = Identitaet::neu();
        let erzeugt = ich.einmalschluessel_erzeugen(5);
        assert_eq!(erzeugt.len(), 5);

        let gefroren = ich.einfrieren(&schluessel).expect("einfrieren");
        let wieder = Identitaet::auftauen(&gefroren, &schluessel).expect("auftauen");

        assert_eq!(wieder.schluessel().curve25519, ich.schluessel().curve25519);
        let mut a = ich.offene_einmalschluessel();
        let mut b = wieder.offene_einmalschluessel();
        a.sort();
        b.sort();
        assert_eq!(a, b);
    }

    #[test]
    fn falscher_schluessel_taut_nicht_auf() {
        let gefroren = Identitaet::neu().einfrieren(&[1u8; 32]).expect("einfrieren");
        assert!(Identitaet::auftauen(&gefroren, &[2u8; 32]).is_err());
    }

    #[test]
    fn veroeffentlichen_leert_die_offene_liste() {
        // Nach dem Hochladen darf derselbe Einmalschluessel nicht ein zweites
        // Mal angeboten werden — sonst benutzen ihn zwei Absender.
        let mut ich = Identitaet::neu();
        ich.einmalschluessel_erzeugen(3);
        assert_eq!(ich.offene_einmalschluessel().len(), 3);
        ich.als_veroeffentlicht_markieren();
        assert!(ich.offene_einmalschluessel().is_empty());
    }

    #[test]
    fn rueckfallschluessel_erzeugen_liefert_den_neuen_nicht_den_alten() {
        // Regressionstest fuer die Falle im Doc-Kommentar oben: ein naives
        // `generate_fallback_key().map(...)` haette hier `None` geliefert
        // (kein vorheriger Rueckfallschluessel existiert beim ersten Aufruf).
        let mut ich = Identitaet::neu();
        let erster = ich.rueckfallschluessel_erzeugen();
        assert!(erster.is_some(), "erster Aufruf muss einen Schluessel liefern, nicht None");

        // Ein zweiter Aufruf erzeugt einen ANDEREN Schluessel (echte Rotation,
        // kein zufaelliger Treffer auf denselben Wert).
        let zweiter = ich.rueckfallschluessel_erzeugen();
        assert!(zweiter.is_some());
        assert_ne!(erster, zweiter);
    }

    #[test]
    fn rueckfallschluessel_ueberlebt_das_einfrieren() {
        // Derselbe Grund wie bei den Einmalschluesseln: ohne korrektes
        // Pickle-Roundtrip waere der Rueckfallschluessel nach einem
        // Neustart weg, ohne dass es irgendwo auffiele.
        let schluessel = [9u8; 32];
        let mut ich = Identitaet::neu();
        let erzeugt = ich.rueckfallschluessel_erzeugen().expect("rueckfallschluessel");

        let gefroren = ich.einfrieren(&schluessel).expect("einfrieren");
        let wieder = Identitaet::auftauen(&gefroren, &schluessel).expect("auftauen");

        assert_eq!(wieder.schluessel().curve25519, ich.schluessel().curve25519);
        // `fallback_key()` liefert den Schluessel nur, solange er nicht als
        // veroeffentlicht markiert ist — direkt nach dem Auftauen gilt das noch.
        let wieder_key =
            wieder.account.fallback_key().into_values().next().map(|k| k.to_base64());
        assert_eq!(wieder_key, Some(erzeugt));
    }
}
