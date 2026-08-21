//! Haelt die Dateien fest, die an zwei Stellen **wortgleich** liegen muessen.
//!
//! `src/zeigerbild.rs` beschreibt das Bildformat der Zeigeruebertragung: der
//! Sidecar packt, der Player entpackt. Beide Enden muessen sich Byte fuer Byte
//! einig sein, und eine Beschreibung in zwei Fassungen laeuft auseinander —
//! deshalb liegt sie zweimal identisch da statt zweimal aehnlich.
//!
//! **Warum ein Test und nicht nur ein Kommentar.** Genau diese Zusage gibt es
//! im Repo schon einmal, fuer `zeitbasis.rs` in den beiden Sidecars, und dort
//! steht sie allein in der Dokumentation. Am 2026-08-17 wichen die beiden
//! Fassungen in drei Kommentarzeilen voneinander ab, ohne dass es jemandem
//! auffiel (harmlos, sie verweisen je auf plattformeigene Dateien — aber
//! niemand hatte es bemerkt). Eine Zusage, die niemand prueft, ist eine
//! Vermutung.
//!
//! Als Integrationstest und nicht in der Datei selbst: staende er drin, muesste
//! die Zwillingsdatei ihn mit vertauschten Pfaden enthalten — und waere damit
//! nicht mehr wortgleich.

/// Wortgleich heisst wortgleich, samt Kommentaren. Wer hier etwas aendert,
/// aendert es in **beiden** Dateien oder in keiner.
#[test]
fn zeigerbild_liegt_im_sidecar_wortgleich() {
    const PLAYER: &str = include_str!("../src/zeigerbild.rs");
    const SIDECAR: &str = include_str!("../../win-hq-sidecar/src/zeigerbild.rs");
    assert_eq!(
        PLAYER, SIDECAR,
        "streaming/pulse-player/src/zeigerbild.rs und \
         streaming/win-hq-sidecar/src/zeigerbild.rs sind auseinandergelaufen. \
         Sie beschreiben dasselbe Format fuer beide Enden der Leitung — \
         die Aenderung gehoert in beide Dateien.",
    );
}

/// Die Bildmarke liegt in DREI Kisten: beide Sidecars schreiben sie, der
/// Player liest sie. Ein Format, das an drei Stellen beschrieben wird, laeuft
/// dreifach auseinander — deshalb dieselbe Zusage wie oben, nur mit einem
/// Pfad mehr.
///
/// Der Pruefstein `streaming/bildmarke-formen.json` prueft zusaetzlich die
/// erzeugten BYTES; dieser Test prueft die QUELLE. Beides ist noetig: der
/// Pruefstein faenge eine Aenderung nicht, die alle drei Kopien gleichzeitig
/// falsch macht, und dieser Test faenge keine, die nur den Pruefstein
/// verfaelscht.
#[test]
fn bildmarke_liegt_in_allen_drei_kisten_wortgleich() {
    const PLAYER: &str = include_str!("../src/bildmarke.rs");
    const WINDOWS: &str = include_str!("../../win-hq-sidecar/src/whip/bildmarke.rs");
    const LINUX: &str = include_str!("../../linux-hq-sidecar/src/whip/bildmarke.rs");
    assert_eq!(
        PLAYER, WINDOWS,
        "streaming/pulse-player/src/bildmarke.rs und \
         streaming/win-hq-sidecar/src/whip/bildmarke.rs sind auseinandergelaufen.",
    );
    assert_eq!(
        PLAYER, LINUX,
        "streaming/pulse-player/src/bildmarke.rs und \
         streaming/linux-hq-sidecar/src/whip/bildmarke.rs sind auseinandergelaufen.",
    );
}
