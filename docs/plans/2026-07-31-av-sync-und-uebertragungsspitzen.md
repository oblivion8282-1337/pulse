# A/V-Synchronität, Tonaussetzer und Übertragungsspitzen — Messreihe 2026-07-30/31

Zweiter Messtag am Windows-HQ-Sidecar, Branch `perf/win-sidecar-latenz`.
Gegenstand: **AV1 und H.264 im echten Betrieb** — Latenz, GPU-Last, Bildqualität,
Ton, A/V-Synchronität, und die Frage, warum bei Ziel 4000 kbit/s deutlich mehr
über die Leitung geht.

Hardware: Radeon 780M, Aufnahme 2560x1440 nativ, Ausgabe 1080p60, 4000 kbit/s.
Empfänger: `mediamtx-sidecar-test` auf dem Hetzner (RTMPS über echtes Internet).

---

## Der Messaufbau — und warum er zuerst geprüft wurde

Aus dem Vortag steht die Regel: **erst den Messaufbau gegen einen bekannt guten
Fall prüfen.** Sie hat sich hier zweimal ausgezahlt.

**Referenzmaterial** (`ref_av.mkv`, 120 s, 2560x1440@60, 1:1 zum Monitor):
scharfe Textkanten für die Sichtprüfung, bewegte Inhalte für echte Encoder-Last,
und zwei Prüfmarken, die **sample-genau gleichzeitig** liegen:

- **Bildmarke** — weißes Feld an fester Position, 100 ms alle 2 s
- **Tonmarke** — 1-kHz-Piep, 100 ms, exakt zeitgleich
- **Trägerton** — durchgehender 440-Hz-Ton; jede Lücke darin ist ein Tonaussetzer

Erzeugt mit `aevalsrc` (sample-genaue Flanken, beide an Nulldurchgängen — kein
Knacken) und `drawbox` mit demselben Zeitraster.

**Erste Kontrolle — die Auswertung gegen sich selbst.** Das Referenzmaterial
durch dieselbe Auswertung: **A/V-Versatz +0,0 ms, null Tonlücken.** Die Kette
meldet also Null auf Material, das konstruktionsbedingt Null ist.

**Zweite Kontrolle — der Empfangsweg.** Derselbe Strom mit `ffmpeg` direkt an
MediaMTX gepusht und aus dessen Aufzeichnung ausgewertet: **+0,5 ms, keine
Aussetzer, Bitraten-Spanne x1,14.** RTMPS, MediaMTX, Aufzeichnung und Auswertung
verfälschen also nichts. Jeder danach gemessene Versatz gehört dem Sidecar oder
dem Abspielweg.

**Dritte Kontrolle — die eigene Sonde.** Siehe unten; sie war zwischenzeitlich
selbst die Fehlerquelle.

---

## Ergebnis 1: Beide Codecs laufen zero-copy, beide liefern ein sauberes Bild

| | H.264 | AV1 |
|---|---|---|
| Weg | `pipeline-d3d12`, `h264_d3d12va` | `pipeline-hw` (D3D11), `av1_amf` |
| Encode-Latenz Mittel | **7,5 ms** | **17,5 ms** |
| Encode-Latenz Maximum | 13,4 ms | 22,5 ms |
| CPU (Anteil EINES Kerns) | 18,1 % | 14,1 % |
| GPU Video-Engine | **25,3 %** | **9,4 %** |
| GPU 3D | 10,5 % | 12,9 % |
| Bitrate Sekundenfenster | Mittel 4000, max 4669 (x1,17) | Mittel 3820, max 4574 (x1,14) |
| Tonaussetzer in 100 s | **0** | **0** |

Kein CPU-Kopierweg bei beiden (der Notausgang läge über 100 % einer Kerne).

**Am Rand aufgefallen**: `av1_amf` liefert **1920x1082** statt 1920x1080 — die
Aufzeichnung des Empfängers zeigt diese Höhe. Zwei Zeilen Zugabe, ungerade
Zahl. Nicht weiter untersucht, gehört aber geklärt: eine krumme Höhe kann bei
Zuschauern zu einer Skalierung führen, die es nicht geben müsste.

*(2026-08-22 geklärt: die Vermutung stimmte. Die zwei Zeilen sind hartes
Schwarz, die Skalierung findet statt, und dazu kommt ein Zielversatz der
Fernsteuerung von bis zu 2 Pixeln. Ursache und Messung:
`streaming/win-hq-sidecar/README.md`.)*

**Sichtprüfung bestanden**: Standbilder aus beiden Empfangsströmen zeigen den
Prüftext rasiermesserscharf, keine Risse, keine versetzten Kopien. Das ist die
Prüfung, die am Vortag den kaputten AV1-Weg entlarvt hat, den jede Kennzahl für
gut befand.

**Die Wahl zwischen beiden ist ein echter Tausch**, kein „einer ist besser":
H.264 ist um das Zweieinhalbfache latenzärmer, AV1 kostet die Video-Engine nur
gut ein Drittel. Auf einer iGPU, die sich die Leistungsaufnahme mit der CPU
teilt, ist Letzteres der größere Posten.

---

## Ergebnis 2: Die Übertragungsspitzen sind die Keyframes — nicht die Ratensteuerung

Der Verdacht aus der Übergabe lautete auf die Ratensteuerung von `av1_amf`
(dort mit Spanne x2,32 vermerkt). **Im Sekundenfenster ist davon nichts mehr zu
sehen** — beide Codecs halten das Ziel auf x1,14 bis x1,17.

Der Ärger sitzt eine Ebene feiner:

| Fenster | H.264 | AV1 |
|---|---|---|
| 100 ms, Median | 3648 | 3530 |
| 100 ms, p95 | 5247 | 7872 |
| **100 ms, p99** | **12053** | **11821** |
| 100 ms, Spitze | 12584 | 13243 |

Ursache belegt: die größten Pakete liegen **exakt alle 2,000 s** und sind
100–132 kB groß — die Keyframes (GOP = fps x 2). Ein Bild trägt damit rund
0,9 Mbit, wo im Mittel 8,3 kB pro Bild vorgesehen wären. Auf 100 ms verteilt
ergibt genau das die gemessenen 12–13 Mbit/s.

**Auf einer 10-Mbit-Leitung passt dieser Stoß nicht durch.** Er staut sich,
verzögert die folgenden Bilder und wird beim Zuschauer als Ruckler sichtbar —
während Mittelwert, Bildzahl und Paketverlust unauffällig bleiben.

### Was dagegen hilft — gemessen

`h264_d3d12va` bietet als einziger der drei Encoder `intra_refresh_mode`.
**Wirkung: keine.** Die Option wird angenommen, die Keyframes bleiben
unverändert groß — der Encoder setzt trotzdem IDRs im GOP-Raster.

Was gewirkt hat, ist das GOP-Raster selbst (`g=1200`, also 20 s):

| | GOP 2 s (heute) | GOP 20 s |
|---|---|---|
| 100 ms Median | 3648 | 3999 |
| 100 ms p95 | 5247 | **4779** |
| **100 ms p99** | **12053** | **5108** |
| Sekunde max | 4669 | 4844 |

Das 99-%-Fenster fällt von 12,1 auf 5,1 Mbit/s: der Strom ist 99 % der Zeit
glatt, ein Stoß bleibt nur alle 20 s statt alle 2 s.

**Das ist noch keine Empfehlung.** Ein langes GOP verzögert den Bildeinstieg
neuer Zuschauer über WHEP, solange kein Keyframe angefordert wird — genau die
Frage, an der der PLI-Versuchsaufbau im All-in-One-Container hängt. Sinnvolle
Alternativen, noch ungemessen:

1. **GOP mittlerer Länge** (4–6 s) — Stoß bleibt gleich groß, kommt aber
   seltener; Einstiegsverzögerung überschaubar.
2. **Ausgabe takten** (Token-Bucket im `MuxWriter`) — glättet den Stoß auf der
   Leitung, kostet ihn aber als Latenz (0,9 Mbit bei 4 Mbit/s = 230 ms).
3. **Keyframes verbilligen** — `av1_amf` hat `min_qp_i`; ein höherer I-Frame-QP
   verkleinert den Stoß gegen etwas Qualität an genau diesen Bildern.

---

## Ergebnis 3: Der Ton geht zu früh raus — Ursache gefunden, Fix zur Hälfte belegt

**Die Frage war nicht am Empfänger zu beantworten.** Ein dort gemessener Versatz
kann vom Abspielweg kommen (der Player stellt das Bild gegen die Audio-Uhr, dazu
der Puffer des Ausgabegeräts) oder von uns. Deshalb misst `syncprobe.rs` am
**rohen Geräte-Eingang** mit: wann der Piep laut WASAPI-Geräteuhr eintraf, und
wo er im ausgehenden Strom landet. Beide Zeitstempel — WGCs
`SystemRelativeTime` und WASAPIs `QPCPosition` — liegen auf derselben QPC-Uhr;
nachgemessen liegt der Bildstempel beim Eintreffen 2–8 ms in der Vergangenheit,
der Tonstempel 10 ms in der Zukunft. Sie sind vergleichbar.

Damit zerfällt der Versatz sauber:

| Lauf | AUFNAHME (was der Rechner tat) | EMPFANG (unser Strom) | KETTE (unser Anteil) |
|---|---|---|---|
| vor dem Fix, 40 s | +0,2 ms | −178,3 ms | **−178,4 ms** |
| nach dem Fix, 40 s | −1,9 ms | −102,9 ms | **−100,9 ms** |
| H.264, 100 s (48 Marken) | −7,6 ms | −98,5 ms | **−90,9 ms** |
| AV1, 100 s (49 Marken) | −9,3 ms | +63,5 ms | **+72,7 ms** |

Zwei Dinge stehen darin, und das zweite ist das wichtigere.

**Erstens: die Aufnahmeseite ist in Ordnung.** Über alle Läufe liegen Bild und
Ton beim Einfangen innerhalb von ±10 ms — der Rechner hat sie gleichzeitig
dargeboten, und unsere Zeitstempel geben das korrekt wieder. Was am Empfänger
schiefsteht, haben wir dazwischen erzeugt.

**Zweitens: der Restversatz ist NICHT konstant.** Innerhalb eines Laufs schon —
über 48 bzw. 49 Prüfmarken auf ±0,6 ms stabil, kein Driften. Aber **zwischen**
Läufen schwankt er über eine Spanne von 164 ms (−91 bis +73 ms), und zwar
unabhängig vom Codec: der Ton-Weg ist für beide derselbe Code. Der Betrag hängt
davon ab, was in der ersten Sekunde der Tonaufnahme passiert.

Das ist die eigentlich unangenehme Eigenschaft: **jede Sitzung bekommt ihren
eigenen festen Versatz.** Wer einmal misst und „passt schon" sagt, hat nur
diesen einen Start gemessen.

### Die Ursache

WASAPI liefert je Lesevorgang den **Geräte-Frame-Index** des ersten enthaltenen
Samples mit. Springt der weiter, als wir Frames bekommen haben, hat das Gerät
Samples übersprungen (gemessen: 688 ms kurz nach dem Start, dazu
`DATA_DISCONTINUITY`-Flags).

Die Ton-Zeitlinie entsteht aber durch **Zählen** der angekommenen Samples — der
PTS wächst je Paket um dessen Länge. Fehlen N ms im Zulauf, ist die Zeitlinie
danach um N ms zu kurz, und der ganze restliche Ton läuft dem Bild um N ms
voraus. Dauerhaft: nichts holt das je wieder ein. Die vorhandene
Stille-Auffüllung greift nur, wenn gar nichts mehr kommt — nicht, wenn der Strom
**mit Sprung** weiterläuft.

Belegt am Encoder-Eingang: der Piep bekam dort einen PTS von 3710 ms, während
die Geräteuhr für dasselbe Sample 3852 ms nennt — 142 ms Ton, die nie ankamen.

### Was eingebaut ist

`audio/wasapi.rs::fuelle_geraetelucke` erkennt die Lücke am Geräte-Index und
füllt sie mit Stille auf — **vor** den frisch gelesenen Daten, an der Stelle, an
der sie real entstand. Gemessen: von −178 ms auf −101 ms.

### Was noch offen ist

Der Rest von rund 100 ms hat eine identifizierte, aber noch nicht behobene
Ursache: die **Drift-Korrektur im selben Loop verwirft echte Tonblöcke**, sobald
die Ausgabe der Wanduhr um mehr als 100 ms vorausläuft — und die eingefügte
Stille lässt sie genau das glauben. Die beiden Mechanismen arbeiten
gegeneinander (`drift_drop`-Zeilen der Sonde belegen es).

Der saubere Weg: **die Drift-Korrektur gegen die Geräteuhr laufen lassen statt
gegen die Wanduhr** — `owed` aus `BufferInfo.index` statt aus
`started.elapsed()`. Dann sind Auffüllung und Verwerfen auf denselben Bezug
gestellt und können sich nicht mehr widersprechen. Nicht mehr gemacht, weil es
eine eigene Messrunde braucht.

### Ein zweiter Fund am Rand

`AudioPipeline::reanchor_on_first_device_stamp` ist neu: der PTS-Ursprung wurde
bisher auf dem **ersten ausgegebenen Block** gesetzt, und das kann eine
Stille-Auffüllung ohne Geräte-Zeitstempel sein. Dann verankert die Wanduhr des
Aufnahme-Threads — der startet in allen drei Pipelines **vor** dem ersten Bild.
Der Anker wird jetzt einmalig nachgezogen, sobald ein echter Geräte-Zeitstempel
vorliegt (nur vorwärts, ein PTS-Rückschritt wäre im Muxer unzulässig). In den
Läufen dieser Reihe hat der Fall nicht gegriffen; er ist trotzdem real.

Ebenfalls gefunden, nicht behoben: **`report_lag` lügt im QPC-Pfad.** Der Anker
ist dort konstant (QPC des ersten Samples), `pts_samples` wächst — die gemeldete
Zahl fällt deshalb um 1000 ms pro Sekunde („Ton-Zeitlinie −2620 ms hinter der
Wanduhr"). Nur unter `PULSE_MUX_LATENCY_LOG=1` sichtbar, aber eine Diagnose, die
in die Irre führt.

---

## Ergebnis 4: Tonaussetzer

Im Dauerbetrieb **null** — weder im Trägerton am Empfänger noch am
Geräte-Eingang. Alle gefundenen Lücken liegen im Anlauf (die 688-ms-Lücke des
Geräts beim Start, plus deren Nachwirkungen).

Die Sonde unterscheidet dabei, was am Empfänger nicht zu unterscheiden ist:
`device_gap` heißt, das Gerät hat nichts geliefert (der Aussetzer war schon da,
bevor wir ihn anfassen konnten); `input_gap` heißt, im gelieferten Ton war
Stille. Ohne diese Trennung sucht man den Fehler in der eigenen Kette, während
er im Eingang liegt.

---

## Fehler in der eigenen Messung — festgehalten, weil er teuer war

Die erste Fassung von `syncprobe.rs` stempelte die Piep-Flanken über einen
**Blockzähler**, verglich sie aber mit einer Geräteposition, die die
übersprungenen Samples **enthielt**. Beides gegeneinander gestellt verschiebt
jeden Zeitstempel um genau die Lücke.

Das Ergebnis war nicht offensichtlich falsch, sondern hochplausibel: ein sauber
konstanter Versatz von 650 ms, über alle Marken auf 0,3 ms stabil, und eine
schlüssige Geschichte dazu (der Player hinke beim Bild hinterher). Es gab sogar
eine scheinbare Bestätigung am eingebrannten Zeitcode — die denselben falschen
Zeitpunkt benutzte.

Aufgefallen ist es erst beim Gegenrechnen zweier Wege, die zum selben Ergebnis
hätten kommen müssen.

> **Eine Sonde ist auch nur ein Messgerät und gehört gegengeprüft.**
> Konstanz über viele Marken ist KEIN Beleg für Richtigkeit — ein systematischer
> Fehler ist per Definition konstant.

---

## Werkzeuge dieser Reihe

Im Sidecar (Diagnose, nur mit `PULSE_HQ_SYNC_PROBE=1`, greift nie in den
Datenfluss ein):

- `src/syncprobe.rs` — Prüfton-Erkennung am rohen Geräte-Eingang (Goertzel),
  QPC-Stempel je Piep, Erkennung von Geräte-Lücken und verworfenen Blöcken
- `encode/audio.rs::probe_beep_pts` — welchen PTS ein Piep beim EINTRITT in den
  Encoder bekommt. Erst dieser Messpunkt trennt „vor dem FIFO" von „danach"

Im Scratchpad (gehen beim Aufräumen verloren, Aufbau steht oben):
`ref.filter`/`ref_av.mkv` (Referenz), `run_measure.ps1` (Messlauf),
`analyze.sh` (Auswertung), `sync_check.sh` (Zerlegung des Versatzes),
`fetch.sh` (Aufzeichnung holen).

Auf dem Hetzner: `~/mediamtx-sidecar-test/` zeichnet jetzt auf
(`record: yes`, fmp4, `recordDeleteAfter: 24h`, Ablage in
`~/mediamtx-sidecar-test/recordings/`). Das ist die Messgrundlage — sie hält
fest, was wirklich ankommt.
