//! Messstand für den experimentellen HQ-Sendeweg.
//!
//! **Dieses Crate hat seit dem 2026-08-02 keinen eigenen Sendepfad mehr.** Der
//! WHIP-Weg — eigener WebRTC-Sender mit AV1-Paketierer und RTCP-Rückkanal, der
//! hier entstanden ist — liegt jetzt im ausgelieferten Sidecar nebenan und
//! kommt von dort. Ebenso Encode, Ops und Stream-Controller.
//!
//! **Warum das Crate trotzdem bleibt.** Es ist der Ort für Versuche, die im
//! Produkt nichts verloren haben: Diagnosezähler, Messschalter und Varianten,
//! die noch nicht entschieden sind. Was hier gemessen und für gut befunden
//! wurde, wandert nach nebenan — nicht umgekehrt. Läuft das Binary heute, fährt
//! es exakt denselben Code wie ein Nutzer; jeder Unterschied ist ab jetzt eine
//! bewusste Ergänzung an dieser Stelle.
//!
//! Die Vorgeschichte, die Messakten und die offenen Punkte stehen in
//! `CLAUDE.md` daneben.

pub use pulse_linux_hq_sidecar::{
    caps, capture, dispatch, encode, events, logging, ops, profiles, proto, redact,
    stream_controller, system, whip,
};
