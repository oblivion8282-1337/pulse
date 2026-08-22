//! 10 bit — wer es wirklich trägt, und die Absage für den Rest.
//!
//! Gegenstück zu [`super::hdr`], aus demselben Grund gebaut und STRUKTURGLEICH:
//! **ein Strom, der unter dem Etikett „10 bit" läuft und in Wahrheit 8 bit ist,
//! ist schlimmer als ein Start, der abbricht.** Der Unterschied zeigt sich
//! höchstens als leichtes Banding in einem Verlauf — niemand sucht ihn dort,
//! und die Zusage bleibt trotzdem gebrochen.
//!
//! **Nachgemessen am 2026-08-11** (RTX 5080): `PULSE_HQ_DISABLE_ZERO_COPY=1`
//! mit `bit_depth: 10` lieferte `yuv420p` statt `yuv420p10le` — ohne Abbruch,
//! ohne Zeile im Log. Der Grund liegt an genau zwei Stellen, beide strukturell,
//! keine misst nach: der CPU-Weg (`encode/encoder.rs`) hat gar kein
//! `ten_bit`-Feld in `EncoderConfig`, und der D3D12-Weg
//! (`encode/encoder_d3d12.rs:152`) legt seinen Bildpuffer fest auf NV12.
//! Dieses Modul schließt genau diese Lücke: ein 10-bit-Wunsch, der auf einen
//! dieser beiden Wege trifft, muss den Start verweigern statt still zu
//! verschwinden.
//!
//! **Wo dieser Check sitzt und wo nicht.** Er prüft den EFFEKTIVEN Encode-Weg
//! (nach `PULSE_HQ_DISABLE_ZERO_COPY`, vor dem eigentlichen Encoder-Open) —
//! dieselbe Stelle, an der [`super::hdr::pruefen`] sitzt, aus demselben Grund:
//! das ist die letzte Stelle, an der alle drei Wege noch gemeinsam sichtbar
//! sind. Was er NICHT prüft, ist die feinere Frage INNERHALB des D3D11-
//! Zero-Copy-Wegs — ob der gewählte Codec 10 bit überhaupt trägt (nur AV1,
//! [`VideoCodec::supports_ten_bit`]) und ob ein angemeldeter Encode-Weg einen
//! 8-bit-Pool verlangt. Die hängt schon vor diesem Modul an EINER Stelle
//! (`bildencoder::pool_wahl`, ausgewertet in `pipeline_hw::run`, mit eigener
//! Log-Zeile) und wird hier bewusst nicht verdoppelt — zwei Prüfungen für
//! dieselbe Frage laufen irgendwann auseinander.
//!
//! **HDR schaltet 10 bit selbst ein** (`StartParams::hdr`, `ops/start.rs:99`)
//! und hat eine EIGENE, strengere Absage (`hdr::pruefen` bricht schon ab, wenn
//! der Encoder keine HDR-Signalisierung trägt — das schließt „kein 10 bit"
//! mit ein, s. Modulkopf dort). Der Aufrufer (`stream_controller::run_pipeline`)
//! ruft [`pruefen`] deshalb nur, wenn HDR NICHT verlangt ist — sonst bekäme
//! ein HDR-Nutzer bei genau derselben Ursache entweder dieselbe Absage
//! doppelt oder, schlimmer, die genauere HDR-Meldung würde durch die
//! allgemeinere 10-bit-Meldung verdrängt.

use anyhow::{Result, bail};

use super::codec::{EncodePath, VideoCodec};

/// Darf dieser Stream mit 10 bit starten, bei diesem effektiven Encode-Weg?
///
/// `disable_zc` = `PULSE_HQ_DISABLE_ZERO_COPY` gesetzt — der erzwingt den
/// CPU-Weg, unabhängig davon, was `pfad` sagt, und wird deshalb ZUERST
/// geprüft: sonst nennte die Meldung einen Weg, den der Nutzer gar nicht
/// gewählt hat. `pfad` = [`VideoCodec::encode_path`] des Aufrufers, roh
/// ausgewertet (vor dem Schalter).
///
/// Einmal je Start aufzurufen, **bevor** irgendein Encoder geöffnet wird —
/// dieselbe Reihenfolge und derselbe Grund wie bei [`super::hdr::pruefen`]:
/// eine Absage nach dem Öffnen ist ein halb gestarteter Stream.
pub fn pruefen(disable_zc: bool, pfad: EncodePath) -> Result<()> {
    if disable_zc {
        bail!(
            "10 bit verlangt, aber PULSE_HQ_DISABLE_ZERO_COPY erzwingt den CPU-Weg — der hat \
             kein `ten_bit`-Feld in seiner Encoder-Konfiguration (encode/encoder.rs) und liefert \
             deshalb immer 8 bit. 10 bit und dieser Schalter schließen sich aus: entweder den \
             Schalter weglassen, oder ohne 10 bit starten."
        );
    }
    match pfad {
        EncodePath::D3d11ZeroCopy => Ok(()),
        EncodePath::D3d12ZeroCopy => bail!(
            "10 bit verlangt, aber dieser Stream liefe über den D3D12-Weg (aktiv z. B. über \
             PULSE_HQ_AMD_D3D12=1) — dessen Bildpuffer liegt fest auf NV12 (8 bit), es gibt \
             keinen P010-Zweig (encoder_d3d12.rs:152). Abhilfe: den Gegenprobe-Schalter \
             ausschalten."
        ),
        EncodePath::Cpu => bail!(
            "10 bit verlangt, aber dieser Stream liefe über die CPU-Pipeline (auf Intel der \
             Regelweg) — die hat kein `ten_bit`-Feld in ihrer Encoder-Konfiguration \
             (encode/encoder.rs) und liefert deshalb immer 8 bit. Abhilfe: auf NVIDIA/AMD mit \
             AV1 streamen."
        ),
    }
}

/// Kann diese Maschine überhaupt 10 bit senden — mit mindestens einem ihrer
/// Codecs, über den Weg, der bei dieser Kombination WIRKLICH läuft?
///
/// Das ist die Frage, die `health.gsr.ten_bit` beantwortet. **Bis zum
/// 2026-08-11 fragte sie nur, ob es überhaupt einen FFmpeg-Encoder für
/// (Vendor, Codec) gibt** — auf Intel gibt es `av1_qsv`, und die Antwort war
/// `true`, obwohl Intel über die CPU-Pipeline läuft, die 10 bit strukturell
/// nicht trägt. Die Zusage war damit auf jeder Intel-Maschine falsch. Jetzt
/// prüft sie denselben Encode-Weg, den [`pruefen`] beim Start prüft
/// ([`VideoCodec::encode_path`]) — dieselbe Disziplin wie `hdr::verfuegbar`
/// nebenan, das ebenfalls fragt, welcher Weg WIRKLICH läuft statt nur, ob
/// irgendein Encoder existiert.
///
/// Hier stand bis zum 2026-08-21 zusätzlich `auffrischung::verfuegbar`. Die
/// Funktion gibt es nicht mehr — mit der Betriebsart ist auch ihre
/// Verfügbarkeitsfrage entfallen; geblieben ist dort nur
/// `auffrischung::braucht_selbsttakt`, und das beantwortet eine andere Frage
/// (ob ein Encoder von sich aus auffrischt).
///
/// `push_url` leer, aus demselben Grund wie dort: die Fähigkeitsmeldung kennt
/// das Ziel noch nicht, und der Regelweg ist der ohne angemeldeten Sendeweg.
pub fn verfuegbar(vendor: &str, codecs: &[String]) -> bool {
    codecs.iter().any(|slug| {
        let codec = VideoCodec::from_slug(slug);
        codec.supports_ten_bit() && codec.encode_path(vendor, "") == EncodePath::D3d11ZeroCopy
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_copy_weg_ist_erlaubt() {
        assert!(pruefen(false, EncodePath::D3d11ZeroCopy).is_ok());
    }

    /// Der nachgemessene Fehler, gegenprobt: der Schalter erzwingt effektiv
    /// den CPU-Weg, auch wenn `pfad` (roh, vor dem Schalter ausgewertet)
    /// D3d11ZeroCopy waere, weil NVIDIA/AMD normalerweise diesen Weg nehmen.
    /// Die Absage muss trotzdem kommen — und den Schalter beim Namen nennen,
    /// nicht nur "CPU-Weg" sagen.
    #[test]
    fn disable_zc_bricht_ab_und_nennt_den_schalter() {
        let fehler = pruefen(true, EncodePath::D3d11ZeroCopy).unwrap_err();
        assert!(fehler.to_string().contains("PULSE_HQ_DISABLE_ZERO_COPY"), "{fehler}");
    }

    #[test]
    fn disable_zc_greift_unabhaengig_vom_rohen_pfad() {
        assert!(pruefen(true, EncodePath::D3d11ZeroCopy).is_err());
        assert!(pruefen(true, EncodePath::Cpu).is_err());
    }

    #[test]
    fn d3d12_weg_bricht_ab_und_nennt_den_gegenprobe_schalter() {
        let fehler = pruefen(false, EncodePath::D3d12ZeroCopy).unwrap_err();
        let text = fehler.to_string();
        assert!(text.contains("D3D12"), "{text}");
        assert!(text.contains("PULSE_HQ_AMD_D3D12"), "{text}");
    }

    #[test]
    fn cpu_weg_bricht_ab() {
        let fehler = pruefen(false, EncodePath::Cpu).unwrap_err();
        assert!(fehler.to_string().contains("CPU-Pipeline"), "{fehler}");
    }

    /// Die Faehigkeitsmeldung verlangt BEIDES: einen Codec, der 10 bit
    /// strukturell traegt (nur AV1), UND einen Weg, der es bei diesem
    /// Hersteller wirklich einloest. Intel hat AV1 im Angebot und trotzdem
    /// keine Zusage — das war genau die falsche Antwort bis zum 2026-08-11.
    #[test]
    fn faehigkeit_verlangt_av1_und_den_zero_copy_weg() {
        assert!(verfuegbar("nvidia", &["av1".to_string()]));
        assert!(verfuegbar("amd", &["av1".to_string()]));
        assert!(!verfuegbar("nvidia", &["h264".to_string()]));
        assert!(!verfuegbar("intel", &["av1".to_string(), "h264".to_string()]));
        // Aus einer gemischten Liste genuegt ein tragender Codec.
        assert!(verfuegbar("nvidia", &["h264".to_string(), "av1".to_string()]));
    }
}
