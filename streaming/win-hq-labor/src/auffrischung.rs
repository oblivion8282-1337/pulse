//! Intra-Refresh auf dem herstellereigenen Weg einschalten.
//!
//! **Warum das hier steht und nicht im Encoder.** Der ausgelieferte Sidecar
//! setzt die Auffrischungs-Optionen nicht — und er wird für eine Labormessung
//! nicht angefasst (Laborordnung, „Niemals"). Er liest sie aber aus
//! `PULSE_ENCODER_OPTS`, und diese Naht gab es schon; sie ist ausdrücklich
//! dafür gebaut, eine Encoder-Einstellung ohne Neubau vergleichen zu können.
//!
//! **Jeder Encoder nennt die Option anders**, und ein Name vom Nachbarn misst
//! nichts — genau daher kam der Fehlschluss „AMF kann kein Intra-Refresh":
//!
//! | Codec | Encoder | Option |
//! |---|---|---|
//! | AV1 | `av1_amf` | `intra_refresh_mode=gop_aligned` + `intra_refresh_stripes` |
//! | H.264 | `h264_amf` | **nichts** — `usage=ultralowlatency` frischt schon auf |
//!
//! Bei H.264 wäre `intra_refresh_mb` die passende Option, aber sie schaltet
//! nichts mehr ein: der Sidecar setzt `usage=ultralowlatency` aus Last-Gründen,
//! und das bringt die Auffrischung von sich aus mit (gemessen 2026-08-02: fünf
//! Vollbilder werden zu einem). Sie hier trotzdem zu setzen hieße, an einem
//! laufenden Zyklus zu drehen, ohne dass jemand einen Grund dafür gemessen hat.
//!
//! **`av1_amf` braucht den Schalter dagegen ausdrücklich** — dort ändert
//! `usage` nichts, das ist am Messstand gegengeprüft (sechs Vollbilder mit
//! derselben Einstellung).

use pulse_win_hq_sidecar::profiles::BASELINE;
use pulse_win_hq_sidecar::proto::Request;

/// Die Optionsliste für diesen `start`-Auftrag, oder `None`, wenn nichts zu
/// setzen ist.
///
/// Getrennt von [`vorbereiten`], weil nur so etwas zu prüfen ist: das Setzen
/// selbst ist eine Wirkung auf den ganzen Prozess und im Test nicht ohne
/// Nebenwirkung zu haben.
///
/// **Die Vorgaben kommen aus [`BASELINE`], nicht von hier.** Sie hier zu raten
/// wäre die Sorte zweite Wahrheit, die auseinanderläuft: ein Auftrag ohne
/// `codec` fährt im Sidecar H.264, und wer hier AV1 annimmt, schickt einem
/// H.264-Encoder AV1-Schlüssel — samt Warnung bei jedem gesunden Lauf.
fn optionen_fuer(zeile: &str) -> Option<String> {
    // Denselben Leser wie der Dispatcher benutzen, statt `op` von Hand aus einem
    // rohen `Value` zu klauben — zwei Leser desselben Drahtformats sind einer
    // zu viel.
    let req: Request = serde_json::from_str(zeile).ok()?;
    if req.op != "start" {
        return None;
    }
    let ov = req.params.get("overrides");
    let codec = ov
        .and_then(|o| o.get("codec"))
        .and_then(|c| c.as_str())
        .unwrap_or(BASELINE.codec);
    if codec != "av1" {
        return None;
    }
    // Der Zyklus in Bildern. `gop_aligned` richtet ihn ohnehin am GOP aus, und
    // wie genau die Streifenzahl darauf wirkt, ist NICHT verstanden (60 verhielt
    // sich wie 30, Messakte). Die Bildrate ist der Wert, mit dem gemessen wurde.
    let fps = ov
        .and_then(|o| o.get("fps"))
        .and_then(|f| f.as_u64())
        .filter(|f| *f > 0)
        .unwrap_or(u64::from(BASELINE.fps));
    Some(format!("intra_refresh_mode=gop_aligned,intra_refresh_stripes={fps}"))
}

/// Vor dem Weiterreichen eines Auftrags aufrufen.
///
/// Tut nichts, wenn der Vulkan-Weg läuft (der setzt seine Optionen selbst),
/// wenn die Auffrischung ausdrücklich abgeschaltet ist, oder wenn
/// `PULSE_ENCODER_OPTS` schon steht — **eine Angabe von außen sticht immer**,
/// sonst wäre eine Messreihe über diese Variable nicht mehr zu fahren. Weil der
/// erste `start` die Variable selbst setzt, sticht danach auch die eigene
/// Vorgabe: gesetzt ist gesetzt.
///
/// **Und nichts, solange ein Strom läuft.** Das Schreiben in die Umgebung wäre
/// dann parallel zu FFmpegs `getenv` auf einer lebenden Pipeline. Der Fall ist
/// real erreichbar — ein zweiter `start` kommt hier vorbei, *bevor* der
/// Controller ihn ablehnt.
pub fn vorbereiten(zeile: &str) {
    if pulse_win_hq_sidecar::env::flag("PULSE_LABOR_VULKAN")
        || pulse_win_hq_sidecar::env::flag("PULSE_LABOR_KEIN_IR")
        || std::env::var_os("PULSE_ENCODER_OPTS").is_some()
        || pulse_win_hq_sidecar::stream_controller::StreamController::singleton()
            .state()
            .running
    {
        return;
    }
    let Some(opts) = optionen_fuer(zeile) else {
        return;
    };
    // SAFETY: kein Strom laeuft (oben geprueft), also gibt es keinen
    // Encoder-Faden, der die Umgebung gleichzeitig liest.
    unsafe { std::env::set_var("PULSE_ENCODER_OPTS", &opts) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn av1_bekommt_die_auffrischung_mit_der_bildrate() {
        let o = optionen_fuer(r#"{"op":"start","overrides":{"codec":"av1","fps":60}}"#).unwrap();
        assert_eq!(o, "intra_refresh_mode=gop_aligned,intra_refresh_stripes=60");
    }

    /// **Ohne Angabe gilt die Vorgabe des Sidecars, nicht die des Labors.**
    /// Die ist H.264 — es gibt also nichts zu setzen. Waere hier AV1 geraten,
    /// bekaeme ein H.264-Encoder AV1-Schluessel, und der Sidecar warnte bei
    /// jedem gesunden Lauf.
    #[test]
    fn ohne_angaben_gilt_die_baseline() {
        assert_eq!(BASELINE.codec, "h264", "sonst zielt dieser Test ins Leere");
        assert!(optionen_fuer(r#"{"op":"start"}"#).is_none());
    }

    /// Und die Bildrate ebenso — `fps: 0` filtert `ops::start` auf die Vorgabe
    /// zurueck, ein `stripes=1` waere die Folge einer zweiten Rechnung hier.
    #[test]
    fn fehlende_oder_leere_bildrate_nimmt_die_baseline() {
        for zeile in [
            r#"{"op":"start","overrides":{"codec":"av1"}}"#,
            r#"{"op":"start","overrides":{"codec":"av1","fps":0}}"#,
        ] {
            let o = optionen_fuer(zeile).unwrap();
            assert!(o.ends_with(&format!("stripes={}", BASELINE.fps)), "{o}");
        }
    }

    /// **H.264 darf NICHTS bekommen.** `h264_amf` kennt die AV1-Schluessel
    /// nicht; ffmpeg verwuerfe sie still, und der Sidecar warnte bei jedem
    /// gesunden Lauf. Eine Warnung, die im gesunden Fall feuert, erzieht dazu,
    /// Warnungen zu ueberlesen.
    #[test]
    fn h264_bekommt_nichts() {
        assert!(optionen_fuer(r#"{"op":"start","overrides":{"codec":"h264"}}"#).is_none());
    }

    #[test]
    fn andere_auftraege_bleiben_unberuehrt() {
        assert!(optionen_fuer(r#"{"op":"stop","id":2}"#).is_none());
        assert!(optionen_fuer("kein JSON").is_none());
    }
}
