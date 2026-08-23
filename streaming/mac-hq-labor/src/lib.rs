//! **Pulse mac-HQ-Labor — das Eingabe-Pruefziel.**
//!
//! Gegenstueck zu `streaming/win-hq-labor/testbench/eingabe-pruefziel.ps1`. Ein
//! Vollbild-Fenster faengt Maus und Tastatur ab und protokolliert, **was
//! wirklich ankommt** — nicht, wo der Zeiger steht.
//!
//! ## Warum ein Fenster und nicht `CGEventSourceCounter` oder ein Abgriff
//!
//! Zwei Gruende, beide aus dem Windows-Labor uebernommen:
//!
//! 1. **Sicherheit.** Eingabe zu injizieren ist auf einem benutzten Rechner
//!    gefaehrlich: ein Klick landet irgendwo, ein Tastendruck geht in ein fremdes
//!    Fenster. Dieses Fenster legt sich ueber alles und faengt beides ab.
//! 2. **Aussagekraft.** Die Zeigerlage zurueckzulesen sagt nur, wo der Zeiger
//!    steht. Ob ein **Fenster** die Eingabe zugestellt bekommt — und mit welchem
//!    Tastencode, welcher Seite und welchem Klickstand — steht dort nicht.
//!    Dazwischen liegen die Fallen: Schirm-Zuordnung, Punkte gegen Bildpunkte,
//!    erweiterte Tasten.
//!
//! ## Die Aufteilung
//!
//! Alles, was rechnet, liegt in eigenen Modulen mit Tests
//! ([`lage`], [`obenauf`], [`tasten`], [`ziele`], [`zusammenfassung`]). Alles,
//! was das System befragt, liegt daneben ([`fensterliste`], [`ereignisse`],
//! [`fenster`], [`zeichnen`], [`eigenfahrt`]) — dort gibt es nichts zu testen,
//! nur zu messen.

pub mod eigenfahrt;
pub mod ereignisse;
pub mod fenster;
pub mod fensterliste;
pub mod lage;
pub mod obenauf;
pub mod protokoll;
pub mod tasten;
pub mod treiber;
pub mod zeichnen;
pub mod ziele;
pub mod zusammenfassung;
