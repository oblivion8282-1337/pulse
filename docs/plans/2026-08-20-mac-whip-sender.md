# Eigener WHIP-Sender für macOS — Umsetzungsplan

> **Für agentische Bearbeiter:** ERFORDERLICHE UNTER-SKILL: `superpowers:subagent-driven-development` (empfohlen) oder `superpowers:executing-plans`. Die Schritte tragen Checkbox-Syntax (`- [ ]`).

**Ziel:** Der mac-Sidecar sendet über einen eigenen WebRTC-Sendeweg statt über ffmpegs WHIP-Muxer und bekommt damit einen RTCP-Rückkanal. Folge: der Vollbild-Abstand darf von 2 s auf die regulären 60 s.

**Aufbau:** `mac-hq-sidecar/src/whip/` wird eine Kopie der Linux-Fassung. **Windows und Linux werden nicht angefasst** — sie bauen auf einem Mac nicht, ein hier geschriebener, aber nie übersetzter Adapter an ausgeliefertem Code wäre schlechter als keiner. Alles in diesem Plan ist auf dieser Maschine prüfbar.

**Technik:** Rust, `webrtc` 0.17 (unverändert von crates.io), `tokio`, `rtcp`, `reqwest`/rustls, VideoToolbox über `ffmpeg-next` 8.0.

**Entwurf:** `docs/specs/2026-08-20-mac-whip-sender-design.md` — **zuerst lesen**, besonders „Was dieser Entwurf zurücknimmt".

**Zweig:** `feat/mac-whip-sender`

## Globale Randbedingungen

- **Nie direkt auf `main`.** Landen nur über GitHub-PR via `bash scripts/ship.sh`. Merge = Prod-Deploy, braucht Freigabe.
- **Kein `git push`, keine GitHub-CLI ohne Freigabe.**
- **Windows- und Linux-Sidecar NICHT anfassen.** Kein `streaming/win-hq-sidecar/**`, kein `streaming/linux-hq-sidecar/**` — ausser lesend als Vorlage. Wer meint, dort etwas ändern zu müssen, hält an und fragt.
- **Test-Gate lokal.** Vor jedem Commit `cargo test` im mac-Sidecar. Vor dem Push zusätzlich pytest, `pnpm check`, `pnpm build`, Playwright.
- **Keine neuen Abhängigkeiten ausser den im Plan genannten**, und die in genau den Fassungen der anderen Sidecars.
- **Niemals Stream-Keys oder Tokens loggen.** Jede Meldung, die eine Push-URL enthält, geht durch die Redaktion.
- **Code-Größen-Policy:** ≤ 350 Zeilen (hart 500), ausgenommen Tests.
- **Sprache:** Rust-Doc-Kommentare in diesen Crates sind ASCII (`ae`/`oe`/`ue`/`ss`). Beim Kopieren Kommentare **wortgleich mitnehmen** — sie tragen Messwerte, die nirgends sonst stehen. Commit-Messages und Changelog mit echten Umlauten. **Keine Emojis.**
- **Bau-Umgebung:** vor jedem `cargo`-Aufruf
  `export PKG_CONFIG_PATH="$HOME/src/ffmpeg-openssl/lib/pkgconfig:$PKG_CONFIG_PATH"`
- **Alle Befehle im Vordergrund**, kein `run_in_background`.

## Dateiübersicht

| Datei | Verantwortung | Aufgabe |
|---|---|---|
| `mac-hq-sidecar/src/redact.rs` | **neu** — Token-Redaktion, löst eine bestehende Doppelung auf | 1 |
| `mac-hq-sidecar/src/zeitbasis.rs` | **neu** — RTP-Takt, damit `av1.rs` wortgleich bleiben kann | 1 |
| `mac-hq-sidecar/Cargo.toml` | webrtc/rtcp/bytes/tokio/reqwest | 1 |
| `mac-hq-sidecar/src/whip/{av1,sdp,mod,pacer}.rs` | **neu** — der Sendeweg | 2 |
| `mac-hq-sidecar/tests/zwillinge.rs` | **neu** — hält `av1.rs`/`sdp.rs` gegen Linux | 2 |
| `mac-hq-sidecar/src/encode/mod.rs` | `enum Ausgabe`, Anforderungspfad | 3, 4 |
| `mac-hq-sidecar/src/encode/audio.rs` | Ton-Senke | 3 |
| `mac-hq-sidecar/src/keyframe.rs` | **neu** — Anforderung + Drossel | 4 |
| `web/src/lib/stream/settings.svelte.ts` | `av1Nutzbar` | 5 |

---

## Aufgabe 1: Die Grundlagen, die der Sendeweg braucht

**Dateien:** neu `src/redact.rs`, `src/zeitbasis.rs`; ändern `Cargo.toml`, `src/lib.rs`, `src/ops/start.rs`, `src/encode/mod.rs`

**Hintergrund.** Die Linux-Fassung des Sendewegs greift auf drei crate-eigene Module zurück, von denen der mac-Sidecar zwei nicht hat: `crate::zeitbasis::{VIDEO_HZ, pts_aus_sekunden, takte_je_bild}` (in `av1.rs`) und `crate::redact::redact_url` (in `mod.rs`). Das dritte, `crate::encode::request_keyframe`, kommt in Aufgabe 4.

**Der `redact`-Befund.** Der mac-Sidecar hat die Redaktion **doppelt**: `src/ops/start.rs:196` und `src/encode/mod.rs:377`, beide `fn redact(url: &str) -> String`. Das ist eine sicherheitsrelevante Funktion in zwei Kopien; Windows und Linux führen dafür ein eigenes Modul. Ohne Aufräumen entstünde jetzt eine dritte. Deshalb wandert sie in ein Modul, und **beide** bestehenden Definitionen verschwinden.

- [ ] **Schritt 1: Die beiden `redact`-Fassungen vergleichen**

```bash
cd /Users/michael/Documents/pulse/streaming/mac-hq-sidecar
sed -n '190,205p' src/ops/start.rs
sed -n '370,390p' src/encode/mod.rs
```

**Sind sie nicht identisch, halte an und berichte** — dann hat eine der beiden Stellen eine Eigenheit, die erst zu verstehen ist. Ein stillschweigendes „ich nehme die längere" wäre hier falsch.

- [ ] **Schritt 2: Den Test schreiben, bevor das Modul existiert**

Neue Datei `src/redact.rs`. Der Name der Funktion ist `redact_url`, wie in der Linux-Fassung — dann bleibt `whip/mod.rs` beim Kopieren unverändert.

```rust
//! Token aus einer Push-URL entfernen, bevor sie in eine Meldung geht.
//!
//! **Hier stand nichts — die Funktion lag bis zum 2026-08-20 ZWEIMAL im
//! Sidecar** (`ops/start.rs` und `encode/mod.rs`), beide Male gleich. Mit dem
//! eigenen Sendeweg waere eine dritte Kopie dazugekommen. Windows und Linux
//! fuehren dafuer laengst ein eigenes Modul; dieses zieht nach.
//!
//! Der Name `redact_url` ist von der Linux-Fassung uebernommen, damit die
//! kopierten Sendeweg-Dateien unveraendert bleiben koennen.

#[cfg(test)]
mod tests {
    use super::*;

    /// Ein Token darf unter keinen Umstaenden in einer Meldung landen — nicht
    /// im Log, nicht in einer Fehlermeldung, nirgends.
    #[test]
    fn token_verschwindet() {
        let roh = "https://howispulse.com/whep/channel-1-2/whip?token=geheim123";
        let sauber = redact_url(roh);
        assert!(!sauber.contains("geheim123"), "Token steht noch drin: {sauber}");
        assert!(sauber.contains("howispulse.com"), "Host soll lesbar bleiben: {sauber}");
    }

    /// Eine URL ohne Token bleibt brauchbar — sonst nuetzt die Meldung nichts.
    #[test]
    fn ohne_token_bleibt_lesbar() {
        let roh = "rtmps://howispulse.com:1936/channel-1-2";
        assert!(redact_url(roh).contains("howispulse.com"));
    }
}
```

- [ ] **Schritt 3: Test laufen lassen, Fehlschlag bestätigen**

```bash
export PKG_CONFIG_PATH="$HOME/src/ffmpeg-openssl/lib/pkgconfig:$PKG_CONFIG_PATH"
cargo test redact 2>&1 | tail -10
```

Erwartung: Kompilierfehler, `redact_url` gibt es nicht.

- [ ] **Schritt 4: Die Funktion aus der bestehenden Fassung übernehmen**

Nimm den Rumpf der vorhandenen `redact`-Funktion (aus Schritt 1) wortgleich, benenne sie `redact_url`, mach sie `pub`. Erfinde nichts Neues — die bestehende Fassung ist erprobt.

`src/lib.rs`: `pub mod redact;` ergänzen.

- [ ] **Schritt 5: Beide alten Definitionen entfernen und die Aufrufer umbiegen**

`src/ops/start.rs` und `src/encode/mod.rs`: die lokalen `fn redact` löschen, Aufrufe auf `crate::redact::redact_url` ziehen.

```bash
grep -rn "fn redact\|redact(" src/ | grep -v "src/redact.rs"
```

Erwartung danach: nur noch Aufrufe von `redact_url`, keine zweite Definition.

- [ ] **Schritt 6: `zeitbasis.rs` anlegen**

Der Sendeweg braucht aus `linux-hq-sidecar/src/zeitbasis.rs` (179 Zeilen) drei Dinge: `VIDEO_HZ`, `pts_aus_sekunden`, `takte_je_bild`. **Übernimm genau diese drei samt ihren Doc-Kommentaren** — sie begründen die 90 kHz und die Aufrundung. Den Rest der Linux-Datei nicht mitnehmen, was nicht gebraucht wird.

Ergänze im Modulkopf, woher es stammt und dass es ein Zwilling ist:

```rust
//! **Dritte Fassung dieser Rechnung im Repo** (2026-08-20), neben
//! `win-hq-sidecar/src/zeitbasis.rs` und `linux-hq-sidecar/src/zeitbasis.rs`.
//! Uebernommen wurde nur, was der Sendeweg braucht. Wer hier etwas aendert,
//! sieht dort nach — und umgekehrt.
```

`src/lib.rs`: `pub mod zeitbasis;`

- [ ] **Schritt 7: Die Abhängigkeiten ergänzen**

`Cargo.toml`. Die Fassungen müssen mit `linux-hq-sidecar/Cargo.toml` übereinstimmen — lies sie dort ab, statt sie zu raten:

```toml
webrtc = "0.17"
rtcp = "0.17"
bytes = "1"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "time", "sync"] }
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }
```

- [ ] **Schritt 8: Bauen und testen**

```bash
cargo test 2>&1 | tail -10
cargo clippy --all-targets 2>&1 | grep -E "^(warning|error)" | head
```

Erwartung: grün, beide `redact`-Tests laufen.

- [ ] **Schritt 9: Committen**

```bash
git add streaming/mac-hq-sidecar
git commit -F - <<'EOF'
refactor(mac): Redaktion und Zeitbasis als eigene Module

Vorarbeit fuer den eigenen WHIP-Sendeweg, der beides braucht.

Der Sidecar trug die Token-Redaktion ZWEIMAL — in ops/start.rs und in
encode/mod.rs, beide Male dieselbe Funktion. Bei einer
sicherheitsrelevanten Funktion ist das eine Kopie zu viel, und mit dem
Sendeweg waere eine dritte dazugekommen. Windows und Linux fuehren dafuer
laengst ein eigenes Modul; dieses zieht nach. Der Name redact_url ist von
Linux uebernommen, damit die kopierten Sendeweg-Dateien unveraendert
bleiben koennen.

zeitbasis.rs uebernimmt aus der Linux-Fassung nur, was der Sendeweg
braucht: VIDEO_HZ, pts_aus_sekunden, takte_je_bild samt ihren
Begruendungen. Es ist damit die dritte Fassung dieser Rechnung im Repo —
im Kopf vermerkt, damit die naechste Aenderung die anderen beiden findet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Aufgabe 2: Der Sendeweg, kopiert und festgenagelt

**Dateien:** neu `src/whip/{mod,av1,sdp,pacer}.rs`, `tests/zwillinge.rs`; ändern `src/lib.rs`

**Hintergrund.** `av1.rs` und `sdp.rs` sind zwischen Windows und Linux in der Logik **bitgleich** (496 bzw. 220 Codezeilen). Sie werden **wortgleich** übernommen und per Test festgehalten. `mod.rs` und `pacer.rs` können nicht wortgleich sein — sie greifen auf crate-eigene Module zurück.

Vorlage ist durchgehend `linux-hq-sidecar/src/whip/`.

- [ ] **Schritt 1: Die vier Dateien kopieren**

```bash
cd /Users/michael/Documents/pulse/streaming
mkdir -p mac-hq-sidecar/src/whip
cp linux-hq-sidecar/src/whip/{mod,av1,sdp,pacer}.rs mac-hq-sidecar/src/whip/
```

- [ ] **Schritt 2: Den Zwillings-Test schreiben, bevor angepasst wird**

`mac-hq-sidecar/tests/zwillinge.rs`, Muster von `pulse-player/tests/zwillinge.rs`:

```rust
//! Haelt die wortgleichen Teile des Sendewegs gegen die Linux-Fassung.
//!
//! **Warum ein Test und kein Kommentar.** Beim aelteren Paar `zeitbasis.rs`
//! ist eine Abweichung unbemerkt entstanden, weil nur ein Kommentar davor
//! warnte. `include_str!` zieht beide Dateien zur Uebersetzungszeit herein;
//! laufen sie auseinander, wird dieser Test rot und nicht erst der Zuschauer
//! schwarz.
//!
//! **Nur `av1.rs` und `sdp.rs`.** `mod.rs` und `pacer.rs` greifen auf
//! crate-eigene Module zurueck und koennen nicht wortgleich sein; sie tragen
//! stattdessen einen Kopfvermerk.
//!
//! Der Test liegt AUSSERHALB der Zwillinge — laege er darin, machte er sie
//! selbst ungleich.

#[test]
fn av1_ist_wortgleich_mit_linux() {
    let hier = include_str!("../src/whip/av1.rs");
    let dort = include_str!("../../linux-hq-sidecar/src/whip/av1.rs");
    assert_eq!(
        hier, dort,
        "src/whip/av1.rs ist von linux-hq-sidecar/src/whip/av1.rs abgewichen. \
         Wer dort etwas lernt, traegt es hier nach — und umgekehrt."
    );
}

#[test]
fn sdp_ist_wortgleich_mit_linux() {
    let hier = include_str!("../src/whip/sdp.rs");
    let dort = include_str!("../../linux-hq-sidecar/src/whip/sdp.rs");
    assert_eq!(
        hier, dort,
        "src/whip/sdp.rs ist von linux-hq-sidecar/src/whip/sdp.rs abgewichen."
    );
}
```

- [ ] **Schritt 3: Test laufen lassen — er muss GRÜN sein**

```bash
export PKG_CONFIG_PATH="$HOME/src/ffmpeg-openssl/lib/pkgconfig:$PKG_CONFIG_PATH"
cargo test --test zwillinge 2>&1 | tail -10
```

Hier ist der grüne Lauf der Beleg (frisch kopiert = gleich). **Wird er rot, hast du beim Kopieren etwas verändert.**

Gegenprobe, dass der Test überhaupt greift: ändere versuchsweise ein Zeichen in `src/whip/av1.rs`, lass den Test laufen (muss rot werden), mach es rückgängig. Ein Test, der nie rot wird, ist keiner.

- [ ] **Schritt 4: `mod.rs` und `pacer.rs` anpassen**

Nur die Rückgriffe, die es auf macOS anders gibt:
- `crate::encode::request_keyframe()` → gibt es noch nicht (Aufgabe 4). Setze vorerst einen benannten Platzhalter, der **nicht still schluckt**: eine Funktion `crate::keyframe::request_keyframe()`, die in Aufgabe 4 gebaut wird. Bis dahin ist der Bau rot — das ist gewollt und wird in Aufgabe 4 grün.
- `crate::redact::redact_url` → existiert seit Aufgabe 1, unverändert.
- `crate::zeitbasis::…` → existiert seit Aufgabe 1, unverändert.

In **beide** Dateien einen Kopfvermerk:

```rust
//! **Kopie aus `linux-hq-sidecar/src/whip/` (2026-08-20).** Nicht wortgleich —
//! die crate-eigenen Rueckgriffe unterscheiden sich. Was hier an der LOGIK
//! geaendert wird, gehoert dort nachgetragen; `tests/zwillinge.rs` deckt nur
//! `av1.rs` und `sdp.rs` ab, diese Datei nicht.
```

- [ ] **Schritt 5: `src/lib.rs`** → `pub mod whip;`

- [ ] **Schritt 6: Committen** (der Bau ist an dieser Stelle noch rot — im Commit-Text sagen, warum)

---

## Aufgabe 3: Der Sidecar sendet selbst

**Dateien:** `src/encode/mod.rs`, `src/encode/audio.rs`

**Hintergrund.** Heute ist `MuxWriter` an drei Stellen hart verdrahtet: Feld `mux: MuxWriter`, `self.mux.send(packet)` im `drain`, und `mux: &MuxWriter` im ganzen Audio-Pfad. Vorbild ist `linux-hq-sidecar/src/encode/mod.rs:60-66`:

```rust
enum Ausgabe {
    Mux(MuxWriter),
    Whip(std::sync::Arc<crate::whip::WhipSender>),
}
```

**Zwei Fallen, beide aus der Linux-Fassung abzulesen:**
1. Über den Muxer gehen Pakete mit `rescale_ts` und Stream-Index, über WHIP **ohne beides** (`w.send(daten, packet.pts())`).
2. Beim WHIP-Weg ist `global_header = false` — SPS/PPS müssen über RTP im Strom mitlaufen, nicht im Container-Kopf.

Die Naht liegt hinter `VideoEncoder`; `stream_controller.rs` bleibt unberührt.

- [ ] **Schritt 1:** `url_format_hint` — für `http(s)://` nicht mehr an den Muxer. RTMPS und SRT bleiben unverändert.
- [ ] **Schritt 2:** `enum Ausgabe` einführen, Feld umstellen, Gabelung in `VideoEncoder::start` vor dem Öffnen des Outputs.
- [ ] **Schritt 3:** Gabelung im `drain` — mit den zwei Fallen oben.
- [ ] **Schritt 4:** Audio-Pfad auf eine `TonSenke` umstellen (Vorbild `linux .../encode/audio.rs`).
- [ ] **Schritt 5:** `cargo test` + `cargo clippy` grün.
- [ ] **Schritt 6: WHIP-Rauchtest** gegen ein Wegwerf-MediaMTX:

```bash
docker run --rm -p 8889:8889 -p 8189:8189/udp \
  -v "$PWD/test-mediamtx.yml:/mediamtx.yml" bluenviron/mediamtx:1.19.1
```

Minimal-Config: `webrtc: yes`, `webrtcAddress: :8889`, `webrtcLocalUDPAddress: :8189`, `moq: no`, `hls: no`, `paths: {all_others:}`. Dann `cargo run --release --example encode_smoke -- http://127.0.0.1:8889/whipsmoke/whip …` (argv-Konvention im Beispiel nachsehen).

Erwartung: WHIP-Handshake, MediaMTX meldet `stream is available and online`, sauberer Abbau.

- [ ] **Schritt 7: RTMPS-Regression** — derselbe Lauf gegen `rtmps://…`. Der Muxer-Weg muss unverändert funktionieren.
- [ ] **Schritt 8: Committen**

---

## Aufgabe 4: Der Vollbild-Anforderungspfad

**Dateien:** neu `src/keyframe.rs`; ändern `src/encode/hw.rs`, `src/encode/mod.rs`, `src/dispatch.rs`, `src/ops/`

**Hintergrund.** Der Weg über VideoToolbox ist nachgewiesen vorhanden:

```bash
nm -u /opt/homebrew/opt/ffmpeg/lib/libavcodec.dylib | grep ForceKeyFrame
# _kVTEncodeFrameOptionKey_ForceKeyFrame
```

`videotoolboxenc.c` setzt diesen Schlüssel, wenn ein Eingabe-Frame `pict_type == AV_PICTURE_TYPE_I` trägt — unabhängig vom HW-Frames-Kontext, der Zero-Copy-Pfad bleibt intakt.

**Ein Vorteil gegenüber Linux und Windows:** dort muss `pict_type` pro Bild zurückgesetzt werden, weil die Frames aus einem Pool stammen. Auf macOS wird der `AVFrame` je Bild frisch alloziert (`hw.rs`) und sofort freigegeben — das Problem entsteht gar nicht.

**Die Drossel ist Pflicht.** Ohne sie legt ein Zuschauer mit PLI-Sturm den Encoder lahm.

- [ ] **Schritt 1: Die Tests zuerst**

`src/keyframe.rs`. Die Drossel nimmt die Zeit als Parameter statt `Instant::now()` zu rufen — dann ist sie ohne Warten prüfbar (dasselbe Muster, mit dem `abstand_sekunden_aus` von der Umgebung getrennt wurde).

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Zwei Anforderungen dicht hintereinander duerfen nur EIN Vollbild
    /// ausloesen — sonst legt ein Zuschauer mit PLI-Sturm den Encoder lahm.
    #[test]
    fn drossel_fasst_dichte_anforderungen_zusammen() {
        let d = Drossel::neu();
        assert!(d.anfordern_und_abholen(Duration::ZERO));
        assert!(!d.anfordern_und_abholen(Duration::from_millis(10)));
    }

    /// Nach dem Mindestabstand geht wieder eines durch.
    #[test]
    fn nach_dem_mindestabstand_wieder_erlaubt() {
        let d = Drossel::neu();
        assert!(d.anfordern_und_abholen(Duration::ZERO));
        assert!(d.anfordern_und_abholen(DROSSEL_DECKEL + Duration::from_millis(1)));
    }

    /// Der Deckel darf der gestreckten Vorgabe NICHT folgen: sonst verwirft der
    /// Sender eine Anforderung den ganzen Vollbild-Abstand lang. Gegenstueck zu
    /// `drossel_deckel_entspricht_dem_unbedenklichen_abstand` im Linux-Sidecar.
    #[test]
    fn deckel_haengt_am_unbedenklichen_abstand() {
        assert_eq!(
            DROSSEL_DECKEL.as_secs_f32(),
            crate::encode::KEYFRAME_SEKUNDEN_UNBEDENKLICH
        );
    }
}
```

**Sichtbarkeit:** `KEYFRAME_SEKUNDEN_UNBEDENKLICH` ist heute modulprivat und braucht `pub(crate)` — die kleinstmögliche Öffnung, **nicht** `pub`.

- [ ] **Schritt 2:** Test laufen lassen, Fehlschlag bestätigen (`Drossel` gibt es nicht).
- [ ] **Schritt 3:** Drossel implementieren. Vorbild `linux .../encode/mod.rs` (`take_keyframe_request`, `KEYFRAME_DROSSEL_DECKEL_MS = 2_000`).
- [ ] **Schritt 4:** `pict_type` durchreichen — in `hw.rs::wrap` als Parameter oder in `push_pixel_buffer` zwischen `wrap` und `avcodec_send_frame`.
- [ ] **Schritt 5:** `whip/mod.rs` ruft jetzt `crate::keyframe::request_keyframe()` — der Bau aus Aufgabe 2 wird hier grün.
- [ ] **Schritt 6:** Eine `keyframe`-Op ergänzen (Linux und Windows haben `ops/keyframe.rs`, macOS nicht).
- [ ] **Schritt 7:** `cargo test` + `clippy` grün, committen.
- [ ] **Schritt 8: Der eigentliche Nachweis, von Hand.** Zwei Clients: der Mac sendet, ein zweiter tritt **später** bei. Er muss sein erstes Bild in Sekundenbruchteilen bekommen. **Ohne diesen Nachweis darf Aufgabe 5 nicht laufen.**

---

## Aufgabe 5: Den Sonderfall zurücknehmen

**Erst nach dem Nachweis aus Aufgabe 4.** Diese Aufgabe nimmt die Schutzmassnahme weg, die den fehlenden Rückkanal ausglich.

- [ ] **Schritt 1: Alle Fundstellen suchen, bevor eine geändert wird**

```bash
grep -rn "KEYFRAME_SEKUNDEN_UNBEDENKLICH" streaming/
grep -rn "isMac\|kein Rueckkanal\|kein Rückkanal" web/src/lib/stream/ streaming/mac-hq-sidecar/ CLAUDE.md
```

- [ ] **Schritt 2:** Vorgabe in `abstand_sekunden_aus` auf die regulären 60 s (wie Linux und Windows). **`KEYFRAME_SEKUNDEN_UNBEDENKLICH` bleibt bestehen** — es trägt den Drossel-Deckel aus Aufgabe 4 und die Warnschwelle; genau diese zwei Zahlen dürfen der Vorgabe nicht folgen.
- [ ] **Schritt 3:** Die beiden Tests **ersetzen, nicht löschen**: `ohne_rueckkanal_gilt_der_unbedenkliche_abstand` und `bilder_aus_sekunden_nie_null` (dessen `== 120` kippt). Die neue Fassung hält fest, dass macOS jetzt am regulären Abstand hängt — und warum das zulässig ist.
- [ ] **Schritt 4:** `warne_bei_langem_abstand_ohne_rueckkanal` → Prüfung, dass der Rückkanal wirklich steht (warnen, wenn langer Abstand auf einen Sendeweg **ohne** Rückkanal trifft, also RTMPS).
- [ ] **Schritt 5:** Den H.264-Zwangsrückfall für den WHIP-Muxer entfernen. **Der andere Rückfall bleibt**: `videotoolbox_encoder` fällt auf `h264_videotoolbox` zurück, wenn `caps::supports_codec` nein sagt — Hardware-Fähigkeit, nichts mit WHIP zu tun.
- [ ] **Schritt 6:** `!isMac()` in `av1Nutzbar` fällt. **Die Begründung darüber wird ersetzt, nicht gelöscht** — und sie muss ehrlich sein: der Muxer-Grund ist weg, aber AV1 bleibt auf heutiger Mac-Hardware unnutzbar, weil FFmpeg 8.0.1 keinen `av1_videotoolbox` hat und kein Apple-Chip AV1 encodiert. Es bleibt bei `gpuHasAv1`, und das ist der richtige Test.
- [ ] **Schritt 7:** `mac-hq-sidecar/README.md` und `CLAUDE.md` nachziehen.
- [ ] **Schritt 8:** Version-Bump in `desktop/package.json` + Changelog (Stil abstimmen, echte Umlaute, keine Emojis). Inhalt: beitretende Zuschauer sehen sofort ein Bild.
- [ ] **Schritt 9:** Volle Prüfung: `cargo test`, pytest, `pnpm check`, `pnpm build`, Playwright. Dann committen.

---

## Von Hand prüfen

- **Zwei Clients, später Beitritt** — der eigentliche Nachweis (Aufgabe 4, Schritt 8).
- **RTMPS-Regression** — der Muxer-Weg muss unverändert funktionieren.
- **Ein echter Stream aus der App**, nicht nur `encode_smoke`.

## Offen, bewusst

- **Die dritte Kopie des Sendewegs.** Die Extraktion in eine gemeinsame Crate bleibt der richtige nächste Schritt, sobald jemand mit Zugang zu Windows und Linux sie fahren kann. Der Zwillings-Test hält `av1.rs` und `sdp.rs` bis dahin zusammen.
- **AV1 auf macOS.** Nicht Teil dieses Vorhabens — es fehlt der Encoder, nicht der Sendeweg.
- **Die Pacer-Frage.** Ungemessen, bleibt es.

## Abschluss

Wenn alles steht: `superpowers:finishing-a-development-branch`. **Merge nach `main` ist ein Prod-Deploy und braucht Freigabe.**
