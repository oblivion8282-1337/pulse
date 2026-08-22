# Vorhalt beim Steuern: gemessen, gekoppelt — und warum es so noch nicht raus darf

Stand 2026-08-22, Zweig `feat/vorhalt-reserve-messen`. Vorgeschichte und
Messanleitung: `2026-08-22-vorhalt-messung-anleitung.md`. Herleitung der
Mechanik: `streaming/pulse-player/src/app/takt/{reserve,anpassung,fernsteuerung}.rs`.

**Diese Datei hält einen unfertigen Stand fest.** Der Umbau ist gebaut, getestet
und gemessen; er hat dabei einen Konstruktionsfehler in sich selbst gezeigt, der
noch offen ist. Wer hier weitermacht, fängt bei „Was noch fehlt" an.

## Ausgangslage

Der Vorhalt beim Steuern stand fest auf 30 ms und ging nie darunter. Die Zahl war
zweimal aus je einer einzelnen Messreihe gesetzt und beim nächsten Netz widerlegt
(5 ms am 12.08. gemessen gut, am 15.08. auf der Testinstanz jedes zweite Bild zu
spät, danach zurück auf 30). Die Frage war, ob sich die Untergrenze an eine
laufende Messung koppeln lässt, statt sie ein drittes Mal zu raten.

## Was gemessen wurde

Zwei Läufe, dieselbe Strecke, derselbe Startwert, beide gegen die Cloud
(`159.195.150.54`, howispulse.com), Linux steuert einen Windows-Rechner. Rohdaten:
`streaming/testbench/messungen/player-2026-08-22-vorhalt-{a,b}-*.log`.

| | A: fest 30 | B: messgekoppelt |
|---|---|---|
| Dauer | 86 s | 185 s |
| Vorhalt im Mittel | 32,1 ms | **37,0 ms** |
| Zeit bei 30 ms | 86 % | 1,6 % |
| knappste Reserve, Median | 3 ms | 4 ms |
| Nutzung (Viertel des Vorhalts) | 22/23/45/10 % | 20/34/36/10 % |
| verspätete Bilder | 1,15/s | 1,00/s |
| verdrängte Bilder | 0 | 0 |
| Paketverlust | 1 | — |

Ergänzend aus Lauf A: `Ankunft max` im Mittel 29,6 ms bei 60 fps (Soll 16,7),
13 Bilder je Sekunde mit mehr als 5 ms Abstand, Bitrate 3933 kbit/s.

### Erste Erkenntnis: 30 ms sind auf dieser Strecke nicht zu viel, sondern zu wenig

Die Erwartung der Messanleitung — reichliche Reserve, alles in der ersten Stufe,
Vorhalt kann deutlich herunter — trägt nicht. Über die Hälfte aller Bilder
verbraucht mehr als den halben Vorhalt, in 12 von 85 Sekunden kam ein Bild mit
0 ms Reserve durch. **Beide Läufe beginnen damit, dass der Regler von 30 auf 45
anhebt.** Diese Leitung will rund 40 ms.

### Zweite Erkenntnis: der alte Regler sägte bereits

In Lauf A, mit der festen Untergrenze, stehen vier Reglerentscheidungen:

```
30 -> 45 (12,5 zu spaet/s)     45 -> 30 (blind, volle Stufe)
30 -> 45 (10,5 zu spaet/s)     45 -> 30 (blind, volle Stufe)
```

Das Absenken ging in einem 15-ms-Sprung zurück auf die Basis, ohne jeden Bezug
zur Leitung — und musste danach sofort wieder klettern.

## Was gebaut wurde

Die Absenkung hängt jetzt an der gemessenen Reserve statt an einer festen Stufe
gegen eine geratene Basis.

* Startwert beim Steuern bleibt `FERN_VORHALT_MS` = 30 ms.
* Harte Untergrenze neu: `FERN_VORHALT_MIN_MS` = 5 ms (`fernsteuerung.rs`).
* Ein Absenkschritt verbraucht höchstens **die Hälfte der knappsten Reserve**
  (`MESS_TEILER`), gedeckelt durch die bestehende Stufe von 15 ms.
* Drei Riegel, alle fail-closed auf das alte Verhalten: nur während einer
  Fernsteuerung, nur ab 30 gemessenen Bildern (`MESS_MINDESTBILDER`), nur gegen
  den geltenden Vorhalt.
* Ein Verhältnis statt einer Millisekundenzahl ist Absicht: genau an einer festen
  Zahl ist der Wert zweimal gescheitert.

**Beim Zusehen ändert sich nichts, und das ist prüfbar:** `senk_boden_ms` verlangt
`vorhalt_vor_fern.is_some()`, und `fernsteuerung()` hat genau einen Aufrufer,
`app/eingabe.rs:73` (Eingabe-Erfassung).

Test zuerst, jeder erst rot gesehen: 422 bestanden, 0 fehlgeschlagen (vorher 413).
Neu abgesichert sind Abstieg bis an die harte Grenze, Halten der harten Grenze bei
absurd großer Reserve, kleiner Schritt bei knapper Reserve (4 ms gemessen → 2 ms
Schritt), Rückfall auf das alte Verhalten ohne Messung, Bindung der Basis außerhalb
der Fernsteuerung, Erreichbarkeit eines tieferen Nutzerwerts.

### Verhalten in Lauf B

```
30 -> 45 (10,4 zu spaet/s)     45 -> 39 -> 35                      (Reserve 12, 8 ms)
35 -> 50 (10,9 zu spaet/s)     50 -> 43 -> 41 -> 39 -> 38 -> 35 -> 33 -> 31
31 -> 46 ( 6,5 zu spaet/s)     46 -> 37                            (Reserve 18 ms)
```

Die Mechanik arbeitet wie entworfen: kleine, von der Messung bemessene Schritte
statt eines blinden Sprungs. **Die 5 ms wurden nie angesteuert** — tiefster Wert
im ganzen Lauf war 30. Die Messung hat die Absenkung 185 Sekunden lang verweigert,
obwohl der Boden bei 5 lag. Das ist der Beleg, dass der Riegel greift.

**Ein Gewinn an Reaktionszeit ist es trotzdem nicht:** der Vorhalt liegt im Mittel
5 ms höher als vorher. Der neue Abstieg ist vorsichtiger als der alte blinde
Sprung, und auf einer Strecke ohne Reserve heißt vorsichtig eben langsam. Bezahlt
wird Verzögerung, gekauft werden 13 % weniger verspätete Bilder — der Tausch geht
in die Richtung, aus der wir wegwollten.

## Was noch fehlt — und warum der Stand so nicht ausgeliefert werden darf

**Das Beweisfenster ist kürzer als der Ausfalltakt der Leitung.**

Der Regler entscheidet aus den letzten **zwei Sekunden**, wie tief er darf. Wann
diese Leitung ausfällt, steht in denselben Protokollen:

```
Lauf A:   17:42:14        17:43:24                     Abstand 70 s
Lauf B:   18:08:08   18:08:32        18:10:45          Abstand 24 s, dann 133 s
```

Alle 24 bis 133 Sekunden. Das Beweisfenster ist also zwölf- bis fünfundsechzigmal
kürzer als der Takt, in dem die Strecke danebengreift — der Regler kann die
schlechten Momente prinzipiell nicht sehen. Er misst eine Ruhepause und hält sie
für die Leitung.

In Lauf B ist es live zu beobachten: In den 133 ruhigen Sekunden zwischen 18:08:32
und 18:10:45 stieg er acht Stufen ab (50 → 31), dann riss ihn der nächste Schwall
auf 46. Gerettet hat ihn hier nur, dass jeder Schritt winzig war, weil kaum
Reserve da war. **Auf einer Leitung mit Luft zwischen den Schwällen hätten
dieselben 133 Sekunden gereicht, um bis auf 5 durchzurutschen** — und dann trifft
der Schwall einen Vorhalt, der ein Sechstel dessen ist, was er auffangen müsste.
Das ist genau der Zustand vom 15.08.

Die alte feste 30 war eine schlechte Zahl, aber ein funktionierender Ersatz für ein
Gedächtnis, das der Regler nicht hat. Der Umbau hat die Zahl ersetzt, ohne das
Gedächtnis mitzuliefern.

Bimodale Leitungen — ruhig mit seltenen Schwällen — sind nicht der Sonderfall,
sondern der Normalfall bei WLAN, Mobilfunk und geteiltem Hausanschluss. Der Stand
ist deshalb für uns hier unbedenklich (der riskante Bereich wird auf dieser Strecke
nicht erreicht) und für fremde Nutzer nicht.

### Vorschlag für den nächsten Durchgang

Gleiche Struktur, längeres Gedächtnis:

1. **Der Abstieg wird von der schlechtesten Reserve über Minuten begrenzt**, nicht
   über zwei Sekunden. Ein Schwall von vor einer Minute bindet dann noch. Die
   Größenordnung liefert die Messung oben: Ausfalltakt 24–133 s.
2. **Jede Anhebung löscht das Abstiegsguthaben.** Die Leitung hat gerade bewiesen,
   dass sie ausfällt; danach fängt das Vertrauen von vorn an.
3. **Absenken darf langsam sein.** Es ist nie dringend — zu tief zu stehen kostet
   sofort sichtbar, zu hoch zu stehen kostet nur Millisekunden.

Zusätzlich erwägenswert: **das Anheben ebenfalls an die Reserve hängen** statt an
bereits verlorene Bilder. Der Regler reagiert heute erst, wenn Bilder zu spät sind
(`HOCH_AB` = 5/s); in Lauf A lag die Rate bei 1,15/s, während die knappste Reserve
schon bei 0 ms stand. Er merkt also nicht, dass es eng wird, sondern erst, dass es
brennt.

### Vor einer Auslieferung offen

* Ein Lauf auf einer wirklich ruhigen Strecke — der Abstieg unter 30 hat außerhalb
  der Unit-Tests **nie stattgefunden**.
* Eine Gegenprobe auf einer schlechten Strecke (Hetzner-Testinstanz, 47 ms) als
  Beweis, dass er dort hochgeht statt zu ruckeln.
* Windows-Auslieferung braucht einen Version-Bump (`pulse-player` liegt seit dem
  05.08. im Installer).
* `code-simplifier` über die geänderten Dateien (Disziplinregel aus `CLAUDE.md`),
  bislang nicht gelaufen.

## Nebenbefund, unabhängig vom Vorhalt

`Ankunft max` liegt im Mittel bei 29,6 ms, wo bei 60 Bildern/s 16,7 stehen müssten,
bei Paketverlust 1 auf der ganzen Strecke. Das sieht nach Bündelung auf der
Senderseite aus, nicht nach einer unruhigen Leitung. Eine Gegenprobe mit
`PULSE_HQ_FERN_TICKRASTER=1` auf dem Windows-Rechner würde das in einem Lauf
klären. Trifft es zu, liegt der Hebel für kürzere Reaktionszeit dort und nicht im
Vorhalt — der ist auf dieser Strecke bereits das Minimum dessen, was sie verlangt.
