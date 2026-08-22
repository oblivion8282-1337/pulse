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
/// mit `- name: <x>` auf zwei Leerzeichen Einrueckung und endet vor dem
/// naechsten Eintrag derselben Einrueckung; dazwischen wird jede
/// `path: ../streaming/<y>`-Zeile gesammelt. Die Einrueckung gehoert zur
/// Abgrenzung: `- name: ffnvcodec` steht tiefer eingerueckt INNERHALB des
/// ffmpeg-Moduls und darf es nicht beenden.
///
/// **Zeilenweise statt byteweise, und das ist der Punkt.** Die erste Fassung
/// suchte mit `find("- name: <x>\n")` im rohen Text und fand deshalb auf
/// Windows kein einziges Modul: Git wandelt die Zeilenenden beim Auschecken um
/// (`core.autocrlf`, Vorgabe des dortigen Installers), im Text steht dann
/// `\r\n`. Der Waechter meldete "steht nicht im Manifest" fuer Eintraege, die
/// sehr wohl dort standen — auf dem Bauserver gruen, auf jeder
/// Windows-Maschine rot. `lines()` streift das `\r` selbst ab und macht die
/// Auswertung damit unabhaengig von der Schreibweise.
fn dir_quellen(manifest: &str, modul: &str) -> BTreeSet<String> {
    let kopf = format!("  - name: {modul}");
    let mut im_modul = false;
    let mut gesehen = false;
    let mut quellen = BTreeSet::new();

    for zeile in manifest.lines() {
        if zeile.starts_with("  - name: ") {
            im_modul = zeile.trim_end() == kopf;
            gesehen |= im_modul;
            continue;
        }
        if im_modul {
            if let Some(p) = zeile.trim().strip_prefix("path: ../streaming/") {
                quellen.insert(p.trim().to_string());
            }
        }
    }

    assert!(gesehen, "Modul '{modul}' steht nicht im Manifest");
    quellen
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

/// Gegenprobe: die Auswertung darf nicht an der Schreibweise der Zeilenenden
/// haengen.
///
/// Der Test hier arbeitet auf einem gestellten Manifest, nicht auf dem echten:
/// welche Zeilenenden das echte traegt, entscheidet die Git-Einstellung der
/// Maschine — auf dem Bauserver LF, auf Windows CRLF. Ein Test gegen die Datei
/// prueft also je nach Rechner etwas anderes und auf dem Bauserver nie den
/// Fall, an dem die erste Fassung gescheitert ist.
///
/// Beide Schreibweisen muessen dasselbe ergeben. Zusaetzlich wird das Ergebnis
/// selbst geprueft: gaebe die Auswertung fuer beide nichts zurueck, waere der
/// Vergleich leer gegen leer und damit wertlos.
#[test]
fn zeilenenden_aendern_das_ergebnis_nicht() {
    const MANIFEST: &str = "modules:\n\
                            \x20 - name: ffmpeg\n\
                            \x20   sources:\n\
                            \x20     - name: ffnvcodec\n\
                            \x20       path: ../streaming/nicht-mitzaehlen\n\
                            \x20 - name: pulse-player\n\
                            \x20   sources:\n\
                            \x20     - type: dir\n\
                            \x20       path: ../streaming/pulse-zeigerbild\n\
                            \x20     - type: dir\n\
                            \x20       path: ../streaming/pulse-bildmarke\n\
                            \x20 - name: pulse\n";
    let mit_crlf = MANIFEST.replace('\n', "\r\n");

    let lf = dir_quellen(MANIFEST, "pulse-player");
    let crlf = dir_quellen(&mit_crlf, "pulse-player");

    assert_eq!(lf, crlf, "CRLF und LF muessen dieselben Quellen ergeben");
    assert_eq!(
        lf,
        ["pulse-bildmarke", "pulse-zeigerbild"].map(String::from).into(),
        "die Auswertung findet nicht genau die Quellen des Moduls — das tiefer \
         eingerueckte 'ffnvcodec' beendet das ffmpeg-Modul faelschlich, oder die \
         Abgrenzung greift gar nicht mehr"
    );
}
