//! Der Umschlag ist die einzige Form, in der Verschluesseltes diese Kiste
//! verlaesst. Er traegt bewusst KEINE Empfaengerangabe und keine Kanal-ID —
//! wer wohin gehoert, entscheidet Pulse, nicht die Krypto.

use crate::fehler::KryptoFehler;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Umschlagart {
    /// Baut die Sitzung erst auf (Olm-PreKey). Der Empfaenger hat noch keine.
    Sitzungsaufbau,
    /// Laufende Nachricht in einer bestehenden Sitzung.
    Laufend,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Umschlag {
    pub art: Umschlagart,
    /// Base64. Nie loggen.
    pub daten: String,
}

impl Umschlagart {
    /// vodozemac zaehlt die Arten als `usize`: 0 = PreKey, alles andere normal.
    pub(crate) fn aus_zahl(zahl: usize) -> Self {
        if zahl == 0 { Self::Sitzungsaufbau } else { Self::Laufend }
    }

    pub(crate) fn als_zahl(self) -> usize {
        match self {
            Self::Sitzungsaufbau => 0,
            Self::Laufend => 1,
        }
    }
}

impl Umschlag {
    pub(crate) fn aus_olm(nachricht: &vodozemac::olm::OlmMessage) -> Self {
        let (art, bytes) = nachricht.to_parts();
        Self { art: Umschlagart::aus_zahl(art), daten: vodozemac::base64_encode(&bytes) }
    }

    pub(crate) fn zu_olm(&self) -> Result<vodozemac::olm::OlmMessage, KryptoFehler> {
        let bytes =
            vodozemac::base64_decode(&self.daten).map_err(|_| KryptoFehler::UmschlagUnlesbar)?;
        vodozemac::olm::OlmMessage::from_parts(self.art.als_zahl(), &bytes)
            .map_err(|_| KryptoFehler::UmschlagUnlesbar)
    }
}
