//! Was der Vulkan-Weg auf dieser Maschine **nicht** kann — und warum das ein
//! Abbruch ist und keine Umleitung.
//!
//! Eigene Datei, damit die Begründung dort steht, wo man sie sucht: nicht
//! zwischen den Encoder-Optionen, sondern unter „Grenzen".

use anyhow::{Result, bail};

/// **10 Bit über den Vulkan-Encoder ist auf dieser Karte unbrauchbar** — und
/// zwar so, dass keine Kennzahl es zeigt. Deshalb ein Abbruch und keine
/// Warnung.
///
/// Gemessen am 2026-08-02 (Radeon 780M, Treiber 32.0.31035.1003, FFmpeg
/// n8.1.2), Messakte `intrarefresh-2026-08-02-windows-amd.json` Abschnitt 11
/// (am 2026-08-21 gelöscht):
/// `av1_vulkan` liefert in 10 Bit **ab dem ersten Zwischenbild** eine falsche
/// Farbebene, die binnen weniger Bilder auf Anschlag läuft — das Bild wird
/// durchgehend magenta. Das erste Vollbild ist einwandfrei, alle folgenden
/// nicht.
///
/// **Es liegt nicht an unserem Weg.** Derselbe Fehler entsteht über FFmpegs
/// eigenes `hwupload`, ohne jede D3D11-Textur und ohne unseren Import; er
/// entsteht mit fester Quantisierung genauso wie mit Ratensteuerung und mit wie
/// ohne Intra-Refresh. In 8 Bit ist derselbe Encoder einwandfrei, rein
/// intra-kodiert in 10 Bit ebenfalls, und `av1_amf` kann 10 Bit mit
/// Zwischenbildern auf derselben Karte. Übrig bleibt der Vulkan-Encode-Weg für
/// 10 Bit — FFmpeg oder Treiber, von außen nicht weiter zu trennen.
///
/// # Warum ein Abbruch und kein Rückfall auf 8 Bit
///
/// Der naheliegende Weg wäre, `EncoderBauer::pool_format` für 10 Bit einfach
/// NV12 antworten zu lassen: die Pipeline liest die Bittiefe aus dem Pool
/// zurück, meldet „10 bit … -> 8 bit" auf stderr und liefe weiter. Für den
/// ausgelieferten Sidecar wäre das richtig — ein Nutzer bekäme ein Bild.
///
/// **Für das Labor ist es falsch.** Hier ist jeder Lauf eine Messung, und eine
/// Messung, die unter „AV1 10 Bit" läuft und in Wahrheit 8 Bit ist, beantwortet
/// eine andere Frage als die gestellte — genau die Sorte Verwechslung, vor der
/// Regel 2 der Laborordnung warnt und die in diesem Labor schon einmal zwei Tage
/// gekostet hat. Ein Abbruch kann man nicht überlesen.
///
/// Der Preis ist, dass er spät kommt: Pool und Skalierer stehen dann schon.
/// `pool_format` kann keinen Fehler zurückgeben, und die nächste Stelle, an der
/// das ginge, ist der Encoder-Bau.
///
/// Wer 10 Bit trotzdem messen will — etwa um einen neuen Treiber zu prüfen —
/// setzt `PULSE_LABOR_ZEHNBIT_TROTZDEM=1`.
pub fn zehn_bit_pruefen(ten_bit: bool) -> Result<()> {
    if !ten_bit {
        return Ok(());
    }
    if !pulse_win_hq_sidecar::env::flag("PULSE_LABOR_ZEHNBIT_TROTZDEM") {
        bail!(
            "10 Bit ueber den Vulkan-Encoder ist auf dieser Karte farblich kaputt: ab dem \
             ersten Zwischenbild laeuft die Farbebene auf Anschlag (magenta). Gemessen \
             2026-08-02, auch ueber FFmpegs eigenes hwupload — es liegt nicht am \
             D3D11-Import. 8 Bit ist einwandfrei; 10 Bit gibt es auf dieser Karte nur ueber \
             av1_amf, dann aber ohne Intra-Refresh. PULSE_LABOR_ZEHNBIT_TROTZDEM=1 hebt die \
             Sperre auf."
        );
    }
    eprintln!(
        "[vulkan-enc] WARNUNG: 10 Bit ist auf diesem Treiber farblich KAPUTT (magenta ab dem \
         ersten Zwischenbild). Lauf geht auf ausdrueckliche Anforderung weiter — jede Aussage \
         daraus ist wertlos."
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 8 Bit darf die Sperre nie sehen — sie ist der Regelbetrieb des Labors.
    #[test]
    fn acht_bit_geht_immer_durch() {
        assert!(zehn_bit_pruefen(false).is_ok());
    }

    /// Und 10 Bit muss ohne den ausdruecklichen Schalter scheitern. Ohne diesen
    /// Test waere die Sperre eine Zeile, die jemand beim Aufraeumen entfernt.
    #[test]
    fn zehn_bit_ist_gesperrt() {
        // Der Schalter wird hier NICHT gesetzt: `env::flag` liest die echte
        // Umgebung, und ein Test, der sie veraendert, schlaegt auf jeden
        // parallel laufenden zurueck.
        if pulse_win_hq_sidecar::env::flag("PULSE_LABOR_ZEHNBIT_TROTZDEM") {
            return; // Wer die Sperre global aufhebt, misst gerade — kein Urteil.
        }
        let fehler = zehn_bit_pruefen(true).unwrap_err().to_string();
        assert!(fehler.contains("magenta"), "Die Meldung muss das Fehlerbild nennen: {fehler}");
        assert!(
            fehler.contains("PULSE_LABOR_ZEHNBIT_TROTZDEM"),
            "Die Meldung muss den Ausweg nennen: {fehler}"
        );
    }
}
