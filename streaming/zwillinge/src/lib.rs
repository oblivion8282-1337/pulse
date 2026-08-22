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
//!
//! **Zweite Aufgabe seit dem 2026-08-20: Listen von Hand nachrechnen.** Seit
//! die Doppelungen in gemeinsame Kisten (`pulse-*`) gezogen sind, steht an
//! mehreren Stellen im Repo je eine Liste, welche Kiste ein Programm braucht —
//! im Flatpak-Manifest und in den Pfad-Filtern der Bau-Ablaeufe. Diese Listen
//! pflegt niemand automatisch, und eine fehlende Zeile faellt jeweils nur auf
//! einer der drei Maschinen auf (s. `tests/flatpak_kisten.rs` und
//! `tests/bau_ausloeser.rs`). Dafuer stehen [`streaming`] und [`kisten_von`]
//! hier: beide Tests brauchen dieselbe Rechnung.

/// Entfernt Zeilenkommentare und Leerzeilen, damit nur die Logik verglichen
/// wird.
///
/// **Entfernt NUR ganze Kommentarzeilen — Kommentare am Zeilenende bleiben
/// stehen und werden mitverglichen.**
///
/// **Hier stand bis zum 2026-08-20 abends, die verglichenen Dateien nutzten
/// ausschliesslich ganze Kommentarzeilen, "geprueft" mit Datum. Das war nicht
/// geprueft, sondern behauptet, und es stimmt nicht:** allein
/// `whip/av1.rs` hat 43 Kommentare am Zeilenende. Gefunden bei der Pruefung
/// dieser Aufgabe, nicht beim Schreiben.
///
/// Was daraus folgt, und warum es trotzdem so bleibt: Diese 43 werden als Code
/// verglichen. Heute gruen, weil sie auf beiden Seiten gleich sind — und das
/// ist bei einem Zwilling auch die richtige Erwartung. Wer einen davon auf
/// einer Plattform praezisiert, muss es auf der anderen ebenso tun, sonst wird
/// dieser Test rot. **Das ist kein Fehlalarm, sondern die strengere Regel**,
/// nur eben eine, die vorher nirgends stand.
///
/// Der Filter wird deshalb NICHT erweitert. Zeilenend-Kommentare zuverlaessig
/// zu entfernen hiesse, `//` innerhalb von Zeichenketten zu erkennen — also
/// Rust zu zerlegen. Heute enthaelt keine der verglichenen Dateien eine
/// Zeichenkette mit `//` (nachgesehen am 2026-08-20), ein naiver Schnitt ginge
/// also gut; aber er bliebe eine Falle fuer das naechste Paar, das man
/// hinzufuegt.
///
/// **Wer ein Paar hinzufuegt, dessen Dateien ganze Kommentarzeilen
/// unterschiedlich fuehren muessen** (etwa Verweise auf plattformeigene
/// Module, wie in `zeitbasis.rs`), ist hier richtig. Wer eines hinzufuegt, das
/// auch am Zeilenende abweichen darf, braucht einen anderen Helfer — und
/// sollte vorher fragen, ob es dann noch ein Zwilling ist.
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

/// `streaming/` — der Elternordner dieser Test-Crate.
///
/// Ueber `CARGO_MANIFEST_DIR` statt ueber das Arbeitsverzeichnis, damit die
/// Tests unabhaengig davon laufen, aus welchem Ordner `cargo test` gerufen
/// wurde.
pub fn streaming() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("streaming/")
        .to_path_buf()
}

/// Die Repo-Wurzel.
pub fn wurzel() -> std::path::PathBuf {
    streaming().parent().expect("Repo-Wurzel").to_path_buf()
}

/// Die `pulse-*`-Pfad-Abhaengigkeiten eines Pakets, **rekursiv** aufgeloest.
///
/// **Rekursiv ist hier nicht Feinschliff, sondern der Kern.** `pulse-whip`
/// haengt selbst an `pulse-zeitbasis` und `pulse-bildmarke`. Ein Programm, das
/// in seiner `Cargo.toml` nur `pulse-whip` nennt, braucht die beiden trotzdem
/// im Bauordner und muss bei einer Aenderung an ihnen neu gebaut werden. Eine
/// Liste der direkt genannten Abhaengigkeiten uebersaehe das.
///
/// Bewusst ein Zeilen-Vergleich statt eines TOML-Parsers: diese Crate ist
/// abhaengigkeitsfrei, damit sie auf jeder Maschine in Sekunden baut. Erkannt
/// wird die Form, in der die Abhaengigkeiten im Repo geschrieben stehen —
/// `pulse-foo = { path = "../pulse-foo" }`.
pub fn kisten_von(paket: &str, gefunden: &mut std::collections::BTreeSet<String>) {
    let pfad = streaming().join(paket).join("Cargo.toml");
    let Ok(inhalt) = std::fs::read_to_string(&pfad) else {
        panic!("{} nicht lesbar — Paket umbenannt oder verschoben?", pfad.display());
    };
    for zeile in inhalt.lines() {
        let zeile = zeile.trim();
        if !zeile.starts_with("pulse-") || !zeile.contains("path") {
            continue;
        }
        let Some(name) = zeile.split_whitespace().next() else { continue };
        if gefunden.insert(name.to_string()) {
            kisten_von(name, gefunden); // rekursiv: Kisten haengen an Kisten
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Die Rechnung muss ueber `pulse-whip` hinweg auch dessen eigene Kisten
    /// finden — sonst waere jede Liste, die auf ihr aufbaut, zu kurz.
    #[test]
    fn kisten_von_loest_ueber_zwei_ebenen_auf() {
        let mut gefunden = std::collections::BTreeSet::new();
        kisten_von("pulse-whip", &mut gefunden);
        assert!(
            gefunden.contains("pulse-zeitbasis") && gefunden.contains("pulse-bildmarke"),
            "pulse-whip haengt an beiden — gefunden: {gefunden:?}"
        );
    }

    #[test]
    fn kommentare_und_leerzeilen_fallen_weg() {
        let roh = "// Kopf\nfn a() {}\n\n    /// Doc\n    fn b() {}\n";
        assert_eq!(ohne_kommentare(roh), "fn a() {}\n    fn b() {}");
    }

    /// **Haelt die Grenze aus dem Doc-Kommentar fest.**
    ///
    /// Ein Kommentar am Zeilenende ueberlebt den Filter und wird damit
    /// mitverglichen. Das ist die strengere Regel und heute erfuellt, aber sie
    /// stand bis zum 2026-08-20 falsch in der Doku ("kommen nicht vor") — und
    /// eine Behauptung ohne Test ist genau das, was hier schon einmal
    /// danebenging.
    #[test]
    fn kommentar_am_zeilenende_bleibt_stehen() {
        let roh = "let a = 1; // Hinweis\n";
        assert_eq!(
            ohne_kommentare(roh),
            "let a = 1; // Hinweis",
            "Zeilenend-Kommentare werden NICHT entfernt — s. Doc-Kommentar"
        );
    }

    /// Code darf NICHT verschwinden, nur weil irgendwo `//` vorkommt.
    #[test]
    fn code_mit_doppelstrich_bleibt() {
        let roh = "let u = \"https://example\";\n";
        assert_eq!(ohne_kommentare(roh), "let u = \"https://example\";");
    }
}
