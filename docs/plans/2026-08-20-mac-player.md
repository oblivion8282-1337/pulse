# Nativer Player auf macOS — Umsetzungsplan

> **Für agentische Bearbeiter:** ERFORDERLICHE UNTER-SKILL: `superpowers:subagent-driven-development` (empfohlen) oder `superpowers:executing-plans`, um diesen Plan Aufgabe für Aufgabe umzusetzen. Die Schritte tragen Checkbox-Syntax (`- [ ]`) zum Mitverfolgen.

**Ziel:** `streaming/pulse-player/` dekodiert auf macOS in Hardware und wird mit dem DMG ausgeliefert.

**Aufbau:** Der Player baut auf macOS bereits (nachgewiesen 2026-08-20, `cargo check` grün in 36,68 s). Es fehlen drei Dinge: VideoToolbox als vierter hwaccel im bestehenden `Hwaccel`-Muster, ein Bündelweg für die private LGPL-FFmpeg, sowie CI-Trigger und Packaging. Für die letzten beiden existiert die Mechanik schon beim mac-Sidecar und wird geteilt statt verdoppelt.

**Technik:** Rust (rustc ≥ 1.95), `ffmpeg-next` 8.1 gegen eine selbstgebaute LGPL-FFmpeg, wgpu 30 (Metal), winit 0.30, GitHub Actions auf `macos-latest` (Apple Silicon), electron-builder.

**Entwurf:** `docs/specs/2026-08-20-mac-player-design.md`

**Zweig:** `feat/mac-player` (von frisch gepulltem `main`)

## Globale Randbedingungen

- **Nie direkt auf `main` arbeiten.** Alles auf `feat/mac-player`; landen nur über GitHub-PR mittels `bash scripts/ship.sh`. Merge nach `main` = Prod-Deploy und braucht ausdrückliche Freigabe.
- **Kein `git push` und keine GitHub-CLI ohne Freigabe.**
- **Test-Gate ist lokal, nicht in der CI.** Vor jedem Commit mit Code-Änderung: `cargo test` betroffener Crates. Vor dem Push zusätzlich `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q`, `cd web && pnpm check && pnpm build` und Playwright. Rot = kein Push.
- **Code-Größen-Policy:** Quelldateien ≤ 350 Zeilen (hart 500). Ausgenommen Tests und Migrationen.
- **Refactoring darf Verhalten nicht ändern.** Bricht ein Test nach einem Refactor, ist der Code kaputt, nicht der Test.
- **Keine neuen Abhängigkeiten ohne Rückfrage.** Insbesondere **keine GPL/AGPL-Abhängigkeiten** — FFmpeg bleibt überall LGPL und **dynamisch** gelinkt.
- **Niemals Stream-Keys oder Tokens loggen.**
- **`~/Dokumente/GPU_Screen_Recorder/` ist READ-ONLY.** Nur die Kopie unter `streaming/` anfassen.
- **Sprache im Repo:** Das Player-README und die Rust-Doc-Kommentare sind durchgehend ASCII (`ae`/`oe`/`ue`, `ss`). Diesen Stil in bestehenden Dateien fortführen. **Commit-Messages und Changelog-Einträge dagegen mit echten Umlauten** (ä/ö/ü/ß). **Keine Emojis, nirgends.**
- **Eine Behauptung wird nie an nur einer Stelle korrigiert.** Wer einen Wert, Pfad, Optionsnamen oder eine Verhaltensaussage ändert, sucht vorher alle Fundstellen (`grep -rn "<alter Wert>"`) und zieht sie mit.
- **Version-Bump ist Pflicht** (Aufgabe 7): `streaming/pulse-player/**` wird über den Windows-Installer ausgeliefert; ohne Bump in `desktop/package.json` ignoriert electron-updater die Änderung stillschweigend.

## Dateiübersicht

| Datei | Verantwortung | Aufgabe |
|---|---|---|
| `streaming/pulse-player/src/decode.rs` | `Hwaccel`-Aufzählung, Kandidatenliste, Geräteanlage | 1 |
| `streaming/pulse-player/src/decoderwahl.rs` | Doku der `PULSE_PLAYER_DECODER`-Kurzformen | 1 |
| `streaming/mac-hq-sidecar/scripts/bundle-dylibs.sh` | Mach-O-Bündelung, mehrere Binaries | 2 |
| `desktop/package.json` | `bundle:mac-sidecar`, `dist:mac`, `version` | 2, 5, 7 |
| `.github/workflows/mac-build.yml` | Pfad-Trigger, Cache, Player-Bau | 4 |
| `desktop/electron-builder.yml` | `mac.extraResources` | 5 |
| `streaming/pulse-player/README.md` | Stand der macOS-Unterstützung | 7 |
| `streaming/pulse-player/WISSENSSTAND.md` | Messbefunde nach GEMESSEN/VERMUTET | 7 |
| `web/static/changelog.json` | Nutzer-sichtbarer Eintrag | 7 |

`desktop/electron/player.ts` wird **nicht** geändert — Zweig 4 des Resolvers (`process.resourcesPath/hq-sidecar/<BINARY>`) greift auf macOS bereits, und `BINARY_NAME` ist außerhalb von Windows schon `pulse-player`.

---

## Aufgabe 1: VideoToolbox als vierter hwaccel

**Dateien:**
- Ändern: `streaming/pulse-player/src/decode.rs` (Aufzählung ~Z. 93–97, `geraetetyp` ~Z. 100–106, `beschreibung` ~Z. 108–114, `bildformat` ~Z. 166–172, `AUF_GPU_FORMATE` ~Z. 194–198, `Kandidat::nativ_hw` ~Z. 219–225, `geraet_kurzform` ~Z. 251, Gerätepfad-Auswahl ~Z. 742–743, `ZUERST_NATIV_HW` ~Z. 511)
- Ändern: `streaming/pulse-player/src/decoderwahl.rs` (Doku-Tabelle ~Z. 28)
- Test: `streaming/pulse-player/src/decode.rs` (Testmodul am Dateiende, ~Z. 2283 und ~Z. 2402)

**Schnittstellen:**
- Erzeugt: `Hwaccel::VideoToolbox` — vierte Variante der crate-privaten Aufzählung `Hwaccel`. Wird von Aufgabe 3 (Lauftest) und Aufgabe 8 (Zero-Copy) vorausgesetzt.

**Hintergrund für den Bearbeiter.** `Hwaccel` ist eine crate-private Aufzählung in `decode.rs`. Ihre Varianten sind **hwaccels, keine Decoder** — `Vaapi` und `D3d11va` sitzen auf dem *nativen* Decoder (`av1`, `h264`) und ändern nur, wer die Arbeit tut. `Cuda` fällt aus der Reihe: es sitzt auf `av1_cuvid`/`h264_cuvid` und ändert nur, *wohin* das Ergebnis geht. VideoToolbox verhält sich wie die ersten beiden. Auf macOS gibt es `*_videotoolbox` **nur encoderseitig** — es darf also kein Decoder-Name erfunden werden. Genau diese Verwechslung hat die Kandidatenliste bis 2026-08-01 zu Fall gebracht.

Zwei Listen werden absichtlich getrennt geführt und gegeneinander geprüft: `Hwaccel::bildformat()` und `AUF_GPU_FORMATE`. Leitete man eine aus der anderen ab, wäre die Prüfung eine Tautologie. Beide müssen erweitert werden.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

In `streaming/pulse-player/src/decode.rs`, im Testmodul: den bestehenden Test `geraetetyp_passt_zur_plattform` (~Z. 2283) um den macOS-Zweig erweitern. Er sieht heute so aus:

```rust
    #[test]
    fn geraetetyp_passt_zur_plattform() {
        let hw = candidates_mit(Codec::Av1, true, false)
            .into_iter()
            .find_map(|k| k.hw)
            .expect("hwaccel-Kandidat fehlt");
        #[cfg(windows)]
        assert_eq!(hw, Hwaccel::D3d11va);
        #[cfg(not(windows))]
        assert_eq!(hw, Hwaccel::Vaapi);
    }
```

Ersetze den Rumpf durch die dreifache Fallunterscheidung:

```rust
    #[test]
    fn geraetetyp_passt_zur_plattform() {
        let hw = candidates_mit(Codec::Av1, true, false)
            .into_iter()
            .find_map(|k| k.hw)
            .expect("hwaccel-Kandidat fehlt");
        #[cfg(windows)]
        assert_eq!(hw, Hwaccel::D3d11va);
        #[cfg(target_os = "macos")]
        assert_eq!(hw, Hwaccel::VideoToolbox);
        #[cfg(not(any(windows, target_os = "macos")))]
        assert_eq!(hw, Hwaccel::Vaapi);
    }
```

Und den Test `jeder_geraetetyp_hat_ein_abgeholtes_bildformat` (~Z. 2402) um die neue Variante ergänzen:

```rust
        for art in [
            Hwaccel::Vaapi,
            Hwaccel::D3d11va,
            Hwaccel::Cuda,
            Hwaccel::VideoToolbox,
        ] {
```

- [ ] **Schritt 2: Test laufen lassen und Fehlschlag bestätigen**

```bash
cd streaming/pulse-player
export PKG_CONFIG_PATH="$(brew --prefix ffmpeg)/lib/pkgconfig:$PKG_CONFIG_PATH"
cargo test --lib geraetetyp 2>&1 | tail -20
```

Erwartung: **Kompilierfehler**, `no variant or associated item named `VideoToolbox` found for enum `Hwaccel``. Das ist der gewünschte Fehlschlag — die Variante gibt es noch nicht.

- [ ] **Schritt 3: Die Variante und ihre vier Abbildungen anlegen**

In `streaming/pulse-player/src/decode.rs`. Erstens die Aufzählung (~Z. 93):

```rust
enum Hwaccel {
    Vaapi,
    D3d11va,
    Cuda,
    VideoToolbox,
}
```

Zweitens `geraetetyp()`:

```rust
            Self::Cuda => ffmpeg::ffi::AVHWDeviceType::AV_HWDEVICE_TYPE_CUDA,
            Self::VideoToolbox => ffmpeg::ffi::AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
```

Drittens `beschreibung()`:

```rust
            Self::Cuda => "Hardware (CUDA)",
            Self::VideoToolbox => "Hardware (VideoToolbox)",
```

Viertens `bildformat()`:

```rust
            Self::Cuda => ffmpeg::format::Pixel::CUDA,
            Self::VideoToolbox => ffmpeg::format::Pixel::VIDEOTOOLBOX,
```

Und `flags()` — VideoToolbox verhält sich wie VAAPI und D3D11VA, FFmpeg legt sich seinen eigenen Kontext an:

```rust
            Self::Vaapi | Self::D3d11va | Self::VideoToolbox => 0,
```

- [ ] **Schritt 4: `AUF_GPU_FORMATE` erweitern**

Die Länge im Typ mitziehen — sie steht als Zahl da (~Z. 194):

```rust
const AUF_GPU_FORMATE: [ffmpeg::format::Pixel; 4] = [
    ffmpeg::format::Pixel::VAAPI,
    ffmpeg::format::Pixel::D3D11,
    ffmpeg::format::Pixel::CUDA,
    ffmpeg::format::Pixel::VIDEOTOOLBOX,
];
```

- [ ] **Schritt 5: Den nativen hwaccel je Plattform wählen**

`Kandidat::nativ_hw` (~Z. 219) trägt heute zwei `cfg`-Zweige. Der dritte kommt dazu — die Reihenfolge der `cfg`-Attribute muss sich gegenseitig ausschließen, sonst sind zwei `let hw` gleichzeitig gültig:

```rust
    const fn nativ_hw(name: &'static str) -> Self {
        #[cfg(windows)]
        let hw = Some(Hwaccel::D3d11va);
        #[cfg(target_os = "macos")]
        let hw = Some(Hwaccel::VideoToolbox);
        #[cfg(not(any(windows, target_os = "macos")))]
        let hw = Some(Hwaccel::Vaapi);
        Self { name, hw }
    }
```

- [ ] **Schritt 6: Kurzform und Gerätepfad nachziehen**

`geraet_kurzform` (~Z. 251) — VideoToolbox ist ein plattform-eigener hwaccel und meldet wie die anderen beiden `hw`, damit `PULSE_PLAYER_DECODER=av1+hw` plattformübergreifend dasselbe bedeutet:

```rust
            Some(Hwaccel::Vaapi) | Some(Hwaccel::D3d11va) | Some(Hwaccel::VideoToolbox) => Some("hw"),
            Some(Hwaccel::Cuda) => Some("cuda"),
```

Die Gerätepfad-Auswahl (~Z. 742) — nur VAAPI braucht einen Pfad:

```rust
    let pfad = match art {
        Hwaccel::Vaapi => Some(vaapi_geraetepfad()),
        Hwaccel::D3d11va | Hwaccel::Cuda | Hwaccel::VideoToolbox => None,
    };
```

- [ ] **Schritt 7: Den nativen Weg auf macOS nach vorn stellen**

`ZUERST_NATIV_HW` (~Z. 511) steht heute auf `cfg!(windows)`. Auf macOS gibt es kein cuvid — `*_cuvid` würde dort nie öffnen, nur bei jedem Start einen vergeblichen Versuch kosten. Linux bleibt ausdrücklich unangetastet (dort ist `*_cuvid` mit CUDA-Gerät selbst der Anfang der Zero-Copy-Kette):

```rust
const ZUERST_NATIV_HW: bool = cfg!(not(target_os = "linux"));
```

Ergänze **über** der Konstanten, im bestehenden Doc-Kommentar, einen Absatz im Stil der Datei:

```rust
/// **Seit dem 2026-08-20 gilt das auch fuer macOS**, und deshalb steht hier
/// `not(linux)` statt `windows`: cuvid-Decoder gibt es auf macOS gar nicht, ein
/// Versuch kostet nur Startzeit. Die Aussage der Konstanten ist unveraendert —
/// ueberall ausser auf Linux zuerst der native Decoder mit dem
/// plattform-eigenen hwaccel.
```

- [ ] **Schritt 8: Tests laufen lassen und Erfolg bestätigen**

```bash
cd streaming/pulse-player
export PKG_CONFIG_PATH="$(brew --prefix ffmpeg)/lib/pkgconfig:$PKG_CONFIG_PATH"
cargo test --lib 2>&1 | tail -20
```

Erwartung: alle Tests grün, darunter `geraetetyp_passt_zur_plattform` und `jeder_geraetetyp_hat_ein_abgeholtes_bildformat`. Die Gesamtzahl liegt bei 326 plus den hier berührten.

- [ ] **Schritt 9: Clippy**

```bash
cargo clippy --all-targets 2>&1 | grep -E "^(warning|error)" | head -20
```

Erwartung: keine neuen Warnungen. `Hwaccel` trägt `#[allow(dead_code)]` — je Zielplattform ist genau eine Variante tot, das ist beabsichtigt und dokumentiert.

- [ ] **Schritt 10: Die Kurzform-Tabelle in `decoderwahl.rs` nachziehen**

`streaming/pulse-player/src/decoderwahl.rs` ~Z. 28 beschreibt heute:

```
//! | `av1+hw` | den nativen Decoder mit dem plattform-eigenen hwaccel (D3D11VA unter Windows, VAAPI unter Linux) |
```

Ersetze durch:

```
//! | `av1+hw` | den nativen Decoder mit dem plattform-eigenen hwaccel (D3D11VA unter Windows, VAAPI unter Linux, VideoToolbox unter macOS) |
```

- [ ] **Schritt 11: Committen**

```bash
git add streaming/pulse-player/src/decode.rs streaming/pulse-player/src/decoderwahl.rs
git commit -F - <<'EOF'
feat(player): VideoToolbox als vierter hwaccel

Auf macOS dekodierte der Player bisher rein in Software: die Aufzaehlung
Hwaccel kannte nur Vaapi, D3d11va und Cuda. VideoToolbox verhaelt sich wie
die ersten beiden — es sitzt auf dem nativen Decoder und aendert nur, wer
die Arbeit tut.

Kein neuer Decoder-Name: *_videotoolbox gibt es auf macOS ausschliesslich
encoderseitig, Dekodieren laeuft allein ueber den hwaccel. Genau diese
Verwechslung hatte die Kandidatenliste bis zum 2026-08-01 zu Fall
gebracht.

Beide absichtlich getrennt gefuehrten Listen sind mitgezogen —
Hwaccel::bildformat und AUF_GPU_FORMATE —, und der Test, der sie
gegeneinander haelt, deckt die neue Variante ab. Ohne das Bildformat in
AUF_GPU_FORMATE liefert der Decoder sauber und der Zuschauer sieht ein
weisses Fenster ohne Fehlermeldung; am 2026-08-04 mit D3D11 genau so
passiert.

ZUERST_NATIV_HW steht jetzt auf not(linux) statt windows: cuvid gibt es
auf macOS gar nicht, ein Versuch kostet nur Startzeit. Die Aussage der
Konstanten bleibt dieselbe, Linux ist unveraendert.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Aufgabe 2: `bundle-dylibs.sh` bündelt mehrere Binaries

**Dateien:**
- Ändern: `streaming/mac-hq-sidecar/scripts/bundle-dylibs.sh` (Z. 16–26, 38, 63–65)
- Ändern: `desktop/package.json` (Z. 17, `bundle:mac-sidecar`)

**Schnittstellen:**
- Erzeugt: neue Aufrufform `bundle-dylibs.sh <outdir> <binary...>` (Argumentreihenfolge **umgedreht**). Aufgabe 3 und 4 setzen sie voraus.

**Hintergrund für den Bearbeiter.** Das Skript macht ein Mach-O-Binary weitergabefähig: es kopiert rekursiv jede Nicht-System-Dylib neben das Binary, schreibt alle install-names auf `@loader_path` um und signiert jede angefasste Datei ad-hoc nach. Das Nachsignieren ist auf Apple Silicon **zwingend** — `install_name_tool` macht die Signatur ungültig, und arm64 killt ungültig signierte Binaries.

Der Player und der Sidecar linken **dieselbe** private FFmpeg und landen beide in `Resources/hq-sidecar/`. Sie sollen sich einen Dylib-Satz teilen. Heute nimmt das Skript genau ein Binary und **leert sein Ausgabeverzeichnis eingangs** (`rm -rf "$OUT"`) — zweimal nacheinander aufgerufen träfe der zweite Lauf das zuerst Gebündelte.

Die Dedup-Logik arbeitet über Dateiexistenz in `$OUT` statt über ein assoziatives Array, weil das System-bash auf macOS 3.2 ist. Das trägt mehrere Binaries ohne Änderung: die zweite Datei findet die Dylibs der ersten bereits vor und kopiert sie nicht erneut.

- [ ] **Schritt 1: Aufrufform und Kopfkommentar umstellen**

In `streaming/mac-hq-sidecar/scripts/bundle-dylibs.sh` Z. 16 und Z. 19–26 ersetzen. Alt:

```bash
# Usage: bundle-dylibs.sh <sidecar-binary> <output-dir>
set -euo pipefail

BIN="${1:?usage: bundle-dylibs.sh <binary> <outdir>}"
OUT="${2:?usage: bundle-dylibs.sh <binary> <outdir>}"
BINNAME="$(basename "$BIN")"

rm -rf "$OUT"
mkdir -p "$OUT"
cp -f "$BIN" "$OUT/$BINNAME"
chmod u+w "$OUT/$BINNAME"
```

Neu:

```bash
# Usage: bundle-dylibs.sh <output-dir> <binary> [more-binaries...]
#
# More than one binary shares ONE set of dylibs: the player and the sidecar
# link the same private FFmpeg and both ship in Resources/hq-sidecar/. The
# dedup below keys on file-existence in OUT, so the second binary finds the
# first one's dylibs already there and skips copying them. Argument order was
# <binary> <outdir> until 2026-08-20 — it had to flip for the variadic tail.
set -euo pipefail

OUT="${1:?usage: bundle-dylibs.sh <outdir> <binary> [more...]}"
shift
[ "$#" -ge 1 ] || { echo "usage: bundle-dylibs.sh <outdir> <binary> [more...]" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"

# Copy every binary in first, then scan them all — a single queue, one dylib set.
queue=()
for bin in "$@"; do
  [ -f "$bin" ] || { echo "not found: $bin" >&2; exit 1; }
  name="$(basename "$bin")"
  cp -f "$bin" "$OUT/$name"
  chmod u+w "$OUT/$name"
  queue+=("$OUT/$name")
done
```

- [ ] **Schritt 2: Die alte Queue-Initialisierung entfernen**

Z. 38 lautet heute:

```bash
queue=("$OUT/$BINNAME")
i=0
```

Die Queue wird jetzt oben gefüllt. Nur noch:

```bash
i=0
```

Der Kommentarblock darüber (Z. 35–37) bleibt unverändert — er erklärt die Dedup-Strategie, die weiterhin gilt.

- [ ] **Schritt 3: Die Schlussmeldung auf mehrere Binaries umstellen**

Z. 63–65 lauten heute:

```bash
echo "✓ bundled $(ls "$OUT" | wc -l | tr -d ' ') files into $OUT"
echo "--- sidecar deps (should be @loader_path / system only) ---"
otool -L "$OUT/$BINNAME" | tail -n +2 | awk '{print "  "$1}'
```

Neu — jedes Binary wird einzeln ausgewiesen, denn genau daran erkennt man einen unvollständigen Rewrite:

```bash
echo "✓ bundled $(ls "$OUT" | wc -l | tr -d ' ') files into $OUT"
for bin in "$@"; do
  name="$(basename "$bin")"
  echo "--- $name deps (should be @loader_path / system only) ---"
  otool -L "$OUT/$name" | tail -n +2 | awk '{print "  "$1}'
done
```

- [ ] **Schritt 4: Den Aufrufer nachziehen**

`desktop/package.json` Z. 17 lautet heute:

```json
    "bundle:mac-sidecar": "cd ../streaming/mac-hq-sidecar && cargo build --release && bash scripts/bundle-dylibs.sh target/release/pulse-mac-hq-sidecar target/release/hq-sidecar",
```

Neu — Sidecar und Player werden gebaut und **gemeinsam** gebündelt. Der Player liegt in einer anderen Crate, deshalb der zweite `cargo build` und der relative Pfad:

```json
    "bundle:mac-sidecar": "cd ../streaming/mac-hq-sidecar && cargo build --release && (cd ../pulse-player && cargo build --release) && bash scripts/bundle-dylibs.sh target/release/hq-sidecar target/release/pulse-mac-hq-sidecar ../pulse-player/target/release/pulse-player",
```

- [ ] **Schritt 5: Prüfen, dass keine weitere Fundstelle der alten Aufrufform übrig ist**

```bash
cd /Users/michael/Documents/pulse
grep -rn "bundle-dylibs" --include="*.json" --include="*.yml" --include="*.sh" --include="*.md" . | grep -v node_modules
```

Erwartung: Treffer nur in `desktop/package.json` (die neue Form), im Skript selbst und in `.github/workflows/mac-build.yml` bzw. `desktop/electron-builder.yml` als **Kommentar**. Jeder Kommentar, der die alte Argumentreihenfolge nennt, wird mitgezogen — insbesondere der Block über `mac.extraResources` in `desktop/electron-builder.yml`, der `scripts/bundle-dylibs.sh` erwähnt.

- [ ] **Schritt 6: Committen** (die Prüfung des Ergebnisses erfolgt in Aufgabe 3, sie braucht gebaute Binaries)

```bash
git add streaming/mac-hq-sidecar/scripts/bundle-dylibs.sh desktop/package.json
git commit -F - <<'EOF'
build(mac): bundle-dylibs.sh buendelt mehrere Binaries in einen Dylib-Satz

Der Player und der Sidecar linken dieselbe private LGPL-FFmpeg und landen
beide in Resources/hq-sidecar/. Sie sollen sich einen Satz Dylibs teilen —
zwei Saetze waeren dieselben Bibliotheken doppelt im DMG.

Das ging bisher nicht: das Skript nahm genau ein Binary und leerte sein
Ausgabeverzeichnis eingangs. Zweimal nacheinander aufgerufen haette der
zweite Lauf das zuerst Gebuendelte getroffen.

Die Argumentreihenfolge ist dafuer umgedreht (<outdir> <binary...> statt
<binary> <outdir>) — anders laesst sich kein variadischer Schwanz
anhaengen. Es gibt genau einen Aufrufer, er ist mitgezogen.

Die Dedup-Logik trug die Erweiterung ohne Aenderung: sie haengt an der
Dateiexistenz im Ausgabeverzeichnis und nicht an einem assoziativen Array
(System-bash auf macOS ist 3.2). Das zweite Binary findet die Dylibs des
ersten also vor und kopiert sie nicht erneut. Die Schlussmeldung weist
jedes Binary einzeln aus — an ihr erkennt man einen unvollstaendigen
install-name-Rewrite.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Aufgabe 3: Lokal bauen, bündeln und nachweisen

Diese Aufgabe schreibt keinen Code. Sie weist nach, dass Aufgabe 1 und 2 zusammen ein weitergabefähiges Binary ergeben — **bevor** CI und Packaging daran gehängt werden.

**Dateien:** keine Änderung.

- [ ] **Schritt 1: Die private LGPL-FFmpeg bauen, falls noch nicht vorhanden**

```bash
cd /Users/michael/Documents/pulse
ls ~/src/ffmpeg-openssl/lib/pkgconfig 2>/dev/null || bash streaming/mac-hq-sidecar/scripts/build-ffmpeg.sh
```

Der Bau dauert rund 15 Minuten. Er erzeugt eine LGPL-FFmpeg 8.0.1 mit `--enable-openssl --disable-securetransport --enable-videotoolbox --enable-audiotoolbox --enable-libopus`, shared, nach `~/src/ffmpeg-openssl`. Voraussetzung: `brew install openssl@3 opus`.

- [ ] **Schritt 2: Den webrtc-rs-Zweig herstellen**

```bash
cd /Users/michael/Documents/pulse
./streaming/pulse-player/scripts/bootstrap-webrtc.sh
```

Pflicht: `Cargo.toml` trägt `[patch.crates-io] webrtc = { path = "vendor/webrtc-rs/webrtc" }`, und `vendor/` ist gitignored. Ohne diesen Schritt scheitert bereits `cargo resolve`.

- [ ] **Schritt 3: Beides bauen und gemeinsam bündeln**

```bash
cd /Users/michael/Documents/pulse/desktop
export PKG_CONFIG_PATH="$HOME/src/ffmpeg-openssl/lib/pkgconfig:/opt/homebrew/opt/openssl@3/lib/pkgconfig:/opt/homebrew/opt/opus/lib/pkgconfig"
pnpm run bundle:mac-sidecar
```

Erwartung: zwei `cargo build --release` laufen durch, danach meldet das Skript `✓ bundled N files into target/release/hq-sidecar` und listet **zwei** Abhängigkeitsblöcke — einen für `pulse-mac-hq-sidecar`, einen für `pulse-player`.

- [ ] **Schritt 4: Nachweisen, dass keine Maschinen-Pfade übrig sind**

Das ist die eigentliche Prüfung dieser Aufgabe. Jede verbliebene Referenz auf `/Users/` oder `/opt/homebrew/` bedeutet: das Binary startet auf keinem fremden Mac.

```bash
cd /Users/michael/Documents/pulse/streaming/mac-hq-sidecar/target/release/hq-sidecar
otool -L pulse-player | tail -n +2 | awk '{print $1}' | grep -vE '^(@loader_path|/usr/lib|/System)' || echo "OK: keine fremden Pfade"
otool -L pulse-mac-hq-sidecar | tail -n +2 | awk '{print $1}' | grep -vE '^(@loader_path|/usr/lib|/System)' || echo "OK: keine fremden Pfade"
```

Erwartung: zweimal `OK: keine fremden Pfade`.

- [ ] **Schritt 5: Nachweisen, dass die Dylibs wirklich geteilt werden**

```bash
ls *.dylib | wc -l
codesign -v pulse-player && echo "Signatur gueltig"
```

Erwartung: ein einstelliger bis niedrig zweistelliger Satz Dylibs (FFmpeg, openssl, opus) — **nicht** doppelt. Die Signaturprüfung muss durchgehen; scheitert sie, killt Apple Silicon das Binary beim Start.

- [ ] **Schritt 6: Den Player wirklich starten**

Der Player ist ein stdio-JSON-RPC-Dienst wie die Sidecars. `health` öffnet kein Fenster und streamt nichts:

```bash
printf '{"op":"health","id":1}\n' | ./pulse-player
```

Erwartung: eine JSON-Zeile auf stdout mit `"id":1`. Diagnose geht auf stderr — stdout gehört dem RPC. Kommt hier ein `dyld`-Fehler, ist die Bündelung unvollständig.

- [ ] **Schritt 7: Hardware-Dekodierung nachweisen**

Der volle Nachweis für Aufgabe 1 braucht einen echten Stream (zwei Clients, siehe „Von Hand prüfen" unten) — der Player hat **keinen** `--help`-Schalter, er spricht ausschliesslich stdio-JSON-RPC.

Bis ein Stream zur Verfügung steht, prüft der `health`-Op aus Schritt 6 nur, dass der Prozess lebt. Was er **nicht** beweist, ist die Decoder-Wahl: die entscheidet sich erst beim `open` an einem echten Strom.

Der belastbare Zwischenbeleg ist deshalb der Unit-Test aus Aufgabe 1 (`geraetetyp_passt_zur_plattform` behauptet auf dieser Plattform `Hwaccel::VideoToolbox`), zusammen mit der Startmeldung am echten Strom.

Beim echten Stream muss das Statistik-Overlay `Hardware (VideoToolbox)` zeigen. Mit `PULSE_PLAYER_HWDEC=0` muss stattdessen der Software-Weg greifen — den Schalter setzt Electron über `desktop/electron/player-hwdec-wacht.ts` selbst.

**Trage das Ergebnis für Aufgabe 7 mit**: was hier gemessen wurde, geht als GEMESSEN in `WISSENSSTAND.md`; was nur aus dem Test folgt, als VERMUTET. Die Datei unterscheidet das streng, und die Unterscheidung ist der Zweck der Datei.

- [ ] **Schritt 8: Kein Commit**

Diese Aufgabe ändert keine Dateien. Ergebnisse gehören in die Notizen für Aufgabe 7 (WISSENSSTAND.md).

---

## Aufgabe 4: Die CI baut den Player mit

**Dateien:**
- Ändern: `.github/workflows/mac-build.yml` (Pfad-Trigger ~Z. 28–34, Cargo-Cache ~Z. 56, neuer Schritt vor „DMG bauen" ~Z. 95)

**Hintergrund für den Bearbeiter.** `mac-build.yml` läuft auf `macos-latest` (Apple Silicon, passt zum arm64-DMG und zu `--enable-neon`). Der teure Teil ist die FFmpeg — sie wird gecacht, keyed auf den Hash von `build-ffmpeg.sh`. Der Player braucht **dieselbe** FFmpeg und **keinen** zweiten Cache.

`win-build.yml` Z. 117–155 baut Sidecar und Player parallel über `Start-Job`. Auf macOS ist das nicht nötig: `bundle:mac-sidecar` baut beide nacheinander, und `cargo` parallelisiert innerhalb eines Baus ohnehin. Ein zusätzlicher Schritt wäre nur der `bootstrap-webrtc.sh`.

- [ ] **Schritt 1: Den Pfad-Trigger erweitern**

`.github/workflows/mac-build.yml` ~Z. 28–34 listet heute `desktop/**`, `streaming/mac-hq-sidecar/**` und die Workflow-Datei. Ergänze darunter, mit Begründung im Stil der Datei:

```yaml
      # Der native Player wird seit 2026-08-20 auch im DMG ausgeliefert. Ohne
      # diesen Eintrag löst eine Änderung an ihm keinen Build aus, und das DMG
      # trüge weiter den alten Stand — dieselbe Falle, die win-build.yml beim
      # Player und flatpak.yml beim FFmpeg-Patch schon hatte.
      - 'streaming/pulse-player/**'
```

- [ ] **Schritt 2: Den Cargo-Cache auf beide Crates ausweiten**

~Z. 53–56 lautet heute:

```yaml
      - name: Cargo-Cache
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: streaming/mac-hq-sidecar
```

`Swatinem/rust-cache` nimmt mehrere Workspaces zeilenweise:

```yaml
      - name: Cargo-Cache
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: |
            streaming/mac-hq-sidecar
            streaming/pulse-player
```

- [ ] **Schritt 3: Den webrtc-rs-Zweig herstellen**

Neuer Schritt **vor** „DMG bauen (unsigniert)" und **nach** „Dependencies":

```yaml
      # Der Player linkt eine gevendorte, gepatchte webrtc-rs (drei Patches in
      # streaming/pulse-player/patches/ — undeclared-SSRC-Streams für FlexFEC,
      # NACK-Resend-Delay, H264-STAP-A-Bounds-Check). vendor/ ist gitignored,
      # ohne diesen Schritt scheitert schon `cargo resolve`. Gleiches Muster wie
      # in win-build.yml.
      - name: webrtc-rs-Zweig herstellen (Player)
        run: ./streaming/pulse-player/scripts/bootstrap-webrtc.sh
```

- [ ] **Schritt 4: Den Kommentar am DMG-Schritt nachziehen**

Der Block über „DMG bauen (unsigniert)" beschreibt die Kette als „esbuild-Bundle → cargo build --release (Sidecar) → bundle-dylibs.sh". Das stimmt nicht mehr:

```yaml
      # esbuild-Bundle → cargo build --release (Sidecar UND Player) →
      # bundle-dylibs.sh (ein gemeinsamer Dylib-Satz für beide,
      # @loader_path-Rewrite + ad-hoc-Sign) → electron-builder --mac → DMG+ZIP in
      # desktop/release/.
```

Der Rest des Kommentars (PKG_CONFIG_PATH, `--publish never`, der Podman-Vermerk) bleibt unverändert.

- [ ] **Schritt 5: Die Workflow-Datei auf Syntax prüfen**

```bash
cd /Users/michael/Documents/pulse
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/mac-build.yml')); print('YAML ok')"
```

Erwartung: `YAML ok`.

- [ ] **Schritt 6: Committen**

```bash
git add .github/workflows/mac-build.yml
git commit -F - <<'EOF'
ci(mac): der Player wird mitgebaut

Bisher stand streaming/pulse-player/** nicht im Pfad-Trigger von
mac-build.yml — eine Aenderung am Player loeste keinen Mac-Bau aus, und
das DMG truege weiter den alten Stand. Dieselbe Falle hatte win-build.yml
beim Player schon und flatpak.yml beim FFmpeg-Patch.

Der Cargo-Cache deckt jetzt beide Crates ab. Ein zweiter FFmpeg-Cache ist
ausdruecklich NICHT dazugekommen: der Player linkt dieselbe private
LGPL-FFmpeg wie der Sidecar, gecacht keyed auf build-ffmpeg.sh.

Neu ist nur der bootstrap-webrtc.sh-Schritt. Der Player linkt eine
gevendorte, gepatchte webrtc-rs, vendor/ ist gitignored, und ohne den
Schritt scheitert schon cargo resolve. Gleiches Muster wie in
win-build.yml.

Kein paralleler Start-Job wie unter Windows: bundle:mac-sidecar baut beide
nacheinander, und cargo parallelisiert innerhalb eines Baus ohnehin.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Aufgabe 5: Der Player kommt ins DMG

**Dateien:**
- Ändern: `desktop/electron-builder.yml` (`mac.extraResources` ~Z. 199–203)

**Hintergrund für den Bearbeiter.** `mac.extraResources` kopiert heute genau einen Eintrag: das von `bundle-dylibs.sh` erzeugte **Verzeichnis** `../streaming/mac-hq-sidecar/target/release/hq-sidecar` nach `Resources/hq-sidecar/`. Da der Player seit Aufgabe 2 in **dasselbe** Verzeichnis gebündelt wird, wandert er automatisch mit — **es ist kein zweiter Eintrag nötig**. Zu tun ist nur, den Kommentar wahr zu machen: er spricht heute ausschließlich vom Sidecar.

Das ist der Unterschied zu Windows, wo zwei Einträge nötig sind (dort werden Dateien einzeln gefiltert, nicht ein fertiges Verzeichnis kopiert).

- [ ] **Schritt 1: Prüfen, dass der Player wirklich im Verzeichnis liegt**

```bash
ls /Users/michael/Documents/pulse/streaming/mac-hq-sidecar/target/release/hq-sidecar/
```

Erwartung: `pulse-mac-hq-sidecar`, `pulse-player` und die geteilten `*.dylib`. Fehlt `pulse-player`, ist Aufgabe 2 oder 3 unvollständig — dort zurückgehen, nicht hier einen zweiten Eintrag erfinden.

- [ ] **Schritt 2: Den Kommentar über `mac.extraResources` berichtigen**

`desktop/electron-builder.yml` ~Z. 199–203 lautet heute:

```yaml
  # HQ-Streaming-Sidecar: the SELF-CONTAINED bundle dir produced by
  # `scripts/bundle-dylibs.sh` (binary + @loader_path-rewritten FFmpeg/openssl/
  # opus dylibs, ad-hoc signed). Built by `dist:mac` before electron-builder
  # runs; ships to Resources/hq-sidecar/ where resolveMacBinaryPath() finds it.
  # (Requires `cargo build --release` in streaming/mac-hq-sidecar/ first.)
```

Ersetze durch:

```yaml
  # HQ-Streaming-Sidecar UND nativer Player: the SELF-CONTAINED bundle dir
  # produced by `scripts/bundle-dylibs.sh <outdir> <binary...>` (both binaries +
  # ONE shared set of @loader_path-rewritten FFmpeg/openssl/opus dylibs, ad-hoc
  # signed). Built by `dist:mac` before electron-builder runs; ships to
  # Resources/hq-sidecar/ where resolveMacBinaryPath() finds the sidecar and
  # resolvePlayerBinary() (electron/player.ts) finds the player.
  #
  # Deliberately ONE entry, unlike the win section: there the two binaries are
  # filtered out of two different target dirs, here bundle-dylibs.sh has already
  # put them side by side. The player joined on 2026-08-20; before that the Mac
  # app fell back to the <video> path silently, because the dir it looks in
  # existed but was empty.
```

- [ ] **Schritt 3: Die YAML auf Syntax prüfen**

```bash
cd /Users/michael/Documents/pulse
python3 -c "import yaml; yaml.safe_load(open('desktop/electron-builder.yml')); print('YAML ok')"
```

Erwartung: `YAML ok`.

- [ ] **Schritt 4: Ein DMG bauen und den Inhalt nachweisen**

```bash
cd /Users/michael/Documents/pulse/desktop
export PKG_CONFIG_PATH="$HOME/src/ffmpeg-openssl/lib/pkgconfig:/opt/homebrew/opt/openssl@3/lib/pkgconfig:/opt/homebrew/opt/opus/lib/pkgconfig"
pnpm run dist:mac
```

Danach prüfen, dass der Player wirklich im App-Bundle liegt:

```bash
ls release/mac*/Pulse.app/Contents/Resources/hq-sidecar/ | grep pulse-player
```

Erwartung: `pulse-player` wird gelistet.

- [ ] **Schritt 5: Committen**

```bash
git add desktop/electron-builder.yml
git commit -F - <<'EOF'
build(mac): der Player wird ins DMG gepackt

Genauer: er wird es bereits, seit bundle-dylibs.sh beide Binaries in
dasselbe Verzeichnis buendelt — mac.extraResources kopiert dort ein
fertiges VERZEICHNIS und keine gefilterten Einzeldateien. Ein zweiter
Eintrag waere falsch gewesen; das ist der Unterschied zur win-Sektion.

Geaendert ist deshalb nur der Kommentar, der ausschliesslich vom Sidecar
sprach. Er nennt jetzt beide Binaries, den geteilten Dylib-Satz, die neue
Aufrufform des Skripts und beide Resolver — resolveMacBinaryPath fuer den
Sidecar, resolvePlayerBinary fuer den Player.

electron/player.ts ist unveraendert: Zweig 4 des Resolvers
(process.resourcesPath/hq-sidecar/<BINARY>) griff auf macOS immer schon,
das Verzeichnis war nur leer. Genau deshalb fiel die Mac-App still auf den
<video>-Weg zurueck, ohne dass irgendwo ein Fehler stand.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Aufgabe 6: Den wartenden Zweig `build/player-ffmpeg-lokal` einholen

**Hintergrund für den Bearbeiter.** CLAUDE.md führt diesen Zweig ausdrücklich als „wartend, nicht vergessen": er enthält den Linux-Prüfbau des Players gegen die passende FFmpeg-Fassung (auf Systemen mit FFmpeg 9 — Arch, CachyOS — scheitert `cargo check` sonst mit 14 Fehlern **in** der Crate). Er wurde bewusst nicht einzeln gelandet, weil `streaming/pulse-player/**` Windows- und Flatpak-Bau auslöst und ein Neubau ohne Versionswechsel Bestandsclients gar nicht erreicht. **Er soll mit der nächsten echten Player-Änderung mitgehen** — das ist diese.

Er hat einen bekannten Konflikt gegen das Player-README.

- [ ] **Schritt 1: Den Zweig ansehen**

```bash
cd /Users/michael/Documents/pulse
git log --oneline origin/main..origin/build/player-ffmpeg-lokal
git diff --stat origin/main...origin/build/player-ffmpeg-lokal
```

- [ ] **Schritt 2: Einrebasen**

```bash
git merge origin/build/player-ffmpeg-lokal
```

- [ ] **Schritt 3: Den README-Konflikt auflösen**

Erwartet wird ein Konflikt in `streaming/pulse-player/README.md`. **Beide Seiten behalten**: der wartende Zweig ergänzt den Abschnitt „Bauen und Testen" um die FFmpeg-Fassung unter Linux, während auf `feat/mac-player` bereits die Zero-Copy-Korrektur vom 2026-08-20 liegt. Die beiden betreffen verschiedene Abschnitte; ein Konflikt entsteht nur durch Nähe im Text, nicht durch Widerspruch.

Nach der Auflösung prüfen, dass keine Konfliktmarker übrig sind:

```bash
grep -n "<<<<<<<\|>>>>>>>\|=======" streaming/pulse-player/README.md || echo "sauber"
```

- [ ] **Schritt 4: Bauen und testen**

```bash
cd streaming/pulse-player
export PKG_CONFIG_PATH="$HOME/src/ffmpeg-openssl/lib/pkgconfig:$PKG_CONFIG_PATH"
cargo test --lib 2>&1 | tail -10
```

Erwartung: grün.

- [ ] **Schritt 5: Den Merge abschließen**

```bash
cd /Users/michael/Documents/pulse
git add -A
git commit --no-edit
```

---

## Aufgabe 7: Version, Changelog und die berichtigten Behauptungen

**Dateien:**
- Ändern: `desktop/package.json` (`version`)
- Ändern: `streaming/pulse-player/README.md` (Z. ~247–254, ~662–665)
- Ändern: `streaming/pulse-player/WISSENSSTAND.md` (neuer GEMESSEN-Eintrag)
- Ändern: `web/static/changelog.json` (neuer Eintrag oben)
- Ändern: `CLAUDE.md` (Auslieferungswege des Players)

**Hintergrund für den Bearbeiter.** Der Version-Bump ist **Pflicht und nicht optional**: `streaming/pulse-player/**` wird über den Windows-Installer ausgeliefert, und electron-updater ignoriert eine gleiche Version stillschweigend. Bestandsclients unter Windows bekämen die Änderung sonst nie — obwohl das Vorhaben „nur" macOS im Titel trägt.

- [ ] **Schritt 1: Die Version bumpen**

Aktuellen Stand lesen und die Patch-Stelle um eins erhöhen:

```bash
grep '"version"' desktop/package.json
```

Der Stand zum Planzeitpunkt war `0.1.68`. Setze den nächsthöheren Wert.

- [ ] **Schritt 2: Die überholten README-Aussagen berichtigen**

`streaming/pulse-player/README.md` sagt an zwei Stellen, macOS sei ungeprüft und werde nicht ausgeliefert. Beides trifft nach diesem Vorhaben nicht mehr zu. **Vorher alle Fundstellen suchen:**

```bash
grep -n -i "macOS" streaming/pulse-player/README.md
```

Die Stelle bei „Was er noch NICHT kann" (~Z. 247–254) endet heute mit „**macOS bleibt ungeprueft** und wird nicht ausgeliefert." Ersetze durch eine Fassung im Stil der Datei, die den alten Stand mitführt:

```
  **Hier stand bis zum 2026-08-20 „macOS bleibt ungeprueft und wird nicht
  ausgeliefert".** Beides ist erledigt: der Player dekodiert dort ueber
  VideoToolbox in Hardware und faehrt im DMG mit. Was auf macOS weiterhin
  fehlt, ist Zero-Copy (`src/zerocopy/leer.rs` bleibt der bewusste
  Platzhalter) und der EDR-Ausgang fuer HDR — beides steht unter „Naechste
  Schritte".
```

Und den offenen Punkt 5 (~Z. 662–665, „macOS bauen und pruefen … nur macOS ist offen") auf den neuen Stand ziehen: gebaut und ausgeliefert ist es, offen bleiben Zero-Copy und EDR.

- [ ] **Schritt 3: Den Messbefund in WISSENSSTAND.md eintragen**

`streaming/pulse-player/WISSENSSTAND.md` klassifiziert jede Aussage als GEMESSEN, GELESEN, VERMUTET oder WIDERLEGT und enthält bisher **keine** macOS-Aussage. Trage die Befunde aus Aufgabe 3 ein — als GEMESSEN nur das, was wirklich gemessen wurde, mit Hardware und Datum. Wurde der Stream-Lauftest (unten) noch nicht gefahren, gehört die Hardware-Dekodierung als VERMUTET hinein, nicht als GEMESSEN.

- [ ] **Schritt 4: CLAUDE.md nachziehen**

CLAUDE.md nennt die Auslieferungswege des Players. Der Satz zum Version-Bump listet `streaming/pulse-player/**` als „wird seit 2026-08-05 mitgeliefert" — das bezieht sich auf Windows. Ergänze, dass der Player seit 2026-08-20 auch im macOS-DMG fährt.

```bash
grep -n "pulse-player" CLAUDE.md
```

- [ ] **Schritt 5: Den Changelog-Eintrag schreiben**

`web/static/changelog.json`, neuer Eintrag **oben** in `entries`. `id` ist das Datum, bei mehreren am selben Tag mit `.2`-Suffix. Felder: `id`, `date`, `style`, `title`, `intro?`, `items[]`, `outro?`.

**Regeln:** nutzerverständlich, kein Tech-Jargon. **Echte Umlaute.** **Keine Emojis.** Den Stil vorher mit dem Nutzer abstimmen — zuletzt gewählt war „Sachlich".

Inhaltlich: Mac-Nutzer bekommen beim Zusehen ein eigenes Player-Fenster statt des Browser-Wegs, mit Hardware-Dekodierung.

- [ ] **Schritt 6: Alle Prüfungen fahren**

```bash
cd /Users/michael/Documents/pulse
REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q
cd web && pnpm check && pnpm build
cd ../streaming/pulse-player && cargo test --lib 2>&1 | tail -5
cd ../../desktop && pnpm test:unit
```

Erwartung: alles grün. Rot = kein Push.

- [ ] **Schritt 7: Committen**

```bash
cd /Users/michael/Documents/pulse
git add desktop/package.json streaming/pulse-player/README.md streaming/pulse-player/WISSENSSTAND.md web/static/changelog.json CLAUDE.md
git commit -F - <<'EOF'
chore(desktop): Version <NEU> — der Player faehrt auf macOS mit

Der Version-Bump ist Pflicht und nicht Kosmetik: streaming/pulse-player/**
wird ueber den Windows-Installer ausgeliefert, und electron-updater
ignoriert eine gleiche Version stillschweigend. Ohne Bump erreichten die
Aenderungen dieses Zweigs die Windows-Bestandsclients nie — obwohl das
Vorhaben nur macOS im Titel traegt.

Mitgezogen sind die Behauptungen, die dieser Zweig ueberholt: das
Player-README sagte an zwei Stellen, macOS sei ungeprueft und werde nicht
ausgeliefert; CLAUDE.md nannte als Auslieferungsweg nur den
Windows-Installer. WISSENSSTAND.md bekommt die Messbefunde, sauber
getrennt nach GEMESSEN und VERMUTET.

Changelog: Mac-Nutzer sehen beim Zuschauen ein eigenes Player-Fenster
statt des Browser-Wegs.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Aufgabe 8 (nachgelagert): EDR-Ausgang für HDR auf macOS

**Diese Aufgabe hält die Auslieferung nicht auf.** Aufgabe 1–7 sind für sich auslieferbar.

**Dateien:**
- Ändern: `streaming/pulse-player/src/render/hdr_fenster.rs` (~Z. 72, 121–126, 139)

**Hintergrund.** `farbraum_anmelden` gibt außerhalb von Windows heute immer `false` zurück; `schirm_ist_hdr` existiert nur unter `cfg(windows)`. HDR-Material wird auf macOS also über den bestehenden Reinhard-Weg heruntergerechnet (BT.2408, 203 cd/m²). Das ist ein konservativer, kein kaputter Zustand.

Anzusprechen wäre `CAMetalLayer` mit EDR (`wantsExtendedDynamicRangeContent`, `EDRMetadata`). Das holt eine Apple-eigene Schnittstelle in einen bisher wgpu-neutralen Renderer — deshalb eigene Aufgabe.

- [ ] **Schritt 1:** Ermitteln, ob wgpu 30 den Zugriff auf den `CAMetalLayer` der Oberfläche durchreicht, oder ob dafür `raw-window-handle` plus `objc2`-Bindings nötig sind. **Neue Abhängigkeiten brauchen Rückfrage.**
- [ ] **Schritt 2:** Vor der Umsetzung messen, ob der Reinhard-Weg auf einem echten HDR-Mac überhaupt sichtbar schlechter ist. Ohne diesen Beleg nicht bauen.
- [ ] **Schritt 3:** Ergebnis in WISSENSSTAND.md eintragen — auch ein „lohnt nicht" ist ein Befund.

---

## Aufgabe 9 (nachgelagert, ergebnisoffen): IOSurface-Zero-Copy

**Diese Aufgabe hält die Auslieferung nicht auf, und sie wird möglicherweise gar nicht gebaut.**

**Dateien:**
- Möglicherweise ersetzen: `streaming/pulse-player/src/zerocopy/leer.rs` durch ein `macos`-Modul
- Ändern: `streaming/pulse-player/src/zerocopy/mod.rs` (~Z. 184–186, 218–232)

**Hintergrund.** `leer.rs` ist der **bewusste** Platzhalter; sein Kommentar nennt den Grund: VideoToolbox gibt seine Bilder als `IOSurface` heraus, das wäre eine vierte Brücke, und sie vorzutäuschen wäre schlimmer als ihr Fehlen. „Vierte Brücke" ist wörtlich zu nehmen — die drei bestehenden unterscheiden sich laut dem Kopf von `zerocopy/mod.rs` **erzwungen und nicht gewählt**: bei Windows (geteilte Textur, NT-Handle) und Linux/NVIDIA (exportiertes `VkImage`) ist sogar die Richtung vertauscht, und der VAAPI-Weg kopiert überhaupt nicht.

**Die Lehre aus Windows/NVIDIA ist der Grund für die Stufung.** Dort lag die Kostenseite am 2026-08-11 früh vor (Hochladen 1,20 → 0,00 ms bei 1080p8), und die Vorgabe wurde trotzdem ausdrücklich **nicht** umgestellt — es fehlte der Beleg auf der Robustheitsseite. Erst als `player-2026-08-11-robustheit-d3d11va-gegen-cuvid.json` nachgereicht war, wurde gedreht. Eine Zero-Copy-Brücke braucht also **zwei** getrennte Belege, und der zweite ist der teurere.

- [ ] **Schritt 1:** Kosten messen — was kostet der Umweg über den Hauptspeicher auf Apple Silicon wirklich? Bei Unified Memory ist die Ausgangslage grundlegend anders als bei Karten mit eigenem Speicher über PCIe. **Fällt die Zahl klein aus, endet die Aufgabe hier**, und das Ergebnis wird als Befund in WISSENSSTAND.md festgehalten.
- [ ] **Schritt 2:** Nur bei einer klaren Zahl: Robustheit gegen den bestehenden Weg messen (verworfene Zugriffseinheiten, beschädigter Bitstrom, Einstieg mitten in den Strom).
- [ ] **Schritt 3:** Nur wenn beide Belege stehen: die Brücke bauen und `bruecke_moeglich` für `Pixel::VIDEOTOOLBOX` öffnen.

---

## Von Hand prüfen (nicht automatisierbar)

Diese Punkte kann keine Testsuite abdecken und sie gehören vor den PR:

- **HQ-Stream mit zwei Clients**: ein Sender (Windows- oder Linux-Maschine), ein Mac als Zuschauer. Das Statistik-Overlay muss `Hardware (VideoToolbox)` zeigen.
- **Hardware gegen Software**: derselbe Stream mit `PULSE_PLAYER_DECODER=av1+hw` und mit erzwungenem Software-Weg; das Bild muss identisch sein.
- **Der Rückfall greift**: mit `PULSE_PLAYER_HWDEC=0` muss der Player weiterlaufen, nur teurer.
- **Ein fremder Mac**: das DMG auf einem Mac **ohne** Homebrew und **ohne** `~/src/ffmpeg-openssl` installieren und den Player starten. Das ist die eigentliche Prüfung der Bündelung.
- **Gatekeeper**: die App ist unsigniert; beim Erststart Rechtsklick→Öffnen. Das ist erwartet und ändert sich mit diesem Vorhaben nicht.

## Abschluss

Wenn alle Aufgaben stehen und alle Prüfungen grün sind, die Unter-Skill `superpowers:finishing-a-development-branch` verwenden. **Der Merge nach `main` ist ein Prod-Deploy und braucht ausdrückliche Freigabe.**
