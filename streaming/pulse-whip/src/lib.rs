//! Die geteilten Teile des WHIP-Sendewegs.
//!
//! **Seit dem 2026-08-20 gemeinsam fuer alle drei Sidecars.** Vorher lagen
//! `av1.rs` und `sdp.rs` dreimal im Repo — `sdp.rs` dreimal bitgleich,
//! `av1.rs` mit einem einzigen Unterschied, der die POSITION eines
//! Doc-Kommentarblocks betraf. Zusammen 2366 ueberzaehlige Zeilen.
//!
//! **Was hier bewusst NICHT liegt:**
//!
//! * `mod.rs` — plattformeigen. Es bleibt die einzige Datei, die dreimal
//!   vorliegt: sie verdrahtet die Aufnahme, und die ist je Plattform eine
//!   andere. Auch die Log-Sprache unterscheidet sich (Linux `tracing`,
//!   Windows/macOS `eprintln!`), weshalb hier reine RECHNUNGEN liegen und
//!   dort das Absetzen von Meldung und Ereignis.
//!
//! **`bandbreite.rs` stand bis zum 2026-08-27 in dieser Liste** und lag nur
//! unter Windows. `goog-remb` bietet das gemeinsame [`sdp`] aber auf ALLEN
//! drei Plattformen an — Linux und macOS baten also um Berichte, die sie
//! anschliessend wortlos wegwarfen. Genau der Fall „im Angebot zugesagt, im
//! Code ignoriert". Die Zustandsmaschine ist abhaengigkeitsfrei und lag ohne
//! Grund plattformeigen; hier liegt sie einmal und ihre Tests laufen im Gate.
//!
//! **`pacer.rs` stand bis zum 2026-08-22 auch in dieser Liste** — Windows
//! trug einen eigenen Zuschnitt, und welcher besser sei, war nicht gemessen.
//! Aufgeloest hat das nicht eine Messung, sondern die Einsicht, dass die
//! Frage kleiner ist als sie aussah: die beiden unterschieden sich nur bei
//! kleinen Bildern, also dort, wo ein Schwall am wenigsten schadet. Kleiner
//! ungewisser Gewinn gegen sicheren Gewinn an Wartbarkeit — Begruendung und
//! Zahlen im Kopf von [`pacer`].
//!
//! **Bewusst nicht mitgezogen: `streaming/win-hq-labor/src/whip/av1.rs`.**
//! Vierte Fassung, 572 statt 791 Zeilen — das Labor bildet nur einen
//! Ausschnitt der Paketierung nach, den es fuer seine Testbench braucht, und
//! bleibt eigenstaendig: es ist kein Auslieferziel und soll nicht an dieser
//! Crate haengen.
//!
//! `src/zeitbasis.rs` ist kein eigener Baustein, sondern nur ein Re-Export von
//! `pulse-zeitbasis` — `av1.rs` ruft `crate::zeitbasis::…` auf, unveraendert
//! wie in allen drei Sidecars.

pub mod av1;
pub mod bandbreite;
pub mod h264;
pub mod pacer;
pub mod sdp;
pub mod verbindung;
pub mod zeitbasis;
