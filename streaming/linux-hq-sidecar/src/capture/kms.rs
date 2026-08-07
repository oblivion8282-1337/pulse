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
//! DRM-Master ist oder `CAP_SYS_ADMIN` traegt. Der Aufnehmer selbst soll das
//! nicht sein — Trennung siehe [`crate::system::drm_ioctl`]. Fehlen die Rechte,
//! meldet [`KmsKarte::bild`] das ausdruecklich, statt ein leeres Bild zu
//! liefern.
//!
//! **Was dieser Weg nicht kann.** Er nimmt einen ganzen Ausgang auf, kein
//! einzelnes Fenster, und er kennt keine Auswahl durch den Nutzer. Er ist
//! deshalb kein Ersatz fuer den Portal-Weg, sondern der Sonderweg fuer HDR.

use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::path::Path;

use anyhow::{Context, Result, anyhow, bail};

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

/// Namen der DRM-Connector-Typen, Index = `connector_type` aus `drm_mode.h`.
const TYP_NAMEN: [&str; 21] = [
    "Unknown", "VGA", "DVI-I", "DVI-D", "DVI-A", "Composite", "SVIDEO", "LVDS",
    "Component", "DIN", "DP", "HDMI-A", "HDMI-B", "TV", "eDP", "Virtual", "DSI",
    "DPI", "Writeback", "SPI", "USB",
];

fn ausgang_name(typ: u32, typ_id: u32) -> String {
    let t = TYP_NAMEN.get(typ as usize).copied().unwrap_or("Unknown");
    format!("{t}-{typ_id}")
}

/// Eine geoeffnete Karte (`/dev/dri/cardN`).
pub struct KmsKarte {
    fd: OwnedFd,
}

impl KmsKarte {
    /// Karte oeffnen und die Client-Faehigkeiten anmelden.
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
                Ok(k) if k.ausgaenge().is_ok_and(|a| !a.is_empty()) => return Ok(k),
                Ok(_) => {}
                Err(e) => letzter = Some(e),
            }
        }
        Err(letzter.unwrap_or_else(|| anyhow!("keine DRM-Karte mit angeschlossenem Ausgang")))
    }

    fn raw(&self) -> RawFd {
        self.fd.as_raw_fd()
    }

    /// Alle angeschlossenen Ausgaenge samt ihrem HDR-Zustand.
    pub fn ausgaenge(&self) -> Result<Vec<Ausgang>> {
        let mut out = Vec::new();
        for c in drm::connectors(self.raw())? {
            let crtc_id = drm::crtc_of_encoder(self.raw(), c.encoder_id).unwrap_or(0);
            if crtc_id == 0 {
                // Angeschlossen, aber nicht aktiv — kein Scanout zu holen.
                continue;
            }
            let hdr = if c.hdr_blob != 0 {
                drm::blob(self.raw(), c.hdr_blob)
                    .ok()
                    .and_then(|b| HdrAngaben::aus_blob(&b))
            } else {
                None
            };
            out.push(Ausgang {
                name: ausgang_name(c.connector_type, c.connector_type_id),
                crtc_id,
                hdr,
            });
        }
        Ok(out)
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

    /// Das aktuelle Bild eines Ausgangs als DMABUF.
    ///
    /// Genommen wird die groesste Plane auf der CRTC — das ist die Bildebene.
    /// Der Mauszeiger liegt auf einer eigenen, kleinen Plane und ist damit
    /// **nicht** im Bild; das ist ein Unterschied zum Portal-Weg und gehoert
    /// dem Nutzer gesagt, nicht stillschweigend hingenommen.
    pub fn bild(&self, crtc_id: u32, pts: u64, epoch: u64) -> Result<DmabufFrame> {
        let planes = drm::planes(self.raw())?;
        let mut beste: Option<(u64, drm::Framebuffer)> = None;
        for p in planes.iter().filter(|p| p.crtc_id == crtc_id && p.fb_id != 0) {
            let fb = match drm::framebuffer(self.raw(), p.fb_id) {
                Ok(fb) => fb,
                Err(_) => continue,
            };
            let flaeche = fb.width as u64 * fb.height as u64;
            if !beste.as_ref().is_none_or(|(f, _)| flaeche > *f) {
                // Kleiner als die bisher beste — ihre Handles sofort zurueck,
                // sonst sammelt jeder Aufruf die des Mauszeigers an.
                Self::handles_freigeben(self.raw(), &fb);
                continue;
            }
            if let Some((_, alt)) = beste.replace((flaeche, fb)) {
                Self::handles_freigeben(self.raw(), &alt);
            }
        }
        let (_, fb) = beste
            .ok_or_else(|| anyhow!("CRTC {crtc_id} zeigt gerade keinen Framebuffer"))?;

        if fb.ebenen.is_empty() {
            bail!(
                "GETFB2 hat keine Handles geliefert — der Aufnehmer ist weder DRM-Master \
                 noch traegt er CAP_SYS_ADMIN. Die Scanout-Aufnahme (und damit HDR) ist \
                 ohne diese Berechtigung nicht moeglich."
            );
        }

        let mut planes_out = Vec::with_capacity(fb.ebenen.len());
        let mut fehler = None;
        for &(handle, pitch, offset) in &fb.ebenen {
            match drm::handle_to_fd(self.raw(), handle) {
                Ok(fd) => planes_out.push(DmabufPlane { fd, offset, stride: pitch as i32 }),
                Err(e) => {
                    fehler = Some(e);
                    break;
                }
            }
        }
        Self::handles_freigeben(self.raw(), &fb);
        if let Some(e) = fehler {
            return Err(e.context("Scanout-Puffer als DMABUF ausgeben"));
        }

        Ok(DmabufFrame {
            planes: planes_out,
            width: fb.width,
            height: fb.height,
            drm_fourcc: fb.fourcc,
            modifier: fb.modifier,
            pts,
            // Der Compositor tauscht den Scanout-Puffer bei jedem Bild; ein
            // Zwischenspeicher nach Puffer-Identitaet traegt hier nicht, und
            // ein falscher Treffer waere ein stehendes Bild. 0 = nicht merken.
            buffer_key: 0,
            epoch,
        })
    }

    fn handles_freigeben(fd: RawFd, fb: &drm::Framebuffer) {
        for &(handle, _, _) in &fb.ebenen {
            drm::close_handle(fd, handle);
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
}
