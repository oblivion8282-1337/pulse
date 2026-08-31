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
| `pruefstand` | Testdoppel beider Traits |

## Die eine Zusicherung

**Beim Kopieren geht kein Inhalt hinaus.** `tests/rundlauf.rs` belegt es: nach
einem Kopiervorgang kreuzt genau ein Rahmen die Leitung, und das ist die
Ankündigung. Erst ein tatsächliches Einfügen löst die Übertragung aus.

Wer hier etwas ändert, fährt diesen Test und liest, was er behauptet.

## Wer die Kiste einbindet

`pulse-player` (der Steuernde), `win-hq-sidecar` und `mac-hq-sidecar` (die
Hosts). **`linux-hq-sidecar` nicht** — Linux kann heute gar nicht Host sein,
`remote_input` gibt es dort nicht.

Die Linux-Umsetzung der beiden Traits liegt im **Player**
(`src/fernsteuerung/wayland/`), nicht hier: der Player hält für die
Zugerkennung bereits ein `wl_data_device` am Sitzplatz, und ein zweites
verdoppelte alle Ereignisse. Windows und macOS bringen ihr eigenes verstecktes
Fenster mit und sind selbsttragend.

## Tests

    cargo test

Läuft ohne FFmpeg, ohne Fenster, ohne Netz — die Kiste ist reine Rechnung.
43 Tests, warnungsfrei; `scripts/gate-rust.sh` fährt sie mit.
