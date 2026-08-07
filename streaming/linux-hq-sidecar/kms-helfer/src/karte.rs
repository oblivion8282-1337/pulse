//! Eine geoeffnete DRM-Karte: Ausgaenge aufzaehlen und den Scanout-Puffer
//! eines Ausgangs als DMABUF herausgeben.
//!
//! **Warum das hier liegt und nicht im Sidecar.** Beide brauchen es, und zwar
//! genau dieselbe Fassung: der Helfer holt damit das Bild (mit
//! `CAP_SYS_ADMIN`), der Sidecar zaehlt damit die Ausgaenge auf (ohne jede
//! Berechtigung — das geht, nur die Handles bleiben ihm verwehrt). Zwei
//! Fassungen davon liefen bei der ersten Aenderung auseinander, und der
//! Unterschied faellt erst beim Nutzer auf, weil eine Seite unter Rechten
//! laeuft, die die andere nicht hat.
//!
//! Was hier NICHT liegt: alles, was mit HDR zu tun hat. Der Helfer soll von
//! Farbraeumen nichts wissen muessen — er reicht Puffer weiter. Die Deutung
//! der Property `HDR_OUTPUT_METADATA` steht im Sidecar (`capture::kms`).

use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::Path;

use anyhow::{Context, Result, anyhow};

use crate::drm;

/// Namen der DRM-Connector-Typen, Index = `connector_type` aus `drm_mode.h`.
const TYP_NAMEN: [&str; 21] = [
    "Unknown", "VGA", "DVI-I", "DVI-D", "DVI-A", "Composite", "SVIDEO", "LVDS",
    "Component", "DIN", "DP", "HDMI-A", "HDMI-B", "TV", "eDP", "Virtual", "DSI",
    "DPI", "Writeback", "SPI", "USB",
];

/// Der Name, den auch `/sys/class/drm` und `kscreen-doctor` zeigen.
pub fn ausgang_name(typ: u32, typ_id: u32) -> String {
    let t = TYP_NAMEN.get(typ as usize).copied().unwrap_or("Unknown");
    format!("{t}-{typ_id}")
}

/// Ein aktiver Ausgang, so roh wie ihn der Kernel meldet.
#[derive(Debug, Clone)]
pub struct AusgangRoh {
    pub name: String,
    pub crtc_id: u32,
    /// Blob-Nummer der Property `HDR_OUTPUT_METADATA` (0 = nicht gesetzt).
    pub hdr_blob: u32,
}

/// Eine Bildebene samt ihrem Dateideskriptor. Der Deskriptor gehoert dieser
/// Struktur; sie schliesst ihn.
#[derive(Debug)]
pub struct Ebene {
    pub fd: OwnedFd,
    pub pitch: u32,
    pub offset: u32,
}

/// Das aktuelle Bild eines Ausgangs.
#[derive(Debug)]
pub struct Scanoutbild {
    pub width: u32,
    pub height: u32,
    pub fourcc: u32,
    pub modifier: u64,
    pub ebenen: Vec<Ebene>,
}

/// Warum das Bild nicht kam. Die Faelle sind getrennt, weil sie
/// unterschiedliche Abhilfen haben — und weil „keine Rechte" die einzige
/// Meldung ist, aus der ein Nutzer etwas machen kann.
#[derive(Debug)]
pub enum BildFehler {
    /// Die CRTC zeigt gerade keinen Framebuffer (Ausgang schlaeft, gerade
    /// umgeschaltet).
    KeinBild,
    /// `GETFB2` lieferte keine GEM-Handles: der Aufrufer ist weder DRM-Master
    /// noch traegt er `CAP_SYS_ADMIN`.
    KeineRechte,
    Sonst(anyhow::Error),
}

impl std::fmt::Display for BildFehler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::KeinBild => write!(f, "die CRTC zeigt gerade keinen Framebuffer"),
            Self::KeineRechte => write!(
                f,
                "GETFB2 hat keine Handles geliefert — weder DRM-Master noch CAP_SYS_ADMIN"
            ),
            Self::Sonst(e) => write!(f, "{e:#}"),
        }
    }
}

/// Eine geoeffnete Karte (`/dev/dri/cardN`).
pub struct Karte {
    fd: OwnedFd,
}

impl Karte {
    pub fn oeffnen(pfad: &Path) -> Result<Self> {
        let datei = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(pfad)
            .with_context(|| format!("{} oeffnen", pfad.display()))?;
        let fd: OwnedFd = datei.into();
        drm::set_client_caps(fd.as_raw_fd())?;
        Ok(Self { fd })
    }

    /// Die erste Karte, die ueberhaupt Ausgaenge fuehrt. Render-Nodes
    /// (`renderD*`) scheiden aus — sie kennen die Mode-ioctls nicht.
    pub fn erste_mit_ausgaengen() -> Result<Self> {
        let mut namen: Vec<_> = std::fs::read_dir("/dev/dri")
            .context("/dev/dri lesen")?
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("card"))
            })
            .collect();
        namen.sort();
        let mut letzter = None;
        for p in namen {
            match Self::oeffnen(&p) {
                Ok(k) if k.ausgaenge_roh().is_ok_and(|a| !a.is_empty()) => return Ok(k),
                Ok(_) => {}
                Err(e) => letzter = Some(e),
            }
        }
        Err(letzter.unwrap_or_else(|| anyhow!("keine DRM-Karte mit angeschlossenem Ausgang")))
    }

    pub fn roh(&self) -> RawFd {
        self.fd.as_raw_fd()
    }

    /// Alle angeschlossenen und aktiven Ausgaenge.
    pub fn ausgaenge_roh(&self) -> Result<Vec<AusgangRoh>> {
        let mut out = Vec::new();
        for c in drm::connectors(self.roh())? {
            let crtc_id = drm::crtc_of_encoder(self.roh(), c.encoder_id).unwrap_or(0);
            if crtc_id == 0 {
                // Angeschlossen, aber nicht aktiv — kein Scanout zu holen.
                continue;
            }
            out.push(AusgangRoh {
                name: ausgang_name(c.connector_type, c.connector_type_id),
                crtc_id,
                hdr_blob: c.hdr_blob,
            });
        }
        Ok(out)
    }

    /// Das aktuelle Bild einer CRTC.
    ///
    /// Genommen wird die groesste Plane — das ist die Bildebene. Der
    /// Mauszeiger liegt auf einer eigenen, kleinen Plane und ist damit **nicht**
    /// im Bild; das ist ein Unterschied zum Portal-Weg und gehoert dem Nutzer
    /// gesagt, nicht stillschweigend hingenommen.
    pub fn bild(&self, crtc_id: u32) -> std::result::Result<Scanoutbild, BildFehler> {
        let planes = drm::planes(self.roh()).map_err(BildFehler::Sonst)?;
        let mut beste: Option<(u64, drm::Framebuffer)> = None;
        for p in planes.iter().filter(|p| p.crtc_id == crtc_id && p.fb_id != 0) {
            let Ok(fb) = drm::framebuffer(self.roh(), p.fb_id) else {
                continue;
            };
            let flaeche = fb.width as u64 * fb.height as u64;
            if !beste.as_ref().is_none_or(|(f, _)| flaeche > *f) {
                // Kleiner als die bisher beste — ihre Handles sofort zurueck,
                // sonst sammelt jeder Aufruf die des Mauszeigers an.
                self.handles_freigeben(&fb);
                continue;
            }
            if let Some((_, alt)) = beste.replace((flaeche, fb)) {
                self.handles_freigeben(&alt);
            }
        }
        let (_, fb) = beste.ok_or(BildFehler::KeinBild)?;
        if fb.ebenen.is_empty() {
            return Err(BildFehler::KeineRechte);
        }

        let mut ebenen = Vec::with_capacity(fb.ebenen.len());
        let mut fehler = None;
        for &(handle, pitch, offset) in &fb.ebenen {
            match drm::handle_to_fd(self.roh(), handle) {
                // Sicher: `handle_to_fd` liefert einen frischen, uns
                // gehoerenden Deskriptor.
                Ok(fd) => ebenen.push(Ebene {
                    fd: unsafe { OwnedFd::from_raw_fd(fd) },
                    pitch,
                    offset,
                }),
                Err(e) => {
                    fehler = Some(e);
                    break;
                }
            }
        }
        // Die GEM-Handles IMMER zurueckgeben — auch im Fehlerfall. Der Kernel
        // legt sie fuer jede `GETFB2`-Antwort neu an; bei 60 Bildern je Sekunde
        // sammeln sich sonst in Minuten Zehntausende.
        self.handles_freigeben(&fb);
        if let Some(e) = fehler {
            return Err(BildFehler::Sonst(e.context("Scanout-Puffer als DMABUF ausgeben")));
        }

        Ok(Scanoutbild {
            width: fb.width,
            height: fb.height,
            fourcc: fb.fourcc,
            modifier: fb.modifier,
            ebenen,
        })
    }

    fn handles_freigeben(&self, fb: &drm::Framebuffer) {
        for &(handle, _, _) in &fb.ebenen {
            drm::close_handle(self.roh(), handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ausgangsnamen_wie_in_sysfs() {
        assert_eq!(ausgang_name(10, 2), "DP-2");
        assert_eq!(ausgang_name(11, 1), "HDMI-A-1");
        assert_eq!(ausgang_name(14, 1), "eDP-1");
        // Unbekannter Typ darf nicht panisch werden, sondern faellt zurueck.
        assert_eq!(ausgang_name(99, 1), "Unknown-1");
    }

    /// Die Meldung fuer den Rechte-Fall muss den Grund nennen — sie ist die
    /// einzige, aus der ein Nutzer etwas machen kann.
    #[test]
    fn rechte_fehler_nennt_den_grund() {
        let t = BildFehler::KeineRechte.to_string();
        assert!(t.contains("CAP_SYS_ADMIN"), "{t}");
    }
}
