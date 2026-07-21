# Fernsteuerung (Parsec-artig) — Machbarkeits-Analyse + Latenz-Messung (2026-07-21)

Frage: Ist ein Parsec-artiger Fernsteuerungs-Modus (Bildschirm sehen + Maus/Tastatur
steuern) in Pulse mit sehr niedriger Latenz machbar — ohne den bestehenden
HQ-Streaming-Pfad umzubauen? Host-Fokus zunächst **Windows**; Steuern von überall.
Gamepad und Virtual Displays bewusst ausgeklammert.

**Ergebnis vorweg: Ja.** Glass-to-glass ~45–90 ms sind mit P2P-WebRTC erreichbar
(gemessen, s. u.). Der Engineering-Aufwand steckt im Transport, nicht im Encoder.

## 1. Architektur-Entscheidungen (mit User getroffen)

- **Additiver Feature-Slice, kein Umbau**: Fernsteuerung teilt mit HQ-Streaming nur
  Code-Module (Capture/Encode), keine Laufzeitpfade. RTMPS→MediaMTX→WHEP bleibt
  byte-identisch; der P2P-Ausgang wird nur bei aktiver Steuersitzung zugeschaltet.
- **Core-Feature, kein Plugin**: Input-Injection braucht nativen Sidecar-Code +
  Electron-IPC (für Stufe-A-Plugins unerreichbar), und das Consent-Modell
  (Grant pro Sitzung/Person, sichtbarer Indikator, Not-Aus, Auto-Revoke) muss hart
  im Core verdrahtet sein. Auch eine spätere Plugin-Stufe B darf diese Capability
  nie exponieren.
- **Ein geteilter Encode für beide Ausgänge** (User-Entscheid): NVENC encodet
  einmal mit Low-Latency-Settings (zerolatency, keine B-Frames, CBR); derselbe
  Bitstrom wird zweimal paketiert — RTP für den P2P-Steuernden, FLV→RTMPS für die
  Zuschauer. Zuschauer ziehen damit auf die Low-Latency-Settings mit (minimal
  schlechtere Kompression bei gleicher Bitrate, bei 60 fps/4000 kbps kaum sichtbar).
  Paketieren kostet keine GPU; ein zweiter NVENC-Encode wäre auf moderner
  Hardware ebenfalls drin (~14 ms, 1 von 8 Sessions), ist aber nicht nötig.
- **MoQ ist geprüft und verworfen** (Details §4): falsches Werkzeug für 1:1-Steuerung.

## 2. Latenz-Messung — was gemessen wurde

Alle Messungen 2026-07-21, Dev-Maschine (RTX 5080, CachyOS) ↔ Hetzner-Test-Server
(77.42.71.166, Ubuntu 24.04, kein GPU). GStreamer 1.28.5 / nvh264enc / Python-Loop;
Skripte lagen im Session-Scratchpad (Wegwerf-Prototyp, bewusst nicht eingecheckt).

### 2.1 Encode+Decode-Pipeline (lokal, NVENC Low-Latency)

`nvh264enc bframes=0 zerolatency=true rc-mode=cbr bitrate=4000 gop-size=60` →
`nvh264dec`, 60 fps, GStreamer-Latency-Tracer, n=320 Frames pro Lauf:

| Auflösung @60fps | median | avg | max |
|---|---|---|---|
| 1080p | 11,0 ms | 10,1 | 14,7 |
| 1440p | 13,8 ms | 13,7 | 17,6 |
| 4K | 17,0 ms | 15,6 | 18,1 |

Encode+Decode zusammen bleibt bei/unter einem Frame (16,7 ms) — vernachlässigbar.

### 2.2 Echte Internet-Strecke (RTP-Round-Trip über UDP-Reflektor)

Voller NVENC-H.264-RTP-Stream (1440p60, mtu 1400) über den Hetzner reflektiert,
Round-Trip auf einer Uhr per RTP-Seqnum gematcht (~7000 Pakete pro Lauf):

| Größe | Wert |
|---|---|
| Netz-RTT (ICMP-Baseline) | 58,8 ms ± 1,1 ms Jitter, 0 % Verlust |
| RTP-Round-Trip | median 60 ms · p95 82 ms → one-way ~30 ms |
| Netz-Jitter one-way (p95−median) | ~11 ms |
| Paketverlust | 0,14–0,29 % |
| Frame-Durchsatz | ~100 % bei 60 fps |
| Jitter-Buffer-Sweep 5/20/40 ms | alle sauber → **5–15 ms Puffer reichen** |
| NAT-Lochung (Consumer-Seite) | UDP-Echo 20/20 durch Fritz!Box-NAT + Docker |

### 2.3 Latenz-Budget (fett = gemessen)

| Komponente | naher Peer (RTT ~20 ms) | Teststrecke (RTT **60 ms**) |
|---|---|---|
| Capture (~0,5–1 Frame, geschätzt) | 8–16 ms | 8–16 ms |
| **Encode+Decode (NVENC, 1440p)** | **14 ms** | **14 ms** |
| **Netz one-way** | ~10 ms | **30 ms** |
| **Jitter-Buffer** | **5–15 ms** | **5–15 ms** |
| Render (~0,5–1 Frame, geschätzt) | 8–16 ms | 8–16 ms |
| **≈ glass-to-glass** | **~45–70 ms** | **~65–90 ms** |

Input-Round-Trip (Maus → sichtbare Reaktion) = glass-to-glass + DataChannel-Hinweg
(≈ Netz one-way). Zum Vergleich: der bestehende MediaMTX-Relay-Pfad liegt bei
300 ms+ — fürs Zuschauen fein, für Steuern unbrauchbar. **Fazit: Parsec-Klasse ist
mit P2P erreichbar; die Latenz wird vom Netz dominiert, nicht von unserer Pipeline.**

### 2.4 Was NICHT gemessen wurde (offene Risiken)

- **Consumer↔Consumer-NAT** (beide hinter Router): Lochung nur einseitig bewiesen.
  Betrifft Verbindungs*wahrscheinlichkeit*, nicht Latenz. Fallback: TURN (coturn,
  bewusst aufgeschobener Baustein) oder degraded WHIP→MediaMTX→WHEP.
- **DTLS/SRTP/Congestion-Control**: addieren der laufenden Latenz nichts (nur
  Verbindungsaufbau/Sicherheit), waren aber nicht im Test.
- **Echter Screen-Capture** (WGC/PipeWire statt videotestsrc) und Render-Kette:
  Frame-Physik-Schätzungen (~1 Frame je Seite).
- Encode-Settings sind die *Steuer*-Settings (zerolatency), nicht byte-identisch
  die heutigen Zuschau-Settings des Rust-Sidecars (dessen Code liegt im eigenen Repo).

## 3. Ziel-Architektur (Kurzform)

| Schicht | HQ-Streaming (bleibt) | Fernsteuerung (neu, additiv) |
|---|---|---|
| Sidecar (win-hq) | `StreamController` → RTMPS | `RemoteController` → webrtc-rs P2P; teilt Capture/Encode als Lib |
| Signaling | media-svc-Tokens + auth-hook | WS-Ops `remote:*` im chat-gateway (Muster: Watch-Party) |
| Server-Infra | MediaMTX | keine (P2P); TURN nur als späterer Fallback |
| Frontend | HQ-Panel, StreamTile, WHEP | `lib/remote/` + Viewer-Fenster; `window.pulse.remote.*` |
| Input | — | DataChannel → `SendInput` (`MOUSEEVENTF_ABSOLUTE|VIRTUALDESK`, Per-Monitor-DPI-aware) |

Einstiege: Voice-Channel (Knopf am Stream-Tile, Marke „STEUERBAR") + DM/Friends
(Remote-Hilfe). Multi-Monitor: Umschalten fällt mit ab (`list_monitors` existiert);
mehrere gleichzeitig = mehrere Tracks (Bandbreite × Monitore). Mockup:
Artifact „Pulse — Fernsteuerung (Mockup)" (claude.ai/code/artifact/6d9cd0f6-…).
Windows-Sidecar-Änderungen brauchen den obligatorischen Version-Bump (electron-updater).

## 4. MoQ-Befund (geprüft 2026-07-21, verworfen)

MediaMTX 1.19.0 brachte MoQ (unser Fork 1.19.1-pulse hat es im Binary; in unseren
Configs nicht aktiviert, Port 8892 nicht freigegeben). Gegen MoQ für diesen Use-Case:

1. **Publish ist browser-only** (WebTransport+WebCodecs+MediaStreamTrackProcessor,
   Chrome): kein ffmpeg-/natives SDK; MediaMTX spricht IETF draft-19/18, das reifste
   native Ökosystem (moq-rs) ist auf „moq-lite" divergiert → Sidecar-Publish wäre
   Handarbeit auf quinn. Ingest bliebe eh RTMPS/WHIP.
2. **Messdaten**: Für interaktive Lasten ist MoQ das langsamste der Protokolle
   (arXiv 2505.22132: MoQ 431–559 ms E2E vs. WebRTC 234–289 ms vs. RoQ 122–215 ms);
   der produktionsreife WINK-Fork wirbt mit „sub-300 ms". Parsec-Liga ist <60 ms.
3. **Kein Rückkanal zum Host, kein P2P**: QUIC endet am Server; jeder Relay-Pfad
   addiert beide Netz-Beine. MoQs Stärken (Delivery at scale, schnelle Startzeit)
   sind für eine stehende 1:1-Session irrelevant.

## 5. Vorhandene Bausteine (Zweitverwertung)

- NAT-Lochung real bewiesen (WHIP-Plan/PR #172, Hetzner); STUN/TURN-Port 3478 läuft
  auf der Test-Instanz bereits (LiveKit-Stack).
- Offer/Answer-Relay-Muster existiert: `services/auth/.../routes_selfhost_signal.py`
  (`direct_offer`, App-Hosting).
- Opus passt exakt für WebRTC (48 kHz, 20-ms-Frames — WHIP-Plan verifiziert).
- `list_monitors`-Op im win-hq-sidecar (Monitor-Enumeration).
- Geplanter WHIP-Pfad (`docs/plans/2026-07-12-whip-guest-publish.md`) = natürlicher
  Degraded-Fallback, wenn P2P an symmetrischem NAT scheitert.

Nebenprodukte des Slices: „Tastatur weiterreichen" in Watch-Partys, optionaler
P2P-Low-Latency-Zuschaumodus (1–2 Viewer direkt, MediaMTX als Fallback),
generischer P2P-DataChannel (Clipboard, Datei-Drop, Stats-Overlay).
