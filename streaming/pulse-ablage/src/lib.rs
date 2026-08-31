//! Die geteilte Zwischenablage der Fernsteuerung — plattformfreier Kern.
//!
//! **Der Mechanismus ist verzoegertes Rendern**, und das ist der ganze Grund,
//! warum diese Kiste existiert. Die naheliegende Loesung — beide Ablagen bei
//! jeder Aenderung spiegeln — wurde verworfen: sie legt alles, was waehrend
//! einer Sitzung lokal kopiert wird, im selben Moment auf den fremden Rechner;
//! auch ein Passwort aus dem Passwortmanager, das mit der Sitzung nichts zu tun
//! hat.
//!
//! Stattdessen:
//!
//! 1. Aendert sich die Ablage, geht **nur eine Ankuendigung** hinaus
//!    ([`Rahmen::Neu`]) — eine Generationsnummer, sonst nichts. Kein Inhalt,
//!    keine Groesse, kein Auszug.
//! 2. Die Gegenseite traegt sich daraufhin als Eigentuemer ihrer lokalen Ablage
//!    ein, **ohne Daten zu hinterlegen**.
//! 3. Erst wenn dort jemand einfuegt, fragt das Betriebssystem den Eigentuemer,
//!    und **erst dann** geht [`Rahmen::Hol`] hinaus und der Inhalt zurueck.
//!
//! Der haeufigste Fall (drueben kopieren, drueben einfuegen) kostet null
//! Uebertragung, und ein nie eingefuegtes Geheimnis verlaesst den Rechner nie.
//!
//! **Diese Kiste kennt weder Fenster noch Sockets.** Sie nimmt Rahmen entgegen
//! und gibt Rahmen zurueck; die beiden Beruehrungspunkte mit dem Betriebssystem
//! sind Traits ([`beobachter::Beobachter`], [`eigentum::Eigentum`]). Deshalb
//! laesst sich der ganze Ablauf im Test fahren, ohne dass eine Zwischenablage
//! im Spiel ist — siehe `tests/rundlauf.rs`.

//! **Welche Plattform-Aufrufe hier liegen — und welche nicht.** Wayland steht
//! im Player (`fernsteuerung/wayland/ablage.rs`, Begruendung im Entwurf),
//! Windows im `win-hq-sidecar` (`src/ablage/`): dort hat jede Plattform genau
//! EINEN Verbraucher. **macOS hat zwei** — den `mac-hq-sidecar` als Host und
//! den `pulse-player` als Steuernden —, und weil beide Haelften einer
//! Zwischenablage spiegelbildlich gleich sind, laege die Umsetzung dort zweimal
//! im Baum. Sie liegt deshalb hier ([`plattform::macos`]).
//!
//! Was alle teilen, ist ohnehin alles darueber — seit dem 2026-08-31 auch die
//! Zustandsfuehrung ([`lage`]) und die Traits, die eine Plattform erfuellen
//! muss ([`plattform`]).

pub mod beobachter;
pub mod eigentum;
pub mod format;
pub mod lage;
pub mod plattform;
pub mod pruefstand;
pub mod sitzung;
pub mod stand;
pub mod stueckelung;
