//! Was der Bildschirm über sich sagt, auf dem aufgenommen wird: läuft er in
//! HDR, und mit welchen Leuchtdichten.
//!
//! **Zwei Fragen, eine Quelle.** Windows beantwortet beide über denselben
//! DXGI-Ausgang (`IDXGIOutput6::GetDesc1`), und sie gehören zusammen: ob HDR
//! an ist, entscheidet, ob wir überhaupt starten dürfen; die Leuchtdichten
//! werden als HDR10-Metadaten in den Strom geschrieben, damit der Zuschauer
//! weiß, für welchen Schirm das Bild gemacht wurde.
//!
//! **Warum am Ausgang und nicht am Adapter.** HDR ist eine Eigenschaft des
//! Bildschirms, nicht der Grafikkarte — an einem Rechner mit zwei Schirmen kann
//! einer in HDR laufen und der andere nicht. Wer den Adapter fragt, bekommt
//! deshalb für den falschen Schirm eine richtige Antwort. Die Zuordnung läuft
//! über das `HMONITOR`, das auch die Aufnahme benutzt (`capture::source`) — das
//! ist der einzige Bezeichner, den beide Seiten kennen.
//!
//! **Die Werte sind Angaben des Schirms, keine Messung.** `MaxLuminance` ist
//! das, was das Anzeigegerät über EDID meldet; viele Geräte übertreiben dabei.
//! Für die Metadaten ist das trotzdem die richtige Quelle: HDR10 will wissen,
//! auf welchem Mastering-Gerät das Bild entstanden ist, und das IST hier dieser
//! Schirm. Wir geben also weiter, was gilt, nicht was schön wäre.

use anyhow::{Context, Result};
use std::ffi::c_void;

use windows::Win32::Graphics::Dxgi::Common::DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ERROR_NOT_FOUND, DXGI_OUTPUT_DESC1, IDXGIAdapter1, IDXGIFactory1,
    IDXGIOutput6,
};
use windows::core::Interface;

/// Was der Bildschirm über seine Farbwiedergabe meldet.
///
/// Alle Leuchtdichten in cd/m² (Nits), so wie DXGI sie liefert — die Umrechnung
/// in die Einheiten der HDR10-Metadaten (Vielfache von 0,0001 cd/m²) passiert
/// erst dort, wo die Metadaten gebaut werden. Hier stehen die rohen Angaben,
/// damit man sie im Log gegen das lesen kann, was das Datenblatt des Geräts
/// sagt.
#[derive(Debug, Clone, Copy)]
pub struct SchirmFarbe {
    /// Läuft der Schirm gerade in HDR? Das ist die Frage, an der der Start
    /// hängt — nicht „kann er HDR", sondern „ist es eingeschaltet".
    pub hdr_aktiv: bool,
    /// Bit je Farbkanal, wie der Ausgang sie meldet (8 im SDR-Regelfall, 10
    /// oder 12 in HDR). Nur zur Diagnose: die Aufnahme entscheidet sich am
    /// Farbraum, nicht hieran.
    pub bits_je_kanal: u32,
    /// Höchste Leuchtdichte des Geräts (cd/m²).
    pub max_nits: f32,
    /// Höchste Leuchtdichte über die volle Fläche (cd/m²). Bei Geräten mit
    /// örtlicher Abdunklung deutlich niedriger als `max_nits` — ein kleiner
    /// heller Fleck geht, ein weißes Vollbild nicht.
    pub max_vollbild_nits: f32,
    /// Niedrigste Leuchtdichte des Geräts (cd/m²).
    pub min_nits: f32,
    /// Primärvalenzen und Weißpunkt in CIE-xy, Reihenfolge Rot, Grün, Blau.
    pub primaervalenzen: [[f32; 2]; 3],
    pub weisspunkt: [f32; 2],
}

impl SchirmFarbe {
    /// Eine Zeile fürs Log. Bewusst mit den Rohwerten: wer später eine
    /// Metadaten-Zahl im Strom nachprüft, muss sie hier wiederfinden können.
    pub fn beschreibung(&self) -> String {
        format!(
            "HDR {}, {} bit/Kanal, {:.0} cd/m² Spitze ({:.0} über die volle Fläche), \
             {:.4} cd/m² Schwarz, Weißpunkt ({:.4}, {:.4})",
            if self.hdr_aktiv { "an" } else { "aus" },
            self.bits_je_kanal,
            self.max_nits,
            self.max_vollbild_nits,
            self.min_nits,
            self.weisspunkt[0],
            self.weisspunkt[1],
        )
    }
}

impl From<&DXGI_OUTPUT_DESC1> for SchirmFarbe {
    fn from(d: &DXGI_OUTPUT_DESC1) -> Self {
        Self {
            // **Genau EIN Farbraum zählt als HDR**, und das ist Absicht.
            // Windows schaltet den Ausgang bei aktivem HDR auf PQ mit
            // BT.2020-Primärvalenzen; alles andere (auch die weiten
            // SDR-Farbräume wie Display-P3) ist für uns SDR, weil die Aufnahme
            // dann keine PQ-Werte liefert. Eine großzügigere Prüfung hier
            // hieße, einen SDR-Desktop als HDR zu senden.
            hdr_aktiv: d.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020,
            bits_je_kanal: d.BitsPerColor,
            max_nits: d.MaxLuminance,
            max_vollbild_nits: d.MaxFullFrameLuminance,
            min_nits: d.MinLuminance,
            primaervalenzen: [d.RedPrimary, d.GreenPrimary, d.BluePrimary],
            weisspunkt: d.WhitePoint,
        }
    }
}

/// Den DXGI-Ausgang zu einem `HMONITOR` suchen und auslesen.
///
/// `None`, wenn kein Ausgang dieses Monitor-Handle führt — das passiert bei
/// virtuellen Anzeigen (Fernwartung, manche Aufnahme-Treiber) und bei
/// Sitzungen ohne echten Schirm. **Das ist kein Fehler**, sondern eine Lage, in
/// der wir nichts über den Schirm wissen; der Aufrufer behandelt sie wie „kein
/// HDR", muss das aber unterscheiden können, um es sagen zu können.
///
/// Läuft über ALLE Adapter, nicht nur den ersten: auf Notebooks mit zwei GPUs
/// hängen die Schirme oft am integrierten Chip, während die
/// `HIGH_PERFORMANCE`-Reihenfolge die dedizierte Karte nach vorn stellt.
pub fn schirm_farbe(hmonitor: *mut c_void) -> Result<Option<SchirmFarbe>> {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.context("CreateDXGIFactory1")?;
    let mut adapter_idx = 0u32;
    loop {
        let adapter: IDXGIAdapter1 = match unsafe { factory.EnumAdapters1(adapter_idx) } {
            Ok(a) => a,
            Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => return Ok(None),
            Err(e) => return Err(anyhow::anyhow!("EnumAdapters1({adapter_idx}): {e}")),
        };
        adapter_idx += 1;

        let mut output_idx = 0u32;
        loop {
            let output = match unsafe { adapter.EnumOutputs(output_idx) } {
                Ok(o) => o,
                // Ausgänge dieses Adapters durch — zum nächsten Adapter.
                Err(_) => break,
            };
            output_idx += 1;

            // `IDXGIOutput6` gibt es seit Windows 10 1703; ohne das Interface
            // gibt es auf diesem System auch kein HDR, der Ausgang ist dann
            // schlicht nicht der gesuchte Fall.
            let Ok(output6) = output.cast::<IDXGIOutput6>() else { continue };
            let Ok(desc) = (unsafe { output6.GetDesc1() }) else { continue };
            if desc.Monitor.0 == hmonitor {
                return Ok(Some(SchirmFarbe::from(&desc)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ein Ausgang ist genau dann HDR, wenn er auf PQ/BT.2020 steht. Der Test
    /// hält die Regel an einem gebauten Deskriptor fest, ohne einen echten
    /// Schirm zu brauchen — sonst wäre sie nur auf einer Maschine prüfbar, die
    /// gerade zufällig richtig eingestellt ist.
    #[test]
    fn nur_pq_bt2020_zaehlt_als_hdr() {
        use windows::Win32::Graphics::Dxgi::Common::{
            DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709,
        };
        let mut desc = DXGI_OUTPUT_DESC1::default();

        desc.ColorSpace = DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709; // gewöhnliches SDR
        assert!(!SchirmFarbe::from(&desc).hdr_aktiv);

        // scRGB ist linear und weit, aber NICHT das, was ein HDR-Desktop
        // ausgibt — als HDR zu zählen hieße hier, ohne PQ-Werte loszustreamen.
        desc.ColorSpace = DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709;
        assert!(!SchirmFarbe::from(&desc).hdr_aktiv);

        desc.ColorSpace = DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
        assert!(SchirmFarbe::from(&desc).hdr_aktiv);
    }

    /// **Diagnose, kein Test** — fragt den echten primären Bildschirm ab und
    /// druckt, was er meldet. Deshalb `ignore`: das Ergebnis hängt an der
    /// Maschine und an einer Windows-Einstellung, ein Sollwert wäre hier
    /// sinnlos.
    ///
    /// Aufruf: `cargo test -- --ignored --nocapture schirm_der_maschine`
    ///
    /// Das ist der schnellste Weg, die Frage „warum sagt der Start, mein Schirm
    /// laufe in SDR" zu beantworten, ohne einen Stream zu starten.
    #[test]
    #[ignore = "fragt echte Hardware ab; Ergebnis ist maschinenabhängig"]
    fn schirm_der_maschine() {
        let m = windows_capture::monitor::Monitor::primary().expect("primärer Bildschirm");
        match schirm_farbe(m.as_raw_hmonitor()).expect("DXGI-Abfrage") {
            Some(f) => println!("primärer Bildschirm: {}\n{f:#?}", f.beschreibung()),
            None => println!("primärer Bildschirm: kein DXGI-Ausgang gefunden"),
        }
    }

    /// Die Leuchtdichten müssen unverändert durchkommen — sie werden später zu
    /// Metadaten im Strom, und ein Faktor an der falschen Stelle fiele dort
    /// niemandem mehr auf.
    #[test]
    fn leuchtdichten_kommen_unveraendert_an() {
        let mut desc = DXGI_OUTPUT_DESC1::default();
        desc.MaxLuminance = 1499.0;
        desc.MaxFullFrameLuminance = 463.0;
        desc.MinLuminance = 0.0001;
        desc.WhitePoint = [0.3127, 0.3290];
        let f = SchirmFarbe::from(&desc);
        assert_eq!(f.max_nits, 1499.0);
        assert_eq!(f.max_vollbild_nits, 463.0);
        assert_eq!(f.min_nits, 0.0001);
        assert_eq!(f.weisspunkt, [0.3127, 0.3290]);
    }
}
