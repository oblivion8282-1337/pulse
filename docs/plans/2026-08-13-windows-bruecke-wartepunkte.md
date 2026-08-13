# Zwei unbegrenzte Wartepunkte im Windows-Bildweg (2026-08-13)

**Für die Windows-Maschine.** Der Befund stammt aus einem Bughunt über Player
und Fernsteuerung, ist am Code bestätigt — und lässt sich auf dem Linux-Rechner
**nicht umsetzen**: der Code steht hinter `cfg(windows)`, dort gibt es kein
`rustup` und damit keine Quer-Übersetzung, und die `windows`-Kiste liegt nicht
einmal lokal vor. Blind geschrieben wäre er gefährlicher als der Fehler selbst
(s. „Die Falle").

## Der Befund

`streaming/pulse-player/src/zerocopy/bruecke.rs` wartet an **zwei** Stellen ohne
Zeitgrenze:

| Zeile | Aufruf | Wartet auf |
|---|---|---|
| 372 | `platz.mutex.AcquireSync(0, INFINITE)` | den Renderer, der den Platz freigibt |
| 435 | `WaitForSingleObject(self.zaun_ereignis, INFINITE)` | die Grafikeinheit (Zaun nach der Kopie) |

Beide liegen im Dekodier-Pfad, der selbst im Tokio-Task der Sitzung läuft.
Blockiert einer davon, steht **die ganze Sitzung** — und zwar ohne Rückfall:

* Der Einfrier-Wächter (`einfrieren/`) misst erst, NACHDEM ein Bild fertig
  dekodiert wurde. Kommt keins mehr, misst er nichts und greift nie.
* Der Rettungsweg auf Software-Dekodierung hängt an derselben Kette.

Ergebnis für den Nutzer: eingefrorenes Bild, keine Meldung, kein Rückfall, bis
er das Fenster selbst schliesst.

Der Code **misst die Wartezeit bereits** und meldet sie ab `LANGSAM` (100 ms,
Zeile 111) getrennt je Wartepunkt — die Unterscheidung hat am 2026-08-07 einen
halben Messtag gekostet und ist es wert, erhalten zu bleiben. Es fehlt nur die
Konsequenz: melden ja, abbrechen nein.

## Die Falle — bitte vor dem Schreiben lesen

**`IDXGIKeyedMutex::AcquireSync` liefert eine Zeitüberschreitung als
ERFOLGS-Code.** `WAIT_TIMEOUT` ist `0x00000102`, also positiv; ein
`.context("AcquireSync")?` sieht darin **keinen** Fehler.

Wer also nur `INFINITE` durch eine Zahl ersetzt und das `?` stehen lässt, baut
sich einen schlimmeren Fehler ein als den, den er behebt: der Code läuft weiter,
als hielte er die Sperre, und schreibt in eine Fläche, die der Renderer noch
benutzt. Aus einem eingefrorenen Bild würden beschädigte Bilder oder ein
Absturz — und die CI merkt davon nichts, weil es sauber übersetzt.

Der Rückgabewert muss also **ausdrücklich** auf `WAIT_TIMEOUT` geprüft werden,
nicht über `?`.

Beim zweiten Wartepunkt ist es unkritischer: `WaitForSingleObject` gibt
`WAIT_TIMEOUT` als eigenen Wert zurück und wird ohnehin von Hand ausgewertet
werden müssen.

## Was zu tun ist

1. Beide Wartepunkte mit einem endlichen Zeitlimit versehen. Ein Vorschlag zum
   Diskutieren, nicht zum Übernehmen: **250 ms**. Deutlich über `LANGSAM`
   (100 ms, also über dem, was als „langsam, aber normal" gilt) und weit unter
   dem, was ein Zuschauer als Standbild wahrnimmt.
2. Bei Überschreitung **nicht** weiterlaufen, sondern einen Fehler nach oben
   geben, damit der vorhandene Rettungsweg greift: Zero-Copy aufgeben und über
   den Hauptspeicher weitermachen (dieser Weg existiert bereits, s.
   `decode.rs`/`render/`), notfalls die Sitzung neu aufbauen.
3. Den Fall **zählen und melden**, nicht still schlucken — nach demselben
   Muster wie die bestehenden `LANGSAM`-Meldungen. Ein Rückfall, den niemand
   sieht, ist die Sorte Fehler, die dieses Projekt schon mehrfach eingeholt hat.
4. Prüfen, ob `ReleaseSync` (Zeile 383) im Zeitüberschreitungs-Fall **nicht**
   gerufen werden darf — die Sperre wurde ja nie erlangt.

## Was nicht geprüft ist

* **Ob 250 ms passen.** Der Wert ist geraten. Am laufenden Bildweg nachmessen:
  wie lange dauert die Anmeldung am Platz im Normalfall, wie weit streut sie
  unter Last (144 fps, HDR, mehrere Streams)?
* **Wie oft der Fall überhaupt eintritt.** Der Auslöser ist ein bereits
  abnormaler Zustand (hängender Treiber, abgestürzter Renderer-Thread). Es kann
  gut sein, dass es nie eintritt — das ändert nichts daran, dass es dann keinen
  Ausweg gibt.
* **Ob der Rückfall auf den Hauptspeicher-Weg mitten in einer Sitzung wirklich
  trägt.** Das ist der eigentliche Prüfpunkt und braucht einen echten Lauf.

## Herkunft

Bughunt vom 2026-08-13 (sechs Suchrichtungen, jeder Befund von einem zweiten
Agenten adversarisch geprüft). Dieser Befund wurde in beiden Prüfrunden
bestätigt. Drei weitere Befunde derselben Runde sind bereits behoben:
Fernsteuerungs-Anfrage überlebte den Kontowechsel, Ton verstummte lautlos beim
Geräteverlust, und Abbrechen mit sofortiger Neuanfrage verklemmte beide Seiten.
