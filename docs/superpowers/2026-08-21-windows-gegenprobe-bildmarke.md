# Auftrag für die Windows-Maschine: Gegenprobe der Bildmarke

Geschrieben am 2026-08-21 von der Linux-Maschine aus, nachdem die Kette dort
vollständig durchgemessen wurde. **Du bist der Sender, nicht der Zuschauer.**

---

## Worum es geht, in drei Sätzen

Der Player hat bis heute aus den **Zeitabständen** zwischen Bildern geschlossen,
ob eines fehlt. Diese Rechnung kann zwei Fälle nicht trennen — „ein Bild ging
verloren" und „der Sender hat für diesen Moment keines erzeugt" —, und deshalb
forderte er ein halbes Vollbild je Sekunde an, obwohl nichts fehlte. Neu trägt
der Strom eine **laufende Bildnummer** (AV1 Dependency Descriptor), an der beides
eindeutig ist.

Volle Herleitung: `docs/superpowers/specs/2026-08-21-dependency-descriptor-design.md`.
Umsetzungsplan: `docs/superpowers/plans/2026-08-21-dependency-descriptor.md`.

## Was schon bewiesen ist — und was nicht

**Bewiesen** (Linux sendet, Linux schaut, über den Hetzner-Dev-Stack):

```
Bildmarke ausgehandelt als extmap 1                      (Sender)
Rueckkanal — nack ja / pli ja / rtx NEIN / bildmarke ja  (Player)
Bildmarke — 120 von 120 Bildern tragen eine Nummer       (sie kommen an)
Vollbild #2 empfangen, Abstand 60003 ms                  (Abnahme)
Bildluecken: 0
```

**Nicht bewiesen:** der Windows-Sidecar. Sein Code ist zeilengleich mit der
Linux-Fassung (nachgewiesen: der Abstand zwischen beiden Dateien ist unverändert
8 Zeilen in `whip/av1.rs`, 122 in `whip/mod.rs`), aber er ist nie übersetzt
worden — **auf der Linux-Maschine baut er nicht**, und zwar aus einem Grund, der
dich betreffen könnte (s. unten „Falle 1").

**Dein Auftrag ist genau das:** übersetzen, senden, und die drei Zeilen im Log
bestätigen.

---

## Schritt für Schritt

### 1. Zweig holen

```powershell
cd <pulse-repo>
git fetch
git checkout feat/dependency-descriptor
```

Der Zweig steht auf `origin`, elf Commits über `main`. **Nicht nach `main`
mergen** — das ist ein Prod-Deploy und braucht die Freigabe des Besitzers.

### 2. Windows-Sidecar bauen

```powershell
cd streaming\win-hq-sidecar
bash scripts\bootstrap-windows-capture.sh     # Git-Bash oder WSL
cargo build --release
```

Ergebnis muss sein: `streaming\win-hq-sidecar\target\release\pulse-win-hq-sidecar.exe`.
`dev-remote` findet ihn von dort über die Aufwärtssuche, es braucht **keine
Umgebungsvariable** (anders als auf Linux).

> **Falle 1 — bitte melden, wenn sie zuschnappt.** `bootstrap-windows-capture.sh`
> scheitert auf Linux hart an **Zeilenenden**: die Fremdquelle hat gemischte
> Enden (`src/capture.rs` CRLF, `src/graphics_capture_api.rs` LF), der Patch ist
> LF, und `patch` meldet für jeden Hunk „different line endings". Die Meldung des
> Skripts behauptet stattdessen eine Versionsanhebung — das führt in die Irre.
>
> Auf Windows sollte es durchgehen (sonst schlüge jeder CI-Bau fehl). **Falls
> nicht: nicht selbst reparieren, sondern melden.** Der Fix fasst den
> Windows-Bauweg an, und das gehört nicht in denselben Zweig wie diese Änderung.
>
> Und: ein gescheiterter Lauf lässt `vendor/windows-capture` mit **ungepatchten**
> Quellen liegen. Ein späterer Bau nähme sie und verlöre stillschweigend das
> Cursor-Echo. Beim Abbrechen also löschen.

### 3. Diagnose einschalten und starten

```powershell
$env:PULSE_PLAYER_ERHOLUNG_LOG = "1"
pnpm dev:remote
```

Das fährt Vite und Electron **lokal** gegen den gemeinsamen Hetzner-Stack
(`https://pulse.unicutmedia.com`). Backend, MediaMTX und LiveKit laufen dort
schon — **du musst am Server nichts anfassen**, dort läuft bereits der neue
Fork `1.19.1-pulse5` mit gesetztem `PULSE_DEPENDENCY_DESCRIPTOR=1`.

### 4. Senden

Im Electron-Fenster anmelden, in einen **Sprachkanal** gehen, **HQ-Stream
starten**.

Einstellungen so wie heute Vormittag, als der Fehler auftrat:

| | |
|---|---|
| Codec | **AV1** |
| Bildrate | **60 fps** |
| Encoder | AMD (`av1_amf`) |

Zwei Minuten laufen lassen. Auf der Linux-Maschine wird zugesehen — das ist der
Empfänger, du bist nur der Sender.

### 5. Log lesen

`%APPDATA%\Pulse\sidecar.log`

```powershell
Get-Content "$env:APPDATA\Pulse\sidecar.log" -Tail 200 |
  Select-String -Pattern "Bildmarke|whip:|Vollbild"
```

---

## Was zu erwarten ist

**Die eine Zeile, auf die es ankommt:**

```
INFO whip: Bildmarke ausgehandelt als extmap N
```

Steht sie da, hat der Windows-Sidecar die Erweiterung angeboten, der Server hat
sie angenommen, und der Sidecar schreibt sie. Das ist dein Teil des Beweises.

**Steht stattdessen dies:**

```
WARN whip: Bildmarke nicht ausgehandelt — der Zuschauer kann fehlende Bilder
     nicht erkennen (Server ohne Patch 0006?)
```

dann hat die Aushandlung nicht geklappt. Der Server ist es nicht (dort läuft
pulse5 nachweislich, Linux hat gerade darüber gesendet) — also liegt es am
Windows-Sender. Dann brauche ich den vollen SDP-Austausch: `PULSE_HQ_LOG=debug`
setzen und neu starten.

---

## Was du zurückmelden sollst

1. Ob `bootstrap-windows-capture.sh` durchgelaufen ist (Falle 1).
2. Ob `cargo build --release` ohne Fehler durchlief — **und wenn nicht, die
   Fehlermeldung wörtlich.** Das ist der eigentliche Zweck: die Windows-Fassung
   der Änderung ist nie übersetzt worden.
3. Die Zeile `Bildmarke ausgehandelt als extmap N` (oder die Warnung).
4. Ob der Stream sichtbar lief und ob dir am Bild etwas auffiel.

---

## Was du NICHT tun sollst

- **Nicht nach `main` mergen**, nicht `scripts/ship.sh` fahren. Der Merge ist ein
  Prod-Deploy und braucht die Freigabe des Besitzers.
- **Nichts am Hetzner-Stack ändern.** Dort läuft der Testaufbau, den die
  Linux-Maschine gerade benutzt. Ein Neustart von `pulsetest_mediamtx` reisst
  deren laufende Messung ab.
- **Die Version nicht erneut bumpen** — `desktop/package.json` steht schon auf
  0.1.70, das gehört zu diesem Zweig.
- **Den Zeilenenden-Fehler nicht nebenbei reparieren**, falls Falle 1 zuschnappt.
  Eigener Zweig, eigene Prüfung.
- **Nicht pushen**, ohne zu fragen. Wenn am Windows-Code etwas zu ändern ist,
  erst zeigen.

---

## Wenn der Bau Fehler wirft

Wahrscheinlichster Ort ist `streaming\win-hq-sidecar\src\whip\mod.rs`, Funktion
`send` — dort wird die Marke an jedes Paket gehängt. Die Änderung ist
zeilengleich mit `streaming\linux-hq-sidecar\src\whip\mod.rs`, die übersetzt und
läuft. Ein Vergleich der beiden Dateien zeigt also sofort, ob etwas
verrutscht ist:

```powershell
git diff --no-index streaming\win-hq-sidecar\src\whip\mod.rs `
                    streaming\linux-hq-sidecar\src\whip\mod.rs | Measure-Object -Line
```

Erwartet sind **122 abweichende Zeilen** (der Stand vor der Änderung, plattform-
eigene Unterschiede). Sind es mehr, ist beim Spiegeln etwas schiefgegangen.

Für `whip\av1.rs` gilt dasselbe mit **8** Zeilen.

Die dritte geänderte Datei `whip\bildmarke.rs` ist ein **Zwilling** und muss
Byte für Byte gleich sein — das prüft der Test
`streaming/pulse-player/tests/zwillinge.rs`.
