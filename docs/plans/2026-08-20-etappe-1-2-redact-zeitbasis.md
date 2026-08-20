# Etappe 1 und 2: `pulse-redact` und `pulse-zeitbasis`

> **Für agentische Bearbeiter:** ERFORDERLICHE UNTER-SKILL: `superpowers:subagent-driven-development` (empfohlen) oder `superpowers:executing-plans`. Die Schritte tragen Checkbox-Syntax (`- [ ]`).

**Ziel:** Zwei kleine, geteilte Crates. `pulse-redact` beseitigt ein echtes Leck — die Token-Maskierung verhält sich heute auf den drei Plattformen verschieden. `pulse-zeitbasis` beseitigt eine Doppelung, die schon einmal unbemerkt auseinandergelaufen ist.

**Aufbau:** Geteilte Crates per Pfad-Abhängigkeit, **kein Cargo-Workspace** (Begründung im Entwurf: der Workspace hat sieben Hindernisse, zwei davon hart). Jedes Programm behält sein eigenes `Cargo.lock`, seine FFmpeg-Fassung und seine Toolchain.

**Technik:** Rust, beide Crates ohne Abhängigkeiten.

**Entwurf:** `docs/specs/2026-08-20-gemeinsame-bausteine-design.md` — Etappen 1 und 2.

**Zweig:** `feat/gemeinsame-bausteine` (enthält bereits Etappe 0 und den mac-WHIP-Sender)

## Globale Randbedingungen

- **Nie direkt auf `main`.** Landen nur über GitHub-PR via `bash scripts/ship.sh`. Merge = Prod-Deploy, braucht Freigabe.
- **Kein `git push`, keine GitHub-CLI ohne Freigabe.**
- **Der Windows- und der Linux-Sidecar bauen auf diesem Mac NICHT.** Du kannst sie ändern, aber nicht übersetzen. Prüfe deshalb besonders sorgfältig durch Lesen — jede Änderung dort wird auf der jeweiligen Maschine per Übergabedokument bestätigt (Aufgabe 4).
- **Test-Gate lokal:** `cargo test` in den Crates, die hier bauen (`pulse-redact`, `pulse-zeitbasis`, `mac-hq-sidecar`, `zwillinge`). Vor dem Push zusätzlich pytest, `pnpm check`, `pnpm build`.
- **Keine neuen Abhängigkeiten.** Beide Crates kommen ohne aus.
- **Niemals Stream-Keys oder Tokens loggen.** Das ist der Gegenstand von Etappe 1 — hier wiegt jeder Fehler doppelt.
- **Sprache:** Rust-Doc-Kommentare in diesen Crates sind ASCII (`ae`/`oe`/`ue`/`ss`). **Commit-Messages mit ECHTEN Umlauten** (ä/ö/ü/ß) — Projektkonvention. **Keine Emojis.**
- **Kein Changelog-Eintrag** — reine Umbauten ohne sichtbare Verhaltensänderung für Nutzer. Ausnahme: falls die Vereinheitlichung der Maskierung als Verhaltensänderung gewertet wird, entscheidet das der Controller.
- Quelldateien ≤ 350 Zeilen (hart 500), ausgenommen Tests.
- **Alle Befehle im Vordergrund**, kein `run_in_background`.

## Ausgangslage, selbst gemessen am 2026-08-20

**Die Maskierung** (`redact.rs`) liegt dreimal vor, mit **drei verschiedenen Verhalten**:

| | Funktion | alle Vorkommen | Groß/klein egal | Abschlusszeichen |
|---|---|---|---|---|
| Windows | `secrets` | ✓ | ✗ | `is_whitespace` + `& " ' ( ) [ ] { } , ; < > \| \`` |
| Linux | `redact_url` | ✓ | ✓ | nur `&` und Leerzeichen |
| macOS | `redact_url` | ✗ (nur das erste) | ✗ | nur `&` und Leerzeichen |

Alle drei suchen dieselben Präfixe: `pass=`, `token=`, `streamid=publish:`.

**Aufrufer:** Windows 4, Linux 8, macOS 6 — **plus drei im Labor** (`win-hq-labor` nutzt `pulse_win_hq_sidecar::redact::secrets`). Das Labor ist der vierte Nutzer und wird oft übersehen.

**Die Zeitrechnung** (`zeitbasis.rs`) liegt in win und linux mit **null abweichenden Codezeilen** vor (nur Kommentare unterscheiden sich, und die verweisen berechtigt auf plattformeigene Module). macOS hat seit dem WHIP-Sender eine dritte, reduzierte Fassung.

## Dateiübersicht

| Datei | Verantwortung | Aufgabe |
|---|---|---|
| `streaming/pulse-redact/Cargo.toml` + `src/lib.rs` | die gemeinsame Maskierung | 1 |
| `streaming/{win,linux,mac}-hq-sidecar/src/redact.rs` | wird zum Re-Export | 2 |
| `streaming/pulse-zeitbasis/Cargo.toml` + `src/lib.rs` | die gemeinsame Zeitrechnung | 3 |
| `streaming/{win,linux,mac}-hq-sidecar/src/zeitbasis.rs` | wird zum Re-Export | 3 |
| `docs/plans/2026-08-20-uebergabe-etappe-1-2.md` | Prüfauftrag für Windows und Linux | 4 |

---

## Aufgabe 1: `pulse-redact` — die beste Fassung aus dreien

**Dateien:**
- Erstellen: `streaming/pulse-redact/Cargo.toml`, `streaming/pulse-redact/src/lib.rs`

**Interfaces:**
- Erzeugt: `pulse_redact::redact_url(&str) -> String` und `pulse_redact::ends_value(char) -> bool` (letzteres `pub`, damit Tests es prüfen können).

**Hintergrund für den Bearbeiter.** Diese Funktion maskiert Stream-Schlüssel, bevor irgendetwas den Prozess verlässt. Sie ist die **einzige** Schranke zwischen einer Push-URL und dem Protokoll, das `desktop/electron/sidecar.ts` dauerhaft auf die Platte schreibt.

Die gemeinsame Fassung setzt sich aus den Stärken zusammen: **Windows' Abschlusszeichen** (die gründlichsten), **Linux' Unempfindlichkeit gegen Groß-/Kleinschreibung** und **„alle Vorkommen"** von beiden. Sie fängt damit strikt mehr als jede heutige Einzelfassung.

**Zwei Kommentare aus der Windows-Fassung sind mitzunehmen, weil sie Wissen tragen, das nirgends sonst steht:**
1. Warum `/`, `+`, `=`, `%`, `:`, `-`, `_`, `.` **nicht** als Ende gelten: Base64-Schlüssel enthalten sie.
2. Warum Klammern und Anführungszeichen sehr wohl: In Fehlerketten steht die URL fast immer eingefasst (`format::output(rtmps://…?pass=x)`), sonst fräße die Maskierung die schließende Klammer mit.

- [ ] **Schritt 1: Die Crate anlegen**

`streaming/pulse-redact/Cargo.toml`:

```toml
[package]
name = "pulse-redact"
version = "0.1.0"
edition = "2024"
publish = false

# Ohne Abhaengigkeiten — diese Crate wird von allen drei Sidecars und vom
# Labor eingebunden und darf deren Bauwege nicht beschweren.
[dependencies]
```

`streaming/pulse-redact/.gitignore`:

```
/target
/Cargo.lock
```

- [ ] **Schritt 2: Die Tests zuerst — sie halten das VERHALTEN fest**

`streaming/pulse-redact/src/lib.rs`, Testmodul. Jeder Test benennt, welche der drei alten Fassungen ihn bestanden hätte — das ist der Beleg, dass die gemeinsame Fassung strikt mehr fängt:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// Der Grundfall, den alle drei alten Fassungen konnten.
    #[test]
    fn token_wird_maskiert() {
        let roh = "https://howispulse.com/whep/kanal/whip?token=geheim123";
        let s = redact_url(roh);
        assert!(!s.contains("geheim123"), "Token steht noch drin: {s}");
        assert!(s.contains("howispulse.com"), "Host soll lesbar bleiben: {s}");
    }

    /// **Konnte vorher NUR Linux.** Windows und macOS suchten
    /// gross-/kleinschreibungsempfindlich und haetten den Schluessel
    /// durchgelassen.
    #[test]
    fn grossgeschriebener_parametername_wird_auch_gefasst() {
        let s = redact_url("rtmps://h/p?Token=geheim123&x=1");
        assert!(!s.contains("geheim123"), "Token= mit grossem T durchgerutscht: {s}");
    }

    /// **Konnte vorher NUR Windows.** Linux und macOS kannten als Ende nur
    /// `&` und Leerzeichen, fanden hier keins und maskierten deshalb bis zum
    /// Ende der Meldung — der Schluessel war zwar weg, der Rest der Meldung
    /// aber auch.
    #[test]
    fn url_in_klammern_endet_an_der_klammer() {
        let s = redact_url("Fehler (url=rtmps://h/p?pass=geheim123) beim Oeffnen");
        assert!(!s.contains("geheim123"), "Schluessel steht noch drin: {s}");
        assert!(s.contains(") beim Oeffnen"), "Rest der Meldung gefressen: {s}");
    }

    /// **Konnte vorher NICHT macOS.** Verschachtelte anyhow-Kontexte
    /// enthalten dieselbe URL mehrfach; macOS maskierte nur das erste
    /// Vorkommen und liess die folgenden im Klartext stehen.
    #[test]
    fn alle_vorkommen_werden_gefasst() {
        let s = redact_url("open (rtmps://h?pass=eins): failed rtmps://h?pass=zwei");
        assert!(!s.contains("eins"), "erstes Vorkommen: {s}");
        assert!(!s.contains("zwei"), "zweites Vorkommen durchgerutscht: {s}");
    }

    /// Base64-Schluessel enthalten `/`, `+`, `=` — die duerfen NICHT als Ende
    /// gelten, sonst bliebe ein Rest des Schluessels stehen.
    #[test]
    fn base64_schluessel_wird_ganz_gefasst() {
        let s = redact_url("?token=aGVsbG8+d29ybGQ/Zm9v=");
        assert!(!s.contains("aGVsbG8"), "Anfang steht noch da: {s}");
        assert!(!s.contains("Zm9v"), "Rest des Schluessels steht noch da: {s}");
    }

    /// Alle drei bekannten Praefixe, je einer pro Sendeweg.
    #[test]
    fn alle_drei_sendewege() {
        for (roh, geheim) in [
            ("?token=abc123", "abc123"),        // WHIP
            ("?pass=abc123", "abc123"),         // RTMPS
            ("?streamid=publish:abc123", "abc123"), // SRT
        ] {
            let s = redact_url(roh);
            assert!(!s.contains(geheim), "{roh} nicht maskiert: {s}");
        }
    }

    /// Ohne Schluessel bleibt die Meldung unveraendert brauchbar.
    #[test]
    fn ohne_schluessel_unveraendert() {
        let roh = "rtmps://howispulse.com:1936/kanal";
        assert_eq!(redact_url(roh), roh);
    }
}
```

- [ ] **Schritt 3: Tests laufen lassen, Fehlschlag bestätigen**

```bash
cd /Users/michael/Documents/pulse/streaming/pulse-redact
cargo test
```

Erwartung: **Kompilierfehler**, `redact_url` gibt es nicht.

- [ ] **Schritt 4: Die Funktion schreiben**

Nimm die Windows-Fassung als Grundlage (`streaming/win-hq-sidecar/src/redact.rs`) — **samt ihrer Doc-Kommentare, wortgleich** — und ergänze Linux' Groß-/Kleinschreibungs-Toleranz. Die Suche läuft dann auf einer kleingeschriebenen Kopie, die Ersetzung im Original (ASCII-Kleinschreibung erhält die Byte-Abstände, deshalb stimmen die Positionen).

Der Modulkopf muss zusätzlich festhalten, woher die Fassung stammt und was sie gegenüber den drei alten kann:

```rust
//! Maskierung von Stream-Keys in Strings, die den Prozess verlassen.
//!
//! **Seit dem 2026-08-20 gemeinsam fuer alle drei Sidecars.** Vorher lag diese
//! Funktion dreimal vor, mit drei verschiedenen VERHALTEN: Windows kannte die
//! meisten Abschlusszeichen, aber keine Gross-/Kleinschreibungs-Toleranz;
//! Linux umgekehrt; macOS maskierte nur das erste Vorkommen je Praefix. Es gab
//! also Adressen, bei denen ein Schluessel auf einer Plattform maskiert wurde
//! und auf einer anderen im Klartext im Protokoll landete.
//!
//! Diese Fassung setzt die Staerken zusammen und faengt damit strikt mehr als
//! jede der drei. Welcher Test welche alte Luecke schliesst, steht am Test.
```

- [ ] **Schritt 5: Tests grün**

```bash
cargo test 2>&1 | grep -E "^test |test result"
```

Erwartung: alle sieben grün.

- [ ] **Schritt 6: Committen**

---

## Aufgabe 2: Die drei Sidecars (und das Labor) auf `pulse-redact` ziehen

**Dateien:**
- Ändern: `streaming/{win,linux,mac}-hq-sidecar/Cargo.toml` und `src/redact.rs`
- Prüfen: `streaming/win-hq-labor/` (nutzt `pulse_win_hq_sidecar::redact::secrets` an drei Stellen)

**Hintergrund.** Die drei `redact.rs` werden zu **Re-Exports** statt gelöscht. Das hält alle 18 Aufrufstellen unverändert — `crate::redact::redact_url(...)` funktioniert weiter, und der Diff bleibt klein genug, um ihn auf Maschinen zu prüfen, die hier nicht bauen.

**Der Namensunterschied ist die Falle:** Windows heißt die Funktion `secrets`, Linux und macOS `redact_url`. Der Re-Export in Windows muss **beide** Namen anbieten, weil `win-hq-labor` `secrets` benutzt.

- [ ] **Schritt 1: Abhängigkeit in allen drei Cargo.toml**

```toml
pulse-redact = { path = "../pulse-redact" }
```

- [ ] **Schritt 2: `linux-hq-sidecar/src/redact.rs` ersetzen**

Der ganze Inhalt wird zu:

```rust
//! Maskierung von Stream-Keys — die Fassung liegt seit dem 2026-08-20
//! gemeinsam in `pulse-redact`.
//!
//! Dieses Modul bleibt als Re-Export bestehen, damit die Aufrufstellen
//! (`crate::redact::redact_url`) unveraendert bleiben. Wer die Funktion
//! aendern will, tut es in `streaming/pulse-redact/` — sie gilt fuer alle
//! drei Sidecars.

pub use pulse_redact::redact_url;
```

- [ ] **Schritt 3: `mac-hq-sidecar/src/redact.rs` ersetzen** — wortgleich wie Schritt 2.

- [ ] **Schritt 4: `win-hq-sidecar/src/redact.rs` ersetzen — hier beide Namen**

```rust
//! Maskierung von Stream-Keys — die Fassung liegt seit dem 2026-08-20
//! gemeinsam in `pulse-redact`.
//!
//! Dieses Modul bleibt als Re-Export bestehen, damit die Aufrufstellen
//! unveraendert bleiben. Wer die Funktion aendern will, tut es in
//! `streaming/pulse-redact/` — sie gilt fuer alle drei Sidecars.

pub use pulse_redact::redact_url;

/// Der alte Name dieser Funktion unter Windows.
///
/// Bleibt bestehen, weil `../win-hq-labor` ihn an drei Stellen benutzt
/// (`pulse_win_hq_sidecar::redact::secrets`). Das Labor gehoert nicht zum
/// Auslieferumfang und soll fuer diesen Umbau nicht angefasst werden muessen.
pub fn secrets(s: &str) -> String {
    redact_url(s)
}
```

- [ ] **Schritt 5: Prüfen, dass keine Aufrufstelle bricht**

```bash
cd /Users/michael/Documents/pulse/streaming
for d in win linux mac; do
  echo "--- $d ---"
  grep -rn "redact::secrets\|redact::redact_url" $d-hq-sidecar/src/ --include="*.rs" | grep -v "src/redact.rs" | wc -l
done
grep -rn "redact::secrets" win-hq-labor/src/ | wc -l
```

Erwartung: win 4, linux 8, mac 6, Labor 3 — dieselben Zahlen wie vorher. **Keine Aufrufstelle wird geändert.**

- [ ] **Schritt 6: Bauen, was hier baut**

```bash
cd /Users/michael/Documents/pulse/streaming/mac-hq-sidecar
export PKG_CONFIG_PATH="$HOME/src/ffmpeg-openssl/lib/pkgconfig:$PKG_CONFIG_PATH"
cargo test 2>&1 | grep -E "test result|^error"
```

Erwartung: grün. **Windows und Linux bauen hier nicht** — für sie prüfst du durch Lesen und meldest das im Bericht.

- [ ] **Schritt 7: Committen**

---

## Aufgabe 3: `pulse-zeitbasis`

**Dateien:**
- Erstellen: `streaming/pulse-zeitbasis/Cargo.toml`, `src/lib.rs`
- Ändern: `streaming/{win,linux,mac}-hq-sidecar/Cargo.toml` und `src/zeitbasis.rs`
- Ändern: `streaming/zwillinge/tests/logisch_gleich.rs` (der Zwillings-Test wird überflüssig)

**Hintergrund.** `zeitbasis.rs` liegt in win und linux mit **null abweichenden Codezeilen** vor; macOS hat eine reduzierte dritte Fassung. Es ist reine, seiteneffektfreie Arithmetik ohne Plattformbezug — der einfachste denkbare Fall für eine gemeinsame Crate.

Und die Stelle, an der die Doppelung schon einmal zugeschlagen hat: am 2026-08-17 liefen die beiden Fassungen unbemerkt auseinander, folgenlos nur durch Zufall, weil es Kommentarzeilen traf.

**Wichtig:** Die Windows- und Linux-Fassung enthalten mehr als der Sendeweg braucht (etwa `lueckenschwelle`). Nimm den **vollen** Inhalt der Windows-Fassung — nicht die reduzierte mac-Fassung —, sonst verlieren win und linux Funktionen.

- [ ] **Schritt 1: Den Umfang feststellen**

```bash
cd /Users/michael/Documents/pulse/streaming
grep -n "^pub " win-hq-sidecar/src/zeitbasis.rs
grep -n "^pub " linux-hq-sidecar/src/zeitbasis.rs
grep -n "^pub " mac-hq-sidecar/src/zeitbasis.rs
diff win-hq-sidecar/src/zeitbasis.rs linux-hq-sidecar/src/zeitbasis.rs
```

**Weichen win und linux in einer Codezeile ab, halte an und berichte** — dann ist zwischen der Messung vom 2026-08-20 und jetzt etwas passiert, und das will verstanden werden, bevor eine Fassung zur gemeinsamen erklärt wird.

- [ ] **Schritt 2: Die Crate anlegen**

`streaming/pulse-zeitbasis/Cargo.toml` — wie `pulse-redact`, nur mit `name = "pulse-zeitbasis"`. Dazu dieselbe `.gitignore`.

- [ ] **Schritt 3: Den Inhalt übernehmen**

Der **volle** Inhalt von `win-hq-sidecar/src/zeitbasis.rs`, wortgleich samt aller Doc-Kommentare. Ergänze im Modulkopf:

```rust
//! **Seit dem 2026-08-20 gemeinsam fuer alle drei Sidecars.** Vorher lag diese
//! Rechnung dreimal vor. Am 2026-08-17 sind zwei der Fassungen unbemerkt
//! auseinandergelaufen — folgenlos nur durch Zufall, weil es Kommentarzeilen
//! traf. Genau dafuer gibt es diese Crate.
```

**Kommentare, die auf plattformeigene Module verweisen** (die Windows-Fassung nennt `crate::tick_monitor`, die Linux-Fassung `stream_controller.rs`), müssen umformuliert werden: Die gemeinsame Crate kennt weder das eine noch das andere. Schreib die Aussage plattformneutral, ohne den Inhalt zu verlieren.

- [ ] **Schritt 4: Die drei Sidecars auf Re-Export umstellen**

Je `src/zeitbasis.rs`:

```rust
//! Zeitbasis — die Rechnung liegt seit dem 2026-08-20 gemeinsam in
//! `pulse-zeitbasis`. Dieses Modul bleibt als Re-Export bestehen, damit die
//! Aufrufstellen (`crate::zeitbasis::…`) unveraendert bleiben.

pub use pulse_zeitbasis::*;
```

Dazu `pulse-zeitbasis = { path = "../pulse-zeitbasis" }` in allen drei `Cargo.toml`.

- [ ] **Schritt 5: Den Zwillings-Test entfernen — er ist jetzt gegenstandslos**

`streaming/zwillinge/tests/logisch_gleich.rs` enthält `zeitbasis_win_gleich_linux`. Die beiden Dateien sind jetzt Re-Exports derselben Crate; der Test vergliche zwei Einzeiler.

**Nicht einfach löschen** — ersetze ihn durch einen Kommentar an derselben Stelle, der festhält, dass dieses Paar am 2026-08-20 in `pulse-zeitbasis` zusammengeführt wurde und deshalb keinen Vergleich mehr braucht. Wer später sucht, warum hier nichts steht, soll die Antwort finden.

- [ ] **Schritt 6: Bauen und testen**

```bash
cd /Users/michael/Documents/pulse/streaming/pulse-zeitbasis && cargo test
cd ../zwillinge && cargo test
cd ../mac-hq-sidecar
export PKG_CONFIG_PATH="$HOME/src/ffmpeg-openssl/lib/pkgconfig:$PKG_CONFIG_PATH"
cargo test 2>&1 | grep -E "test result|^error"
```

- [ ] **Schritt 7: Committen**

---

## Aufgabe 4: Das Übergabedokument für Windows und Linux

**Dateien:**
- Erstellen: `docs/plans/2026-08-20-uebergabe-etappe-1-2.md`

**Hintergrund.** Zwei der drei Sidecars bauen auf dieser Maschine nicht. Ihre Bestätigung kommt von den Rechnern, auf denen sie bauen. Das im Repo etablierte Muster dafür sind Übergabedokumente (`docs/plans/*-uebergabe-*.md`) — sie nennen genau, was zu tun und was zurückzumelden ist.

- [ ] **Schritt 1: Das Dokument schreiben**

Es muss enthalten:

**Was geändert wurde und warum** — knapp: Maskierung und Zeitrechnung liegen jetzt in geteilten Crates, die alten Module sind Re-Exports, **keine Aufrufstelle wurde angefasst**. Für die Maskierung gilt: das Verhalten ändert sich auf **allen** Plattformen, sie fängt jetzt strikt mehr (die Tabelle aus diesem Plan gehört hinein).

**Was auf der Maschine zu tun ist:**
- `git pull`, Zweig auschecken
- `cargo test` im jeweiligen Sidecar — muss grün sein
- `cargo test -p pulse-redact` und `-p pulse-zeitbasis`
- **Ein echter Stream**, und zwar mit Blick ins Protokoll: Es darf **kein** Stream-Schlüssel im Klartext stehen. Die Push-URL erscheint dort mehrfach (Start-Antwort, argv, Fehlerketten) — jede Stelle prüfen.
- Auf Windows zusätzlich: `cargo check` im **Labor** (`win-hq-labor`), weil es `redact::secrets` benutzt.

**Was zurückzumelden ist:** Testausgaben im Wortlaut, das Ergebnis der Protokoll-Prüfung, und ob irgendwo noch ein Schlüssel sichtbar war.

- [ ] **Schritt 2: Committen**

---

## Von Hand prüfen

- **Auf Windows und Linux** — siehe Übergabedokument. Ohne diese Bestätigung landet die Etappe nicht.
- **Auf dem Mac**: ein echter Stream, Protokoll auf Schlüssel absuchen.

## Abschluss

Wenn alles steht und beide Übergaben zurück sind: `superpowers:finishing-a-development-branch`. **Merge nach `main` ist ein Prod-Deploy und braucht Freigabe.**
