//! H.264: Traegt dieser Zugriff ein Vollbild?
//!
//! Der Payloader von webrtc-rs sagt es nicht, die Bildmarke braucht es aber
//! fuer ihre Schablone. Deshalb hier, aus den Startmustern des Bitstroms
//! gelesen (NAL-Typ 5 = IDR).
//!
//! **Seit dem 2026-08-21 gemeinsam.** Lag zuvor bitgleich in beiden Sidecars.

/// Ein SPS (7) oder PPS (8) allein ist KEIN Vollbild: solche Pakete haelt der
/// Payloader zurueck und gibt sie erst vor dem naechsten Vollbild aus.
pub fn h264_ist_vollbild(daten: &[u8]) -> bool {
    let mut i = 0;
    while i + 3 < daten.len() {
        let lang = daten[i] == 0 && daten[i + 1] == 0 && daten[i + 2] == 0 && daten[i + 3] == 1;
        let kurz = daten[i] == 0 && daten[i + 1] == 0 && daten[i + 2] == 1;
        if lang || kurz {
            let kopf = i + if lang { 4 } else { 3 };
            if kopf < daten.len() && daten[kopf] & 0x1F == 5 {
                return true;
            }
            i = kopf;
        } else {
            i += 1;
        }
    }
    false
}
