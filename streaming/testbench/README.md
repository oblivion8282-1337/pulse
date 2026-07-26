# Prüfstand für den HQ-Streaming-Weg

Fährt einen echten Stream **ohne App, ohne Klick** — Token selbst in Redis,
Sender starten, nativen Player öffnen, Messwerte einsammeln, alles abräumen.
Gebaut am 2026-07-26, weil das Suchen der Ruckel-Ursache sonst bei jedem Versuch
zwei Electron-Neustarts, eine Quellenauswahl und einen Klick auf Play gekostet
hätte — und weil eine Messung, die von Handgriffen abhängt, selten wiederholt
wird.

Zwei Sender stehen zur Wahl, und der Unterschied ist der Witz an der Sache:

| Skript | Sender | Wofür |
|---|---|---|
| `harness.py` | ffmpeg, vorkodierte Datei per `-c copy` | Referenz: exakt gleichmäßig, ganz ohne unseren Code. Zeigt, ob ein Symptom vom Sender kommt oder dahinter entsteht. |
| `real-harness.py` | Linux-Rust-Sidecar | Der echte Weg: Aufnahme → Encode → RTMPS. |

## Voraussetzungen

* Dev-Infrastruktur läuft: MediaMTX (`streaming/server/docker-compose.yml`),
  Redis auf 6380, `mediamtx-auth-hook` auf 8005. `scripts/dev-up.fish` bringt alles.
* `pulse-player` gebaut: `cd streaming/pulse-player && cargo build --release`.
* Für `real-harness.py` zusätzlich der Linux-Sidecar (eigenes Repo, Pfad in
  `real-harness.py`).
* Für `harness.py` einmalig die Vorlage erzeugen (bleibt liegen, ~32 MB):

  ```bash
  ffmpeg -f lavfi -i "testsrc2=size=2560x1440:rate=144" \
         -f lavfi -i "sine=frequency=440:sample_rate=48000" \
         -t 10 -vf format=yuv420p10le \
         -c:v av1_nvenc -preset p4 -rc cbr -b:v 25M -g 144 \
         -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv \
         -c:a libopus -b:a 128k -ac 2 synth10.mkv
  ```

  Auf der CPU umrechnen und gleichzeitig senden geht **nicht** — dann hinkt der
  Referenzsender selbst („Resumed reading … after a lag of 0.4s") und taugt
  nicht mehr als Vergleich. Deshalb erst kodieren, dann nur umpacken.

## Benutzung

```bash
./harness.py --secs 12                 # Referenzsender, mit Ton
./harness.py --secs 12 --noaudio       # Gegenprobe ohne Ton
./real-harness.py --secs 14 --fps 200  # echter Sender
./real-harness.py --fps 60 --audio Aus
```

Ausgabe je Lauf: `player-<label>.log`, `send-<label>.log` bzw.
`push-<label>.log` und `samples-<label>.json` (alle Proben roh).

Der **Portal-Dialog erscheint nur beim ersten Lauf**: `real-harness.py` setzt
`PULSE_PORTAL_REUSE=1`, der Sidecar legt das Restore-Token des Portals ab und
startet danach ohne Klick. Ohne diese Variable bleibt es beim Dialog — im
Produkt ist der Dialog unter Wayland ja die Quellenauswahl, still übergehen
darf man ihn nicht.

## Die Zahl, auf die es ankommt

Im Player-Log:

```
Abstand 0.6-5.8 ms (0 zu spaet), Ankunft max 5.6 ms
```

* **Ankunft max** — größter Abstand zwischen zwei eintreffenden Videopaketen.
  Zeigt Bündelung auf dem Weg zum Zuschauer.
* **zu spät** — Ausgabe-Abstände über dem **doppelten** Soll (also 13,9 ms bei
  144 fps, aber nur 7,1 ms bei 280 fps). Das ist das, was man als Ruckeln
  sieht: die Bildzahl je Sekunde kann stimmen, während einzelne Bilder doppelt
  so lange stehen und andere sich drängeln.

Bildzahl, Bitrate und Paketverlust allein sagen darüber **nichts** — die sahen
während des ganzen Ruckelns tadellos aus.

## Ende zu Ende messen

```bash
./real-harness.py --secs 22 --fps 60 --kbps 4000 --e2e --label <name>
```

`--e2e` startet zusätzlich `latency-pattern.py`: auf jedem Bildschirm ein
Vollbild-Fenster (ganz nach hinten gestellt) mit einem Balken aus schwarzen und
weißen Klötzen, der die Millisekunden seit einer gemeinsamen Epoche kodiert. Der
Player liest ihn aus der Luma-Ebene des dekodierten Bildes zurück und rechnet
`jetzt − abgelesene Zeit`.

Das Bild trägt die Uhrzeit also selbst — nötig, weil der Weg über FLV, RTMP,
MediaMTX und WebRTC führt und jede Station Zeitstempel umschreibt. Was im Bild
steht, übersteht alle davon. Kein Bildschirmfoto, keine Texterkennung, keine
Fensterposition, kein Handgriff.

Im Player-Log:

```
pulse-player: Sitzung 1, Ende-zu-Ende 96.1/104.0 ms (0 ohne Muster)
```

Die letzte Zahl ist die Kontrolle: **„ohne Muster" muss 0 sein**. Steht dort
etwas anderes, war der Balken verdeckt oder das Muster lief auf einem Bildschirm,
den der Sender nicht aufnimmt — dann ist der Mittelwert nur über die restlichen
Bilder gebildet.

Zwei Dinge, die man wissen muss, um die Zahl nicht zu überschätzen:

* Sie ist eine **Obergrenze**. Der Anzeigeverzug des messenden Fensters steckt
  mit drin (Qt malt, der Compositor zeigt es einen Bildtakt später).
* Das Muster-Fenster **erzeugt Last**. Beim ersten Aufbau war das grob genug, um
  die Messung zu verfälschen (Dekodieren 1,6 → 4,8 ms, Aufnahme auf 30 Bilder).
  Deshalb wird nur der Bereich der Balken neu gezeichnet, nicht die Fläche, und
  das Raster ist 8 ms — feiner gemessen wurde die Zahl schlechter, nicht besser.

## Bildqualität messen

```bash
./real-harness.py --secs 12 --fps 60 --kbps 4000 --quality --content synth10.mkv --label <name>
./compare-quality.py --ref ref-<name>.raw --rec rec-<name>.mkv --frames 100
```

`--quality` schaltet zwei Mitschnitte ein und spielt Bildinhalt ab:

* **Referenz** — der Sender schreibt mit `PULSE_DUMP_RAW` verlustfrei mit, was er
  dem Encoder *hineingibt*. Damit ist „gegen das Original" messbar statt nur
  „Variante gegen Variante". Unkomprimiert: gut **660 MB je Sekunde**, Grenze
  180 Bilder (rund 2 GB). Auf eine SSD, nicht nach `/tmp` — das ist
  Arbeitsspeicher.
* **Empfang** — der Player nimmt den empfangenen Bitstrom auf, ohne Neukodierung.
* **Inhalt** — `--content` spielt ein Video auf *allen* Bildschirmen in
  Endlosschleife (mpv). Ohne bewegtes Bild sagt eine Qualitätsmessung nichts, und
  welchen Bildschirm der Sender aufnimmt, steht nicht fest.

`compare-quality.py` ordnet die beiden Seiten über die **Bildinhalte** zu (das
erste Bild der Aufnahme gegen die ersten Referenzbilder, kleinste mittlere
Abweichung gewinnt) und misst dann VMAF, PSNR und SSIM. Zeitstempel taugen dafür
nicht: beide Seiten haben eigene Uhren mit unbekanntem Versatz. Die gemeldete
Abweichung der Zuordnung ist die Kontrolle — Werte um 2 bis 3 sind gut, ein
zweistelliger Wert bedeutet, dass die Zahlen darunter wertlos sind.

Zwei Dinge über die absoluten Zahlen: `testsrc2` ist ein **schwerer Sonderfall**
(Rauschen und Kanten überall), und 4000 kbps bei 1440p60 sind 0,018 bit je
Bildpunkt. VMAF um 25 ist dort normal und sagt nichts über Bildschirminhalt.
Vergleiche zwischen Einstellungen sind damit belastbar, absolute Urteile nicht.

## Die Kette aufteilen

`dump-latency.py` misst den letzten Posten, der lange nur erschlossen war: von
der Anzeige bis zum Encoder-Eingang. Es braucht einen Lauf mit **beidem** —
`--quality` (schreibt den Mitschnitt) und `--e2e` (zeigt das Zeitmuster):

```bash
./real-harness.py --secs 14 --fps 60 --kbps 4000 --quality --e2e --label z
./dump-latency.py --ref ref-z.raw --epoch <Epoche aus dem Player-Log>
```

Es funktioniert, weil zwei Uhrzeiten zusammentreffen: im Bild steht, wann es
gemalt wurde, in der `.pts`-Liste steht (zweite Spalte, vom Sender), wann genau
dieses Bild beim Encoder ankam.

Damit sind alle Posten der Kette direkt gemessen statt geschätzt, und der Rest
ist eine einfache Subtraktion.

## Was damit gefunden wurde (2026-07-26)

Der Ton bündelte das Bild. FLV ist eine einzige Zeitleiste, der Muxer gibt ein
Bild erst frei, wenn Ton mit passendem Zeitstempel vorliegt — bei 20-ms-Opus
und 21-ms-Aufnahmeraster gingen die Bilder in 20-ms-Bündeln heraus. Der
Referenzsender zeigte dasselbe Muster und entlastete damit unseren Sender; die
Ursache lag im Zusammenspiel von Tonraster und Muxer. Behoben an der Quelle
(5-ms-Opus-Pakete + feines PipeWire-Raster), nicht am Interleave-Delta — daran
zu drehen half nur einer Bildrate und ließ bei 280 fps die Schreibreihenfolge
kippen. Begründung im Code: `src/encode/mod.rs` und `src/capture/audio.rs` des
Linux-Sidecars.
