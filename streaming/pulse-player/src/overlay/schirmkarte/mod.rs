//! Die massstaebliche Karte der Bildschirme des ferngesteuerten Rechners —
//! ersetzt im Menue am Griff die fruehere Liste von „+ Name"-Knoepfen.
//!
//! **Zwei Dateien statt Abschnitten**, seit die eine `schirmkarte.rs` ueber
//! den Richtwert von 350 Zeilen Nicht-Test-Code wuchs: [`rechnung`] ist reine
//! Zahlenrechnung, kein egui-Kontext — pruefbar ohne Fenster, wie
//! [`crate::fernsteuerung::nachbarn`] und [`crate::fernsteuerung::bildlage`].
//! [`zeichnung`] malt duenn darueber, wie [`super::fernbedienung`] es fuer
//! den Griff vormacht. `zeichnung::zeichnen` entscheidet selbst NICHT, ob
//! eine Karte ueberhaupt sinnvoll ist — das prueft der Aufrufer vorab ueber
//! [`rechnung::darstellbar`] und faellt sonst auf die alte Knopfliste zurueck
//! (`fernbedienung.rs`).

mod rechnung;
mod zeichnung;

// `kaestchen`/`satz` bleiben in `rechnung` oeffentlich (Interface-Vertrag,
// direkt getestet ueber `super::*` in deren Testmodul), aber NICHT hier
// erneut re-exportiert: ausserhalb von `schirmkarte` braucht sie aktuell
// niemand, und wegen des privaten `mod schirmkarte;` in `overlay/mod.rs`
// kann der Compiler das beweisen — ein ungenutzter Re-Export waere totes
// Gewicht statt eines belegten Vertrags.
pub use rechnung::darstellbar;
pub(super) use zeichnung::zeichnen;
