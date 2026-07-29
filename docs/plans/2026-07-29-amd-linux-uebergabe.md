# Übergabe an die AMD-Maschine: Linux-Sendeweg optimieren

**Stand 2026-07-29.** Alle Messwerte dieser Messreihe sind auf einer **RTX 5080**
entstanden. Für AMD ist die Kette **unvermessen** — nicht falsch, sondern
unbekannt. Dieses Dokument sagt, was dort ohne Zutun gilt, was neu erarbeitet
werden muss, wie man es belegt und welche Fallen unterwegs stehen.

Es geht ausdrücklich um **Electron-Streaming** (Chromium empfängt und stellt dar,
im Browser wie in der Desktop-App). Der native Player ist nicht Teil des
Auftrags — er profitiert später automatisch, weil der Sender beiden Wegen
gemeinsam ist.

## Was zu klonen ist

| Repo | Branch | Rolle |
|---|---|---|
| `github.com/oblivion8282-1337/pulse-linux-hq-sidecar` | `perf/sendeweg-latenz-und-gpu` | **Arbeitsort.** Hier sitzt der Encoder-Code. |
| `github.com/oblivion8282-1337/pulse` | `feat/native-hq-player` | **Messen.** Der Prüfstand liegt unter `streaming/testbench/`. |

**Warum zwei Repos:** Der Linux-Rust-Sidecar liegt außerhalb des Pulse-Repos —
anders als Windows (`streaming/win-hq-sidecar/`), macOS und der Player, die alle
im Hauptrepo sind. Der Grund ist nirgends dokumentiert; die Indizien deuten auf
ein separates Experiment, das später zum Standard wurde. Ein Zusammenlegen ist
nach dieser Runde vorgesehen.

Neuen Branch von `perf/sendeweg-latenz-und-gpu` aufsetzen, etwa `perf/amd-vaapi`.

## Was auf AMD schon gilt — nur gegenprüfen

Vier Verbesserungen sind **encoder-unabhängig** und sollten dort ohne Änderung
wirken. Sie sitzen im Muxer und im Ton-Pfad:

| Änderung | Ort | Wirkung (NVIDIA) |
|---|---|---|
| `max_interleave_delta` auf 10 ms | `encode/mod.rs` | 99,8 → 82,3 ms |
| Ton-Rückstand aufholen (2. Schwelle 15 ms) | `encode/audio.rs` | 33,5 → 17,4 ms |
| 5-ms-Opus statt 20 | `encode/audio.rs`, `capture/` | Bild wird nicht mehr gebündelt |
| `tcp_nodelay=1` | RTMPS-Ausgang | 3,6 ms |

Die erste ist die wichtigste und am wenigsten offensichtliche: Der Muxer gibt ein
Bild erst frei, wenn Ton mit mindestens so großem Zeitstempel vorliegt — der
Rückstand des Tons ist damit 1:1 Bild-Latenz.

## Was NEU erarbeitet werden muss

Zwei Verbesserungen stehen **ausschließlich im NVENC-Zweig** von
`encode/opts.rs::vendor_opts`. Der AMD/Intel-Zweig setzt heute `rc_mode=CBR`,
`async_depth=3`, `coder=cabac`.

**1. Encoder-Vorlauf abschalten.** Auf NVENC war das der größte Einzelposten der
Latenzkette: Der Encoder gab ein Paket erst heraus, wenn zwei weitere Bilder
eingeschoben waren — 33,3 ms bei 60 fps, exakt zwei Bildabstände. Abgeschaltet
mit `zerolatency=1` + `delay=0`: **33,4 → 2,9 ms**.

Bei VAAPI gibt es diese Optionen nicht. **Verdächtig ist `async_depth=3`** — der
Name deutet auf drei Bilder Tiefe, was demselben Problem entspräche. Das ist eine
Vermutung anhand des Namens, **keine Messung**. Zu klären: Hat VAAPI einen
vergleichbaren Vorlauf, und was schaltet ihn ab?

**2. Qualitätsstufe.** `preset=p2` bringt auf NVENC **rund 40 % weniger
Encoder-Last bei gleicher Bildqualität** (die ganze Leiter p1–p7 liegt innerhalb
von 1,3 VMAF). VAAPI hat andere Stufen; das Gegenstück ist zu finden und zu
messen.

## Wie man es belegt

Der Prüfstand fährt einen echten Stream ohne App und ohne Klick.

**Sender-Messungen** (brauchen keinen Zuschauer, Hauptteil für Encoder-Arbeit):
Der Sidecar protokolliert je Sekunde die Encode-Latenz („Einschieben bis Paket"),
die Zeitachse (`duplicates`/`pts_gaps`/`pts_clamps`) und beim Start den
gesetzten `max_interleave_delta`. Zusätzlich: `PULSE_MUX_LATENCY_LOG=1` meldet
den Ton-Rückstand im Muxer — das misst die **Ursache**, sieht den Deckel aber
NICHT. Wer den Deckel bewerten will, misst Ende zu Ende.

**Ende-zu-Ende** (`real-harness.py --e2e`): Das Bild trägt die Uhrzeit als
Klotzmuster, der Empfänger liest sie zurück. Zeitstempel im Bitstrom taugen
nicht, weil FLV/RTMP/MediaMTX/WebRTC sie umschreiben. **Achtung:** Der Prüfstand
nutzt dafür den nativen Player als Messgerät, und ob der auf AMD überhaupt läuft,
ist ungetestet (s. u.).

**Vergleichszahlen** liegen in `streaming/testbench/profiles/` (append-only).
Einstieg: `latenz-2026-07-27-*.json`, `bild-2026-07-27-av1.json` (Encoder-Preset),
`ruckeln-2026-07-28-geloest.json`.

## Fallen, die schon zugeschlagen haben

- **Die Prüfvorlage entscheidet über den Befund.** `synth10.mkv` ist mit
  av1_nvenc-Datei-Defaults kodiert und trägt Alt-Ref-Struktur, die der
  Live-Sidecar nie erzeugt. Damit entstanden ein reproduzierbarer
  Decoder-Absturz und 87 OBU-Fehler je Lauf, die es live gar nicht gibt.
  **Immer `live-vorlage.py` erzeugen und `PULSE_HARNESS_SOURCE` darauf setzen.**
- **Eine Störung, die nichts tut, sieht wie ein gutes Ergebnis aus.**
  `netem loss 5% 50%` (Korrelationsschreibweise) verwirft NACHWEISLICH gar
  nichts. `netz-harness.py` liest deshalb die tatsächlich verworfenen Pakete aus
  den tc-Zählern und meldet sie bei jedem Lauf. Nie ohne diese Kontrolle deuten.
- **Die Störung darf nicht an der Wurzel von `lo` hängen** — sie trifft sonst den
  RTMP-Push mit, und dann ist offen, welche Seite schwächelt. `--nur-empfang`
  benutzen.
- **Einzelmessungen bei schwankenden Größen beweisen nichts.** Erst das Rauschen
  messen (dieselbe Einstellung mehrfach), dann Unterschiede beurteilen. Ein
  vermeintlicher Fix von 33,5 → 21,4 ms war über je fünf Läufe 22,5 gegen 21,3.
- **Vor „das Bild steht" erst `duplicates` gegen echte Bewegung prüfen.** Wayland
  liefert nur bei Bildänderung ein neues Bild; der Sender füllt mit
  Wiederholungen auf. Bei ruhigem Desktop sind 100+ von 145 Bildern Duplikate —
  das ist normal.
- **Der Bildschirm muss wach sein.** Schlafende Monitore ergeben Schwarzbild ohne
  Zeitmuster. Bei Messreihen `systemd-inhibit --what=idle:sleep` setzen.

## Ungetestet auf AMD

- **Der Player-Decoder.** Er probiert `av1_cuvid`, `av1_qsv`, `av1_vaapi`, dann
  Software — auf AMD landet er bei `av1_vaapi`, durch den in dieser Messreihe
  kein Bild gelaufen ist. Offen: ob VAAPI genauso vier Bilder zurückhält wie der
  NVIDIA-Decoder (dort mit `AV_CODEC_FLAG_LOW_DELAY` behoben, 82,3 → 33,5 ms),
  und was er unter Paketverlust tut.
- **Der TempDelim-Patch im MediaMTX-Fork** (`infra/mediamtx-fork/patches/0001-`)
  existiert ausschließlich für AMD-VAAPI-AV1: Diesen Strömen fehlen
  `OBU_TEMPORAL_DELIMITER`-Einheiten, und der Stream friert beim Zuschauer nach
  Sekunden ein. Zu prüfen, ob das noch gilt.
- **Der webrtc-Patchzweig liegt nur auf der NVIDIA-Maschine**
  (`~/Dokumente/webrtc-rs-pulse`, v0.17.2 + 24 Zeilen, via `[patch.crates-io]`
  eingebunden). Er wird nur für den FlexFEC-**Empfang** im Player gebraucht — für
  Sender-Arbeit nicht nötig, aber ein Player-Build auf AMD braucht ihn erreichbar.

## Was NICHT Teil des Auftrags ist

WHIP als Sendeweg, Intra-Refresh, die Vollbild-Weiterleitung im Server, FlexFEC,
der native Player selbst. Alles bewusst aus `perf/sendeweg-latenz-und-gpu`
herausgehalten — der Schnitt liegt vor den WHIP-Commits.
