# Messstand-Werkzeuge des Windows-Labors

Dinge, die nicht in den Code gehören, aber auch nicht in ein Scratchpad — weil
sie Ergebnisse liefern, die in Messakten landen, und nachvollziehbar bleiben
müssen.

Die meisten setzen den Hetzner-Messstand voraus (`streaming/win-hq-labor/CLAUDE.md`,
Abschnitt „Messen") und ein Token in `fern_token.txt`. **Das Token steht in
keinem der Skripte** und wird in der Ausgabe maskiert. Ausnahmen:
`bewegung.ps1` und `mitschnitt.ps1` brauchen kein Netz.

| Datei | Beantwortet |
|---|---|
| `intra-refresh-nachweis.ps1` | Läuft Intra-Refresh wirklich — auf dem **Vulkan**-Weg? |
| `amd-intra-refresh-nachweis.ps1` | Dieselbe Frage für die **herstellereigenen** Wege, samt Einstieg und Erholung |
| `browser-whep.ps1` + `browser-whep.html` | Sieht ein Browser-Nutzer den Strom? |
| `hdr-ansehen.ps1` | Sieht das HDR-Bild richtig aus — mit oder ohne Zuschauer, mit Spur |
| `last-messen.ps1` | Was kostet der Sender auf der **Grafikeinheit**? (Leistungsindikatoren je Prozess) |
| `bewegung.ps1` | Eine billige Bildänderung — **Voraussetzung** jeder Lastmessung |
| `mitschnitt.ps1` | Ein kurzer Dateimitschnitt für die Sichtprüfung an einem Bild aus der Mitte |
| `bruecke-einrichten.ps1` | Richtet den SSH-Zugang der Linux-Maschine ein (**als Administrator**) |
| `sitzungs-helfer.ps1` | Zeiger, Bildschirmfoto, Monitorliste, Prozessstart — **in der angemeldeten Sitzung** |
| `eingabe-pruefziel.ps1` | Vollbild-Fenster, das injizierte Maus- und Tastatureingaben auffängt und protokolliert |

## `eingabe-pruefziel.ps1` — das Messmittel der Fernsteuerung

Legt sich über **alle** Bildschirme, fängt Maus und Tastatur ab und schreibt
jedes Ereignis als JSONL-Zeile.

**Zwei Gründe, und der zweite ist der wichtigere.** Erstens Sicherheit: Eingabe
zu injizieren heißt, auf einem benutzten Rechner blind zu klicken und zu tippen.
Liegt das Prüfziel darüber, kann nichts danebengehen, weil daneben nichts mehr
liegt. Zweitens die Messgüte: `GetCursorPos` zurückzulesen sagt nur, wo der
Zeiger steht. Das Prüfziel sagt, was Windows an einem **echten Fenster**
ankommen lässt — also die Strecke, die es im Ernstfall auch geht. Dazwischen
liegen genau die Fallen, um die es geht: Monitor-Zuordnung
(`MOUSEEVENTF_VIRTUALDESK`), DPI-Skalierung, erweiterte Tasten.

```powershell
.\eingabe-pruefziel.ps1 -Pfad C:\Temp\lauf.jsonl -Sekunden 60
```

**Die Zwangsabschaltung ist Pflicht, keine Bequemlichkeit.** Ein Vollbildfenster,
das Eingaben schluckt und hängenbleibt, sperrt den Rechner aus. Es endet nach
`-Sekunden` von selbst; Strg+Alt+Umschalt+Q beendet von Hand (dasselbe Kürzel
wie bei Moonlight).

**Erster Lauf gegen den M0-Prüfling** (2026-08-12, ein Monitor, 2560×1440,
Skalierung 100 %): Der Prüfling meldete Ziel (1280,720), Ist (1280,720), Δ 0 px
— und das Prüfziel empfing `maus_bewegt` sowie `maus_taste` runter/hoch auf
exakt derselben Koordinate. Damit ist die Zustellung belegt, nicht nur die
Zeigerposition.

**Tasten kommen aus der rohen Windows-Nachricht, nicht aus den
WinForms-Ereignissen** — und das ist keine Feinheit. WinForms meldet linke und
rechte Zusatztasten als **dieselbe** Taste (`KeyCode = ControlKey` für beide);
wer daraus per `MapVirtualKey` einen Scancode zurückrechnet, bekommt immer den
linken, und die `0xE0`-Kennung ist weg. Im Selbsttest am 2026-08-12 wurde aus
einer gesendeten rechten Strg-Taste (`0xE01D`) eine empfangene linke (`0x1D`,
`erweitert=false`). **Der Fehler lag im Prüfziel und hätte wie einer des
Injektors ausgesehen.** Gelesen wird jetzt `lParam`: Bits 16–23 der Scancode,
Bit 24 die Erweitert-Kennung. Danach: `0xE01D` gesendet, `0xE01D` empfangen.

Zwei Fallen beim Bauen, beide kosten sonst eine Weile:

* **`Environment.TickCount64` gibt es nicht.** PowerShell 5.1 läuft auf dem
  .NET Framework; die Typdefinition scheitert dann beim Übersetzen und das
  Fenster startet **wortlos gar nicht** — es entsteht einfach keine
  Protokolldatei. `Stopwatch.GetTimestamp()` statt dessen.
* **Die Warteschlange wird im Zeichentakt geleert, nicht über
  `Register-ObjectEvent`.** Das hat in diesem Repo schon einmal ausgerechnet die
  aussagekräftigen Zeilen verschluckt (siehe oben, Fallen im Messaufbau).

**Was damit weiter nicht geprüft ist:** gemischte DPI. Dafür braucht es zwei
Monitore mit unterschiedlicher Skalierung; hier lief einer mit 100 %.
`SetProcessDPIAware` steht im Skript trotzdem ganz oben — ohne das misst es den
Fehler, den es aufdecken soll.

## Die Brücke zur Linux-Maschine

Auftrag und Begründung: `docs/plans/2026-08-11-windows-bruecke-einrichten.md`.

Die beiden Skripte gehören zusammen und sind **kein Produktbestandteil** — sie
gehören nicht in den Installer und nicht in den Autostart einer Auslieferung.

**Warum es zwei sind.** Windows trennt die am Monitor angemeldete Sitzung streng
von der, die eine SSH-Anmeldung erzeugt; jeder Prozess sieht nur den Desktop
seiner eigenen. Über SSH nimmt ein gestarteter Sidecar deshalb **nicht** den
echten Bildschirm auf, `GetCursorPos` liefert den Zeiger der unsichtbaren
Sitzung, und ein Bildschirmfoto ist schwarz. **SSH allein kann bauen, lesen und
Dateien schieben — sehen und prüfen kann es nicht.** Genau das leistet der
Helfer, und deshalb ist er nicht optional.

```powershell
powershell -File sitzungs-helfer.ps1            # in der angemeldeten Sitzung starten
curl.exe -s http://127.0.0.1:47615/gesundheit   # von der SSH-Seite, lokal
curl.exe -s http://127.0.0.1:47615/zeiger
curl.exe -s http://127.0.0.1:47615/monitore
curl.exe -s "http://127.0.0.1:47615/bild?monitor=0&pfad=C:\Temp\schirm.png"
```

**Bindung ausschließlich `127.0.0.1`**, niemals `0.0.0.0` oder `+`. Keine
Authentifizierung — Absicht: wer SSH auf der Maschine hat, hat ohnehin alles.

**`SetProcessDPIAware` steht ganz oben und muss dort bleiben.** Ohne das
spiegelt Windows dem Prozess eine hochgerechnete Fläche vor: Zeiger und
Monitor-Rechtecke kämen in virtuellen Punkten heraus, das Bildschirmfoto in
echten Pixeln — die Fernsteuerung rechnete mit zwei Maßstäben. Aus demselben
Grund meldet `/monitore` die **Skalierung**, nicht nur die Pixelgröße.

**Ein Bild, das 1 MB groß ist, ist noch kein Beweis** — aber ein schwarzes ist
klein. Die belastbare Probe ist eine Stichprobe über die Farbtöne (leere Fläche
= 1 Ton) plus ein Blick auf den Zeiger vor und nach einer sichtbaren
Mausbewegung.

## Die drei zusammen: eine Lastmessung an der Sendeseite

`bewegung.ps1` läuft nebenher (sonst liefert WGC nichts und beide Arme messen
dasselbe Nichts — die Falle, in die am 2026-08-06 **und** am 2026-08-07 je ein
Messanlauf gelaufen ist), `last-messen.ps1` fährt je einen Arm und schreibt
`last-<kennung>.csv` (GPU je Engine-Typ) plus `last-<kennung>.jsonl` (Spur des
Senders), `mitschnitt.ps1` liefert danach das Bild zum Hinsehen.

**Zwei Arme, ein Binary.** `last-messen.ps1 -Zwischenkopie` setzt
`PULSE_HQ_HDR_ZWISCHENKOPIE=1` und stellt damit den Stand vor dem 2026-08-07
her. Zwei Binaries zu vergleichen wäre schlechter — dann unterschieden sich auch
Übersetzung und Anordnung im Speicher. Beispiel:
`streaming/testbench/profiles/leistung-2026-08-07-wandlung-im-rueckruf.json`.

## `amd-intra-refresh-nachweis.ps1`

Dazugekommen, weil die Annahme „AMF kann kein Intra-Refresh" — die Begründung
für den ganzen Vulkan-Umweg — am 2026-08-02 gefallen ist.

**Jeder Encoder nennt die Option anders**, und ein Name vom Nachbarn misst
nichts:

| Codec | Encoder | Option |
|---|---|---|
| `av1` | `av1_amf` | `-intra_refresh_mode gop_aligned` + `-intra_refresh_stripes` |
| `h264` | `h264_amf` | `-intra_refresh_mb <Makroblöcke je Bild>` |
| (Datei-Weg) | `h264_d3d12va` | `-intra_refresh_mode row_based` + `-intra_refresh_duration` |

`continuous` gibt es bei `av1_amf` auch — der Treiber nimmt es an und tut nichts
damit. Und bei H.264 ist die Auffrischung über `usage=ultralowlatency`
**ohnehin schon an**, das setzt der Sidecar selbst.

Der ausgelieferte Sidecar setzt die Auffrischungs-Optionen nicht, und für eine
Labormessung wird er nicht angefasst — sie kommen über die vorhandene Naht
`PULSE_ENCODER_OPTS` herein. **Seit 2026-08-02 setzt das Labor sie von selbst**;
das Skript setzt sie trotzdem ausdrücklich, weil eine Messung nennen soll, was
sie fuhr, statt von einer Vorgabe abzuhängen. Die Gegenprobe `-Ohne` schaltet
über `PULSE_LABOR_KEIN_IR=1` ab.

```powershell
.\amd-intra-refresh-nachweis.ps1 -Ohne                          # Gegenprobe: 6 Vollbilder
.\amd-intra-refresh-nachweis.ps1                                # mit Auffrischung: 1
.\amd-intra-refresh-nachweis.ps1 -Bits 10
.\amd-intra-refresh-nachweis.ps1 -Modus kein-pli                # Einstieg ohne Anforderung
.\amd-intra-refresh-nachweis.ps1 -Modus nur-einstieg -VerlustAb 7 -Sekunden 16
.\amd-intra-refresh-nachweis.ps1 -Codec h264 -Modus nur-einstieg -VerlustAb 7 -Sekunden 16
```

Ergebnisse in `testbench/profiles/amf-2026-08-02-intra-refresh-doch.json` (AV1)
und `amd-2026-08-02-h264-intra-refresh.json` (H.264).

**Zwei Fallen, beide teuer:**

* **Die Gegenprobe `-Ohne` gehört dazu** — „1 Vollbild in 12 s" ist erst dann
  eine Aussage, wenn derselbe Aufbau ohne die Option sechs liefert. Bei H.264
  liefert er sie **nicht**: dort unterscheidet die Vollbild-Zahl gar nichts,
  weil schon `usage=ultralowlatency` auffrischt. Dort ist die Verlust-Messung
  (`-Modus nur-einstieg -VerlustAb 7`) das aussagekräftige Werkzeug.
* **Der Encoder hing an der SENKE — seit dem 2026-08-04 nicht mehr.** Hier
  stand: über den Messstand (`http(s)://`) laufe `h264_amf`, eine
  Datei-Mitschrift desselben Auftrags dagegen `h264_d3d12va`, wer beides
  vergleiche, vergleiche zwei Encoder, und `PULSE_HQ_AMD_D3D11=1` gleiche das
  aus. **AMD geht jetzt mit jedem Codec über AMF**, Datei und Netz-Push
  encodieren also gleich — die Falle ist weg, und der Schalter heißt heute
  `PULSE_HQ_AMD_D3D12=1` und wirkt andersherum.

## `intra-refresh-nachweis.ps1`

Zählt am **Zuschauer**, wie viele der ankommenden Bilder Vollbilder sind. Mit
Intra-Refresh darf im ganzen Lauf höchstens eines kommen (das auf die
Einstiegs-Anforderung); der Messstand hat `PULSE_KEYFRAME_INTERVAL=0`, es gibt
also keinen Takt, der die Zahl von selbst hochtriebe. `-Amf` fährt dieselbe
Messung gegen das alte Verfahren.

**Warum am Zuschauer und nicht an einer Mitschrift.** Der naheliegende Weg —
Datei schreiben, `ffprobe` zählen lassen — trägt bei AV1 nicht: die rohe
OBU-Datei hat keinen Sequenzkopf, und `ffprobe` meldet dann „No sequence header
available" für einen Strom, der vollkommen in Ordnung ist. Der Decoder des
Messwerks weiß es ohnehin.

## `browser-whep.ps1`

Startet drei Ströme, lässt einen Chromium-Browser darauf los und liest dessen
`getStats()` aus. **Nicht am Augenschein geprüft**: erst wenn `framesDecoded`
steigt, ist wirklich ein Bild da — eine schwarze Fläche mit laufender
Verbindung sieht sonst aus wie Erfolg.

Die Seite schreibt ihre Zahlen zusätzlich in die Konsole, und der Browser läuft
mit `--enable-logging`; damit landet das Ergebnis in einer Datei statt nur auf
dem Schirm. Ein Test, dessen Ergebnis man nur ablesen kann, ist keiner.

**Nur zählen reicht nicht — ins Protokoll sehen.** Ein Browser, der ein Bild
zeigt, kann trotzdem auf der CPU dekodieren, weil sein Hardware-Decoder
aufgegeben hat. Das steht in keiner Bildzahl. Die Zeilen, auf die es ankommt:

```
Decoder implementation: … is_hardware_accelerated = true   ← womit begonnen wurde
Decoder falling back to software decoding.                 ← DAS ist der Befund
Dav1dDecoder::Decode unhandled bit depth: 10               ← Folge, nicht Ursache
```

Am 2026-08-02 lief AV1 8 Bit scheinbar tadellos und dekodierte durchgehend in
Software; aufgefallen ist es nur, weil 10 Bit dabei schwarz blieb. Ursache war
ein zu kleines `seq_level_idx` von `av1_vulkan` — berichtigt in
`../src/whip/av1_level.rs`. Seitdem spielen alle drei Ströme in Hardware,
inklusive 10 Bit, bis 1440p.

Nebenbefund, der Arbeit spart: die Browser fordern beim Einstieg **von sich
aus** ein Vollbild an (`pliCount=2`). Für Intra-Refresh ist das die
Voraussetzung — im Web-Client braucht es dafür also keinen Sonderweg.

**Die Schalter, und warum es sie gibt** (alle am 2026-08-02 dazugekommen, jeder
für eine Bedingung, die sich sonst nicht trennen ließ):

| Schalter | Trennt |
|---|---|
| (keiner) | der Standard: herstellereigene Wege mit Auffrischung |
| `-Vulkan` | der alte Vergleichsarm (10 Bit bricht dort ab) |
| `-OhneAuffrischung` | „mag der Browser den Encoder nicht" von „mag er die Auffrischung nicht" |
| `-Nur av1-8\|av1-10\|h264-8` | Encoder-Eigenschaft von Gleichzeitigkeit |
| `-OhneTon` | ob die Tonspur etwas ändert |
| `-Software` | Hardware-Decoder von Software-Rückfall |

**Der Browser muss danach WEG sein.** Ein Chromium startet ein gutes Dutzend
Prozesse; das Skript beendete lange nur den gestarteten. Über mehrere Läufe
sammelten sich am 2026-08-02 fünfzehn davon an, und die Messwerte fielen von 493
auf 65 Bilder — das sah nach einer Regression im Sender aus und war die GPU-Last
der eigenen Vorläufe. Behoben (erkannt am Profilverzeichnis, ein privat
geöffneter Browser bleibt unangetastet). **Wenn Zahlen über eine Messreihe
hinweg schlechter werden, zuerst nach eigenen Resten sehen.**

**`--v=1` ist Pflicht** und war es die ganze Zeit — bis 2026-08-02 stand im
Skript `--v=0`, und dann schreibt Chromium gar nicht auf, welchen Decoder es
genommen hat. Der Befund oben stand also über Wochen nur im README, nicht im
Werkzeug.

**Und das Skript berichtet jetzt, was die SENDER gefahren haben** (Encoder plus
wirklich gesetzte Optionen). Der erste AMF-Lauf sah nach „Auffrischung kaputt"
aus; ohne diesen Bericht wäre nicht aufgefallen, dass zuerst zu klären war, ob
sie überhaupt wirkte.

## `av1-datei-test.html`

Spielt dieselben Codecs als **Datei** statt über WebRTC. Trennt zwei Fragen,
die sonst zusammenfallen: kann der Browser den Codec überhaupt, oder scheitert
nur der WebRTC-Weg daran? Genau diese Trennung hat am 2026-08-02 den falschen
Schluss aufgelöst — 10-Bit-AV1 spielte als Datei tadellos, während es über
WebRTC schwarz blieb.

Die beiden Probevideos liegen **nicht im Repo** (Bau-Erzeugnisse, zusammen
~3 MB). Erzeugen, neben die Seite:

```powershell
$ff = "..\ffmpeg-patched\bin\ffmpeg.exe"
$q  = "-init_hw_device vulkan=vk:0 -filter_hw_device vk -f lavfi -i testsrc2=size=1280x720:rate=30"
& $ff @($q -split ' ') -vf "format=nv12,hwupload"   -c:v av1_vulkan -b:v 4000k -t 3 -y achtbit.mp4
& $ff @($q -split ' ') -vf "format=p010le,hwupload" -c:v av1_vulkan -b:v 4000k -t 3 -y zehnbit.mp4
```

## Skripte hier sind ASCII

PowerShell 5.1 liest `.ps1` als ANSI, nicht als UTF-8. Ein Gedankenstrich in
einer Zeichenkette zerlegt damit das Skript beim Einlesen, mit einer
Fehlermeldung, die auf eine ganz andere Zeile zeigt. Deshalb: keine Umlaute,
keine typografischen Zeichen.
