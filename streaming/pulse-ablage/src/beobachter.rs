//! „Meine Ablage hat sich geaendert" — der eine Beruehrungspunkt, an dem das
//! Betriebssystem etwas MELDET.

/// Beobachtet die lokale Zwischenablage.
pub trait Beobachter {
    /// Hat sich die Ablage seit dem letzten Aufruf geaendert?
    ///
    /// **Darf den Inhalt nicht lesen muessen.** Auf macOS ist das ein
    /// Zaehlerstand (`NSPasteboard.changeCount`), auf Windows eine Nachricht,
    /// auf Wayland ein Ereignis — nirgends muss dafuer der Inhalt angefasst
    /// werden, und genau das ist der Punkt: eine Aenderung zu bemerken kostet
    /// nichts an Vertraulichkeit.
    fn geaendert(&mut self) -> bool;

    /// Der aktuelle Text, oder `None`, wenn die Ablage keinen Text haelt (Bild,
    /// Dateien, leer).
    ///
    /// Wird **nur** beim Beantworten eines `hol` gerufen, nie beim Ankuendigen.
    fn lesen(&self) -> Option<String>;
}
