# Mac/HEVC: WHIP-Sendeweg verlor jede IDR — Befund und Korrektur (2026-09-13)

Frage dieser Sitzung: läuft HEVC auf dem Mac (hevc-Zweig, Commit `b92b92d6`
hat den WHIP-/Direktpfad angeschlossen)? Antwort **vorher**: Encoder ja
(`encode_smoke` mit `hevc`: HEVC Main, yuv420p, dekodiert sauber), aber der
echte Weg endete in schwarzem Bild — und zwar **systematisch, nicht
zufällig**.

## Messung

Echte Kette auf dieser Maschine: mac-hq-sidecar (`hevc_videotoolbox`,
1920×1080@30, 4 Mbit/s CBR, BGRA zero-copy) → WHIP → MediaMTX 1.19.1 →
WHEP → der echte `pulse-player` (frisch gebaut, mit hevc-Unterstützung).
Gegenprobe mit demselben Aufbau und `h264`.

* **h264:** Player dekodiert ~30 fps, `Decoder h264 (Hardware
  (VideoToolbox))` — Aufbau taugt als Kontrolle.
* **hevc:** `Decoder hevc (Hardware (VideoToolbox))` wird aufgebaut, RTP
  fließt — aber `decode_count = 0` über die ganze Sitzung.

## Beweisführung (wer verliert was?)

1. **Senderseite**: Wegwerf-Instrumentierung in `zerlege_annexb` zeigt, was
   der Encoder liefert — Zugriff 0 ist `[VPS 32, SPS 33, PPS 34, SEI 39,
   IDR 20]`, 30 KB, korrekt.
2. **Nach dem Payloader**: derselbe Print über die erzeugten RTP-Pakete —
   aus dem 30-KB-Zugriff werden **nur 2 Pakete**: `[48, 39]` (AP mit
   VPS/SPS/PPS + SEI). **Die IDR ist weg.**
3. **Playerseite**: `PULSE_PLAYER_DUMP_RTP` (Mitschnitt vor dem Assembler)
   zeigt über 10 s nur Single-NAL-Trail-Pakete (Typ 1) und 6 FU-Fragmente —
   null APs, null vollständige IDR. Der Player sieht „Paketverlust 0"
   (MediaMTX nummeriert neu und verwirft unvollständige Bilder), kann aber
   nie einen Einstiegspunkt assemblieren: `decode_count 0`, der eigene
   `record`-Op lehnt ab („noch kein Bild empfangen").

## Ursache

`rtp` 0.17.2 (webrtc 0.17), `codecs/h265::UnitType::for_id`: die Zuordnung
kennt IDR nur als **19 (IDR_W_RADL)** — **IDR_N_LP (20) fehlt** und liefert
`IGNORE`; `emit` verwirft ignorierte NALs wortlos. `hevc_videotoolbox`
schreibt seine Vollbilder als **IDR_N_LP** → jede IDR des Mac-Senders
verschwand zwischen Encoder und RTP. Linux sah dasselbe nie, weil
`hevc_vaapi` IDR_W_RADL (19) schreibt — der Bug ist plattformübergreifend,
nur der Encodertyp hat ihn auf Linux verschleiert. (Windows war offen:
dessen Live-E2E stand noch aus; AMF/NVENC wäre derselbe Verdacht gewesen.)

Nebenbefund: Docker-Desktops UDP-Proxy ist hier unschuldig — dasselbe Bild
mit nativem MediaMTX (Homebrew) und mit dem Docker-Container. Für künftige
Prüfstände gilt trotzdem: nativer Server spart eine Stufe.

## Korrektur

Der Fix liegt im Zwilling: **02433b1f** („HEVC-Keyframes erreichten den
Empfänger nie — eigener Paketierer", aus der Windows-Sitzung, wo `hevc_amf`
denselben Fehler zeigte — auch AMF schreibt IDR_N_LP). `pulse_whip::hevc`
pakettiert jetzt selbst: kleine NALs als Einzel-NAL, große als FU für ALLE
Typen, VPS/SPS/PPS gepuffert und gebündelt vor dem nächsten Vollbild, E-Bit
auch bei exakt passendem letztem Fragment.

Dieser Commit zieht nur den **Mac nach**: `b92b92d6` (Mac-Wire-up) war
gegen den alten `HevcPayloader` gebaut und beim Rebase auf 02433b1f
nachgezogen — `Paketierer::Hevc` hält jetzt den Parameter-Satz-Puffer
(`Vec<Vec<u8>>`) unter dem Spur-Lock und ruft `pulse_whip::hevc::paketiere`
auf, wortgleich zum Linux-Zwilling. Ein eigener Entwurf (zustandsloser
Payloader-Trait) wurde zugunsten des upstream-standes verworfen; die
Überholtheit ist der Grund, warum dieser Commit klein ist.

## Verifikation

Derselbe E2E-Lauf nach der Korrektur: Player dekodiert **~30 fps**
(`decode_count` 10 → 192 über sechs Sekunden Fenster), Decoder
`hevc (Hardware (VideoToolbox))`, 695 KB empfangen gegen 151 KB vor dem
Fix — die FU-Fragmente kommen durch. `encode_smoke` mit `hevc`: HEVC
Main 8 bit, `ffmpeg -f null` dekodiert ohne Fehler. Test-Suiten: mac-hq-
sidecar 173 grün.

## Grenzen / offen

* **10 bit auf dem Mac: bewusst nicht angeboten** (ScreenCaptureKit liefert
  BGRA; eine 10-bit-Kette bräuchte eine Umfärbung). `health` meldet kein
  `hevc_ten_bit`, die UI bietet es auf dem Mac nicht an — bestätigt, nicht
  neu.
* **Linux/Windows sind auf diesem Mac nicht baubar** (PipeWire-/D3D-Build-
  Scripts) — der nächste Lauf auf diesen Maschinen muss den hevc-E2E
  erneut fahren: der Linux-Wire-Stream ändert sich durch 02433b1f (PS
  laufen gebündelt vor dem Vollbild statt verstreut).
* Stock MediaMTX 1.19.1: nach dem ersten RTSP-Leser liefert DESCRIBE für
  den Pfad gelegentlich 404 — für den Betrieb egal (Pulse fährt WHEP/
  nativen Player und den gepatchten Server), für Prüfstände aber merken.
* Die erzwungene Vollbild-Anforderung (`op keyframe`) wurde in diesem Aufbau
  zweimal vom Drossel-Deckel (2 s) geschluckt, weil MediaMTX selbst PLIs
  sendete — Ops-Reihenfolge im Prüfstand künftig mit ~3 s Abstand wählen.
