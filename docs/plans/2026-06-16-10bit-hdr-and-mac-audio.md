# 10-Bit / HDR-Streaming + Mac-Audio-Routing — Recherche & Design

Stand: 2026-06-16 (Nacht-Session). Zwei Themen: (A) Machbarkeit von 10-Bit/HDR
in H.264 **und** AV1 über Mac/Windows/Linux, (B) Design des noch offenen
Mac-Audio-Routings (Excludes / spezifische App / Pulse-Echo).

---

## A) 10-Bit / HDR-Streaming

Wichtig vorweg: **aktuell ist nirgends 10-Bit oder HDR implementiert** — alle drei
Sidecars encoden 8-Bit (`h264`/`hevc`/`av1`). Die folgende Analyse ist Machbarkeit,
kein Ist-Zustand. Drei Stufen müssen *alle* mitspielen: Encode → Container/Transport
→ Browser-Wiedergabe. Der Engpass ist die Wiedergabe.

### 1. Encode (Hardware)

| Plattform / Encoder            | H.264 10-Bit | HEVC 10-Bit (Main10) | AV1 10-Bit |
|--------------------------------|:------------:|:--------------------:|:----------:|
| **Mac** VideoToolbox           | nein¹        | **ja** (verifiziert²)| nein³      |
| **Windows** NVENC/AMF/QSV      | nein¹        | ja                   | ja⁴        |
| **Linux** GSR (NVENC/VAAPI)    | nein¹        | ja                   | ja⁴        |

¹ **H.264 10-Bit (High 10) kann kein verbreiteter Hardware-Encoder** — weder NVENC
noch VideoToolbox noch AMF/QSV. H.264-10-Bit ist damit auf allen Plattformen raus.
Antwort auf „10-Bit in H.264?": **technisch nicht über Hardware-Encode möglich.**

² Mein OpenSSL-FFmpeg auf diesem Mac: `hevc_videotoolbox` listet `p010le` (10-Bit)
+ Profil `main10`. 10-Bit-HEVC-Encode auf Apple Silicon ist also real.

³ `av1_videotoolbox` existiert in FFmpeg 8.0.1 nicht; AV1-HW-Encode ohnehin erst M3+.

⁴ AV1 10-Bit: NVENC ab Ada (RTX 40xx — deine 4090 kann es), AMD RDNA3+, Intel Arc.

**HDR** ist 10-Bit **plus** BT.2020-Primärfarben + PQ-/HLG-Transferfunktion +
Mastering-Metadaten. Encode-seitig dieselbe Geschichte wie 10-Bit (HEVC/AV1 tragen
die Color-VUI/SEI); der Capture-Pfad müsste die HDR-Frames aber auch 10-Bit liefern
(SCK/WGC/Portal in P010 + die Display-HDR-Metadaten durchreichen — heute liefern wir
überall 8-Bit BGRA).

### 2. Container / Transport (FLV/RTMP → MediaMTX → WHEP)

- Klassisches **FLV/RTMP kann nur H.264 + AAC**. Für HEVC/AV1 brauchen wir
  **Enhanced-RTMP (E-RTMP)**. FFmpegs FLV-Muxer kann E-RTMP-HEVC/AV1, MediaMTX 1.x
  reicht E-RTMP-HEVC/AV1 durch (es dekodiert nicht). 10-Bit sollte transparent
  durchlaufen, da MediaMTX nur weiterleitet.
- **HDR-Metadaten** (Mastering Display / MaxCLL, colr) müssen den ganzen Weg
  überleben — Bitstream-SEI überlebt Passthrough meist, ist aber pro Pfad zu prüfen.

### 3. Wiedergabe im Browser (WHEP/WebRTC) — **der Engpass**

Unser Viewer-Modell ist WHEP (WebRTC) für Low-Latency. Browser-WebRTC kann:
- **H.264** (8-Bit), VP8/VP9, **AV1**. **HEVC über WebRTC: praktisch nur Safari.**
- **10-Bit-Decode über WebRTC** ist der kritische Punkt:
  - **AV1 10-Bit**: Chrome/Edge dekodieren AV1; das Main-Profil deckt 10-Bit ab —
    der WebRTC-Pfad + korrektes Rendering ist aber **real zu testen**, nicht
    garantiert.
  - **HEVC 10-Bit**: nur Safari, HDR-Rendering im WebRTC-Pfad ungesichert.
- **Echtes HDR** (an ein HDR-Display durchgereicht) ist über Browser-WebRTC heute
  **nicht etabliert**.
- **HLS-Alternative:** MediaMTX serviert auch LL-HLS, und Safari spielt HDR-HEVC via
  HLS nativ — das ist der etablierte HDR-Streaming-Pfad. Aber: HLS statt WHEP heißt
  **mehr Latenz** (wir geben das WebRTC-Low-Latency-Modell auf).

> ⚠️ Browser-Support bewegt sich schnell und liegt teils hinter meinem Wissensstand
> (Jan 2026). Die obigen Aussagen sind **vor einer Entscheidung mit echten
> Chrome-/Safari-WHEP-Tests zu verifizieren**, nicht aus dem Gedächtnis zu glauben.

### 4. Fazit & Empfehlung

- **„10-Bit in H.264"**: nicht möglich (kein HW-Encoder kann High 10).
- **10-Bit (SDR, weniger Banding) in AV1**: am ehesten machbar — Windows/Linux jetzt
  (RTX 4090 ✓), Mac erst mit künftigem `av1_videotoolbox` + M3+. Lohnt einen Spike,
  *wenn* ein realer Test zeigt, dass Chrome AV1-10-Bit über WHEP sauber abspielt.
- **Echtes HDR (PQ/HLG)**: über den WHEP-Viewer-Pfad heute **nicht praktikabel**
  (Browser-Support). Nur via HLS + Safari realistisch — was Low-Latency opfert.
  **Empfehlung: HDR zurückstellen**, 10-Bit-AV1-SDR als optionalen „Quality"-Modus
  evaluieren (hinter eine Capability-Probe, die HW *und* Browser prüft).

### 5. Konkrete nächste Schritte (falls weiterverfolgt)

1. **Realer Browser-Test** zuerst (billigste Erkenntnis): E-RTMP-HEVC-10-Bit und
   AV1-10-Bit durch MediaMTX pushen, in Chrome + Safari per WHEP öffnen → was spielt
   wirklich, mit Farben? Erst danach Encode-Arbeit.
2. Capability-Probe um **Bit-Tiefe** erweitern (`caps.rs` analog: 10-Bit nur
   anbieten, wenn HW-Encoder *und* Ziel-Browser es können).
3. Capture-Pfad auf **P010** umstellen (heute 8-Bit BGRA) — nur für HDR nötig,
   größerer Eingriff (SCK `pixelFormat`, swscale, HDR-Metadaten).

---

## B) Mac-Audio-Routing — Design (noch nicht implementiert)

Heute auf Mac: `Aus` und `Desktop` funktionieren; `list_application_audio` liefert
jetzt echte Apps (Picker füllt sich). **Nicht** verdrahtet: Excludes, spezifische
App, korrekter Pulse-Echo-Ausschluss. Grund für das Zurückstellen: headless nicht
verifizierbar + echte Designfragen.

### SCK-Kernconstraint

`SCContentFilter` scopt **Video UND Audio gemeinsam**. Die Bindings bieten:
- `initWithDisplay:excludingApplications:exceptingWindows:` → Display **minus** Apps.
- `initWithDisplay:includingApplications:exceptingWindows:` → **nur** diese Apps.

### Die drei UI-Modi und wie sie auf SCK abbilden

1. **Desktop-Ton minus Apps (+ Pulse-Echo)** → `excludingApplications`.
   Schließt die Apps aus Video **und** Audio aus. Pulses Fenster verschwindet damit
   auch aus dem Video — für „streame meinen Desktop, aber nicht meine Pulse-Stimme"
   akzeptabel. **Baseline (leere Liste) ist identisch zu heute** → geringes Regressionsrisiko.
   - **Pulse-Identität:** der `excludesCurrentProcessAudio`-Flag schließt das
     *Sidecar* aus (das hat keinen Ton) — falsch. Pulse = der **Electron-Prozess**.
     Optionen: Sidecar nimmt `getppid()` (Electron ist der Parent) oder matcht die
     Bundle-ID `com.howispulse.Pulse`. Achtung: Electron spielt Audio aus einem
     **Helper-Prozess**, nicht dem Main — SCRunningApplication ist aber pro App
     (Bundle), also sollte der App-Ausschluss greifen. **Live zu verifizieren.**

2. **Spezifische App-Audio bei Monitor-Video** → geht **nicht** mit einem Stream
   (Filter scopt beides). Zwei Wege:
   - (a) **Zweiter, audio-only `SCStream`**, gefiltert auf die App (`includingApplications`
     + `capturesAudio`, kein Video) — sauberste Semantik (Monitor-Video + App-Audio),
     aber mehr Code (zweite Session, A/V-Mux aus zwei Quellen).
   - (b) **„Spezifische App" = ganze App capturen** (Video+Audio via
     `includingApplications`) — einfach, aber ändert das Video auf das App-Fenster.
   - **Entscheidung nötig** (Produkt): Win/Linux-Semantik ist Monitor-Video +
     App-Audio → spricht für (a).

3. **Mikrofon / Desktop+Mikrofon** → braucht `AVCaptureSession` (separater
   Mic-Pfad) + einen Mixer. Heute Stub. Eigener Arbeitsblock.

### Empfohlene Reihenfolge (mit Live-Verifikation)

1. **Pulse-Echo-Fix + Excludes** via `excludingApplications` (Baseline bleibt) —
   zuerst, weil klar definiert und hoher Wert (kein Stimm-Echo im Stream).
2. **Spezifische App** als **Dual-Stream** (Variante a) — die ehrliche Semantik.
3. **Mikrofon** zuletzt (AVCaptureSession).

Jeder Schritt braucht den Live-Test (Ton abspielen, Stream mitschneiden, hören),
deshalb gemeinsam morgen statt blind über Nacht.
