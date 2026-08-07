//! Aufnahme direkt vom Scanout (DRM/KMS) — der einzige Weg zu HDR-Inhalt.
//!
//! **Warum nicht der Portal-Weg.** KWins ScreenCast-Erzeuger fuehrt in seiner
//! Formatliste ausschliesslich 8-Bit-Formate und traegt keinerlei
//! Farbraum-Felder; gemessen am 2026-08-07 (Messakte
//! `hdr-2026-08-07-machbarkeit-linux-nvidia.json`) und am Quelltext von
//! `screencaststream.cpp` bis heute unveraendert. Ueber diesen Weg gibt es
//! also nichts, was HDR sein koennte — die Aufnahme ist bei eingeschaltetem
//! HDR sogar byte-identisch zu der im SDR-Betrieb.
//!
//! **Was der Scanout stattdessen liefert.** Der Puffer, den der Compositor an
//! den Bildschirm schickt, ist bei eingeschaltetem HDR ein 10-Bit-Puffer
//! (`AB30`/`XB30`) mit bereits PQ-kodierten Werten in BT.2020 — der Compositor
//! hat die Wandlung schon gemacht, weil der Bildschirm sie so erwartet. Wir
//! muessen deshalb **keine** Transferkurve rechnen (anders als der
//! Windows-Sidecar, der aus scRGB kommt); es bleibt die Umsetzung nach YCbCr
//! mit der BT.2020-Matrix. Dasselbe tut gpu-screen-recorder.
//!
//! **Preis: erhoehte Rechte.** Die GEM-Handles aus `GETFB2` bekommt nur, wer
//! DRM-Master ist oder `CAP_SYS_ADMIN` traegt. Das **Aufzaehlen** der Ausgaenge
//! und das Lesen ihres HDR-Zustands geht dagegen ohne jede Berechtigung — was
//! dieses Modul unmittelbar tut. Fuer das Bild selbst gibt es zwei Wege:
//! unmittelbar (als root oder mit gesetzter Faehigkeit, so laeuft das Labor)
//! oder ueber das Helfer-Programm ([`super::kms_helfer`]), so laeuft die
//! ausgelieferte App. Welcher genommen wird, entscheidet
//! [`super::kms_aufnahme`] beim Start — an einem Versuch, nicht an einer
//! Vermutung.
//!
//! **Was dieser Weg nicht kann.** Er nimmt einen ganzen Ausgang auf, kein
//! einzelnes Fenster, und er kennt keine Auswahl durch den Nutzer. Er ist
//! deshalb kein Ersatz fuer den Portal-Weg, sondern der Sonderweg fuer HDR.

use std::os::fd::IntoRawFd;
use std::path::Path;

use anyhow::{Result, anyhow};

use pulse_kms_helfer::karte::{BildFehler, Karte};

use crate::system::drm_ioctl as drm;

use super::pipewire_stream::{DmabufFrame, DmabufPlane};

/// Die statischen HDR-Angaben, die der Compositor an den Bildschirm meldet
/// (DRM-Property `HDR_OUTPUT_METADATA`, Aufbau `struct hdr_output_metadata`).
///
/// Einheiten sind die von CTA-861: Farbort in 1/50000, Leuchtdichte in cd/m2
/// (die kleinste in 1/10000 cd/m2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HdrAngaben {
    pub eotf: u8,
    pub primaries: [(u16, u16); 3],
    pub weisspunkt: (u16, u16),
    pub max_leuchtdichte: u16,
    pub min_leuchtdichte: u16,
    pub max_cll: u16,
    pub max_fall: u16,
}

/// `eotf`-Wert fuer SMPTE ST 2084 (PQ) aus CTA-861-G. Nur dieser Fall ist fuer
/// uns HDR: bei 0 (Gamma/SDR) oder 1 (traditionelles HDR-Gamma) traegt der
/// Scanout keine PQ-Werte, und HLG (3) waere eine andere Kurve, die wir nicht
/// signalisieren.
pub const EOTF_SMPTE_ST2084: u8 = 2;

impl HdrAngaben {
    /// Aus dem Blob lesen. `None`, wenn er zu kurz ist — dann ist die Property
    /// zwar gesetzt, ihr Inhalt aber nicht der erwartete, und Raten waere hier
    /// besonders teuer (die Zahlen landen sonst als Mastering-Angaben im Strom).
    fn aus_blob(bytes: &[u8]) -> Option<Self> {
        // `struct hdr_output_metadata`: u32 metadata_type, dann das Infoframe.
        const KOPF: usize = 4;
        if bytes.len() < KOPF + 26 {
            return None;
        }
        let d = &bytes[KOPF..];
        let u16_at = |i: usize| u16::from_ne_bytes([d[i], d[i + 1]]);
        Some(Self {
            eotf: d[0],
            primaries: [
                (u16_at(2), u16_at(4)),
                (u16_at(6), u16_at(8)),
                (u16_at(10), u16_at(12)),
            ],
            weisspunkt: (u16_at(14), u16_at(16)),
            max_leuchtdichte: u16_at(18),
            min_leuchtdichte: u16_at(20),
            max_cll: u16_at(22),
            max_fall: u16_at(24),
        })
    }

    pub fn ist_pq(&self) -> bool {
        self.eotf == EOTF_SMPTE_ST2084
    }
}

/// Ein Ausgang, wie ihn dieser Weg sieht.
#[derive(Debug, Clone)]
pub struct Ausgang {
    /// `DP-2`, `HDMI-A-1` — derselbe Name wie in `/sys/class/drm`.
    pub name: String,
    pub crtc_id: u32,
    pub hdr: Option<HdrAngaben>,
}

impl Ausgang {
    /// Laeuft dieser Ausgang gerade wirklich in HDR (PQ)?
    pub fn ist_hdr(&self) -> bool {
        self.hdr.is_some_and(|h| h.ist_pq())
    }
}

/// Eine geoeffnete Karte (`/dev/dri/cardN`), um die HDR-Deutung erweitert.
pub struct KmsKarte {
    karte: Karte,
}

impl KmsKarte {
    pub fn oeffnen(pfad: &Path) -> Result<Self> {
        Ok(Self { karte: Karte::oeffnen(pfad)? })
    }

    /// Die erste Karte, die ueberhaupt Ausgaenge fuehrt.
    pub fn erste_mit_ausgaengen() -> Result<Self> {
        Ok(Self { karte: Karte::erste_mit_ausgaengen()? })
    }

    /// Alle angeschlossenen Ausgaenge samt ihrem HDR-Zustand.
    ///
    /// Braucht **keine** Berechtigung — das ist der Grund, warum die Auswahl
    /// und die Absage-Meldungen ohne den Helfer auskommen.
    pub fn ausgaenge(&self) -> Result<Vec<Ausgang>> {
        let fd = self.karte.roh();
        Ok(self
            .karte
            .ausgaenge_roh()?
            .into_iter()
            .map(|a| Ausgang {
                hdr: (a.hdr_blob != 0)
                    .then(|| drm::blob(fd, a.hdr_blob).ok())
                    .flatten()
                    .and_then(|b| HdrAngaben::aus_blob(&b)),
                name: a.name,
                crtc_id: a.crtc_id,
            })
            .collect())
    }

    /// Ausgang nach Namen (`DP-2`), sonst der erste mit eingeschaltetem HDR,
    /// sonst der erste ueberhaupt.
    pub fn ausgang_waehlen(&self, wunsch: Option<&str>) -> Result<Ausgang> {
        let alle = self.ausgaenge()?;
        if let Some(w) = wunsch {
            return alle
                .into_iter()
                .find(|a| a.name.eq_ignore_ascii_case(w))
                .ok_or_else(|| anyhow!("Ausgang '{w}' gibt es nicht oder er ist nicht aktiv"));
        }
        alle.iter()
            .find(|a| a.ist_hdr())
            .or_else(|| alle.first())
            .cloned()
            .ok_or_else(|| anyhow!("kein aktiver Ausgang"))
    }

    /// Das aktuelle Bild eines Ausgangs als DMABUF — auf dem unmittelbaren Weg.
    ///
    /// [`BildFehler::KeineRechte`] ist hier **kein** Fehlschlag im ueblichen
    /// Sinn, sondern die Auskunft „nimm den Helfer". Deshalb reicht diese
    /// Funktion den Fall getrennt heraus, statt ihn in eine Textmeldung zu
    /// verpacken, die der Aufrufer wieder auseinandernehmen muesste.
    pub fn bild(
        &self,
        crtc_id: u32,
        pts: u64,
        epoch: u64,
    ) -> std::result::Result<DmabufFrame, BildFehler> {
        let bild = self.karte.bild(crtc_id)?;
        Ok(als_frame(
            bild.width,
            bild.height,
            bild.fourcc,
            bild.modifier,
            bild.ebenen
                .into_iter()
                .map(|e| DmabufPlane {
                    fd: e.fd.into_raw_fd(),
                    offset: e.offset,
                    stride: e.pitch as i32,
                })
                .collect(),
            pts,
            epoch,
        ))
    }

    pub fn roh(&self) -> std::os::fd::RawFd {
        self.karte.roh()
    }
}

/// Aus den Angaben des Scanouts denselben Rahmen bauen, den der Portal-Weg
/// liefert — alles dahinter (Import, Skalierung, Encode) bleibt unveraendert.
pub(crate) fn als_frame(
    width: u32,
    height: u32,
    drm_fourcc: u32,
    modifier: u64,
    planes: Vec<DmabufPlane>,
    pts: u64,
    epoch: u64,
) -> DmabufFrame {
    DmabufFrame {
        planes,
        width,
        height,
        drm_fourcc,
        modifier,
        pts,
        // Der Compositor tauscht den Scanout-Puffer bei jedem Bild; ein
        // Zwischenspeicher nach Puffer-Identitaet traegt hier nicht, und ein
        // falscher Treffer waere ein stehendes Bild. 0 = nicht merken.
        buffer_key: 0,
        epoch,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hdr_blob_wird_gelesen() {
        // metadata_type=1, dann das Infoframe: eotf=2 (PQ), type=1,
        // Primaries/Weisspunkt/Leuchtdichten/CLL/FALL aufsteigend zaehlend.
        let mut b = Vec::new();
        b.extend_from_slice(&1u32.to_ne_bytes());
        b.push(EOTF_SMPTE_ST2084);
        b.push(1);
        for v in 1u16..=12 {
            b.extend_from_slice(&v.to_ne_bytes());
        }
        assert_eq!(b.len(), 4 + 26, "so lang ist das Infoframe laut CTA-861");
        let a = HdrAngaben::aus_blob(&b).expect("Blob ist lang genug");
        assert!(a.ist_pq());
        assert_eq!(a.primaries, [(1, 2), (3, 4), (5, 6)]);
        assert_eq!(a.weisspunkt, (7, 8));
        assert_eq!(a.max_leuchtdichte, 9);
        assert_eq!(a.min_leuchtdichte, 10);
        assert_eq!(a.max_cll, 11);
        assert_eq!(a.max_fall, 12);
    }

    #[test]
    fn zu_kurzer_blob_wird_nicht_geraten() {
        assert!(HdrAngaben::aus_blob(&[0u8; 8]).is_none());
    }

    #[test]
    fn nur_pq_gilt_als_hdr() {
        let mut a = HdrAngaben {
            eotf: 0,
            primaries: [(0, 0); 3],
            weisspunkt: (0, 0),
            max_leuchtdichte: 0,
            min_leuchtdichte: 0,
            max_cll: 0,
            max_fall: 0,
        };
        assert!(!a.ist_pq(), "Gamma/SDR ist kein HDR");
        a.eotf = 3;
        assert!(!a.ist_pq(), "HLG signalisieren wir nicht");
        a.eotf = EOTF_SMPTE_ST2084;
        assert!(a.ist_pq());
    }

    /// Der Rahmen darf sich nicht merken lassen: bei der Scanout-Aufnahme
    /// wechselt der Puffer je Bild, ein Treffer im EGLImage-Zwischenspeicher
    /// waere ein stehendes Bild (Befund M9 der Messakte).
    #[test]
    fn scanout_rahmen_wird_nicht_zwischengespeichert() {
        let f = als_frame(2560, 1440, 0x3033_4241, 7, Vec::new(), 5, 0);
        assert_eq!(f.buffer_key, 0);
        assert_eq!((f.width, f.pts), (2560, 5));
    }
}
