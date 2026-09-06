# Zwischenablage Stufe 1a — die Kiste `pulse-ablage`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eine abhängigkeitsfreie Rust-Kiste, die das Rahmenformat, die Stückelung und die Zustandsmaschine der geteilten Zwischenablage trägt — vollständig ohne Betriebssystem prüfbar, samt einem Rundlauftest, der belegt, dass beim Kopieren **kein Inhalt** über die Leitung geht.

**Architecture:** Verzögertes Rendern. Beim Kopieren geht nur eine Ankündigung (`neu`) mit einer Generationsnummer hinüber; der Inhalt erst, wenn die Gegenseite beim tatsächlichen Einfügen `hol` schickt. Die Kiste kennt weder Fenster noch Sockets: sie nimmt Rahmen entgegen und gibt Rahmen zurück. Die beiden Berührungspunkte mit dem Betriebssystem sind Traits (`Beobachter`, `Eigentum`), für die ein Testdoppel mitgeliefert wird.

**Tech Stack:** Rust, edition 2024. Einzige Abhängigkeit: `pulse-fernsteuerung` (Schwesterkiste, Pfad) für `serde_json` und das handgeschriebene Base64. Tests mit dem eingebauten `cargo test`.

**Spec:** `docs/superpowers/specs/2026-08-31-fernsteuerung-zwischenablage-design.md`

## Global Constraints

- **Keine neue Fremdabhängigkeit.** Die Grenze steht in `streaming/pulse-fernsteuerung/Cargo.toml`: jede weitere braucht eine eigene Nachmessung und Entscheidung. Diese Kiste nimmt genau eine Pfad-Abhängigkeit auf (`pulse-fernsteuerung`), die alle Verbraucher ohnehin nennen.
- **Größen-Policy:** Quelldateien ≤ 350 Zeilen (hart 500). Tests sind ausgenommen.
- **Deutsche Bezeichner** für neuen Code in `streaming/pulse-*` — die Schwesterkisten (`zeigerbuch`, `zuordnung`, `druck`, `frist`) sind durchgehend deutsch.
- **`edition = "2024"`**, wie neun der elf Kisten im Baum. **Damit ist `gen` als Rust-Bezeichner gesperrt** — es ist dort ein reserviertes Schlüsselwort (nachgemessen 2026-08-31, cargo 1.98.0: `expected identifier, found reserved keyword \`gen\``). Der Bezeichner heisst deshalb überall `generation`; **das Feld auf der Leitung heisst weiter `"gen"`** — es ist eine Zeichenkette, kein Bezeichner, und die Spec nennt es so. Weder die Edition senken noch `r#gen` schreiben: das erste macht die Kiste zur Ausnahme unter elf, das zweite pflanzt sich durch jede Folge-Task fort.
- **Ein Kommentar darf nicht mehr behaupten, als er hält.** Wer einen Grund hinschreibt, prüft ihn am Code an dieser Stelle und trennt „gemessen" von „aus der Doku gefolgert".
- **Gateway-Deckel, gegen den gerechnet wird:** `_SIGNAL_MAX_DATA_BYTES = 8 * 1024` (8192), gemessen an `len(json.dumps(data, separators=(",",":")))` in `services/chat-gateway/src/dcc_chat_gateway/routes/ws_remote_handlers.py:98,423`. `_SIGNAL_MAX_MESSAGES_PER_S = 60`, Überschreitung wird **still** verworfen.
- **Kein Changelog-Eintrag** — das Merkmal hängt an `REMOTE_CONTROL`, das nicht in `DEFAULT_EVERYONE_PERMISSIONS` steht.
- **Kein `git push`** ohne Freigabe des Nutzers.

## Was dieser Plan NICHT tut

Er bindet die Kiste in **keinen** Verbraucher ein. `pulse-player`, `win-hq-sidecar` und `mac-hq-sidecar` kommen in Plan 1b und 1c dazu, zusammen mit den Pfad-Filtern in `win-build.yml`/`mac-build.yml`/`flatpak.yml` und den `type: dir`-Quellen im Flatpak-Manifest (die `streaming/zwillinge`-Prüfsteine erzwingen das dort, sobald die Abhängigkeit existiert — vorher haben sie nichts zu prüfen).

**Die Selbstdrosselung auf 30 Stücke/s gehört ebenfalls nicht hierher**, obwohl die Spec sie unter denselben Abschnitt stellt. Sie ist eine Pflicht des SENDERS, und gesendet wird erst in Plan 1b (Renderer → WS). Die Kiste gibt eine Liste von Rahmen zurück und sagt nichts darüber, in welchem Takt sie hinausgehen — genau wie die Wire-Spec die Flutkontrolle dem Steuernden auferlegt und nicht dem Frame-Format. Wer sie hier einbaute, hätte einen Taktgeber in einer Kiste ohne Uhr.

`scripts/gate-rust.sh` braucht **keinen** Eingriff: es fährt jede geänderte `streaming/pulse-*`-Kiste über eine Schleife (`sed -n 's|^\(streaming/pulse-[a-z-]*\)/.*|\1|p'`), `pulse-ablage` fällt automatisch hinein. Nachgesehen am 2026-08-31.

---

### Task 1: Kiste anlegen und das Rahmenformat

**Files:**
- Create: `streaming/pulse-ablage/Cargo.toml`
- Create: `streaming/pulse-ablage/.gitignore`
- Create: `streaming/pulse-ablage/src/lib.rs`
- Create: `streaming/pulse-ablage/src/format.rs`

**Interfaces:**
- Consumes: `pulse_fernsteuerung::base64::{kodiere, dekodiere}` — `kodiere(bytes: &[u8]) -> String`, `dekodiere(s: &str) -> Result<Vec<u8>, String>`
- Produces:
  - `pulse_ablage::format::{MAX_TEXT_BYTE, MAX_STUECK_ROH}` (`usize`)
  - `pulse_ablage::format::Grund` — `Veraltet | ZuGross | Weg | Frist`, mit `fn als_str(&self) -> &'static str` und `fn aus_str(s: &str) -> Option<Grund>`
  - `pulse_ablage::format::Inhaltstyp` — `Text | Anderes(String)`
  - `pulse_ablage::format::Rahmen` — `Neu { generation: u64, typ: Inhaltstyp } | Hol { generation: u64, id: u64 } | Stueck { id: u64, i: u32, n: u32, d: String } | Leer { id: u64, grund: Grund }`, mit `fn nach_json(&self) -> serde_json::Value` und `fn aus_json(v: &serde_json::Value) -> Result<Rahmen, String>`

- [ ] **Step 1: Kiste anlegen**

`streaming/pulse-ablage/Cargo.toml`:

```toml
[package]
name = "pulse-ablage"
version = "0.1.0"
edition = "2024"
publish = false
description = "Geteilte Zwischenablage der Fernsteuerung — Rahmenformat, Stueckelung, Zustandsmaschine"

# Grundsatz wie in `pulse-zeitbasis` und `pulse-fernsteuerung`: keine
# Abhaengigkeit, die einen Bauweg beschwert. Hier genau eine, und sie ist keine
# Fremdquelle: `pulse-fernsteuerung` liegt im selben Baum, wird von allen drei
# Verbrauchern dieser Kiste (pulse-player, win-hq-sidecar, mac-hq-sidecar)
# ohnehin schon genannt, und liefert zwei Dinge, die sonst hier ein zweites Mal
# entstuenden: `serde_json` (dort mit derselben Nachmessung aufgenommen) und das
# handgeschriebene Base64. Ein eigenes Base64 waere genau die Doppelung, gegen
# die `pulse-zeigerbild` und `pulse-zeitbasis` gebaut wurden.
[dependencies]
pulse-fernsteuerung = { path = "../pulse-fernsteuerung" }
serde_json = "1"
```

`streaming/pulse-ablage/src/lib.rs`:

```rust
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

pub mod beobachter;
pub mod eigentum;
pub mod format;
pub mod pruefstand;
pub mod sitzung;
pub mod stueckelung;
```

Die Module `beobachter`, `eigentum`, `pruefstand`, `sitzung` und `stueckelung` entstehen in den Tasks 2–5. Damit Task 1 für sich übersetzt, wird `lib.rs` in diesem Schritt zunächst nur mit `pub mod format;` angelegt und in den Folge-Tasks je um eine Zeile ergänzt.

Und `streaming/pulse-ablage/.gitignore` — zwei Zeilen, wortgleich zu jeder
Schwesterkiste:

```
/target
/Cargo.lock
```

**Ohne sie landen die Bauartefakte im Commit.** Die Wurzel-`.gitignore` führt
`target/` **je Kiste einzeln** auf (`/streaming/pulse-player/target/` …); es
gibt keine allgemeine Regel, und eine neue Kiste ist deshalb zunächst
ungeschützt. Beim ersten Anlauf dieses Plans sind so 71 MB Bauartefakte in zwei
Commits gelandet — 324 Dateien, die niemandem auffallen, weil `git status`
danach sauber aussieht.

- [ ] **Step 2: Den fehlschlagenden Test schreiben**

In `streaming/pulse-ablage/src/format.rs` ans Dateiende:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn hin_und_zurueck(r: Rahmen) {
        let j = r.nach_json();
        let zurueck = Rahmen::aus_json(&j).expect("muss lesbar sein");
        assert_eq!(r, zurueck, "Rundlauf verliert etwas: {j}");
    }

    #[test]
    fn alle_vier_rahmen_ueberstehen_den_rundlauf() {
        hin_und_zurueck(Rahmen::Neu { generation: 7, typ: Inhaltstyp::Text });
        hin_und_zurueck(Rahmen::Hol { generation: 7, id: 3 });
        hin_und_zurueck(Rahmen::Stueck { id: 3, i: 0, n: 2, d: "aGFsbG8=".into() });
        hin_und_zurueck(Rahmen::Leer { id: 3, grund: Grund::Veraltet });
        hin_und_zurueck(Rahmen::Leer { id: 3, grund: Grund::ZuGross });
        hin_und_zurueck(Rahmen::Leer { id: 3, grund: Grund::Weg });
        hin_und_zurueck(Rahmen::Leer { id: 3, grund: Grund::Frist });
    }

    #[test]
    fn unbekannte_art_ist_ein_fehler() {
        let j = serde_json::json!({ "t": "erfunden", "gen": 1 });
        assert!(Rahmen::aus_json(&j).is_err());
    }

    #[test]
    fn fehlendes_feld_ist_ein_fehler() {
        // `hol` ohne `id` — fail-closed, nicht mit einer 0 auffuellen: eine
        // erfundene Anfragenummer beantwortete spaeter einen fremden Abruf.
        let j = serde_json::json!({ "t": "hol", "gen": 1 });
        assert!(Rahmen::aus_json(&j).is_err());
    }

    #[test]
    fn unbekannter_inhaltstyp_ist_KEIN_fehler() {
        // Stufe 2 wird `dateien` schicken. Eine aeltere Fassung muss den Rahmen
        // LESEN koennen und ihn dann ignorieren — wuerde sie ihn als Fehler
        // behandeln, risse eine neuere Gegenstelle die Sitzung ab. Das
        // Ignorieren entscheidet `sitzung.rs`, nicht diese Ebene.
        let j = serde_json::json!({ "t": "neu", "gen": 1, "typ": "dateien" });
        let r = Rahmen::aus_json(&j).expect("muss lesbar bleiben");
        assert_eq!(r, Rahmen::Neu { generation: 1, typ: Inhaltstyp::Anderes("dateien".into()) });
    }

    #[test]
    fn groesstes_stueck_bleibt_unter_dem_gateway_deckel() {
        // **Die wichtigste Zahl der Kiste.** Der Weiterleiter des Gateways misst
        // `len(json.dumps(data, separators=(",",":")))` gegen 8192
        // (`ws_remote_handlers.py:98,423`) und verwirft Groesseres — beim
        // Ratendeckel sogar STILL. Ein zu grosses Stueck saehe vom Sender aus
        // wie ein Erfolg aus und kaeme nie an.
        let roh = vec![b'x'; MAX_STUECK_ROH];
        let d = pulse_fernsteuerung::base64::kodiere(&roh);
        let r = Rahmen::Stueck { id: u64::MAX, i: u32::MAX, n: u32::MAX, d };
        let kompakt = serde_json::to_string(&r.nach_json()).expect("serialisierbar");
        assert!(
            kompakt.len() <= 8192,
            "Stueck ist {} Byte kompakt — ueber dem 8192-Deckel des Gateways",
            kompakt.len()
        );
    }
}
```

- [ ] **Step 3: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd streaming/pulse-ablage && cargo test -q`
Expected: FAIL — `cannot find type Rahmen in this scope` (bzw. die Datei existiert noch nicht).

- [ ] **Step 4: Das Format schreiben**

`streaming/pulse-ablage/src/format.rs` (oberhalb des Testmoduls aus Step 2):

```rust
//! Das Rahmenformat der geteilten Zwischenablage — vier Rahmen, beide
//! Richtungen, und die zwei Zahlen, gegen die gerechnet wird.

use serde_json::{Value, json};

/// Groesster Text, den eine Ablage-Uebertragung traegt.
///
/// 64 KiB sind rund zwoelf Stuecke (s. [`MAX_STUECK_ROH`]) und damit bei der
/// Selbstdrosselung auf 30 Stuecke/s rund 0,4 s vom Einfuegen bis zum Inhalt.
/// Die Grenze ist nicht der Speicher, sondern die WARTEZEIT: auf Windows und
/// macOS blockiert das einfuegende Programm, solange wir liefern.
pub const MAX_TEXT_BYTE: usize = 64 * 1024;

/// Groesste ROHE Nutzlast eines Stuecks, vor Base64.
///
/// Zurueckgerechnet aus dem Deckel des Gateways (8192 Byte kompaktes JSON,
/// `ws_remote_handlers.py:98`): 5900 rohe Byte werden zu 7868 Base64-Zeichen,
/// dazu hoechstens 77 Byte Huelle (`{"t":"stueck","id":…,"i":…,"n":…,"d":""}`
/// mit maximalen Zahlen) — zusammen 7945. Der Abstand zum Deckel ist Absicht
/// und hat einen Zwilling: `pulse-zeigerbild::MAX_LAEUFE_BYTE` (5900) ist aus
/// derselben Rechnung entstanden.
pub const MAX_STUECK_ROH: usize = 5900;

/// Warum nichts geliefert wird.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grund {
    /// Die angeforderte Generation ist nicht mehr die aktuelle. **Es wird nie
    /// ein anderer Inhalt geliefert als der angekuendigte.**
    Veraltet,
    /// Der Inhalt ueberschreitet [`MAX_TEXT_BYTE`].
    ZuGross,
    /// Es gibt gar nichts (mehr) zu liefern — Sitzung vorbei, Ablage leer.
    Weg,
    /// Die Abruf-Frist ist abgelaufen.
    Frist,
}

impl Grund {
    pub fn als_str(&self) -> &'static str {
        match self {
            Grund::Veraltet => "veraltet",
            Grund::ZuGross => "zu_gross",
            Grund::Weg => "weg",
            Grund::Frist => "frist",
        }
    }

    pub fn aus_str(s: &str) -> Option<Grund> {
        match s {
            "veraltet" => Some(Grund::Veraltet),
            "zu_gross" => Some(Grund::ZuGross),
            "weg" => Some(Grund::Weg),
            "frist" => Some(Grund::Frist),
            _ => None,
        }
    }
}

/// Was angekuendigt wird.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inhaltstyp {
    Text,
    /// Alles, was diese Fassung nicht kennt — Stufe 2 wird hier `dateien`
    /// schicken. Ein Rahmen damit ist **kein Fehler**: er wird gelesen und
    /// dann ignoriert. Wuerde er als Fehler gelten, risse eine neuere
    /// Gegenstelle die Sitzung ab.
    Anderes(String),
}

impl Inhaltstyp {
    fn als_str(&self) -> &str {
        match self {
            Inhaltstyp::Text => "text",
            Inhaltstyp::Anderes(s) => s,
        }
    }

    fn aus_str(s: &str) -> Inhaltstyp {
        if s == "text" { Inhaltstyp::Text } else { Inhaltstyp::Anderes(s.to_string()) }
    }
}

/// Ein Rahmen auf der Leitung. Reist als `data` einer `remote_signal`-Nachricht
/// mit `kind: "ablage"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rahmen {
    /// Meine Ablage hat sich geaendert. **Sonst nichts.**
    Neu { generation: u64, typ: Inhaltstyp },
    /// Bei mir wird eingefuegt — gib Generation `gen` her.
    Hol { generation: u64, id: u64 },
    /// Stueck `i` von `n`, `d` ist Base64.
    Stueck { id: u64, i: u32, n: u32, d: String },
    /// Kann nicht liefern.
    Leer { id: u64, grund: Grund },
}

impl Rahmen {
    pub fn nach_json(&self) -> Value {
        match self {
            Rahmen::Neu { generation, typ } => json!({ "t": "neu", "gen": generation, "typ": typ.als_str() }),
            Rahmen::Hol { generation, id } => json!({ "t": "hol", "gen": generation, "id": id }),
            Rahmen::Stueck { id, i, n, d } => {
                json!({ "t": "stueck", "id": id, "i": i, "n": n, "d": d })
            }
            Rahmen::Leer { id, grund } => {
                json!({ "t": "leer", "id": id, "grund": grund.als_str() })
            }
        }
    }

    pub fn aus_json(v: &Value) -> Result<Rahmen, String> {
        let zahl = |feld: &str| -> Result<u64, String> {
            v.get(feld).and_then(Value::as_u64).ok_or_else(|| format!("{feld} fehlt"))
        };
        let klein = |feld: &str| -> Result<u32, String> {
            let n = zahl(feld)?;
            u32::try_from(n).map_err(|_| format!("{feld} zu gross"))
        };
        match v.get("t").and_then(Value::as_str) {
            Some("neu") => Ok(Rahmen::Neu {
                generation: zahl("gen")?,
                // Ein fehlendes `typ` als Text zu lesen waere geraten. Eine
                // Fassung, die `neu` schickt, schickt auch `typ` — sie steht
                // im selben `nach_json` daneben.
                typ: Inhaltstyp::aus_str(
                    v.get("typ").and_then(Value::as_str).ok_or("typ fehlt")?,
                ),
            }),
            Some("hol") => Ok(Rahmen::Hol { generation: zahl("gen")?, id: zahl("id")? }),
            Some("stueck") => Ok(Rahmen::Stueck {
                id: zahl("id")?,
                i: klein("i")?,
                n: klein("n")?,
                d: v.get("d").and_then(Value::as_str).ok_or("d fehlt")?.to_string(),
            }),
            Some("leer") => Ok(Rahmen::Leer {
                id: zahl("id")?,
                grund: v
                    .get("grund")
                    .and_then(Value::as_str)
                    .and_then(Grund::aus_str)
                    .ok_or("grund fehlt oder unbekannt")?,
            }),
            Some(andere) => Err(format!("unbekannte Rahmenart: {andere}")),
            None => Err("t fehlt".to_string()),
        }
    }
}
```

- [ ] **Step 5: Tests laufen lassen, Grün bestätigen**

Run: `cd streaming/pulse-ablage && cargo test -q`
Expected: PASS, 5 Tests.

Läuft `groesstes_stueck_bleibt_unter_dem_gateway_deckel` rot, ist **`MAX_STUECK_ROH` zu senken**, nicht der Test zu lockern — der Deckel gehört dem Gateway.

- [ ] **Step 6: Commit**

```bash
git add streaming/pulse-ablage
git commit -m "feat(ablage): Rahmenformat der geteilten Zwischenablage

Vier Rahmen (neu/hol/stueck/leer) und die zwei Zahlen, gegen die
gerechnet wird. Ein Test haelt fest, dass das groesstmoegliche Stueck
unter dem 8192-Byte-Deckel des Gateway-Weiterleiters bleibt — darueber
wuerde es still verworfen und saehe vom Sender aus wie ein Erfolg."
```

---

### Task 2: Stückelung und Wiederzusammensetzung

**Files:**
- Create: `streaming/pulse-ablage/src/stueckelung.rs`
- Modify: `streaming/pulse-ablage/src/lib.rs` (Zeile `pub mod stueckelung;` ergänzen)

**Interfaces:**
- Consumes: `format::{Rahmen, Grund, MAX_TEXT_BYTE, MAX_STUECK_ROH}` aus Task 1
- Produces:
  - `pulse_ablage::stueckelung::zerlegen(id: u64, text: &str) -> Result<Vec<Rahmen>, Grund>`
  - `pulse_ablage::stueckelung::Sammler` mit `fn neu(id: u64) -> Sammler`, `fn nimm(&mut self, rahmen: &Rahmen) -> Result<Option<String>, String>`

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

In `streaming/pulse-ablage/src/stueckelung.rs`:

```rust
#[cfg(test)]
mod tests {
    // `super::*` bringt `MAX_TEXT_BYTE` und `MAX_STUECK_ROH` schon mit — sie
    // stehen im `use` des Elternmoduls. Ein zweiter expliziter Import waere
    // eine Doppelung, die beim naechsten Umbenennen auseinanderliefe.
    use super::*;

    fn durchreichen(text: &str) -> String {
        let stuecke = zerlegen(9, text).expect("passt");
        let mut s = Sammler::neu(9);
        let mut fertig = None;
        for r in &stuecke {
            if let Some(t) = s.nimm(r).expect("gueltig") {
                fertig = Some(t);
            }
        }
        fertig.expect("muss fertig werden")
    }

    #[test]
    fn kurzer_text_geht_in_einem_stueck() {
        let stuecke = zerlegen(9, "hallo").expect("passt");
        assert_eq!(stuecke.len(), 1);
        assert_eq!(durchreichen("hallo"), "hallo");
    }

    #[test]
    fn umlaute_und_leerer_text_ueberstehen_den_weg() {
        assert_eq!(durchreichen("Größe: 1 µm — ok"), "Größe: 1 µm — ok");
        assert_eq!(durchreichen(""), "");
        assert_eq!(zerlegen(9, "").expect("passt").len(), 1, "leerer Text ist EIN Stueck, nicht null");
    }

    #[test]
    fn erfundene_stueckzahl_wird_abgelehnt() {
        let mut s = Sammler::neu(9);
        let fehler = s.nimm(&Rahmen::Stueck { id: 9, i: 0, n: u32::MAX, d: "aGE=".into() });
        assert!(fehler.is_err(), "n = u32::MAX muss abgelehnt werden, vor jeder Allokation");
    }

    #[test]
    fn hoechste_ehrliche_stueckzahl_geht_durch() {
        // Gegenprobe zur Schranke: sie darf den ehrlichen Sender nicht treffen.
        // Ohne diesen Test waere `MAX_STUECKE = 1` ebenfalls gruen.
        let text = "z".repeat(MAX_TEXT_BYTE);
        let stuecke = zerlegen(9, &text).expect("genau an der Grenze, muss passen");
        assert!(stuecke.len() as u32 <= MAX_STUECKE, "{} Stuecke gegen Schranke {MAX_STUECKE}", stuecke.len());
        let mut s = Sammler::neu(9);
        assert!(s.nimm(&stuecke[0]).is_ok(), "die Schranke darf einen echten Sender nicht abweisen");
    }

    #[test]
    fn langer_text_wird_gestueckelt_und_wieder_ganz() {
        let text = "z".repeat(20_000);
        let stuecke = zerlegen(9, &text).expect("passt");
        assert!(stuecke.len() > 1, "20 kB muessen mehrere Stuecke sein");
        assert_eq!(durchreichen(&text), text);
    }

    #[test]
    fn ueber_der_grenze_wird_abgelehnt_statt_abgeschnitten() {
        // Abschneiden waere schlimmer als ablehnen: der Nutzer bekaeme drueben
        // die halbe Zeichenkette eingefuegt und merkte es womoeglich nicht.
        let zu_lang = "z".repeat(MAX_TEXT_BYTE + 1);
        assert_eq!(zerlegen(9, &zu_lang), Err(Grund::ZuGross));
    }

    #[test]
    fn stuecke_duerfen_in_beliebiger_reihenfolge_kommen() {
        let text = "z".repeat(20_000);
        let mut stuecke = zerlegen(9, &text).expect("passt");
        stuecke.reverse();
        let mut s = Sammler::neu(9);
        let mut fertig = None;
        for r in &stuecke {
            if let Some(t) = s.nimm(r).expect("gueltig") {
                fertig = Some(t);
            }
        }
        assert_eq!(fertig.expect("fertig"), text);
    }

    #[test]
    fn fremde_anfragenummer_wird_abgelehnt() {
        let stuecke = zerlegen(9, "hallo").expect("passt");
        let mut s = Sammler::neu(10);
        assert!(s.nimm(&stuecke[0]).is_err());
    }

    #[test]
    fn doppeltes_stueck_wird_abgelehnt() {
        let text = "z".repeat(20_000);
        let stuecke = zerlegen(9, &text).expect("passt");
        let mut s = Sammler::neu(9);
        s.nimm(&stuecke[0]).expect("erstes ok");
        assert!(s.nimm(&stuecke[0]).is_err(), "dasselbe Stueck zweimal ist ein Fehler");
    }

    #[test]
    fn wechselnde_gesamtzahl_wird_abgelehnt() {
        let mut s = Sammler::neu(9);
        s.nimm(&Rahmen::Stueck { id: 9, i: 0, n: 3, d: "aGE=".into() }).expect("erstes ok");
        assert!(
            s.nimm(&Rahmen::Stueck { id: 9, i: 1, n: 4, d: "aGE=".into() }).is_err(),
            "n darf sich innerhalb einer Lieferung nicht aendern"
        );
    }

    #[test]
    fn kaputtes_base64_wird_abgelehnt() {
        let mut s = Sammler::neu(9);
        assert!(s.nimm(&Rahmen::Stueck { id: 9, i: 0, n: 1, d: "!!!".into() }).is_err());
    }

    #[test]
    fn ungueltiges_utf8_wird_abgelehnt() {
        // 0xFF ist in UTF-8 nie gueltig. Ohne diese Pruefung landete Muell in
        // der Ablage des Nutzers.
        let d = pulse_fernsteuerung::base64::kodiere(&[0xFF, 0xFE]);
        let mut s = Sammler::neu(9);
        assert!(s.nimm(&Rahmen::Stueck { id: 9, i: 0, n: 1, d }).is_err());
    }

    #[test]
    fn zu_viele_bytes_werden_abgelehnt() {
        // Der Sender haelt sich an MAX_TEXT_BYTE — der Empfaenger glaubt es ihm
        // nicht. Ohne diese Pruefung koennte eine boesartige Gegenstelle
        // beliebig viel Speicher belegen, ein Stueck nach dem anderen.
        let d = pulse_fernsteuerung::base64::kodiere(&vec![b'x'; MAX_STUECK_ROH]);
        let mut s = Sammler::neu(9);
        let viele = MAX_TEXT_BYTE / MAX_STUECK_ROH + 2;
        let mut letzte = Ok(None);
        for i in 0..viele as u32 {
            letzte = s.nimm(&Rahmen::Stueck { id: 9, i, n: viele as u32, d: d.clone() });
            if letzte.is_err() {
                break;
            }
        }
        assert!(letzte.is_err(), "der Empfaenger muss bei MAX_TEXT_BYTE abbrechen");
    }
}
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd streaming/pulse-ablage && cargo test -q stueckelung`
Expected: FAIL — `cannot find function zerlegen`.

- [ ] **Step 3: Die Stückelung schreiben**

`streaming/pulse-ablage/src/stueckelung.rs` (oberhalb des Testmoduls):

```rust
//! Zerlegen und Wiederzusammensetzen unter dem Deckel des Gateways.
//!
//! **Der Empfaenger glaubt dem Sender nichts.** Jede Grenze, die `zerlegen`
//! einhaelt, prueft [`Sammler`] noch einmal — die Gegenstelle ist eine andere
//! Maschine, moeglicherweise mit einer anderen Fassung, moeglicherweise
//! feindlich.

use pulse_fernsteuerung::base64::{dekodiere, kodiere};

use crate::format::{Grund, MAX_STUECK_ROH, MAX_TEXT_BYTE, Rahmen};

/// Wie viele Stuecke eine Lieferung hoechstens hat.
///
/// Aus den beiden Grenzen des Formats GERECHNET statt daneben geschrieben —
/// eine dritte Zahl liefe auseinander, sobald sich eine der beiden aendert.
/// Geht die Teilung auf, ist ein Platz Reserve dabei; das schadet nichts, ein
/// Fehlalarm gegen einen ehrlichen Sender schon.
const MAX_STUECKE: u32 = (MAX_TEXT_BYTE / MAX_STUECK_ROH + 1) as u32;

/// Einen Text in sendefertige Stuecke zerlegen.
///
/// Ein leerer Text ergibt **ein** Stueck mit leerer Nutzlast — nicht null
/// Stuecke: der Empfaenger wartet sonst ewig auf eine Lieferung, die es nie
/// gibt.
pub fn zerlegen(id: u64, text: &str) -> Result<Vec<Rahmen>, Grund> {
    let roh = text.as_bytes();
    if roh.len() > MAX_TEXT_BYTE {
        return Err(Grund::ZuGross);
    }
    let teile: Vec<&[u8]> =
        if roh.is_empty() { vec![&[][..]] } else { roh.chunks(MAX_STUECK_ROH).collect() };
    let n = teile.len() as u32;
    Ok(teile
        .into_iter()
        .enumerate()
        .map(|(i, teil)| Rahmen::Stueck { id, i: i as u32, n, d: kodiere(teil) })
        .collect())
}

/// Sammelt die Stuecke einer Lieferung, bis sie vollstaendig ist.
pub struct Sammler {
    id: u64,
    n: Option<u32>,
    teile: Vec<Option<Vec<u8>>>,
    roh: usize,
}

impl Sammler {
    pub fn neu(id: u64) -> Sammler {
        Sammler { id, n: None, teile: Vec::new(), roh: 0 }
    }

    /// Ein Stueck aufnehmen. `Ok(Some(text))`, sobald die Lieferung vollstaendig
    /// ist; `Ok(None)`, solange noch etwas fehlt; `Err`, wenn der Rahmen nicht
    /// zu dieser Lieferung gehoert oder die Grenzen verletzt.
    pub fn nimm(&mut self, rahmen: &Rahmen) -> Result<Option<String>, String> {
        let Rahmen::Stueck { id, i, n, d } = rahmen else {
            return Err("kein Stueck".to_string());
        };
        if *id != self.id {
            return Err(format!("Stueck gehoert zu Anfrage {id}, nicht {}", self.id));
        }
        if *n == 0 {
            return Err("n = 0".to_string());
        }
        // **Der Empfaenger glaubt dem Sender nichts — auch seine Stueckzahl
        // nicht.** Ohne diese Schranke legt `n = u32::MAX` sofort einen Vektor
        // mit vier Milliarden Plaetzen an, lange bevor das erste Byte gezaehlt
        // wird: ein einziger Rahmen genuegt fuer den Absturz. Ein ehrlicher
        // Sender kommt nie darueber, weil `zerlegen` aus denselben zwei
        // Grenzen rechnet.
        if *n > MAX_STUECKE {
            return Err(format!("n = {n} ueberschreitet {MAX_STUECKE} Stuecke"));
        }
        match self.n {
            None => {
                self.n = Some(*n);
                self.teile = (0..*n).map(|_| None).collect();
            }
            Some(bekannt) if bekannt != *n => {
                return Err(format!("n wechselt von {bekannt} auf {n}"));
            }
            Some(_) => {}
        }
        let platz = self.teile.get_mut(*i as usize).ok_or_else(|| format!("i={i} ausserhalb"))?;
        if platz.is_some() {
            return Err(format!("Stueck {i} kam zweimal"));
        }
        let bytes = dekodiere(d)?;
        // **Vor** dem Ablegen zaehlen, sonst haette ein Schwall den Speicher
        // schon belegt, wenn wir es merken.
        self.roh += bytes.len();
        if self.roh > MAX_TEXT_BYTE {
            return Err(format!("Lieferung ueberschreitet {MAX_TEXT_BYTE} Byte"));
        }
        *platz = Some(bytes);
        if self.teile.iter().any(Option::is_none) {
            return Ok(None);
        }
        let ganz: Vec<u8> = self.teile.iter().flatten().flatten().copied().collect();
        String::from_utf8(ganz).map(Some).map_err(|e| format!("kein gueltiges UTF-8: {e}"))
    }
}
```

`lib.rs` um `pub mod stueckelung;` ergänzen.

- [ ] **Step 4: Tests laufen lassen, Grün bestätigen**

Run: `cd streaming/pulse-ablage && cargo test -q`
Expected: PASS, 18 Tests.

- [ ] **Step 5: Commit**

```bash
git add streaming/pulse-ablage
git commit -m "feat(ablage): Stueckelung unter dem Gateway-Deckel

Zerlegen und Wiederzusammensetzen, mit doppelter Buchfuehrung: jede
Grenze, die der Sender einhaelt, prueft der Empfaenger noch einmal. Die
Gegenstelle ist eine andere Maschine — moeglicherweise mit einer
anderen Fassung, moeglicherweise feindlich."
```

---

### Task 3: Die Zustandsmaschine

**Files:**
- Create: `streaming/pulse-ablage/src/sitzung.rs`
- Modify: `streaming/pulse-ablage/src/lib.rs` (`pub mod sitzung;`)

**Interfaces:**
- Consumes: `format::{Rahmen, Grund, Inhaltstyp, MAX_TEXT_BYTE}`, `stueckelung::{zerlegen, Sammler}`
- Produces:
  - `pulse_ablage::sitzung::ABRUF_FRIST_MS: u64`
  - `pulse_ablage::sitzung::Ankuendiger` mit `fn neu() -> Ankuendiger`, `fn geaendert(&mut self) -> Rahmen`, `fn generation(&self) -> u64`, `fn beantworte(&self, hol: &Rahmen, inhalt: Option<&str>) -> Vec<Rahmen>`
  - `pulse_ablage::sitzung::Fortschritt` — `Warten | Fertig(String) | Leer(Grund)`
  - `pulse_ablage::sitzung::Empfaenger` mit `fn neu() -> Empfaenger`, `fn angekuendigt(&mut self, rahmen: &Rahmen) -> bool`, `fn abrufen(&mut self, jetzt_ms: u64) -> Option<Rahmen>`, `fn eingang(&mut self, rahmen: &Rahmen) -> Fortschritt`, `fn takt(&mut self, jetzt_ms: u64) -> Fortschritt`

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

In `streaming/pulse-ablage/src/sitzung.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::Inhaltstyp;

    #[test]
    fn ankuendigung_traegt_keinen_inhalt() {
        // Der Kern des ganzen Entwurfs. Sollte diese Zusicherung je fallen,
        // liegt jedes lokal kopierte Passwort sofort auf dem fremden Rechner.
        let mut a = Ankuendiger::neu();
        let r = a.geaendert();
        assert_eq!(r, Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text });
        let j = serde_json::to_string(&r.nach_json()).expect("serialisierbar");
        // **Woertlich diese drei Felder und keins mehr.** Ein Teilstring-Test
        // („enthaelt 'geheim' nicht") waere wirkungslos: `geaendert()` nimmt gar
        // keinen Inhalt entgegen, es gaebe nichts, was dort landen koennte.
        // Diese Fassung wird rot, sobald jemand `Rahmen::Neu` um ein Feld
        // erweitert — und genau das ist der Weg, auf dem Inhalt jemals in eine
        // Ankuendigung geriete.
        //
        // Die Reihenfolge ist alphabetisch, nicht die Schreibreihenfolge:
        // `serde_json::Map` ist ohne das Merkmal `preserve_order` eine BTreeMap.
        // Nachgemessen, nicht angenommen.
        assert_eq!(j, r#"{"gen":1,"t":"neu","typ":"text"}"#);
    }

    #[test]
    fn ein_kaputtes_stueck_verwirft_die_ganze_lieferung() {
        // Halb eingefuegter Text waere schlimmer als gar keiner: der Nutzer
        // saehe eine abgeschnittene Zeichenkette und merkte es womoeglich nicht.
        let mut e = Empfaenger::neu();
        e.angekuendigt(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text });
        let Some(Rahmen::Hol { id, .. }) = e.abrufen(0) else { panic!("Abruf fehlt") };
        let stuecke = crate::stueckelung::zerlegen(id, &"z".repeat(20_000)).expect("passt");
        assert!(stuecke.len() > 2, "der Fall braucht mehrere Stuecke");
        assert_eq!(e.eingang(&stuecke[0]), Fortschritt::Warten);
        // Ein Stueck mit kaputtem Base64 — `Sammler::nimm` liefert `Err`.
        let kaputt = Rahmen::Stueck { id, i: 1, n: stuecke.len() as u32, d: "!!!".into() };
        assert_eq!(e.eingang(&kaputt), Fortschritt::Leer(Grund::Weg));
        // Und der Abruf ist geraeumt: die noch fehlenden Stuecke duerfen die
        // angebrochene Lieferung nicht doch noch vollenden.
        assert_eq!(e.eingang(&stuecke[1]), Fortschritt::Warten);
        assert_eq!(e.eingang(&stuecke[2]), Fortschritt::Warten);
    }

    #[test]
    fn jede_aenderung_erhoeht_die_generation() {
        let mut a = Ankuendiger::neu();
        a.geaendert();
        a.geaendert();
        assert_eq!(a.generation(), 2);
    }

    #[test]
    fn veraltete_anfrage_bekommt_nie_den_neuen_inhalt() {
        // Die wichtigste Regel des Protokolls: es wird nie ein ANDERER Inhalt
        // geliefert als der angekuendigte.
        let mut a = Ankuendiger::neu();
        a.geaendert(); // gen 1 — "alt"
        a.geaendert(); // gen 2 — "neu"
        let antwort = a.beantworte(&Rahmen::Hol { generation: 1, id: 5 }, Some("neu"));
        assert_eq!(antwort, vec![Rahmen::Leer { id: 5, grund: Grund::Veraltet }]);
    }

    #[test]
    fn passende_anfrage_bekommt_den_inhalt() {
        let mut a = Ankuendiger::neu();
        a.geaendert();
        let antwort = a.beantworte(&Rahmen::Hol { generation: 1, id: 5 }, Some("hallo"));
        assert_eq!(antwort.len(), 1);
        assert!(matches!(antwort[0], Rahmen::Stueck { id: 5, i: 0, n: 1, .. }));
    }

    #[test]
    fn leere_ablage_beantwortet_mit_weg() {
        let mut a = Ankuendiger::neu();
        a.geaendert();
        let antwort = a.beantworte(&Rahmen::Hol { generation: 1, id: 5 }, None);
        assert_eq!(antwort, vec![Rahmen::Leer { id: 5, grund: Grund::Weg }]);
    }

    #[test]
    fn zu_grosser_inhalt_beantwortet_mit_zu_gross() {
        let mut a = Ankuendiger::neu();
        a.geaendert();
        let riesig = "z".repeat(crate::format::MAX_TEXT_BYTE + 1);
        let antwort = a.beantworte(&Rahmen::Hol { generation: 1, id: 5 }, Some(&riesig));
        assert_eq!(antwort, vec![Rahmen::Leer { id: 5, grund: Grund::ZuGross }]);
    }

    #[test]
    fn ohne_ankuendigung_wird_nicht_abgerufen() {
        let mut e = Empfaenger::neu();
        assert_eq!(e.abrufen(0), None, "es gibt nichts zu holen");
    }

    #[test]
    fn unbekannter_typ_wird_nicht_beansprucht() {
        // Stufe 2 schickt `dateien`. Diese Fassung darf die lokale Ablage
        // dafuer NICHT beanspruchen — sie koennte nichts liefern, und der
        // Vorbestand des Nutzers waere weg.
        let mut e = Empfaenger::neu();
        let angekuendigt = e.angekuendigt(&Rahmen::Neu {
            generation: 1,
            typ: Inhaltstyp::Anderes("dateien".into()),
        });
        assert!(!angekuendigt);
        assert_eq!(e.abrufen(0), None);
    }

    #[test]
    fn abruf_nennt_die_angekuendigte_generation() {
        let mut e = Empfaenger::neu();
        assert!(e.angekuendigt(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text }));
        assert_eq!(e.abrufen(0), Some(Rahmen::Hol { generation: 4, id: 1 }));
    }

    #[test]
    fn zweiter_abruf_waehrend_eines_laufenden_wird_abgelehnt() {
        let mut e = Empfaenger::neu();
        e.angekuendigt(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text });
        e.abrufen(0);
        assert_eq!(e.abrufen(10), None, "es laeuft schon einer");
    }

    #[test]
    fn stuecke_fuehren_zu_fertig() {
        let mut e = Empfaenger::neu();
        e.angekuendigt(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text });
        let Some(Rahmen::Hol { id, .. }) = e.abrufen(0) else { panic!("Abruf fehlt") };
        for r in crate::stueckelung::zerlegen(id, "hallo").expect("passt") {
            match e.eingang(&r) {
                Fortschritt::Fertig(t) => {
                    assert_eq!(t, "hallo");
                    return;
                }
                Fortschritt::Warten => {}
                Fortschritt::Leer(g) => panic!("unerwartet leer: {g:?}"),
            }
        }
        panic!("nie fertig geworden");
    }

    #[test]
    fn leer_rahmen_beendet_den_abruf() {
        let mut e = Empfaenger::neu();
        e.angekuendigt(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text });
        let Some(Rahmen::Hol { id, .. }) = e.abrufen(0) else { panic!("Abruf fehlt") };
        assert_eq!(
            e.eingang(&Rahmen::Leer { id, grund: Grund::Veraltet }),
            Fortschritt::Leer(Grund::Veraltet)
        );
        // Danach ist wieder ein Abruf moeglich.
        assert!(e.abrufen(10).is_some());
    }

    #[test]
    fn frist_laeuft_ab_und_spaete_stuecke_werden_ignoriert() {
        // **Der Grund fuer die Frist:** auf Windows und macOS blockiert das
        // einfuegende Programm, solange wir liefern. Ein Einfuegen, das nichts
        // einfuegt, versteht jeder; ein haengendes Programm nicht.
        let mut e = Empfaenger::neu();
        e.angekuendigt(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text });
        let Some(Rahmen::Hol { id, .. }) = e.abrufen(1_000) else { panic!("Abruf fehlt") };
        assert_eq!(e.takt(1_000 + ABRUF_FRIST_MS - 1), Fortschritt::Warten);
        assert_eq!(e.takt(1_000 + ABRUF_FRIST_MS), Fortschritt::Leer(Grund::Frist));
        let spaet = crate::stueckelung::zerlegen(id, "hallo").expect("passt");
        assert_eq!(
            e.eingang(&spaet[0]),
            Fortschritt::Warten,
            "ein Stueck nach Fristablauf darf nichts mehr ausloesen"
        );
    }

    #[test]
    fn abruf_frist_liegt_unter_der_gnadenfrist() {
        // **Eine Beziehung, kein Einzelwert.** Reisst der Socket mitten im
        // Abruf ab, haelt die Gnadenfrist die SITZUNG offen
        // (`REMOTE_DISCONNECT_GRACE_S`, Vorgabe 10 s,
        // `services/chat-gateway/src/dcc_chat_gateway/routes/remote_reconnect_registry.py`).
        // Der ABRUF darf darauf nicht warten — sonst steht das einfuegende
        // Programm zehn Sekunden. Dieselbe Bauart wie `CLIENT_GRACE_MS` gegen
        // die Server-Frist in `web/src/lib/remote/gnadenfrist.ts`.
        //
        // Die 10_000 sind hier eine SPIEGELKONSTANTE: aendert sich die Vorgabe
        // drueben, muss dieser Test von Hand nachgezogen werden. Ein Test ueber
        // die Sprachgrenze gibt es hier nicht — er waere die dritte Kopie
        // derselben Zahl.
        const GNADENFRIST_MS: u64 = 10_000;
        assert!(
            ABRUF_FRIST_MS < GNADENFRIST_MS,
            "ABRUF_FRIST_MS ({ABRUF_FRIST_MS}) muss unter der Gnadenfrist \
             ({GNADENFRIST_MS}) liegen"
        );
    }
}
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd streaming/pulse-ablage && cargo test -q sitzung`
Expected: FAIL — `cannot find type Ankuendiger`.

- [ ] **Step 3: Die Zustandsmaschine schreiben**

`streaming/pulse-ablage/src/sitzung.rs` (oberhalb des Testmoduls):

```rust
//! Die Zustandsmaschine beider Enden — angekuendigt, unterwegs, Frist.
//!
//! Zwei Haelften, absichtlich getrennt: [`Ankuendiger`] ist meine Seite (was
//! ICH habe und liefere), [`Empfaenger`] die Gegenseite (was DRUEBEN liegt und
//! was ich davon hole). Jedes Ende haelt beide — die Richtung ist symmetrisch.

use crate::format::{Grund, Inhaltstyp, Rahmen};
use crate::stueckelung::{Sammler, zerlegen};

/// Wie lange ein Abruf hoechstens dauern darf.
///
/// Muss **unter** der Gnadenfrist der Fernsteuerung liegen (`REMOTE_DISCONNECT_
/// GRACE_S`, Vorgabe 10 s) — ein Test haelt die Beziehung fest. Der Grund ist
/// nicht das Netz, sondern das wartende Programm: auf Windows und macOS
/// blockiert der Einfuegevorgang, solange geliefert wird.
pub const ABRUF_FRIST_MS: u64 = 2_000;

/// Meine Seite: was ich habe und was ich davon herausgebe.
pub struct Ankuendiger {
    generation: u64,
}

impl Ankuendiger {
    pub fn neu() -> Ankuendiger {
        // Generation 0 heisst „nie angekuendigt". Ein `hol` mit gen 0 ist damit
        // immer veraltet, ohne Sonderfall.
        Ankuendiger { generation: 0 }
    }

    /// Meine Ablage hat sich geaendert. Liefert den Rahmen, der hinausgeht —
    /// **ohne Inhalt**.
    pub fn geaendert(&mut self) -> Rahmen {
        self.generation += 1;
        Rahmen::Neu { generation: self.generation, typ: Inhaltstyp::Text }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Ein `hol` beantworten. `inhalt` ist der JETZIGE Inhalt meiner Ablage
    /// (`None`, wenn sie keinen Text haelt).
    pub fn beantworte(&self, hol: &Rahmen, inhalt: Option<&str>) -> Vec<Rahmen> {
        let Rahmen::Hol { generation, id } = hol else {
            return Vec::new();
        };
        // **Zuerst die Generation.** Stimmt sie nicht, wird nicht einmal
        // gelesen — es gaebe nichts zu liefern, das der Anfragende gemeint hat.
        if *generation != self.generation || self.generation == 0 {
            return vec![Rahmen::Leer { id: *id, grund: Grund::Veraltet }];
        }
        let Some(text) = inhalt else {
            return vec![Rahmen::Leer { id: *id, grund: Grund::Weg }];
        };
        // **Die Laengengrenze wird hier NICHT noch einmal geprueft.** `zerlegen`
        // haelt sie und meldet `Err(Grund::ZuGross)`, das die Zeile darunter
        // abbildet. Zwei Stellen, die dieselbe Grenze pruefen, laufen
        // auseinander, sobald eine von beiden angefasst wird.
        match zerlegen(*id, text) {
            Ok(stuecke) => stuecke,
            Err(grund) => vec![Rahmen::Leer { id: *id, grund }],
        }
    }
}

/// Wie weit ein laufender Abruf ist.
#[derive(Debug, PartialEq, Eq)]
pub enum Fortschritt {
    Warten,
    Fertig(String),
    Leer(Grund),
}

struct Laufend {
    id: u64,
    seit_ms: u64,
    sammler: Sammler,
}

/// Die Gegenseite: was drueben liegt und was ich davon hole.
pub struct Empfaenger {
    fremde_generation: Option<u64>,
    laufend: Option<Laufend>,
    naechste_id: u64,
}

impl Empfaenger {
    pub fn neu() -> Empfaenger {
        Empfaenger { fremde_generation: None, laufend: None, naechste_id: 1 }
    }

    /// Eine Ankuendigung der Gegenseite. Liefert `true`, wenn daraufhin die
    /// **lokale Ablage zu beanspruchen** ist.
    ///
    /// Ein unbekannter Inhaltstyp liefert `false`: wir koennten nichts liefern,
    /// und ein Anspruch, den wir nicht einloesen koennen, kostete den
    /// Vorbestand des Nutzers.
    pub fn angekuendigt(&mut self, rahmen: &Rahmen) -> bool {
        let Rahmen::Neu { generation, typ } = rahmen else {
            return false;
        };
        if *typ != Inhaltstyp::Text {
            return false;
        }
        self.fremde_generation = Some(*generation);
        // Ein laufender Abruf gilt der ALTEN Generation und wird von der
        // Gegenseite ohnehin mit `veraltet` beantwortet — verworfen wird er
        // hier trotzdem nicht: sonst bliebe der wartende Einfuegevorgang ohne
        // Antwort haengen, bis seine Frist ablaeuft.
        true
    }

    /// Es wird gerade eingefuegt — den Abruf bauen.
    pub fn abrufen(&mut self, jetzt_ms: u64) -> Option<Rahmen> {
        let generation = self.fremde_generation?;
        if self.laufend.is_some() {
            return None;
        }
        let id = self.naechste_id;
        self.naechste_id += 1;
        self.laufend = Some(Laufend { id, seit_ms: jetzt_ms, sammler: Sammler::neu(id) });
        Some(Rahmen::Hol { generation, id })
    }

    /// Ein Rahmen der Gegenseite.
    pub fn eingang(&mut self, rahmen: &Rahmen) -> Fortschritt {
        let Some(laufend) = self.laufend.as_mut() else {
            // Kein Abruf offen — etwa nach Fristablauf. Still verwerfen: ein
            // spaetes Stueck ist ein Rennen, kein Angriff.
            return Fortschritt::Warten;
        };
        match rahmen {
            Rahmen::Leer { id, grund } if *id == laufend.id => {
                let g = *grund;
                self.laufend = None;
                Fortschritt::Leer(g)
            }
            Rahmen::Stueck { id, .. } if *id == laufend.id => match laufend.sammler.nimm(rahmen) {
                Ok(Some(text)) => {
                    self.laufend = None;
                    Fortschritt::Fertig(text)
                }
                Ok(None) => Fortschritt::Warten,
                Err(_) => {
                    // Ein kaputtes Stueck macht die ganze Lieferung unbrauchbar
                    // — halb eingefuegter Text waere schlimmer als gar keiner.
                    self.laufend = None;
                    Fortschritt::Leer(Grund::Weg)
                }
            },
            _ => Fortschritt::Warten,
        }
    }

    /// Zeitablauf pruefen. Ruft der Aufrufer regelmaessig, waehrend er wartet.
    pub fn takt(&mut self, jetzt_ms: u64) -> Fortschritt {
        let Some(laufend) = self.laufend.as_ref() else {
            return Fortschritt::Warten;
        };
        if jetzt_ms.saturating_sub(laufend.seit_ms) < ABRUF_FRIST_MS {
            return Fortschritt::Warten;
        }
        self.laufend = None;
        Fortschritt::Leer(Grund::Frist)
    }
}
```

`lib.rs` um `pub mod sitzung;` ergänzen.

- [ ] **Step 4: Tests laufen lassen, Grün bestätigen**

Run: `cd streaming/pulse-ablage && cargo test -q`
Expected: PASS, 33 Tests.

- [ ] **Step 5: Commit**

```bash
git add streaming/pulse-ablage
git commit -m "feat(ablage): Zustandsmaschine beider Enden

Ankuendiger und Empfaenger, mit den drei Regeln, die den Entwurf
tragen: eine Ankuendigung traegt keinen Inhalt, eine veraltete Anfrage
bekommt nie den neuen Inhalt, und die Abruf-Frist liegt unter der
Gnadenfrist der Fernsteuerung — sonst stuende das einfuegende Programm
zehn Sekunden."
```

---

### Task 4: Die zwei Betriebssystem-Traits, ein Testdoppel und der Rundlauf

**Files:**
- Create: `streaming/pulse-ablage/src/beobachter.rs`
- Create: `streaming/pulse-ablage/src/eigentum.rs`
- Create: `streaming/pulse-ablage/src/pruefstand.rs`
- Create: `streaming/pulse-ablage/tests/rundlauf.rs`
- Modify: `streaming/pulse-ablage/src/lib.rs` (drei `pub mod`-Zeilen)

**Interfaces:**
- Consumes: `sitzung::{Ankuendiger, Empfaenger, Fortschritt}`, `format::{Rahmen, Grund}`
- Produces:
  - `pulse_ablage::beobachter::Beobachter` — `fn geaendert(&mut self) -> bool`, `fn lesen(&self) -> Option<String>`
  - `pulse_ablage::eigentum::Eigentum` — `fn beanspruchen(&mut self) -> Result<(), String>`, `fn liefern(&mut self, text: &str)`, `fn freigeben(&mut self, zurueck: Option<&str>)`
  - `pulse_ablage::pruefstand::TestAblage` — `fn neu() -> TestAblage`, `fn setzen(&mut self, text: &str)`, `fn inhalt(&self) -> Option<String>`, `fn beansprucht(&self) -> bool`, `fn geliefert(&self) -> Option<String>`; setzt beide Traits um

- [ ] **Step 1: Den fehlschlagenden Rundlauftest schreiben**

`streaming/pulse-ablage/tests/rundlauf.rs`:

```rust
//! Der Rundlauf beider Enden, ohne Betriebssystem.
//!
//! Dieser Test ist der Beleg fuer die eine Zusicherung, um derentwillen die
//! ganze Kiste so gebaut ist: **beim Kopieren geht kein Inhalt hinaus.**

use pulse_ablage::beobachter::Beobachter;
use pulse_ablage::eigentum::Eigentum;
use pulse_ablage::format::{Grund, Rahmen};
use pulse_ablage::pruefstand::TestAblage;
use pulse_ablage::sitzung::{Ankuendiger, Empfaenger, Fortschritt};

/// Eine Seite: eigene Ablage, eigener Ankuendiger, eigener Empfaenger.
struct Seite {
    ablage: TestAblage,
    ank: Ankuendiger,
    emp: Empfaenger,
}

impl Seite {
    fn neu() -> Seite {
        Seite { ablage: TestAblage::neu(), ank: Ankuendiger::neu(), emp: Empfaenger::neu() }
    }

    /// Der Nutzer kopiert. Liefert, was daraufhin hinausgeht.
    fn kopiert(&mut self, text: &str) -> Vec<Rahmen> {
        self.ablage.setzen(text);
        if self.ablage.geaendert() { vec![self.ank.geaendert()] } else { Vec::new() }
    }

    /// Ein Rahmen der Gegenseite. Liefert, was zurueckgeht.
    fn empfaengt(&mut self, r: &Rahmen) -> Vec<Rahmen> {
        match r {
            Rahmen::Neu { .. } => {
                if self.emp.angekuendigt(r) {
                    self.ablage.beanspruchen().expect("Testdoppel scheitert nie");
                }
                Vec::new()
            }
            Rahmen::Hol { .. } => {
                let inhalt = self.ablage.inhalt();
                self.ank.beantworte(r, inhalt.as_deref())
            }
            Rahmen::Stueck { .. } | Rahmen::Leer { .. } => {
                match self.emp.eingang(r) {
                    Fortschritt::Fertig(t) => self.ablage.liefern(&t),
                    Fortschritt::Leer(_) => self.ablage.liefern(""),
                    Fortschritt::Warten => {}
                }
                Vec::new()
            }
        }
    }

    /// Der Nutzer fuegt ein.
    fn fuegt_ein(&mut self, jetzt_ms: u64) -> Vec<Rahmen> {
        self.emp.abrufen(jetzt_ms).into_iter().collect()
    }
}

/// Rahmen so lange hin und her reichen, bis nichts mehr fliesst. Liefert alles,
/// was insgesamt ueber die Leitung ging.
fn austauschen(a: &mut Seite, b: &mut Seite, start: Vec<Rahmen>) -> Vec<Rahmen> {
    let mut alle = Vec::new();
    let mut nach_b = start;
    let mut nach_a: Vec<Rahmen> = Vec::new();
    while !nach_b.is_empty() || !nach_a.is_empty() {
        let mut neu_a = Vec::new();
        for r in &nach_b {
            alle.push(r.clone());
            neu_a.extend(b.empfaengt(r));
        }
        let mut neu_b = Vec::new();
        for r in &nach_a {
            alle.push(r.clone());
            neu_b.extend(a.empfaengt(r));
        }
        nach_b = neu_b;
        nach_a = neu_a;
    }
    alle
}

#[test]
fn beim_kopieren_geht_kein_inhalt_hinaus() {
    let mut a = Seite::neu();
    let mut b = Seite::neu();

    let hinaus = a.kopiert("streng geheim");
    let alle = austauschen(&mut a, &mut b, hinaus);

    assert_eq!(alle.len(), 1, "genau ein Rahmen: die Ankuendigung");
    assert!(matches!(alle[0], Rahmen::Neu { .. }));
    for r in &alle {
        let j = serde_json::to_string(&r.nach_json()).expect("serialisierbar");
        assert!(!j.contains("geheim"), "Inhalt in einem Rahmen gefunden: {j}");
    }
    assert!(b.ablage.beansprucht(), "B haelt jetzt einen Anspruch, aber keine Daten");
    assert_eq!(b.ablage.geliefert(), None, "B hat nichts geliefert bekommen");
}

#[test]
fn erst_das_einfuegen_holt_den_inhalt() {
    let mut a = Seite::neu();
    let mut b = Seite::neu();

    let hinaus = a.kopiert("streng geheim");
    austauschen(&mut a, &mut b, hinaus);

    let hol = b.fuegt_ein(0);
    assert_eq!(hol.len(), 1);
    // Achtung Richtung: der `hol` geht von B nach A, die Antwort zurueck.
    let alle = austauschen(&mut b, &mut a, hol);

    assert!(alle.iter().any(|r| matches!(r, Rahmen::Stueck { .. })), "Inhalt muss geflossen sein");
    assert_eq!(b.ablage.geliefert().as_deref(), Some("streng geheim"));
}

#[test]
fn ein_zwischenzeitliches_kopieren_macht_den_abruf_veraltet() {
    let mut a = Seite::neu();
    let mut b = Seite::neu();

    let hinaus = a.kopiert("alt");
    austauschen(&mut a, &mut b, hinaus);

    // B beginnt den Abruf …
    let hol = b.fuegt_ein(0);
    // … waehrenddessen kopiert A etwas anderes.
    a.kopiert("neu");

    let alle = austauschen(&mut b, &mut a, hol);
    assert!(
        alle.iter().any(|r| matches!(r, Rahmen::Leer { grund: Grund::Veraltet, .. })),
        "der Abruf muss als veraltet abgelehnt werden, nicht mit dem neuen Inhalt beantwortet"
    );
    assert_ne!(b.ablage.geliefert().as_deref(), Some("neu"), "NIE ein anderer als der angekuendigte Inhalt");
}

#[test]
fn langer_text_kommt_vollstaendig_an() {
    let mut a = Seite::neu();
    let mut b = Seite::neu();
    let text = "Zeile mit Umlauten: Größe µ\n".repeat(600);

    let hinaus = a.kopiert(&text);
    austauschen(&mut a, &mut b, hinaus);
    let hol = b.fuegt_ein(0);
    austauschen(&mut b, &mut a, hol);

    assert_eq!(b.ablage.geliefert().as_deref(), Some(text.as_str()));
}
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd streaming/pulse-ablage && cargo test -q --test rundlauf`
Expected: FAIL — `unresolved import pulse_ablage::beobachter`.

- [ ] **Step 3: Traits und Testdoppel schreiben**

`streaming/pulse-ablage/src/beobachter.rs`:

```rust
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
```

`streaming/pulse-ablage/src/eigentum.rs`:

```rust
//! „Ich bin Eigentuemer, liefere aber erst auf Abruf" — der Beruehrungspunkt,
//! an dem das Betriebssystem etwas VERLANGT.

/// Eigentum an der lokalen Zwischenablage, mit verzoegertem Rendern.
pub trait Eigentum {
    /// Beanspruchen, **ohne Daten zu hinterlegen**.
    ///
    /// Auf Windows `SetClipboardData(CF_UNICODETEXT, NULL)`, auf macOS
    /// `declareTypes(owner:)`, auf Wayland ein `wl_data_source` samt
    /// `set_selection`.
    fn beanspruchen(&mut self) -> Result<(), String>;

    /// Den Inhalt an einen wartenden Einfuegevorgang geben.
    ///
    /// **Auf Windows und macOS wartet dort ein blockierter Faden.** Ein leerer
    /// Text ist eine gueltige Antwort und heisst „es kam nichts" — das ist
    /// besser als ein haengendes Programm.
    fn liefern(&mut self, text: &str);

    /// Eigentum abgeben.
    ///
    /// `zurueck` ist der gemerkte Vorbestand. **Das ist kein Beiwerk:** ein
    /// Anspruch loescht, was vorher in der Ablage lag. Wird nie eingefuegt,
    /// waere der eigene kopierte Pfad des Nutzers still verloren — durch fremde
    /// Aktivitaet. Zurueckgeschrieben wird nur, wenn wir zum Zeitpunkt des
    /// Freigebens noch Eigentuemer sind; hat inzwischen jemand anders kopiert,
    /// bleibt dessen Inhalt stehen.
    fn freigeben(&mut self, zurueck: Option<&str>);
}

/// Ob ein angemeldeter Anspruch schon eingeloest werden konnte.
///
/// **Wozu das gut ist: Wayland.** Dort verlangt `set_selection` eine
/// Seriennummer aus einem frischen Eingabeereignis, und ein Klient **ohne
/// Fokus kann die Auswahl nicht setzen** — der Compositor verwirft es, und
/// zwar still. Genau der Fall tritt ein: der Nutzer wechselt zu einem lokalen
/// Programm, drueben wird kopiert, die Ankuendigung kommt an — und das
/// Player-Fenster hat keinen Fokus. Der Anspruch wird deshalb EINGEREIHT und
/// beim naechsten Fenster-Ereignis eingeloest.
///
/// Die Rechnung steht hier als reine Zustandsmaschine, damit sie ohne
/// Compositor pruefbar ist — dieselbe Trennung wie bei der Zugerkennung in
/// `pulse-player/src/fernsteuerung/wayland/zustand.rs`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Anspruch {
    offen: bool,
}

impl Anspruch {
    pub fn neu() -> Anspruch {
        Anspruch { offen: false }
    }

    /// Eine Ankuendigung ist eingetroffen — Anspruch anmelden.
    pub fn anmelden(&mut self) {
        self.offen = true;
    }

    /// Ein Fenster-Ereignis ist da. Liefert `true`, wenn jetzt zu beanspruchen
    /// ist — und merkt sich, dass es geschehen ist.
    ///
    /// `serial == None` heisst „kein brauchbares Ereignis": der Anspruch bleibt
    /// offen, statt mit einer erfundenen Nummer still zu verpuffen.
    pub fn seriennummer(&mut self, serial: Option<u32>) -> bool {
        if !self.offen || serial.is_none() {
            return false;
        }
        self.offen = false;
        true
    }

    /// Der Anspruch ist gegenstandslos geworden (Sitzungsende, Typ unbekannt).
    pub fn aufgeben(&mut self) {
        self.offen = false;
    }

    pub fn offen(&self) -> bool {
        self.offen
    }
}

#[cfg(test)]
mod tests {
    use super::Anspruch;

    #[test]
    fn ohne_anmeldung_wird_nichts_beansprucht() {
        let mut a = Anspruch::neu();
        assert!(!a.seriennummer(Some(42)));
    }

    #[test]
    fn ohne_seriennummer_bleibt_der_anspruch_offen() {
        let mut a = Anspruch::neu();
        a.anmelden();
        assert!(!a.seriennummer(None));
        assert!(a.offen(), "er darf nicht verpuffen — sonst bliebe die Ablage leer");
        assert!(a.seriennummer(Some(42)), "mit Nummer wird er eingeloest");
    }

    #[test]
    fn ein_anspruch_wird_nur_einmal_eingeloest() {
        let mut a = Anspruch::neu();
        a.anmelden();
        assert!(a.seriennummer(Some(42)));
        assert!(!a.seriennummer(Some(43)), "kein zweites set_selection ohne neue Ankuendigung");
    }

    #[test]
    fn aufgeben_loescht_den_offenen_anspruch() {
        let mut a = Anspruch::neu();
        a.anmelden();
        a.aufgeben();
        assert!(!a.seriennummer(Some(42)));
    }
}
```

`streaming/pulse-ablage/src/pruefstand.rs`:

```rust
//! Ein Testdoppel beider Traits — eine Zwischenablage im Speicher.
//!
//! Muster und Begruendung wie `pulse-fernsteuerung/src/pruefstand.rs`: der
//! Ablauf soll ohne Betriebssystem fahrbar sein, sonst laesst sich genau das
//! nicht pruefen, worauf es ankommt (dass beim Kopieren nichts hinausgeht).

use crate::beobachter::Beobachter;
use crate::eigentum::Eigentum;

#[derive(Default)]
pub struct TestAblage {
    inhalt: Option<String>,
    /// Zaehlt wie `NSPasteboard.changeCount` — die Nachbildung ist Absicht.
    stand: u64,
    gesehen: u64,
    beansprucht: bool,
    geliefert: Option<String>,
    vorbestand: Option<String>,
}

impl TestAblage {
    pub fn neu() -> TestAblage {
        TestAblage::default()
    }

    /// Der Nutzer kopiert etwas.
    pub fn setzen(&mut self, text: &str) {
        self.inhalt = Some(text.to_string());
        self.stand += 1;
        self.beansprucht = false;
    }

    pub fn inhalt(&self) -> Option<String> {
        self.inhalt.clone()
    }

    pub fn beansprucht(&self) -> bool {
        self.beansprucht
    }

    /// Was ein Einfuegevorgang bekommen haette.
    pub fn geliefert(&self) -> Option<String> {
        self.geliefert.clone()
    }

    /// Der gemerkte Vorbestand, den `freigeben` zurueckschreiben wuerde.
    pub fn vorbestand(&self) -> Option<String> {
        self.vorbestand.clone()
    }
}

impl Beobachter for TestAblage {
    fn geaendert(&mut self) -> bool {
        let neu = self.stand != self.gesehen;
        self.gesehen = self.stand;
        neu
    }

    fn lesen(&self) -> Option<String> {
        self.inhalt.clone()
    }
}

impl Eigentum for TestAblage {
    fn beanspruchen(&mut self) -> Result<(), String> {
        // Genau die Falle, gegen die `freigeben(zurueck)` gebaut ist: der
        // Anspruch loescht den Vorbestand.
        self.vorbestand = self.inhalt.take();
        self.beansprucht = true;
        Ok(())
    }

    fn liefern(&mut self, text: &str) {
        self.geliefert = Some(text.to_string());
    }

    fn freigeben(&mut self, zurueck: Option<&str>) {
        self.beansprucht = false;
        if let Some(t) = zurueck {
            self.inhalt = Some(t.to_string());
        }
    }
}
```

`lib.rs` um `pub mod beobachter;`, `pub mod eigentum;`, `pub mod pruefstand;` ergänzen.

- [ ] **Step 4: Tests laufen lassen, Grün bestätigen**

Run: `cd streaming/pulse-ablage && cargo test -q`
Expected: PASS, 41 Tests (33 aus Task 1–3, 4 in `eigentum`, 4 im Rundlauf).

- [ ] **Step 5: Commit**

```bash
git add streaming/pulse-ablage
git commit -m "feat(ablage): Betriebssystem-Traits, Testdoppel und Rundlauf

Der Rundlauftest ist der Beleg fuer die Zusicherung, um derentwillen
die Kiste so gebaut ist: beim Kopieren geht genau ein Rahmen hinaus,
und der traegt keinen Inhalt. Erst das Einfuegen holt ihn.

Dazu die Anspruchs-Zustandsmaschine fuer Wayland als reine Rechnung —
dort kann ein Klient ohne Fokus die Auswahl nicht setzen, der Anspruch
muss also eingereiht werden statt still zu verpuffen."
```

---

### Task 5: Der Vorbestand-Schutz, durchgängig geprüft

**Files:**
- Modify: `streaming/pulse-ablage/tests/rundlauf.rs` (zwei Tests anfügen)

**Interfaces:**
- Consumes: alles aus Task 4. Keine neuen Namen.

Diese Task hat keinen eigenen Produktionscode: sie prüft eine Eigenschaft, die aus Task 4 folgt, aber leicht wieder verlorengeht — und sie ist der Grund, warum `freigeben` überhaupt einen Parameter hat.

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

An `streaming/pulse-ablage/tests/rundlauf.rs` anfügen:

```rust
#[test]
fn ein_anspruch_loescht_den_vorbestand_und_gibt_ihn_zurueck() {
    // **Die Falle, die kein Protokoll loest.** B hat lokal einen Pfad kopiert.
    // Drueben kopiert A etwas, B beansprucht daraufhin seine Ablage — und der
    // Pfad ist weg, ohne dass B etwas getan hat. Wird nie eingefuegt, merkt es
    // niemand, bis B einfuegen will.
    let mut a = Seite::neu();
    let mut b = Seite::neu();

    b.ablage.setzen("/home/michael/wichtig.txt");
    b.ablage.geaendert(); // den eigenen Stand quittieren

    let hinaus = a.kopiert("drueben kopiert");
    austauschen(&mut a, &mut b, hinaus);

    assert!(b.ablage.beansprucht());
    assert_eq!(b.ablage.inhalt(), None, "der Anspruch hat den Vorbestand geloescht");
    assert_eq!(
        b.ablage.vorbestand().as_deref(),
        Some("/home/michael/wichtig.txt"),
        "er muss gemerkt sein, sonst ist er unwiederbringlich"
    );

    // Sitzungsende: zurueckschreiben. Zwei Zeilen, nicht eine: der einzeilige
    // Ausdruck `b.ablage.freigeben(b.ablage.vorbestand().as_deref())` leiht
    // `b.ablage` gleichzeitig veraenderlich und lesend aus und traegt nur ueber
    // die Zwei-Phasen-Ausleihe. Ein Test soll nicht von einer Optimierung des
    // Ausleih-Pruefers abhaengen, die er gar nicht pruefen will.
    let vorher = b.ablage.vorbestand();
    b.ablage.freigeben(vorher.as_deref());
    assert_eq!(
        b.ablage.inhalt().as_deref(),
        Some("/home/michael/wichtig.txt"),
        "nach Sitzungsende steht wieder da, was der Nutzer selbst kopiert hatte"
    );
}

#[test]
fn nach_fristablauf_wird_leer_geliefert_statt_zu_haengen() {
    // Auf Windows und macOS wartet an dieser Stelle ein blockierter Faden. Ein
    // Einfuegen, das nichts einfuegt, versteht jeder; ein haengendes Programm
    // nicht.
    let mut a = Seite::neu();
    let mut b = Seite::neu();

    let hinaus = a.kopiert("kommt nie an");
    austauschen(&mut a, &mut b, hinaus);

    let hol = b.fuegt_ein(1_000);
    assert_eq!(hol.len(), 1, "der Abruf geht hinaus");
    // Die Antwort geht unterwegs verloren — nichts wird zugestellt.

    match b.emp.takt(1_000 + pulse_ablage::sitzung::ABRUF_FRIST_MS) {
        Fortschritt::Leer(Grund::Frist) => b.ablage.liefern(""),
        andere => panic!("erwartet Leer(Frist), bekam {andere:?}"),
    }
    assert_eq!(b.ablage.geliefert().as_deref(), Some(""), "es wurde geliefert, wenn auch nichts");
}
```

Damit die Tests auf `b.emp` zugreifen können, ist das Feld in `struct Seite` sichtbar zu halten (die Struktur liegt in derselben Testdatei — keine Änderung an der Kiste nötig).

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd streaming/pulse-ablage && cargo test -q --test rundlauf`
Expected: FAIL — der erste Test schlägt fehl, falls `beanspruchen` den Vorbestand nicht merkt.

Läuft er sofort grün, ist das **kein** Grund weiterzugehen: dann prüfen, ob `TestAblage::beanspruchen` den Vorbestand wirklich `take()`t (Task 4, Step 3). Ein Test, der auch ohne die Eigenschaft grün ist, prüft nichts.

- [ ] **Step 3: Grün machen**

Falls rot, sind das die beiden Methoden, um die es geht — in
`streaming/pulse-ablage/src/pruefstand.rs`, `impl Eigentum for TestAblage`:

```rust
    fn beanspruchen(&mut self) -> Result<(), String> {
        // Genau die Falle, gegen die `freigeben(zurueck)` gebaut ist: der
        // Anspruch loescht den Vorbestand. `take()` und nicht `clone()` —
        // die Ablage ist danach WIRKLICH leer, sonst bildete das Doppel den
        // Fehler gar nicht nach, den es nachweisen soll.
        self.vorbestand = self.inhalt.take();
        self.beansprucht = true;
        Ok(())
    }

    fn freigeben(&mut self, zurueck: Option<&str>) {
        self.beansprucht = false;
        if let Some(t) = zurueck {
            self.inhalt = Some(t.to_string());
        }
    }
```

- [ ] **Step 4: Tests laufen lassen, Grün bestätigen**

Run: `cd streaming/pulse-ablage && cargo test -q`
Expected: PASS, 43 Tests.

- [ ] **Step 5: Commit**

```bash
git add streaming/pulse-ablage
git commit -m "test(ablage): Vorbestand-Schutz und Fristablauf im Rundlauf

Zwei Eigenschaften, die aus dem Entwurf folgen und leicht wieder
verlorengehen: ein Anspruch loescht, was vorher in der Ablage lag (also
muss er es merken und bei Sitzungsende zurueckschreiben), und nach
Fristablauf wird LEER geliefert statt gar nicht — auf Windows und macOS
wartet dort ein blockierter Faden."
```

---

### Task 6: Das Gate wirklich fahren und die Kiste dokumentieren

**Files:**
- Create: `streaming/pulse-ablage/README.md`
- Modify: `docs/fernsteuerung.md` (Abschnitt am Ende anfügen)

**Interfaces:** keine.

- [ ] **Step 1: Nachweisen, dass das Gate die Kiste greift**

Run:

```bash
cd /home/michael/Documents/pulse
printf 'streaming/pulse-ablage/src/format.rs\n' | bash scripts/gate-rust.sh "$(cat)"
```

Expected: eine Zeile `  Cargo-Tests streaming/pulse-ablage…` und danach Grün.

Kommt die Zeile **nicht**, ist die Schleife in `gate-rust.sh` anzupassen — nicht der Plan. Ein Test, den kein Gate fährt, sieht in der Ausgabe genauso aus wie ein grüner; dieses Projekt hat diese Fehlerklasse dreimal bezahlt (Node-Unit-Tests 2026-08-17, mac-Kisten 2026-08-23, `pulse-whip` 2026-08-27).

- [ ] **Step 2: README schreiben**

`streaming/pulse-ablage/README.md`:

```markdown
# pulse-ablage

Der plattformfreie Kern der geteilten Zwischenablage der Fernsteuerung.

**Entwurf:** `docs/superpowers/specs/2026-08-31-fernsteuerung-zwischenablage-design.md`

## Was hier drin ist

| Modul | Aufgabe |
|---|---|
| `format` | Die vier Rahmen (`neu`/`hol`/`stueck`/`leer`) und die zwei Zahlen, gegen die gerechnet wird |
| `stueckelung` | Zerlegen und Wiederzusammensetzen unter dem 8192-Byte-Deckel des Gateways |
| `sitzung` | `Ankuendiger` (meine Seite) und `Empfaenger` (die Gegenseite) |
| `beobachter` / `eigentum` | Die zwei Beruehrungspunkte mit dem Betriebssystem, als Traits |
| `pruefstand` | Testdoppel beider Traits |

## Die eine Zusicherung

**Beim Kopieren geht kein Inhalt hinaus.** `tests/rundlauf.rs` belegt es: nach
einem Kopiervorgang kreuzt genau ein Rahmen die Leitung, und das ist die
Ankuendigung. Erst ein tatsaechliches Einfuegen loest die Uebertragung aus.

Wer hier etwas aendert, faehrt diesen Test und liest, was er behauptet.

## Wer die Kiste einbindet

`pulse-player` (der Steuernde), `win-hq-sidecar` und `mac-hq-sidecar` (die
Hosts). **`linux-hq-sidecar` nicht** — Linux kann heute gar nicht Host sein,
`remote_input` gibt es dort nicht.

Die Linux-Umsetzung der beiden Traits liegt im **Player**
(`src/fernsteuerung/wayland/`), nicht hier: der Player haelt fuer die
Zugerkennung bereits ein `wl_data_device` am Sitzplatz, und ein zweites
verdoppelte alle Ereignisse. Windows und macOS bringen ihr eigenes verstecktes
Fenster mit und sind selbsttragend.

## Tests

    cargo test

Laeuft ohne FFmpeg, ohne Fenster, ohne Netz — die Kiste ist reine Rechnung.
```

- [ ] **Step 3: `docs/fernsteuerung.md` ergänzen**

Am Ende von `docs/fernsteuerung.md` anfügen:

```markdown
**Geteilte Zwischenablage (im Bau, seit 2026-08-31)** — Text, beidseitig, über
**verzögertes Rendern**: beim Kopieren geht nur eine Ankündigung mit einer
Generationsnummer hinüber, der Inhalt erst, wenn drüben jemand tatsächlich
einfügt. Entwurf `docs/superpowers/specs/2026-08-31-fernsteuerung-zwischenablage-design.md`,
Kern in `streaming/pulse-ablage` (dort auch das README).
- **Die Sofort-Spiegelung ist verworfen, nicht vergessen.** Sie legt alles, was
  während einer Sitzung lokal kopiert wird, im selben Moment auf den fremden
  Rechner — auch ein Passwort aus dem Passwortmanager, das mit der Sitzung
  nichts zu tun hat. Wer sie „der Einfachheit halber" wieder einbaut, hebt den
  ganzen Entwurf auf.
- **`gen` ist die Regel, nicht ein Feld:** stimmt die angeforderte Generation
  nicht mehr, wird `leer/veraltet` geantwortet. Es wird **nie** ein anderer
  Inhalt geliefert als der angekündigte.
- **Der Rückruf des Betriebssystems blockiert.** `WM_RENDERFORMAT` und
  `pasteboard(_:provideDataForType:)` müssen synchron beantwortet werden,
  während das einfügende Programm wartet — deshalb ein eigener Faden mit
  eigenem, nur für Nachrichten sichtbarem Fenster, und deshalb `ABRUF_FRIST_MS`
  (2 s) **unter** `REMOTE_DISCONNECT_GRACE_S` (10 s). Ein Einfügen, das nichts
  einfügt, versteht jeder; ein hängendes Programm nicht.
- **Ein Anspruch löscht den Vorbestand** der lokalen Ablage. Deshalb wird er
  beim ersten Anspruch gemerkt und bei Sitzungsende zurückgeschrieben.
- **Linux ist immer der Steuernde** — `remote_input` gibt es nur im Windows-
  und macOS-Sidecar.
```

- [ ] **Step 4: Volles Gate fahren**

Run: `bash scripts/gate.sh`
Expected: Grün. (Reine Doku- und Rust-Änderung; Backend und Frontend sind unberührt und werden über den `origin/main`-Teilbaumvergleich übersprungen.)

- [ ] **Step 5: Commit**

```bash
git add streaming/pulse-ablage/README.md docs/fernsteuerung.md
git commit -m "docs(ablage): README der Kiste und Eintrag in der Fernsteuerungs-Doku

Festgehalten wird vor allem, was NICHT wieder passieren soll: die
Sofort-Spiegelung ist verworfen, nicht vergessen; die Generation ist
eine Regel und kein Feld; und ein Anspruch loescht den Vorbestand."
```

---

## Was danach kommt

**Plan 1b — Verdrahtung und Windows-Host.** `"ablage"` in `_SIGNAL_KINDS`
(`ws_remote_handlers.py`) und `RemoteSignalKind`
(`web/src/lib/ws/handlers/types.ts:32`); Durchreichen im Renderer **ohne den
Rahmen zu parsen**, samt Wahl des Träger-Platzes unter mehreren Sidecars;
`ablage`-Ops im `win-hq-sidecar` (`dispatch.rs`) und die Windows-Umsetzung
beider Traits auf eigenem Faden mit `HWND_MESSAGE`; Player-RPC und
`player:event`, Eintrag in `ALLOWED_PLAYER_OPS` (`desktop/electron/main.ts:922`),
`preload.ts` und `web/src/lib/platform/pulse.d.ts`; die Wayland-Umsetzung im
Player; der Schalter im Fern-Menü und die Zeile im Zustimmungsdialog. Dazu die
Selbstdrosselung auf 30 Stücke/s (Pflicht des Senders — der Gateway verwirft
über 60/s **still**), das frische `neu` **beider** Seiten nach erfolgreichem
`remote_reclaim` (sonst hält die Gegenseite ein Versprechen auf eine
Generation, die hier niemand mehr kennt, und jedes Einfügen antwortet
`veraltet`), und das Abgeben des Eigentums samt Zurückschreiben des
Vorbestands in `remote_end` — dem einen Trichter, durch den jede Sitzung
verschwindet. Dazu die
Pfad-Filter in `win-build.yml`/`mac-build.yml`/`flatpak.yml` und die
`type: dir`-Quellen im Flatpak-Manifest — die `streaming/zwillinge`-Prüfsteine
erzwingen sie, sobald die Abhängigkeit da ist. **Windows-Versions-Bump ist
Pflicht.** Erstes echtes Ende-zu-Ende: Linux steuert Windows.

**Plan 1c — macOS.** Host-Seite im `mac-hq-sidecar`, Steuernden-Seite im Player.
`objc2` + `objc2-app-kit` im Player sind am 2026-08-31 vom Nutzer
**freigegeben** — der Player hatte bis dahin keine einzige
macOS-Abhängigkeit. Die Grenze bleibt hart: die Freigabe gilt für diese zwei
Kisten und diesen Zweck.

**Stufe 2 — Dateien.** Eigener Entwurf. Die vier Rahmen bleiben; `typ:"dateien"`,
`anzahl`/`bytes` an `neu`, Datei-Index an `hol`, und der Träger wechselt auf den
P2P-DataChannel. Offen ist dort die Lieferart (Staging gegen echte
Dateiversprechen).
