# Dependency Descriptor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Player erkennt fehlende Bilder an einer echten Bildnummer im Strom statt an einer gedeuteten Uhr, und die drei Verlust-Vermutungen fallen weg.

**Architecture:** Die WHIP-Sender der Sidecars hängen an jedes RTP-Paket den AV1-Dependency-Descriptor (RTP-Header-Erweiterung) mit einer laufenden Bildnummer, vergeben hinter dem Encoder. Der MediaMTX-Fork rahmt die Marke über seine Neuverpackung um. Der Player liest nur die drei Pflichtbyte, zählt sie bei vollständiger Einheit und fordert bei einer Lücke ein Vollbild an.

**Tech Stack:** Rust (`webrtc` 0.17, `bytes`), Go (MediaMTX 1.19.1, `pion/webrtc` v4.2.15, `pion/rtp` v1.10.2), AV1-RTP-Spezifikation Anhang A.8.

**Spec:** `docs/superpowers/specs/2026-08-21-dependency-descriptor-design.md`

## Global Constraints

- **Sprache im Code**: deutsche Bezeichner und Kommentare, wie im Umfeld (`bildluecke.rs`, `zeitbasis.rs`). Echte Umlaute in Commit-Nachrichten und Changelog, `ss` statt `ß` in Quelldateien (bestehende Praxis).
- **Keine Emojis** — nirgends, auch nicht in Commit-Nachrichten.
- **Code-Größen-Policy**: Quelldatei ≤ 350 Zeilen (hart 500). `bildmarke.rs` bleibt darunter.
- **Keine neuen Abhängigkeiten.** Alles Nötige ist da: `webrtc::rtp::header::Header::{set_extension, get_extension}`, `MediaEngine::register_header_extension`.
- **Nicht in den vendorierten webrtc-Zweig** (`streaming/pulse-player/vendor/webrtc-rs/`). Der bleibt bei 24 Zeilen Abweichung gegen v0.17.2.
- **Zwillings-Dateien sind wortgleich** — geprüft durch Test, nicht durch Kommentar.
- **extmap-URI, wörtlich**: `https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension`
- **Kein `git push`** ohne Freigabe. Zweig `feat/dependency-descriptor` besteht bereits und trägt den Entwurf.
- **Vor jedem Commit**: `cargo test` der betroffenen Kiste. Vor dem Landen zusätzlich das volle Gate (`scripts/ship.sh` erzwingt es).

### Bauen auf der Linux-Maschine

```bash
# Player und Linux-Sidecar bauen lokal:
export FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared
cd streaming/pulse-player && cargo test
cd streaming/linux-hq-sidecar && cargo test

# Windows-Sidecar baut hier NICHT (kein ffmpeg-dist, kein vendored windows-capture).
# Pruefbar ist die Kiste einzeln:
cd streaming/win-hq-sidecar && cargo test --lib whip::bildmarke
```

### Abnahmekriterium (aus dem Entwurf §11)

Derselbe Aufbau, mit dem der Fehler gemessen wurde (Windows/AMD → Linux/NVIDIA), `PULSE_PLAYER_ERHOLUNG_LOG=1`:

| | heute | Abnahme |
|---|---|---|
| Vollbild-Abstand, saubere Leitung | 0,6 bis 12 s | wieder 60 s |
| Anforderungen je Sekunde | ~0,5 | null |
| bei echtem Verlust | Anforderung sofort | Anforderung sofort |

---

## Abweichung vom Entwurf, die hier festgelegt wird

Der Entwurf sagt „Schablonen-Tabelle auf dem **ersten** Paket jedes Vollbilds". Dieser Plan schreibt sie auf **jedes** Paket eines Vollbilds.

**Grund:** MediaMTX schneidet die Pakete neu. Läge die Tabelle nur auf dem ersten, müsste der Patch erkennen, welches neue Paket das erste ist, und die Tabelle dorthin verschieben — Logik, die falsch sein kann. Liegt sie auf allen, kopiert der Patch die Bytes und korrigiert nur zwei Bits.

**Kosten:** 6 Byte zusätzlich je Vollbild-Paket. Ein Vollbild sind rund 90 Pakete, also ~540 Byte je Vollbild; bei 60 s Abstand nicht messbar. Auf Differenzbild-Paketen ändert sich nichts (3 Byte).

**Nebennutzen:** ein spät einsteigender Zuschauer hat die Tabelle mit dem ersten Vollbild-Paket, das er sieht, statt womöglich erst mit dem nächsten Vollbild.

---

## Die Bitfolge, ausgerechnet

Verbindlich ist Anhang A.8.2 der AV1-RTP-Spezifikation. Für unseren Fall (zwei Schablonen, ein Decode-Ziel, eine Kette, keine Schichten) ergibt sich:

**Pflichtfelder, immer, 3 Byte:**

```
Byte 0:  Bit 7    start_of_frame
         Bit 6    end_of_frame
         Bit 5-0  frame_dependency_template_id   (0 = Vollbild, 1 = Differenzbild)
Byte 1:  frame_number, hohe 8 Bit
Byte 2:  frame_number, niedrige 8 Bit
```

**Auf Vollbild-Paketen zusätzlich 6 Byte** (41 Bit Inhalt + 7 Bit Nullauffüllung):

```
Bit  0     template_dependency_structure_present_flag = 1
Bit  1     active_decode_targets_present_flag         = 0
Bit  2     custom_dtis_flag                           = 0
Bit  3     custom_fdiffs_flag                         = 0
Bit  4     custom_chains_flag                         = 0
Bit  5-10  template_id_offset  f(6)                   = 0
Bit 11-15  dt_cnt_minus_one    f(5)                   = 0      (ein Decode-Ziel)
Bit 16-17  next_layer_idc      f(2)                   = 0      (nach T0: gleiche Schicht)
Bit 18-19  next_layer_idc      f(2)                   = 3      (nach T1: Ende)
Bit 20-21  template_dti[T0][0] f(2)                   = 2      (switch — Einstiegspunkt)
Bit 22-23  template_dti[T1][0] f(2)                   = 3      (required)
Bit 24     fdiff_follows_flag  T0                     = 0      (Vollbild beruft sich auf nichts)
Bit 25     fdiff_follows_flag  T1                     = 1
Bit 26-29  fdiff_minus_one     f(4)                   = 0      (fdiff = 1)
Bit 30     fdiff_follows_flag  T1                     = 0
Bit 31     chain_cnt           ns(2)                  = 1      (ns(2) ist EIN Bit)
           decode_target_protected_by[0] ns(1)                 (NULL Bit — ns(1) schreibt nichts)
Bit 32-35  template_chain_fdiff[T0][0] f(4)           = 0
Bit 36-39  template_chain_fdiff[T1][0] f(4)           = 1
Bit 40     resolutions_present_flag f(1)              = 0
Bit 41-47  Nullauffuellung
```

**Daraus die Prüfvektoren** (werden in Task 1 als Test festgehalten):

| Fall | Bytes |
|---|---|
| Vollbild, einziges Paket (Anfang+Ende), Nummer 0 | `C0 00 00 80 00 3B 41 01 00` |
| Differenzbild, erstes Paket von mehreren, Nummer 0x1234 | `81 12 34` |
| Differenzbild, letztes Paket, Nummer 1 | `41 00 01` |
| Differenzbild, einziges Paket, Nummer 65535 | `C1 FF FF` |

Herleitung des ersten: `C0` = start 1, end 1, template 0. `00 00` = Nummer 0. Dann `10000` `000000` `00000` `00` `11` `10` `11` `0` `1` `0000` `0` `1` `0000` `0001` `0` + sieben Nullen = `80 00 3B 41 01 00`.

---

## File Structure

**Neu:**

| Datei | Verantwortung |
|---|---|
| `streaming/win-hq-sidecar/src/whip/bildmarke.rs` | Das Format: schreiben, lesen, Rundlauf-Test. Zwilling A. |
| `streaming/linux-hq-sidecar/src/whip/bildmarke.rs` | Zwilling B, wortgleich. |
| `streaming/pulse-player/src/bildmarke.rs` | Zwilling C, wortgleich. Der Player nutzt nur `lesen`. |
| `streaming/bildmarke-formen.json` | Prüfstein, vom Sender erzeugt, von allen drei Stationen geprüft. |
| `infra/mediamtx-fork/patches/0006-dependency-descriptor-durchreichen.patch` | Die Marke über die Neuverpackung tragen. |

**Geändert:**

| Datei | Änderung |
|---|---|
| `streaming/*/src/whip/sdp.rs` (beide, wortgleich) | Erweiterung anmelden |
| `streaming/*/src/whip/mod.rs` (beide) | Zähler, Marke anhängen, ausgehandelte ID merken |
| `streaming/*/src/whip/av1.rs` (beide) | `Nutzlast` trägt `vollbild` |
| `streaming/pulse-player/src/whep.rs` | Erweiterung anmelden, ID herausreichen |
| `streaming/pulse-player/src/session.rs` | Bildnummer lesen, urteilen, drei Auslöser abbauen |
| `streaming/pulse-player/tests/zwillinge.rs` | dritten Zwilling aufnehmen |
| `streaming/pulse-player/src/main.rs` | `mod bildmarke;` |
| `desktop/package.json` | Version 0.1.70 |
| `web/static/changelog.json` | Eintrag |

**Gelöscht:**

| Datei | |
|---|---|
| `streaming/pulse-player/src/bildluecke.rs` | 246 Zeilen, 7 Tests |

---

### Task 1: Das Format (`bildmarke.rs`)

**Files:**
- Create: `streaming/win-hq-sidecar/src/whip/bildmarke.rs`
- Modify: `streaming/win-hq-sidecar/src/whip/mod.rs` (nur `mod bildmarke;` ergänzen)

**Interfaces:**
- Produces:
  - `pub const EXTMAP_URI: &str`
  - `pub struct Bildmarke { pub anfang: bool, pub ende: bool, pub vollbild: bool, pub nummer: u16 }`
  - `pub fn schreiben(m: &Bildmarke) -> Vec<u8>` — 9 Byte bei `vollbild`, sonst 3
  - `pub fn nummer_lesen(daten: &[u8]) -> Option<u16>` — liest NUR die Pflichtfelder
  - `pub fn marke_lesen(daten: &[u8]) -> Option<Bildmarke>` — Pflichtfelder + ob die Tabelle anhängt
  - `pub fn anfang_ende_setzen(daten: &mut [u8], anfang: bool, ende: bool)` — für MediaMTX-nahe Prüfungen und den Rundlauf

- [ ] **Step 1: Die Datei anlegen, mit Kopf und Format**

```rust
//! Die Bildmarke: eine laufende Bildnummer im Strom, statt einer gedeuteten Uhr.
//!
//! ## Warum es das gibt
//!
//! Der RTP-Zeitstempel ist eine UHR. Er sagt, wann ein Bild aufgenommen wurde,
//! nicht das wievielte es ist. Eine Luecke in einer Uhr bedeutet zweierlei, und
//! die beiden sind an ihr nicht zu unterscheiden:
//!
//! ```text
//! Sender liess einen Bildplatz aus:   1500 3000 ---- 6000    Nummern 41 42 -- 43
//! ein Bild ging verloren:             1500 3000 ---- 6000    Nummern 41 42 43 44
//! ```
//!
//! Die Zeitstempel-Zeilen sind identisch, die Nummern-Zeilen nicht. Am
//! 2026-08-21 hat der Player deshalb ein halbes Vollbild je Sekunde angefordert,
//! obwohl nichts fehlte (`docs/superpowers/specs/2026-08-21-dependency-descriptor-design.md`).
//!
//! ## Was hier steht
//!
//! Der „Dependency Descriptor" aus Anhang A.8 der AV1-RTP-Spezifikation, in der
//! kleinsten Ausprägung, die fuer einen ungeschichteten Strom gueltig ist: zwei
//! Schablonen (Vollbild, Differenzbild), ein Decode-Ziel, eine Kette.
//!
//! **Diese Datei ist ein Zwilling** — wortgleich in beiden Sidecars und im
//! Player. Die Wortgleichheit haelt `streaming/pulse-player/tests/zwillinge.rs`
//! fest, nicht dieser Kommentar.
//!
//! **Der Schreiber ist vollstaendig, der Leser nicht.** Zum Urteilen genuegen
//! die drei Pflichtbyte; die Schablonen-Tabelle wird geschrieben, weil das
//! Format sie verlangt und libwebrtc sie auswertet, aber von uns nie gelesen.
//!
//! ## Wo die Nummer entsteht
//!
//! Im Paketierer, also HINTER dem Encoder. Verschluckt der Encoder ein Bild,
//! entsteht kein Paket und keine Nummer wird verbraucht — die Folge bleibt
//! lueckenlos, und das ist richtig: es gibt nichts zu reparieren.

/// Der URI, unter dem die Erweiterung im SDP ausgehandelt wird.
pub const EXTMAP_URI: &str =
    "https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension";

/// Schablone 0: Vollbild. Beruft sich auf nichts, beginnt die Kette.
const SCHABLONE_VOLLBILD: u8 = 0;
/// Schablone 1: Differenzbild. Beruft sich auf das vorige Bild.
const SCHABLONE_DIFFERENZ: u8 = 1;

/// Laenge der Pflichtfelder. Ein Descriptor dieser Laenge hat per
/// Spezifikation KEINE erweiterten Felder (`sz > 3` entscheidet das).
pub const PFLICHT_BYTE: usize = 3;
/// Laenge mit angehaengter Schablonen-Tabelle: 24 Pflicht- + 41 Struktur-Bit,
/// auf 72 Bit aufgefuellt.
pub const MIT_TABELLE_BYTE: usize = 9;

/// Was an einem Paket steht.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bildmarke {
    /// Erstes Paket dieses Bildes.
    pub anfang: bool,
    /// Letztes Paket dieses Bildes.
    pub ende: bool,
    /// Vollbild — bestimmt die Schablone UND ob die Tabelle mitgeschrieben wird.
    pub vollbild: bool,
    /// Laufende Nummer des Bildes. Laeuft bei 65536 um.
    pub nummer: u16,
}
```

- [ ] **Step 2: Den Bit-Schreiber und `schreiben` ergänzen**

```rust
/// Schreibt Bits von hoher zu niedriger Ordnung, wie `f(n)` der Spezifikation.
#[derive(Default)]
struct BitSchreiber {
    aus: Vec<u8>,
    /// Wie viele Bit im letzten Byte schon belegt sind (0..8).
    belegt: u8,
}

impl BitSchreiber {
    fn f(&mut self, breite: u8, wert: u32) {
        for i in (0..breite).rev() {
            if self.belegt == 0 {
                self.aus.push(0);
                self.belegt = 8;
            }
            self.belegt -= 1;
            let bit = ((wert >> i) & 1) as u8;
            let letzter = self.aus.len() - 1;
            self.aus[letzter] |= bit << self.belegt;
        }
    }

    /// Auf volle Byte mit Nullen auffuellen.
    fn abschliessen(self) -> Vec<u8> {
        self.aus
    }
}

/// Die Marke als Bytefolge.
///
/// Bei `vollbild` haengt die Schablonen-Tabelle an — auf JEDEM Paket des
/// Vollbilds, nicht nur auf dem ersten. Grund: MediaMTX schneidet die Pakete
/// neu; laege die Tabelle nur auf dem ersten, muesste der Fork erkennen,
/// welches neue Paket das erste ist, und sie dorthin verschieben. So kopiert er
/// die Bytes und korrigiert zwei Bit. Kostet rund 540 Byte je Vollbild.
pub fn schreiben(m: &Bildmarke) -> Vec<u8> {
    let mut b = BitSchreiber::default();
    let schablone = if m.vollbild { SCHABLONE_VOLLBILD } else { SCHABLONE_DIFFERENZ };
    b.f(1, u32::from(m.anfang));
    b.f(1, u32::from(m.ende));
    b.f(6, u32::from(schablone));
    b.f(16, u32::from(m.nummer));
    if !m.vollbild {
        return b.abschliessen();
    }
    // Erweiterte Felder: nur die Tabelle, sonst nichts.
    b.f(1, 1); // template_dependency_structure_present_flag
    b.f(1, 0); // active_decode_targets_present_flag
    b.f(1, 0); // custom_dtis_flag
    b.f(1, 0); // custom_fdiffs_flag
    b.f(1, 0); // custom_chains_flag
    b.f(6, 0); // template_id_offset
    b.f(5, 0); // dt_cnt_minus_one — ein Decode-Ziel
    // template_layers(): zwei Schablonen in derselben Schicht, dann Schluss.
    b.f(2, 0); // next_layer_idc nach T0: gleiche Schicht
    b.f(2, 3); // next_layer_idc nach T1: Ende
    // template_dtis(): T0 ist ein Einstiegspunkt (switch), T1 erforderlich.
    b.f(2, 2);
    b.f(2, 3);
    // template_fdiffs(): T0 beruft sich auf nichts, T1 auf das vorige Bild.
    b.f(1, 0); // T0: kein fdiff
    b.f(1, 1); // T1: ein fdiff folgt
    b.f(4, 0); // fdiff_minus_one = 0, also fdiff = 1
    b.f(1, 0); // T1: kein weiterer
    // template_chains(): eine Kette.
    // chain_cnt = ns(DtCnt + 1) = ns(2); write_ns(2, 1) schreibt EIN Bit.
    b.f(1, 1);
    // decode_target_protected_by[0] = ns(chain_cnt) = ns(1) — schreibt NICHTS.
    b.f(4, 0); // template_chain_fdiff[T0][0] — Vollbild beginnt die Kette
    b.f(4, 1); // template_chain_fdiff[T1][0] — ein Bild zurueck
    b.f(1, 0); // resolutions_present_flag
    b.abschliessen()
}
```

- [ ] **Step 3: Die Prüfvektoren als Test schreiben (muss zuerst fehlschlagen)**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// **Der Prueffall, der das Format festnagelt.** Von Hand aus Anhang A.8.2
    /// ausgerechnet, nicht aus dem Schreiber abgelesen — sonst prueft er nur,
    /// dass der Schreiber tut, was er tut.
    #[test]
    fn vollbild_mit_tabelle_hat_die_ausgerechnete_bytefolge() {
        let m = Bildmarke { anfang: true, ende: true, vollbild: true, nummer: 0 };
        assert_eq!(
            schreiben(&m),
            vec![0xC0, 0x00, 0x00, 0x80, 0x00, 0x3B, 0x41, 0x01, 0x00],
            "Pflichtfelder C0 00 00, dann die 41 Struktur-Bit auf 6 Byte aufgefuellt"
        );
    }

    #[test]
    fn differenzbild_ist_drei_byte() {
        let m = Bildmarke { anfang: true, ende: false, vollbild: false, nummer: 0x1234 };
        assert_eq!(schreiben(&m), vec![0x81, 0x12, 0x34]);

        let m = Bildmarke { anfang: false, ende: true, vollbild: false, nummer: 1 };
        assert_eq!(schreiben(&m), vec![0x41, 0x00, 0x01]);

        let m = Bildmarke { anfang: true, ende: true, vollbild: false, nummer: u16::MAX };
        assert_eq!(schreiben(&m), vec![0xC1, 0xFF, 0xFF]);
    }

    #[test]
    fn laengen_stimmen_mit_den_konstanten() {
        let d = Bildmarke { anfang: true, ende: true, vollbild: false, nummer: 7 };
        assert_eq!(schreiben(&d).len(), PFLICHT_BYTE);
        let v = Bildmarke { vollbild: true, ..d };
        assert_eq!(schreiben(&v).len(), MIT_TABELLE_BYTE);
    }
}
```

- [ ] **Step 4: Test laufen lassen, Fehlschlag bestätigen**

```bash
cd streaming/win-hq-sidecar && cargo test --lib whip::bildmarke 2>&1 | tail -20
```
Erwartet: FAIL — `schreiben` existiert noch nicht oder liefert eine andere Folge.

- [ ] **Step 5: Schreiber fertigstellen, bis die Vektoren stimmen**

Falls die Folge abweicht: die Abweichung Bit für Bit gegen die Tabelle im Plan halten. Der häufigste Fehler ist `ns(2)`— es ist **ein** Bit, nicht zwei, und `ns(1)` schreibt **nichts**.

- [ ] **Step 6: Leser ergänzen**

```rust
/// Nur die Bildnummer — mehr braucht das Urteil nicht.
///
/// Bewusst ohne die Tabelle: sie wird geschrieben, weil das Format sie
/// verlangt und libwebrtc sie braucht, aber die Nummer steht in den
/// Pflichtfeldern und ist ohne jede Vorkenntnis lesbar. Ein Zuschauer, der
/// zwischen zwei Vollbildern einsteigt, kann deshalb sofort zaehlen.
pub fn nummer_lesen(daten: &[u8]) -> Option<u16> {
    if daten.len() < PFLICHT_BYTE {
        return None;
    }
    Some(u16::from(daten[1]) << 8 | u16::from(daten[2]))
}

/// Die ganze Marke, soweit sie ohne die Tabelle bestimmbar ist.
///
/// `vollbild` wird an der Schablonen-Nummer erkannt, nicht an der Laenge: ein
/// Sender darf die Tabelle auch weglassen, die Schablone bleibt dieselbe.
pub fn marke_lesen(daten: &[u8]) -> Option<Bildmarke> {
    if daten.len() < PFLICHT_BYTE {
        return None;
    }
    Some(Bildmarke {
        anfang: daten[0] & 0b1000_0000 != 0,
        ende: daten[0] & 0b0100_0000 != 0,
        vollbild: daten[0] & 0b0011_1111 == SCHABLONE_VOLLBILD,
        nummer: u16::from(daten[1]) << 8 | u16::from(daten[2]),
    })
}

/// Bildanfang und Bildende neu setzen, ohne den Rest anzufassen.
///
/// Fuer jeden, der die Pakete neu schneidet — allen voran MediaMTX. Die
/// uebrigen Felder beschreiben das BILD und bleiben, diese zwei beschreiben
/// das PAKET und muessen mitwandern.
pub fn anfang_ende_setzen(daten: &mut [u8], anfang: bool, ende: bool) {
    if daten.is_empty() {
        return;
    }
    daten[0] = (daten[0] & 0b0011_1111) | (u8::from(anfang) << 7) | (u8::from(ende) << 6);
}
```

- [ ] **Step 7: Rundlauf und die drei Fallen testen**

```rust
    #[test]
    fn rundlauf_ueber_alle_kombinationen() {
        for vollbild in [false, true] {
            for anfang in [false, true] {
                for ende in [false, true] {
                    for nummer in [0u16, 1, 0x1234, u16::MAX] {
                        let m = Bildmarke { anfang, ende, vollbild, nummer };
                        let roh = schreiben(&m);
                        assert_eq!(marke_lesen(&roh), Some(m), "Rundlauf {m:?}");
                        assert_eq!(nummer_lesen(&roh), Some(nummer));
                    }
                }
            }
        }
    }

    /// Zu kurz ist kein Descriptor. Ohne diese Pruefung liest `nummer_lesen`
    /// ueber das Ende hinaus und der Player urteilt auf Zufallszahlen.
    #[test]
    fn zu_kurz_ergibt_nichts() {
        assert_eq!(nummer_lesen(&[]), None);
        assert_eq!(nummer_lesen(&[0xC0, 0x00]), None);
        assert_eq!(marke_lesen(&[0xC0, 0x00]), None);
    }

    /// Anfang und Ende sind PAKET-Eigenschaften und muessen sich aendern
    /// lassen, ohne Nummer oder Schablone zu beruehren — genau das tut
    /// MediaMTX beim Neuschneiden.
    #[test]
    fn anfang_ende_setzen_laesst_den_rest_in_ruhe() {
        let m = Bildmarke { anfang: true, ende: true, vollbild: true, nummer: 4711 };
        let mut roh = schreiben(&m);
        anfang_ende_setzen(&mut roh, false, false);
        let gelesen = marke_lesen(&roh).expect("lesbar");
        assert!(!gelesen.anfang && !gelesen.ende);
        assert_eq!(gelesen.nummer, 4711, "die Nummer bleibt");
        assert!(gelesen.vollbild, "die Schablone bleibt");
        assert_eq!(roh.len(), MIT_TABELLE_BYTE, "die Tabelle bleibt");
    }
```

- [ ] **Step 8: Tests laufen lassen**

```bash
cd streaming/win-hq-sidecar && cargo test --lib whip::bildmarke 2>&1 | tail -20
```
Erwartet: PASS, alle sechs Tests.

- [ ] **Step 9: Commit**

```bash
git add streaming/win-hq-sidecar/src/whip/bildmarke.rs streaming/win-hq-sidecar/src/whip/mod.rs
git commit -m "feat(streaming): Bildmarke — das Format der laufenden Bildnummer"
```

---

### Task 2: Der Prüfstein (`streaming/bildmarke-formen.json`)

**Files:**
- Create: `streaming/bildmarke-formen.json`
- Modify: `streaming/win-hq-sidecar/src/whip/bildmarke.rs` (Test, der ihn prüft)

**Interfaces:**
- Consumes: `schreiben`, `Bildmarke` aus Task 1
- Produces: die Datei `streaming/bildmarke-formen.json` mit dem Feld `formen: [{name, anfang, ende, vollbild, nummer, bytes}]`, `bytes` als Grossbuchstaben-Hex ohne Trenner

**Warum:** Am 2026-08-17 rutschte ein Formatfehler durch beide Testnetze, weil jede Seite ihre Fälle aus derselben Vorstellung aufschrieb, aus der sie die Prüfung schrieb. Der Prüfstein kommt deshalb vom **Sender** und wird von Player und MediaMTX gegengeprüft.

**Die Datei wird nicht von Hand geschrieben.** Sie entsteht in Step 2 aus dem Schreiber und wird danach nur noch geprüft — eine von Hand gepflegte Vorlage wäre eine zweite Quelle, die auseinanderlaufen kann.

- [ ] **Step 1: Den erzeugenden Test schreiben**

```rust
    /// **Der Pruefstein.** Er kommt vom Sender und wird von Player und
    /// MediaMTX-Patch gegengeprueft (Muster `streaming/zeigerbild-formen.json`).
    ///
    /// Schlaegt er fehl, weil sich das Format absichtlich geaendert hat:
    /// `PULSE_PRUEFSTEIN_SCHREIBEN=1 cargo test bildmarke_pruefstein` schreibt
    /// die Datei neu. Ohne die Umgebungsvariable schreibt er NIE — sonst
    /// bestaetigte er jede Aenderung von selbst.
    #[test]
    fn bildmarke_pruefstein() {
        let faelle = [
            ("vollbild-einziges-paket", true, true, true, 0u16),
            ("differenz-erstes-paket", true, false, false, 4660),
            ("differenz-letztes-paket", false, true, false, 1),
            ("differenz-umlauf", true, true, false, u16::MAX),
            ("vollbild-mittleres-paket", false, false, true, u16::MAX),
        ];
        let mut zeilen = Vec::new();
        for (name, anfang, ende, vollbild, nummer) in faelle {
            let roh = schreiben(&Bildmarke { anfang, ende, vollbild, nummer });
            let hex: String = roh.iter().map(|b| format!("{b:02X}")).collect();
            zeilen.push(format!(
                "    {{ \"name\": \"{name}\", \"anfang\": {anfang}, \"ende\": {ende}, \
                 \"vollbild\": {vollbild}, \"nummer\": {nummer}, \"bytes\": \"{hex}\" }}"
            ));
        }
        let inhalt = format!(
            "{{\n  \"_kommentar\": \"Pruefstein fuer die Bildmarke (Dependency \
             Descriptor). ERZEUGT VOM SENDER durch `bildmarke_pruefstein` in \
             win-hq-sidecar. Player und MediaMTX-Patch pruefen dagegen. Neu \
             schreiben: PULSE_PRUEFSTEIN_SCHREIBEN=1 cargo test \
             bildmarke_pruefstein\",\n  \"formen\": [\n{}\n  ]\n}}\n",
            zeilen.join(",\n")
        );
        let pfad = concat!(env!("CARGO_MANIFEST_DIR"), "/../bildmarke-formen.json");
        if std::env::var("PULSE_PRUEFSTEIN_SCHREIBEN").as_deref() == Ok("1") {
            std::fs::write(pfad, &inhalt).expect("Pruefstein schreiben");
            return;
        }
        let vorhanden = std::fs::read_to_string(pfad).expect("Pruefstein lesen");
        assert_eq!(
            vorhanden, inhalt,
            "Der Pruefstein weicht ab. Absichtlich? \
             PULSE_PRUEFSTEIN_SCHREIBEN=1 cargo test bildmarke_pruefstein"
        );
    }
```

- [ ] **Step 2: Pruefstein erzeugen und pruefen**

```bash
cd streaming/win-hq-sidecar
PULSE_PRUEFSTEIN_SCHREIBEN=1 cargo test --lib whip::bildmarke::tests::bildmarke_pruefstein
cargo test --lib whip::bildmarke 2>&1 | tail -10
```
Erwartet: der zweite Lauf PASS ohne Umgebungsvariable.

- [ ] **Step 3: Gegenprobe — der Pruefstein muss auch fehlschlagen koennen**

```bash
cd streaming/win-hq-sidecar
sed -i 's/"C1FFFF"/"C1FFF0"/' ../bildmarke-formen.json
cargo test --lib whip::bildmarke::tests::bildmarke_pruefstein 2>&1 | tail -5   # muss FAIL sein
git checkout ../bildmarke-formen.json
```
Erwartet: FAIL, dann wiederhergestellt. Ein Prüfstein, der nie fehlschlägt, prüft nichts.

- [ ] **Step 4: Commit**

```bash
git add streaming/bildmarke-formen.json streaming/win-hq-sidecar/src/whip/bildmarke.rs
git commit -m "test(streaming): Pruefstein fuer die Bildmarke, erzeugt vom Sender"
```

---

### Task 3: Die Zwillinge

**Files:**
- Create: `streaming/linux-hq-sidecar/src/whip/bildmarke.rs` (Kopie)
- Create: `streaming/pulse-player/src/bildmarke.rs` (Kopie)
- Modify: `streaming/linux-hq-sidecar/src/whip/mod.rs`, `streaming/pulse-player/src/main.rs` (`mod`-Zeilen)
- Modify: `streaming/pulse-player/tests/zwillinge.rs`

**Interfaces:**
- Consumes: die Datei aus Task 1 und 2
- Produces: dieselben Namen in allen drei Kisten

- [ ] **Step 1: Kopieren**

```bash
cd ~/Dokumente/pulse
cp streaming/win-hq-sidecar/src/whip/bildmarke.rs streaming/linux-hq-sidecar/src/whip/bildmarke.rs
cp streaming/win-hq-sidecar/src/whip/bildmarke.rs streaming/pulse-player/src/bildmarke.rs
```

- [ ] **Step 2: `mod`-Zeilen ergänzen**

In `streaming/linux-hq-sidecar/src/whip/mod.rs` neben die bestehenden `mod`-Zeilen: `mod bildmarke;`
In `streaming/pulse-player/src/main.rs` neben `mod bildluecke;`: `mod bildmarke;`

Der Pfad zum Prüfstein steht als `concat!(env!("CARGO_MANIFEST_DIR"), "/../bildmarke-formen.json")` und stimmt damit in allen drei Kisten — alle drei liegen direkt unter `streaming/`.

- [ ] **Step 3: Den Zwillings-Test erweitern**

Bestehende Datei `streaming/pulse-player/tests/zwillinge.rs` — nach dem Muster des vorhandenen `zeigerbild`-Tests ergänzen:

```rust
/// Die Bildmarke steht wortgleich in drei Kisten. Ein Kommentar haelt das nicht
/// — beim aelteren Paar `zeitbasis.rs` lagen am 2026-08-17 drei Kommentarzeilen
/// unbemerkt auseinander.
#[test]
fn bildmarke_ist_in_allen_drei_kisten_wortgleich() {
    let player = include_str!("../src/bildmarke.rs");
    let windows = include_str!("../../win-hq-sidecar/src/whip/bildmarke.rs");
    let linux = include_str!("../../linux-hq-sidecar/src/whip/bildmarke.rs");
    assert_eq!(player, windows, "Player und Windows-Sidecar sind auseinandergelaufen");
    assert_eq!(player, linux, "Player und Linux-Sidecar sind auseinandergelaufen");
}
```

- [ ] **Step 4: Tests in allen drei Kisten**

```bash
export FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared
cd streaming/pulse-player && cargo test zwillinge && cargo test bildmarke
cd ../linux-hq-sidecar && cargo test bildmarke
cd ../win-hq-sidecar && cargo test --lib whip::bildmarke
```
Erwartet: überall PASS.

- [ ] **Step 5: Gegenprobe**

```bash
echo "// stoerung" >> streaming/pulse-player/src/bildmarke.rs
cd streaming/pulse-player && cargo test zwillinge 2>&1 | tail -5   # muss FAIL sein
cd ../.. && git checkout streaming/pulse-player/src/bildmarke.rs
```

- [ ] **Step 6: Commit**

```bash
git add streaming/linux-hq-sidecar/src streaming/pulse-player/src streaming/pulse-player/tests
git commit -m "feat(streaming): Bildmarke als Zwilling in beide Sidecars und den Player"
```

---

### Task 4: Sender — die Erweiterung aushandeln

**Files:**
- Modify: `streaming/win-hq-sidecar/src/whip/sdp.rs` und `streaming/linux-hq-sidecar/src/whip/sdp.rs` (wortgleich halten)
- Modify: `streaming/win-hq-sidecar/src/whip/mod.rs` und `streaming/linux-hq-sidecar/src/whip/mod.rs`

**Interfaces:**
- Consumes: `bildmarke::EXTMAP_URI`
- Produces: `pub(super) fn register_header_extensions(media: &mut MediaEngine) -> Result<()>` in `sdp.rs`; ein Feld `marken_id: AtomicU8` (0 = nicht ausgehandelt) am Sender

- [ ] **Step 1: Anmelden in `sdp.rs`**

Direkt nach `register_codecs` einfügen:

```rust
/// Die Bildmarke im Angebot anbieten.
///
/// Nur fuer Video: eine Bildnummer auf einer Tonspur ergaebe keinen Sinn, und
/// jede angebotene Erweiterung kostet Aushandlung.
///
/// **Geschrieben wird nur, was die Antwort annimmt** (RFC 8285). Die
/// ausgehandelte Nummer holt `whip/mod.rs` nach dem Verbindungsaufbau aus den
/// Sender-Parametern; kommt sie nicht vor, bleibt die Marke weg. Das ist
/// zugleich der Rueckfall gegen einen Server ohne Patch 0006.
pub(super) fn register_header_extensions(media: &mut MediaEngine) -> Result<()> {
    media
        .register_header_extension(
            RTCRtpHeaderExtensionCapability { uri: super::bildmarke::EXTMAP_URI.to_owned() },
            RTPCodecType::Video,
            None,
        )
        .context("Bildmarke als Header-Erweiterung anmelden")
}
```

Import ergänzen: `use webrtc::rtp_transceiver::RTCRtpHeaderExtensionCapability;`

- [ ] **Step 2: In `baue_api` aufrufen**

In `sdp.rs::baue_api`, unmittelbar nach dem Aufruf von `register_codecs`, `register_header_extensions(&mut media)?;` ergänzen.

- [ ] **Step 3: Die ausgehandelte Nummer merken**

In `whip/mod.rs`, im Sender-Struct ein Feld ergänzen:

```rust
    /// Die ausgehandelte Nummer der Bildmarke, 0 = nicht ausgehandelt.
    ///
    /// Steht als Atomar da, weil sie erst NACH dem Verbindungsaufbau feststeht,
    /// `send` aber nur `&self` hat. Null als „gibt es nicht" ist zulaessig:
    /// RFC 8285 vergibt die Nummern ab 1.
    marken_id: std::sync::atomic::AtomicU8,
```

Nach dem Setzen der Remote-Description (dort, wo die Antwort verarbeitet wird):

```rust
        // Die Nummer, unter der die Bildmarke ausgehandelt wurde. Kennt der
        // Server die Erweiterung nicht, taucht sie hier nicht auf und wir
        // schreiben sie nicht — dann urteilt der Zuschauer wie vor dem
        // 2026-08-21, naemlich gar nicht.
        let id = sender
            .get_parameters()
            .await
            .header_extensions
            .iter()
            .find(|e| e.uri == bildmarke::EXTMAP_URI)
            .map_or(0, |e| e.id as u8);
        self_.marken_id.store(id, Ordering::Relaxed);
        eprintln!(
            "[whip] Bildmarke {}",
            if id == 0 { "nicht ausgehandelt — Zuschauer zaehlt nicht".into() }
            else { format!("ausgehandelt als extmap {id}") }
        );
```

- [ ] **Step 4: Bauen**

```bash
cd streaming/linux-hq-sidecar && FFMPEG_DIR=$PWD/../../ffmpeg-dist/n8.1-lgpl-shared cargo build 2>&1 | tail -20
cd ../win-hq-sidecar && cargo check --target x86_64-pc-windows-msvc 2>&1 | tail -20
```
Erwartet: beide ohne Fehler.

- [ ] **Step 5: Wortgleichheit von `sdp.rs` prüfen**

```bash
diff streaming/win-hq-sidecar/src/whip/sdp.rs streaming/linux-hq-sidecar/src/whip/sdp.rs && echo "wortgleich"
```
Erwartet: `wortgleich`. Die Datei war es vor der Änderung und muss es bleiben.

- [ ] **Step 6: Commit**

```bash
git add streaming/win-hq-sidecar/src/whip streaming/linux-hq-sidecar/src/whip
git commit -m "feat(streaming): Bildmarke im WHIP-Angebot aushandeln"
```

---

### Task 5: Sender — Zähler und Marke anhängen

**Files:**
- Modify: `streaming/*/src/whip/av1.rs` (beide) — `Nutzlast` trägt `vollbild`
- Modify: `streaming/*/src/whip/mod.rs` (beide) — Zähler, `set_extension`, H.264-Erkennung

**Interfaces:**
- Consumes: `bildmarke::{Bildmarke, schreiben}`, `marken_id` aus Task 4
- Produces: `av1::Nutzlast { daten, letztes, vollbild }`; `av1::SpurZustand::naechste_bildnummer() -> u16`

- [ ] **Step 1: `Nutzlast` erweitern (`av1.rs`, beide Zwillinge)**

```rust
/// Die fertige Nutzlast eines RTP-Pakets samt Markierung.
pub struct Nutzlast {
    pub daten: Vec<u8>,
    /// Letztes Paket des Zeitabschnitts — setzt das Marker-Bit (Abschnitt 4.2).
    pub letztes: bool,
    /// Erstes Paket des Zeitabschnitts — Bildanfang der Bildmarke.
    pub erstes: bool,
    /// Gehoert zu einem Vollbild. Je Bild gleich, steht an jedem Paket, weil
    /// die Bildmarke es an jedem Paket braucht.
    pub vollbild: bool,
}
```

In `paketiere` das `vollbild` einmal bestimmen (`obus.iter().any(ist_vollbild)`) und bei jeder erzeugten `Nutzlast` mitgeben; `erstes` ist der Index 0.

- [ ] **Step 2: Zähler in `SpurZustand`**

```rust
    /// Laufende Bildnummer fuer die Bildmarke. Laeuft bei 65536 um.
    bildnummer: u16,
```

```rust
    /// Die Nummer DIESES Bildes; danach steht der Zaehler auf dem naechsten.
    ///
    /// Wird nur aufgerufen, wenn wirklich Pakete hinausgehen. Verschluckt der
    /// Encoder ein Bild oder haelt der Paketierer einen Sequenzkopf ohne
    /// Vollbild zurueck, verbraucht das KEINE Nummer — und genau daran
    /// erkennt der Zuschauer, dass nichts verlorenging.
    pub(super) fn naechste_bildnummer(&mut self) -> u16 {
        let n = self.bildnummer;
        self.bildnummer = self.bildnummer.wrapping_add(1);
        n
    }
```

Test dazu, in `av1.rs`:

```rust
    #[test]
    fn bildnummer_laeuft_um_und_ueberspringt_nichts() {
        let mut z = SpurZustand::neu(60);
        z.bildnummer = u16::MAX - 1;
        assert_eq!(z.naechste_bildnummer(), u16::MAX - 1);
        assert_eq!(z.naechste_bildnummer(), u16::MAX);
        assert_eq!(z.naechste_bildnummer(), 0, "der Umlauf ist ein normaler Schritt");
        assert_eq!(z.naechste_bildnummer(), 1);
    }
```

- [ ] **Step 3: H.264-Vollbilderkennung (`mod.rs`, beide)**

```rust
/// Traegt dieser H.264-Zeitabschnitt ein Vollbild (IDR)?
///
/// Der Payloader von webrtc-rs sagt es nicht, und die Bildmarke braucht es fuer
/// die Schablone. Gesucht wird ueber die Annex-B-Startcodes, weil der Encoder
/// in diesem Format liefert — dasselbe, was `H264Payloader` erwartet.
fn h264_ist_vollbild(daten: &[u8]) -> bool {
    let mut i = 0;
    while i + 3 < daten.len() {
        let kurz = daten[i] == 0 && daten[i + 1] == 0 && daten[i + 2] == 1;
        let lang = daten[i] == 0 && daten[i + 1] == 0 && daten[i + 2] == 0 && daten[i + 3] == 1;
        if kurz || lang {
            let kopf = i + if lang { 4 } else { 3 };
            if kopf < daten.len() && daten[kopf] & 0x1F == 5 {
                return true;
            }
            i = kopf;
        } else {
            i += 1;
        }
    }
    false
}
```

```rust
    #[test]
    fn h264_idr_wird_erkannt() {
        // Startcode, NAL-Typ 5 (IDR)
        assert!(h264_ist_vollbild(&[0, 0, 0, 1, 0x65, 0xAA]));
        // Startcode, NAL-Typ 1 (Differenzbild)
        assert!(!h264_ist_vollbild(&[0, 0, 0, 1, 0x41, 0xAA]));
        // SPS (7) und PPS (8) vor einem IDR
        assert!(h264_ist_vollbild(&[0, 0, 1, 0x67, 0, 0, 1, 0x68, 0, 0, 1, 0x65]));
        assert!(!h264_ist_vollbild(&[]));
    }
```

- [ ] **Step 4: Die Marke im Paketbau anhängen (`mod.rs::send`, beide)**

```rust
        let pakete: Vec<Packet> = {
            let mut g = zustand.lock().expect("Spur-Zustand vergiftet");
            let (z, paketierer) = &mut *g;
            let ts = z.zeitstempel(pts);
            let marken_id = self.marken_id.load(Ordering::Relaxed);
            // Erst paketieren, dann nummerieren: geht nichts hinaus, wird auch
            // keine Nummer verbraucht.
            let teile: Vec<(Bytes, bool, bool, bool)> = match paketierer {
                Paketierer::Av1 => av1::paketiere(data, av1::MTU)?
                    .into_iter()
                    .map(|p| (Bytes::from(p.daten), p.erstes, p.letztes, p.vollbild))
                    .collect(),
                Paketierer::H264(p) => {
                    let vollbild = h264_ist_vollbild(data);
                    let teile = p
                        .payload(av1::MTU, &Bytes::copy_from_slice(data))
                        .context("H.264 paketieren")?;
                    let n = teile.len();
                    teile
                        .into_iter()
                        .enumerate()
                        .map(|(i, b)| (b, i == 0, i + 1 == n, vollbild))
                        .collect()
                }
            };
            if teile.is_empty() {
                return Ok(());
            }
            let nummer = z.naechste_bildnummer();
            teile
                .into_iter()
                .map(|(daten, erstes, letztes, vollbild)| {
                    let mut header = Header {
                        version: 2,
                        marker: letztes,
                        sequence_number: z.naechste_seq(),
                        timestamp: ts,
                        ..Default::default()
                    };
                    if marken_id != 0 {
                        let marke = bildmarke::Bildmarke {
                            anfang: erstes,
                            ende: letztes,
                            vollbild,
                            nummer,
                        };
                        // Fehler hier waere ein Programmierfehler (ungueltige
                        // Nummer), kein Betriebsfall — aber ein Stream ohne
                        // Marke ist besser als kein Stream.
                        let _ = header
                            .set_extension(marken_id, Bytes::from(bildmarke::schreiben(&marke)));
                    }
                    Packet { header, payload: daten }
                })
                .collect()
        };
```

- [ ] **Step 5: Bauen und testen**

```bash
export FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared
cd streaming/linux-hq-sidecar && cargo test 2>&1 | tail -15
cd ../win-hq-sidecar && cargo test --lib 2>&1 | tail -15
diff <(sed -n '/pub struct Nutzlast/,/^}/p' ../win-hq-sidecar/src/whip/av1.rs) \
     <(sed -n '/pub struct Nutzlast/,/^}/p' ../linux-hq-sidecar/src/whip/av1.rs) && echo "av1 Nutzlast gleich"
```
Erwartet: Tests grün, `Nutzlast` in beiden gleich.

- [ ] **Step 6: Commit**

```bash
git add streaming/win-hq-sidecar/src streaming/linux-hq-sidecar/src
git commit -m "feat(streaming): Bildnummer hinter dem Encoder vergeben und an jedes Paket haengen"
```

---

### Task 6: MediaMTX-Patch 0006

**Files:**
- Create: `infra/mediamtx-fork/patches/0006-bildmarke-durchreichen.patch`
- Modify: `infra/mediamtx-fork/Dockerfile` (Patch aufnehmen), `infra/mediamtx-fork/README.md` (Tabelle)

**Interfaces:**
- Consumes: das Format aus Task 1, den Prüfstein aus Task 2
- Produces: MediaMTX trägt die Marke über die Neuverpackung; hinter `PULSE_DEPENDENCY_DESCRIPTOR=1`

- [ ] **Step 1: Arbeitskopie herstellen**

```bash
cd /tmp/claude-1000/*/scratchpad
git clone --depth=1 -b v1.19.1 https://github.com/bluenviron/mediamtx.git mtx-patch
cd mtx-patch && git checkout -b bildmarke
```

- [ ] **Step 2: Die Marke lesen und wieder anheften**

Neue Datei `internal/protocols/webrtc/bildmarke.go`:

```go
package webrtc

import (
	"encoding/hex"
	"os"

	"github.com/pion/rtp"
)

// bildmarkeURI ist der Aushandlungs-URI der Bildmarke (Dependency Descriptor).
// Wortgleich mit EXTMAP_URI in streaming/*/src/whip/bildmarke.rs.
const bildmarkeURI = "https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension"

// bildmarkeAktiv sagt, ob der Patch eingeschaltet ist. Aus per Vorgabe, wie
// alle Pulse-Patches: ein unkonfiguriertes Deployment verhaelt sich wie
// Upstream.
func bildmarkeAktiv() bool {
	return os.Getenv("PULSE_DEPENDENCY_DESCRIPTOR") == "1"
}

// bildmarkeLesen holt die rohe Marke vom ersten eingehenden Paket eines Bildes.
// Nil heisst: der Publisher markiert nicht, es ist nichts zu tragen.
func bildmarkeLesen(pkts []*rtp.Packet, id uint8) []byte {
	if id == 0 || len(pkts) == 0 {
		return nil
	}
	roh := pkts[0].GetExtension(id)
	if len(roh) < 3 {
		return nil
	}
	aus := make([]byte, len(roh))
	copy(aus, roh)
	return aus
}

// bildmarkeSetzen haengt die Marke an ein neu geschnittenes Paket.
//
// Nummer und Schablone beschreiben das BILD und bleiben unveraendert; Bildanfang
// und Bildende beschreiben das PAKET und werden neu gesetzt, weil MediaMTX die
// Pakete neu schneidet. Genau das ist der ganze Patch.
func bildmarkeSetzen(pkt *rtp.Packet, roh []byte, id uint8, anfang, ende bool) {
	if len(roh) < 3 || id == 0 {
		return
	}
	aus := make([]byte, len(roh))
	copy(aus, roh)
	aus[0] = aus[0] & 0b0011_1111
	if anfang {
		aus[0] |= 1 << 7
	}
	if ende {
		aus[0] |= 1 << 6
	}
	pkt.SetExtension(id, aus) //nolint:errcheck
}

// bildmarkeHex ist nur fuer den Test gegen den Pruefstein da.
func bildmarkeHex(b []byte) string { return hex.EncodeToString(b) }
```

- [ ] **Step 3: In `from_stream.go` einhängen**

Im AV1-Zweig (und gleichlautend im H.264-Zweig), nach `encoder.Encode(...)`:

```go
				marke := []byte(nil)
				if bildmarkeAktiv() {
					marke = bildmarkeLesen(u.RTPPackets, markenID)
				}
				for i, pkt := range packets {
					ntp := u.NTP.Add(timestampToDuration(int64(pkt.Timestamp), 90000))
					pkt.Timestamp += u.RTPPackets[0].Timestamp
					if marke != nil {
						bildmarkeSetzen(pkt, marke, markenID, i == 0, i == len(packets)-1)
					}
					track.WriteRTPWithNTP(pkt, ntp) //nolint:errcheck
				}
```

`markenID` kommt aus den ausgehandelten Sender-Parametern; sie wird beim Aufbau des Tracks einmal bestimmt (analog zu `senderHeaderExtensionID` in `peer_connection_test.go`) und mit dem Track geführt.

- [ ] **Step 4: Erweiterung registrieren**

In `peer_connection.go`, wo die MediaEngine gebaut wird, für Video anmelden — nur wenn `bildmarkeAktiv()`.

- [ ] **Step 5: Der Prüfstein-Test in Go**

Neue Datei `internal/protocols/webrtc/bildmarke_test.go`:

```go
func TestBildmarkeGegenPruefstein(t *testing.T) {
	// Der Pruefstein kommt vom Sender (streaming/bildmarke-formen.json).
	// Er wird beim Bauen des Images danebengelegt.
	roh, err := os.ReadFile("testdata/bildmarke-formen.json")
	require.NoError(t, err)
	var stein struct {
		Formen []struct {
			Name    string `json:"name"`
			Anfang  bool   `json:"anfang"`
			Ende    bool   `json:"ende"`
			Bytes   string `json:"bytes"`
		} `json:"formen"`
	}
	require.NoError(t, json.Unmarshal(roh, &stein))

	for _, f := range stein.Formen {
		t.Run(f.Name, func(t *testing.T) {
			erwartet, err := hex.DecodeString(f.Bytes)
			require.NoError(t, err)
			// Aus derselben Marke mit VERTAUSCHTEN Paketgrenzen muss durch
			// bildmarkeSetzen wieder genau die Vorlage entstehen.
			verdreht := make([]byte, len(erwartet))
			copy(verdreht, erwartet)
			verdreht[0] ^= 0b1100_0000
			pkt := &rtp.Packet{}
			bildmarkeSetzen(pkt, verdreht, 5, f.Anfang, f.Ende)
			require.Equal(t, erwartet, []byte(pkt.GetExtension(5)))
		})
	}
}
```

- [ ] **Step 6: Patch erzeugen und im Dockerfile eintragen**

```bash
cd /tmp/claude-1000/*/scratchpad/mtx-patch
git add -A && git commit -m "bildmarke"
git format-patch -1 --stdout > ~/Dokumente/pulse/infra/mediamtx-fork/patches/0006-bildmarke-durchreichen.patch
```

Im `Dockerfile` die `0006`-Zeile neben die bestehenden Patch-Anwendungen setzen und den Prüfstein nach `internal/protocols/webrtc/testdata/` kopieren. In `README.md` die Patch-Tabelle um eine Zeile ergänzen.

- [ ] **Step 7: Image bauen**

```bash
cd ~/Dokumente/pulse/infra/mediamtx-fork
docker build -t pulse-mediamtx:1.19.1-pulse5 . 2>&1 | tail -25
```
Erwartet: Bau ohne Fehler, Go-Tests im Bau grün.

- [ ] **Step 8: Commit**

```bash
git add infra/mediamtx-fork
git commit -m "feat(mediamtx): Bildmarke ueber die Neuverpackung tragen (Patch 0006)"
```

---

### Task 7: Player — lesen und urteilen

**Files:**
- Modify: `streaming/pulse-player/src/whep.rs`
- Modify: `streaming/pulse-player/src/session.rs`
- Modify: `streaming/pulse-player/src/bildmarke.rs` (Zähler ergänzen — und in die Zwillinge spiegeln)

**Interfaces:**
- Consumes: `bildmarke::{EXTMAP_URI, nummer_lesen}`
- Produces: `bildmarke::Bildzaehler` mit `pruefen(&mut self, nummer: u16) -> Option<u16>`; `WhepSession::marken_id() -> u8`

- [ ] **Step 1: Den Zähler in `bildmarke.rs` ergänzen (Test zuerst)**

```rust
    #[test]
    fn zaehler_meldet_nur_echte_luecken() {
        let mut z = Bildzaehler::neu();
        assert_eq!(z.pruefen(41), None, "das erste Bild ist nie eine Luecke");
        assert_eq!(z.pruefen(42), None, "lueckenlos");
        assert_eq!(z.pruefen(44), Some(1), "die 43 fehlt");
        assert_eq!(z.pruefen(45), None);
    }

    /// **Der Fall, um dessentwillen es das Ganze gibt.** Der Sender laesst
    /// einen Bildplatz aus: die Zeit springt, die Nummer nicht.
    #[test]
    fn ausgelassener_bildplatz_ist_keine_luecke() {
        let mut z = Bildzaehler::neu();
        z.pruefen(7);
        assert_eq!(z.pruefen(8), None);
    }

    #[test]
    fn umlauf_ist_ein_normaler_schritt() {
        let mut z = Bildzaehler::neu();
        z.pruefen(u16::MAX - 1);
        assert_eq!(z.pruefen(u16::MAX), None);
        assert_eq!(z.pruefen(0), None, "65535 -> 0 ist ein Schritt");
        assert_eq!(z.pruefen(1), None);
    }

    /// Eine Wiederholung (dasselbe Paket zweimal) und eine Umordnung duerfen
    /// weder melden noch den Zaehler zurueckstellen — sonst meldete das
    /// naechste regulaere Bild eine Luecke, die es nicht gibt.
    #[test]
    fn wiederholung_und_umordnung_stellen_nichts_zurueck() {
        let mut z = Bildzaehler::neu();
        z.pruefen(100);
        assert_eq!(z.pruefen(100), None, "Wiederholung");
        assert_eq!(z.pruefen(99), None, "Umordnung");
        assert_eq!(z.pruefen(101), None, "der Zaehler steht noch auf 100");
    }
```

```rust
/// Zaehlt die Bildnummern und meldet Luecken.
#[derive(Default)]
pub struct Bildzaehler {
    letzte: Option<u16>,
}

impl Bildzaehler {
    pub fn neu() -> Self {
        Self::default()
    }

    /// Rueckgabe: wie viele Bilder fehlen, oder `None`, wenn nichts fehlt.
    ///
    /// **Rueckwaerts heisst Umordnung, nicht Ausfall.** Nach dem Jitter-Puffer
    /// sollte das nicht vorkommen; kommt es doch, darf der Zaehler NICHT
    /// zurueckgestellt werden, sonst meldet das naechste regulaere Bild eine
    /// erfundene Luecke.
    pub fn pruefen(&mut self, nummer: u16) -> Option<u16> {
        let Some(vorher) = self.letzte else {
            self.letzte = Some(nummer);
            return None;
        };
        let schritt = nummer.wrapping_sub(vorher);
        // 0 = Wiederholung, >= 0x8000 = rueckwaerts. Beides beruehrt den
        // Zaehler nicht.
        if schritt == 0 || schritt >= 0x8000 {
            return None;
        }
        self.letzte = Some(nummer);
        (schritt > 1).then(|| schritt - 1)
    }
}
```

Danach in beide Sidecars spiegeln (`cp`), damit der Zwillings-Test grün bleibt.

- [ ] **Step 2: Tests**

```bash
export FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared
cd streaming/pulse-player && cargo test bildmarke && cargo test zwillinge
```
Erwartet: PASS.

- [ ] **Step 3: Erweiterung im Player anmelden (`whep.rs`)**

In der Funktion, die die `MediaEngine` baut (bei `register_default_codecs`, Zeile ~480):

```rust
    // Die Bildmarke aushandeln. Kommt sie in der Antwort nicht vor, urteilt der
    // Player gar nicht — „Marke oder nichts" (Entwurf §3).
    media.register_header_extension(
        RTCRtpHeaderExtensionCapability { uri: crate::bildmarke::EXTMAP_URI.to_owned() },
        RTPCodecType::Video,
        None,
    )?;
```

Und die ausgehandelte Nummer nach dem Aufbau herausreichen:

```rust
    /// Die ausgehandelte Nummer der Bildmarke; 0 = nicht ausgehandelt.
    pub fn marken_id(&self) -> u8 {
        self.marken_id.load(std::sync::atomic::Ordering::Relaxed)
    }
```

Gefüllt beim `on_track`, aus `receiver.get_parameters().await.header_extensions`, gleiche Suche wie im Sender.

Zusätzlich in die bestehende Rückkanal-Zeile aufnehmen, damit ein Blick ins Log genügt:

```rust
    eprintln!(
        "pulse-player: Rueckkanal — nack {} / pli {} / rtx {} / bildmarke {}",
        ...,
        if marken_id != 0 { "ja" } else { "NEIN" }
    );
```

- [ ] **Step 4: In `session.rs` lesen und urteilen**

Den Zähler neben den bisherigen Zustand stellen (dort, wo heute `bildluecken` steht):

```rust
    // Die Bildnummer aus dem Strom — die einzige Angabe, die „verloren" von
    // „nie erzeugt" trennt (`crate::bildmarke`). Ohne ausgehandelte Marke bleibt
    // sie leer und es wird NICHT geurteilt.
    let marken_id = whep_session.marken_id();
    let mut bildzaehler = crate::bildmarke::Bildzaehler::neu();
    let mut bild_luecken: u64 = 0;
```

Im `Release::Packet`-Zweig die Nummer mit herausreichen (vierter Rückgabewert):

```rust
                    Release::Packet(p, arrived) => {
                        let marker = p.header.marker;
                        let ts = p.header.timestamp;
                        // Die Bildnummer DIESES Pakets. Alle Pakete eines
                        // Bildes tragen dieselbe; gezaehlt wird sie erst, wenn
                        // die Einheit VOLLSTAENDIG ist — ein Bild, von dem nur
                        // ein Teil ankam, hat seine Nummer sonst schon gezeigt,
                        // waehrend der Zusammensetzer es wegwirft.
                        let nummer = (marken_id != 0)
                            .then(|| p.header.get_extension(marken_id))
                            .flatten()
                            .and_then(|roh| crate::bildmarke::nummer_lesen(&roh));
                        if let Some(d) = dumps.get(codec).and_then(Option::as_ref) {
                            d.write(&p.payload, marker);
                        }
                        (
                            assembler.push(p.header.sequence_number, &p.payload, marker),
                            Some(arrived),
                            Some(ts),
                            nummer,
                        )
                    }
```

Und den Urteilsblock, der den bisherigen `bildluecken`-Block ersetzt:

```rust
                // Fehlt ein Bild? Die Nummer sagt es, statt sie aus der Uhr zu
                // erraten. Ein ausgelassener Bildplatz verbraucht keine Nummer
                // und meldet deshalb nichts — das war der Fehler vom
                // 2026-08-21 (`docs/superpowers/specs/2026-08-21-dependency-descriptor-design.md`).
                if codec.is_video() && unit.is_some() {
                    if let Some(nummer) = unit_bildnummer {
                        if let Some(fehlend) = bildzaehler.pruefen(nummer) {
                            bild_luecken += 1;
                            if erholung_log {
                                eprintln!(
                                    "pulse-player: Bildluecke (#{bild_luecken}) — {fehlend} \
                                     Bild(er) fehlen vor Nummer {nummer}, Vollbild angefordert"
                                );
                            }
                            if let Some(f) = decoder.as_ref() {
                                f.zustand().schaden.store(true, Relaxed);
                            }
                            if let Some(ssrc) = video_ssrc.filter(|_| !ohne_anforderung) {
                                if last_keyframe_request.elapsed() >= KEYFRAME_REQUEST_INTERVAL {
                                    last_keyframe_request = Instant::now();
                                    whep_session.request_keyframe(ssrc).await;
                                }
                            }
                        }
                    }
                }
```

- [ ] **Step 5: Bauen und testen**

```bash
export FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared
cd streaming/pulse-player && cargo test 2>&1 | tail -15
```
Erwartet: PASS (die `bildluecke`-Tests laufen noch mit, sie fallen erst in Task 8).

- [ ] **Step 6: Commit**

```bash
git add streaming/pulse-player/src streaming/win-hq-sidecar/src streaming/linux-hq-sidecar/src
git commit -m "feat(player): auf der Bildnummer urteilen statt auf dem Zeitstempel"
```

---

### Task 8: Player — die Vermutungen abbauen

**Files:**
- Delete: `streaming/pulse-player/src/bildluecke.rs`
- Modify: `streaming/pulse-player/src/main.rs`, `streaming/pulse-player/src/session.rs`

- [ ] **Step 1: Auslöser 2 und 3 entfernen**

Aus `session.rs` streichen: den gesamten `bildluecken`-Block (heute Zeile 698 ff., in Task 7 bereits ersetzt), sowie den Zeugen-Auslöser bei `verworfen_abholen()` — dort bleibt das Setzen von `schaden` und der Diagnose-Ausdruck, es fällt nur die Vollbild-Anforderung samt Bremsen-Abfrage.

Begründung, die als Kommentar dorthin gehört:

```rust
                    // KEINE Anforderung mehr von hier: dieses Bild hat seine
                    // Nummer nie vollstaendig gezeigt, also meldet der
                    // Bildzaehler die Luecke ohnehin — mit der besseren
                    // Angabe, WELCHES Bild fehlt. Der Schadensmerker bleibt,
                    // er stellt die Einfrier-Wacht scharf.
```

- [ ] **Step 2: Auslöser 1 entschärfen**

Im `Release::Gap`-Zweig (heute Zeile 626 ff.) bleibt `f.luecke()` — **Absturzschutz**, `libnvcuvid` stuerzt an einem Differenzbild ohne Referenz ab. Es fällt nur der `request_keyframe`-Aufruf. Kommentar:

```rust
                            // `f.luecke()` bleibt: das ist Absturzschutz, nicht
                            // Erkennung — `av1_cuvid` stuerzt an einem
                            // Differenzbild ohne Referenz ab (2026-07-28
                            // gemessen). Die Anforderung faellt weg: der
                            // Decoder steht danach auf „wartet auf Einstieg"
                            // und der Einstieg-Pfad fordert binnen 500 ms
                            // nach — und der Bildzaehler sofort, falls
                            // wirklich ein Bild fehlt.
```

- [ ] **Step 3: `bildluecke.rs` löschen**

```bash
git rm streaming/pulse-player/src/bildluecke.rs
```
Und `mod bildluecke;` aus `main.rs` streichen sowie die verbliebenen Verweise (`ts_spruenge`, `video_clock_rate`, wenn sonst ungenutzt).

- [ ] **Step 4: Bauen und testen**

```bash
export FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared
cd streaming/pulse-player && cargo test 2>&1 | tail -15
cargo clippy --all-targets 2>&1 | grep -E "^(warning|error)" | head -20
```
Erwartet: Tests grün, keine „unused"-Warnungen von den entfernten Variablen.

- [ ] **Step 5: Zählen, was weg ist**

```bash
git diff --stat HEAD~2 -- streaming/pulse-player/
```
Erwartet: `bildluecke.rs` mit 246 gelöschten Zeilen in der Statistik.

- [ ] **Step 6: Commit**

```bash
git add -A streaming/pulse-player
git commit -m "refactor(player): die drei Verlust-Vermutungen abbauen"
```

---

### Task 9: Ausliefern

**Files:**
- Modify: `desktop/package.json` (Version)
- Modify: `web/static/changelog.json`
- Modify: `docs/superpowers/specs/2026-08-21-dependency-descriptor-design.md` (Abweichung aus diesem Plan nachtragen)
- Merge: Zweig `build/player-ffmpeg-lokal`

- [ ] **Step 1: Den wartenden Zweig hereinholen**

```bash
git merge --no-ff build/player-ffmpeg-lokal
# Konflikt gegen das Player-README aufloesen: beide Aussagen behalten,
# die neuere Fassung des Bau-Abschnitts gewinnt.
```

`CLAUDE.md` bestimmt, dass dieser Zweig bei der nächsten echten Player-Änderung mitfährt — das ist sie.

- [ ] **Step 2: Version bumpen**

`desktop/package.json`: `"version": "0.1.70"`.

**Pflicht, nicht Kosmetik**: `streaming/pulse-player/**` und `win-hq-sidecar/**` sind beide geändert, und electron-updater ignoriert eine gleiche Version stillschweigend — Bestandsclients bekämen den Fix nie.

- [ ] **Step 3: Changelog-Eintrag**

Oben in `entries` von `web/static/changelog.json`, Stil sachlich, echte Umlaute, keine Emojis:

```json
{
  "id": "2026-08-21.2",
  "date": "2026-08-21",
  "style": "sachlich",
  "title": "Ruhigeres Bild beim Zuschauen",
  "intro": "Der Player hat bisher manchmal ein neues Vollbild angefordert, obwohl gar nichts fehlte. Das kostete Bildschaerfe, ohne etwas zu verbessern.",
  "items": [
    "Der Stream traegt jetzt eine laufende Bildnummer. Damit erkennt der Player sicher, ob wirklich ein Bild fehlt, statt es aus den Zeitabstaenden zu schaetzen.",
    "Bei ruhigem Bildinhalt bleibt die Uebertragung ruhig; die Bandbreite geht in Bildschaerfe statt in ueberfluessige Vollbilder.",
    "Geht wirklich etwas verloren, wird es genauso schnell repariert wie bisher."
  ]
}
```

- [ ] **Step 4: Den Entwurf nachziehen**

In `docs/superpowers/specs/2026-08-21-dependency-descriptor-design.md` §5 und §7 die Festlegung „Tabelle auf **jedem** Paket eines Vollbilds" eintragen und die Byte-Zahl von „rund zehn" auf „neun" berichtigen.

- [ ] **Step 5: Volles Test-Gate**

```bash
cd ~/Dokumente/pulse
export FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud uv run --all-packages pytest -q 2>&1 | tail -5
cd web && pnpm check && pnpm build && pnpm test:unit
cd ../desktop && pnpm test:unit
cd ../streaming/pulse-player && cargo test
cd ../linux-hq-sidecar && cargo test
cd ../win-hq-sidecar && cargo test --lib
```
Erwartet: alles grün. **Nicht neben einem schweren Build laufen lassen** — ein WS-Test hängt dann bis ins Zeitlimit (`CLAUDE.md`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(desktop): Version 0.1.70 — die Bildmarke muss Bestandsclients erreichen"
```

- [ ] **Step 7: Abnahme an der echten Leitung**

MediaMTX-Image zuerst auf den Dev-Stack, dann:

```bash
# Auf der sendenden Windows-Maschine: neuen Stand starten.
# Auf der Linux-Maschine, mit PULSE_PLAYER_ERHOLUNG_LOG=1 (steht bereits):
tail -f ~/.var/app/com.howispulse.Pulse/config/Pulse/sidecar.log | grep -E "Bildluecke|Vollbild #|Rueckkanal"
```

Erwartet:
- `Rueckkanal — ... / bildmarke ja`
- **null** `Bildluecke`-Zeilen bei sauberer Leitung
- `Vollbild #N empfangen, Abstand ~60000 ms`

Zusätzlich Chromium als Schiedsrichter: denselben Strom im Browser-Fenster öffnen, `chrome://webrtc-internals`, `googleFramesReceived` und die Descriptor-Auswertung prüfen.

- [ ] **Step 8: Landen — NUR auf Freigabe**

```bash
bash scripts/ship.sh
```
Merge nach `main` ist ein Prod-Deploy. Vorher fragen.

---

## Self-Review

**Spec-Abdeckung:**

| Entwurf | Task |
|---|---|
| §4 Nummer hinter dem Encoder | 5 |
| §5 Drahtformat | 1 |
| §6 Sidecars (sdp, av1, Zwillinge) | 3, 4, 5 |
| §7 MediaMTX Patch 0006 | 6 |
| §8 Player liest, urteilt auf vollständiger Einheit | 7 |
| §9 Was wegfällt | 8 |
| §10 Fehlerfälle | 1 (zu kurz), 4 (nicht ausgehandelt), 7 (Umlauf, Umordnung) |
| §11 Prüfen (4 Ebenen) | 1 (Rundlauf), 2 (Prüfstein), 3 (Zwillinge), 9 (Chromium + Leitung) |
| §12 Ausrollen | 9 |

**Lücke gefunden und geschlossen:** Der Entwurf nennt H.264 nicht ausdrücklich, aber unser WHIP-Sender trägt beide Codecs — ohne Marke bekämen H.264-Zuschauer nach „Marke oder nichts" gar keine Erkennung mehr. Task 5 Step 3 deckt es ab.

**Typen-Abgleich:** `Bildmarke{anfang,ende,vollbild,nummer}` · `schreiben` · `nummer_lesen` · `marke_lesen` · `anfang_ende_setzen` · `Bildzaehler::{neu,pruefen}` · `av1::Nutzlast{daten,letztes,erstes,vollbild}` · `SpurZustand::naechste_bildnummer` · `marken_id` — durchgängig gleich in Tasks 1, 3, 5, 7.

**Reihenfolge:** Task 6 (Server) muss vor der Auslieferung von 5+7 draussen sein, sonst handelt niemand die Erweiterung aus. Innerhalb des Zweigs ist die Reihenfolge egal; beim Ausrollen nicht (Task 9 Step 7).
