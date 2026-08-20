# Eigener WHIP-Sender für macOS — Umsetzungsplan

> **Für agentische Bearbeiter:** ERFORDERLICHE UNTER-SKILL: `superpowers:subagent-driven-development` (empfohlen) oder `superpowers:executing-plans`, um diesen Plan Aufgabe für Aufgabe umzusetzen. Die Schritte tragen Checkbox-Syntax (`- [ ]`) zum Mitverfolgen.

**Ziel:** Der mac-Sidecar sendet über einen eigenen WebRTC-Sendeweg statt über ffmpegs WHIP-Muxer. Damit fallen beide macOS-Sonderfälle weg — der Vollbild-Abstand von 2 s und die AV1-Sperre.

**Aufbau:** Der Sendeweg existiert bereits **zweimal** im Repo (Windows und Linux), davon 716 Codezeilen bitgleich. Er wird in eine gemeinsame Crate `streaming/pulse-whip/` gezogen, an die sich alle drei Sidecars hängen. Der Taktgeber (`pacer.rs`) bleibt plattformeigen hinter einem Trait, weil dort zwei ungemessene Algorithmen stehen.

**Technik:** Rust, `webrtc` 0.17 (unverändert von crates.io), `tokio`, `rtcp`, `reqwest` mit rustls. Auf macOS zusätzlich VideoToolbox über `ffmpeg-next` 8.0.

**Entwurf:** `docs/specs/2026-08-20-mac-whip-sender-design.md` — **zuerst lesen.**

**Zweig:** `feat/mac-whip-sender` (von frisch gepulltem `main`)

## Globale Randbedingungen

- **Nie direkt auf `main` arbeiten.** Alles auf `feat/mac-whip-sender`; landen nur über GitHub-PR mittels `bash scripts/ship.sh`. Merge nach `main` = Prod-Deploy und braucht ausdrückliche Freigabe.
- **Kein `git push` und keine GitHub-CLI ohne Freigabe.**
- **Test-Gate ist lokal.** Vor jedem Commit `cargo test` der berührten Crates. Vor dem Push zusätzlich pytest, `pnpm check`, `pnpm build`, Playwright. Rot = kein Push.
- **Dies ist der empfindlichste Zweig der beiden.** Er fasst `win-hq-sidecar` **und** `linux-hq-sidecar` an — beide produktiv, beide ausgeliefert. Eine Regression trifft Bestandsnutzer. Bei jeder Aufgabe gilt: Verhalten der bestehenden Plattformen unverändert, sofern nicht ausdrücklich als Änderung ausgewiesen (das gibt es genau einmal, Aufgabe 4).
- **Refactoring darf Verhalten nicht ändern.** Bricht ein Test nach einem Refactor, ist der Code kaputt, nicht der Test.
- **Keine neuen Abhängigkeiten ohne Rückfrage.** Die Fassungen von `webrtc`/`rtcp`/`tokio`/`reqwest` müssen zwischen allen Crates übereinstimmen — Begründung in `win-hq-sidecar/Cargo.toml:85-99`.
- **Niemals Stream-Keys oder Tokens loggen.** `redact::secrets` ist Pflicht auf jedem Pfad, der eine Push-URL in eine Meldung schreibt. `SendewegAbgewiesen` trägt bewusst nur den HTTP-Status und nicht die URL.
- **Code-Größen-Policy:** Quelldateien ≤ 350 Zeilen (hart 500). `whip/mod.rs` liegt mit 597 Zeilen bereits darüber — beim Verschieben **nicht** vergrössern; wenn sich beim Auftrennen eine natürliche Naht zeigt, splitten.
- **Sprache:** Rust-Doc-Kommentare in diesen Crates sind ASCII (`ae`/`oe`/`ue`, `ss`). Beim Verschieben Stil und Inhalt der Kommentare **wortgleich mitnehmen** — sie tragen Messwerte und Begründungen, die nirgends sonst stehen. **Commit-Messages und Changelog mit echten Umlauten. Keine Emojis.**
- **Version-Bump ist Pflicht** (Aufgabe 8): berührt `streaming/win-hq-sidecar/**`, das über den Windows-Installer ausgeliefert wird.
- **Commit-Messages:** Die Aufgaben 1, 2 und 4 geben den Text vollständig vor, weil dort das Wesentliche schon feststeht. Wo nur „Committen" steht, gilt dasselbe Muster: erste Zeile im Format `typ(bereich): was`, darunter **warum** — was der Code vorher tat, was daran nicht trug, und welche Belege die Entscheidung stützen. Kein Aufzählen der geänderten Dateien; das steht im Diff. Echte Umlaute, keine Emojis, `Co-Authored-By`-Zeile am Ende.

## Dateiübersicht

| Datei | Verantwortung | Aufgabe |
|---|---|---|
| `streaming/pulse-whip/Cargo.toml` | neue Crate | 1 |
| `streaming/pulse-whip/src/lib.rs` | `WhipSender`, `Taktgeber`-Trait, Callbacks | 1, 2 |
| `streaming/pulse-whip/src/av1.rs` | AV1-Paketierer (aus Windows übernommen) | 1 |
| `streaming/pulse-whip/src/sdp.rs` | SDP/Codec-Fähigkeiten | 1 |
| `streaming/pulse-whip/src/bandbreite.rs` | REMB-Schätzung | 2 |
| `streaming/win-hq-sidecar/src/whip/` | schrumpft auf `senke.rs` + `pacer.rs` | 2, 3 |
| `streaming/linux-hq-sidecar/src/whip/` | schrumpft auf `pacer.rs` | 4 |
| `streaming/mac-hq-sidecar/src/whip.rs` | neuer Adapter (Senke + Pacer) | 5 |
| `streaming/mac-hq-sidecar/src/encode/mod.rs` | `enum Ausgabe`, Anforderungspfad | 5, 6 |
| `streaming/mac-hq-sidecar/src/keyframe.rs` | neu: Anforderung + Drossel | 6 |
| `web/src/lib/stream/settings.svelte.ts` | `av1Nutzbar` | 7 |

---

## Aufgabe 1: Die Crate mit den bitgleichen Teilen

**Dateien:**
- Erstellen: `streaming/pulse-whip/Cargo.toml`, `streaming/pulse-whip/src/lib.rs`
- Verschieben: `streaming/win-hq-sidecar/src/whip/av1.rs` → `streaming/pulse-whip/src/av1.rs`
- Verschieben: `streaming/win-hq-sidecar/src/whip/sdp.rs` → `streaming/pulse-whip/src/sdp.rs`

**Schnittstellen:**
- Erzeugt: Crate `pulse-whip` mit `pub mod av1` und `pub(crate) mod sdp`. Aus `av1` öffentlich: `MTU: usize`, `RTP_TAKT_HZ: u32`, `Nutzlast { daten: Vec<u8>, letztes: bool }`, `paketiere(&[u8], usize) -> Result<Vec<Nutzlast>>`, `SpurZustand` mit `neu(fps)`, `zeitstempel(&mut self, Option<i64>) -> u32`, `naechste_seq(&mut self) -> u16`.

**Hintergrund für den Bearbeiter.** Diese beiden Dateien sind zwischen Windows und Linux **in der Logik bitgleich** (496 bzw. 220 Codezeilen, null Abweichung ohne Kommentare). Das Verschieben ist damit risikofrei — es gibt keine zwei Fassungen abzuwägen.

`av1.rs` greift an genau einer produktiven Stelle in die Sidecar-Crate zurück: `crate::zeitbasis::takte_je_bild(fps)` in Zeile 414. Das ist eine Zeile Ceil-Division und wandert mit. `VIDEO_HZ` und `pts_aus_sekunden` werden nur im Testmodul gebraucht (Zeile 730) — der dortige Test `assert_eq!(VIDEO_HZ, RTP_TAKT_HZ)` ist die Klammer, die Encoder- und RTP-Uhr zusammenhält und muss erhalten bleiben.

- [ ] **Schritt 1: Die Crate anlegen**

`streaming/pulse-whip/Cargo.toml`. Die Fassungen sind aus `win-hq-sidecar/Cargo.toml` übernommen und **müssen** dort identisch bleiben:

```toml
[package]
name = "pulse-whip"
version = "0.1.0"
edition = "2024"

[dependencies]
webrtc = "0.17"
rtcp = "0.17"
bytes = "1"
anyhow = "1"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "time", "sync"] }
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }
serde_json = "1"
```

- [ ] **Schritt 2: `av1.rs` und `sdp.rs` mit Historie verschieben**

`git mv` statt kopieren — die Historie dieser Dateien trägt Messwerte und Begründungen:

```bash
cd /Users/michael/Documents/pulse
mkdir -p streaming/pulse-whip/src
git mv streaming/win-hq-sidecar/src/whip/av1.rs streaming/pulse-whip/src/av1.rs
git mv streaming/win-hq-sidecar/src/whip/sdp.rs streaming/pulse-whip/src/sdp.rs
```

- [ ] **Schritt 3: `takte_je_bild` mitnehmen**

In `streaming/pulse-whip/src/lib.rs` — die Funktion wird aus `win-hq-sidecar/src/zeitbasis.rs:73` übernommen, mit ihrem Doc-Kommentar. Ergänze einen Hinweis, warum sie hier steht:

```rust
//! Der eigene WebRTC-Sendeweg (WHIP), geteilt von allen drei HQ-Sidecars.
//!
//! **Hier stand er bis zum 2026-08-20 zweimal** — je einmal in
//! `win-hq-sidecar/src/whip/` und `linux-hq-sidecar/src/whip/`, davon 716
//! Codezeilen bitgleich, ohne Zwillings-Test und ohne Vermerk.

pub mod av1;
mod sdp;

/// Wie viele RTP-Takte ein Bild bei dieser Bildrate dauert.
///
/// **Uebernommen aus `win-hq-sidecar/src/zeitbasis.rs`**, weil `av1.rs` sie
/// braucht und die Crate sonst in den Sidecar zurueckgriffe. Die Sidecars
/// behalten ihre eigene `zeitbasis` — sie rechnet dort mehr als nur dies.
pub fn takte_je_bild(fps: u32) -> i64 {
    (90_000f64 / fps.max(1) as f64).ceil() as i64
}
```

**Prüfe die übernommene Fassung gegen das Original** (`win-hq-sidecar/src/zeitbasis.rs:73`) und übernimm sie wortgleich, falls sie abweicht. Rate die Implementierung nicht.

- [ ] **Schritt 4: Die Rückgriffe in `av1.rs` umbiegen**

In `streaming/pulse-whip/src/av1.rs`: `crate::zeitbasis::takte_je_bild` → `crate::takte_je_bild` (Zeile ~414) und im Testmodul (~Zeile 730) `crate::zeitbasis::{VIDEO_HZ, pts_aus_sekunden}` auflösen. `VIDEO_HZ` ist `90_000` und identisch mit `RTP_TAKT_HZ` — der Test, der beide gleichsetzt, wird zu einer Selbstverständlichkeit und **muss deshalb umformuliert werden**, statt still zu verschwinden:

```rust
    /// **Die Klammer zwischen Encoder-Uhr und RTP-Uhr.**
    ///
    /// Bis zum 2026-08-20 stand hier `assert_eq!(VIDEO_HZ, RTP_TAKT_HZ)` — die
    /// beiden Konstanten lagen in verschiedenen Modulen und konnten
    /// auseinanderlaufen. Seit der Sendeweg eine eigene Crate ist, gibt es nur
    /// noch `RTP_TAKT_HZ`; die Sidecars melden ihre `VIDEO_HZ` dagegen. Der
    /// Test steht deshalb jetzt DORT (`zeitbasis.rs`), nicht mehr hier.
    #[test]
    fn rtp_takt_ist_90k() {
        assert_eq!(RTP_TAKT_HZ, 90_000);
    }
```

Und in `win-hq-sidecar/src/zeitbasis.rs` sowie `linux-hq-sidecar/src/encode/` (dort, wo `VIDEO_HZ` definiert ist) den Gegentest ergänzen:

```rust
    /// Encoder-Uhr und RTP-Uhr muessen dieselbe sein — sonst laeuft das Bild
    /// gegen die Wanduhr weg, ohne dass irgendwo ein Fehler auftaucht.
    /// Gegenstueck zu `pulse_whip::av1::RTP_TAKT_HZ`.
    #[test]
    fn video_hz_passt_zum_rtp_takt() {
        assert_eq!(VIDEO_HZ, pulse_whip::av1::RTP_TAKT_HZ);
    }
```

- [ ] **Schritt 5: Die Crate allein bauen und testen**

```bash
cd /Users/michael/Documents/pulse/streaming/pulse-whip
cargo test 2>&1 | tail -20
```

Erwartung: baut, und die Tests aus `av1.rs` (Paketierer, Round-Trip, Zeitstempel) laufen grün. Das sind die Tests, die den webrtc-rs-Fehler bei Längenfeldern ab 128 absichern — sie müssen **alle** mitgekommen sein.

- [ ] **Schritt 6: Committen**

```bash
cd /Users/michael/Documents/pulse
git add streaming/pulse-whip streaming/win-hq-sidecar
git commit -F - <<'EOF'
refactor(whip): neue Crate pulse-whip mit den bitgleichen Teilen

Der eigene WHIP-Sendeweg lag zweimal im Repo — je einmal im Windows- und
im Linux-Sidecar. Ohne Kommentare gerechnet sind av1.rs (496 Codezeilen)
und sdp.rs (220) zwischen beiden BITGLEICH; der einzige Unterschied in
av1.rs ist die Position eines Doc-Absatzes. 716 Zeilen Doppelung, ohne
Zwillings-Test und ohne Vermerk — dasselbe Muster, das CLAUDE.md beim Paar
zeitbasis.rs beschreibt.

Diese beiden Dateien wandern als Erstes, weil daran nichts abzuwaegen ist.
Verschoben mit git mv statt kopiert: ihre Historie traegt Messwerte und
Begruendungen, die nirgends sonst stehen.

takte_je_bild kommt aus zeitbasis.rs mit — eine Zeile Ceil-Division, der
einzige produktive Rueckgriff von av1.rs in die Sidecar-Crate. Die
Sidecars behalten ihre eigene zeitbasis, die mehr rechnet als dies.

Der Test assert_eq!(VIDEO_HZ, RTP_TAKT_HZ) waere in der Crate zur
Selbstverstaendlichkeit geworden. Statt ihn still fallen zu lassen, ist er
umgedreht: die Crate prueft, dass ihr RTP-Takt 90k ist, und jeder Sidecar
prueft seine VIDEO_HZ dagegen. Die Klammer zwischen Encoder-Uhr und
RTP-Uhr bleibt damit gespannt — laeuft sie auf, wandert das Bild gegen die
Wanduhr, ohne dass irgendwo ein Fehler auftaucht.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Aufgabe 2: `mod.rs` und `bandbreite.rs` in die Crate, Windows hängt sich an

**Dateien:**
- Verschieben: `win-hq-sidecar/src/whip/mod.rs` → `pulse-whip/src/lib.rs` (eingegliedert), `win-hq-sidecar/src/whip/bandbreite.rs` → `pulse-whip/src/bandbreite.rs`
- Ändern: `streaming/win-hq-sidecar/src/whip/mod.rs` (schrumpft auf Adapter), `Cargo.toml`, `src/lib.rs`

**Schnittstellen:**
- Erzeugt: `pulse_whip::WhipSender` mit `connect(...) -> Result<Self>`, `send(&self, &[u8], Option<i64>) -> Result<()>`, `send_audio(&self, &[u8], Duration) -> Result<()>`, `close(&self)`.
- Erzeugt: `pulse_whip::Taktgeber` — Trait, plattformeigen implementiert.
- Erzeugt: `pulse_whip::SendewegAbgewiesen(pub u16)`.
- Erzeugt: `pulse_whip::Einhaengung` — die beiden Callbacks.

**Hintergrund für den Bearbeiter.** Hier entstehen die zwei Nähte. `whip/mod.rs` greift produktiv an drei Stellen in die Sidecar-Crate zurück: `events::emit` (Zeile 239), `request_keyframe` (Zeile 392), `redact::secrets` (Zeile 441). Die letzte wandert mit — `redact.rs:42-44` verbietet ausdrücklich zwei Fassungen. Die ersten beiden werden Callbacks.

**`pacer.rs` bleibt, wo es ist.** Dort stehen zwei ungemessene Algorithmen (Windows teilt das Sendefenster, Linux hält einen festen Gruppenabstand), und die Frage wird umgangen statt gelöst. Das kostet nichts: beide `mod.rs` konstruieren, halten und rufen den Pacer heute schon wortgleich.

- [ ] **Schritt 1: Das Taktgeber-Trait definieren**

In `streaming/pulse-whip/src/lib.rs`:

```rust
/// Der Taktgeber verteilt die Pakete eines Bildes, statt sie als Schwall zu
/// senden.
///
/// **Bewusst ein Trait und keine Implementierung in dieser Crate.** Windows und
/// Linux loesen dasselbe Problem verschieden — Windows teilt das Sendefenster
/// durch die Gruppenzahl (variabler Abstand, Untergrenze 2 ms), Linux haelt
/// einen festen Gruppenabstand von 2500 us und variiert die Zahl. Welcher Weg
/// besser ist, ist NICHT gemessen: die Ankunftsluecken, um die es geht, treten
/// auf der lokalen Schleife gar nicht auf (0 bei 4000 kbps), es braeuchte also
/// eine echte Strecke. Solange das offen ist, behaelt jede Plattform ihren
/// erprobten Algorithmus.
///
/// Windows haengt hier zusaetzlich `remote_input::fern_aktiv()` ein — im
/// Fern-Modus wird ohne Verteilung gesendet. Genau deshalb steht der Taktgeber
/// im Sidecar und nicht hier: dieser Rueckgriff bleibt dort, wo er hingehoert.
pub trait Taktgeber: Send + Sync {
    /// Die fertigen RTP-Pakete eines Bildes abgeben.
    ///
    /// **Darf nicht blockieren.** Der Encode-Faden ruft das; wartet er,
    /// bremst die Verteilung die Aufnahme aus.
    fn send(&self, pakete: Vec<webrtc::rtp::packet::Packet>) -> anyhow::Result<()>;
}

/// Baut den plattformeigenen Taktgeber, sobald die Spur steht.
///
/// Funktionszeiger und kein Closure — gleiches Muster wie `SenkenBauer` in
/// `win-hq-sidecar/src/encode/senke.rs`.
pub type TaktgeberBauer = fn(
    &'static tokio::runtime::Runtime,
    std::sync::Arc<webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP>,
    std::time::Duration,
) -> Box<dyn Taktgeber>;
```

- [ ] **Schritt 2: Die beiden Callbacks definieren**

```rust
/// Was der Sendeweg vom Sidecar braucht.
///
/// Zwei Rueckwege, beide vom Sidecar gestellt. Bis zum 2026-08-20 waren es
/// direkte `crate::`-Aufrufe — genau die machten den Sendeweg
/// unverschiebbar.
#[derive(Clone)]
pub struct Einhaengung {
    /// Ein Vollbild anfordern (RTCP PLI oder FIR ist eingetroffen).
    ///
    /// **Das ist der Grund, warum es diesen Sendeweg ueberhaupt gibt.**
    /// ffmpegs WHIP-Muxer hat keinen Rueckkanal zur Anwendung; ohne ihn steht
    /// das Bild nach einem Paketverlust bis zum naechsten regulaeren Vollbild.
    pub vollbild_anfordern: std::sync::Arc<dyn Fn() + Send + Sync>,
    /// Ein Ereignis nach vorne melden (JSON, wie `events::emit`).
    pub melde: std::sync::Arc<dyn Fn(serde_json::Value) + Send + Sync>,
}
```

- [ ] **Schritt 3: `mod.rs` und `bandbreite.rs` verschieben**

```bash
cd /Users/michael/Documents/pulse
git mv streaming/win-hq-sidecar/src/whip/bandbreite.rs streaming/pulse-whip/src/bandbreite.rs
```

`whip/mod.rs` wird in `pulse-whip/src/lib.rs` eingegliedert. **Wortgleich übernehmen**, inklusive aller Doc-Kommentare — sie tragen die Messwerte vom 2026-07-28 (ohne Rückkanal 7 bis 9 Sekunden ohne Bild bei 0,2 % Verlust, mit Rückkanal 0 bis 1) und die Begründung, warum H.264 seit 2026-08-14 als RTP-Spur statt als Sample-Spur läuft.

Dabei drei Stellen umbiegen:
- Zeile ~239 `crate::events::emit(json!(…))` → `(self.einhaengung.melde)(json!(…))`
- Zeile ~392 `crate::keyframe::request_keyframe()` → `(einhaengung.vollbild_anfordern)()`
- Zeile ~441 `crate::redact::secrets(…)` → `redact::secrets(…)` (mitgewandert)
- Das Feld `pacer: Option<pacer::Pacer>` → `takt: Option<Box<dyn Taktgeber>>`
- Die Konstruktion `pacer::Pacer::start(runtime(), Arc::clone(&video_track), frame_duration)` → `(bauer)(runtime(), Arc::clone(&video_track), frame_duration)`

**`WhipSender::connect` bekommt zwei Parameter dazu**: die `Einhaengung` und den `TaktgeberBauer`. Die bestehende Parameterliste (`url`, `codec`, `fps`, `breite`, `hoehe`, `bitrate_kbps`) bleibt unverändert.

Beachte die Größen-Policy: `mod.rs` hatte 597 Zeilen. Zeigt sich beim Auftrennen eine natürliche Naht (etwa der ICE-/Aushandlungsteil `negotiate`), splitten.

- [ ] **Schritt 4: `redact.rs` mitnehmen**

`win-hq-sidecar/src/redact.rs:45` — die Funktion wandert in die Crate. **Achtung, `redact.rs:42-44` warnt ausdrücklich vor zwei Fassungen und davor, dass sie nicht idempotent ist.** Der Sidecar nutzt sie auch anderswo, muss sie also weiter erreichen: er re-exportiert aus der Crate, statt eine zweite Kopie zu halten.

```bash
grep -rn "redact::secrets\|redact::" streaming/win-hq-sidecar/src/ | grep -v "^streaming/win-hq-sidecar/src/redact.rs"
```

Jede Fundstelle prüfen und auf den Re-Export ziehen.

- [ ] **Schritt 5: Windows an die Crate hängen**

`win-hq-sidecar/Cargo.toml`:

```toml
pulse-whip = { path = "../pulse-whip" }
```

`win-hq-sidecar/src/whip/mod.rs` schrumpft auf den Adapter: er behält `pub mod pacer;` und `pub mod senke;`, implementiert `pulse_whip::Taktgeber` für den lokalen `Pacer`, stellt die `Einhaengung` aus `crate::events::emit` und `crate::keyframe::request_keyframe` zusammen, und re-exportiert `SendewegAbgewiesen`, damit `encode/bildencoder.rs:327` unverändert bleibt.

```rust
impl pulse_whip::Taktgeber for pacer::Pacer {
    fn send(&self, pakete: Vec<webrtc::rtp::packet::Packet>) -> anyhow::Result<()> {
        pacer::Pacer::send(self, pakete)
    }
}

fn baue_takt(
    rt: &'static tokio::runtime::Runtime,
    track: std::sync::Arc<webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP>,
    bilddauer: std::time::Duration,
) -> Box<dyn pulse_whip::Taktgeber> {
    Box::new(pacer::Pacer::start(rt, track, bilddauer))
}

fn einhaengung() -> pulse_whip::Einhaengung {
    pulse_whip::Einhaengung {
        vollbild_anfordern: std::sync::Arc::new(crate::keyframe::request_keyframe),
        melde: std::sync::Arc::new(crate::events::emit),
    }
}
```

`whip/senke.rs` bleibt unverändert bis auf den Typpfad von `WhipSender` und die zwei neuen `connect`-Argumente.

- [ ] **Schritt 6: Windows bauen und die volle Suite fahren**

Auf einer Windows-Maschine (oder per Cross-Check, siehe CLAUDE.md zum Wegwerf-Crate):

```bash
cd streaming/win-hq-sidecar
cargo test 2>&1 | tail -20
cargo clippy --all-targets 2>&1 | grep -E "^(warning|error)" | head
```

Erwartung: grün. Insbesondere muss `ohne_anmeldung_geht_alles_ueber_den_muxer` (in `encode/senke.rs`) weiter laufen — er hält fest, dass die Senken-Anmeldung im Binary steht und nicht in der Bibliothek.

- [ ] **Schritt 7: Committen**

```bash
git add streaming/pulse-whip streaming/win-hq-sidecar
git commit -F - <<'EOF'
refactor(whip): mod.rs und bandbreite.rs in die Crate, Windows haengt sich an

Damit ist der Sendeweg geteilt. Zurueck im Sidecar bleiben genau zwei
Dateien: senke.rs (der Adapter auf sein PaketSenke-Trait — mitgewandert
waere er zirkulaer geworden) und pacer.rs.

Der Taktgeber bleibt ausdruecklich plattformeigen, hinter einem Trait.
Windows und Linux loesen dasselbe Problem verschieden, und welcher Weg
besser ist, ist NICHT gemessen — die Ankunftsluecken, um die es geht,
treten auf der lokalen Schleife gar nicht auf. Die Frage wird umgangen
statt beantwortet. Das kostet nichts: beide mod.rs konstruieren, halten
und rufen den Pacer schon heute wortgleich.

Angenehme Folge: fern_aktiv bleibt damit im Windows-Pacer und ist gar kein
Callback. Es bleiben zwei Naehte — vollbild_anfordern und melde.

redact::secrets wandert mit, statt zurueckgerufen zu werden: redact.rs
warnt ausdruecklich vor zwei Fassungen und davor, dass die Funktion nicht
idempotent ist. Der Sidecar re-exportiert aus der Crate.

Fuer Windows ist das Ergebnis verhaltensgleich — reines Verschieben plus
Einhaengung, keine geaenderte Logik.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Aufgabe 3: Die Bauwege für die neue Crate nachziehen

**Dateien:**
- Ändern: `.github/workflows/win-build.yml` (Cargo-Cache-Workspaces)
- Ändern: `packaging/com.howispulse.Pulse.yml` und `packaging/*-cargo-sources.json` (Flatpak, offline)

**Hintergrund für den Bearbeiter.** Es gibt keinen Cargo-Workspace; jede Crate steht für sich, und die CI cacht je Crate-Verzeichnis. Eine neue Pfad-Abhängigkeit muss deshalb überall bekannt gemacht werden. **Flatpak baut Cargo offline** — bei jeder `Cargo.lock`-Änderung muss `packaging/linux-hq-sidecar-cargo-sources.json` neu erzeugt werden, sonst scheitert der Bau.

- [ ] **Schritt 1: Alle Stellen finden, die Crate-Pfade kennen**

```bash
cd /Users/michael/Documents/pulse
grep -rn "win-hq-sidecar\|linux-hq-sidecar\|pulse-player" .github/workflows/ packaging/*.yml packaging/*.json 2>/dev/null | grep -vi "^\s*#" | head -30
```

- [ ] **Schritt 2: Den Windows-Cache erweitern**

In `.github/workflows/win-build.yml` beim `Swatinem/rust-cache`-Schritt (~Zeile 47) `streaming/pulse-whip` ergänzen.

- [ ] **Schritt 3: Bauen und prüfen**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/win-build.yml')); print('YAML ok')"
```

- [ ] **Schritt 4: Committen** (die Flatpak-Seite folgt in Aufgabe 4, sie hängt an Linux)

---

## Aufgabe 4: Linux hängt sich an — mit einer ausgewiesenen Verhaltensänderung

**Dateien:**
- Löschen: `linux-hq-sidecar/src/whip/{av1.rs,sdp.rs,mod.rs}`
- Ändern: `linux-hq-sidecar/src/whip/pacer.rs` (bleibt), `Cargo.toml`, `src/encode/mod.rs`
- Ändern: `packaging/linux-hq-sidecar-cargo-sources.json`

**Dies ist die einzige Aufgabe im Plan, die vorhandenes Verhalten ändert.**

**Hintergrund für den Bearbeiter.** Der Linux-Sidecar bekommt mit `mod.rs` aus der Crate die **REMB-Bandbreitenschätzung**, die er heute nicht hat (`bandbreite.rs` existiert dort gar nicht). Das ist inhaltlich eine Verbesserung — der Sender erfährt, wenn die Leitung eng wird — aber es ist eine Verhaltensänderung an produktivem, über Flatpak ausgeliefertem Code. Sie wird einzeln geprüft und einzeln committet, nicht als Nebenwirkung mitgeschleift.

Linux hat statt der Senken-Registry ein `enum Ausgabe { Mux(MuxWriter), Whip(Arc<WhipSender>) }` (`encode/mod.rs:60-66`). Das bleibt so — es wird nur der `WhipSender`-Typ getauscht.

- [ ] **Schritt 1: Vor dem Umbau festhalten, was heute gilt**

```bash
cd /Users/michael/Documents/pulse/streaming/linux-hq-sidecar
cargo test 2>&1 | tail -5
```

Die Zahl der grünen Tests notieren — sie ist der Vergleichswert für Schritt 5.

- [ ] **Schritt 2: Die drei Dateien entfernen und die Crate einhängen**

```bash
git rm streaming/linux-hq-sidecar/src/whip/av1.rs \
       streaming/linux-hq-sidecar/src/whip/sdp.rs \
       streaming/linux-hq-sidecar/src/whip/mod.rs
```

`linux-hq-sidecar/Cargo.toml`: `pulse-whip = { path = "../pulse-whip" }`.

Statt `src/whip/mod.rs` tritt ein schlankes `src/whip.rs` mit `pub mod pacer;`, der `Taktgeber`-Implementierung für den **Linux**-Pacer und der `Einhaengung` aus den Linux-Gegenstücken zu `events::emit` und `request_keyframe`.

**Der Linux-Pacer nutzt `fern_aktiv` nicht** — seine `eilig`-Bedingung ist `!rx.is_empty()`. Das bleibt so.

- [ ] **Schritt 3: `encode/mod.rs` auf den neuen Typ ziehen**

`enum Ausgabe` (~Zeile 60-66) hält `Whip(Arc<WhipSender>)` — der Pfad wird `pulse_whip::WhipSender`. Die Gabelungen in `create_whip` (~Zeile 355), `drain_video` (~Zeile 472-523) und `ton_senke()` (`encode/audio.rs:310`) bleiben inhaltlich unverändert.

Nicht anfassen: `global_header = false` in `create_whip` ist ausdrücklich begründet (SPS/PPS müssen über RTP im Strom mitlaufen).

- [ ] **Schritt 4: Die Verhaltensänderung sichtbar machen**

Die REMB-Schätzung meldet über den `melde`-Callback. Prüfe, dass die neuen Meldungen auf Linux nicht in einen Kanal laufen, der sie für einen Fehler hält:

```bash
grep -rn "fn emit" streaming/linux-hq-sidecar/src/events.rs
```

- [ ] **Schritt 5: Bauen, testen, vergleichen**

```bash
cd streaming/linux-hq-sidecar
cargo test 2>&1 | tail -10
cargo clippy --all-targets 2>&1 | grep -E "^(warning|error)" | head
```

Erwartung: mindestens so viele grüne Tests wie in Schritt 1.

- [ ] **Schritt 6: Flatpak-Quellen neu erzeugen**

**Pflicht bei jeder `Cargo.lock`-Änderung** — Flatpak baut Cargo offline. Das Verfahren steht in `packaging/README.md`.

Danach **nur prüfen**, nicht installieren — `packaging/build.fish` ersetzt die installierte App und hängt sie an den lokalen Cache:

```bash
flatpak-builder --repo=/tmp/pulse-pruef build/flatpak packaging/com.howispulse.Pulse.yml
```

- [ ] **Schritt 7: Von Hand prüfen**

Ein echter Stream vom Linux-Sidecar: WHIP-Push, ein PLI löst ein Vollbild aus, RTMPS-Regression. Grüne Tests genügen hier nicht — der Sendeweg ist über Flatpak ausgeliefert.

- [ ] **Schritt 8: Committen**

```bash
git add -A streaming/linux-hq-sidecar streaming/pulse-whip packaging
git commit -F - <<'EOF'
refactor(whip): Linux haengt sich an die Crate — und bekommt REMB dazu

Die dritte und letzte Fassung des Sendewegs faellt weg. Zurueck bleibt im
Linux-Sidecar nur pacer.rs mit seinem eigenen Algorithmus.

ACHTUNG, das hier ist keine reine Verschiebung: mit mod.rs erbt Linux die
REMB-Bandbreitenschaetzung, die es bisher nicht hatte — bandbreite.rs
existierte dort gar nicht. Der Sender erfaehrt jetzt, wenn die Leitung eng
wird. Inhaltlich eine Verbesserung, aber eine Verhaltensaenderung an
produktivem, ueber Flatpak ausgeliefertem Code, und deshalb ein eigener
Commit mit eigener Pruefung statt einer Nebenwirkung.

Das enum Ausgabe { Mux, Whip } bleibt, wie es ist — Linux hat nie die
Senken-Registry von Windows gehabt und braucht sie auch nicht. Getauscht
wurde nur der Typ des WhipSender. global_header = false in create_whip
blieb unberuehrt: SPS/PPS muessen ueber RTP im Strom mitlaufen.

Cargo-Quellen fuer Flatpak neu erzeugt (baut offline, Pflicht bei jeder
Cargo.lock-Aenderung).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Aufgabe 5: Der mac-Sidecar sendet selbst

**Dateien:**
- Erstellen: `streaming/mac-hq-sidecar/src/whip.rs` (Adapter: Senke + Taktgeber)
- Ändern: `streaming/mac-hq-sidecar/Cargo.toml`, `src/encode/mod.rs`, `src/encode/audio.rs`, `src/lib.rs`, `src/main.rs`

**Hintergrund für den Bearbeiter.** Heute gibt es im mac-Sidecar **keine Abstraktion für den Ausgang** — `MuxWriter` ist an drei Stellen hart verdrahtet: Feld `mux: MuxWriter` (`encode/mod.rs:170`), `self.mux.send(packet)` im `drain` (`encode/mod.rs:355`) und `mux: &MuxWriter` im gesamten Audio-Pfad (`audio.rs:97/121/138`).

**Die engste Vorlage ist Linux, nicht Windows**: dort steht ein `enum Ausgabe { Mux(MuxWriter), Whip(Arc<WhipSender>) }` (`linux-hq-sidecar/src/encode/mod.rs:60-66`), und der mac-Sidecar ist ihm strukturell näher als der Windows-Registry-Lösung. Ein weiterer Grund: die Registry (`registriere_senken_bauer`) löst ein Problem, das macOS nicht hat — dort gibt es nur einen Sendeweg-Kandidaten.

**Die Naht liegt vollständig hinter `VideoEncoder`** — `stream_controller.rs` braucht keine Änderung.

Beachte den Unterschied beim Ausgeben: über den Muxer gehen Pakete mit `rescale_ts` und Stream-Index, über WHIP **ohne beides** (`w.send(daten, packet.pts())`, Vorbild `linux .../encode/mod.rs:498-520`).

- [ ] **Schritt 1: Die Abhängigkeiten ergänzen**

`streaming/mac-hq-sidecar/Cargo.toml` — der Sidecar hat heute **kein** tokio, webrtc, rtcp, bytes oder reqwest. Fassungen müssen mit den anderen Crates übereinstimmen:

```toml
pulse-whip = { path = "../pulse-whip" }
```

Die tokio-Laufzeit lebt gekapselt in `pulse-whip` (`runtime()` mit `OnceLock`, zwei Worker) — der mac-Sidecar bleibt im Übrigen synchron (`std::thread`, `std::sync::mpsc`), genau wie der Windows-Sidecar. Das ist das zu kopierende Muster.

- [ ] **Schritt 2: Den Adapter schreiben**

`streaming/mac-hq-sidecar/src/whip.rs` mit der `Taktgeber`-Implementierung und der `Einhaengung`. **macOS hat keinen eigenen Pacer** — die Frage, welcher Algorithmus besser ist, ist offen, und einen dritten zu erfinden wäre die schlechteste Antwort. Nimm den Linux-Algorithmus (fester Gruppenabstand): er ist der jüngere Umbau und kommt ohne den `fern_aktiv`-Sonderfall aus, den macOS nicht hat.

Kopiere `linux-hq-sidecar/src/whip/pacer.rs` nach `mac-hq-sidecar/src/whip/pacer.rs` und **vermerke im Modulkopf**, dass es eine Kopie ist, warum sie existiert und dass sie mit der Linux-Fassung zu ziehen ist, solange die Pacer-Frage offen bleibt.

- [ ] **Schritt 3: `enum Ausgabe` einführen**

In `streaming/mac-hq-sidecar/src/encode/mod.rs`, nach dem Vorbild von Linux:

```rust
/// Wohin die encodierten Pakete gehen.
///
/// **Der WHIP-Weg ist der einzige, auf dem eine Vollbild-Anforderung des
/// Zuschauers den Encoder erreicht** — ffmpegs WHIP-Muxer hat keinen
/// Rueckkanal zur Anwendung. Genau das war bis zum 2026-08-20 der Grund,
/// warum auf macOS der Vollbild-Abstand bei 2 s festhing und AV1 gar nicht
/// erst angeboten wurde.
enum Ausgabe {
    Mux(MuxWriter),
    Whip(std::sync::Arc<pulse_whip::WhipSender>),
}
```

Feld `mux: MuxWriter` → `ausgabe: Ausgabe`. Die Gabelung beim Bauen kommt in `VideoEncoder::start` vor Zeile 206; die Gabelung beim Ausgeben in `drain` (Zeile 348-363).

- [ ] **Schritt 4: Den Audio-Pfad nachziehen**

`audio.rs` nimmt heute `mux: &MuxWriter` (Zeilen 97/121/138). Nach dem Linux-Vorbild wird daraus eine `TonSenke` mit den beiden Zweigen (`linux .../encode/audio.rs:310`).

- [ ] **Schritt 5: Bauen und testen**

```bash
cd streaming/mac-hq-sidecar
export PKG_CONFIG_PATH="$HOME/src/ffmpeg-openssl/lib/pkgconfig:$PKG_CONFIG_PATH"
cargo test 2>&1 | tail -15
cargo clippy --all-targets 2>&1 | grep -E "^(warning|error)" | head
```

- [ ] **Schritt 6: WHIP-Rauchtest gegen ein Wegwerf-MediaMTX**

Verfahren wie in `docs/plans/2026-07-12-whip-win-mac-handover.md` beschrieben: Docker `bluenviron/mediamtx:1.19.1`, Minimal-Config (`webrtc: yes`, `webrtcAddress: :8889`, `webrtcLocalUDPAddress: :8189`, `moq: no`), dann `encode_smoke` gegen `http://127.0.0.1:8889/whipsmoke/whip`.

Erwartung: WHIP-Handshake-Zeile, MediaMTX meldet `stream is available and online`, sauberer Abbau. Danach **RTMPS-Regression** gegen `rtmps://…` — der Muxer-Weg muss unverändert funktionieren.

- [ ] **Schritt 7: Committen**

---

## Aufgabe 6: Der Vollbild-Anforderungspfad auf macOS

**Dateien:**
- Erstellen: `streaming/mac-hq-sidecar/src/keyframe.rs`
- Ändern: `src/encode/hw.rs` (~Zeile 108-138, `wrap`), `src/encode/mod.rs` (~Zeile 332-345, `push_pixel_buffer`), `src/dispatch.rs`, `src/ops/mod.rs`

**Hintergrund für den Bearbeiter.** Der mac-Sidecar hat heute **kein** `request_keyframe` und **kein** `pict_type=I`. `venc.set_gop(...)` (Zeile 256) ist der einzige Keyframe-Schalter, ein statisches GOP.

**Der Weg über VideoToolbox ist nachgewiesen vorhanden:**

```bash
nm -u /opt/homebrew/opt/ffmpeg/lib/libavcodec.dylib | grep ForceKeyFrame
# _kVTEncodeFrameOptionKey_ForceKeyFrame
```

`libavcodec/videotoolboxenc.c` setzt diesen Schlüssel, wenn ein Eingabe-Frame `pict_type == AV_PICTURE_TYPE_I` trägt — unabhängig davon, ob der Pixelpuffer aus einem HW-Frames-Kontext kommt. Der bestehende Zero-Copy-Pfad bleibt also intakt.

**Ein Vorteil gegenüber Linux und Windows:** dort steht ausdrücklich „pro Bild ZURÜCKSETZEN, der Frame stammt aus einem Pool" (`linux .../encode/mod.rs:430-442`). Auf macOS wird der `AVFrame` je Bild frisch alloziert (`hw.rs:116`) und sofort wieder freigegeben — das Kleben-Problem entsteht gar nicht.

**Die Drossel ist Pflicht, nicht Kür.** Ohne sie kann ein Zuschauer mit PLI-Sturm den Encoder lahmlegen. Vorbilder: `linux .../encode/mod.rs:908-937` (`take_keyframe_request`, `KEYFRAME_DROSSEL_DECKEL_MS = 2_000`) und `win-hq-sidecar/src/keyframe.rs:148` (`Leiter`-Drossel mit Treppen-Staffelung).

**Der Deckel muss `KEYFRAME_SEKUNDEN_UNBEDENKLICH` entsprechen** — auf Linux hält ein Test das fest (`drossel_deckel_entspricht_dem_unbedenklichen_abstand`). Genau deshalb bleibt die Konstante in Aufgabe 7 bestehen, auch wenn die Vorgabe auf 60 s geht.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

`streaming/mac-hq-sidecar/src/keyframe.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// Zwei Anforderungen kurz hintereinander duerfen nur EIN Vollbild
    /// ausloesen — sonst legt ein Zuschauer mit PLI-Sturm den Encoder lahm.
    #[test]
    fn drossel_fasst_dichte_anforderungen_zusammen() {
        let d = Drossel::neu();
        assert!(d.anfordern_und_abholen(std::time::Duration::ZERO));
        assert!(!d.anfordern_und_abholen(std::time::Duration::from_millis(10)));
    }

    /// Nach dem Mindestabstand geht wieder eines durch.
    #[test]
    fn nach_dem_mindestabstand_wieder_erlaubt() {
        let d = Drossel::neu();
        assert!(d.anfordern_und_abholen(std::time::Duration::ZERO));
        assert!(d.anfordern_und_abholen(DROSSEL_DECKEL + std::time::Duration::from_millis(1)));
    }

    /// Der Deckel darf der gestreckten Vorgabe NICHT folgen: sonst verwirft
    /// der Sender eine Anforderung den ganzen Vollbild-Abstand lang.
    /// Gegenstueck zu `drossel_deckel_entspricht_dem_unbedenklichen_abstand`
    /// im Linux-Sidecar.
    #[test]
    fn deckel_haengt_am_unbedenklichen_abstand() {
        assert_eq!(
            DROSSEL_DECKEL.as_secs_f32(),
            crate::encode::KEYFRAME_SEKUNDEN_UNBEDENKLICH
        );
    }
}
```

**Sichtbarkeit beachten:** `KEYFRAME_SEKUNDEN_UNBEDENKLICH` ist heute modulprivat (`encode/mod.rs:36`, schlicht `const`). Der dritte Test greift von `keyframe.rs` darauf zu und braucht deshalb `pub(crate) const`. Das ist die kleinstmögliche Öffnung — **nicht** `pub` machen, die Konstante gehört nicht in die Schnittstelle der Bibliothek.

- [ ] **Schritt 2: Test laufen lassen und Fehlschlag bestätigen**

```bash
cd streaming/mac-hq-sidecar && cargo test --lib keyframe 2>&1 | tail -10
```

Erwartung: Kompilierfehler, `Drossel` gibt es nicht.

- [ ] **Schritt 3: Die Drossel implementieren**

Zeitgesteuert über einen hereingereichten `Duration`-Wert statt über `Instant::now()`, damit sie ohne Warten prüfbar ist — dasselbe Muster, mit dem `abstand_sekunden_aus` von der Umgebung getrennt wurde.

- [ ] **Schritt 4: Die Anforderung an den Encoder durchreichen**

`encode/hw.rs::wrap` (Zeile 108-138) setzt heute `format`, `width`, `height`, `pts`, `data[3]`, `buf[0]`, `hw_frames_ctx` — `pict_type` bleibt unberührt. Ergänze einen Parameter, oder setze das Feld in `push_pixel_buffer` zwischen `wrap` (Zeile 336) und `avcodec_send_frame` (Zeile 337).

- [ ] **Schritt 5: Die Einhängung verbinden**

In `mac-hq-sidecar/src/whip.rs` zeigt `vollbild_anfordern` jetzt auf `crate::keyframe::request_keyframe`.

- [ ] **Schritt 6: Eine `keyframe`-Op ergänzen**

Linux und Windows haben `ops/keyframe.rs`; macOS hat keine (`ops/mod.rs:20-28`, `dispatch.rs:31-41`). Für Gleichstand ergänzen.

- [ ] **Schritt 7: Tests grün, dann committen**

- [ ] **Schritt 8: Von Hand prüfen — das ist der eigentliche Nachweis**

Zwei Clients: ein Mac sendet, ein zweiter Rechner tritt **später** bei. Der Beitretende muss sein erstes Bild in Sekundenbruchteilen bekommen, nicht nach bis zu 60 s. Ohne diesen Nachweis darf Aufgabe 7 nicht laufen.

---

## Aufgabe 7: Die Sonderfälle zurücknehmen

**Erst wenn Aufgabe 6 nachgewiesen ist.** Diese Aufgabe nimmt die Schutzmassnahmen weg, die den fehlenden Rückkanal ausglichen — sie sind ohne den Nachweis das Einzige, was Zuschauer vor einem schwarzen Bild bewahrt.

**Dateien:** `mac-hq-sidecar/src/encode/mod.rs`, `web/src/lib/stream/settings.svelte.ts`, `mac-hq-sidecar/README.md`, `CLAUDE.md`

- [ ] **Schritt 1: Alle Fundstellen suchen, bevor eine geändert wird**

```bash
cd /Users/michael/Documents/pulse
grep -rn "KEYFRAME_SEKUNDEN_UNBEDENKLICH" streaming/
grep -rn "isMac\|kein Rueckkanal\|kein Rückkanal" web/src/lib/stream/ streaming/mac-hq-sidecar/ CLAUDE.md
```

- [ ] **Schritt 2: Die Vorgabe auf 60 s ziehen**

In `abstand_sekunden_aus` (`encode/mod.rs:73-95`) wird `const VORGABE: f32 = KEYFRAME_SEKUNDEN_UNBEDENKLICH;` zu den regulären 60 s, wie Linux und Windows.

**`KEYFRAME_SEKUNDEN_UNBEDENKLICH` bleibt bestehen** — die Konstante trägt weiterhin den Drossel-Deckel aus Aufgabe 6 und die Warnschwelle. Genau diese zwei Zahlen dürfen der Vorgabe nicht folgen.

- [ ] **Schritt 3: Die beiden Tests umschreiben, nicht löschen**

`ohne_rueckkanal_gilt_der_unbedenkliche_abstand` (Zeile 400-404) sichert heute genau das ab, was hier wegfällt. Er wird ersetzt durch einen Test, der festhält, dass macOS jetzt am regulären Abstand hängt — **und warum das jetzt zulässig ist** (es gibt einen Anforderungspfad). Ebenso `bilder_aus_sekunden_nie_null` (Zeile 428-432), dessen `== 120` kippt.

- [ ] **Schritt 4: Die Warnung umbauen**

`warne_bei_langem_abstand_ohne_rueckkanal` (Zeile 97-113) wird zur Prüfung, dass der Rückkanal wirklich steht: warnen, wenn ein langer Abstand mit einem Sendeweg **ohne** Rückkanal zusammentrifft (also über RTMPS).

- [ ] **Schritt 5: Den H.264-Zwangsrückfall entfernen**

`encode/mod.rs:195-203` — er greift nur für `format_hint == Some("whip")`, also für ffmpegs Muxer. Da dieser Weg für `http(s)://` nicht mehr genommen wird, entfällt der Rückfall. **Der andere Rückfall bleibt**: `videotoolbox_encoder` (Zeile 115-128) fällt auf `h264_videotoolbox` zurück, wenn `caps::supports_codec` nein sagt — das ist eine Fähigkeitsprüfung der Hardware und hat mit WHIP nichts zu tun.

- [ ] **Schritt 6: AV1 in der Oberfläche wieder anbieten**

`web/src/lib/stream/settings.svelte.ts:156-158` — das `!isMac()` in `av1Nutzbar` fällt, samt der Begründung darüber (Zeile 136-155). Die Zeile *„Wer hier je das `!isMac()` entfernt, baut vorher den eigenen WHIP-Sender für macOS"* hat ihren Zweck erfüllt und wird durch einen Vermerk ersetzt, dass er gebaut ist.

- [ ] **Schritt 7: Die Doku nachziehen**

`mac-hq-sidecar/README.md` (Abschnitt „No back channel — and what follows from it") und `CLAUDE.md` (der Absatz „macOS ist der Sonderfall: kein Rückkanal", dazu die Erwähnungen beim Vollbild-Abstand und bei `pushProtokoll`).

- [ ] **Schritt 8: Volle Prüfung**

```bash
cd /Users/michael/Documents/pulse
REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q
cd web && pnpm check && pnpm build && pnpm test:unit
```

- [ ] **Schritt 9: Committen**

---

## Aufgabe 8: Version und Changelog

- [ ] **Schritt 1: Version bumpen** in `desktop/package.json` — Pflicht, weil `streaming/win-hq-sidecar/**` berührt ist und über den Installer ausgeliefert wird.
- [ ] **Schritt 2: Changelog-Eintrag** in `web/static/changelog.json`, neuer Eintrag oben. Inhalt: Mac-Nutzer bekommen AV1 zurück und ein deutlich schnelleres erstes Bild beim Zuschauen. **Stil vorher abstimmen, echte Umlaute, keine Emojis.**
- [ ] **Schritt 3: Volle Prüfung und Commit.**

---

## Von Hand prüfen (nicht automatisierbar)

- **Windows-Regression zuerst.** Der Sidecar geht über den Installer an Bestandsnutzer; ein echter Stream von einer Windows-Maschine ist Pflicht, grüne Tests genügen nicht.
- **Linux-Regression**, wegen der REMB-Änderung aus Aufgabe 4.
- **macOS**: WHIP-Push, AV1 über den eigenen Weg, PLI löst ein Vollbild aus, RTMPS-Regression.
- **Der eigentliche Nachweis**: ein später beitretender Zuschauer bekommt sein erstes Bild sofort.

## Offen, bewusst

- **Die Pacer-Frage.** Welcher der beiden Algorithmen besser ist, bleibt unbeantwortet. Sie ist umgangen, nicht gelöst — und `mac-hq-sidecar/src/whip/pacer.rs` ist eine dritte Kopie des Linux-Algorithmus, die mit ihm zu ziehen ist, solange das so bleibt. Das ist der wissentlich in Kauf genommene Preis.
- **Der 60-s-Takt unter echtem Paketverlust** ist ungemessen (die Messreihe lief auf sauberer Leitung, null Nachlieferungen — `linux .../encode/mod.rs:770-774`). Das gilt nach diesem Vorhaben auch für macOS.

## Abschluss

Wenn alle Aufgaben stehen und alle Prüfungen grün sind, die Unter-Skill `superpowers:finishing-a-development-branch` verwenden. **Der Merge nach `main` ist ein Prod-Deploy und braucht ausdrückliche Freigabe.**
