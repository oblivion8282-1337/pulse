//! Gemeinsamer Teil des KMS-Helfers: die DRM-ioctls, das Format auf dem Draht
//! und die Socket-Mechanik.
//!
//! **Wer das benutzt.** Das Programm `pulse-kms-helfer` (`main.rs`) und der
//! Sidecar nebenan (`capture/kms_helfer.rs` als Gegenstelle,
//! `capture/kms.rs` fuer die Aufzaehlung ohne Berechtigung). Beide Seiten
//! desselben Gespraechs teilen sich damit **eine** Fassung des Formats — der
//! Handschlag in [`protokoll::FASSUNG`] faengt nur den Fall ab, dass ein ALT
//! installiertes Programm neben einer neuen App steht, nicht das Auseinanderlaufen
//! zweier Quelltexte.

pub mod drm;
pub mod karte;
pub mod protokoll;
pub mod uebertragung;
