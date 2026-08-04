//! Wohin Mitschriften und Diagnose-Dateien gehen.
//!
//! **Warum es das gibt.** Quer durch den Player stand `/tmp/...` — als Vorgabe
//! für Diagnose-Ausgaben und als Ziel in Tests. Unter Linux ist das richtig,
//! unter Windows gibt es kein `/tmp`: die betroffenen Tests scheiterten dort
//! mit „Error opening output file", und die Meldung zeigte auf den Muxer statt
//! auf den Pfad. Gefunden beim ersten Windows-Bau am 2026-08-02.
//!
//! Kein Zufallsname und kein Aufräumen: die Dateien sollen nach einem Lauf noch
//! da sein, denn genau dafür gibt es sie. Ein Test, der seine Ausgabe wegwirft,
//! hilft beim Nachsehen nicht.
//!
//! **`#[cfg(test)]`, weil heute nur Tests hier hereinkommen.** Alle neun
//! Stellen, die vorher `/tmp/...` fest verdrahtet hatten, liegen in
//! Test-Funktionen; ohne die Schranke wären beide Funktionen im normalen Bau
//! toter Code und würden eine Warnung erzeugen. Kommt ein Diagnose-Pfad im
//! Betrieb dazu, ist es eine Zeile in `main.rs`.

use std::path::PathBuf;

/// Ein Pfad im Temp-Verzeichnis der Plattform.
///
/// `std::env::temp_dir()` liest unter Windows `TMP`/`TEMP` und liefert unter
/// Unix `/tmp` — also genau das, was vorher fest dastand, nur eben überall.
pub fn temp(name: &str) -> PathBuf {
    std::env::temp_dir().join(name)
}

/// Dasselbe als Zeichenkette, für die Stellen, die einen Pfad als `String`
/// erwarten (Umgebungs-Vorgaben, Kommandozeilen).
pub fn temp_str(name: &str) -> String {
    temp(name).to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der Pfad muss im Temp-Verzeichnis liegen und den Namen tragen — mehr
    /// wird nicht zugesichert, damit der Test nicht die Plattform festschreibt.
    #[test]
    fn liegt_im_temp_verzeichnis() {
        let p = temp("pulse-player-probe.bin");
        assert!(p.starts_with(std::env::temp_dir()));
        assert_eq!(p.file_name().unwrap(), "pulse-player-probe.bin");
    }

    /// **Und es ist nicht `/tmp` fest verdrahtet.** Unter Windows gibt es das
    /// nicht; genau daran sind die Tests beim ersten Bau dort gescheitert.
    #[test]
    fn kein_fester_unix_pfad() {
        let s = temp_str("x");
        if cfg!(windows) {
            assert!(!s.starts_with("/tmp"), "auf Windows darf kein /tmp stehen: {s}");
        }
    }
}
