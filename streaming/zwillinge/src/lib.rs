//! Haelt die bewusst doppelt gefuehrten Dateien der HQ-Programme zusammen.
//!
//! **Warum es diese Crate gibt.** Zwischen `win-hq-sidecar`,
//! `linux-hq-sidecar`, `mac-hq-sidecar` und `pulse-player` liegen rund 2.400
//! Codezeilen mehrfach fast wortgleich vor. Zweimal ist eine dieser Kopien
//! unbemerkt auseinandergelaufen (`zeitbasis.rs` am 2026-08-17, die
//! Zero-Copy-Bruecke am 2026-08-06), und die Token-Redaktion verhaelt sich bis
//! heute auf den drei Plattformen verschieden.
//!
//! **Warum als eigene Crate und nicht in einer der vier.** Ein Test in einer
//! Sidecar-Crate laeuft nur dort, wo diese Crate baut — und keine der vier
//! baut auf allen Plattformen. Diese hier hat keine Abhaengigkeiten und laeuft
//! ueberall. `include_str!` liest zur Uebersetzungszeit aus dem Repo, es muss
//! also nichts von den fremden Plattformen gebaut werden.
//!
//! **Diese Crate aendert nie Produktivcode.** Wird ein Test rot, ist das der
//! Befund — nicht der Test.
