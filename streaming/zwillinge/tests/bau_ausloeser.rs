//! Loest jeder Bau-Ablauf bei jeder Kiste aus, die sein Programm braucht?
//!
//! **Warum es diesen Test gibt.** Die Bau-Ablaeufe unter `.github/workflows/`
//! laufen nicht bei jedem Push, sondern nur, wenn er bestimmte Verzeichnisse
//! beruehrt (`on.push.paths`). Seit die vormals mehrfachen Dateien in
//! gemeinsame Kisten gezogen sind, liegt ein Teil des ausgelieferten Codes
//! ausserhalb des Programmordners — und muss dort einzeln aufgezaehlt werden.
//!
//! **Fehlt eine Kiste, bricht nichts.** Genau das ist das Gefaehrliche: der Bau
//! laeuft einfach nicht, der zuletzt gebaute Installer bleibt liegen, und das
//! Ausgelieferte traegt still den alten Stand. Es gibt keine rote CI, keine
//! Fehlermeldung, nichts, was jemandem auffiele — bis sich jemand wundert,
//! warum eine Aenderung beim Nutzer nicht ankommt.
//!
//! Gefunden am 2026-08-22 auf der Windows-Maschine: `pulse-bildmarke` fehlte in
//! **allen drei** Ablaeufen. Dieselbe Falle wie im Flatpak-Manifest
//! (`flatpak_kisten.rs` daneben), nur ohne den Knall am Ende — deshalb dieser
//! zweite Test und nicht bloss ein Eintrag mehr.
//!
//! **Nur fehlende Eintraege sind ein Befund, ueberzaehlige nicht.** Ein Eintrag
//! zu viel loest hoechstens einen unnoetigen Bau aus; einer zu wenig liefert
//! alten Code aus. Nur die zweite Richtung wird geprueft.

use std::collections::BTreeSet;
use std::fs;
use zwillinge::{kisten_von, wurzel};

/// Je Bau-Ablauf: welche Programme baut er?
///
/// `mac-build.yml` baut den Player NICHT mit — er wird unter macOS nicht
/// ausgeliefert. Deshalb steht dort auch `pulse-zeigerbild` nicht, und das ist
/// richtig so.
const ABLAEUFE: &[(&str, &[&str])] = &[
    ("win-build.yml", &["win-hq-sidecar", "pulse-player"]),
    ("mac-build.yml", &["mac-hq-sidecar", "pulse-player"]),
    ("flatpak.yml", &["linux-hq-sidecar", "pulse-player"]),
];

/// Die `streaming/<x>/**`-Eintraege eines Ablaufs.
///
/// Zeilenweise, nicht byteweise — aus demselben Grund wie in
/// `flatpak_kisten.rs`: Git wandelt Zeilenenden beim Auschecken auf Windows um,
/// und ein Test, der auf einer der drei Maschinen blind ist, ist keiner.
fn ausgeloeste_verzeichnisse(ablauf: &str) -> BTreeSet<String> {
    let pfad = wurzel().join(".github/workflows").join(ablauf);
    let inhalt = fs::read_to_string(&pfad)
        .unwrap_or_else(|e| panic!("{} nicht lesbar: {e}", pfad.display()));

    inhalt
        .lines()
        .filter_map(|z| z.trim().strip_prefix("- 'streaming/"))
        .filter_map(|z| z.strip_suffix("/**'"))
        .map(str::to_string)
        .collect()
}

/// Was ein Ablauf an gemeinsamen Kisten braucht — rekursiv ueber alle
/// Programme, die er baut.
fn gebrauchte_kisten(pakete: &[&str]) -> BTreeSet<String> {
    let mut gebraucht = BTreeSet::new();
    for paket in pakete {
        kisten_von(paket, &mut gebraucht);
    }
    gebraucht
}

#[test]
fn jeder_bau_ablauf_loest_bei_seinen_kisten_aus() {
    let mut klagen = Vec::new();

    for (ablauf, pakete) in ABLAEUFE {
        let gebraucht = gebrauchte_kisten(pakete);
        let vorhanden = ausgeloeste_verzeichnisse(ablauf);

        let fehlend: Vec<_> = gebraucht.difference(&vorhanden).cloned().collect();
        if !fehlend.is_empty() {
            klagen.push(format!(
                "{ablauf} (baut {pakete:?}) fehlen unter on.push.paths: {}\n     \
                 gebraucht (rekursiv): {gebraucht:?}",
                fehlend.join(", "),
            ));
        }
    }

    assert!(
        klagen.is_empty(),
        "Ein Bau-Ablauf loest nicht bei allen Kisten aus, die er ausliefert.\n\n  {}\n\n\
         Folge: Eine Aenderung allein an dieser Kiste startet keinen Bau. Es bricht\n\
         nichts — das Ausgelieferte bleibt still auf dem alten Stand. Je Kiste\n\
         gehoert eine Zeile in den paths-Block:\n\n\
         \x20     - 'streaming/<kiste>/**'\n",
        klagen.join("\n\n  ")
    );
}

/// Gegenprobe: greift die Auswertung ueberhaupt noch?
///
/// Ohne diesen Test bliebe der obige gruen, wenn die Ablaeufe ihre Pfade anders
/// schrieben (andere Anfuehrungszeichen, `paths-ignore` statt `paths`) und
/// `ausgeloeste_verzeichnisse` deshalb nichts mehr faende — leere Menge gegen
/// leere Menge sieht wie Erfolg aus.
#[test]
fn die_auswertung_findet_ueberhaupt_etwas() {
    for (ablauf, pakete) in ABLAEUFE {
        let vorhanden = ausgeloeste_verzeichnisse(ablauf);
        assert!(
            vorhanden.len() >= 2,
            "{ablauf}: nur {} streaming-Pfad(e) gefunden — die Auswertung greift nicht \
             mehr (Schreibweise im paths-Block geaendert?)",
            vorhanden.len()
        );
        assert!(
            !gebrauchte_kisten(pakete).is_empty(),
            "{ablauf}: {pakete:?} haengen an keiner einzigen pulse-Kiste — \
             Cargo.toml-Form geaendert?"
        );
    }
}
