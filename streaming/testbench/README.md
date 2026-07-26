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
