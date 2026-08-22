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

// `whip/av1.rs` — der eigene AV1-Paketierer.
//
// War hier bis zum 2026-08-20 ein Zwillingstest (`av1_win_gleich_linux`,
// 496 Codezeilen je Seite, null logische Abweichung — die acht Rohzeilen
// Unterschied waren ein Doc-Absatz an anderer Stelle). Win/linux/mac sind
// seit dem 2026-08-20 alle nur noch ein Re-Export aus der gemeinsamen Crate
// `streaming/pulse-whip` — ein Vergleich zweier Einzeiler haette keinen
// Erkenntniswert mehr. Die eigentliche Logik samt ihrer Tests steht jetzt in
// `pulse-whip/src/av1.rs`.

// `zeitbasis.rs` — die RTP-Taktrechnung.
//
// War hier bis zum 2026-08-20 ein Zwillingstest (`zeitbasis_win_gleich_linux`,
// gefunden anlaesslich des Auseinanderlaufens vom 2026-08-17). Win und linux
// sind seit dem 2026-08-20 beide nur noch ein Re-Export aus der gemeinsamen
// Crate `streaming/pulse-zeitbasis` — ein Vergleich zweier Einzeiler haette
// keinen Erkenntniswert mehr. Die eigentliche Logik samt ihrer Tests steht
// jetzt in `pulse-zeitbasis/src/lib.rs`.

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
