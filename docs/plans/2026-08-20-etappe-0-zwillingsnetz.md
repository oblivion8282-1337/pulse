# Etappe 0: Das Netz spannen — Gleichheits-Tests für alle Doppelungen

> **Für agentische Bearbeiter:** ERFORDERLICHE UNTER-SKILL: `superpowers:subagent-driven-development` (empfohlen) oder `superpowers:executing-plans`. Die Schritte tragen Checkbox-Syntax (`- [ ]`).

**Ziel:** Jede bekannte Code-Doppelung zwischen den vier Rust-Programmen unter `streaming/` bekommt einen Test, der Abweichungen rot macht — insbesondere die von **Windows**, das heute in keinem solchen Test steht.

**Aufbau:** Eine neue, winzige Test-Crate `streaming/zwillinge/` ohne jede Abhängigkeit. Sie liest die zu vergleichenden Dateien mit `include_str!` zur Übersetzungszeit und braucht deshalb **keine** der Plattformen zu bauen. Damit läuft sie auf jedem Rechner in Sekunden — genau die Eigenschaft, an der ein Test in einer der Sidecar-Crates scheitern würde.

**Technik:** Rust, keine Abhängigkeiten, nur `#[test]` und `include_str!`.

**Entwurf:** `docs/specs/2026-08-20-gemeinsame-bausteine-design.md` — Etappe 0.

**Zweig:** `docs/gemeinsame-bausteine` (der Entwurf liegt dort schon) oder ein neuer `feat/zwillingsnetz` von frisch gepulltem `main`.

## Globale Randbedingungen

- **Nie direkt auf `main`.** Landen nur über GitHub-PR via `bash scripts/ship.sh`. Merge nach `main` = Prod-Deploy, braucht Freigabe.
- **Kein `git push`, keine GitHub-CLI ohne Freigabe.**
- **Diese Etappe ändert KEINEN Produktivcode.** Sie legt nur Tests an. Wer meint, eine der verglichenen Dateien ändern zu müssen, damit ein Test grün wird, hält an und berichtet — genau diese Abweichung ist der gesuchte Befund.
- **Alles hier ist auf einer einzigen Maschine prüfbar**, weil `include_str!` zur Übersetzungszeit liest und nichts von den fremden Plattformen gebaut werden muss.
- **Sprache:** Rust-Doc-Kommentare in diesen Crates sind ASCII (`ae`/`oe`/`ue`/`ss`). Commit-Messages und Changelog mit echten Umlauten. **Keine Emojis.**
- **Kein Changelog-Eintrag nötig** — reine Testinfrastruktur, nicht nutzersichtbar (`NON_USER_FACING` in `scripts/check-changelog.sh`).
- Quelldateien ≤ 350 Zeilen (hart 500), ausgenommen Tests.

## Ausgangslage, selbst gemessen am 2026-08-20

Auf `main`. Die `whip/`-Dateien liegen dort nur in win und linux — die mac-Fassung entsteht erst mit `feat/mac-whip-sender`.

| Datei | Paar | Abweichung roh | ohne Kommentare | Klasse |
|---|---|---|---|---|
| `whip/sdp.rs` | win–linux | **0** | 0 | **A: bitgleich** |
| `ops/state.rs` | linux–mac | **0** | 0 | **A: bitgleich** |
| `whip/av1.rs` | win–linux | 8 | **0** | **B: logisch gleich** |
| `zeitbasis.rs` | win–linux | 6 | **0** | **B** |
| `proto.rs` | win–mac | 5 | **0** | **B** |
| `events.rs` | linux–mac | 8 | **0** | **B** |
| `profiles.rs` | linux–mac | 20 | 1 | C: fast gleich |
| `ops/stop.rs` | linux–mac | 8 | 2 | C |
| `ops/keyframe.rs` | win–linux | 29 | 2 | C |
| `events.rs` | win–linux | 51 | 4 | C |
| `ops/mod.rs` | linux–mac | 29 | 8 | C |
| `proto.rs` | win–linux | 57 | 39 | D: echt verschieden |
| `whip/mod.rs` | win–linux | 122 | 80 | D |
| `whip/pacer.rs` | win–linux | 250 | 120 | D |

**Der Befund vorab, den Etappe 0 eigentlich klären sollte, ist damit schon da: Windows ist NICHT abgewichen.** `sdp.rs` ist byte-identisch mit Linux, `av1.rs` und `zeitbasis.rs` unterscheiden sich nur in Kommentaren. Die Sorge war unbegründet — aber sie war es wert, geprüft zu werden, und ab jetzt bleibt sie es.

**Warum Klasse B keinen byte-genauen Test bekommen darf:** Bei `zeitbasis.rs` verweisen die abweichenden Kommentare auf **plattformeigene Module** — `crate::tick_monitor` auf Windows, `stream_controller.rs` auf Linux. Diese Abweichung ist nicht nur harmlos, sie ist **richtig**. Ein Test, der sie rot macht, würde zum Nachziehen einer Falschaussage verleiten.

**Klasse C und D bekommen in dieser Etappe keinen Test.** C sind Kandidaten für die späteren Etappen (dort verschwinden sie ohnehin), D sind keine Zwillinge. Beide werden nur dokumentiert.

## Dateiübersicht

| Datei | Verantwortung | Aufgabe |
|---|---|---|
| `streaming/zwillinge/Cargo.toml` | die Test-Crate, ohne Abhängigkeiten | 1 |
| `streaming/zwillinge/src/lib.rs` | leer bis auf die Vergleichs-Hilfe | 1, 2 |
| `streaming/zwillinge/tests/bitgleich.rs` | Klasse A | 1 |
| `streaming/zwillinge/tests/logisch_gleich.rs` | Klasse B | 2 |
| `streaming/zwillinge/README.md` | was hier bewacht wird und was nicht | 3 |
| `streaming/pulse-player/tests/zwillinge.rs` | wandert nach `streaming/zwillinge/` | 3 |
| `.github/workflows/ci.yml` | die Crate in der CI fahren | 3 |

---

## Aufgabe 1: Die Test-Crate und die bitgleichen Paare

**Dateien:**
- Erstellen: `streaming/zwillinge/Cargo.toml`, `streaming/zwillinge/src/lib.rs`, `streaming/zwillinge/tests/bitgleich.rs`

**Interfaces:**
- Erzeugt: die Crate `zwillinge`. Aufgabe 2 und 3 bauen darauf auf.

**Hintergrund für den Bearbeiter.** Es gibt im Repo bereits ein solches Muster: `streaming/pulse-player/tests/zwillinge.rs` hält `zeigerbild.rs` zwischen Player und Windows-Sidecar zusammen. Es liegt aber **in** einer Crate, die zum Bauen eine gepatchte webrtc-Kopie und eine passende FFmpeg braucht — der Test läuft also nur, wo der Player baut.

Diese Crate löst das: keine Abhängigkeiten, kein Produktivcode, nur Tests. `cargo test -p zwillinge` läuft überall in Sekunden.

`include_str!` liest zur **Übersetzungszeit** aus dem Dateisystem. Der Test vergleicht also die Dateien im Repo, ohne dass irgendeine der Plattformen gebaut werden muss. Das ist der Grund, warum diese Etappe vollständig auf einer Maschine prüfbar ist.

- [ ] **Schritt 1: Die Crate anlegen**

`streaming/zwillinge/Cargo.toml`:

```toml
[package]
name = "zwillinge"
version = "0.1.0"
edition = "2024"
publish = false

# Bewusst OHNE Abhaengigkeiten. Diese Crate soll auf jeder Maschine in
# Sekunden bauen — auch dort, wo weder FFmpeg noch ein Plattform-SDK
# vorhanden ist. Sie enthaelt keinen Produktivcode.
[dependencies]
```

`streaming/zwillinge/src/lib.rs`:

```rust
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
```

- [ ] **Schritt 2: Den ersten Test schreiben**

`streaming/zwillinge/tests/bitgleich.rs`:

```rust
//! Paare, die ZEICHEN FUER ZEICHEN gleich sein muessen.
//!
//! Fuer Paare, deren Kommentare berechtigt abweichen (weil sie auf
//! plattformeigene Module verweisen), ist `logisch_gleich.rs` zustaendig.

/// `whip/sdp.rs` — das SDP-Angebot des eigenen WebRTC-Sendewegs.
///
/// Am 2026-08-20 gemessen: byte-identisch zwischen Windows und Linux. Hier
/// darf nichts abweichen, auch kein Kommentar — die Datei enthaelt die
/// ausgehandelten Codec-Fassungen und Profil-Stufen, und eine Abweichung
/// zwischen zwei Sendern zeigt sich erst in der SDP-Verhandlung beim
/// Zuschauer.
#[test]
fn sdp_win_gleich_linux() {
    let win = include_str!("../../win-hq-sidecar/src/whip/sdp.rs");
    let linux = include_str!("../../linux-hq-sidecar/src/whip/sdp.rs");
    assert_eq!(
        win, linux,
        "whip/sdp.rs ist zwischen win-hq-sidecar und linux-hq-sidecar abgewichen. \
         Wer an einem etwas lernt, traegt es am anderen nach."
    );
}

/// `ops/state.rs` — die Zustandsabfrage des Sidecars.
///
/// Am 2026-08-20 gemessen: byte-identisch zwischen Linux und macOS.
#[test]
fn ops_state_linux_gleich_mac() {
    let linux = include_str!("../../linux-hq-sidecar/src/ops/state.rs");
    let mac = include_str!("../../mac-hq-sidecar/src/ops/state.rs");
    assert_eq!(
        linux, mac,
        "ops/state.rs ist zwischen linux-hq-sidecar und mac-hq-sidecar abgewichen."
    );
}
```

- [ ] **Schritt 3: Test laufen lassen — er muss GRÜN sein**

```bash
cd /Users/michael/Documents/pulse/streaming/zwillinge
cargo test
```

Erwartung: `2 passed`. Hier ist der grüne Lauf der Beleg, dass die Paare heute gleich sind.

- [ ] **Schritt 4: Die Gegenprobe — der Test MUSS rot werden können**

Ein Test, der nie rot wird, ist keiner. Insbesondere ein Tippfehler im `include_str!`-Pfad fällt zur Übersetzungszeit auf, aber ein Pfad, der versehentlich **zweimal dieselbe Datei** liest, wäre immer grün.

```bash
cd /Users/michael/Documents/pulse
# Ein Zeichen in EINER der beiden Dateien aendern
printf '\n// probe\n' >> streaming/win-hq-sidecar/src/whip/sdp.rs
cd streaming/zwillinge && cargo test 2>&1 | tail -5
```

Erwartung: `sdp_win_gleich_linux` schlägt **fehl**. Danach zurücknehmen:

```bash
cd /Users/michael/Documents/pulse
git checkout streaming/win-hq-sidecar/src/whip/sdp.rs
cd streaming/zwillinge && cargo test 2>&1 | tail -3
```

Erwartung: wieder `2 passed`. **Beide Läufe im Bericht festhalten.**

- [ ] **Schritt 5: Committen**

```bash
cd /Users/michael/Documents/pulse
git add streaming/zwillinge
git commit -F - <<'EOF'
test(zwillinge): eigene Crate fuer die Gleichheits-Tests, erste zwei Paare

Zwischen den vier HQ-Programmen liegen rund 2.400 Codezeilen mehrfach fast
wortgleich vor. Zweimal ist eine dieser Kopien unbemerkt auseinandergelaufen
(zeitbasis.rs am 2026-08-17, die Zero-Copy-Bruecke am 2026-08-06). Es gab
zwar schon einen Gleichheits-Test, aber er liegt in pulse-player und laeuft
deshalb nur, wo der Player baut — also nur mit gepatchter webrtc-Kopie und
passender FFmpeg.

Diese Crate hat KEINE Abhaengigkeiten und keinen Produktivcode. Sie baut auf
jeder Maschine in Sekunden, weil include_str! zur Uebersetzungszeit aus dem
Repo liest und nichts von den fremden Plattformen gebaut werden muss.

Den Anfang machen die beiden Paare, die byte-identisch sind: whip/sdp.rs
(win-linux) und ops/state.rs (linux-mac). Beide am 2026-08-20 gemessen.

Die Gegenprobe ist gefahren: ein zusaetzliches Zeichen in einer der Dateien
macht den Test nachweislich rot. Ein Test, der nie rot wird, waere keiner —
und ein include_str!-Pfad, der versehentlich zweimal dieselbe Datei liest,
waere immer gruen.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Aufgabe 2: Die logisch gleichen Paare

**Dateien:**
- Ändern: `streaming/zwillinge/src/lib.rs` (Vergleichs-Hilfe)
- Erstellen: `streaming/zwillinge/tests/logisch_gleich.rs`

**Interfaces:**
- Consumes: die Crate aus Aufgabe 1.
- Produces: `zwillinge::ohne_kommentare(&str) -> String` — entfernt Zeilenkommentare und Leerzeilen, damit Doc-Kommentare abweichen dürfen.

**Hintergrund für den Bearbeiter.** Vier Paare sind in der **Logik** identisch, weichen aber in Kommentaren ab. Ein byte-genauer Test wäre dort nicht nur zu streng, sondern **schädlich**: Bei `zeitbasis.rs` verweisen die abweichenden Kommentare auf plattformeigene Module (`crate::tick_monitor` auf Windows, `stream_controller.rs` auf Linux). Diese Abweichung ist richtig. Ein Test, der sie rot macht, würde jemanden dazu bringen, eine Falschaussage nachzuziehen.

Die Vergleichs-Hilfe entfernt deshalb **ganze Kommentarzeilen**.

**Korrektur vom 2026-08-20 abends:** Hier stand, die vier Paare nutzten „ausschliesslich `//`- und `///`-Kommentare (geprüft am 2026-08-20)". Das war behauptet, nicht geprüft, und es stimmt nicht — allein `whip/av1.rs` hat **43 Kommentare am Zeilenende**. Der Filter entfernt die nicht; sie werden mitverglichen.

Das bleibt so, und die Doku sagt es jetzt: Bei einem Zwilling ist „auch die Zeilenend-Kommentare bleiben gleich" die passendere Regel. Sie zuverlässig zu entfernen hiesse, `//` innerhalb von Zeichenketten zu erkennen — also Rust zu zerlegen. Ein Test hält die Grenze fest (`kommentar_am_zeilenende_bleibt_stehen`), damit sie nicht wieder zur unbelegten Behauptung wird.

- [ ] **Schritt 1: Den Test zuerst schreiben**

`streaming/zwillinge/tests/logisch_gleich.rs`:

```rust
//! Paare, deren LOGIK gleich sein muss, deren Kommentare aber abweichen duerfen.
//!
//! **Warum Kommentare abweichen duerfen — und muessen.** Bei `zeitbasis.rs`
//! verweisen sie auf plattformeigene Module: `crate::tick_monitor` unter
//! Windows, `stream_controller.rs` unter Linux. Ein byte-genauer Test wuerde
//! dazu verleiten, eine Falschaussage nachzuziehen, nur damit er gruen wird.
//!
//! Fuer Paare, die zeichengenau gleich sein muessen, ist `bitgleich.rs`
//! zustaendig.

use zwillinge::ohne_kommentare;

/// `whip/av1.rs` — der eigene AV1-Paketierer.
///
/// Er umgeht einen dokumentierten Fehler in webrtc-rs' `Av1Payloader`
/// (Laengenfelder ab 128 falsch geschrieben). Laufen die Fassungen
/// auseinander, sendet eine Plattform Pakete, die der Zuschauer nicht
/// zusammensetzen kann — und das faellt erst am schwarzen Bild auf.
///
/// Am 2026-08-20 gemessen: 496 Codezeilen je Seite, null Abweichung. Die
/// acht Rohzeilen Unterschied sind ein Doc-Absatz an anderer Stelle.
#[test]
fn av1_win_gleich_linux() {
    let win = include_str!("../../win-hq-sidecar/src/whip/av1.rs");
    let linux = include_str!("../../linux-hq-sidecar/src/whip/av1.rs");
    assert_eq!(
        ohne_kommentare(win),
        ohne_kommentare(linux),
        "whip/av1.rs ist in der LOGIK abgewichen (Kommentare duerfen abweichen)."
    );
}

/// `zeitbasis.rs` — die RTP-Taktrechnung.
///
/// **Die Stelle, an der es schon einmal passiert ist**: am 2026-08-17 liefen
/// die beiden Fassungen unbemerkt auseinander. Folgenlos nur durch Zufall, weil
/// es Kommentarzeilen traf. Genau dieser Test haette es gemeldet.
#[test]
fn zeitbasis_win_gleich_linux() {
    let win = include_str!("../../win-hq-sidecar/src/zeitbasis.rs");
    let linux = include_str!("../../linux-hq-sidecar/src/zeitbasis.rs");
    assert_eq!(
        ohne_kommentare(win),
        ohne_kommentare(linux),
        "zeitbasis.rs ist in der LOGIK abgewichen. Encoder-Uhr und RTP-Uhr \
         muessen auf allen Plattformen dieselbe sein."
    );
}

/// `proto.rs` — das stdio-JSON-RPC-Rahmenformat zwischen Electron und Sidecar.
///
/// Nur win gegen mac: die Linux-Fassung ist echt verschieden (80 gegen 47
/// Codezeilen) und kein Zwilling.
#[test]
fn proto_win_gleich_mac() {
    let win = include_str!("../../win-hq-sidecar/src/proto.rs");
    let mac = include_str!("../../mac-hq-sidecar/src/proto.rs");
    assert_eq!(
        ohne_kommentare(win),
        ohne_kommentare(mac),
        "proto.rs ist in der LOGIK abgewichen. Beide Seiten sprechen dasselbe \
         Protokoll mit demselben Electron-Wirt."
    );
}

/// `events.rs` — die Ereignis-Ausgabe auf stdout.
///
/// Nur linux gegen mac: die win-Fassung weicht in vier Codezeilen ab und ist
/// damit Klasse C (s. README dieser Crate).
#[test]
fn events_linux_gleich_mac() {
    let linux = include_str!("../../linux-hq-sidecar/src/events.rs");
    let mac = include_str!("../../mac-hq-sidecar/src/events.rs");
    assert_eq!(
        ohne_kommentare(linux),
        ohne_kommentare(mac),
        "events.rs ist in der LOGIK abgewichen."
    );
}
```

- [ ] **Schritt 2: Test laufen lassen und Fehlschlag bestätigen**

```bash
cd /Users/michael/Documents/pulse/streaming/zwillinge
cargo test --test logisch_gleich 2>&1 | tail -10
```

Erwartung: **Kompilierfehler**, `ohne_kommentare` gibt es nicht.

- [ ] **Schritt 3: Die Vergleichs-Hilfe schreiben**

An `streaming/zwillinge/src/lib.rs` anhängen:

```rust
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
```

- [ ] **Schritt 4: Tests laufen lassen**

```bash
cd /Users/michael/Documents/pulse/streaming/zwillinge
cargo test 2>&1 | grep -E "^test |test result"
```

Erwartung: alle grün — 2 aus `bitgleich.rs`, 4 aus `logisch_gleich.rs`, 2 aus `lib.rs`.

**Wird einer der vier Paar-Tests rot, halte an und berichte.** Das wäre eine echte, bisher unbemerkte Abweichung — der gesuchte Befund, kein Testfehler.

- [ ] **Schritt 5: Die Gegenprobe für den Kommentar-Filter**

Der Filter muss Logik-Abweichungen fangen und Kommentar-Abweichungen durchlassen. Beides prüfen:

```bash
cd /Users/michael/Documents/pulse
# (a) Ein KOMMENTAR weicht ab -> muss GRUEN bleiben
printf '\n// nur ein Kommentar\n' >> streaming/win-hq-sidecar/src/zeitbasis.rs
cd streaming/zwillinge && cargo test --test logisch_gleich 2>&1 | grep "test result"
cd /Users/michael/Documents/pulse && git checkout streaming/win-hq-sidecar/src/zeitbasis.rs

# (b) CODE weicht ab -> muss ROT werden
printf '\nfn probe() {}\n' >> streaming/win-hq-sidecar/src/zeitbasis.rs
cd streaming/zwillinge && cargo test --test logisch_gleich 2>&1 | grep "test result"
cd /Users/michael/Documents/pulse && git checkout streaming/win-hq-sidecar/src/zeitbasis.rs
```

Erwartung: (a) grün, (b) rot. **Beide Läufe im Bericht festhalten** — ein Filter, der zu viel wegwirft, macht den Test wertlos, ohne dass es auffällt.

- [ ] **Schritt 6: Committen**

---

## Aufgabe 3: Den bestehenden Test übernehmen, CI, und die Restfälle dokumentieren

**Dateien:**
- Verschieben: `streaming/pulse-player/tests/zwillinge.rs` → `streaming/zwillinge/tests/bitgleich.rs` (der Zeigerbild-Fall)
- Erstellen: `streaming/zwillinge/README.md`
- Ändern: `.github/workflows/ci.yml`

- [ ] **Schritt 1: Den Zeigerbild-Fall übernehmen**

`streaming/pulse-player/tests/zwillinge.rs` hält heute `zeigerbild.rs` zwischen Player und Windows-Sidecar (byte-genau, Klasse A). Nimm den Test **mit seinem Doc-Kommentar** nach `streaming/zwillinge/tests/bitgleich.rs` und passe nur die `include_str!`-Pfade an.

Lösche die alte Datei danach — **aber prüfe vorher**, ob sie noch etwas anderes enthält als diesen einen Fall:

```bash
grep -c "#\[test\]" streaming/pulse-player/tests/zwillinge.rs
```

Enthält sie mehr als einen Test, nimm alle mit.

- [ ] **Schritt 2: Das README schreiben**

`streaming/zwillinge/README.md` — es muss beantworten, was hier bewacht wird **und was nicht**, samt der gemessenen Zahlen aus der Tabelle oben (Klassen A bis D). Besonders wichtig: **Klasse C und D sind hier absichtlich nicht vertreten**, und warum.

Ohne diesen Abschnitt entsteht der falsche Eindruck, die Crate decke alle Doppelungen ab.

- [ ] **Schritt 3: In die CI einhängen**

`.github/workflows/ci.yml` hat heute vier Jobs (`backend`, `frontend`, `changelog`, `images`) und **keinen** Rust-Job — die Sidecars werden in den Plattform-Workflows gebaut. Diese Crate hat keine Abhängigkeiten und kann deshalb hier laufen.

Neuer Job, einzurücken auf derselben Ebene wie `backend:` (zwei Leerzeichen), am besten direkt hinter `frontend`:

```yaml
  # Haelt die bewusst doppelt gefuehrten Dateien der HQ-Programme zusammen
  # (streaming/zwillinge/). Laeuft HIER und nicht in den Plattform-Workflows,
  # weil die Crate keine Abhaengigkeiten hat: `include_str!` liest zur
  # Uebersetzungszeit aus dem Repo, es muss also weder FFmpeg noch ein
  # Plattform-SDK vorhanden sein. Sekunden, kein Cache noetig.
  zwillinge:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - name: Zwillinge pruefen
        run: cargo test --manifest-path streaming/zwillinge/Cargo.toml
```

**Nicht ändern:** die `paths-ignore` auf beiden Triggern (`**.md`, `docs/**`, `.claude/**`). Eine reine Doku-Änderung soll den Lauf weiterhin nicht auslösen — und die verglichenen Dateien sind `.rs`, fallen also nicht darunter.

**Nicht in den `images`-Job eingreifen.** Er hängt laut CLAUDE.md bewusst nur am `changelog`-Job, damit das Deployment nicht an einem Test-Gate hängt. Der neue Job bekommt also **kein** `needs:` und ist für nichts eine Vorbedingung.

- [ ] **Schritt 4: YAML prüfen**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('YAML ok')"
```

- [ ] **Schritt 5: Volle Prüfung und Commit**

```bash
cd streaming/zwillinge && cargo test 2>&1 | grep "test result"
cd /Users/michael/Documents/pulse
REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q 2>&1 | tail -3
cd web && pnpm check 2>&1 | tail -2
```

---

## Nach dem Landen

Sobald `feat/mac-whip-sender` gelandet ist, kommen die dortigen Paare dazu: `whip/av1.rs` und `whip/sdp.rs` haben dann eine **dritte** Fassung (mac). Der Test aus `mac-hq-sidecar/tests/zwillinge.rs` wandert dann ebenfalls hierher, und aus den Paar-Tests werden Dreier-Vergleiche.

Das ist keine offene Aufgabe dieses Plans, sondern ein Hinweis für den, der den mac-Zweig landet.

## Was diese Etappe NICHT tut

- **Keinen Produktivcode ändern.** Wird ein Test rot, ist das der Befund.
- **Klasse C und D nicht abdecken.** C verschwindet in den späteren Etappen ohnehin, D sind keine Zwillinge.
- **Die Token-Redaktion nicht anfassen.** Sie verhält sich auf den drei Plattformen verschieden und ist deshalb gerade **kein** Zwilling — sie ist Etappe 1.

## Abschluss

Wenn alles grün ist: `superpowers:finishing-a-development-branch`. **Merge nach `main` ist ein Prod-Deploy und braucht Freigabe.**
