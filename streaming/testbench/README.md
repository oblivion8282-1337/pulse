# Prüfstand für den HQ-Streaming-Weg

> **Intra-Refresh ist am 2026-08-21 aus Pulse entfernt worden.** Die
> Betriebsart, um die es auf diesem Blatt streckenweise geht, gibt es nicht
> mehr: kein Kästchen, kein Health-Feld, keine Encoder-Optionen, keine
> FFmpeg-Patches. Gründe waren das sichtbar schlechtere H.264-Bild, dass macOS
> sie nie trug, und dass ein Vollbild-Strom sich nach Paketverlust selbst
> repariert — ein Intra-Refresh-Strom nicht. Die zugehörigen Messakten sind
> gelöscht, weil sie teils nie bestätigt und teils später widerlegt wurden.
>
> **Was hier über die Betriebsart steht, ist Historie und keine Anleitung.**
> Methodik, Aufbau und alles Übrige gelten weiter.


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

## Wie die Messakten in `profiles/` zu lesen sind

Es sind inzwischen **88 Stück**, und sie sind **append-only**: eine Akte wird
nicht überschrieben, wenn sich herausstellt, dass ihr Schluss falsch war. Das
ist Absicht — der Irrweg gehört zum Beleg —, aber es heißt auch: **eine Akte
allein ist nicht der Stand der Dinge.** Ein Datum später kann alles umdrehen.

Drei Regeln fürs Lesen, jede aus einem Fall, in dem genau das schiefging:

1. **Erst auf einen Nachtrag sehen, dann auf den Befund.** Die Felder heißen
   `nachtrag_<datum>_*`, `behoben_am` oder tragen im `stand` ein Wort wie
   „VERWORFEN". Beispiel: `vulkan-2026-08-01-d3d11-import-zerocopy` beantwortet
   die Frage „geht der Bildweg zero-copy nach Vulkan" mit einem sauberen Ja —
   und ist als **Lösung** trotzdem verworfen, weil der Weg, für den es sie
   brauchte, sich als überflüssig erwies. Der Nachtrag steht drin; wer nur den
   Befund liest, baut den Vulkan-Weg nach.
2. **Die Frage einer Akte trägt oft eine Annahme.** Dieselbe Akte fragt im
   Nebensatz nach dem Encoder, „der als EINZIGER Intra-Refresh kann". Diese
   Annahme war am nächsten Tag widerlegt — die Messung darin bleibt richtig,
   ihr Anlass nicht.
3. **Eine Messung altert anders als eine Empfehlung.** Zahlen bleiben, was sie
   waren. Der Schluss daraus kann kippen, sobald sich etwas anderes ändert.
   `2026-07-30-amd-windows-messung` misst korrekt, dass D3D12 latenzärmer ist
   als AMF — die daraus gezogene Aufteilung („H.264 über D3D12") ist am
   2026-08-04 trotzdem aufgegeben worden.

**Die vier Umkehrungen, die dieser Prüfstand bisher erlebt hat**, damit niemand
auf halbem Weg stehenbleibt:

| Erst gemessen | Später berichtigt | Wo die Korrektur steht |
|---|---|---|
| „AMF kann kein Intra-Refresh" (2026-08-01) | Kann es doch — die Option heißt nur anders | `amf-2026-08-02-intra-refresh-doch` |
| 10-Bit-Magenta liegt am eigenen D3D11-Import | Liegt im Vulkan-Encode-Weg | `amd-2026-08-02-qualitaet-und-browser` |
| Adaptive Parität repariert nichts (2026-07-31) | Tut sie doch — mit dem NACK statt `fraction lost` als Regelgröße | `fec-2026-08-04-adaptiv-ueber-nack` |
| Browser bekommen keine FlexFEC-Parität (2026-07-29) | Bekommen sie | `fec-2026-08-01-windows-browser` |

Und die Regel, die aus allen vieren folgt: **ein Lauf je Variante trägt keine
Entscheidung.** Zwei der obigen Umkehrungen kamen zustande, weil der zweite
Durchgang das Gegenteil zeigte.

## Voraussetzungen

* Dev-Infrastruktur läuft: MediaMTX (`streaming/server/docker-compose.yml`),
  Redis auf 6380, `mediamtx-auth-hook` auf 8005. `scripts/dev-up.fish` bringt alles.
* `pulse-player` gebaut: `cd streaming/pulse-player && cargo build --release`.
* Für `real-harness.py` zusätzlich der Linux-Sidecar — liegt im Baum
  (`streaming/linux-hq-sidecar/`), muss aber gebaut sein
  (`cargo build --release`); Pfad-Kandidaten stehen in `real-harness.py`.
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
./fern-harness.py --secs 30 --e2e      # echter Server statt lokaler Schleife
./vergleich-browser-nativ.py --proben 14   # Normalweg gegen nativen Player
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

## Über die echte Leitung messen

`fern-harness.py` fährt denselben Ablauf gegen einen entfernten Server statt
gegen die lokale Schleife. Das ist der einzige Aufbau, der misst, was ein Nutzer
erlebt — und der Unterschied ist keine Feinheit: dieselbe Kette lag lokal bei
16,3 ms und über die echte Leitung bei 143, bei nur 26,7 ms Laufzeit.

```bash
./fern-harness.py --secs 30 --fps 60 --kbps 4000 --e2e --label fern1
./fern-harness.py --proto srt --codec h264 --bits 8 --label srt1
```

Die Token legt es per `ssh` + `docker exec … redis-cli` direkt in die Redis des
Zielcontainers; media-svc ist nicht im Spiel, die Push-Adresse baut der
Prüfstand selbst. Genau deshalb kann er auch Wege fahren, die media-svc gar
nicht ausgibt — `--proto srt` etwa. Server, Zugang und Ports stehen in
`PULSE_FERN_*`.

Zwei Dinge, die man vorher wissen muss:

* **SRT trägt kein AV1.** MPEG-TS hat dafür keine reguläre Zuordnung, ffmpeg
  schreibt es als „private data stream", MediaMTX erkennt es nicht — beim
  Zuschauer kommt nur Ton an. SRT-Läufe brauchen `--codec h264`.
* **Der SRT-Puffer erklärt die SRT-Latenz nicht.** Von 120 auf 40 ms gesenkt
  änderte am 2026-07-27 vier Millisekunden von rund 305. Die Ursache liegt
  woanders und ist offen.

## Normalweg gegen nativen Player

`vergleich-browser-nativ.py` misst beide Wege an **einem** Sendedurchlauf. Der
Browser bekommt die Latenz nicht aus einer Sonde, sondern physisch: ein Foto
über Quell- und Wiedergabe-Schirm enthält beide Balken im selben Augenblick.

```bash
./vergleich-browser-nativ.py --proben 14 --label bn1
```

Drei Schirme mit Rollen — Quelle (Zeitmuster, wird aufgenommen), Wiedergabe
(Browser im Vollbild, also 1:1) und einer frei für das Player-Fenster. Dafür
gibt es `pattern-one.py`: das normale `latency-pattern.py` bemalt **jeden**
Schirm, seine Balken lägen dann exakt über den übertragenen und beide wären
unlesbar.

**Die beiden Zahlen sind nicht bis auf die Millisekunde vergleichbar** — die
Foto-Messung enthält Compositor und Anzeigeverzug, die Sonde des Players nicht.
Aussagekräftig ist der Verlauf INNERHALB eines Laufs; so fiel auf, dass die
Browser-Latenz im Lauf wächst (177 → 232 ms), während der native Player flach
bleibt.

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

## Was damit gefunden wurde (2026-07-31)

**Der Player warf seine eigenen Reparaturen weg.** webrtc-rs gibt dem
SRTP-Wiedergabeschutz ein Fenster von 64 Paketen mit; wer keine `SettingEngine`
setzt, erbt es. Bei 440 Paketen je Sekunde sind das 145 ms — weniger, als eine
Nachlieferung über diese Strecke braucht. Was herausfiel, wurde still verworfen,
die Lücke blieb offen, und der NACK-Erzeuger forderte alle 10 ms dasselbe Paket
erneut an. Ergebnis: 78 Kopien je verlorenem Paket, 945 kbit/s, von denen der
Player 98 Prozent selbst wegwarf. Fenster auf 2048 → Aufschlag von 42 auf 22,8
Prozent, NACKs von 29910 auf 549, und **alle** Nachlieferungen kommen an
(`profiles/player-2026-07-31-srtp-fenster.json`).

**Wie er so lange unentdeckt blieb**, ist die eigentliche Lehre: die Auswertung
zählte Wiederholungs-*Ereignisse* ohne die Zahl betroffener *Pakete* daneben.
61805 Wiederholungen sehen nach schlechter Leitung aus — verteilt auf 795 Pakete
sind sie eine Rückkopplung im Empfänger. Drei Messungen der FEC-Reihe stützten
sich darauf und tragen jetzt Korrekturvermerke. Dieselbe Auswertung maß die
Verspätung außerdem an der zweiten und jeder weiteren Kopie statt an der
eigentlichen Nachlieferung; daher stammte der (falsche) Befund, 81 Prozent der
Nachlieferungen kämen zu spät. Richtig gerechnet sind es 71 Prozent
**rechtzeitig**, nach dem Fix 93.

Werkzeuge dafür, beide rein lesende Nachauswertung eines Mitschnitts:

```fish
./kopien.py  fenster-2048.pcap    # auf wieviele Pakete sich die Kopien verteilen
./fenster.py fenster-2048.pcap    # ob eine Nachlieferung ins SRTP-Fenster fällt
./fenster.py fenster-2048.pcap --groesse 2048    # gegen das tatsächliche Fenster
```

Merksatz: eine Zählung von Ereignissen ohne ihre Bezugsgröße ist keine Messung.

## Hardware-Decode beim Zuschauer (seit 2026-08-03)

`browser-decode.py` beantwortet, ob Chromium bzw. die Electron-App den
empfangenen Strom in Hardware dekodiert — und ob die bekannten
VA-API-Schalter daran etwas aendern.

```fish
./browser-decode.py --secs 20 --quelle synth8-av1.mkv --label x
./browser-decode.py --nur basis,electron          # Teilmenge
```

Es faehrt EINEN Sender und schickt nacheinander fuenf Zuschauer-Varianten
dagegen (unveraendert / mit VA-API-Schaltern / zusaetzlich EGL / Electron ohne
und mit Schaltern), misst je Lauf die NVDEC-Auslastung der Karte, die
Decode-Zeit je Bild und die Selbstauskunft von `getStats()`.

**Drei Kontrollen sind eingebaut, und keine davon ist Zierde** — jede hat in der
ersten Messreihe (2026-08-03) einen Fehlschluss verhindert:

* **Schlaegt der NVDEC-Zaehler ueberhaupt an?** Vorweg laeuft immer
  `ffmpeg -hwaccel cuda` ueber dieselbe Vorlage. Bleibt der Ausschlag aus,
  bricht das Skript ab, statt ein wertloses „0 %" zu melden.
* **Kommen die Schalter am Prozess an?** Playwright setzt ein **eigenes**
  `--enable-features`; bei doppeltem Switch zaehlt in Chromium der letzte.
  Nachsehen laesst sich das an der Kommandozeile des laufenden Prozesses
  (`tr '\0' '\n' < /proc/<pid>/cmdline`).
* **War der Browser an der echten Karte?** Der GL-Treiber wird je Lauf erhoben
  und mit ausgegeben. Playwright startet mit `--enable-unsafe-swiftshader` —
  faellt Chromium auf SwiftShader zurueck, ist „Software" ein Artefakt des
  Aufbaus. Genau das passierte in der Variante mit `--use-gl=egl`.

Die Feature-Namen sind die von Chromium 150. `VaapiVideoDecoder` aus aelteren
Anleitungen ist **wirkungslos** (seit Chromium 131 heisst es
`AcceleratedVideoDecodeLinuxGL`) und wird still ignoriert — eine Messung damit
saehe aus wie „Schalter helfen nicht", obwohl nichts eingeschaltet war.

Befund der ersten Reihe: alle fuenf Varianten dekodieren in Software, NVDEC
bleibt bei 0 %. Voll in `docs/2026-08-03-chromium-webrtc-decode-messung.md`.

## Verlust selbst einstellen (seit 2026-07-31)

Bis dahin wurde gestört, indem parallel Dateien heruntergeladen wurden — wie
stark, entschied die Gegenstelle und die Tageszeit. Vergleiche zwischen Läufen
mit 0,14 und 0,33 % Verlust tragen aber keine Aussage darüber, welche
Einstellung besser ist; drei Befunde dieses Tages sind daran gescheitert.

```fish
sudo -v
./verluststrecke.py --an 2.0            # 2 % auf UDP vom Labor-Server
./verluststrecke.py --an 2.0 --buendel  # in Bündeln (Gilbert-Elliott)
./verluststrecke.py --aus               # räumt ab und meldet die Bilanz

./fec-kennlinie.py --verluste 0.5 2 5 --paritaeten 1 2   # ganze Reihe
```

Zwei Dinge daran sind nicht offensichtlich:

**Der gesetzte Verlust ist im Mitschnitt nicht als Lücke sichtbar.** `tcpdump`
hängt im Kernel vor dem tc-Hook, sieht das Paket also noch, das netem gleich
danach wegwirft. Er zeigt sich stattdessen an der *Reaktion*: bei 2,053 %
gesetztem Verlust wurden 2,051 % der Pakete nachgefordert. `luecken_erkannt`
misst weiterhin nur den Verlust der echten Leitung, `pakete_mit_kopien` den
gesetzten. `fenster.py` taugt unter gesetztem Verlust gar nicht.

**Bildstabilität kommt aus dem Zuwachs von `frames_decoded`**, nicht aus einem
Feld `dekodiert` — das gibt es nicht. Eine erste Fassung von
`fec-kennlinie.py` fragte danach und meldete deshalb stur „null Bildausfälle";
sie hätte dasselbe bei einem dauerhaften Standbild gemeldet.

## Paritäts-Regelung messen (seit 2026-08-04)

`fec-adaptiv.py` fährt einen kompletten A/B-Arm allein: es stellt den
Laborserver in die gewünschte Betriebsart um, schiebt die Vorlage per RTMPS
hoch, setzt den Verlust, lässt einen headless Chromium zuschauen und wertet
aus. Nachts unbeaufsichtigt fahrbar — kein Portal, kein wacher Bildschirm.

```fish
export PULSE_FERN_SSH=pulse-test    # sonst hängt ssh still an der Passwortfrage
export PULSE_FERN_PASS=… PULSE_FERN_TOKEN=…

./fec-adaptiv.py --profil klar    --secs 60  --label fest
./fec-adaptiv.py --profil klar    --secs 60  --label adaptiv \
    --modus PULSE_FLEXFEC_ADAPTIV=1
./fec-adaptiv.py --profil verlust --secs 120 --zyklus 15,30 --label phasen \
    --modus PULSE_FLEXFEC_ADAPTIV=1
```

**Damit hat das Labor zum ersten Mal eine Strecke, die gleichzeitig verliert
und Umlaufzeit hat** — der Mangel, den die FEC-Analyse §6 als entscheidend
benannt hatte. Der Weg geht über die echte Leitung (60 ms), der Verlust wird
gesetzt statt durch Sättigung erzeugt.

Die Vorlage ist `*.mkv` und damit gitignored — sie muss einmal erzeugt werden.
Echter Intra-Refresh, deshalb über das **gepatchte** FFmpeg
(`streaming/ffmpeg-patches/bootstrap-ffmpeg.sh`); auf AMD zusätzlich der Umweg
über eine Pipe, weil dieser Bau kein `lavfi` enthält:

```bash
P=~/.cache/pulse/ffmpeg-intra-refresh
ffmpeg -f lavfi -i "testsrc2=size=1920x1080:rate=60:duration=150" \
       -pix_fmt yuv420p -f yuv4mpegpipe - |
LD_LIBRARY_PATH=$P/prefix/lib $P/prefix/bin/ffmpeg -y \
  -vaapi_device /dev/dri/renderD128 -f yuv4mpegpipe -i - \
  -vf 'format=nv12,hwupload' \
  -c:v av1_vaapi -rc_mode CBR -b:v 4000k -g 9999 \
  -intra_refresh 1 -intra_refresh_period 120 lang.mkv
ffmpeg -y -i lang.mkv -t 20 -c copy fec-intraref-20s.mkv   # 1200 Bilder, 1 Vollbild
```

**8 bit ist Pflicht**, nicht Bequemlichkeit: Chromiums dav1d lehnt `bpc != 8`
ab, ein 10-bit-Lauf ergäbe null Bilder. Und `-force_key_frames` greift bei
eingeschaltetem Intra-Refresh **nicht** — ein zweiter Einstiegspunkt lässt sich
so nicht setzen, deshalb der Weg über die kurze Schleife.

**Auf NVIDIA ist das alles einfacher:** `av1_nvenc` hat Intra-Refresh upstream,
es braucht also weder den FFmpeg-Patch noch den Umweg über die Pipe (das
System-FFmpeg kann `lavfi`). Ein Aufruf statt zwei:

```bash
ffmpeg -y -f lavfi -i "testsrc2=size=1920x1080:rate=60:duration=150" \
  -c:v av1_nvenc -tune ll -rc cbr -b_ref_mode 0 -preset p2 \
  -zerolatency 1 -delay 0 -b:v 4000k -g 9999 \
  -intra-refresh 1 lang.mkv
```

Der Schalter heißt bei NVENC `-intra-refresh` mit Bindestrich, bei VAAPI
`-intra_refresh` mit Unterstrich. Und `-single-slice-intra-refresh` gibt es
**nur** bei `h264_nvenc`/`hevc_nvenc`, nicht bei `av1_nvenc` — an der
Optionstabelle geprüft, nicht geraten. Die übrigen Werte sind die des
Sidecars (`live-vorlage.py::SIDECAR_OPTS`), damit die Vorlage dieselbe
Bitstrom-Struktur bekommt wie ein echter Stream.

Vier Dinge, die nicht offensichtlich sind:

**Der Verlust sitzt im Netz-Namensraum des MediaMTX-Containers**, nicht auf dem
Host-Interface: auf der Maschine laufen fremde Dienste. Und nicht lokal wie bei
`verluststrecke.py` — ein Paket, das erst über den 10-Mbit-Uplink kommt und
dann verworfen wird, hat die Leitung schon belegt, womit die Ersparnis einer
Regelung gerade nicht mehr messbar wäre.

**`--zyklus AN,AUS` ist der einzige Fall, in dem eine Regelung etwas sparen
kann.** Eine dauernd verlierende Leitung lässt jede Regelung voll aufdrehen,
eine saubere lässt sie ganz zu — beides sagt über den Alltag wenig.

**Die Vorlage läuft in Schleife, und das ist Absicht.** Ein Zuschauer, der nach
dem einzigen Vollbild einsteigt, bekommt nie ein Bild (hier reproduziert: 0
Bilder, 99 vergebliche Anforderungen). Im Produkt löst das Patch 0002; ein
Sender, der eine Datei durchreicht, kann auf eine Anforderung nicht antworten.
Der Schleifenpunkt steht stellvertretend dafür.

**`standbild_sekunden` ist die Kennzahl, nicht `framesDecoded`.** Ein Decoder,
der immer dasselbe Bild ausgibt, meldet volle Bildrate; nur der Fingerabdruck
der Pixel sieht das Standbild.

## Was damit gefunden wurde (2026-07-31, Kennlinie)

**Nicht die Verlustrate entscheidet, sondern ihre Struktur.** Bei
gleichverteiltem Verlust gibt es bis 5 % keinen Unterschied zwischen 10+1 und
10+2: Median 60 Bilder, keine Sekunde unter 30, ein einziger PLI (der vom
Beitritt). Bei **Bündelverlust** derselben Höhe dagegen 21 gegen 2 PLIs — XOR
schließt je Gruppe nur ein Loch, und zwei aufeinanderfolgende Verluste
überfordern 10+1. Details:
`profiles/fec-2026-07-31-kennlinie-gesetzter-verlust.json`.
