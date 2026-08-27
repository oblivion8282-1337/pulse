//! wasm-bindgen-Huelle. Enthaelt KEINE Logik — nur Uebersetzung zwischen
//! JS-Typen und den Modulen dieser Kiste. Was hier stuende, waere von
//! `cargo test` nicht erreichbar.
//!
//! `Umschlag` wird als eigene wasm-bindgen-Klasse mit zwei Zugriffsmethoden
//! (`art()` als kleine Zahl, `daten()` als Base64-Zeichenkette) ausgefuehrt —
//! einfacher als ein Ruecksprung ueber ein rohes JS-Objekt (`js_sys::Object`),
//! weil wasm-bindgen die Feldzugriffe dann selbst erzeugt.

#![cfg(target_arch = "wasm32")]

use wasm_bindgen::prelude::*;

use crate::{fehler::KryptoFehler, umschlag::Umschlagart};

/// Wandelt einen `KryptoFehler` in einen JS-Fehler — die Meldung bleibt der
/// feste, schluessel- und klartextfreie Text aus `fehler.rs`.
fn js_fehler(fehler: KryptoFehler) -> JsValue {
    JsError::new(&fehler.to_string()).into()
}

/// `&[u8; 32]` kommt nicht ueber die WASM-Grenze — JS reicht ein `Uint8Array`
/// als `Vec<u8>` herein, dessen Laenge hier geprueft wird.
fn schluessel32(schluessel: Vec<u8>) -> Result<[u8; 32], JsValue> {
    schluessel.try_into().map_err(|_| js_fehler(KryptoFehler::SchluesselUnlesbar))
}

#[wasm_bindgen(js_name = Umschlag)]
pub struct JsUmschlag {
    inner: crate::Umschlag,
}

#[wasm_bindgen(js_class = Umschlag)]
impl JsUmschlag {
    /// `art`: 0 = Sitzungsaufbau, alles andere = laufende Nachricht.
    #[wasm_bindgen(constructor)]
    pub fn new(art: u8, daten: String) -> Self {
        let art = if art == 0 { Umschlagart::Sitzungsaufbau } else { Umschlagart::Laufend };
        Self { inner: crate::Umschlag { art, daten } }
    }

    pub fn art(&self) -> u8 {
        match self.inner.art {
            Umschlagart::Sitzungsaufbau => 0,
            Umschlagart::Laufend => 1,
        }
    }

    pub fn daten(&self) -> String {
        self.inner.daten.clone()
    }
}

impl From<crate::Umschlag> for JsUmschlag {
    fn from(inner: crate::Umschlag) -> Self {
        Self { inner }
    }
}

#[wasm_bindgen(js_name = Identitaet)]
pub struct JsIdentitaet {
    inner: crate::Identitaet,
}

#[wasm_bindgen(js_class = Identitaet)]
impl JsIdentitaet {
    #[wasm_bindgen(constructor)]
    pub fn neu() -> Self {
        Self { inner: crate::Identitaet::neu() }
    }

    pub fn curve25519(&self) -> String {
        self.inner.schluessel().curve25519
    }

    pub fn ed25519(&self) -> String {
        self.inner.schluessel().ed25519
    }

    #[wasm_bindgen(js_name = einmalschluesselErzeugen)]
    pub fn einmalschluessel_erzeugen(&mut self, anzahl: usize) -> Vec<String> {
        self.inner.einmalschluessel_erzeugen(anzahl)
    }

    #[wasm_bindgen(js_name = offeneEinmalschluessel)]
    pub fn offene_einmalschluessel(&self) -> Vec<String> {
        self.inner.offene_einmalschluessel()
    }

    #[wasm_bindgen(js_name = alsVeroeffentlichtMarkieren)]
    pub fn als_veroeffentlicht_markieren(&mut self) {
        self.inner.als_veroeffentlicht_markieren();
    }

    #[wasm_bindgen(js_name = rueckfallschluesselErzeugen)]
    pub fn rueckfallschluessel_erzeugen(&mut self) -> Option<String> {
        self.inner.rueckfallschluessel_erzeugen()
    }

    pub fn einfrieren(&self, schluessel: Vec<u8>) -> Result<String, JsValue> {
        self.inner.einfrieren(&schluessel32(schluessel)?).map_err(js_fehler)
    }

    pub fn auftauen(gefroren: &str, schluessel: Vec<u8>) -> Result<JsIdentitaet, JsValue> {
        let inner = crate::Identitaet::auftauen(gefroren, &schluessel32(schluessel)?)
            .map_err(js_fehler)?;
        Ok(Self { inner })
    }

    #[wasm_bindgen(js_name = sitzungAusgehend)]
    pub fn sitzung_ausgehend(
        &self,
        gegenstelle_curve25519: &str,
        einmalschluessel: &str,
    ) -> Result<JsSitzung, JsValue> {
        let inner = self
            .inner
            .sitzung_ausgehend(gegenstelle_curve25519, einmalschluessel)
            .map_err(js_fehler)?;
        Ok(JsSitzung { inner })
    }

    #[wasm_bindgen(js_name = sitzungEingehend)]
    pub fn sitzung_eingehend(
        &mut self,
        absender_curve25519: &str,
        umschlag: &JsUmschlag,
    ) -> Result<JsSitzungEingehendErgebnis, JsValue> {
        let (sitzung, klartext) = self
            .inner
            .sitzung_eingehend(absender_curve25519, &umschlag.inner)
            .map_err(js_fehler)?;
        Ok(JsSitzungEingehendErgebnis { sitzung: Some(sitzung), klartext })
    }
}

/// Ergebnis von `sitzungEingehend`: die neue Sitzung UND der Klartext der
/// ersten Nachricht, die im Sitzungsaufbau bereits steckte. wasm-bindgen kann
/// kein Tupel ueber die Grenze reichen, deshalb dieser kleine Traeger.
#[wasm_bindgen(js_name = SitzungEingehendErgebnis)]
pub struct JsSitzungEingehendErgebnis {
    sitzung: Option<crate::Sitzung>,
    klartext: Vec<u8>,
}

#[wasm_bindgen(js_class = SitzungEingehendErgebnis)]
impl JsSitzungEingehendErgebnis {
    /// Entnimmt die Sitzung. Nur einmal aufrufbar — danach ist sie hier leer.
    pub fn sitzung(&mut self) -> JsSitzung {
        JsSitzung { inner: self.sitzung.take().expect("sitzung schon entnommen") }
    }

    pub fn klartext(&self) -> Vec<u8> {
        self.klartext.clone()
    }
}

#[wasm_bindgen(js_name = Sitzung)]
pub struct JsSitzung {
    inner: crate::Sitzung,
}

#[wasm_bindgen(js_class = Sitzung)]
impl JsSitzung {
    pub fn kennung(&self) -> String {
        self.inner.kennung()
    }

    pub fn verschluesseln(&mut self, klartext: Vec<u8>) -> Result<JsUmschlag, JsValue> {
        self.inner.verschluesseln(&klartext).map(JsUmschlag::from).map_err(js_fehler)
    }

    pub fn entschluesseln(&mut self, umschlag: &JsUmschlag) -> Result<Vec<u8>, JsValue> {
        self.inner.entschluesseln(&umschlag.inner).map_err(js_fehler)
    }

    pub fn einfrieren(&self, schluessel: Vec<u8>) -> Result<String, JsValue> {
        self.inner.einfrieren(&schluessel32(schluessel)?).map_err(js_fehler)
    }

    pub fn auftauen(gefroren: &str, schluessel: Vec<u8>) -> Result<JsSitzung, JsValue> {
        let inner =
            crate::Sitzung::auftauen(gefroren, &schluessel32(schluessel)?).map_err(js_fehler)?;
        Ok(Self { inner })
    }
}

#[wasm_bindgen(js_name = Gruppensitzung)]
pub struct JsGruppensitzung {
    inner: crate::Gruppensitzung,
}

#[wasm_bindgen(js_class = Gruppensitzung)]
impl JsGruppensitzung {
    #[wasm_bindgen(constructor)]
    pub fn neu() -> Self {
        Self { inner: crate::Gruppensitzung::neu() }
    }

    pub fn verteilschluessel(&self) -> String {
        self.inner.verteilschluessel()
    }

    pub fn verschluesseln(&mut self, klartext: Vec<u8>) -> String {
        self.inner.verschluesseln(&klartext)
    }

    #[wasm_bindgen(js_name = nachrichtenzaehler)]
    pub fn nachrichtenzaehler(&self) -> u32 {
        self.inner.nachrichtenzaehler()
    }

    pub fn einfrieren(&self, schluessel: Vec<u8>) -> Result<String, JsValue> {
        self.inner.einfrieren(&schluessel32(schluessel)?).map_err(js_fehler)
    }

    pub fn auftauen(gefroren: &str, schluessel: Vec<u8>) -> Result<JsGruppensitzung, JsValue> {
        let inner = crate::Gruppensitzung::auftauen(gefroren, &schluessel32(schluessel)?)
            .map_err(js_fehler)?;
        Ok(Self { inner })
    }
}

#[wasm_bindgen(js_name = Gruppennachricht)]
pub struct JsGruppennachricht {
    inner: crate::Gruppennachricht,
}

#[wasm_bindgen(js_class = Gruppennachricht)]
impl JsGruppennachricht {
    pub fn klartext(&self) -> Vec<u8> {
        self.inner.klartext.clone()
    }

    pub fn zaehler(&self) -> u32 {
        self.inner.zaehler
    }
}

#[wasm_bindgen(js_name = Gruppenempfang)]
pub struct JsGruppenempfang {
    inner: crate::Gruppenempfang,
}

#[wasm_bindgen(js_class = Gruppenempfang)]
impl JsGruppenempfang {
    #[wasm_bindgen(js_name = ausVerteilschluessel)]
    pub fn aus_verteilschluessel(schluessel: &str) -> Result<JsGruppenempfang, JsValue> {
        let inner = crate::Gruppenempfang::aus_verteilschluessel(schluessel).map_err(js_fehler)?;
        Ok(Self { inner })
    }

    pub fn entschluesseln(&mut self, nachricht: &str) -> Result<JsGruppennachricht, JsValue> {
        let inner = self.inner.entschluesseln(nachricht).map_err(js_fehler)?;
        Ok(JsGruppennachricht { inner })
    }
}
