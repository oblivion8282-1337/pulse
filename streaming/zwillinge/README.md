# zwillinge

Bewacht die noch verbliebenen doppelt gefuehrten Dateien der vier HQ-Programme
(`win-hq-sidecar`, `linux-hq-sidecar`, `mac-hq-sidecar`, `pulse-player`) auf
unbemerktes Auseinanderlaufen. Frueher waren das rund 2.400 Codezeilen ueber
mehrere Datei-Paare; die vier engsten davon (`whip/sdp.rs`, `whip/av1.rs`,
`zeitbasis.rs`, `zeigerbild.rs`) sind seit dem 2026-08-20 in eigene gemeinsame
Crates gezogen (`pulse-whip`, `pulse-zeitbasis`, `pulse-zeigerbild` — s.
Tabelle unten) und damit keine Doppelung mehr, die diese Kiste bewachen
muesste. Ebenso ist die Token-Redaktion, die frueher auf den drei Plattformen
verschieden ausfiel, seit Commit `5dd051e5` in `pulse-redact` vereinheitlicht.
Was bleibt, sind die Datei-Paare aus der Tabelle unten, die (noch) nicht
zusammengefuehrt sind. Der Anlass fuer diese Crate ist historisch: gleich
zweimal ist eine solche Kopie unbemerkt auseinandergelaufen (das damals noch
doppelt gefuehrte `zeitbasis.rs` am 2026-08-17, die Zero-Copy-Bruecke am
2026-08-06) — beide Male harmlos, beide Male reiner Zufallsfund. Die noch
verbliebenen Paare tragen dasselbe Risiko, solange sie nicht ebenfalls
zusammengefuehrt sind.

Diese Crate hat **keine Abhaengigkeiten** und **aendert nie Produktivcode**.
Wird ein Test rot, ist das der Befund — nicht der Test. `include_str!` liest
zur Uebersetzungszeit aus dem Repo, es muss also nichts von den fremden
Plattformen gebaut werden; die Tests laufen deshalb auf jeder Maschine und in
der CI (`.github/workflows/ci.yml`, Job `zwillinge`).

## Zweite Aufgabe: Listen von Hand nachrechnen

Seit die Doppelungen in gemeinsame Kisten (`pulse-*`) gezogen sind, steht an
mehreren Stellen im Repo je eine Liste, welche Kiste ein Programm braucht.
Diese Listen pflegt niemand automatisch, und eine fehlende Zeile faellt
jeweils nur auf **einer** der drei Maschinen auf — deshalb gehoeren sie
hierher, in die Crate, die ueberall laeuft.

| Test | Liste | was passiert, wenn eine Kiste fehlt |
|---|---|---|
| `tests/flatpak_kisten.rs` | `type: dir`-Quellen in `packaging/com.howispulse.Pulse.yml` | Flatpak-Bau **bricht** (cargo `--offline` findet die Pfad-Abhaengigkeit nicht) — nur dort, und erst in der CI nach dem Merge |
| `tests/bau_ausloeser.rs` | `on.push.paths` in `win-build.yml`, `mac-build.yml`, `flatpak.yml` | Es bricht **gar nichts**: der Bau laeuft nicht, und das Ausgelieferte bleibt still auf dem alten Stand |

Der zweite Fall ist der unangenehmere, weil es keinen Knall gibt. Beide Listen
gehen getrennt kaputt — `pulse-bildmarke` fehlte am 2026-08-22 in beiden.

Beide rechnen die Abhaengigkeiten **rekursiv** ueber
`zwillinge::kisten_von`: `pulse-whip` haengt selbst an `pulse-zeitbasis` und
`pulse-bildmarke`, eine Liste der direkt genannten Abhaengigkeiten uebersaehe
sie. Und beide werten **zeilenweise** aus statt byteweise — ein byteweiser
Vergleich mit `\n` findet auf Windows nichts, weil Git die Zeilenenden beim
Auschecken umwandelt (genau daran war die erste Fassung von
`flatpak_kisten.rs` gescheitert).

## Was hier bewacht wird — und was nicht

Am 2026-08-20 gemessen, Abweichung in Rohzeilen und nach Herausfiltern ganzer
Kommentarzeilen (`ohne_kommentare`, s. `src/lib.rs`):

| Datei | Paar | Abweichung roh | ohne Kommentare | Klasse |
|---|---|---|---|---|
| `ops/state.rs` | linux-mac | 0 | 0 | A: bitgleich |
| `proto.rs` | win-mac | 5 | 0 | B |
| `events.rs` | linux-mac | 8 | 0 | B |
| `profiles.rs` | linux-mac | 20 | 1 | C: fast gleich |
| `ops/stop.rs` | linux-mac | 8 | 2 | C |
| `ops/keyframe.rs` | win-linux | 29 | 2 | C |
| `events.rs` | win-linux | 51 | 4 | C |
| `ops/mod.rs` | linux-mac | 29 | 8 | C |
| `proto.rs` | win-linux | 57 | 39 | D: echt verschieden |
| `whip/mod.rs` | win-linux | 122 | 80 | D |

**`whip/pacer.rs` (win-linux) stand hier bis zum 2026-08-22 als Klasse D** —
also als Paar, das absichtlich verschieden bleiben sollte. Windows fuhr einen
eigenen Zuschnitt des Sendetakts, und welcher besser sei, war nicht gemessen.
Aufgeloest hat das nicht eine Messung, sondern die Einsicht, dass die beiden
sich nur bei kleinen Bildern unterschieden — dort, wo ein Schwall am wenigsten
schadet. Windows fuehrt seither denselben Taktgeber wie die anderen beiden;
Begruendung und Zahlen im Kopf von `streaming/pulse-whip/src/pacer.rs`.
**Merkposten fuer die Klassen-Einteilung hier:** "Klasse D" heisst nicht
"bleibt fuer immer" — es heisst "verschieden, und wir wissen nicht, ob
zu Recht". Das ist eine Frage, die man stellen kann, kein Endzustand.

**Vier Paare sind seit dem 2026-08-20 keine Zwillinge mehr, sondern
zusammengefuehrt** und deshalb aus der Tabelle oben entfernt: `whip/sdp.rs`
(win-linux-mac, war Klasse A: bitgleich), `zeigerbild.rs` (player-win, war
Klasse A: bitgleich), `whip/av1.rs` (win-linux-mac, war Klasse B: logisch
gleich, 8 Rohzeilen Abweichung) und `zeitbasis.rs` (win-linux, war Klasse B,
6 Rohzeilen Abweichung). Alle vier Dateien sind in ihren Sidecars/im Player
jetzt nur noch Re-Export-Einzeiler aus den gemeinsamen Crates `pulse-whip`
(`sdp.rs`, `av1.rs`), `pulse-zeigerbild` (`zeigerbild.rs`) und
`pulse-zeitbasis` (`zeitbasis.rs`) — ein Vergleich zweier Einzeiler haette
keinen Erkenntniswert mehr gehabt, die zugehoerigen Tests wurden deshalb
entfernt. Die eigentliche Logik samt ihrer eigenen Tests steht jetzt in
`streaming/pulse-whip/src/{sdp,av1}.rs`, `streaming/pulse-zeigerbild/src/lib.rs`
bzw. `streaming/pulse-zeitbasis/src/lib.rs`.

**Getestet sind nur Klasse A (`tests/bitgleich.rs`) und Klasse B
(`tests/logisch_gleich.rs`) — aktuell ein Paar Klasse A und zwei Paare
Klasse B, drei Tests insgesamt.** Klasse C und D sind hier **absichtlich
nicht vertreten**:

- **Klasse C** ("fast gleich", wenige Zeilen Abweichung nach Filter) sind
  Kandidaten fuer spaetere Etappen — dort werden sie zusammengefuehrt und
  verschwinden als eigenstaendige Doppelung ohnehin. Ein Test hier wuerde
  entweder sofort rot anschlagen (falsch, denn die Abweichung ist bekannt und
  noch nicht bereinigt) oder muesste die aktuelle Abweichung als Toleranz
  einbauen — beides ist fuer eine Uebergangsphase nicht die richtige Form von
  Test.
- **Klasse D** ("echt verschieden") sind **keine Zwillinge**. Die Dateien
  loesen auf den Plattformen unterschiedliche Probleme (z. B. `whip/mod.rs`:
  Windows traegt dort eine Bandbreiten-Schaetzung, die die anderen nicht
  haben). Ein Gleichheits-Test darauf waere in der Sache falsch. Dass die
  Einordnung trotzdem ueberprueft gehoert, zeigt `whip/pacer.rs` — es stand
  hier als Klasse D und ist es bei genauerem Hinsehen nicht gewesen (s. o.).

Beide Klassen sind hier nur **dokumentiert**, nicht getestet. Ohne diesen
Abschnitt entstuende der falsche Eindruck, diese Crate decke alle Doppelungen
im HQ-Streaming-Code ab — das tut sie nicht.

## Klasse A: bitgleich (`tests/bitgleich.rs`)

Fuer Paare, bei denen jede Abweichung — auch ein Kommentar — ein Fehler waere:
das Dateiformat selbst ist die Vertragsgrundlage zwischen den Seiten
(aktuell: die Zustandsabfrage des Sidecars).

## Klasse B: logisch gleich (`tests/logisch_gleich.rs`)

Fuer Paare, deren Kommentare **berechtigt** abweichen duerfen, weil sie auf
plattformeigene Module verweisen — das Muster, das den Fall ausgeloest hat,
war `zeitbasis.rs`: `crate::tick_monitor` unter Windows, `stream_controller.rs`
unter Linux (Datei liegt seit dem 2026-08-20 nicht mehr hier, s. o.). Verglichen
wird ueber `ohne_kommentare()` aus `src/lib.rs`.

## Die Grenze des Filters (`ohne_kommentare`)

`ohne_kommentare` entfernt **nur ganze Kommentarzeilen**. Ein Kommentar am
Zeilenende bleibt stehen und wird mitverglichen — das ist bewusst so, nicht
eine Luecke im Filter. `whip/av1.rs` (bis zum 2026-08-20 hier ein Klasse-B-Paar,
seither Re-Export aus `pulse-whip`) hatte allein 43 Kommentare am Zeilenende,
die auf beiden Seiten gleich waren; das ist bei einem Zwilling die richtige
Erwartung, und wer einen davon auf einer Plattform praezisiert, muss es auf
der anderen ebenso tun, sonst wird der Test rot.

Der Filter wird deshalb nicht erweitert, um `//` auch am Zeilenende zu
entfernen — das hiesse, `//` innerhalb von Zeichenketten von echten
Kommentaren zu unterscheiden, also Rust zu zerlegen. Ein Unit-Test haelt die
Grenze fest: `kommentar_am_zeilenende_bleibt_stehen` in `src/lib.rs`.

## Ein Paar hinzufuegen

- Zeichengenau gleich (Klasse A) -> `tests/bitgleich.rs`.
- Logik gleich, Kommentare duerfen wegen plattformeigener Verweise abweichen
  (Klasse B) -> `tests/logisch_gleich.rs`, ueber `ohne_kommentare()`.
- Weicht auch am Zeilenende ab und soll das duerfen -> hier falsch, braucht
  einen anderen Helfer, und es lohnt sich vorher zu fragen, ob es dann noch
  ein Zwilling ist.
