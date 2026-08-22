# Etappe 3: `pulse-whip` — der Sendeweg, dreimal im Repo

> **Für agentische Bearbeiter:** ERFORDERLICHE UNTER-SKILL: `superpowers:subagent-driven-development` (empfohlen) oder `superpowers:executing-plans`. Die Schritte tragen Checkbox-Syntax (`- [ ]`).

**Ziel:** Die beiden Dateien des WHIP-Sendewegs, die in allen drei Sidecars gleich sind, in eine gemeinsame Kiste ziehen. **2.366 überzählige Zeilen** entfallen — der grösste Einzelposten des ganzen Vorhabens.

**Aufbau:** Wie Etappen 1 und 2: geteilte Crate per Pfad-Abhängigkeit, **kein Cargo-Workspace**, die alten Dateien werden Re-Exports, **keine Aufrufstelle wird angefasst**.

**Technik:** Rust. Anders als `pulse-redact` und `pulse-zeitbasis` hat diese Crate Abhängigkeiten: `webrtc = "0.17"` und `anyhow = "1"`.

**Entwurf:** `docs/specs/2026-08-20-gemeinsame-bausteine-design.md` — Etappe 3.

**Zweig:** `feat/gemeinsame-bausteine` (Etappen 1 und 2 liegen dort bereits)

## Globale Randbedingungen

- **Nie direkt auf `main`.** Landen nur über GitHub-PR via `bash scripts/ship.sh`. Merge = Prod-Deploy, braucht Freigabe.
- **Kein `git push`, keine GitHub-CLI ohne Freigabe.**
- **Der Windows- und der Linux-Sidecar bauen auf diesem Mac NICHT**, Flatpak ebenso wenig. Du änderst sie, kannst sie aber nicht übersetzen. Prüf durch Lesen und sag im Bericht ausdrücklich, was ungeprüft bleibt.
- **Keine neuen Abhängigkeiten.** `webrtc = "0.17"` und `anyhow = "1"` stehen bereits in allen drei Sidecars — es kommt nichts hinzu.
- **Niemals Stream-Keys oder Tokens loggen.**
- **Sprache:** Rust-Doc-Kommentare ASCII (`ae`/`oe`/`ue`/`ss`). **Commit-Messages mit ECHTEN Umlauten** (ä/ö/ü/ß). **Keine Emojis.**
- **Kein Changelog-Eintrag** — reiner Umbau ohne sichtbare Verhaltensänderung.
- Quelldateien ≤ 350 Zeilen (hart 500), ausgenommen Tests. **`av1.rs` (791 Z.) und `sdp.rs` (392 Z.) überschreiten das bereits — vorbestehend, nicht Gegenstand dieser Etappe.** Sie werden verschoben, nicht umgebaut.
- **Tests gegen die volle erwartete Zahl**, nicht gegen „ist ungleich null". Einen Erwartungswert nie blind aus dem Ist-Ergebnis übernehmen.
- **Alle Befehle im Vordergrund**, kein `run_in_background`.

## Ausgangslage, selbst gemessen am 2026-08-20

| Datei | win | linux | mac | Zustand |
|---|---|---|---|---|
| `sdp.rs` | 392 | 392 | 392 | **dreimal bitgleich** |
| `av1.rs` | 791 | 791 | 791 | linux ≡ mac bitgleich; win weicht in 8 Zeilen ab |
| `pacer.rs` | 232 | 246 | 249 | win substanziell anders — **bleibt draussen** |
| `mod.rs` | 597 | 507 | 509 | plattformeigen — **bleibt** |

**Die 8 Zeilen in `av1.rs` sind derselbe Doc-Kommentarblock an anderer Stelle** (vier Zeilen verschoben), kein inhaltlicher Unterschied. Nachgeprüft mit `diff`.

### Warum `pacer.rs` NICHT mitkommt

Das ist keine vergessene Doppelung, sondern eine bewusste. Der Linux-Pacer sagt es selbst:

> **Die Windows-Schwester weicht bewusst ab** (`win-hq-sidecar/src/whip/pacer.rs`, dort 2026-08-13 unabhängig nach denselben Lehren gebaut): gleiches Prinzip, anderer Zuschnitt […] Wer einen Pacer-Fehler behebt, sieht sich BEIDE an.

Beide wurden nach demselben gescheiterten ersten Versuch neu gebaut (relatives `sleep` je Paket, verfehlte sein Ziel um zwei Drittel), und beide zogen dieselben zwei Lehren — absolute Zeitpunkte statt relativer Schläfer, Gruppen statt Einzelpakete. Sie unterscheiden sich im Zuschnitt: Linux' Sendefenster **wächst mit der Paketzahl**, damit ein Zwei-Paket-Bild keine künstliche Latenz bekommt; Windows teilt Fenster und Gruppen anders auf.

Welcher Zuschnitt besser ist, **ist nicht gemessen** — die Gegenmessung über die echte Leitung steht laut beiden Modulköpfen noch aus. Eine Zusammenlegung wäre also eine inhaltliche Entscheidung unter Unwissen, getarnt als Aufräumarbeit. Sie gehört in ein eigenes Vorhaben mit Messungen auf beiden Plattformen.

**Der Hinweis „sieh dir BEIDE an" bleibt damit gültig und muss stehenbleiben.**

## Dateiübersicht

| Datei | Verantwortung | Aufgabe |
|---|---|---|
| `streaming/pulse-whip/Cargo.toml` + `src/lib.rs` + `src/av1.rs` + `src/sdp.rs` | die geteilten Teile des Sendewegs | 1 |
| `streaming/{win,linux,mac}-hq-sidecar/src/whip/{av1,sdp}.rs` | werden Re-Exports | 2 |
| `streaming/zwillinge/tests/*.rs` | zwei Tests werden gegenstandslos | 2 |
| `packaging/com.howispulse.Pulse.yml` | vierte `type: dir`-Quelle | 2 |
| `docs/plans/2026-08-20-uebergabe-etappe-3.md` | Prüfauftrag Windows + Linux | 3 |

---

## Aufgabe 1: Die Crate `pulse-whip` anlegen

**Dateien:**
- Erstellen: `streaming/pulse-whip/Cargo.toml`, `.gitignore`, `src/lib.rs`, `src/av1.rs`, `src/sdp.rs`

**Interfaces:**
- Erzeugt: `pulse_whip::av1::*` und `pulse_whip::sdp::*` — dieselben öffentlichen Namen wie heute in `crate::whip::av1` und `crate::whip::sdp`.

**Das Muster steht schon.** `streaming/pulse-redact` und `streaming/pulse-zeitbasis` sind nach genau diesem Schema gebaut. Schau sie an und halte dich an dieselbe Form.

- [ ] **Schritt 1: Die drei Fassungen gegeneinander prüfen**

```bash
cd /Users/michael/Documents/pulse/streaming
for f in av1 sdp; do
  echo "--- $f ---"
  diff win-hq-sidecar/src/whip/$f.rs linux-hq-sidecar/src/whip/$f.rs
  diff linux-hq-sidecar/src/whip/$f.rs mac-hq-sidecar/src/whip/$f.rs
done
```

Erwartung: `sdp.rs` überall still (bitgleich). `av1.rs` zeigt win gegen linux acht Zeilen — **denselben Doc-Kommentarblock an anderer Stelle**. linux gegen mac still.

**Weicht irgendetwas darüber hinaus ab, halte an und berichte.** Dann ist zwischen der Messung vom 2026-08-20 und jetzt etwas passiert, und das will verstanden werden, bevor eine Fassung zur gemeinsamen erklärt wird.

- [ ] **Schritt 2: Die Crate anlegen**

`streaming/pulse-whip/Cargo.toml`:

```toml
[package]
name = "pulse-whip"
version = "0.1.0"
edition = "2024"
publish = false

# Beide Abhaengigkeiten stehen bereits in allen drei Sidecars in genau diesen
# Fassungen — es kommt nichts Neues hinzu. Das ist der Grund, warum die
# Flatpak-Sources-Datei nicht neu erzeugt werden muss.
[dependencies]
anyhow = "1"
webrtc = "0.17"
```

`.gitignore` wie bei den beiden anderen Crates (`/target`, `/Cargo.lock`).

- [ ] **Schritt 3: Die beiden Dateien übernehmen**

`src/av1.rs` und `src/sdp.rs` **wortgleich** aus `linux-hq-sidecar/src/whip/` (linux ≡ mac, und bei `av1.rs` ist die Linux-Anordnung des Kommentarblocks die, die zwei von drei Sidecars tragen).

**`sdp.rs` enthält `use super::av1;`** — das wird in der Crate zu `use crate::av1;`. Das ist die einzige nötige Codeänderung; prüf, dass es die einzige bleibt.

`src/lib.rs`:

```rust
//! Die geteilten Teile des WHIP-Sendewegs.
//!
//! **Seit dem 2026-08-20 gemeinsam fuer alle drei Sidecars.** Vorher lagen
//! `av1.rs` und `sdp.rs` dreimal im Repo — `sdp.rs` dreimal bitgleich,
//! `av1.rs` mit einem einzigen Unterschied, der die POSITION eines
//! Doc-Kommentarblocks betraf. Zusammen 2366 ueberzaehlige Zeilen.
//!
//! **Was hier bewusst NICHT liegt:**
//!
//! * `pacer.rs` — die Windows-Fassung weicht ABSICHTLICH ab (dort 2026-08-13
//!   unabhaengig nach denselben Lehren gebaut, anderer Zuschnitt des
//!   Sendefensters). Welcher Zuschnitt besser ist, ist nicht gemessen; eine
//!   Zusammenlegung waere eine inhaltliche Entscheidung unter Unwissen. Der
//!   Hinweis in beiden Fassungen — „wer einen Pacer-Fehler behebt, sieht sich
//!   BEIDE an" — gilt weiter.
//! * `mod.rs` — plattformeigen. Windows traegt dort zusaetzlich eine
//!   Bandbreiten-Schaetzung, die die anderen nicht haben.

pub mod av1;
pub mod sdp;
```

- [ ] **Schritt 4: Bauen und testen**

```bash
cd /Users/michael/Documents/pulse/streaming/pulse-whip
cargo test
```

Erwartung: grün. Die Tests kommen aus den übernommenen Dateien mit; zähl sie und nenn die Zahl im Bericht.

- [ ] **Schritt 5: Committen**

---

## Aufgabe 2: Die drei Sidecars umziehen, Zwillings-Tests und Flatpak nachziehen

**Dateien:**
- Ändern: `streaming/{win,linux,mac}-hq-sidecar/Cargo.toml` und `src/whip/{av1,sdp}.rs`
- Ändern: `streaming/zwillinge/tests/bitgleich.rs` und `tests/logisch_gleich.rs`
- Ändern: `packaging/com.howispulse.Pulse.yml`

- [ ] **Schritt 1: Abhängigkeit in allen drei Cargo.toml**

```toml
pulse-whip = { path = "../pulse-whip" }
```

- [ ] **Schritt 2: Die sechs Dateien zu Re-Exports machen**

Je `src/whip/av1.rs`:

```rust
//! AV1-Teil des Sendewegs — liegt seit dem 2026-08-20 gemeinsam in
//! `pulse-whip`. Dieses Modul bleibt als Re-Export bestehen, damit die
//! Aufrufstellen (`crate::whip::av1::…`) unveraendert bleiben. Wer etwas
//! aendern will, tut es in `streaming/pulse-whip/` — es gilt fuer alle drei
//! Sidecars.

pub use pulse_whip::av1::*;
```

Und je `src/whip/sdp.rs` dasselbe mit `pulse_whip::sdp::*`.

**Prüf, ob `whip/mod.rs` etwas über `super::av1` oder `super::sdp` bezieht, das ein `pub use *` nicht durchreicht** — etwa Typen, die nur `pub(crate)` sind. Falls ja, berichte es, statt die Sichtbarkeit stillschweigend zu erweitern.

- [ ] **Schritt 3: Die Aufrufstellen zählen — vor und nach der Änderung gleich**

```bash
cd /Users/michael/Documents/pulse/streaming
for d in win linux mac; do
  printf "%-6s " $d
  grep -rn "av1::\|sdp::" $d-hq-sidecar/src/ --include="*.rs" | grep -v "src/whip/av1.rs\|src/whip/sdp.rs" | wc -l
done
```

Weicht eine Zahl ab, hast du eine Aufrufstelle kaputtgemacht — such sie, statt die Zahl im Bericht zu korrigieren.

- [ ] **Schritt 4: Die zwei Zwillings-Tests, die gegenstandslos werden**

`streaming/zwillinge/tests/bitgleich.rs` prüft `sdp.rs` (win ↔ linux), `tests/logisch_gleich.rs` prüft `av1.rs`. Beide Paare sind danach Re-Exports derselben Crate — die Tests verglichen zwei Einzeiler.

**Nicht ersatzlos löschen.** Ersetz sie an derselben Stelle durch einen Kommentar, der festhält, dass dieses Paar am 2026-08-20 in `pulse-whip` zusammengeführt wurde und deshalb keinen Vergleich mehr braucht. Genau so ist es bei `zeitbasis` in Etappe 2 gemacht worden — schau es dort an und halte dich an dieselbe Form.

**Der Test `zeigerbild_liegt_im_sidecar_wortgleich` bleibt unangetastet** — dieses Paar wird erst in Etappe 4 zusammengeführt.

```bash
cd /Users/michael/Documents/pulse/streaming/zwillinge && cargo test
```

- [ ] **Schritt 5: Flatpak — die vierte `type: dir`-Quelle**

`packaging/com.howispulse.Pulse.yml`, Modul `pulse-linux-hq-sidecar`. Dort stehen bereits drei `type: dir`-Quellen (Sidecar, `pulse-redact`, `pulse-zeitbasis`) mit `dest:`. **Füg `pulse-whip` nach demselben Muster hinzu** und zieh den erklärenden Kommentar mit (er zählt die Verzeichnisse auf).

**Warum das sein muss:** Der Flatpak baut `cargo --offline` und kopiert per `type: dir` nur die genannten Verzeichnisse. Ohne eigenen Eintrag zeigt `../pulse-whip` dort ins Leere, und ohne Netz gibt es kein Nachladen — der Bau bricht, und zwar nur auf dem Flatpak und erst in CI.

**Die Sources-JSON musst du NICHT neu erzeugen.** `webrtc = "0.17"` und `anyhow = "1"` stehen bereits in allen drei Sidecars und damit in deren `Cargo.lock`; es kommt kein Crate von crates.io hinzu. **Prüf diese Annahme aber nach**, indem du `webrtc` und `anyhow` in `packaging/linux-hq-sidecar-cargo-sources.json` suchst — findest du sie dort nicht, stimmt die Annahme nicht und du hältst an.

- [ ] **Schritt 6: Bauen, was hier baut**

```bash
cd /Users/michael/Documents/pulse/streaming/mac-hq-sidecar
export PKG_CONFIG_PATH="$HOME/src/ffmpeg-openssl/lib/pkgconfig:$PKG_CONFIG_PATH"
cargo test
```

Windows und Linux bauen hier nicht — durch Lesen prüfen, im Bericht benennen.

- [ ] **Schritt 7: Committen**

---

## Aufgabe 3: Das Übergabedokument

**Dateien:**
- Erstellen: `docs/plans/2026-08-20-uebergabe-etappe-3.md`

**Vorlage:** `docs/plans/2026-08-20-uebergabe-etappe-1-2.md` — gleiche Form, gleiche Gliederung.

- [ ] **Schritt 1: Schreiben**

Es muss enthalten:

**Was geändert wurde:** `av1.rs` und `sdp.rs` liegen jetzt gemeinsam, die alten Dateien sind Re-Exports, **keine Aufrufstelle angefasst**, **kein Verhalten geändert** (anders als bei der Maskierung in Etappe 1 — das hier ist ein reiner Umzug).

**Warum `pacer.rs` draussen blieb** — mit der Begründung aus diesem Plan. Wer die Übergabe liest, soll nicht denken, es sei vergessen worden.

**Auf beiden Maschinen:** Zweig auschecken, `cargo test` im jeweiligen Sidecar, `Cargo.lock` mitcommitten (getrackt, kennt `pulse-whip` noch nicht). **Ein echter Stream, der wirklich über WHIP geht** — das ist der Zweck dieser Dateien, und ein Umzug, der die SDP-Aushandlung beschädigt, fällt nur dort auf. Prüfen: Kommt beim Zuschauer ein Bild, und zwar in **AV1**?

**Auf Linux zusätzlich:** der Flatpak-Bau (`flatpak-builder --repo=/tmp/… --force-clean build/flatpak packaging/com.howispulse.Pulse.yml`, **nicht** `build.fish`).

**Auf Windows zusätzlich:** `cargo check` im Labor (`win-hq-labor`), das den Sidecar als Bibliothek zieht.

- [ ] **Schritt 2: Committen**

## Von Hand prüfen

- **Auf Windows und Linux** — siehe Übergabedokument. Ohne beide Rückmeldungen landet die Etappe nicht.
- **Auf dem Mac:** ein echter WHIP-Stream mit AV1, Bild beim Zuschauer.

## Abschluss

Etappe 4 (`pulse-zeigerbild`) ist die letzte. Sie trifft zusätzlich den **Player**, der genauso offline baut und deshalb denselben Flatpak-Eintrag in seinem eigenen Modul braucht.
