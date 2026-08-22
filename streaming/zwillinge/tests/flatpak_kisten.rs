//! Traegt das Flatpak-Manifest jede Kiste, die ein Programm darin braucht?
//!
//! **Warum es diesen Test gibt.** Der Flatpak baut in einem eigenen, leeren
//! Ordner und kopiert nur hinein, was im Manifest aufgezaehlt ist — und er
//! baut mit `cargo --offline`. Fehlt dort eine geteilte Kiste, zeigt ihre
//! Pfad-Abhaengigkeit ins Leere, und ohne Netz gibt es kein Nachladen: der Bau
//! bricht.
//!
//! Das faellt sonst NIRGENDS auf. Auf dem Mac und unter Windows wird direkt im
//! Projektordner gebaut, wo alle Kisten ohnehin nebeneinander liegen; dort
//! stimmt die Angabe "Nachbarverzeichnis" einfach. Der Fehler existiert allein
//! in der Flatpak-Umgebung, und die wird erst beim Push nach `main` gebaut —
//! der Bruch schlaegt also in der CI auf, nach dem Merge.
//!
//! **Zweimal passiert, beide Male nur durch Nachrechnen bemerkt:** am
//! 2026-08-20 bei den ersten vier Kisten, am 2026-08-22 bei `pulse-bildmarke`.
//! Die Falle schnappt bei JEDER neuen Kiste zu, weil das Manifest eine Liste
//! von Hand ist, die niemand mit den `Cargo.toml` abgleicht. Genau das tut
//! dieser Test.
//!
//! **Rekursiv, nicht nur direkt.** `pulse-whip` haengt selbst an
//! `pulse-zeitbasis` und `pulse-bildmarke`. Ein Programm, das nur `pulse-whip`
//! nennt, braucht die beiden trotzdem im Bauordner — eine Liste der direkt
//! genannten Abhaengigkeiten wuerde sie uebersehen.
//!
//! **Zur Laufzeit gelesen, nicht per `include_str!`.** Die uebrigen Tests hier
//! vergleichen feste Dateipaare, da ist `include_str!` richtig. Hier waere es
//! falsch: eine neu angelegte Kiste muesste dann von Hand nachgetragen werden
//! — und genau dieses Nachtragen ist der Handgriff, den der Test absichern
//! soll.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// `streaming/` — der Elternordner dieser Test-Crate.
fn streaming() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("streaming/").to_path_buf()
}

/// Die `pulse-*`-Pfad-Abhaengigkeiten einer `Cargo.toml`, rekursiv aufgeloest.
///
/// Bewusst ein Zeilen-Vergleich statt eines TOML-Parsers: diese Crate ist
/// abhaengigkeitsfrei, damit sie auf jeder Maschine in Sekunden baut. Erkannt
/// wird die Form, in der die Abhaengigkeiten im Repo geschrieben stehen —
/// `pulse-foo = { path = "../pulse-foo" }`.
fn kisten_von(paket: &str, gefunden: &mut BTreeSet<String>) {
    let pfad = streaming().join(paket).join("Cargo.toml");
    let Ok(inhalt) = fs::read_to_string(&pfad) else {
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

/// Die `type: dir`-Quellen EINES Moduls des Flatpak-Manifests.
///
/// Auch hier Zeilen-Vergleich statt YAML-Parser (s. oben). Ein Modul beginnt
/// mit `- name: <x>` und endet vor dem naechsten `- name:` auf derselben
/// Einrueckung; dazwischen wird jede `path: ../streaming/<y>`-Zeile gesammelt.
fn dir_quellen(manifest: &str, modul: &str) -> BTreeSet<String> {
    let start = manifest
        .find(&format!("- name: {modul}\n"))
        .unwrap_or_else(|| panic!("Modul '{modul}' steht nicht im Manifest"));
    let rest = &manifest[start + 1..];
    let ende = rest.find("\n  - name: ").map_or(manifest.len(), |i| start + 1 + i);

    manifest[start..ende]
        .lines()
        .filter_map(|z| z.trim().strip_prefix("path: ../streaming/"))
        .map(|p| p.trim().to_string())
        .collect()
}

/// Je Flatpak-Modul: welches Paket wird darin gebaut?
const MODULE: &[(&str, &str)] =
    &[("pulse-linux-hq-sidecar", "linux-hq-sidecar"), ("pulse-player", "pulse-player")];

#[test]
fn flatpak_traegt_jede_gebrauchte_kiste() {
    let manifest_pfad = streaming().parent().expect("Repo-Wurzel").join("packaging/com.howispulse.Pulse.yml");
    let manifest = fs::read_to_string(&manifest_pfad)
        .unwrap_or_else(|e| panic!("{} nicht lesbar: {e}", manifest_pfad.display()));

    let mut klagen = Vec::new();
    for (modul, paket) in MODULE {
        let mut gebraucht = BTreeSet::new();
        kisten_von(paket, &mut gebraucht);
        let vorhanden = dir_quellen(&manifest, modul);

        let fehlend: Vec<_> = gebraucht.difference(&vorhanden).cloned().collect();
        if !fehlend.is_empty() {
            klagen.push(format!(
                "Modul '{modul}' (baut '{paket}') fehlen im Manifest: {}\n     \
                 gebraucht (rekursiv): {:?}\n     im Manifest: {:?}",
                fehlend.join(", "),
                gebraucht,
                vorhanden,
            ));
        }
    }

    assert!(
        klagen.is_empty(),
        "packaging/com.howispulse.Pulse.yml ist unvollstaendig.\n\n  {}\n\n\
         Der Flatpak baut mit `cargo --offline` und kopiert NUR die dort genannten\n\
         Verzeichnisse. Eine fehlende Kiste bricht den Bau — nur auf dem Flatpak,\n\
         und erst in der CI nach dem Merge. Je Kiste gehoert ein Block ins Modul:\n\n\
         \x20     - type: dir\n\
         \x20       path: ../streaming/<kiste>\n\
         \x20       dest: <kiste>\n\
         \x20       skip:\n\
         \x20         - target\n",
        klagen.join("\n\n  ")
    );
}

/// Gegenprobe: findet die Auswertung ueberhaupt etwas?
///
/// Ohne diesen Test bliebe der obige gruen, wenn das Manifest umgebaut wuerde
/// und `dir_quellen` nichts mehr faende — leere Menge gegen leere Menge sieht
/// wie Erfolg aus. Genau die Sorte Test, die stillschweigend aufhoert zu
/// pruefen.
#[test]
fn die_auswertung_findet_ueberhaupt_etwas() {
    let manifest_pfad = streaming().parent().expect("Repo-Wurzel").join("packaging/com.howispulse.Pulse.yml");
    let manifest = fs::read_to_string(&manifest_pfad).expect("Manifest lesbar");

    for (modul, paket) in MODULE {
        let quellen = dir_quellen(&manifest, modul);
        assert!(
            quellen.len() >= 2,
            "Modul '{modul}': nur {} dir-Quelle(n) gefunden — die Auswertung greift \
             nicht mehr (Manifest-Aufbau geaendert?)",
            quellen.len()
        );
        let mut gebraucht = BTreeSet::new();
        kisten_von(paket, &mut gebraucht);
        assert!(
            !gebraucht.is_empty(),
            "'{paket}' haengt an keiner einzigen pulse-Kiste — Cargo.toml-Form geaendert?"
        );
    }
}
