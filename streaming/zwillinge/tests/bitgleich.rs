//! Paare, die ZEICHEN FUER ZEICHEN gleich sein muessen.
//!
//! Fuer Paare, deren Kommentare berechtigt abweichen (weil sie auf
//! plattformeigene Module verweisen), ist `logisch_gleich.rs` zustaendig.

// `whip/sdp.rs` — das SDP-Angebot des eigenen WebRTC-Sendewegs.
//
// War hier bis zum 2026-08-20 ein Zwillingstest (`sdp_win_gleich_linux`,
// dreimal bitgleich zwischen win/linux/mac). Alle drei Fassungen sind seit
// dem 2026-08-20 nur noch ein Re-Export aus der gemeinsamen Crate
// `streaming/pulse-whip` — ein Vergleich zweier Einzeiler haette keinen
// Erkenntniswert mehr. Die eigentliche Logik samt ihrer Tests steht jetzt in
// `pulse-whip/src/sdp.rs`.

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

// `zeigerbild.rs` — das Bildformat der Zeigeruebertragung.
//
// War hier bis zum 2026-08-20 ein Zwillingstest
// (`zeigerbild_liegt_im_sidecar_wortgleich`, player-win, 499 Zeilen bitgleich).
// Beide Fassungen sind seit dem 2026-08-20 nur noch ein Re-Export aus der
// gemeinsamen Crate `streaming/pulse-zeigerbild` — ein Vergleich zweier
// Einzeiler haette keinen Erkenntniswert mehr. Die eigentliche Logik samt
// ihrer Tests steht jetzt in `pulse-zeigerbild/src/lib.rs`.

// ── Uebernommen am 2026-08-21 aus `pulse-player/tests/zwillinge.rs` ──────────
// Jene Datei hielt drei Paare zusammen. Zwei davon — `zeigerbild.rs` und
// `bildmarke.rs` — liegen seither in gemeinsamen Kisten (`pulse-zeigerbild`,
// `pulse-bildmarke`) und brauchen keinen Vergleich mehr. Der dritte gilt
// weiter: der Pruefstein ist eine DATEI, keine Kiste, und wird bewusst an zwei
// Orten gehalten — der MediaMTX-Fork baut ohne dieses Repo. Er wandert deshalb
// hierher, statt mit seiner Datei zu verschwinden.

/// Der Pruefstein, gegen den Sender und Fork gleichermassen pruefen.
#[test]
fn pruefstein_liegt_im_mediamtx_fork_wortgleich() {
    const SENDER: &str = include_str!("../../bildmarke-formen.json");
    const FORK: &str = include_str!("../../../infra/mediamtx-fork/bildmarke-formen.json");
    assert_eq!(
        SENDER, FORK,
        "streaming/bildmarke-formen.json und \
         infra/mediamtx-fork/bildmarke-formen.json sind auseinandergelaufen. \
         Der Sender erzeugt die Datei — die Kopie im Fork zieht nach, nie umgekehrt: \
         cp streaming/bildmarke-formen.json infra/mediamtx-fork/",
    );
}
