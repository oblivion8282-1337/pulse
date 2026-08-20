//! Paare, die ZEICHEN FUER ZEICHEN gleich sein muessen.
//!
//! Fuer Paare, deren Kommentare berechtigt abweichen (weil sie auf
//! plattformeigene Module verweisen), ist `logisch_gleich.rs` zustaendig.
//!
//! **Der Zeigerbild-Fall (`zeigerbild_liegt_im_sidecar_wortgleich`).**
//! `src/zeigerbild.rs` beschreibt das Bildformat der Zeigeruebertragung: der
//! Sidecar packt, der Player entpackt. Beide Enden muessen sich Byte fuer Byte
//! einig sein, und eine Beschreibung in zwei Fassungen laeuft auseinander —
//! deshalb liegt sie zweimal identisch da statt zweimal aehnlich.
//!
//! **Warum ein Test und nicht nur ein Kommentar.** Genau diese Zusage gibt es
//! im Repo schon einmal, fuer `zeitbasis.rs` in den beiden Sidecars, und dort
//! stand sie allein in der Dokumentation. Am 2026-08-17 wichen die beiden
//! Fassungen in drei Kommentarzeilen voneinander ab, ohne dass es jemandem
//! auffiel (harmlos, sie verweisen je auf plattformeigene Dateien — aber
//! niemand hatte es bemerkt). Eine Zusage, die niemand prueft, ist eine
//! Vermutung.
//!
//! Als Integrationstest und nicht in der Datei selbst: staende er drin, muesste
//! die Zwillingsdatei ihn mit vertauschten Pfaden enthalten — und waere damit
//! nicht mehr wortgleich.

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

/// Wortgleich heisst wortgleich, samt Kommentaren. Wer hier etwas aendert,
/// aendert es in **beiden** Dateien oder in keiner.
#[test]
fn zeigerbild_liegt_im_sidecar_wortgleich() {
    const PLAYER: &str = include_str!("../../pulse-player/src/zeigerbild.rs");
    const SIDECAR: &str = include_str!("../../win-hq-sidecar/src/zeigerbild.rs");
    assert_eq!(
        PLAYER, SIDECAR,
        "streaming/pulse-player/src/zeigerbild.rs und \
         streaming/win-hq-sidecar/src/zeigerbild.rs sind auseinandergelaufen. \
         Sie beschreiben dasselbe Format fuer beide Enden der Leitung — \
         die Aenderung gehoert in beide Dateien.",
    );
}
