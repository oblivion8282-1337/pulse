# Vorhalt messen — Anleitung für den steuernden Rechner

Stand 2026-08-22. Zweig `feat/vorhalt-reserve-messen`.

**Diese Datei ist eine Arbeitsanweisung.** Wer sie vorgelegt bekommt, kann ihr
Schritt für Schritt folgen; es ist nichts zu entscheiden und nichts zu
recherchieren.

> **Die Messung ist gelaufen (2026-08-22). Ergebnis:
> `2026-08-22-vorhalt-messung-ergebnis.md`.** Die Erwartung weiter unten —
> reichlich Reserve, alles in der ersten Stufe, der Vorhalt kann deutlich
> herunter — hat sich **nicht** bestätigt: auf der gemessenen Strecke sind 30 ms
> eher zu wenig als zu viel. Die Anleitung bleibt gültig, wenn dieselbe Messung
> auf einer anderen Leitung wiederholt werden soll; nur ihre Erwartung ist
> überholt.

## Worum es geht

Der Player hält jedes Bild kurz zurück, damit die Ausgabe gleichmäßig läuft
(der **Vorhalt**). Während einer Fernsteuerung steht er fest auf 30 ms und geht
nie darunter — diese Zahl ist geraten, nicht gemessen. Sie kostet direkt
Reaktionszeit: 30 ms im geschlossenen Kreis aus Eingabe hin und Bild zurück.

Der Zweig macht sichtbar, wie viel von diesem Vorhalt die Leitung **wirklich**
braucht. Danach lässt sich die Untergrenze an die Messung koppeln statt an eine
Konstante. Am Verhalten ändert der Zweig nichts, er misst nur.

## Wichtig: die Rollen

Der Vorhalt sitzt im **Player**, und der Player läuft dort, wo das fremde Bild
angezeigt wird — also beim **steuernden** Rechner.

* **Dieser Rechner steuert.** Hier wird gebaut, hier entstehen die Zahlen.
* Der übernommene Windows-Rechner braucht **nichts** davon. Er nimmt nur auf
  und sendet; in seinem Protokoll steht zum Vorhalt nichts.

## Schritt 1 — Zweig holen

```bash
git fetch origin
git checkout feat/vorhalt-reserve-messen
```

## Schritt 2 — den `vendor/`-Baum herstellen (nicht überspringen)

```bash
bash streaming/pulse-player/scripts/bootstrap-webrtc.sh
```

**Auch dann ausführen, wenn `streaming/pulse-player/vendor/webrtc-rs` schon
existiert.** Das Verzeichnis ist gitignored, wandert also nicht mit dem Zweig
mit und kann beliebig alt sein. Das Skript ist dafür gebaut: Es setzt einen
vorhandenen Baum hart zurück und legt **alle** Patches erneut auf.

**Woran man einen veralteten Baum erkennt:** `cargo test` meldet

```
depacket::tests::repro_3_stapa_ueberzaehliges_byte ... FAILED
index out of bounds: the len is 4 but the index is 4
```

Das sieht wie ein kaputter Test oder eine Regression aus und ist keines von
beidem — es fehlt schlicht `patches/0003-h264-stapa-bounds-check.patch`. Genau
diese Verwechslung hat am 2026-08-22 auf der Windows-Maschine eine Stunde
gekostet, samt einer überflüssigen zweiten Behebung, die wieder zurückgenommen
werden musste. Das Skript einmal laufen zu lassen erledigt es.

## Schritt 3 — bauen

Die FFmpeg-Pfade müssen von Hand gesetzt werden; diese Kiste hat bewusst keine
`.cargo/config.toml` (Begründung in `streaming/pulse-player/README.md`).
Rust muss mindestens 1.95 sein (`rustup update stable`).

### Linux

```bash
streaming/pulse-player/scripts/fetch-ffmpeg-linux.sh    # einmalig, ~57 MB
export PKG_CONFIG_PATH="$PWD/streaming/pulse-player/ffmpeg-dist/n8.1-lgpl-shared/lib/pkgconfig"
export FFMPEG_DIR="$PWD/streaming/pulse-player/ffmpeg-dist/n8.1-lgpl-shared"
cd streaming/pulse-player && cargo build --release
```

`PKG_CONFIG_PATH` ist hier der wirksame Hebel, **nicht** `FFMPEG_DIR`: Auf
Linux sucht `ffmpeg-sys-next` über pkg-config und übergeht die
Verzeichnisvariable. Mit `FFMPEG_DIR` allein bleibt es bei 14 Übersetzungs-
fehlern **in der Fremdkiste** — das sieht nach kaputtem `ffmpeg-next` aus und
ist ein fehlender Pfad. (System-FFmpeg 9 taugt nicht, `ffmpeg-next` 8.1 baut
nicht dagegen.)

### Windows (PowerShell)

```powershell
cd streaming\pulse-player
$env:FFMPEG_DIR    = "$PWD\..\win-hq-sidecar\ffmpeg-dist\n8.1-lgpl-shared"
$env:LIBCLANG_PATH = 'C:\Program Files\LLVM\bin'
$env:PATH          = "$env:FFMPEG_DIR\bin;$env:PATH"
cargo build --release
```

Die `PATH`-Zeile ist kein Beiwerk: `FFMPEG_DIR` sagt nur, wogegen gelinkt wird.
Fehlen die DLLs zur Laufzeit, stirbt das Programm mit `STATUS_DLL_NOT_FOUND`
(`0xC0000135`), **bevor eine Zeile Code läuft** — bei `cargo test` als nacktes
„test failed" ohne Begründung.

### macOS

```bash
export PKG_CONFIG_PATH="$HOME/src/ffmpeg-openssl/lib/pkgconfig"
cd streaming/pulse-player && cargo build --release
```

**`FFMPEG_DIR` und `ffmpeg-dist/` gibt es auf dem Mac nicht** — wer die
Linux-Zeile abtippt, bekommt `'libavutil/avutil.h' file not found` und hält es
leicht für ein kaputtes FFmpeg statt für einen Pfad, den es nie gab.

### Gegenprobe (empfohlen, dauert ~75 s)

```
cargo test
```

Erwartung: **402 bestanden, 0 fehlgeschlagen, 6 übersprungen.** Ist
`repro_3_stapa_ueberzaehliges_byte` rot, wurde Schritt 2 übersprungen.

## Schritt 4 — die App im PRODUKTIVMODUS starten

```bash
cd desktop && pnpm run prod
```

**Nicht `pnpm dev:remote`.** Das hängt an der Testinstanz auf dem
Hetzner-Server, und die liegt 47 ms entfernt statt 15 wie der Produktivserver.
Ein dort abgelesener Vorhalt wäre für den echten Betrieb weit zu vorsichtig —
und genau dieser Fehler ist im August schon zweimal passiert, einmal in jede
Richtung.

`pnpm run prod` lädt howispulse.com, benutzt aber trotzdem den gerade gebauten
Player: Der Pfad-Sucher greift auf `streaming/pulse-player/target/release/`,
solange die App nicht verpackt ist. **Die installierte Pulse-App aus dem
Startmenü taugt dafür nicht** — die bringt ihren eigenen, älteren Player mit.

Den Start aus einem Terminal machen, das offen bleibt: Die Zahlen laufen dort
mit durch.

## Schritt 5 — messen

1. Eine Fernsteuerung des Windows-Rechners starten, wie sonst auch.
2. **Ein bis zwei Minuten ganz normal arbeiten** — Maus bewegen, scrollen,
   tippen, ein Fenster ziehen. Ein stehendes Bild misst nichts: Ohne
   Bildwechsel liefert die Aufnahme nichts, und der Vorhalt hat nichts zu tun.
3. Danach die Fernsteuerung beenden.

## Schritt 6 — einsammeln

Gesucht sind die Zeilen, die so aussehen:

```
pulse-player: Sitzung 1: … : Ausgabe-Takt 30 ms Vorhalt, verspaetet 0,
neu verankert 0, nachgezogen 12, verdraengt 0, knappste Reserve 26 ms,
Nutzung 178/2/0/0
```

Sie erscheinen einmal je Sekunde in dem Terminal, in dem die App läuft.
Zusätzlich stehen sie in der Protokolldatei:

| | |
|---|---|
| Linux | `~/.config/Pulse/sidecar.log` |
| Windows | `%APPDATA%\Pulse\sidecar.log` |
| macOS | `~/Library/Application Support/Pulse/sidecar.log` |

**Gebraucht wird ein zusammenhängendes Stück von 30 bis 60 dieser Zeilen** aus
der Zeit, in der wirklich gesteuert wurde. Der Rest der Zeile darf gern
mitkommen.

## Was die beiden neuen Zahlen bedeuten

* **knappste Reserve** — wie viel Vorhalt beim schlechtesten noch rechtzeitigen
  Bild der letzten Sekunde übrig blieb. Sie ist die Obergrenze dessen, was sich
  senken lässt: Bei 30 ms Vorhalt und 26 ms knappster Reserve hat die Leitung
  nie mehr als 4 ms Schwankung gebraucht.
* **Nutzung a/b/c/d** — wie sich alle Bilder der letzten Sekunde auf die
  Viertel des Vorhalts verteilen. `a` heißt „hat höchstens ein Viertel
  gebraucht". Steht fast alles in `a`, ist der Vorhalt ein Vielfaches dessen,
  was nötig ist. Die knappste Reserve allein wäre ein einzelner Ausreißer und
  würde jede Senkung blockieren — erst die Verteilung zeigt, ob das die Regel
  ist.

Erwartung, falls die Leitung so ruhig ist wie gemessen (15 ms Umlaufzeit, 0 %
Verlust): reichlich Reserve, alles in der ersten Stufe. Dann kann der Vorhalt
beim Steuern deutlich herunter, und das sind unmittelbar gesparte
Reaktionszeit.

## Fallstricke, kurz

* **Nicht die installierte App** benutzen — sie hat ihren eigenen Player.
* **Nicht `dev:remote`** — falscher Server, falsche Strecke.
* **Bei stehendem Bild nichts messen** — es muss sich etwas bewegen.
* **Vorhalt nicht von Hand verstellen** (`PULSE_PLAYER_AUSGABETAKT_MS`), sonst
  misst man gegen einen anderen Bezugswert.
