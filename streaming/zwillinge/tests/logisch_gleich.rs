//! Paare, deren LOGIK gleich sein muss, deren Kommentare aber abweichen duerfen.
//!
//! **Warum Kommentare abweichen duerfen — und muessen.** Bei `zeitbasis.rs`
//! verweisen sie auf plattformeigene Module: `crate::tick_monitor` unter
//! Windows, `stream_controller.rs` unter Linux. Ein byte-genauer Test wuerde
//! dazu verleiten, eine Falschaussage nachzuziehen, nur damit er gruen wird.
//!
//! Fuer Paare, die zeichengenau gleich sein muessen, ist `bitgleich.rs`
//! zustaendig.

use zwillinge::ohne_kommentare;

/// `whip/av1.rs` — der eigene AV1-Paketierer.
///
/// Er umgeht einen dokumentierten Fehler in webrtc-rs' `Av1Payloader`
/// (Laengenfelder ab 128 falsch geschrieben). Laufen die Fassungen
/// auseinander, sendet eine Plattform Pakete, die der Zuschauer nicht
/// zusammensetzen kann — und das faellt erst am schwarzen Bild auf.
///
/// Am 2026-08-20 gemessen: 496 Codezeilen je Seite, null Abweichung. Die
/// acht Rohzeilen Unterschied sind ein Doc-Absatz an anderer Stelle.
#[test]
fn av1_win_gleich_linux() {
    let win = include_str!("../../win-hq-sidecar/src/whip/av1.rs");
    let linux = include_str!("../../linux-hq-sidecar/src/whip/av1.rs");
    assert_eq!(
        ohne_kommentare(win),
        ohne_kommentare(linux),
        "whip/av1.rs ist in der LOGIK abgewichen (Kommentare duerfen abweichen)."
    );
}

/// `zeitbasis.rs` — die RTP-Taktrechnung.
///
/// **Die Stelle, an der es schon einmal passiert ist**: am 2026-08-17 liefen
/// die beiden Fassungen unbemerkt auseinander. Folgenlos nur durch Zufall, weil
/// es Kommentarzeilen traf. Genau dieser Test haette es gemeldet.
#[test]
fn zeitbasis_win_gleich_linux() {
    let win = include_str!("../../win-hq-sidecar/src/zeitbasis.rs");
    let linux = include_str!("../../linux-hq-sidecar/src/zeitbasis.rs");
    assert_eq!(
        ohne_kommentare(win),
        ohne_kommentare(linux),
        "zeitbasis.rs ist in der LOGIK abgewichen. Encoder-Uhr und RTP-Uhr \
         muessen auf allen Plattformen dieselbe sein."
    );
}

/// `proto.rs` — das stdio-JSON-RPC-Rahmenformat zwischen Electron und Sidecar.
///
/// Nur win gegen mac: die Linux-Fassung ist echt verschieden (80 gegen 47
/// Codezeilen) und kein Zwilling.
#[test]
fn proto_win_gleich_mac() {
    let win = include_str!("../../win-hq-sidecar/src/proto.rs");
    let mac = include_str!("../../mac-hq-sidecar/src/proto.rs");
    assert_eq!(
        ohne_kommentare(win),
        ohne_kommentare(mac),
        "proto.rs ist in der LOGIK abgewichen. Beide Seiten sprechen dasselbe \
         Protokoll mit demselben Electron-Wirt."
    );
}

/// `events.rs` — die Ereignis-Ausgabe auf stdout.
///
/// Nur linux gegen mac: die win-Fassung weicht in vier Codezeilen ab und ist
/// damit Klasse C (s. README dieser Crate).
#[test]
fn events_linux_gleich_mac() {
    let linux = include_str!("../../linux-hq-sidecar/src/events.rs");
    let mac = include_str!("../../mac-hq-sidecar/src/events.rs");
    assert_eq!(
        ohne_kommentare(linux),
        ohne_kommentare(mac),
        "events.rs ist in der LOGIK abgewichen."
    );
}
