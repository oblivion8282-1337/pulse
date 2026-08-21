//! Encoder, die von sich aus auffrischen — und deshalb den bestellten
//! Vollbild-Takt verschlucken.
//!
//! **Was hier bis zum 2026-08-21 stand.** Dieses Modul trug die Betriebsart
//! „rollender Intra-Refresh statt periodischer Vollbilder": eine Tabelle aus
//! Messungen, welcher Encoder sie mit welchen Optionsnamen liefert, eine
//! Prüfung, ob das gelinkte FFmpeg diese Optionen überhaupt durchreicht, und
//! eine Startverweigerung, falls nicht. Die Betriebsart ist entfallen (der
//! Vollbild-Abstand von 60 s liefert an identischen Bildern +1,87 VMAF bei
//! 16 % weniger Daten, H.264 sah damit sichtbar schlechter aus, macOS trug sie
//! nie, und ein Intra-Refresh-Strom heilt sich nach Paketverlust nicht selbst).
//!
//! **Was NICHT mit ihr entfallen ist, und der Grund für dieses Modul:** ein
//! Encoder kann von sich aus auffrischen, ohne dass jemand ihn darum bittet.
//! Dann bleibt der bestellte Vollbild-Takt aus, und ein neu einsteigender
//! Zuschauer bekäme ohne Zutun nie ein Bild. Das ist keine Einstellung, die man
//! abwählen könnte — es ist eine Eigenschaft des Encoders, die bestehen bleibt,
//! solange es ihn gibt.

/// Muss dieser Encoder seine Vollbilder von aussen getaktet bekommen?
///
/// Genau dann, wenn er von sich aus auffrischt: was von sich aus läuft, hört
/// auch von sich aus nicht auf, und der GOP-Takt greift dort nicht. Die
/// Vollbilder kommen deshalb aus `keyframe::Selbsttakt`.
///
/// **`h264_amf` ist der eine Fall**, und er hängt an `usage=ultralowlatency`:
/// das setzt `opts::vendor_encoder_opts` seit dem 2026-07-30 unbedingt, aus
/// Last-Gründen, und bei diesem Encoder bringt es die Auffrischung mit. Am
/// 2026-08-02 gezählt (stehendes Bild, feste Quantisierung, 300 Bilder bei
/// `-g 60`):
///
/// | `usage`            | Vollbilder in 300 Bildern |
/// |--------------------|---------------------------|
/// | Treiber-Vorgabe    | 5 — der bestellte Takt    |
/// | `transcoding`      | 5                         |
/// | `lowlatency`       | 1                         |
/// | `ultralowlatency`  | 1                         |
///
/// **Warum nicht einfach `usage=transcoding`** (der Weg vom 2026-08-07 bis zum
/// 2026-08-19): weil er die Auffrischung nur als Nebenwirkung davon abschaltet,
/// dass er die sparsame Betriebsart wegnimmt — und die kostet das
/// Zweieinhalbfache an Video-Engine. Am 2026-08-19 nachgemessen auf einer
/// Radeon 780M, drei Arme, je 35 s bei 1080p60 und 12 Mbit/s:
///
/// | | Video-Engine | Vollbilder |
/// |---|---|---|
/// | `ultralowlatency` (Auffrischung) | 10,5 % | nein |
/// | `transcoding` (der alte Abschaltweg) | 25,2 % | ja |
/// | **`ultralowlatency` + Selbsttakt** | **10,2 %** | **ja** |
///
/// Die Gegenprobe, dass es nicht am Encode-Weg liegt: `h264_d3d12va` setzt gar
/// kein `usage` und kostet dieselben 25,2 %. Teuer ist also nicht die
/// Umschaltung, sondern alles, was NICHT `ultralowlatency` ist.
///
/// **Was dabei ausdrücklich NICHT behauptet wird:** dass an die Stelle des
/// Vollbild-Takts eine rollende Auffrischung tritt, die Paketverluste
/// repariert. Belegt ist nur die eine Hälfte — `usage=ultralowlatency`
/// unterdrückt den bestellten Takt (2026-08-02 gezählt, 2026-08-19
/// nachgemessen). Drei Versuche, die andere Hälfte zu belegen, sind
/// gescheitert: im Bitstrom keine Spur (`constrained_intra_pred_flag = 0`, kein
/// recovery point), ein Schadenstest über neun Schnittstellen trennte die
/// Betriebsarten nicht (4 von 9 erholt auf beiden Seiten, das Prüfbild war
/// Rauschen), und den Auffrischungs-Wischer sah man nur bei ausdrücklich
/// eingeschalteter Auffrischung. Jede Aussage über die Verlust-Robustheit von
/// H.264 auf AMD darf sich darauf **nicht** stützen.
///
/// Für den Selbsttakt ändert das nichts: er wird gebraucht, weil der bestellte
/// Takt ausbleibt, und dieser Grund steht.
///
/// **Die übrigen Encoder frischen nur auf Ansage auf.** `h264_d3d12va` frischt
/// zwar durchgehend auf, ersetzt den Vollbild-Takt dabei aber NICHT — bei
/// `-g 60` bleiben die fünf Vollbilder stehen. Ein neu einsteigender Zuschauer
/// kommt dort also ins Bild, und genau darum geht es hier.
pub fn braucht_selbsttakt(encoder: &str) -> bool {
    encoder == "h264_amf"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nur_h264_amf_braucht_den_selbsttakt() {
        assert!(braucht_selbsttakt("h264_amf"));
        for andere in [
            "h264_nvenc",
            "hevc_nvenc",
            "av1_nvenc",
            "av1_amf",
            "hevc_amf",
            "h264_d3d12va",
            "av1_d3d12va",
            "h264_qsv",
            "av1_qsv",
            "libx264",
        ] {
            assert!(!braucht_selbsttakt(andere), "{andere} braucht keinen Selbsttakt");
        }
    }
}
