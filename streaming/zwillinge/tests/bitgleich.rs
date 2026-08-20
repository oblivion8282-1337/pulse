//! Paare, die ZEICHEN FUER ZEICHEN gleich sein muessen.
//!
//! Fuer Paare, deren Kommentare berechtigt abweichen (weil sie auf
//! plattformeigene Module verweisen), ist `logisch_gleich.rs` zustaendig.

/// `whip/sdp.rs` — das SDP-Angebot des eigenen WebRTC-Sendewegs.
///
/// Am 2026-08-20 gemessen: byte-identisch zwischen Windows und Linux. Hier
/// darf nichts abweichen, auch kein Kommentar — die Datei enthaelt die
/// ausgehandelten Codec-Fassungen und Profil-Stufen, und eine Abweichung
/// zwischen zwei Sendern zeigt sich erst in der SDP-Verhandlung beim
/// Zuschauer.
#[test]
fn sdp_win_gleich_linux() {
    let win = include_str!("../../win-hq-sidecar/src/whip/sdp.rs");
    let linux = include_str!("../../linux-hq-sidecar/src/whip/sdp.rs");
    assert_eq!(
        win, linux,
        "whip/sdp.rs ist zwischen win-hq-sidecar und linux-hq-sidecar abgewichen. \
         Wer an einem etwas lernt, traegt es am anderen nach."
    );
}

/// `ops/state.rs` — die Zustandsabfrage des Sidecars.
///
/// Am 2026-08-20 gemessen: byte-identisch zwischen Linux und macOS.
#[test]
fn ops_state_linux_gleich_mac() {
    let linux = include_str!("../../linux-hq-sidecar/src/ops/state.rs");
    let mac = include_str!("../../mac-hq-sidecar/src/ops/state.rs");
    assert_eq!(
        linux, mac,
        "ops/state.rs ist zwischen linux-hq-sidecar und mac-hq-sidecar abgewichen."
    );
}
