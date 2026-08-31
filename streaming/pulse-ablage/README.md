# pulse-ablage

Der plattformfreie Kern der geteilten Zwischenablage der Fernsteuerung.

**Entwurf:** `docs/superpowers/specs/2026-08-31-fernsteuerung-zwischenablage-design.md`

## Was hier drin ist

| Modul | Aufgabe |
|---|---|
| `format` | Die vier Rahmen (`neu`/`hol`/`stueck`/`leer`) und die zwei Zahlen, gegen die gerechnet wird |
| `stueckelung` | Zerlegen und Wiederzusammensetzen unter dem 8192-Byte-Deckel des Gateways |
| `sitzung` | `Ankuendiger` (meine Seite) und `Empfaenger` (die Gegenseite) |
| `beobachter` / `eigentum` | Die zwei Berührungspunkte mit dem Betriebssystem, als Traits |
| `plattform` | Was eine Plattform ausserhalb der beiden Traits noch beantworten muss (`Ablagequelle`), das Objekt-Trait darüber und die Fassung für „hier keine" |
| `plattform::macos` | **Die einzige Plattform-Umsetzung, die hier liegt** (seit Plan 1c) — `NSPasteboard`, Eigner-Faden, Auftragsbuch |
| `stand` | Die Buchführung „welche Änderung ist meine" zwischen zwei Fäden |
| `lage` | Die Zustandsführung eines Verbrauchers: `teilen`-Riegel, Vorbestand auf Prozessebene, Fristen, die Deutung eines hereinkommenden Werts |
| `pruefstand` | Testdoppel beider Traits |

`plattform` und `lage` lagen bis zum 2026-08-31 im Player
(`app/ablage/{plattform,lage}.rs`) und sind mit dem Windows-Host hierher
gezogen: **beide Hälften einer Zwischenablage sind spiegelbildlich gleich**,
es gibt keine Sender- und keine Empfängerseite. Eine Kopie im Sidecar wäre
genau das, wogegen die gemeinsamen Kisten gebaut sind.

## Die eine Zusicherung

**Beim Kopieren geht kein Inhalt hinaus.** `tests/rundlauf.rs` belegt es: nach
einem Kopiervorgang kreuzt genau ein Rahmen die Leitung, und das ist die
Ankündigung. Erst ein tatsächliches Einfügen löst die Übertragung aus.

Wer hier etwas ändert, fährt diesen Test und liest, was er behauptet.

## Wer die Kiste einbindet

`pulse-player` (der Steuernde, seit Plan 1b-1), `win-hq-sidecar` (der Host,
seit Plan 1b-2) und `mac-hq-sidecar` (der Host auf macOS, seit Plan 1c).
**`linux-hq-sidecar` nicht** — Linux kann gar nicht Host sein, `remote_input`
gibt es dort nicht.

## Wo die Plattform-Aufrufe liegen — und warum nicht alle am selben Ort

| Plattform | Wo | Warum dort |
|---|---|---|
| Wayland | Player (`src/fernsteuerung/wayland/ablage*`) | Er hält für die Zugerkennung bereits ein `wl_data_device` am Sitzplatz; ein zweites verdoppelte alle Ereignisse. |
| Windows | Sidecar (`win-hq-sidecar/src/ablage/`) | Auf Windows ist nur der Sidecar Host — der Player dort ist Steuernder und teilt heute **nichts**. |
| **macOS** | **hier** (`src/plattform/macos/`) | Auf macOS gibt es **beide** Rollen: der `mac-hq-sidecar` ist Host, der `pulse-player` der Steuernde. Beim Verbraucher läge dieselbe Umsetzung zweimal im Baum. |

Die macOS-Umsetzung bringt als einzige Fremdabhängigkeiten mit — `objc2`,
`objc2-app-kit`, `objc2-foundation` (+ transitiv `objc2-encode`), alle nur
unter `cfg(target_os = "macos")` und mit knapp gehaltenen Merkmalslisten:
`NSPasteboard` ist AppKit, ohne Bindungen dafür gäbe es dort gar keine
Zwischenablage. Vom Nutzer am 2026-08-31 freigegeben; **die Grenze bleibt
hart**, jede weitere braucht ihre eigene Entscheidung.

**Auf macOS gibt es keine Änderungs-Benachrichtigung** — `NSPasteboard.change`
`Count` wird abgefragt (200 ms), und alle machen das so. Zwei Stücke der Kiste
bleiben deshalb ungenutzt, beide mit Begründung am Code: `eigentum::Anspruch`
(eine Wayland-Not) und `stand::Ablagestand::erwartet` (hängt an einer
Meldung; auf macOS quittiert die Plattform ihre eigene Änderung selbst,
`selbst_geaendert_quittiert`).

## Tests

    cargo test

Läuft ohne FFmpeg, ohne Fenster, ohne Netz — die Kiste ist reine Rechnung.
88 Tests, warnungsfrei; `scripts/gate-rust.sh` fährt sie mit (er nimmt jede
geänderte `streaming/pulse-*`, ohne sie einzeln zu nennen).

**Der macOS-Teil ist davon NICHT gedeckt**, und das ist keine Nachlässigkeit,
sondern die Lage: auf Linux wird er gar nicht übersetzt. Was auf einer
Linux-Maschine geht, ist

    cargo check --target aarch64-apple-darwin

(einmalig `rustup target add aarch64-apple-darwin`; es wird nur geprüft, nicht
gebunden, deshalb braucht es kein macOS-SDK). Das belegt, dass er übersetzt —
mehr nicht. Auf einem Mac fährt `cargo test` ihn mit, ohne die Zwischenablage
des Entwicklers anzufassen: `plattform::macos::starten` steigt im Testbau vor
dem Faden aus, wie die Wache im mac-Sidecar.
