# Echo und Rauschen auf iOS messen (Roadmap-Punkt 22)

**Warum hier keine Mechanik gebaut wurde.** Die Roadmap sagt „Nur RNNoise
(web, lazy) → System-AEC dazu, Kombination am Gerät messen". Beides ist schon
da, und zwar ohne Zutun:

- **System-AEC und -Rauschunterdrückung laufen seit Punkt 21.** Sie hängen
  nicht an einem eigenen Schalter, sondern am Modus `.voiceChat` der
  Audio-Session (`AudioSessionPlugin.swift`). Wer `.voiceChat` setzt,
  bekommt sie; es gibt nichts zusätzlich einzuschalten.
- **RNNoise ist längst abschaltbar** — `settings.audio.noiseSuppression`
  kennt `off`, und die Einstellung liegt in der Oberfläche.

Es fehlt also kein Schalter, sondern eine **Messung**. Solange die nicht
vorliegt, bleibt die Vorgabe unverändert: eine Umstellung ohne Zahlen wäre
genau die Sorte Behauptung, die dieses Repo sonst vermeidet.

## Die Frage

Auf einem Telefon laufen zwei Rauschunterdrückungen hintereinander: die von
iOS (im Signalweg vor der WebView) und RNNoise (im Web-Audio-Graphen davor
bzw. danach). Drei Möglichkeiten, und alle drei kommen in der Praxis vor:

1. **Zusammen besser** — dann bleibt alles, wie es ist.
2. **Zusammen schlechter** (die zweite Stufe frisst Sprachanteile, die die
   erste schon ausgedünnt hat; typisch klingt das blechern oder „schluckt"
   Wortanfänge) — dann gehört RNNoise auf iOS standardmässig aus.
3. **Kein hörbarer Unterschied** — dann gehört RNNoise auf iOS aus, weil es
   auf einem Telefon Rechenzeit und Akku kostet, ohne etwas beizutragen.

## Aufbau

Zwei Geräte, ein Sprachkanal, ruhiger Raum. Gerät A ist das iPhone (Prüfling),
Gerät B der Zuhörer und Mitschneider (Rechner, Browser).

Je Durchgang auf Gerät A: **Einstellungen → Audio → Rauschunterdrückung**
umschalten, Sprachkanal neu betreten (die Kette wird beim Beitreten gebaut).

## Die vier Durchgänge

| # | RNNoise auf A | Bedingung |
|---|---|---|
| 1 | aus | still |
| 2 | an | still |
| 3 | aus | Störquelle |
| 4 | an | Störquelle |

Als Störquelle etwas Gleichmässiges, Wiederholbares: Lüfter, laufender
Wasserhahn, Verkehrsgeräusch aus einem Lautsprecher in festem Abstand. **Nicht
Musik** — die ist zu ungleichmässig, um zwei Durchgänge zu vergleichen.

Je Durchgang dasselbe sprechen (ein fester Satz, rund 15 s), auf B
mitschneiden.

## Worauf zu achten ist

- **Wortanfänge.** Die verlässlichste Spur für Überfilterung: „Perfekt" wird
  zu „erfekt". Dafür reicht Hören, dafür braucht es keine Messtechnik.
- **Echo-Rest**, wenn A auf Lautsprecher steht und B spricht. Das ist der
  Teil, den iOS übernimmt — RNNoise kann hier nichts beitragen, denn es kennt
  das Gegensignal nicht.
- **Grundrauschen in den Sprechpausen** (Durchgang 3 gegen 4).
- **Akku/Wärme** am iPhone nach 10 Minuten je Zustand. RNNoise läuft als
  WASM-Worklet im Audio-Thread; wenn es nichts beiträgt, ist das der Grund,
  es abzuschalten.

## Eintragen

Ergebnis hierher, mit Datum und Gerät. Ändert sich daraufhin die Vorgabe,
gehört die Begründung an die Stelle im Code, die sie setzt — nicht nur in
dieses Dokument.
