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
  Messung 1 unten entscheidet.
- Browser-Glättungspuffer (`jitterBufferTarget`) und pulse-player-Vorhalt —
  vom Nutzer zurückgestellt.

## Windows-Verifikation (VOR dem Merge nach main — Auftrag an die KI auf dem Windows-PC)

Der Windows-Sidecar-Anteil dieses Branches (`streaming/win-hq-sidecar/src/whip/`)
ist auf der Linux-Entwicklungsmaschine **nicht kompilierbar** und darum noch
unverifiziert; der Code ist wortgleich zum auf Linux end-to-end geprüften Weg.
Auf dem Windows-PC ist zu tun, in dieser Reihenfolge:

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
   gelaufen" nachtragen und auf dem Branch committen — der Merge nach main
   wartet darauf.

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

## Bereits gelaufen (2026-08-14, lokal, AMD 780M, 2560x1440@143 Hz, mpv-Testbild 60 fps)

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
Linux-Weg (gleiche webrtc-rs-Fassung, gleiche Zerlegung), aber auf Windows
selbst noch unkompiliert/ungetestet.

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
