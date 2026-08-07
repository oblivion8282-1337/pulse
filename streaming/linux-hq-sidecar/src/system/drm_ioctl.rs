//! Rohe DRM/KMS-ioctls — nur die, die der Scanout-Aufnahmeweg braucht.
//!
//! **Der Quelltext ist am 2026-08-08 nach `kms-helfer/src/drm.rs` gewandert**
//! und steht hier nur noch als Weiterleitung. Grund: das Helfer-Programm
//! (`pulse-kms-helfer`) braucht genau dieselben ioctls, und zwar in genau
//! derselben Fassung — es holt damit die Bilder, waehrend der Sidecar damit die
//! Ausgaenge aufzaehlt. Zwei Abschriften waeren bei der ersten Aenderung
//! auseinandergelaufen, und der Unterschied faellt erst beim Nutzer auf, weil
//! die eine Seite unter Rechten laeuft, die die andere nicht hat.
//!
//! Die Begruendungen (warum von Hand statt libdrm, warum die Handles Rechte
//! verlangen) stehen am Kopf der Zieldatei.

pub use pulse_kms_helfer::drm::*;
