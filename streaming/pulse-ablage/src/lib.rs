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

pub mod format;
