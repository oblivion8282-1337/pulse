# HQ-Streaming: 60-fps-Glättung — was geändert wurde und wie man es nachmisst

Stand 2026-08-14, Branch `fix/hq-60fps-glaettung`. Hintergrund: Nutzerbericht
„Stream wirkt ruckelig, besonders bei 60 fps", vier parallele Code-Analysen
über Sender (Windows/Linux), Transport (MediaMTX) und Wiedergabe.

## Was geändert wurde

| Strecke | Änderung | Wo |
|---|---|---|
| Linux-Sender | Encode-Takt wartet auf das Bild statt starr zu ticken (halbe Bildlänge Nachfrist), PTS aus der echten Ankunftszeit statt der Tick-Uhr | `stream_controller.rs`, `pipewire_stream.rs` |
| Beide Sender | H.264 über WHIP stempelt RTP-Zeit jetzt aus der Encoder-PTS (wie AV1 seit 2026-08-03) statt aus fester Bilddauer | `whip/mod.rs` beider Sidecars |
| Beide Sender | Paket-Verteilung (Pacer) per Vorgabe AN — Neubau mit absoluten Zeitpunkten und Paketgruppen; `PULSE_WHIP_PACING=0` schaltet ab | `whip/pacer.rs` beider Sidecars |
| Server | `writeQueueSize: 2048` (Schreibpuffer je Zuschauer, vorher Default 512) | beide `mediamtx.yml` |
| Server | PLI-Drossle 300 ms → 2 s (ein Zuschauer mit schlechtem WLAN kann nicht mehr fünf Vollbilder je 2 s für alle erzwingen) — Fork-Tag `1.19.1-pulse3` | `infra/mediamtx-fork/` |
| Server (Host) | Kernel-UDP-Puffer-Obergrenze 16 MB (`sysctl-pulse.conf`) — einmalig auf dem VPS einspielen | `infra/prod/DEPLOY.md` |

**Bewusst NICHT geändert** (erst messen):
- Windows-Aufnahme-Deckel `0.9/max_fps` (`capture/mod.rs`) — Verdacht: drückt
  auf 144/280-Hz-Schirmen die Aufnahme per VSync-Rundung unter 60 fps.
  **Messung 1 hat entschieden: der Verdacht stimmt** (Zahlen unten, mitsamt
  Gegenprobe). Der Deckel steht trotzdem noch unverändert im Branch — die
  Änderung ist eine eigene Entscheidung und gehört nicht unangekündigt in einen
  Branch, der über den Installer an Bestandsclients geht.
- Browser-Glättungspuffer (`jitterBufferTarget`) und pulse-player-Vorhalt —
  vom Nutzer zurückgestellt.

## Windows-Verifikation (VOR dem Merge nach main — Auftrag an die KI auf dem Windows-PC)

Der Windows-Sidecar-Anteil dieses Branches (`streaming/win-hq-sidecar/src/whip/`)
war auf der Linux-Entwicklungsmaschine **nicht kompilierbar** und darum
zunächst unverifiziert. **Am 2026-08-14 auf dem Windows-PC nachgeholt — alle
vier Punkte grün, Zahlen im Abschnitt „Bereits gelaufen — Windows".** Der
Auftrag bleibt hier stehen, weil er beim nächsten Sender-Umbau erneut zu fahren
ist. Auf dem Windows-PC ist zu tun, in dieser Reihenfolge:

1. **Bauen:**
   ```
   git fetch && git checkout fix/hq-60fps-glaettung
   bash streaming/win-hq-sidecar/scripts/bootstrap-windows-capture.sh
   cd streaming/win-hq-sidecar && cargo build --release
   ```
   Falls das FFmpeg-Paket fehlt (frische Maschine): vorher einmal
   `scripts/fetch-ffmpeg.ps1` (Details `.github/workflows/win-build.yml`).
   Compile-Fehler wären in `src/whip/mod.rs` zu erwarten (der Umbau auf die
   eigene RTP-Spur + `H264Payloader`); die Linux-Zwillinge
   `streaming/linux-hq-sidecar/src/whip/{mod,pacer,av1}.rs` sind die
   kompilierende Referenz — dieselbe webrtc-rs-Fassung (0.17).
2. **`cargo test`** im selben Verzeichnis (u. a. `zuschnitt_haelt_die_grenzen`).
3. **Messung 1** (nächster Abschnitt) auf dem 280-Hz-Schirm fahren — sie
   verifiziert den Stream real UND beantwortet den offenen Deckel-Verdacht.
4. Ergebnis (Bau grün/rot, dups-Zahlen) hier im Dokument unter „Bereits
   gelaufen" nachtragen und auf dem Branch committen + pushen — der Merge
   nach main wartet darauf.

## Messung 1 — Windows, 60-fps-Stream auf dem 144/280-Hz-Schirm

Trennt die Sender-Verdachte: Doppelbilder ohne Netzlast = Takt/Deckel-Problem,
Lücken im 2-s-Takt = Leitung/Keyframes.

1. Auf dem Windows-PC vor dem Start des Streams setzen (PowerShell):
   ```powershell
   $env:PULSE_HQ_TRACE = "$env:TEMP\pulse-trace.jsonl"
   ```
   Dann Pulse aus DERSELBEN Konsole starten, 60-fps-Stream auf dem
   280-Hz-Monitor starten, 60 s laufen lassen, dabei ein Fenster sichtbar
   bewegen (Damage erzeugen — bei stehendem Bild sind Duplikate normal).
2. Auswertung: In der Trace-Datei die 2-s-Zusammenfassungen ansehen
   (`dups`-Zähler) bzw. im Sidecar-Log die Zeilen suchen.
   - **`dups` > 2/s bei bewegtem Inhalt** → der Aufnahme-Deckel quantisiert
     auf dem Hochfrequenz-Schirm unter 60 fps → Deckel-Formel ändern
     (`0.5/max_fps` oder Schirm-Periode berücksichtigen).
   - `pts_delta>1`-Ereignisse gehäuft im 2-s-Abstand → Leitung/Keyframe-Last,
     nicht der Takt.
3. Gegenprobe: denselben Lauf auf dem 60-Hz-Schirm (oder Schirm auf 60 Hz
   stellen) — verschwinden die `dups`, ist die VSync-These belegt.

## Bereits gelaufen — Linux (2026-08-14, lokal, AMD 780M, 2560x1440@143 Hz, mpv-Testbild 60 fps)

Drei 60-s-Läufe gegen lokales MediaMTX (Anleitung unten):

| Lauf | Ergebnis |
|---|---|
| Baseline (main), RTMP | 59 Fenster, 0 Störungen (143-Hz-Schirm überabtastet — die 60↔60-Schwebung kann diese Maschine nicht zeigen) |
| Neu (Endstand), RTMP | 59 Fenster, 1 Start-Lücke, **0 duplicates / 0 clamps** |
| Neu, **H.264 über WHIP** | MediaMTX nimmt den eigenen RTP-Weg an (publiziert sauber, 29 Fenster); **Pacer: Soll ~10,8 ms, Ist ~11,5 ms je Bild** — die alte Fassung lag bei +66 %, jetzt ~+1 ms (ein Zeitgeber-Aufwachen) |

Die Messläufe haben den Umbau selbst zweimal korrigiert — beide Lehren stehen
als Kommentare im Code:

1. **Duplikate müssen am Zähler verankert sein, nicht an der Wanduhr.** Zwei
   Anker mischen hieß: ein einziges aufgerundetes Duplikat hob den
   Monotonie-Zähler dauerhaft über die Bild-Uhr (36-55 pts_clamps/s).
2. **Keine Frische-Prüfung am Slot.** Ein Zwischenstand wartete bei „altem"
   Bild auf ein frischeres — an der Frischegrenze kippte das bistabil und
   erzeugte genau die Doppelbild-Strecken, die es verhindern sollte (22
   Störfenster/60 s). Ein bis zu einen Bildabstand altes Bild ist neuer
   Inhalt mit ehrlicher pts, mehr braucht es nicht.

Außerdem zählt die Klemm-Diagnose erst ab ZWEI Schritten Rückstand — genau
einer ist normales Runden an der Halbslot-Grenze (sonst bis zu 53
Schein-Klemmungen/s bei fehlerfreier Ausgabe).

Der Windows-H.264-WHIP-Weg ist Code-identisch zum hier End-to-End geprüften
Linux-Weg (gleiche webrtc-rs-Fassung, gleiche Zerlegung). Er ist seit dem
2026-08-14 auch auf Windows selbst gebaut, getestet und gegen ein MediaMTX
gefahren — Abschnitt „Bereits gelaufen — Windows".

## Bereits gelaufen — Windows (2026-08-14, RTX 5080, 2560x1440@143 Hz)

Der Auftrag aus dem Abschnitt oben, Punkt für Punkt.

**1. Bau.** `bootstrap-windows-capture.sh` (windows-capture 2.0.0 + 1 Pulse-Patch),
dann `cargo build --release` **grün in 1 min 12 s, ohne Warnung**. Die erwarteten
Compile-Fehler in `src/whip/mod.rs` blieben aus.

**2. Tests.** `cargo test --release`: **184 grün, 0 rot, 2 ignoriert** (die
beiden fragen echte Hardware ab), darunter `zuschnitt_haelt_die_grenzen` und die
drei `zeitstempel_tests`.

**3. Messung 1.** Aufbau ohne Netz und ohne zweiten Rechner: eine push_url, die
nicht mit `http` beginnt, geht an den ffmpeg-Muxer (wie `mitschnitt.ps1`) — der
Aufnahme-Takt, um den es geht, ist davon unberührt.

**Die Bewegungsquelle muss bei JEDEM Vsync ein neues Bild zeigen**, sonst misst
der Lauf nichts. Eine Quelle mit 15-ms-Zeitgeber (so zeichnet `bewegung.ps1`)
passt ohnehin durch den 15,0-ms-Deckel und ergibt ein falsches Grün. Benutzt
wurde eine Browser-Seite mit `requestAnimationFrame`, nachgemessen **143,9 Hz**
über die volle Laufzeit.

| Lauf (60 s, 60 fps, H.264, Deckel `0.9/max_fps`) | Ergebnis |
|---|---|
| Aufnahmerate | **53,8 Bilder/s** statt 60 — nie 60 |
| dups | **7,8/s im Mittel**; Sekunde 0–24 **10–12/s**, danach 4–6/s |
| Lieferabstand Sekunde 0–24 | **20,8 ms = exakt 3 Vsync-Perioden** (143 Hz → 6,993 ms) |
| pts_delta>1 | **0** |
| capture_drops / Rückruf-Verlustschranke | **0 / 0** (Rückruf avg 0,009 ms) |

Damit ist die Schwelle des Auftrags („dups > 2/s bei bewegtem Inhalt") um das
Fünf- bis Sechsfache gerissen, und die **Quantisierung ist direkt sichtbar**:
`ceil(15,0 ms / 6,993 ms) = 3` Perioden → 47,7 Bilder/s. Genau das steht in den
ersten 25 Sekunden in der Spur. Die Sender-Uhr ist dabei sauber (0 pts-Lücken) —
es fehlt schlicht jedes achte Bild an der Quelle.

**Gegenprobe mit `0.5/max_fps`** (gebaut, gemessen, wieder zurückgebaut — der
Branch trägt die Änderung NICHT):

| Lauf (60 s, sonst identisch) | Aufnahmerate | dups |
|---|---|---|
| Deckel `0.9/max_fps` | 53,8/s | 7,8/s |
| Deckel `0.5/max_fps` | **74,5/s** | **0,00/s über volle 60 s** |

Was die Zahl kostet und was nicht: bei 60 Hz Schirm bleibt alles wie es ist
(8,33 ms lässt weiter jeden Vsync durch, 60/s), auf diesem 143-Hz-Schirm werden
**24 % mehr Bilder aufgenommen und verworfen**. Die alte Begründung im Code
(„der Schirm mit 280 Hz kommt damit auf höchstens ~66 Bilder je Sekunde")
rechnet ohne die Vsync-Rundung und stimmt nicht — bei 280 Hz sind es 56/s, bei
143 Hz 47,7/s, beides UNTER 60. Wer den Deckel anfasst, zieht `capture/mod.rs`
und `capture/rueckruf.rs` gemeinsam mit (dort steht dieselbe Zahl, mit dem
ausdrücklichen Hinweis darauf).

**4. Der neue Sendeweg selbst** — das eigentlich Unverifizierte. Gegen ein
lokales MediaMTX (1.20.0 im Docker, Loopback), 30–45 s je Lauf:

- **H.264 über WHIP publiziert**: `stream is available and online, 1 track
  (H264)`. Ein Browser als WHEP-Zuschauer **dekodiert live** (Sichtprüfung an
  der Spiegelung: mehrere Ebenen tief, Balken je Ebene versetzt — es läuft
  wirklich, es steht nicht).
- **AV1 über WHIP publiziert weiter** — der Umbau der Bildspur (Enum → Struct
  mit gemeinsamem `SpurZustand`) hat den AV1-Weg nicht beschädigt.
- **Pacer hält sein Soll**: `soll 8,6–9,2 ms, ist 10,1–10,8 ms` je Bild, also
  **rund +1,4 ms** — dieselbe Größenordnung wie die +1 ms auf Linux (ein
  Zeitgeber-Aufwachen). Die alte Fassung lag bei +66 %.

**Verlustbild, und warum es für den Pacer spricht** (2-s-Meldungen von
MediaMTX, Loopback, je 25–30 s):

| Lauf | Meldungen | Summe |
|---|---|---|
| H.264, Pacer an (Vorgabe) | 1, beim Start | ~125 Pakete, danach still |
| H.264, `PULSE_WHIP_PACING=0` | 1, beim Start | ~142 Pakete, danach still |
| AV1, Pacer an (Vorgabe) | **1, beim Start** | ~1750 Pakete, danach **still** |
| AV1, `PULSE_WHIP_PACING=0` | **10, über den ganzen Lauf verteilt** | ~2011 Pakete |

Der laufende Verlust ohne Verteilung ist genau das, wogegen der Pacer gebaut
ist; die Vorgabe-Umstellung dieses Branches tauscht ihn gegen einen einmaligen
Startburst. **Der Startburst ist nicht neu:** derselbe Lauf auf `main` mit
`PULSE_WHIP_PACING=1` ergibt **1749** — auf Windows ist der Pacer-Code zwischen
`main` und Branch unverändert, der Branch dreht nur die Vorgabe um. Er trifft
außerdem nur die erste Sekunde des Senders, bevor überhaupt ein Zuschauer da
sein kann.

**Was hier NICHT geprüft ist** (und auch nicht geprüft werden konnte): echte
Leitung statt Loopback, zweiter Rechner, HDR/10 bit, Ankunftslücken beim
Zuschauer — dafür braucht es den Messstand, der seit 2026-08-12 für die
Fernsteuer-Testinstanz gestoppt ist.

## Feinere Zeitbasis — der dritte Schritt (Windows, 2026-08-14)

Nach dem Aufnahme-Deckel bleibt ein Rest, den kein Deckel beheben kann: die
Bilder entstehen auf einem 143-Hz-Schirm bei 60 fps im Muster 2-2-3
Bildschirmtakte, also mit Abständen von 13,9 / 13,9 / 20,8 ms. Die ANZAHL
stimmt, die ABSTÄNDE nicht — und im alten Zeitraster (Encoder-Zeitbasis
`1/fps`) konnte ein Zeitstempel nur Vielfache eines Bildabstands ausdrücken.
Die Ungleichmäßigkeit wurde also wegge­rundet: der Zuschauer bekam Bilder, die
13,9 ms auseinander aufgenommen wurden, als wären es 16,7.

**Geändert**: Encoder-Zeitbasis von `1/fps` auf **1/90000** — dieselbe Uhr, die
RTP für Video ohnehin führt. Volle Begründung samt Alternativen in
`streaming/win-hq-sidecar/src/zeitbasis.rs`; die Umrechnung im WHIP-Sendeweg
wird dadurch zur Identität und kann nicht mehr falsch runden.

**Nachweis, A/B mit derselben Bewegungsquelle** (je 25 s, 60 fps, H.264,
Abstände zweier aufeinanderfolgender Bilder im Mitschnitt):

| | Abstände | Bilder | Dauer | Datenrate |
|---|---|---|---|---|
| Branch-Stand | **1421 von 1421 exakt 16,7 ms** | 1482 | 24,7 s | 11,9 Mbit/s |
| Feine Zeitbasis | **13,9 ms (662x) · 20,8 ms (610x)** · 16,7 ms (71x) · 4,2 ms (52x) | 1480 | 24,7 s | 11,9 Mbit/s |

Gleich viele Bilder, gleiche Dauer, gleiche Datenrate — nur die Zeitstempel
sind ehrlich geworden. Die 16,7-ms-Einträge sind die Duplikate (Zähler, s. u.),
die 4,2 ms ein echtes Bild direkt nach einem Duplikat: 16,7 + 4,2 = 20,8, die
Summe stimmt also.

**Zwei Fallen, beide gemessen und beide teuer:**

1. **Duplikate müssen am ZÄHLER hängen, nicht an der Aufnahme-Uhr.** Ein
   Duplikat hat keine eigene Aufnahmezeit; die Uhr steht dann still, und die
   Monotonie-Untergrenze `last_pts + 1` griff. Im alten Raster war dieses „+1"
   zufällig genau ein Bildabstand — in Takten sind es 11 µs. Im ersten Messlauf
   standen deshalb Siebenergruppen im 11-µs-Abstand mit 111-ms-Sprüngen
   dazwischen: eine Sekunde Standbild schrumpft im Strom auf Millisekunden. Der
   Linux-Zwilling verankert Duplikate aus demselben Grund am Zähler.
2. **Die Lücken-Diagnose zählt sonst Phantome.** `pts_delta > 1` hiess „ein
   Bildplatz übersprungen" und war richtig, solange es keine Zwischenwerte gab.
   Mit ehrlichen Zeitstempeln sind Zwischenwerte der Normalfall — die Schwelle
   liegt jetzt bei anderthalb Bildabständen (`zeitbasis::lueckenschwelle`),
   oberhalb der echten Abtast-Schwankung (1,25) und unterhalb eines wirklich
   ausgefallenen Bildes (2,0).

**Gegengeprüft**: 191 Tests grün · WHIP publiziert (`1 track (H264)`), in
diesem Lauf ganz ohne Verlustmeldung · Datenrate unverändert (Ratenregelung
hängt an `set_frame_rate`, die bleibt) · **A/V-Versatz ohne erkennbare
Änderung** (je drei Läufe mit Ton: alt 17/19/48 ms, neu 58/26/29 ms — die
Streuung kommt vom WASAPI-Start, nicht von der Zeitbasis; der Bildstart ist
statt eines festen Rundungsartefakts von 16,7 ms jetzt die echte
Aufnahmezeit, 13 ms).

**Der Linux-Sidecar steht weiter auf `1/fps`** und braucht dieselbe Änderung —
er ist auf dieser Maschine nicht baubar, und ungetesteten Rust auf eine
Plattform zu schieben ist genau der Zustand, den dieses Dokument oben für
Windows beklagt. Betroffen wären `stream_controller.rs` (pts-Ableitung und
Duplikat-Zähler), die Encoder-Zeitbasis und `whip/av1.rs::zeitstempel`.

**Die Messquelle taugt nur mit Bildschirmtakt.** `testbench/bewegung.ps1`
zeichnet alle 15,6 ms und passt damit ohnehin durch den Aufnahme-Deckel — ein
Lauf dagegen ist falsch grün. Ebenso wertlos ist ein Lauf bei
**eingeschlafenem Bildschirm**: die Zusammensetzung fällt dann auf ~11 Hz, die
Aufnahme liefert fast nichts, und es sieht aus wie ein Fehler im Sender (am
2026-08-14 einmal hineingelaufen). Vor jeder Messung die gemessene Rate der
Quelle ablesen, nicht annehmen.

## Messung 2 — Linux, Duplikat-/PTS-Log

Der Sidecar meldet seit je her je Sekunde `duplicates` / `pts_gaps` /
`pts_clamps` (nur wenn > 0; Log-Target `stream`). Nach dem Umbau ist die
Erwartung bei 60-Hz-Schirm → 60-fps-Stream mit bewegtem Inhalt: **0
duplicates** (vorher: periodische Doppel-/Auslass-Paare je nach Phasenlage).

Lauf ohne Portal-Dialog (Token muss von einem früheren Lauf liegen):
```sh
cd streaming/linux-hq-sidecar
docker compose -f test/docker-compose.yml up -d   # MediaMTX auf :11936
PULSE_PORTAL_REUSE=1 PULSE_HQ_LOG=info cargo run --release 2>stderr.log
# dann per JSON-RPC auf stdin: health → start (rtmps://localhost:11936/test)
# 60 s laufen lassen, Fenster bewegen, stop.
grep "Zeitachse" stderr.log
```

## Messung 3 — Pacer hält sein Soll (beide Plattformen)

Der Pacer schreibt alle ~2 s eine Log-Zeile `Verteilung je Bild: soll X ms,
ist Y ms`. **Ist ≈ Soll** heißt: die Verteilung funktioniert (die alte Fassung
lag bei +66 %). Weicht Ist deutlich nach oben ab → `PULSE_WHIP_PACING=0`
setzen und melden.

Die eigentliche Leitungs-Gegenmessung (Ankunftslücken beim Zuschauer, wie
2026-07-28 gegen den Hetzner-Testserver) braucht den MediaMTX-Messstand aus
`streaming/win-hq-labor/testbench/` — der ist seit 2026-08-12 für die
Fernsteuer-Testinstanz gestoppt (Rückholanleitung auf dem Server:
`~/messstand-gestoppt-2026-08-12.txt`). Bis dahin gilt die Soll/Ist-Zeile als
Nachweis, plus der Unit-Test `verteilung_haelt_ihr_soll` (Linux) bzw.
`zuschnitt_haelt_die_grenzen` (Windows) in jedem Testlauf.

## Messung 4 — Zuschauer-Seite

Im Browser-Player die Stats-Anzeige öffnen (Diagnose-Pille): `freezeCount`
und die `totalInterFrameDelay`-Ausschläge sind die Mikroruckler-Signale
(`web/src/lib/stream/whep-stats.ts`). Vorher/Nachher am selben Inhalt
vergleichen. Beim nativen Player: Zähler `verspaetet` / `uebersprungen`.

## Server-Seite nach dem Deploy prüfen

```sh
ssh pulse-prod
docker logs pulse_mediamtx 2>&1 | grep -i "reader is too slow"   # soll leer sein
ss -u -m | grep -A1 8189                                          # Drops ansehen
sysctl net.core.rmem_max                                          # 16777216
```
MediaMTX-Image-Wechsel auf `1.19.1-pulse3` ist ein bewusster Schritt
(unterbricht laufende Streams): erst in der API nachsehen, ob jemand streamt,
dann `docker compose pull mediamtx && docker compose up -d mediamtx`.
