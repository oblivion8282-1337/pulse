# Gemeinsame Bausteine für Sidecars und Player — Entwurf (2026-08-20)

Ziel: den mehrfach vorliegenden Code der vier Rust-Programme unter `streaming/`
in geteilte Bausteine ziehen — zuerst dort, wo die Doppelung nachweislich
schadet.

**Dieser Entwurf beschreibt die Zielrichtung, nicht eine einzelne Umsetzung.**
Er zerfällt in fünf Etappen, jede mit eigenem Plan und eigenem Zweig.

## Ausgangslage

Vier Programme, kein Cargo-Workspace, keine geteilte Crate zwischen ihnen:
`win-hq-sidecar`, `linux-hq-sidecar`, `mac-hq-sidecar` (nehmen auf und senden),
`pulse-player` (empfängt und zeigt an).

**Rund 2.400 Codezeilen liegen mehrfach fast wortgleich vor**, mit den
nicht-textgleichen Fällen 2.700–2.900. Erhoben am 2026-08-20, Kommentare
herausgerechnet:

| Datei | Programme | Zeilen je Fassung | Abweichung | abgesichert |
|---|---|---|---|---|
| `whip/av1.rs` | win, linux, mac | 496 | **0** | nur linux ↔ mac |
| `whip/sdp.rs` | win, linux, mac | 220 | **0** | nur linux ↔ mac |
| `whip/mod.rs` | linux, mac | 278 | 2 | nein |
| `zeigerbild.rs` | win, player | 265 | **0** | ja |
| `whip/pacer.rs` | linux, mac | 129 | 0 | nein |
| `profiles.rs` | linux, mac | ~71 | 1 | nein |
| `zeitbasis.rs` | win, linux | 60 | **0** | nein |
| `proto.rs` | win, mac | 47 | 0 | nein |
| `ops/state.rs` | linux, mac | 31 | **0** | nein |
| `events.rs` | linux, mac | 23 | 0 | nein |
| `ops/{stop,mod,keyframe}.rs` | verschieden | 6–20 | 0–2 | nein |
| Token-Redaktion | win, linux, mac | ~20 | **verhält sich verschieden** | nein |
| Zero-Copy-Brücke | win, player | ~250 | strukturell gleich | nein |

## Warum es sich lohnt: drei Belege, keine Vermutung

**Erstens: eine Doppelung verhält sich bereits unterschiedlich, und zwar an
einer sicherheitsrelevanten Stelle.** Die Token-Redaktion maskiert
Stream-Schlüssel, bevor irgendetwas ins Protokoll geht. Alle drei Sidecars
lösen dieselbe Aufgabe, aber verschieden:

| | alle Vorkommen | Groß/klein egal | gründliche Abschlusszeichen |
|---|---|---|---|
| **Windows** | ✓ | ✗ | ✓ (`is_whitespace` + `& " ' ( ) [ ] { } , ; < > \| \``) |
| **Linux** | ✓ | ✓ (sucht auf kleingeschriebener Kopie) | ✗ (nur `&` und Leerzeichen) |
| **macOS** | ✗ (nur das erste) | ✗ | ✗ |

**Keine der drei ist die beste** — jede kann etwas, was den anderen fehlt. Zwei
konkrete Fälle:

- `?Token=abc` (großes T) in einer Fehlermeldung: **Linux** maskiert, Windows
  und macOS nicht.
- `Fehler (url=rtmps://h/p?token=abc)`: **Windows** endet sauber an der
  Klammer. Linux und macOS finden weder `&` noch Leerzeichen, greifen auf
  `unwrap_or(len)` zurück und maskieren **bis zum Ende der Meldung** — der
  Schlüssel ist zwar weg, aber der Rest der Meldung auch.

Es gibt also Adressen, bei denen ein Schlüssel auf einer Plattform maskiert
wird und auf einer anderen im Klartext im Protokoll landet. Die macOS-Grenze
wurde am 2026-08-20 dokumentiert und getestet — ohne Kenntnis davon, dass die
anderen beiden es anders machen. Genau das ist der Preis getrennter Kopien:
jede für sich sieht richtig aus.

**Zweitens: es ist bereits zweimal unbemerkt auseinandergelaufen.**
`zeitbasis.rs` driftete am 2026-08-17 (folgenlos nur durch Zufall — es traf
Kommentarzeilen). Die Zero-Copy-Brücke lief am 2026-08-06 auseinander.

**Drittens: der vorhandene Schutz hat eine Lücke.** Es gibt Gleichheits-Tests
(`include_str!` + `assert_eq!`), aber **Windows steht in keinem davon** —
obwohl sein Sendeweg zeichengleich mit den anderen ist. Eine Abweichung dort
fiele niemandem auf.

## Grundentscheidung: geteilte Crates, KEIN Workspace

Ein gemeinsamer Cargo-Workspace wäre der naheliegende Griff und ist der
falsche. Sieben Hindernisse, zwei davon hart:

1. **`[patch.crates-io]` gilt workspace-weit.** `pulse-player` zieht einen
   selbst gepatchten `webrtc`-Fork; die drei Sidecars nehmen das unveränderte
   Crate und haben den Vendor-Zweig gar nicht ausgecheckt. In einem Workspace
   gälte der Patch für alle vier — Cargo kennt keine Member-lokale Auflösung.
2. **Drei der vier binden OS-APIs ohne `cfg`-Kapselung** (`windows`,
   `objc2*`, `ashpd`/`pipewire`). `cargo build --workspace` würde auf jeder
   Maschine versuchen, alle Member aufzulösen — auf Linux bricht schon
   `generate-lockfile` ab.
3. Vier physisch verschiedene, selbstgebaute FFmpeg-Distributionen
   (`ffmpeg-next` 8.0 auf mac, 8.1 sonst; je eigene Patches).
4. `.cargo/config.toml`-`[env]`-Blöcke wirken pro Verzeichnis; an der
   Workspace-Wurzel gälten sie für alle Member gleichzeitig — die vier
   heutigen Sätze widersprechen einander.
5. Ein absoluter Entwicklerpfad in `mac-hq-sidecar/.cargo/config.toml`.
6. Edition- und Toolchain-Divergenz (2021 gegen 2024; der Player verlangt
   rustc ≥ 1.95, der Flatpak-Sidecar baut mit 1.89 aus der SDK-Extension).
7. Der Flatpak baut Cargo **offline** aus generierten
   `packaging/*-cargo-sources.json`; ein gemeinsames Lockfile zöge die
   OS-fremden Crates mit hinein.

**Geteilte Crates per Pfad-Abhängigkeit umgehen alle sieben.** Jedes Programm
behält sein eigenes `Cargo.lock`, seine `.cargo/config.toml`, seine
FFmpeg-Fassung, seine Toolchain. Der gemeinsame Baustein steht daneben und wird
mit `pulse-<name> = { path = "../pulse-<name>" }` eingebunden.

Das ist keine Notlösung: Es ist der Zuschnitt, der zu vier Programmen passt,
die dieselbe Aufgabe auf vier verschiedenen Betriebssystemen lösen.

## Die vier Bausteine

| Baustein | Inhalt | Nutzer | Zeilen |
|---|---|---|---|
| `pulse-redact` | Token-Maskierung | 3 Sidecars | ~60 |
| `pulse-zeitbasis` | RTP-Taktrechnung | 3 Sidecars | ~60 |
| `pulse-whip` | WebRTC-Sendeweg | 3 Sidecars | ~1.850 |
| `pulse-zeigerbild` | Zeigerbild-Wireformat | win, player | ~265 |

**Was ausdrücklich NICHT hineingehört:** Bildschirmaufnahme, Encoder-Ansteuerung
und Audioaufnahme. Sie tragen gleiche Dateinamen und lösen dieselbe Aufgabe,
sind aber auf verschiedenen Systemen gebaut (WGC/WASAPI gegen
PipeWire/Portal gegen ScreenCaptureKit/VideoToolbox) und weichen zu über 60 %
ab. Sie zusammenzulegen hiesse, eine Einheitlichkeit zu behaupten, die es nicht
gibt.

**Auch nicht:** der Taktgeber (`whip/pacer.rs`). Er ist zwischen Linux und mac
zwar identisch, aber Windows fährt einen **anderen Algorithmus**, und welcher
besser ist, ist ungemessen (die Ankunftslücken, um die es geht, treten auf der
lokalen Schleife gar nicht auf). Diese Frage gehört nicht in einen Umbau. Der
Taktgeber bleibt plattformeigen hinter einem schmalen Trait.

## Etappen

Jede Etappe hat einen eigenen Plan, einen eigenen Zweig und liefert etwas
Fertiges. Die Reihenfolge steigt in Größe und Risiko — die kleinen Etappen
erproben das Verfahren für die grosse.

### Etappe 0 — Das Netz spannen

**Vor jedem Umbau.** Jede bekannte Doppelung bekommt einen Gleichheits-Test,
insbesondere **Windows**, das heute in keinem steht.

Das ist billig und beantwortet zugleich eine offene Frage: Ist Windows heute
wirklich noch gleich, oder ist es längst leise abgewichen? Wenn ja, ist das ein
Befund, den man vor dem Umbau kennen will, nicht danach.

**Fertig, wenn:** jede Doppelung aus der Tabelle oben von einem Test bewacht
wird und der auf allen drei Rechnern grün ist.

### Etappe 1 — `pulse-redact`

Klein, sicherheitsrelevant, und mit einer echten Entscheidung darin.

**Entschieden am 2026-08-20: das Beste aus beiden.** Windows' Abschlusszeichen
(`ends_value`) plus Linux' Unempfindlichkeit gegen Groß-/Kleinschreibung, beide
mit „alle Vorkommen". Kein Neubau — zwei erprobte Teile zusammengesetzt.

Die gemeinsame Fassung fängt damit **strikt mehr** als jede heutige. Alle drei
Plattformen ändern ihr Verhalten:

- Windows gewinnt Groß-/Kleinschreibungs-Toleranz
- Linux gewinnt die gründlichen Abschlusszeichen
- macOS gewinnt beides und zusätzlich „alle Vorkommen"

Das ist eine Verhaltensänderung an ausgeliefertem Code auf **drei** Plattformen
und gehört als solche geprüft, nicht nebenbei mitgenommen.

**Wie diese Entscheidung zustande kam, gehört mit ins Protokoll**, weil sie
beinahe anders ausgefallen wäre: Die Bestandsaufnahme hatte Windows als
case-insensitiv geführt und Linux nicht. Das ist vertauscht — der Windows-Code
sucht mit `find(pat)` direkt im Original, Linux auf einer
`to_ascii_lowercase()`-Kopie. Auf dieser falschen Grundlage war „wir nehmen
Windows" bereits entschieden; erst der Blick in den echten Code hat gezeigt,
dass Windows dabei eine Fähigkeit verloren hätte, die Linux heute hat. **Bei
einer sicherheitsrelevanten Funktion reicht eine Zusammenfassung nicht** — die
Fassungen gehören nebeneinandergelegt.

Der Test dazu hält nicht fest, dass die Funktion „etwas maskiert", sondern
**welche Adressen sie erwischt** — mit je einem Fall pro Sendeweg (WHIP
`?token=`, RTMPS `pass=`, SRT `streamid=publish:`) und je einem Fall, der
heute auf mindestens einer Plattform durchrutschen würde.

**Fertig, wenn:** alle drei Sidecars dieselbe Maskierung benutzen und auf jedem
Rechner ein echter Stream läuft, ohne dass ein Schlüssel im Protokoll steht.

### Etappe 2 — `pulse-zeitbasis`

Reine, seiteneffektfreie Arithmetik ohne Plattformbezug — der einfachste Fall,
und zugleich die Stelle, an der die Doppelung schon einmal eingetreten ist.

Mitzunehmen sind die Langzeit-Nachweise, die am 2026-08-20 für macOS
entstanden sind: dass die Rechnung über eine Stunde nicht wegdriftet, weil sie
den **absoluten** Zeitwert skaliert statt Pro-Bild-Takte aufzusummieren.

**Fertig, wenn:** alle drei Sidecars dieselbe Rechnung benutzen und die
Langzeit- und Monotonie-Tests für alle gelten.

### Etappe 3 — `pulse-whip`

Der grosse Block. Hier zahlt sich Etappe 0–2 aus: das Verfahren ist dreimal
erprobt, und das Netz aus Etappe 0 fängt Abweichungen.

Der Zuschnitt ist bereits durchdacht (verworfener Entwurf vom 2026-08-20, in
der Git-Historie von `2026-08-20-mac-whip-sender-design.md` vollständig
erhalten): `av1.rs`, `sdp.rs` und `mod.rs` wandern, `pacer.rs` bleibt
plattformeigen hinter einem Trait. Die Rückgriffe in die Sidecar-Crates
(`request_keyframe`, `events::emit`) werden Callbacks.

**Fertig, wenn:** alle drei Sidecars über denselben Baustein senden und auf
jedem Rechner ein echter Stream mit einem später beitretenden Zuschauer läuft.

### Etappe 4 — `pulse-zeigerbild`

Zuletzt, weil es heute schon durch einen Test zusammengehalten wird und damit
am wenigsten weh tut. Betrifft `win-hq-sidecar` und `pulse-player`.

## Wie geprüft wird

Das ist der Teil, an dem das Vorhaben am 2026-08-20 schon einmal gescheitert
ist: Der Windows- und der Linux-Sidecar **bauen auf einem Mac nicht**. Ein
geschriebener, aber nie übersetzter Baustein an ausgeliefertem Code wäre
schlechter als keiner.

Aufgelöst wird das durch die vorhandene Hardware:

| Rechner | baut | prüft |
|---|---|---|
| Mac | mac-Sidecar, Player | hier |
| Windows-Rechner | win-Sidecar, Player | per Übergabedokument |
| Linux-Rechner | linux-Sidecar, Player | per Übergabedokument |
| Remote-Dev-Stack | — | echte Streams zwischen den Rechnern |

**Je Etappe ein Übergabedokument** unter `docs/plans/` — das im Repo etablierte
Muster (`*-uebergabe-*.md`). Es nennt genau: was zu bauen ist, welche
Voraussetzungen die Maschine braucht, was zu prüfen ist und was zurückzumelden
ist. Die Ergebnisse kommen als Befunde ins Repo, nicht als mündliche Zusage.

**Keine Etappe landet, bevor alle drei Rechner sie bestätigt haben.**

## Was das nicht löst

- **Die Bau-Voraussetzungen bleiben verschieden.** Jedes Programm braucht
  weiter seine eigene FFmpeg-Fassung und seine eigenen Vorbereitungsskripte.
  Geteilte Bausteine ändern daran nichts und sollen es nicht.
- **Der absolute Entwicklerpfad** in `mac-hq-sidecar/.cargo/config.toml` bleibt
  bestehen — eigener, kleiner Fund, gehört behoben, aber nicht hierher.
- **Die Pacer-Frage** bleibt offen und ungemessen.

## Offene Entscheidungen

1. ~~Redaktions-Verhalten~~ — **entschieden am 2026-08-20**: das Beste aus
   beiden (s. Etappe 1).
2. **Namensschema** der Crates: `pulse-*` wie hier vorgeschlagen, oder ein
   gemeinsames Präfix wie `hq-*`?
3. **Ob Etappe 0 eigene Befunde erzeugt** — findet sie eine bereits bestehende
   Abweichung (besonders bei Windows), wird daraus eine eigene kleine Aufgabe
   vor Etappe 1.

## Eine Lehre für die Umsetzung

Der Redaktions-Fall oben ist kein Einzelfall, sondern der Grund für Etappe 0.
Zwischen „diese Dateien sind gleich" und „diese Dateien tun dasselbe" liegt
genau die Sorte Fehler, die keiner Suite auffällt. Die Bestandsaufnahme hat
Textgleichheit gut erkannt (`av1.rs`, `sdp.rs` — bitgleich, belegt) und ist bei
der Frage „verhalten sie sich gleich?" einmal danebengelegen.

**Für jede Etappe gilt deshalb: erst die Fassungen nebeneinanderlegen, dann
entscheiden.** Nicht die Zusammenfassung glauben, auch nicht die eigene.
