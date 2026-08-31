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

`pulse-player` (der Steuernde, seit Plan 1b-1) und `win-hq-sidecar` (der Host,
seit Plan 1b-2). `mac-hq-sidecar` folgt in Plan 1c. **`linux-hq-sidecar`
nicht** — Linux kann gar nicht Host sein, `remote_input` gibt es dort nicht.

Die **Plattform-Aufrufe** liegen nicht hier, sondern bei den Verbrauchern:

- Wayland im Player (`src/fernsteuerung/wayland/ablage*`) — er hält für die
  Zugerkennung bereits ein `wl_data_device` am Sitzplatz, und ein zweites
  verdoppelte alle Ereignisse.
- Windows im Sidecar (`streaming/win-hq-sidecar/src/ablage/`) — eigenes,
  nur für Nachrichten sichtbares Fenster auf eigenem Faden, plus ein zweiter
  Faden für den Takt (der muss weiterlaufen, während der erste in
  `WM_RENDERFORMAT` blockiert).

## Tests

    cargo test

Läuft ohne FFmpeg, ohne Fenster, ohne Netz — die Kiste ist reine Rechnung.
80 Tests, warnungsfrei; `scripts/gate-rust.sh` fährt sie mit (er nimmt jede
geänderte `streaming/pulse-*`, ohne sie einzeln zu nennen).
