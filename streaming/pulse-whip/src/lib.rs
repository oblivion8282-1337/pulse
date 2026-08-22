//! Die geteilten Teile des WHIP-Sendewegs.
//!
//! **Seit dem 2026-08-20 gemeinsam fuer alle drei Sidecars.** Vorher lagen
//! `av1.rs` und `sdp.rs` dreimal im Repo — `sdp.rs` dreimal bitgleich,
//! `av1.rs` mit einem einzigen Unterschied, der die POSITION eines
//! Doc-Kommentarblocks betraf. Zusammen 2366 ueberzaehlige Zeilen.
//!
//! **Was hier bewusst NICHT liegt:**
//!
//! * `pacer.rs` — die Windows-Fassung weicht ABSICHTLICH ab (dort 2026-08-13
//!   unabhaengig nach denselben Lehren gebaut, anderer Zuschnitt des
//!   Sendefensters). Welcher Zuschnitt besser ist, ist nicht gemessen; eine
//!   Zusammenlegung waere eine inhaltliche Entscheidung unter Unwissen. Der
//!   Hinweis in beiden Fassungen — „wer einen Pacer-Fehler behebt, sieht sich
//!   BEIDE an" — gilt weiter.
//! * `mod.rs` — plattformeigen. Windows traegt dort zusaetzlich eine
//!   Bandbreiten-Schaetzung, die die anderen nicht haben.
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
pub mod h264;
pub mod pacer;
pub mod sdp;
pub mod zeitbasis;
