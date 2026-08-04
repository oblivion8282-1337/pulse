//! Rollender Intra-Refresh statt periodischer Vollbilder — die Betriebsart und
//! ihre Optionsnamen, je Encoder.
//!
//! Gegenstück zu den `intra_refresh_*`-Funktionen in
//! `streaming/linux-hq-sidecar/src/encode/opts.rs`. Der Wunsch kommt von
//! derselben Stelle (`overrides.intra_refresh`, ersatzweise
//! `PULSE_INTRA_REFRESH=1`) und die Grundregel ist dieselbe: **fällt die
//! Betriebsart aus, wird der Start verweigert.** Ein Keyframe-Strom, der unter
//! dem Etikett „Intra-Refresh" weiterläuft, ist keine Messung, die scheitert,
//! sondern eine, die täuscht.
//!
//! **Der Unterschied zu Linux liegt darin, woran die Antwort hängt.** Dort
//! genügt es zu fragen, ob das gelinkte FFmpeg die Option kennt — auf VAAPI
//! gibt es sie nur mit unserem Patch, auf NVENC immer, und wo sie da ist, wirkt
//! sie auch. Unter Windows stimmt das nicht: `h264_d3d12va` **nimmt die Option
//! an** und tut nichts damit (2026-08-02 gemessen: der Strom ändert sich um
//! 0,47 Prozent, und weder `constrained_intra_pred_flag` noch ein recovery
//! point tauchen auf). Eine Abfrage der Optionstabelle würde hier also „ja"
//! sagen und läge falsch. Deshalb entscheidet unten eine Tabelle aus Messungen,
//! nicht eine Abfrage.
//!
//! **Drei Encoder, drei Optionsnamen** — einen Namen vom Nachbarn zu übernehmen
//! misst nichts, und genau daher kam der Fehlschluss „AMF kann kein
//! Intra-Refresh" (`-intra_refresh` gibt es bei `av1_amf` nicht, die Option
//! heißt dort anders). Messakte
//! `streaming/testbench/profiles/amf-2026-08-02-intra-refresh-doch.json`.

use anyhow::{Result, bail};
use ffmpeg_next::Dictionary;

use super::encoder::{EncodePath, VideoCodec};

/// Wunsch aus den Start-Parametern. `UNGESAGT` = nichts gesagt, dann
/// entscheidet die Umgebungsvariable.
///
/// Prozessweit statt als Feld in der Encoder-Konfiguration, aus demselben Grund
/// wie im Linux-Sidecar: die Frage wird an vier Stellen gestellt (drei
/// Encoder-Wege plus die Fähigkeitsmeldung), und ein durchgereichtes Feld, das
/// an einer davon vergessen wird, liefe still in der falschen Betriebsart.
static AUS_PARAMETERN: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(UNGESAGT);

const UNGESAGT: u8 = 0;
const AUS: u8 = 1;
const AN: u8 = 2;

/// Den Wunsch der Oberfläche hinterlegen. `ops::start` ruft das einmal je
/// Stream, bevor ein Encoder geöffnet wird.
pub fn setzen(an: bool) {
    AUS_PARAMETERN.store(if an { AN } else { AUS }, std::sync::atomic::Ordering::Relaxed);
}

/// Rollender Intra-Refresh statt periodischer Vollbilder?
///
/// Quelle ist der Wunsch aus den Start-Parametern (`overrides.intra_refresh`);
/// ohne ihn `PULSE_INTRA_REFRESH=1`. Die Variable bleibt, weil der Messstand
/// den Sidecar direkt fährt, ohne Oberfläche — und sie heißt bewusst genauso
/// wie auf Linux, damit ein Prüfstand-Skript auf beiden Plattformen dasselbe
/// tut.
pub fn gewuenscht() -> bool {
    match AUS_PARAMETERN.load(std::sync::atomic::Ordering::Relaxed) {
        AN => true,
        AUS => false,
        _ => crate::env::flag("PULSE_INTRA_REFRESH"),
    }
}

/// Was dieser Encoder für rollenden Intra-Refresh braucht.
///
/// * `None` — **dieser Encoder kann es nicht.** Nicht „braucht nichts".
/// * `Some(&[])` — er frischt bereits von sich aus auf, es ist nichts zu setzen.
/// * `Some(liste)` — diese Schlüssel setzen; `{fps}` wird durch die Bildrate
///   ersetzt.
///
/// Die Unterscheidung zwischen den ersten beiden Fällen ist der ganze Zweck der
/// Funktion: bei `h264_amf` ist „keine Option" die richtige Antwort, bei
/// `h264_d3d12va` wäre sie eine Lüge.
fn optionen_fuer(encoder: &str) -> Option<&'static [(&'static str, &'static str)]> {
    match encoder {
        // Upstream-Option, dieselbe wie auf Linux+NVENC — dort gemessen
        // (1,4 statt 48,7 Prozent gestörte Sekunden bei gleicher Datenrate).
        //
        // `no-scenecut` gehört dazu: ohne die Option schiebt NVENC bei
        // Szenenwechseln von sich aus I-Bilder ein — mitten in einen Strom, der
        // gerade KEINE haben soll, und bei fester Bitrate ist jedes davon ein
        // sichtbarer Ausschlag. `forced-idr` setzt `opts::vendor_encoder_opts`
        // bereits unbedingt.
        //
        // **Auf Windows+NVIDIA nicht nachgemessen.** Es ist derselbe
        // ffmpeg-Encoder wie unter Linux, deshalb steht die Option hier — aber
        // die Messung stammt von dort, und das gehört dazugesagt.
        "h264_nvenc" | "hevc_nvenc" | "av1_nvenc" => {
            Some(&[("intra-refresh", "1"), ("no-scenecut", "1")])
        }
        // **`av1_amf` braucht den Schalter ausdrücklich**, und er heißt nicht
        // `intra_refresh`. Mit `gop_aligned` ersetzt AMF die periodischen
        // Vollbilder wirklich: bei `-g 60` über 300 Bilder kommt **eines** statt
        // fünf, die Bitmenge bleibt gleich und verteilt sich, statt in Stößen
        // anzufallen. Gilt für 8 wie für 10 Bit, das 10-Bit-Bild ist dabei
        // einwandfrei. `continuous` (Modus 2) nimmt der Treiber an und tut
        // nichts damit.
        //
        // Die **Streifenzahl** steht auf der Bildrate, weil damit gemessen
        // wurde. Wie genau sie wirkt, ist NICHT verstanden — 60 verhielt sich
        // wie 30, und `gop_aligned` richtet den Zyklus ohnehin am GOP aus. Wer
        // hier dreht, misst nach; ein geratener Wert wäre eine zweite Wahrheit
        // neben der einen gemessenen.
        "av1_amf" => Some(&[("intra_refresh_mode", "gop_aligned"), ("intra_refresh_stripes", "{fps}")]),
        // **Läuft längst, unbemerkt.** `usage=lowlatency` und `ultralowlatency`
        // bringen die Auffrischung bei `h264_amf` von sich aus mit (fünf
        // Vollbilder werden zu einem, verteilte Intra-Last statt Stöße), und
        // `usage=ultralowlatency` setzt `opts::vendor_encoder_opts` seit dem
        // 2026-07-30 aus Last-Gründen. Der Strom heilt sich danach sogar ohne
        // jede Anforderung — anders als AV1 über denselben Messstand.
        //
        // Die eigentliche Option hieße `intra_refresh_mb <Makroblöcke>` und
        // drehte nur noch am laufenden Zyklus. Sie hier zu setzen hieße, an
        // einem funktionierenden Zyklus zu drehen, ohne dass jemand einen Grund
        // dafür gemessen hat. Messakte
        // `amd-2026-08-02-h264-intra-refresh.json`.
        "h264_amf" => Some(&[]),
        // Alles andere: nein, und zwar begründet.
        //
        // * `*_d3d12va` — `av1_d3d12va` bricht mit Intra-Refresh sofort ab;
        //   `h264_d3d12va` nimmt `intra_refresh_mode row_based` an, ändert den
        //   Strom um 0,47 Prozent und setzt weder `constrained_intra_pred_flag`
        //   noch einen recovery point. Das ist der Regelweg für H.264 auf AMD,
        //   deshalb steht die Absage hier und nicht als Randnotiz.
        // * `*_qsv` — die Option gibt es dort nur bei HEVC (`int_ref_type`),
        //   nicht bei `h264_qsv`/`av1_qsv`. HEVC wird ausgebaut.
        // * `hevc_amf` — ungemessen. Kein Grund, es zu behaupten.
        _ => None,
    }
}

/// Der Encoder, den ein Stream mit dieser Kombination wirklich öffnen würde.
///
/// Nicht `VideoCodec::ffmpeg_name` allein: unter Windows hängt der Name am
/// **Encode-Weg**, und der ist bei AMD je Codec ein anderer (AV1 über AMF,
/// H.264 über D3D12). Wer hier den Herstellernamen nähme, meldete für H.264 auf
/// AMD eine Fähigkeit, die der tatsächlich laufende Encoder nicht hat.
///
/// `push_url` leer: die Fähigkeitsmeldung kennt das Ziel noch nicht, und der
/// Regelweg ist der ohne angemeldeten Sendeweg.
pub fn encoder_name(vendor: &str, codec: VideoCodec, push_url: &str) -> Option<&'static str> {
    match codec.encode_path(vendor, push_url) {
        EncodePath::D3d12ZeroCopy => Some(codec.d3d12va_name()),
        _ => codec.ffmpeg_name(vendor).ok(),
    }
}

/// Trägt diese Maschine die Betriebsart mit mindestens einem ihrer Codecs?
///
/// Das ist die Frage, die `health.gsr.intra_refresh` beantwortet, und sie ist
/// bewusst großzügig: die Oberfläche soll das Kästchen anbieten, sobald es
/// einen Weg dorthin gibt. Welcher Codec ihn trägt, entscheidet sich erst beim
/// Start — und wenn der gewählte ihn nicht trägt, sagt [`pruefen`] das mit
/// klarer Meldung, statt still Keyframes zu fahren.
pub fn verfuegbar(vendor: &str, codecs: &[String]) -> bool {
    codecs.iter().any(|slug| {
        encoder_name(vendor, VideoCodec::from_slug(slug), "")
            .is_some_and(|name| optionen_fuer(name).is_some())
    })
}

/// Die Optionen für diesen Encoder eintragen — oder den Start verweigern.
///
/// Einmal je Encoder-Open aufrufen, nachdem die Vendor-Optionen stehen und
/// **bevor** geöffnet wird. Ist die Betriebsart nicht verlangt, passiert
/// nichts.
///
/// **Warum hier ein Fehler steht, wo `output::warn_unknown_opts` nur warnt:**
/// eine unbekannte Option aus `PULSE_ENCODER_OPTS` ist die Eingabe des
/// Messenden und soll ihn nicht am Streamen hindern. Intra-Refresh dagegen ist
/// die Betriebsart selbst — fällt sie aus, läuft ein Keyframe-Strom unter ihrem
/// Etikett weiter.
pub fn anwenden(opts: &mut Dictionary<'_>, encoder: &str, fps: u32) -> Result<()> {
    if !gewuenscht() {
        return Ok(());
    }
    let Some(liste) = optionen_fuer(encoder) else {
        bail!(
            "Intra-Refresh verlangt, aber '{encoder}' liefert ihn nicht. \
             Auf AMD trägt ihn AV1 (über av1_amf), H.264 nur über den \
             AMF-Weg (PULSE_HQ_AMD_D3D11=1) — der Regelweg h264_d3d12va nimmt \
             die Option an und tut nichts damit. Begründung je Encoder: \
             encode/auffrischung.rs"
        );
    };
    let fps = fps.to_string();
    for (key, wert) in liste {
        opts.set(key, &wert.replace("{fps}", &fps));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der Zustand ist prozessweit — die Tests stellen ihn deshalb jeweils
    /// selbst ein und am Ende zurück.
    fn mit_wunsch<T>(an: bool, f: impl FnOnce() -> T) -> T {
        setzen(an);
        let r = f();
        AUS_PARAMETERN.store(UNGESAGT, std::sync::atomic::Ordering::Relaxed);
        r
    }

    #[test]
    fn av1_amf_bekommt_die_auffrischung_mit_der_bildrate() {
        mit_wunsch(true, || {
            let mut opts = Dictionary::new();
            anwenden(&mut opts, "av1_amf", 60).unwrap();
            assert_eq!(opts.get("intra_refresh_mode"), Some("gop_aligned"));
            assert_eq!(opts.get("intra_refresh_stripes"), Some("60"));
        });
    }

    /// **`h264_amf` darf NICHTS bekommen** — `usage=ultralowlatency` bringt die
    /// Auffrischung mit. Die AV1-Schlüssel kennt der Encoder nicht; ffmpeg
    /// verwürfe sie still, und `warn_unknown_opts` feuerte bei jedem gesunden
    /// Lauf. Eine Warnung, die im gesunden Fall feuert, erzieht dazu, Warnungen
    /// zu überlesen.
    #[test]
    fn h264_amf_bekommt_nichts_und_scheitert_trotzdem_nicht() {
        mit_wunsch(true, || {
            let mut opts = Dictionary::new();
            anwenden(&mut opts, "h264_amf", 60).unwrap();
            assert_eq!(opts.get("intra_refresh_mode"), None);
            assert_eq!(opts.get("intra_refresh_mb"), None);
        });
    }

    /// Der Fall, um den es geht: der Encoder nimmt die Option an und tut nichts
    /// damit. Ein stiller Keyframe-Lauf unter dem Etikett „Intra-Refresh" ist
    /// schlimmer als ein abgelehnter Start.
    #[test]
    fn d3d12va_verweigert_statt_still_keyframes_zu_fahren() {
        mit_wunsch(true, || {
            let mut opts = Dictionary::new();
            let fehler = anwenden(&mut opts, "h264_d3d12va", 60).unwrap_err();
            assert!(fehler.to_string().contains("h264_d3d12va"), "{fehler}");
        });
    }

    #[test]
    fn ohne_wunsch_bleibt_alles_unberuehrt() {
        mit_wunsch(false, || {
            let mut opts = Dictionary::new();
            // Auch der Encoder, der es gar nicht kann, darf dann nicht stören.
            anwenden(&mut opts, "h264_d3d12va", 60).unwrap();
            anwenden(&mut opts, "av1_amf", 60).unwrap();
            assert_eq!(opts.get("intra_refresh_mode"), None);
        });
    }

    /// AMD kann es — aber nur über AV1. Genau diese Unterscheidung geht
    /// verloren, wenn die Fähigkeit am Herstellernamen statt am Encode-Weg
    /// hängt: `ffmpeg_name("amd", H264)` ist `h264_amf` und könnte es, der
    /// tatsächlich laufende `h264_d3d12va` nicht.
    #[test]
    fn amd_meldet_die_faehigkeit_ueber_av1_nicht_ueber_h264() {
        assert_eq!(encoder_name("amd", VideoCodec::Av1, ""), Some("av1_amf"));
        assert_eq!(encoder_name("amd", VideoCodec::H264, ""), Some("h264_d3d12va"));
        assert!(verfuegbar("amd", &["av1".to_string()]));
        assert!(!verfuegbar("amd", &["h264".to_string()]));
        assert!(verfuegbar("amd", &["h264".to_string(), "av1".to_string()]));
    }

    #[test]
    fn nvidia_kann_es_immer_intel_nie() {
        assert!(verfuegbar("nvidia", &["h264".to_string()]));
        assert!(verfuegbar("nvidia", &["av1".to_string()]));
        assert!(!verfuegbar("intel", &["h264".to_string(), "av1".to_string()]));
    }
}
