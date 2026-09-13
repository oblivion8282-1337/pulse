//! HEVC: Trägt dieser Zugriff ein Vollbild?
//!
//! Das HEVC-Gegenstück zu [`crate::h264`]: der Payloader von webrtc-rs sagt
//! es nicht, die Bildmarke braucht es aber für ihre Schablone. Gesucht wird
//! über die Annex-B-Startcodes, weil die Encoder in diesem Format liefern —
//! dasselbe, was `HevcPayloader` erwartet.
//!
//! **Der NAL-Kopf ist hier ZWEI Byte und der Typ sitzt woanders** (RFC 7798
//! §1.1.4): `F(1) | Type(6) | LayerId(6) | TID(3)` — der Typ ist die obere
//! Hälfte des ersten Bytes, `(b0 >> 1) & 0x3F`. Die H.264-Maske `& 0x1F`
//! würde hier Müll lesen.
//!
//! Einstiegspunkte sind BLA (16-18), IDR (19, 20) und CRA (21) — alle drei
//! sind intra, ein Zuschauer kann dort einsteigen. VPS (32), SPS (33) und
//! PPS (34) zählen NICHT als Vollbild: sie gehen dem Einstiegspunkt voraus,
//! und der Payloader hält sie ohnehin zurück, bis er ihn ausspielt.

/// Trägt dieser Annex-B-Zeitabschnitt ein Vollbild (BLA/IDR/CRA)?
pub fn hevc_ist_vollbild(daten: &[u8]) -> bool {
    let mut i = 0;
    while i + 4 < daten.len() {
        let lang = daten[i] == 0 && daten[i + 1] == 0 && daten[i + 2] == 0 && daten[i + 3] == 1;
        let kurz = daten[i] == 0 && daten[i + 1] == 0 && daten[i + 2] == 1;
        if lang || kurz {
            let kopf = i + if lang { 4 } else { 3 };
            if kopf + 1 < daten.len() && matches!((daten[kopf] >> 1) & 0x3F, 16..=21) {
                return true;
            }
            i = kopf;
        } else {
            i += 1;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::hevc_ist_vollbild;

    /// IDR_W_RADL (19): `19 << 1 = 0x26`. Derselbe Aufbau wie der
    /// H.264-Test — langer und kurzer Startcode müssen beide gehen.
    #[test]
    fn idr_gilt_als_vollbild() {
        assert!(hevc_ist_vollbild(&[0, 0, 0, 1, 0x26, 0x01, 0xAA]), "langer Startcode, IDR_W_RADL");
        assert!(hevc_ist_vollbild(&[0, 0, 1, 0x26, 0x01, 0xAA]), "kurzer Startcode, IDR_W_RADL");
    }

    /// CRA (21) und BLA_W_LP (16) sind ebenfalls Einstiegspunkte — die
    /// Bildmarke darf sie nicht anders behandeln als eine IDR.
    #[test]
    fn cra_und_bla_gelten_auch() {
        assert!(hevc_ist_vollbild(&[0, 0, 0, 1, 0x2A, 0x01, 0xAA]), "CRA (21)");
        assert!(hevc_ist_vollbild(&[0, 0, 0, 1, 0x20, 0x01, 0xAA]), "BLA_W_LP (16)");
    }

    /// TRAIL_R (1) ist ein Differenzbild; `& 0x1F` würde aus dem Kopf 0x02
    /// fälschlich Typ 2 lesen — der Test hält die richtige Maske fest.
    #[test]
    fn differenzbild_ist_kein_vollbild() {
        assert!(!hevc_ist_vollbild(&[0, 0, 0, 1, 0x02, 0x01, 0xAA]), "TRAIL_R (1)");
    }

    /// VPS (32), SPS (33), PPS (34) gehen dem Vollbild voraus und werden vom
    /// Payloader zurückgehalten — allein sind sie KEIN Einstiegspunkt.
    #[test]
    fn parameter_saetze_sind_kein_vollbild() {
        assert!(!hevc_ist_vollbild(&[0, 0, 0, 1, 0x40, 0x01, 0xAA]), "VPS (32)");
        assert!(!hevc_ist_vollbild(&[0, 0, 0, 1, 0x42, 0x01, 0xAA]), "SPS (33)");
        assert!(!hevc_ist_vollbild(&[0, 0, 0, 1, 0x44, 0x01, 0xAA]), "PPS (34)");
    }
}
