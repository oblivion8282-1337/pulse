# Übergabe — Branch `perf/win-sidecar-latenz`, Stand 2026-07-30 abends

Kurzfassung für den, der hier weitermacht. Die Messungen und ihre Herleitung
stehen in `2026-07-30-amd-windows-messung.md`; **hier steht nur, wo die Arbeit
gerade liegt und was noch offen ist.**

---

## Branch-Stand

Zwei Commits, **nicht gepusht**, kein PR:

```
d8ced867  doku(win-sidecar): AMD/Windows-Messreihe, samt der Irrwege
bfd7a2dc  perf(win-sidecar): AV1 auf AMD zero-copy — der Pool war das Problem
```

Basis ist `3e453ad0` (der Stand, mit dem der Branch übernommen wurde).
Arbeitsverzeichnis sauber, Build grün, 21/21 Tests.

**Ein Changelog-Eintrag fehlt noch.** Die Änderung ist user-facing (AV1-Streaming
auf AMD), und `web/static/changelog.json` hat nichts dazu. Nach Projektregel
werden dafür mehrere Stil-Vorschläge gemacht und der Nutzer wählt — nicht selbst
entscheiden.

---

## Was inhaltlich passiert ist

Eine Zeile pro Punkt, Details im Messdokument:

1. **AV1 auf AMD läuft jetzt zero-copy** (D3D11, `av1_amf`) statt über die
   CPU-Pipeline. 113 % → ~10 % einer CPU-Kerne, 42 → 0 übersprungene Bilder.
   Die Ursache war der D3D11VA-**Texture-Array-Pool**, aus dem die AMF-Runtime
   falsch liest; mit Einzeltexturen (`initial_pool_size=0`, nur auf AMD) ist es
   sauber. NVIDIA unverändert auf dem Array.
2. **`async_depth=1`** auf dem d3d12va-Zweig: H.264-Encode-Latenz 19,2 → 6,8 ms
   bei byte-identischem Bitstrom.
3. **`usage=ultralowlatency`** für AMF: Video-Engine-Last 22 → 10 %, ohne
   Qualitätsverlust.
4. Aufräumen: Pfadregel an einer Stelle (`VideoCodec::encode_path`),
   `StartParams::codec()`, `src/env.rs`, Vendor-Tabelle in `system::dxgi`.
5. `fetch-mediamtx.ps1` zieht 1.19.1 statt 1.18.1.

### Die Lehre, die im Code steht und hier wiederholt gehört

Der zerrissene AV1-Pfad ging durch **jede** Messung: Latenz, CPU, GPU,
Frame-Gaps, Bitrate, Decodierbarkeit — alles besser als beim funktionierenden
Weg, Strom formal einwandfrei, null Decode-Fehler. Nur das Bild war Müll,
aufgefallen ist es dem Nutzer im Produktionstest.

> **Bei jedem Eingriff in einen Bildweg gehört eine Sichtprüfung dazu.**
> Ein Standbild ziehen und ansehen. Zähler reichen nicht.

Zweite Lehre, zweimal am selben Tag zugeschlagen: **erst den Messaufbau gegen
H.264 prüfen.** Ein veralteter MediaMTX-Pin und ein Abgriff am Live-Rand der
HLS-Playlist sahen beide wie Encoder-Fehler aus. Der H.264-Kontrollwert hat
beide Male den Aufbau als Schuldigen entlarvt.

---

## Server — Zugang und was dort steht

Von diesem Rechner (und von `Michi-PC-2`) per SSH-Schlüssel erreichbar:

```
ssh pulse-prod    # netcup 159.195.150.54 — PRODUKTION
ssh pulse-test    # Hetzner 77.42.71.166 — Versuchsserver
```

**Arbeitsweise, vereinbart:** auf Hetzner frei arbeiten; auf netcup von sich aus
nur lesen (Logs, `docker compose ps`, Konfiguration), alles Verändernde vorher
absprechen.

### netcup (Produktion)

`~/pulse/infra/prod`, 15 Container. Bestätigt: MediaMTX ist wirklich
`ghcr.io/oblivion8282-1337/pulse-mediamtx:1.19.1-pulse`
(`sha256:a0a74202cf4a5a84dea9a0121b785cacdaf814bd4d76ed3307c36576f936b8d6`).

**Dort wurde die WHEP-Frage beantwortet:** ein WebRTC-Leser hat den AV1-Stream
knapp drei Minuten gelesen und regulär beendet. AV1 über WHEP funktioniert in
Produktion.

### Hetzner (Versuchsserver)

Sammelserver mit vielen fremden Projekten. Pulse läuft als All-in-One-Container
(`registry.howispulse.com/pulse-allinone:edge`).

**NICHT ANFASSEN — Experimentierbaustelle für den nativen Player:** im
All-in-One-Container ist `/usr/local/bin/mediamtx` durch einen Wrapper ersetzt,
der `mediamtx.fec` mit `PULSE_FLEXFEC=1` (10+2) und `PULSE_KEYFRAME_INTERVAL=0`
startet. Daneben liegen `mediamtx.pli`, `mediamtx.orig` (unverändertes v1.19.1)
und vier Wrapper-Varianten. Alles in der beschreibbaren Container-Schicht —
**ein Neuerzeugen des Containers löscht es.** Der Rückweg steht in den
Wrapper-Kommentaren.

**Neu angelegt für Sidecar-Tests:** `~/mediamtx-sidecar-test/`, eigener Container
`mediamtx-sidecar-test`, dasselbe Image wie Produktion, eigene Ports:

| | Produktion | Testinstanz |
|---|---|---|
| RTMPS | 1936 | **11936** |
| WHEP | via Caddy | **8889** |
| ICE/UDP | 8189 | **18189** |
| HLS | intern | 8888 |
| Auth | `http` (media-svc-Token) | `internal` (Benutzer/Passwort) |

Push-URL: `rtmps://77.42.71.166:11936/<pfad>?user=pulse&pass=<siehe .credentials>`
Zuschauen: `http://77.42.71.166:8889/<pfad>`
Zugangsdaten: `~/mediamtx-sidecar-test/.credentials` auf dem Server.

Verifiziert: Push von Windows aus über echtes Internet, `2 tracks (AV1, Opus)`.

---

## Offene Fäden

**1. Aussetzer in der Audio-Stufe — die dringendste Sache.**
Alle 30–60 s hängt der Pacing-Loop in der Audio-Stufe fest: gemessen 175 ms,
605 ms, 952 ms, **1396 ms**. Video ist dabei jedes Mal unauffällig
(`conv`/`send`/`mux` normal). Der Rückstau lässt den Capture-Kanal überlaufen →
sichtbarer Ruckler. Codec- und pipelineunabhängig.

Verdacht: **kein Audio-Fehler**, sondern Netzwerk-Rückstau. Der `MuxWriter` hat
eine Warteschlange von 256 Paketen; stockt der RTMPS-Schreibvorgang, läuft sie
voll und blockiert. Im Pacing-Loop wird **zuerst Audio** gedraint, das schluckt
also die ganze Wartezeit, während `mux` (nur Video gemessen) bei 0,0 ms bleibt.
Audio liefert bei 5-ms-Paketen ~200 Pakete/s — die Schlange füllt sich in gut
einer Sekunde, passend zur Größenordnung.

Unterscheider: derselbe Lauf mit Ziel **Datei** statt Netzwerk. Tritt es dort
nicht auf, ist es der Uplink. Seit der Hetzner-Testinstanz lässt sich das auch
von beiden Seiten gleichzeitig beobachten.

**2. Bitrate schwankt stark — untersucht, ohne Lösung.**
`av1_amf` hält bei „CBR" nur den Mittelwert, nicht die Momentanrate: gemessen
2322–5389 kbit/s bei Ziel 4000 (Faktor 2,3). Wirkungslos: `rc_buffer_size`,
`enforce_hrd`, `rc=vbr_latency`. `rc=hqcbr` und `rc=qvbr` lassen `av1_amf` gar
nicht erst öffnen. `filler_data=1` würde es lösen (Faktor 1,06), erzeugt aber
`OBU_PADDING` von 0,4–8,3 kB — **genau die Form, die `infra/mediamtx-fork/`
wegpatcht**, weil sie libwebrtcs RTP-Zusammenbau zerlegt. Kein Weg.
H.264 über d3d12va ist mit Faktor 1,23 deutlich stabiler.

**3. `av1_d3d12va` ist upstream kaputt — Meldung nicht abgesetzt.**
Auf AMD unbrauchbarer Bitstrom (drei Decoder lehnen ab), auch im FFmpeg-Nightly
vom 2026-07-30. Zusätzlich öffnet er nur bei Breite%64==0 und Höhe%16==0.
FFmpegs eigener Parser kommt durch (gleiche `cbs_av1`-Implementierung wie der
Schreiber), unabhängige Decoder nicht. Material für eine Upstream-Meldung liegt
im Messdokument; abgeschickt wurde nichts.

**4. NVIDIA ist bei alldem ungetestet** — hier stand keine NVIDIA-Karte zur
Verfügung. Der NVIDIA-Pfad wurde deshalb bewusst code-identisch gelassen; neu
ist dort nur eine einmalige Vendor-Abfrage beim Pool-Bau.

**5. Eine Zahl im Code steht unter Vorbehalt.** Die D3D11-Zeile in der
`amd_forces_d3d11`-Tabelle (`h264_amf`: 17,2 ms / 10,5 % GPU) stammt aus einem
Lauf mit zerrissenem Bild und ist nach dem Fix nicht nachgemessen. Steht so
dabei.

---

## Was auf dem Mini-PC eingerichtet wurde

Steht auch in der maschinenlokalen Memory, hier zur Vollständigkeit:

- Toolchain neu installiert: Rust (rustup), LLVM, VS Build Tools (C++), Go 1.26
  (als ZIP unter dem Scratchpad, nicht im PATH)
- `streaming/win-hq-sidecar/ffmpeg-dist/` geholt (gitignored)
- **Die installierte Pulse-App (0.1.41) hat den gepatchten Sidecar** —
  `%LOCALAPPDATA%\Programs\Pulse\resources\hq-sidecar\pulse-win-hq-sidecar.exe`
  wurde ersetzt, das Original liegt daneben als `.exe.original`. Ein
  App-Update überschreibt den Tausch.
- Testskripte im Scratchpad (`sidecar_run.ps1`, `bench.ps1`) — nicht im Repo,
  gehen beim Aufräumen verloren.
