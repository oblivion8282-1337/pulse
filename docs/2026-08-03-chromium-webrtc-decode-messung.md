# Hardware-Decode im WHEP-Weg — Chromium und Electron (2026-08-03)

Ausgangsfrage: Die bekannten VA-API-Schalter für Chrome unter Linux
(`--enable-features=…,VaapiIgnoreDriverChecks --ignore-gpu-blocklist`) gelten
technisch auch für Electron. Bringen sie der HQ-Wiedergabe etwas?

Diese Messung schließt den Punkt, der in
`2026-07-26-chromium-10bit-messung.md` §6 als offen stand: dort war der
`<video>`-Pfad mit lokalen Dateien gemessen, **nicht** WHEP — und WebRTC hat in
Chromium eine eigene Decoder-Kette.

Maschine wie 2026-07-26: RTX 5080, NVIDIA 610.43.03, CachyOS, KWin (Wayland),
Chromium 150 / Electron 43. Werkzeug: `streaming/testbench/browser-decode.py`.

## Ergebnis

**Die Schalter ändern nichts. Chromium dekodiert den WHEP-Stream in Software —
im Browser wie in der Electron-App.**

AV1 8 bit, 2560x1440, 20 s je Variante:

| Variante | NVDEC | ms/Bild | GL-Treiber | Urteil |
|---|---|---|---|---|
| Chromium unverändert | 0 % | 3,06 | NVIDIA RTX 5080 | Software |
| + VA-API-Schalter | 0 % | 3,02 | NVIDIA RTX 5080 | Software |
| + VA-API und `--use-gl=egl` | 0 % | 3,32 | **SwiftShader** | Software |
| Electron wie ausgeliefert | 0 % | 3,01 | NVIDIA RTX 5080 | Software |
| Electron + VA-API-Schalter | 0 % | 3,16 | NVIDIA RTX 5080 | Software |

Kontrollmessung: `ffmpeg -hwaccel cuda` über dieselbe Vorlage treibt NVDEC auf
**48 %**. Der Zähler schlägt also an — ohne diese Kontrolle wäre jedes „0 %"
oben bedeutungslos.

Rohdaten:
`streaming/testbench/profiles/browser-decode-2026-08-03-chromium-webrtc.json`.

Damit deckt sich der WebRTC-Pfad mit dem `<video>`-Befund von 2026-07-26. Die
Decke ist dieselbe, die Hoffnung, WebRTC könne einen anderen Weg nehmen, trägt
nicht.

## Warum das Ergebnis belastbar ist

Drei Achsen, absichtlich unabhängig voneinander, plus zwei Kontrollen — jede
einzelne davon hätte hier in die Irre geführt:

* **`decoderImplementation` und `powerEfficientDecoder` waren beide
  `undefined`.** Hätte die Messung nur an ihnen gehangen, gäbe es kein
  Ergebnis. Sie sind ohnehin die schwächste Achse: der Name meldet bekanntlich
  gern Hardware, während der Decode still in Software zurückfällt — genau
  deshalb existiert `VaapiIgnoreDriverChecks`.
* **NVDEC-Auslastung der Karte** ist die einzige Achse außerhalb des
  Messobjekts und hat hier entschieden.
* **Decode-Zeit je Bild** (~3 ms bei 1440p) stützt sie unabhängig.
* **Kontrolle 1 — schlägt der Zähler an?** `ffmpeg -hwaccel cuda`: 48 %.
* **Kontrolle 2 — kamen die Schalter überhaupt an?** Am laufenden Prozess
  nachgesehen: `--enable-features=AcceleratedVideoDecodeLinuxGL,…` und
  `LIBVA_DRIVER_NAME=nvidia` stehen dort. Das ist keine Förmlichkeit: Playwright
  setzt ein **eigenes** `--enable-features=CDPScreenshotNewSurface`. Unseres
  steht dahinter und gewinnt (bei doppeltem Switch zählt in Chromium der
  letzte) — stünde es davor, wäre die ganze Messreihe wertlos gewesen, ohne
  dass man es dem Ergebnis ansähe.
* **Kontrolle 3 — war der Browser an der echten Karte?** Der GL-Treiber wird je
  Lauf erhoben. Playwright startet mit `--enable-unsafe-swiftshader`; ein
  Rückfall auf Software-GL hätte „Software" schon in den Aufbau gelegt.

Die Feature-Namen sind die von Chromium 150. `VaapiVideoDecoder` aus älteren
Anleitungen ist **wirkungslos** — seit Chromium 131 heißt das Feature
`AcceleratedVideoDecodeLinuxGL`. Ein unbekannter Feature-Name wird still
ignoriert; eine Messung damit sähe aus wie „Schalter helfen nicht", obwohl gar
nichts eingeschaltet war.

## Nebenbefund: `--use-gl=egl` ist hier schädlich

Die in vielen Anleitungen empfohlene Ergänzung `--use-gl=egl` warf Chromium auf
**SwiftShader** zurück — Software-Rasterisierung statt GPU. Die Decode-Zeit war
in dieser Variante entsprechend die schlechteste des Feldes (3,32 ms). Der
Schalter gehört auf dieser Maschine nicht gesetzt.

## Nebenbefund: AV1 10 bit wird gar nicht dekodiert

Mit `synth10.mkv` (AV1 Main, `yuv420p10le`) blieb `framesDecoded` über den
ganzen Lauf bei **0**, während Transport und Aushandlung sauber liefen: 33.625
Pakete, 12 Keyframes empfangen, AV1 mit `profile=0` ausgehandelt, Verbindung
durchgehend `connected`. Dazu ein PLI-Sturm — Chromium forderte 49 mal einen
Keyframe an, weil es keinen verwerten konnte. Mit derselben Vorlage in 8 bit
lief die Wiedergabe sofort.

Einordnung, bevor daraus eine Produktaussage wird:

* Der Auto-Default ist **AV1 8 bit** (`settings.svelte.ts:418`); 10 bit ist
  eine ausdrückliche Nutzerwahl („AV1 10 bit"). Der Normalfall ist also nicht
  betroffen.
* Gemessen ist der **Prüfstands-Sender** (ffmpeg, `-c copy`), nicht der echte
  Linux-Sidecar. Ob dessen 10-bit-Strom dasselbe auslöst, ist **ungeprüft** —
  `real-harness.py` wäre der Weg.

Wenn es sich am echten Sender bestätigt, wäre die Folge unangenehm konkret: wer
„AV1 10 bit" wählt, sendet an Browser- und Electron-Zuschauer ein Bild, das
diese nicht dekodieren können. Das gehört geprüft, bevor die Einstellung so
angeboten bleibt.

## Offen

* **10 bit am echten Sidecar gegenprüfen** (`real-harness.py`) — s. o.
* **H.264 ist im Prüfstand ungemessen.** Beide Läufe brachen nach 13 Paketen
  ab. Ursache liegt im Aufbau, nicht in Chromium: ausgehandelt wird
  `profile-level-id=42e01f` (Constrained Baseline, Level 3.1, bis 720p30),
  die Vorlage ist Main@1440p. Für einen H.264-Datenpunkt braucht es eine
  passende Vorlage.
* Ob Windows (D3D11-Videodecode) anders aussieht, ist weiterhin ungemessen.

## Folgerung

Für die HQ-Wiedergabe unter Linux gibt es über Chromium-Schalter nichts zu
holen — weder im Browser noch in Electron. `desktop/electron/main.ts` bleibt
unverändert; ein `appendSwitch` dort wäre Aufwand ohne Wirkung und müsste
zudem mit dem bereits gesetzten `DocumentPictureInPictureAPI` in **einen**
Aufruf zusammengelegt werden, sonst überschriebe es dieses still.

Der Weg zu Hardware-Decode bleibt der native Player (`streaming/pulse-player/`),
der Decoder und Pufferformat selbst wählt — dieselbe Folgerung wie 2026-07-26,
jetzt auch für den WHEP-Pfad belegt.

## Reproduzieren

```bash
cd streaming/testbench
./browser-decode.py --secs 20 --quelle synth8-av1.mkv --label x
./browser-decode.py --nur basis --quelle synth10.mkv --label zehnbit
```

Voraussetzungen wie beim übrigen Prüfstand (MediaMTX, Redis 6380,
`mediamtx-auth-hook` 8005). Für die Electron-Varianten zusätzlich
`cd desktop && pnpm run build:electron`.
