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

/// Entfernt Zeilenkommentare und Leerzeilen, damit nur die Logik verglichen
/// wird.
///
/// **Bewusst grob, und das genuegt hier.** Die verglichenen Dateien nutzen
/// ausschliesslich `//`- und `///`-Kommentare (geprueft am 2026-08-20); Block-
/// kommentare und Kommentare am Zeilenende kommen nicht vor. Wer ein Paar
/// hinzufuegt, dessen Dateien das anders halten, prueft das vorher — sonst
/// vergleicht dieser Helfer stillschweigend weniger, als er vorgibt.
///
/// Zeichenketten, die `//` enthalten (etwa eine URL), stehen in diesen Dateien
/// nie am Zeilenanfang; deshalb reicht der Test auf das erste
/// Nicht-Leerzeichen.
pub fn ohne_kommentare(quelle: &str) -> String {
    quelle
        .lines()
        .map(str::trim_end)
        .filter(|z| {
            let t = z.trim_start();
            !t.is_empty() && !t.starts_with("//")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kommentare_und_leerzeilen_fallen_weg() {
        let roh = "// Kopf\nfn a() {}\n\n    /// Doc\n    fn b() {}\n";
        assert_eq!(ohne_kommentare(roh), "fn a() {}\n    fn b() {}");
    }

    /// Code darf NICHT verschwinden, nur weil irgendwo `//` vorkommt.
    #[test]
    fn code_mit_doppelstrich_bleibt() {
        let roh = "let u = \"https://example\";\n";
        assert_eq!(ohne_kommentare(roh), "let u = \"https://example\";");
    }
}
