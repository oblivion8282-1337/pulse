//! Tests fuer [`super::fps_takt_zu_rtp_takt`] + [`super::encoder_pts_fuer`].
//!
//! Ausgelagert aus `mod.rs`, damit die Datei die Groessen-Policy (hart 500
//! Zeilen) nicht reisst — Tests sind davon ausgenommen (`PLAN.md` §12.1), ein
//! eigenes Modul unter `encode/` zaehlt dafuer wie eine eigene Testdatei.

use super::{encoder_pts_fuer, fps_takt_zu_rtp_takt};
use crate::zeitbasis::VIDEO_HZ;

/// Glatte Bildraten treffen die 90-kHz-Uhr exakt.
#[test]
fn glatte_bildrate_trifft_exakt() {
    assert_eq!(fps_takt_zu_rtp_takt(0, 60), 0);
    assert_eq!(fps_takt_zu_rtp_takt(1, 60), 1_500);
    assert_eq!(fps_takt_zu_rtp_takt(60, 60), 90_000);
}

/// Krumme Bildraten runden, statt abzuschneiden.
///
/// **Was der Fall wirklich zeigt** (der Kommentar hier stand bis 2026-08-20
/// falsch — er behauptete, 90000*7/280 sei 2250 "gerundet", dabei ist die
/// Zahl EXAKT, hier wird gar nichts gerundet): der Punkt ist die
/// Unterscheidung zwischen "den ABSOLUTEN pts in einem Zug skalieren"
/// (`fps_takt_zu_rtp_takt(7, 280) == 90000*7/280 == 2250`, exakt) und "sieben
/// EINZELNE Pro-Bild-Takte aufsummieren" (`7 * fps_takt_zu_rtp_takt(1, 280)
/// == 7*321 == 2247`, drei Takte daneben — je Bild wird ja tatsaechlich
/// gerundet, s. `fps_takt_zu_rtp_takt(1, 280) == 321` obwohl
/// `90000/280 == 321,43` waere). Diese Funktion arbeitet nach dem ersten,
/// richtigen Muster — absolut aus `pts`, nie akkumulierend —, sonst liefe
/// der Rundungsfehler Bild fuer Bild auf.
#[test]
fn krumme_bildrate_skaliert_absolut_statt_pro_bild_aufzusummieren() {
    assert_eq!(fps_takt_zu_rtp_takt(7, 280), 2_250);
    assert_eq!(7 * fps_takt_zu_rtp_takt(1, 280), 2_247);
    assert_ne!(fps_takt_zu_rtp_takt(7, 280), 7 * fps_takt_zu_rtp_takt(1, 280));

    // 90000/3 = 30000 exakt, aber 90000*2/3 = 60000 exakt — kein guter
    // Testfall fuer Rundung. 90000/7 = 12857,14... — hier zeigt sich's:
    assert_eq!(fps_takt_zu_rtp_takt(1, 7), 12_857); // 12857,14 -> 12857
    assert_eq!(fps_takt_zu_rtp_takt(2, 7), 25_714); // 25714,29 -> 25714
}

/// `fps=0` darf nicht durch Null teilen — geklemmt auf 1.
#[test]
fn null_fps_teilt_nicht_durch_null() {
    assert_eq!(fps_takt_zu_rtp_takt(1, 0), i64::from(VIDEO_HZ));
}

/// Ein Sekundentakt ergibt immer die volle 90-kHz-Uhr, unabhaengig von der
/// Bildrate.
#[test]
fn ein_sekundentakt_ergibt_die_volle_uhr() {
    assert_eq!(fps_takt_zu_rtp_takt(30, 30), i64::from(VIDEO_HZ));
}

/// **G-4.** Ein echter Halbfall (`90000*1/32 = 2812,5` exakt) rundet nach
/// OBEN, nicht nach unten — die Rundungszugabe ist das volle `fps/2`
/// (`(2*pts*hz + fps) / (2*fps)`), nicht die fuer ungerade `fps` abgerundete
/// Ganzzahl `fps/2`, die einen Halbfall eine halbe Ganzzahl zu knapp
/// verfehlt haette.
#[test]
fn halbfall_rundet_auf() {
    assert_eq!(fps_takt_zu_rtp_takt(1, 32), 2_813);
}

/// **W-2(a).** Nachweis ueber einen LANGEN Horizont — das schliesst aus, was
/// "nach einer Stunde sichtbar weg" waere: eine glatte Bildrate bleibt über
/// eine volle Stunde exakt, eine krumme bleibt über 100 000 Bilder (bei
/// 280 fps > 5 Minuten) auf plus/minus einen RTP-Takt am mathematisch
/// exakten Wert — kein Wegdriften durch akkumulierten Rundungsfehler, weil
/// `fps_takt_zu_rtp_takt` absolut skaliert (s.
/// `krumme_bildrate_skaliert_absolut_statt_pro_bild_aufzusummieren`).
#[test]
fn bleibt_ueber_einen_langen_horizont_am_exakten_wert() {
    assert_eq!(fps_takt_zu_rtp_takt(60 * 60 * 60, 60), 60 * 60 * 90_000);

    let fps: i64 = 280;
    for pts in 0..100_000i64 {
        let exakt = (pts as f64) * f64::from(VIDEO_HZ) / (fps as f64);
        let ist = fps_takt_zu_rtp_takt(pts, fps as u32);
        assert!((ist as f64 - exakt).abs() <= 1.0, "pts={pts}: ist={ist}, exakt={exakt}");
    }
}

/// **W-2(b).** Monotonie: ein spaeteres Bild bekommt IMMER einen spaeteren
/// RTP-Zeitstempel — fuer jede plausible Bildrate von 1 bis 1000 fps (der
/// geclampte Bereich aus `ops/start.rs`).
#[test]
fn ist_monoton_fuer_jede_plausible_bildrate() {
    for fps in 1..=1000u32 {
        for pts in 0..500i64 {
            assert!(
                fps_takt_zu_rtp_takt(pts + 1, fps) > fps_takt_zu_rtp_takt(pts, fps),
                "fps={fps}, pts={pts}: t(n+1) muss > t(n) sein"
            );
        }
    }
}

/// **W-2(d).** Der Muxer-Weg rechnet NICHT um — bisher nur am manuellen
/// RTMPS-Rauchtest belegt, jetzt automatisch bewacht. Wichtig fuer Netze,
/// die UDP (und damit WHIP) sperren: dieser Zweig ist dort der einzige Weg
/// ueberhaupt.
#[test]
fn muxer_weg_rechnet_nicht_um() {
    for fps in [1u32, 7, 30, 60, 280, 1000] {
        for pts in [0i64, 1, 42, 1_000_000] {
            assert_eq!(encoder_pts_fuer(false, pts, fps), pts);
        }
    }
}

/// Der WHIP-Weg rechnet um — identisch zu [`fps_takt_zu_rtp_takt`].
#[test]
fn whip_weg_rechnet_um() {
    assert_eq!(encoder_pts_fuer(true, 7, 280), fps_takt_zu_rtp_takt(7, 280));
}
