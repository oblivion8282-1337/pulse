//! Haelt die wortgleichen Teile des Sendewegs gegen die Linux-Fassung.
//!
//! **Warum ein Test und kein Kommentar.** Beim aelteren Paar `zeitbasis.rs`
//! ist eine Abweichung unbemerkt entstanden, weil nur ein Kommentar davor
//! warnte. `include_str!` zieht beide Dateien zur Uebersetzungszeit herein;
//! laufen sie auseinander, wird dieser Test rot und nicht erst der Zuschauer
//! schwarz.
//!
//! **Nur `av1.rs` und `sdp.rs`.** `mod.rs` und `pacer.rs` greifen auf
//! crate-eigene Module zurueck und koennen nicht wortgleich sein; sie tragen
//! stattdessen einen Kopfvermerk.
//!
//! Der Test liegt AUSSERHALB der Zwillinge — laege er darin, machte er sie
//! selbst ungleich.

#[test]
fn av1_ist_wortgleich_mit_linux() {
    let hier = include_str!("../src/whip/av1.rs");
    let dort = include_str!("../../linux-hq-sidecar/src/whip/av1.rs");
    assert_eq!(
        hier, dort,
        "src/whip/av1.rs ist von linux-hq-sidecar/src/whip/av1.rs abgewichen. \
         Wer dort etwas lernt, traegt es hier nach — und umgekehrt."
    );
}

#[test]
fn sdp_ist_wortgleich_mit_linux() {
    let hier = include_str!("../src/whip/sdp.rs");
    let dort = include_str!("../../linux-hq-sidecar/src/whip/sdp.rs");
    assert_eq!(
        hier, dort,
        "src/whip/sdp.rs ist von linux-hq-sidecar/src/whip/sdp.rs abgewichen."
    );
}
