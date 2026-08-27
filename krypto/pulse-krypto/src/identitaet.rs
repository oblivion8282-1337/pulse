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
    pub fn rueckfallschluessel_erzeugen(&mut self) -> Option<String> {
        self.account.generate_fallback_key().map(|k| k.to_base64())
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
}
