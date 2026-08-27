# Etappe A — Krypto-Kern `pulse-krypto` — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eine eigenständige Rust-Kiste, die vodozemac hinter einer schmalen,
sprachneutralen Schnittstelle kapselt — Gespräche zu zweit (Olm) und Gruppen
(Megolm) —, mit WASM-Ausgabe für den Web-Klienten.

**Architecture:** Die Kiste kennt weder Pulse-Datenmodelle noch Netzwerk. Sie
kennt Identitäten, Sitzungen und Umschläge. **An der Grenze gibt es nur
Zeichenketten und Zahlen** (Base64), weil dieselbe Grenze später von
JavaScript über WASM und von Kotlin über JNI überquert wird; Rust-Typen kämen
dort nicht durch. Sitzungszustand wird eingefroren („pickle") herausgereicht,
nie roh.

**Tech Stack:** Rust (edition 2024) · vodozemac 0.10.0 (Apache-2.0) ·
wasm-bindgen + wasm-pack 0.15.0 · Nodes eingebauter Testläufer

**Spec:** `docs/superpowers/specs/2026-08-28-e2e-dm-design.md` (§2 Modell,
§9 Gruppen, §10 Etappe A)

## Global Constraints

- **Keine GPL/AGPL-Abhängigkeit.** vodozemac ist Apache-2.0. libsignal ist ausgeschlossen.
- **Keine weitere neue Abhängigkeit ohne Rückfrage** ausser den hier genannten (`vodozemac`, `wasm-bindgen`, `getrandom`, dev-only `serde_json`).
- **Quelldateien ≤ 350 Zeilen (hart 500).** Im Zweifel splitten.
- **Niemals Schlüssel, Umschläge oder Klartext loggen** — auch nicht gekürzt, auch nicht in Fehlermeldungen. Ein Fehler sagt *was* schiefging, nie *womit*.
- **Deutsche Kommentare und Commit-Nachrichten, echte Umlaute** (ä/ö/ü/ß).
- **Node-Unit-Tests:** eine geprüfte Datei darf keinen erweiterungslosen Laufzeit-Import haben (`from './nachbar'`) — der Bundler löst ihn auf, Node nicht.
- **Kein `git push`, kein `gh`** ohne Freigabe.
- **Changelog:** diese Etappe ist für Nutzer unsichtbar (keine Oberfläche) → **kein** Eintrag in `web/static/changelog.json`.
- Ort der Kiste: **`krypto/pulse-krypto/`**, eigenständig (kein Workspace) — dasselbe Muster wie `streaming/pulse-zeitbasis/`.

## Gepinnte vodozemac-API

Am Quelltext von 0.10.0 nachgesehen, nicht aus dem Gedächtnis. Wer abweicht,
irrt sich — nicht diese Liste.

```rust
// olm::Account
Account::new() -> Account
account.identity_keys() -> IdentityKeys              // { ed25519, curve25519 }
account.generate_one_time_keys(count: usize) -> OneTimeKeyGenerationResult  // { created, removed }
account.one_time_keys() -> HashMap<KeyId, Curve25519PublicKey>
account.mark_keys_as_published()
account.generate_fallback_key() -> Option<Curve25519PublicKey>
account.fallback_key() -> HashMap<KeyId, Curve25519PublicKey>
account.create_outbound_session(SessionConfig, Curve25519PublicKey, Curve25519PublicKey)
    -> Result<Session, SessionCreationError>
account.create_inbound_session(SessionConfig, Curve25519PublicKey, &PreKeyMessage)
    -> Result<InboundCreationResult, SessionCreationError>   // { session, plaintext }
account.pickle() -> AccountPickle ; Account::from_pickle(AccountPickle) -> Account

// olm::Session
session.encrypt(impl AsRef<[u8]>) -> Result<OlmMessage, EncryptionError>
session.decrypt(&OlmMessage) -> Result<Vec<u8>, DecryptionError>
session.session_id() -> String
session.pickle() -> SessionPickle ; Session::from_pickle(SessionPickle) -> Session

// olm::OlmMessage (enum: Normal(Message) | PreKey(PreKeyMessage))
OlmMessage::from_parts(message_type: usize, ciphertext: &[u8]) -> Result<Self, DecodeError>
olm_message.to_parts() -> (usize, Vec<u8>)

// megolm::GroupSession / InboundGroupSession
GroupSession::new(SessionConfig) -> GroupSession
gs.encrypt(impl AsRef<[u8]>) -> MegolmMessage        // kein Result
gs.session_key() -> SessionKey
gs.message_index() -> u32
InboundGroupSession::new(&SessionKey, SessionConfig) -> InboundGroupSession
igs.decrypt(&MegolmMessage) -> Result<DecryptedMessage, DecryptionError>  // { plaintext, message_index }
SessionKey::to_base64() -> String ; SessionKey::from_base64(&str) -> Result<Self, SessionKeyDecodeError>
MegolmMessage::to_base64() -> String ; MegolmMessage::from_base64(&str) -> Result<Self, DecodeError>

// Schlüssel
Curve25519PublicKey::to_base64() -> String
Curve25519PublicKey::from_base64(&str) -> Result<Curve25519PublicKey, KeyError>

// Pickles verschlüsselt herausreichen
pickle.encrypt(&[u8; 32]) -> String
Pickle::from_encrypted(&str, &[u8; 32]) -> Result<Pickle, PickleError>
```

## Dateizuschnitt

| Datei | Verantwortung |
|---|---|
| `krypto/pulse-krypto/Cargo.toml` | Abhängigkeiten, `crate-type` für WASM |
| `krypto/pulse-krypto/src/lib.rs` | Modulbaum, öffentliche Wiederausfuhr, Fehlertyp |
| `krypto/pulse-krypto/src/fehler.rs` | `KryptoFehler` — trägt **nie** Schlüsselmaterial |
| `krypto/pulse-krypto/src/identitaet.rs` | Account-Hülle: Schlüssel, Einmalschlüssel, Einfrieren |
| `krypto/pulse-krypto/src/sitzung.rs` | Olm-Sitzung zu zweit: Auf- und Abbau, Umschläge |
| `krypto/pulse-krypto/src/gruppe.rs` | Megolm: Sende- und Empfangssitzung |
| `krypto/pulse-krypto/src/umschlag.rs` | `Umschlag { art, daten }` — die Grenze zur Aussenwelt |
| `krypto/pulse-krypto/src/wasm.rs` | wasm-bindgen-Hülle, nur hinter `#[cfg(target_arch = "wasm32")]` |
| `krypto/LICENSE` | Verweis auf die Client-Lizenz (neuer Top-Level-Bereich) |

---

### Task 1: Kiste, Fehlertyp und Identität

**Files:**
- Create: `krypto/pulse-krypto/Cargo.toml`, `src/lib.rs`, `src/fehler.rs`, `src/identitaet.rs`
- Create: `krypto/LICENSE`
- Modify: `LICENSE`, `LICENSE-CLIENT.md`, `README.md` (Client-Bereich um `krypto/` erweitern)

**Interfaces:**
- Produces: `Identitaet::neu()`, `Identitaet::schluessel() -> Identitaetsschluessel { curve25519: String, ed25519: String }`, `Identitaet::einmalschluessel_erzeugen(anzahl: usize) -> Vec<String>`, `Identitaet::offene_einmalschluessel() -> Vec<String>`, `Identitaet::als_veroeffentlicht_markieren()`, `Identitaet::rueckfallschluessel_erzeugen() -> Option<String>`, `Identitaet::einfrieren(&self, schluessel: &[u8; 32]) -> Result<String, KryptoFehler>`, `Identitaet::auftauen(gefroren: &str, schluessel: &[u8; 32]) -> Result<Identitaet, KryptoFehler>`
- Produces: `KryptoFehler` (enum, `std::error::Error`)

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

In `krypto/pulse-krypto/src/identitaet.rs`, unten:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn einmalschluessel_ueberleben_das_einfrieren() {
        // Der Sitzungszustand muss einen App-Neustart ueberstehen. Wird er
        // falsch eingefroren, faellt das erst auf, wenn ein Nutzer die App
        // schliesst — also nie in einem fluechtigen Test.
        let schluessel = [7u8; 32];
        let mut ich = Identitaet::neu();
        let erzeugt = ich.einmalschluessel_erzeugen(5);
        assert_eq!(erzeugt.len(), 5);

        let gefroren = ich.einfrieren(&schluessel).expect("einfrieren");
        let wieder = Identitaet::auftauen(&gefroren, &schluessel).expect("auftauen");

        assert_eq!(wieder.schluessel().curve25519, ich.schluessel().curve25519);
        let mut a = ich.offene_einmalschluessel();
        let mut b = wieder.offene_einmalschluessel();
        a.sort();
        b.sort();
        assert_eq!(a, b);
    }

    #[test]
    fn falscher_schluessel_taut_nicht_auf() {
        let gefroren = Identitaet::neu().einfrieren(&[1u8; 32]).expect("einfrieren");
        assert!(Identitaet::auftauen(&gefroren, &[2u8; 32]).is_err());
    }

    #[test]
    fn veroeffentlichen_leert_die_offene_liste() {
        // Nach dem Hochladen darf derselbe Einmalschluessel nicht ein zweites
        // Mal angeboten werden — sonst benutzen ihn zwei Absender.
        let mut ich = Identitaet::neu();
        ich.einmalschluessel_erzeugen(3);
        assert_eq!(ich.offene_einmalschluessel().len(), 3);
        ich.als_veroeffentlicht_markieren();
        assert!(ich.offene_einmalschluessel().is_empty());
    }
}
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

```bash
cd krypto/pulse-krypto && cargo test
```
Erwartet: Übersetzungsfehler, `Identitaet` existiert nicht.

- [ ] **Schritt 3: `Cargo.toml` schreiben**

```toml
[package]
name = "pulse-krypto"
version = "0.1.0"
edition = "2024"
publish = false

# Kapselt vodozemac (Apache-2.0). Diese Kiste kennt weder Pulse-Datenmodelle
# noch Netzwerk — nur Identitaeten, Sitzungen und Umschlaege.

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
vodozemac = "0.10.0"

[target.'cfg(target_arch = "wasm32")'.dependencies]
wasm-bindgen = "0.2"
getrandom = { version = "0.3", features = ["wasm_js"] }
```

`crate-type` braucht beides: `rlib` für `cargo test` und den Android-Build,
`cdylib` für wasm-pack. `getrandom` mit `wasm_js` ist nötig, weil vodozemac
sonst im Browser keine Zufallsquelle findet — ohne diesen Eintrag baut es, und
schlägt erst zur Laufzeit fehl.

- [ ] **Schritt 4: `src/fehler.rs` schreiben**

```rust
//! Ein Fehler sagt, WAS schiefging — nie, WOMIT.
//!
//! Die Ursprungsfehler von vodozemac werden bewusst nicht durchgereicht:
//! einige tragen Schluesselmaterial oder Teile des Klartexts in ihrer
//! Display-Ausgabe, und diese Ausgabe landet erfahrungsgemaess irgendwann in
//! einem Log. Wer hier `#[from]` ergaenzt, hebt diese Zusicherung auf.

use core::fmt;

#[derive(Debug, PartialEq, Eq)]
pub enum KryptoFehler {
    /// Ein Schluessel liess sich nicht lesen (falsches Format, falsche Laenge).
    SchluesselUnlesbar,
    /// Ein Umschlag liess sich nicht lesen.
    UmschlagUnlesbar,
    /// Entschluesseln schlug fehl — falsche Sitzung, oder verfaelscht.
    EntschluesselnFehlgeschlagen,
    /// Verschluesseln schlug fehl.
    VerschluesselnFehlgeschlagen,
    /// Eine Sitzung liess sich nicht aufbauen.
    SitzungsaufbauFehlgeschlagen,
    /// Eingefrorener Zustand liess sich nicht auftauen (meist falscher Schluessel).
    AuftauenFehlgeschlagen,
    /// Ein Umschlag wurde als laufende Nachricht erwartet, war aber ein
    /// Sitzungsaufbau — oder umgekehrt.
    FalscheUmschlagart,
}

impl fmt::Display for KryptoFehler {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::SchluesselUnlesbar => "Schluessel unlesbar",
            Self::UmschlagUnlesbar => "Umschlag unlesbar",
            Self::EntschluesselnFehlgeschlagen => "Entschluesseln fehlgeschlagen",
            Self::VerschluesselnFehlgeschlagen => "Verschluesseln fehlgeschlagen",
            Self::SitzungsaufbauFehlgeschlagen => "Sitzungsaufbau fehlgeschlagen",
            Self::AuftauenFehlgeschlagen => "Auftauen fehlgeschlagen",
            Self::FalscheUmschlagart => "falsche Umschlagart",
        };
        f.write_str(text)
    }
}

impl std::error::Error for KryptoFehler {}
```

- [ ] **Schritt 5: `src/identitaet.rs` schreiben**

```rust
//! Die Identitaet eines Geraets: ein vodozemac-Account plus Einmalschluessel.
//!
//! An der Grenze gibt es nur Base64-Zeichenketten — dieselbe Grenze ueberquert
//! spaeter JavaScript ueber WASM und Kotlin ueber JNI.

use vodozemac::olm::Account;

use crate::fehler::KryptoFehler;

/// Die oeffentlichen Schluessel eines Geraets, beide Base64.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identitaetsschluessel {
    /// Zum Schluesselaustausch (Curve25519 alias X25519).
    pub curve25519: String,
    /// Zum Signieren.
    pub ed25519: String,
}

pub struct Identitaet {
    pub(crate) account: Account,
}

impl Identitaet {
    pub fn neu() -> Self {
        Self { account: Account::new() }
    }

    pub fn schluessel(&self) -> Identitaetsschluessel {
        let k = self.account.identity_keys();
        Identitaetsschluessel {
            curve25519: k.curve25519.to_base64(),
            ed25519: k.ed25519.to_base64(),
        }
    }

    /// Erzeugt `anzahl` neue Einmalschluessel und gibt die neuen zurueck.
    pub fn einmalschluessel_erzeugen(&mut self, anzahl: usize) -> Vec<String> {
        self.account
            .generate_one_time_keys(anzahl)
            .created
            .iter()
            .map(|k| k.to_base64())
            .collect()
    }

    /// Alle noch nicht veroeffentlichten Einmalschluessel.
    pub fn offene_einmalschluessel(&self) -> Vec<String> {
        self.account.one_time_keys().values().map(|k| k.to_base64()).collect()
    }

    /// Nach dem erfolgreichen Hochladen aufrufen — sonst bietet das Geraet
    /// denselben Schluessel erneut an und zwei Absender benutzen ihn.
    pub fn als_veroeffentlicht_markieren(&mut self) {
        self.account.mark_keys_as_published();
    }

    /// Der Rueckfallschluessel greift, wenn der Vorrat an Einmalschluesseln
    /// leer ist — sonst koennte niemand mehr an ein laenger ausgeschaltetes
    /// Geraet schreiben.
    pub fn rueckfallschluessel_erzeugen(&mut self) -> Option<String> {
        self.account.generate_fallback_key().map(|k| k.to_base64())
    }

    pub fn einfrieren(&self, schluessel: &[u8; 32]) -> Result<String, KryptoFehler> {
        Ok(self.account.pickle().encrypt(schluessel))
    }

    pub fn auftauen(gefroren: &str, schluessel: &[u8; 32]) -> Result<Self, KryptoFehler> {
        let pickle = vodozemac::olm::AccountPickle::from_encrypted(gefroren, schluessel)
            .map_err(|_| KryptoFehler::AuftauenFehlgeschlagen)?;
        Ok(Self { account: Account::from_pickle(pickle) })
    }
}
```

**Hinweis an den Umsetzer:** `einfrieren` gibt hier `Result` zurueck, obwohl
`encrypt` nicht fehlschlagen kann. Das ist Absicht — die Signatur soll sich
nicht aendern muessen, wenn spaeter ein fehlbarer Schritt dazukommt. Wenn der
Übersetzer den `Ok(...)`-Zweig als unnoetig meldet, den `Result` trotzdem
behalten.

- [ ] **Schritt 6: `src/lib.rs` schreiben**

```rust
//! Krypto-Kern von Pulse: Gespraeche zu zweit (Olm) und Gruppen (Megolm).
//!
//! Diese Kiste kennt weder Pulse-Datenmodelle noch Netzwerk. Sie kennt
//! Identitaeten, Sitzungen und Umschlaege — mehr nicht.

pub mod fehler;
pub mod identitaet;

pub use fehler::KryptoFehler;
pub use identitaet::{Identitaet, Identitaetsschluessel};
```

- [ ] **Schritt 7: Tests laufen lassen**

```bash
cd krypto/pulse-krypto && cargo test
```
Erwartet: 3 grün.

- [ ] **Schritt 8: Lizenz-Einordnung nachziehen**

`krypto/` ist ein **neuer Top-Level-Bereich**. Er gehoert zum **Client**
(die Kiste laeuft im Browser und auf dem Telefon, nicht auf dem Server).
`grep -rn "streaming/" LICENSE LICENSE-CLIENT.md README.md` zeigt die Stellen,
an denen die Client-Bereiche aufgezaehlt sind — `krypto/` ueberall danebenstellen.
`krypto/LICENSE` anlegen, Wortlaut von `streaming/LICENSE` uebernehmen.

Das ist der Loesch-/Anlege-Fall der Regel „eine Behauptung wird nie an nur
einer Stelle korrigiert": ein Verzeichnisname ist eine Behauptung wie jede
andere.

- [ ] **Schritt 9: Committen**

```bash
git add krypto/ LICENSE LICENSE-CLIENT.md README.md
git commit -m "feat(krypto): Kiste pulse-krypto mit Geraete-Identitaet"
```

---

### Task 2: Gespräch zu zweit (Olm)

**Files:**
- Create: `krypto/pulse-krypto/src/umschlag.rs`, `krypto/pulse-krypto/src/sitzung.rs`
- Modify: `krypto/pulse-krypto/src/lib.rs` (Module ergänzen), `src/identitaet.rs` (zwei Methoden)

**Interfaces:**
- Consumes: `Identitaet`, `KryptoFehler` aus Task 1
- Produces: `Umschlag { art: Umschlagart, daten: String }`, `Umschlagart::{Sitzungsaufbau, Laufend}`
- Produces: `Identitaet::sitzung_ausgehend(&self, gegenstelle_curve25519: &str, einmalschluessel: &str) -> Result<Sitzung, KryptoFehler>`
- Produces: `Identitaet::sitzung_eingehend(&mut self, absender_curve25519: &str, umschlag: &Umschlag) -> Result<(Sitzung, Vec<u8>), KryptoFehler>`
- Produces: `Sitzung::verschluesseln(&mut self, klartext: &[u8]) -> Result<Umschlag, KryptoFehler>`, `Sitzung::entschluesseln(&mut self, umschlag: &Umschlag) -> Result<Vec<u8>, KryptoFehler>`, `Sitzung::kennung(&self) -> String`, `Sitzung::einfrieren`, `Sitzung::auftauen`

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

In `krypto/pulse-krypto/src/sitzung.rs`:

```rust
#[cfg(test)]
mod tests {
    use crate::{Identitaet, Sitzung, Umschlag, Umschlagart};

    /// Baut ein Paar auf, wie es im Betrieb entsteht: Bob veroeffentlicht
    /// seine Schluessel, Alice holt sie und schreibt zuerst.
    fn paar() -> (Identitaet, Identitaet, Sitzung, Umschlag) {
        let alice = Identitaet::neu();
        let mut bob = Identitaet::neu();
        let einmal = bob.einmalschluessel_erzeugen(1).remove(0);
        bob.als_veroeffentlicht_markieren();

        let mut sitzung = alice
            .sitzung_ausgehend(&bob.schluessel().curve25519, &einmal)
            .expect("ausgehende Sitzung");
        let erster = sitzung.verschluesseln(b"hallo").expect("verschluesseln");
        (alice, bob, sitzung, erster)
    }

    #[test]
    fn erste_nachricht_ist_ein_sitzungsaufbau() {
        let (_, _, _, erster) = paar();
        assert_eq!(erster.art, Umschlagart::Sitzungsaufbau);
    }

    #[test]
    fn hin_und_zurueck() {
        let (alice, mut bob, mut alice_sitzung, erster) = paar();

        let (mut bob_sitzung, klartext) = bob
            .sitzung_eingehend(&alice.schluessel().curve25519, &erster)
            .expect("eingehende Sitzung");
        assert_eq!(klartext, b"hallo");

        // Rueckweg — und ab jetzt sind es laufende Nachrichten.
        let antwort = bob_sitzung.verschluesseln(b"auch hallo").expect("antwort");
        assert_eq!(antwort.art, Umschlagart::Laufend);
        assert_eq!(
            alice_sitzung.entschluesseln(&antwort).expect("entschluesseln"),
            b"auch hallo"
        );
    }

    #[test]
    fn fremde_sitzung_entschluesselt_nicht() {
        let (_, _, _, erster) = paar();
        let mut fremd = Identitaet::neu();
        let alice2 = Identitaet::neu();
        assert!(fremd.sitzung_eingehend(&alice2.schluessel().curve25519, &erster).is_err());
    }

    #[test]
    fn sitzung_ueberlebt_das_einfrieren() {
        let (alice, mut bob, mut alice_sitzung, erster) = paar();
        let (bob_sitzung, _) = bob
            .sitzung_eingehend(&alice.schluessel().curve25519, &erster)
            .expect("eingehende Sitzung");

        let gefroren = bob_sitzung.einfrieren(&[9u8; 32]).expect("einfrieren");
        let mut wieder = Sitzung::auftauen(&gefroren, &[9u8; 32]).expect("auftauen");

        let zweiter = alice_sitzung.verschluesseln(b"danach").expect("verschluesseln");
        assert_eq!(wieder.entschluesseln(&zweiter).expect("entschluesseln"), b"danach");
    }
}
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

```bash
cd krypto/pulse-krypto && cargo test
```
Erwartet: Übersetzungsfehler, `Sitzung` und `Umschlag` existieren nicht.

- [ ] **Schritt 3: `src/umschlag.rs` schreiben**

```rust
//! Der Umschlag ist die einzige Form, in der Verschluesseltes diese Kiste
//! verlaesst. Er traegt bewusst KEINE Empfaengerangabe und keine Kanal-ID —
//! wer wohin gehoert, entscheidet Pulse, nicht die Krypto.

use crate::fehler::KryptoFehler;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Umschlagart {
    /// Baut die Sitzung erst auf (Olm-PreKey). Der Empfaenger hat noch keine.
    Sitzungsaufbau,
    /// Laufende Nachricht in einer bestehenden Sitzung.
    Laufend,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Umschlag {
    pub art: Umschlagart,
    /// Base64. Nie loggen.
    pub daten: String,
}

impl Umschlagart {
    /// vodozemac zaehlt die Arten als `usize`: 0 = PreKey, alles andere normal.
    pub(crate) fn aus_zahl(zahl: usize) -> Self {
        if zahl == 0 { Self::Sitzungsaufbau } else { Self::Laufend }
    }

    pub(crate) fn als_zahl(self) -> usize {
        match self {
            Self::Sitzungsaufbau => 0,
            Self::Laufend => 1,
        }
    }
}

impl Umschlag {
    pub(crate) fn aus_olm(nachricht: &vodozemac::olm::OlmMessage) -> Self {
        let (art, bytes) = nachricht.to_parts();
        Self {
            art: Umschlagart::aus_zahl(art),
            daten: base64_kodieren(&bytes),
        }
    }

    pub(crate) fn zu_olm(&self) -> Result<vodozemac::olm::OlmMessage, KryptoFehler> {
        let bytes = base64_dekodieren(&self.daten)?;
        vodozemac::olm::OlmMessage::from_parts(self.art.als_zahl(), &bytes)
            .map_err(|_| KryptoFehler::UmschlagUnlesbar)
    }
}
```

**Zur Base64-Frage:** vodozemac bringt eine Base64-Hilfe mit
(`vodozemac::base64_encode` / `base64_decode`). **Zuerst pruefen, ob sie
oeffentlich ist** (`rg "pub fn base64_" ~/.cargo/registry/src/*/vodozemac-0.10.0/src/`);
wenn ja, diese benutzen und `base64_kodieren`/`base64_dekodieren` durch sie
ersetzen. Nur wenn nicht, eine eigene Abhaengigkeit vorschlagen — **nicht
selbst hinzufuegen**, das braucht Rueckfrage.

- [ ] **Schritt 4: `src/sitzung.rs` schreiben**

```rust
//! Ein Gespraech zu zweit (Olm, Double Ratchet).

use vodozemac::olm::{OlmMessage, Session, SessionPickle};

use crate::{fehler::KryptoFehler, umschlag::{Umschlag, Umschlagart}};

pub struct Sitzung {
    pub(crate) session: Session,
}

impl Sitzung {
    /// Kennung des Gespraechs — stabil auf beiden Seiten, damit der Klient
    /// eine eingehende Nachricht der richtigen Sitzung zuordnen kann.
    pub fn kennung(&self) -> String {
        self.session.session_id()
    }

    pub fn verschluesseln(&mut self, klartext: &[u8]) -> Result<Umschlag, KryptoFehler> {
        let nachricht = self
            .session
            .encrypt(klartext)
            .map_err(|_| KryptoFehler::VerschluesselnFehlgeschlagen)?;
        Ok(Umschlag::aus_olm(&nachricht))
    }

    pub fn entschluesseln(&mut self, umschlag: &Umschlag) -> Result<Vec<u8>, KryptoFehler> {
        let nachricht: OlmMessage = umschlag.zu_olm()?;
        self.session
            .decrypt(&nachricht)
            .map_err(|_| KryptoFehler::EntschluesselnFehlgeschlagen)
    }

    pub fn einfrieren(&self, schluessel: &[u8; 32]) -> Result<String, KryptoFehler> {
        Ok(self.session.pickle().encrypt(schluessel))
    }

    pub fn auftauen(gefroren: &str, schluessel: &[u8; 32]) -> Result<Self, KryptoFehler> {
        let pickle = SessionPickle::from_encrypted(gefroren, schluessel)
            .map_err(|_| KryptoFehler::AuftauenFehlgeschlagen)?;
        Ok(Self { session: Session::from_pickle(pickle) })
    }
}
```

- [ ] **Schritt 5: Die zwei Methoden an `Identitaet` ergänzen**

In `src/identitaet.rs`:

```rust
    /// Baut die Sitzung auf, wenn WIR zuerst schreiben. Braucht die
    /// veroeffentlichten Schluessel der Gegenstelle.
    pub fn sitzung_ausgehend(
        &self,
        gegenstelle_curve25519: &str,
        einmalschluessel: &str,
    ) -> Result<crate::sitzung::Sitzung, KryptoFehler> {
        use vodozemac::Curve25519PublicKey;
        let gegenstelle = Curve25519PublicKey::from_base64(gegenstelle_curve25519)
            .map_err(|_| KryptoFehler::SchluesselUnlesbar)?;
        let einmal = Curve25519PublicKey::from_base64(einmalschluessel)
            .map_err(|_| KryptoFehler::SchluesselUnlesbar)?;
        let session = self
            .account
            .create_outbound_session(
                vodozemac::olm::SessionConfig::version_2(),
                gegenstelle,
                einmal,
            )
            .map_err(|_| KryptoFehler::SitzungsaufbauFehlgeschlagen)?;
        Ok(crate::sitzung::Sitzung { session })
    }

    /// Baut die Sitzung auf, wenn die GEGENSTELLE zuerst geschrieben hat.
    /// Gibt die Sitzung und den Klartext der ersten Nachricht zurueck — der
    /// steckt bereits im Sitzungsaufbau und ginge sonst verloren.
    pub fn sitzung_eingehend(
        &mut self,
        absender_curve25519: &str,
        umschlag: &crate::umschlag::Umschlag,
    ) -> Result<(crate::sitzung::Sitzung, Vec<u8>), KryptoFehler> {
        use vodozemac::Curve25519PublicKey;
        use vodozemac::olm::OlmMessage;

        let absender = Curve25519PublicKey::from_base64(absender_curve25519)
            .map_err(|_| KryptoFehler::SchluesselUnlesbar)?;
        let OlmMessage::PreKey(vorschluessel) = umschlag.zu_olm()? else {
            return Err(KryptoFehler::FalscheUmschlagart);
        };
        let ergebnis = self
            .account
            .create_inbound_session(
                vodozemac::olm::SessionConfig::version_2(),
                absender,
                &vorschluessel,
            )
            .map_err(|_| KryptoFehler::SitzungsaufbauFehlgeschlagen)?;
        Ok((crate::sitzung::Sitzung { session: ergebnis.session }, ergebnis.plaintext))
    }
```

**Prüfen, nicht raten:** ob `SessionConfig::version_2()` so heisst, sagt
`rg "pub fn version" ~/.cargo/registry/src/*/vodozemac-0.10.0/src/olm/session_config.rs`.
Die neuere Fassung nehmen, nicht `version_1`.

- [ ] **Schritt 6: `src/lib.rs` erweitern**

```rust
pub mod sitzung;
pub mod umschlag;

pub use sitzung::Sitzung;
pub use umschlag::{Umschlag, Umschlagart};
```

- [ ] **Schritt 7: Tests laufen lassen**

```bash
cd krypto/pulse-krypto && cargo test
```
Erwartet: 7 grün (3 aus Task 1, 4 neu).

- [ ] **Schritt 8: Committen**

```bash
git add krypto/pulse-krypto/
git commit -m "feat(krypto): Gespraeche zu zweit ueber Olm-Sitzungen"
```

---

### Task 3: Gruppen (Megolm)

**Files:**
- Create: `krypto/pulse-krypto/src/gruppe.rs`
- Modify: `krypto/pulse-krypto/src/lib.rs`

**Interfaces:**
- Consumes: `KryptoFehler` aus Task 1
- Produces: `Gruppensitzung::neu()`, `Gruppensitzung::verteilschluessel(&self) -> String`, `Gruppensitzung::verschluesseln(&mut self, klartext: &[u8]) -> String`, `Gruppensitzung::nachrichtenzaehler(&self) -> u32`, `Gruppensitzung::einfrieren`, `Gruppensitzung::auftauen`
- Produces: `Gruppenempfang::aus_verteilschluessel(schluessel: &str) -> Result<Gruppenempfang, KryptoFehler>`, `Gruppenempfang::entschluesseln(&mut self, nachricht: &str) -> Result<Gruppennachricht, KryptoFehler>`, `Gruppennachricht { klartext: Vec<u8>, zaehler: u32 }`

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

In `krypto/pulse-krypto/src/gruppe.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wer_den_verteilschluessel_hat_liest_mit() {
        let mut senderin = Gruppensitzung::neu();
        let schluessel = senderin.verteilschluessel();
        let nachricht = senderin.verschluesseln(b"hallo Gruppe");

        let mut empfaenger =
            Gruppenempfang::aus_verteilschluessel(&schluessel).expect("empfang");
        let gelesen = empfaenger.entschluesseln(&nachricht).expect("entschluesseln");
        assert_eq!(gelesen.klartext, b"hallo Gruppe");
        assert_eq!(gelesen.zaehler, 0);
    }

    #[test]
    fn wer_spaeter_dazukommt_liest_das_alte_nicht() {
        // Genau die Zusicherung, auf der die Mitgliedschaftsregel der Spec
        // beruht: ein neues Mitglied bekommt den Schluessel ab SEINEM Stand.
        // Ohne diesen Test faellt ein Rueckschritt hier nicht auf.
        let mut senderin = Gruppensitzung::neu();
        let frueh = senderin.verschluesseln(b"vorher");

        let schluessel_danach = senderin.verteilschluessel();
        let spaet = senderin.verschluesseln(b"nachher");

        let mut neuling =
            Gruppenempfang::aus_verteilschluessel(&schluessel_danach).expect("empfang");
        assert!(neuling.entschluesseln(&frueh).is_err());
        assert_eq!(
            neuling.entschluesseln(&spaet).expect("entschluesseln").klartext,
            b"nachher"
        );
    }

    #[test]
    fn zaehler_steigt_und_erlaubt_wiedereinspiel_erkennung() {
        let mut senderin = Gruppensitzung::neu();
        let schluessel = senderin.verteilschluessel();
        let eins = senderin.verschluesseln(b"eins");
        let zwei = senderin.verschluesseln(b"zwei");

        let mut e = Gruppenempfang::aus_verteilschluessel(&schluessel).expect("empfang");
        assert_eq!(e.entschluesseln(&eins).expect("eins").zaehler, 0);
        assert_eq!(e.entschluesseln(&zwei).expect("zwei").zaehler, 1);
    }

    #[test]
    fn gruppensitzung_ueberlebt_das_einfrieren() {
        let mut senderin = Gruppensitzung::neu();
        let schluessel = senderin.verteilschluessel();
        let gefroren = senderin.einfrieren(&[3u8; 32]).expect("einfrieren");
        let mut wieder = Gruppensitzung::auftauen(&gefroren, &[3u8; 32]).expect("auftauen");

        let nachricht = wieder.verschluesseln(b"nach dem Neustart");
        let mut e = Gruppenempfang::aus_verteilschluessel(&schluessel).expect("empfang");
        assert_eq!(
            e.entschluesseln(&nachricht).expect("entschluesseln").klartext,
            b"nach dem Neustart"
        );
    }
}
```

**Zum zweiten Test:** falls `verteilschluessel()` in vodozemac immer den
Schluessel ab Index 0 liefert (statt ab dem aktuellen Stand), schlaegt er fehl
— dann ist `export_at(index)` auf der **Empfangs**seite der richtige Weg, und
die Spec-Aussage „wer dazukommt, sieht den Verlauf davor nicht" muss ueber
`InboundGroupSession::export_at(aktueller_index)` eingeloest werden. **Den Test
in diesem Fall nicht abschwaechen**, sondern die Umsetzung anpassen und im
Kommentar festhalten, welcher Weg die Zusicherung traegt.

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

```bash
cd krypto/pulse-krypto && cargo test
```
Erwartet: Übersetzungsfehler, `Gruppensitzung` existiert nicht.

- [ ] **Schritt 3: `src/gruppe.rs` schreiben**

```rust
//! Gruppen (Megolm).
//!
//! Megolm ersetzt Olm nicht, es sitzt darauf: die Nachricht wird EINMAL mit
//! dem Gruppenschluessel verschluesselt, und der Gruppenschluessel wird ueber
//! die 1:1-Sitzungen aus `sitzung.rs` an jedes Geraet verteilt. Ohne diesen
//! Aufbau waeren es bei 20 Mitgliedern mit je zwei Geraeten 40 Kopien PRO
//! Nachricht.
//!
//! Megolm hat schwaechere Vorwaertssicherheit als Olm: wer einen
//! Gruppenschluessel erbeutet, liest alles, was damit noch verschluesselt
//! wird. Deshalb wechselt ihn die Anwendungsschicht regelmaessig und bei
//! jeder Aenderung der Mitgliederliste — diese Kiste erzwingt das nicht, sie
//! ermoeglicht es nur.

use vodozemac::megolm::{
    GroupSession, GroupSessionPickle, InboundGroupSession, MegolmMessage, SessionConfig,
    SessionKey,
};

use crate::fehler::KryptoFehler;

/// Was beim Entschluesseln herauskommt.
pub struct Gruppennachricht {
    pub klartext: Vec<u8>,
    /// Laufende Nummer innerhalb der Sitzung. Die Anwendungsschicht erkennt
    /// daran ein Wiedereinspielen — dieselbe Nummer zweimal ist ein Angriff
    /// oder ein Fehler, nie normaler Betrieb.
    pub zaehler: u32,
}

/// Die Sendeseite: gehoert dem Absender, einer je Gruppe und Schluesselstand.
pub struct Gruppensitzung {
    session: GroupSession,
}

impl Gruppensitzung {
    pub fn neu() -> Self {
        Self { session: GroupSession::new(SessionConfig::version_1()) }
    }

    /// Der Schluessel, der ueber die 1:1-Sitzungen an die Mitglieder geht.
    /// Nie loggen, nie unverschluesselt uebertragen.
    pub fn verteilschluessel(&self) -> String {
        self.session.session_key().to_base64()
    }

    pub fn verschluesseln(&mut self, klartext: &[u8]) -> String {
        self.session.encrypt(klartext).to_base64()
    }

    pub fn nachrichtenzaehler(&self) -> u32 {
        self.session.message_index()
    }

    pub fn einfrieren(&self, schluessel: &[u8; 32]) -> Result<String, KryptoFehler> {
        Ok(self.session.pickle().encrypt(schluessel))
    }

    pub fn auftauen(gefroren: &str, schluessel: &[u8; 32]) -> Result<Self, KryptoFehler> {
        let pickle = GroupSessionPickle::from_encrypted(gefroren, schluessel)
            .map_err(|_| KryptoFehler::AuftauenFehlgeschlagen)?;
        Ok(Self { session: GroupSession::from_pickle(pickle) })
    }
}

/// Die Empfangsseite: eine je Gruppe und Absender-Schluesselstand.
pub struct Gruppenempfang {
    session: InboundGroupSession,
}

impl Gruppenempfang {
    pub fn aus_verteilschluessel(schluessel: &str) -> Result<Self, KryptoFehler> {
        let key = SessionKey::from_base64(schluessel)
            .map_err(|_| KryptoFehler::SchluesselUnlesbar)?;
        Ok(Self { session: InboundGroupSession::new(&key, SessionConfig::version_1()) })
    }

    pub fn entschluesseln(&mut self, nachricht: &str) -> Result<Gruppennachricht, KryptoFehler> {
        let msg = MegolmMessage::from_base64(nachricht)
            .map_err(|_| KryptoFehler::UmschlagUnlesbar)?;
        let entschluesselt = self
            .session
            .decrypt(&msg)
            .map_err(|_| KryptoFehler::EntschluesselnFehlgeschlagen)?;
        Ok(Gruppennachricht {
            klartext: entschluesselt.plaintext,
            zaehler: entschluesselt.message_index,
        })
    }
}
```

**Prüfen:** ob `SessionConfig::version_1()` in `megolm` so heisst —
`rg "pub fn version" ~/.cargo/registry/src/*/vodozemac-0.10.0/src/megolm/session_config.rs`.
Die aktuellste Fassung nehmen.

- [ ] **Schritt 4: `src/lib.rs` erweitern**

```rust
pub mod gruppe;

pub use gruppe::{Gruppenempfang, Gruppennachricht, Gruppensitzung};
```

- [ ] **Schritt 5: Tests laufen lassen**

```bash
cd krypto/pulse-krypto && cargo test
```
Erwartet: 11 grün.

- [ ] **Schritt 6: Committen**

```bash
git add krypto/pulse-krypto/
git commit -m "feat(krypto): Gruppen ueber Megolm-Sitzungen"
```

---

### Task 4: WASM-Ausgabe und Ansprache aus TypeScript

**Files:**
- Create: `krypto/pulse-krypto/src/wasm.rs`
- Create: `krypto/pulse-krypto/bauen-wasm.sh`
- Create: `web/test/krypto-wasm.test.ts`
- Modify: `krypto/pulse-krypto/src/lib.rs`, `Cargo.toml`

**Interfaces:**
- Consumes: alles aus Task 1 bis 3
- Produces: WASM-Paket unter `krypto/pulse-krypto/pkg/` mit den Klassen `Identitaet`, `Sitzung`, `Gruppensitzung`, `Gruppenempfang`

- [ ] **Schritt 1: `src/wasm.rs` schreiben**

Nur die Hülle — **keine Logik**. Alles, was gerechnet wird, steht in den
Modulen aus Task 1 bis 3 und ist dort bereits mit `cargo test` geprüft. Diese
Datei übersetzt nur zwischen JS-Typen und Rust-Typen.

```rust
//! wasm-bindgen-Huelle. Enthaelt KEINE Logik — nur Uebersetzung zwischen
//! JS-Typen und den Modulen dieser Kiste. Was hier stuende, waere von
//! `cargo test` nicht erreichbar.

#![cfg(target_arch = "wasm32")]

use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = Identitaet)]
pub struct JsIdentitaet {
    inner: crate::Identitaet,
}

#[wasm_bindgen(js_class = Identitaet)]
impl JsIdentitaet {
    #[wasm_bindgen(constructor)]
    pub fn neu() -> Self {
        Self { inner: crate::Identitaet::neu() }
    }

    #[wasm_bindgen(js_name = curve25519)]
    pub fn curve25519(&self) -> String {
        self.inner.schluessel().curve25519
    }

    #[wasm_bindgen(js_name = ed25519)]
    pub fn ed25519(&self) -> String {
        self.inner.schluessel().ed25519
    }

    #[wasm_bindgen(js_name = einmalschluesselErzeugen)]
    pub fn einmalschluessel_erzeugen(&mut self, anzahl: usize) -> Vec<String> {
        self.inner.einmalschluessel_erzeugen(anzahl)
    }

    #[wasm_bindgen(js_name = alsVeroeffentlichtMarkieren)]
    pub fn als_veroeffentlicht_markieren(&mut self) {
        self.inner.als_veroeffentlicht_markieren();
    }
}
```

Die übrigen Klassen nach demselben Muster. **`&[u8; 32]` geht nicht über die
WASM-Grenze** — die Einfrier-Methoden nehmen dort `Vec<u8>` entgegen und
prüfen die Länge, mit einem `KryptoFehler` bei Abweichung.

- [ ] **Schritt 2: `Cargo.toml` um `wasm-bindgen` ergänzen** (steht bereits in Task 1) und `lib.rs` um `pub mod wasm;` erweitern.

- [ ] **Schritt 3: Bau-Skript schreiben**

`krypto/pulse-krypto/bauen-wasm.sh`:

```bash
#!/usr/bin/env bash
# Baut die WASM-Ausgabe fuer den Web-Klienten.
# wasm-pack liegt unter ~/.cargo/bin, das nicht in jedem PATH steht.
set -euo pipefail
cd "$(dirname "$0")"
PATH="$HOME/.cargo/bin:$PATH"
wasm-pack build --target web --out-dir pkg
```

Ausführbar machen (`chmod +x`).

- [ ] **Schritt 4: Bauen**

```bash
bash krypto/pulse-krypto/bauen-wasm.sh
```
Erwartet: `pkg/pulse_krypto.js` und `pkg/pulse_krypto_bg.wasm` entstehen.

- [ ] **Schritt 5: Node-Test schreiben**

`web/test/krypto-wasm.test.ts`. **Achtung auf die Node-Falle:** kein
erweitungsloser Laufzeit-Import. Das WASM-Paket wird mit vollem Pfad und
Endung geladen.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Der Bau muss vorher gelaufen sein (bauen-wasm.sh). Faehrt der Test ohne
// gebautes Paket, soll er das SAGEN und nicht still uebersprungen werden —
// ein nicht ausgefuehrter Test sieht in der Ausgabe aus wie ein gruener.
test('WASM: zwei Identitaeten reden miteinander', async () => {
  const pfad = new URL('../../krypto/pulse-krypto/pkg/pulse_krypto.js', import.meta.url);
  const modul = await import(pfad.href);
  await modul.default();

  const alice = new modul.Identitaet();
  const bob = new modul.Identitaet();
  const einmal = bob.einmalschluesselErzeugen(1);
  bob.alsVeroeffentlichtMarkieren();

  assert.equal(typeof alice.curve25519(), 'string');
  assert.equal(einmal.length, 1);
});
```

- [ ] **Schritt 6: Test laufen lassen**

```bash
cd web && pnpm test:unit
```
Erwartet: grün, und der neue Test taucht in der Ausgabe **namentlich** auf.
Erscheint er nicht, greift das Glob `web/test/*.test.ts` nicht — dann liegt
die Datei falsch.

- [ ] **Schritt 7: `pkg/` von Git ausschliessen**

Gebaute Artefakte gehoeren nicht ins Repo. `krypto/pulse-krypto/.gitignore`
mit `pkg/` und `target/`.

- [ ] **Schritt 8: Committen**

```bash
git add krypto/pulse-krypto/ web/test/krypto-wasm.test.ts
git commit -m "feat(krypto): WASM-Ausgabe und Ansprache aus TypeScript"
```

---

### Task 5: Android-Cross-Build (nur übersetzen)

**Vorbedingung:** Android-NDK. Ist keines eingerichtet, **diese Aufgabe
zurueckstellen und das sagen** — nicht heimlich ueberspringen.

- [ ] **Schritt 1: Ziele hinzufügen**

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi
```

- [ ] **Schritt 2: Übersetzen**

```bash
cd krypto/pulse-krypto && cargo build --target aarch64-linux-android
```
Erwartet: baut durch. **Ausfuehren ist nicht Teil dieser Aufgabe** — das
braucht ein Geraet.

- [ ] **Schritt 3: Committen** (nur falls Konfigurationsdateien entstanden sind)

---

## Selbstprüfung dieses Plans

**Spec-Abdeckung:** §2 (zwei Schlüssel je Gerät, Einmalschlüssel,
Fallback-Schlüssel) → Task 1. §2 (Sitzungen zu zweit, Einfrieren) → Task 2.
§9 (Megolm, Verteilschlüssel, Mitgliedschaftswechsel) → Task 3. §10 Etappe A
(WASM, Android) → Task 4 und 5.

**Nicht in dieser Etappe** und bewusst offen: das Schlüsselverzeichnis am
Server (Etappe B), das Postfach (Etappe D), die Kanalart für Gruppen
(Etappe G). Diese Kiste kennt kein Netzwerk und keine Datenbank.

**Bekannte Unsicherheiten**, an drei Stellen im Plan mit einer Prüfanweisung
versehen statt geraten: der Name der `SessionConfig`-Fassung (Olm und Megolm
getrennt), die öffentliche Base64-Hilfe in vodozemac, und ob
`session_key()` den Schlüssel ab Index 0 oder ab dem aktuellen Stand liefert.
Alle drei sind am Quelltext in einer Minute zu klären; **keine davon darf
durch Abschwächen eines Tests „gelöst" werden.**
