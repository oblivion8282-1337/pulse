# Fernsteuerung — Übergabe an die Windows-Session (2026-07-22)

Diese Datei ist die Übergabe für die **Claude-Session auf dem Windows-Rechner**.
Auf Linux (Vortag) sind M0–M2b + der Startverzögerungs-Fix gebaut; die
Windows-only-Teile konnten dort **nicht kompiliert** werden (`ffmpeg-sys` nicht
cross-checkbar). Hier steht, was zu tun ist.

**Feature:** Parsec-artige Fernsteuerung in Pulse — additiver Slice neben dem
HQ-Streaming, Host zunächst Windows. Machbarkeit voll belegt (Latenz, Interop,
NAT/TURN) — Details: `docs/2026-07-21-remote-control-latenz-messung.md`.

**Branch:** `feat/remote-control-windows` (dieser). Nichts nach `main` gemergt.

> **Nachtrag Windows-Session 2026-07-22:** Aufgaben 1+2 sind erledigt. M0
> bestanden (Δ 0 px auf 3 Monitoren; Einschränkung: alle 100 % Skalierung —
> Mixed-DPI real noch nicht ausgeübt, nur `PER_MONITOR_AWARE_V2` gesetzt).
> M2b + Fix kompilieren auf Windows **ohne einen einzigen Fix** (`cargo check
> --all-targets` sauber, 9 Tests grün); keine der unten erwarteten Fix-Stellen
> ist eingetreten. Branch auf main (4b81de95, v0.1.39) rebased — ein trivialer
> `lib.rs`-Modulkonflikt (`redact` vs `remote`, beide behalten). Das
> Input-Wire-Protokoll v1 ist mit dem User entschieden:
> `docs/plans/2026-07-22-remote-control-input-wire-protokoll.md` — damit ist
> M2c startklar. Aufgabe 3 (Verhaltens-Test) bleibt offen, sie braucht den
> M3-Controller.

## Meilenstein-Stand

| | Was | Stand |
|---|---|---|
| M0 | Windows-Input-PoC (`streaming/win-input-poc/`) | ✅ bestanden auf Windows (Δ 0 px, 3 Monitore; Mixed-DPI offen) |
| M1 | `remote:*`-WS-Slice + `REMOTE_CONTROL`-Bit (chat-gateway) | ✅ verifiziert (14 Tests + Consent-Review), Linux |
| M2a | webrtc-Kern `streaming/pulse-remote-webrtc` | ✅ headless verifiziert (Chromium-Interop) + baut auf Windows |
| M2b | Sidecar-Tee + `RemoteController` (`win-hq-sidecar`) | ✅ kompiliert auf Windows, Tests grün — Verhaltens-Test offen |
| Fix | Keyframe auf RTCP-PLI/FIR (Startverzögerung) | lib ✅ / Sidecar ✅ kompiliert — Wirkung am Stream offen |
| M2c | Input-Wire-Protokoll v1 | ✅ spezifiziert + implementiert (`src/remote_input.rs`, 15 Unit-Tests) — Verhaltens-Test am Stream offen |

## Aufgaben auf Windows (Reihenfolge)

### 1. M0 — Input-PoC laufen lassen
```
cd streaming/win-input-poc
cargo run --release
```
Beweist Maus-Injection auf Multi-Monitor + gemischter DPI (`SendInput` +
`MOUSEEVENTF_VIRTUALDESK` + Per-Monitor-DPI-Awareness). **Erfolg:** Δ ≤ 2 px auf
allen Monitoren (ideal: zwei Monitore mit unterschiedlicher Skalierung, z.B.
125 % + 100 %). Der Code ist die Vorlage für die Input-Injektion in M2c.

### 2. M2b + Fix — Sidecar kompilieren
```
cd streaming/win-hq-sidecar
cargo check         # bzw. cargo build
```
Der ganze Sidecar-Teil ist auf Linux **ungeprüft**. Erwartbare Fix-Stellen
(vom Vortag markiert):
- **Send-Bounds** des Feed-Tasks in `src/remote.rs` (`rt.spawn(feed_loop(...))`)
  — `RemoteSession` muss `Send+Sync` sein, `feed_frame()` ein Send-Future.
- **Closure→`Arc<dyn Fn>`-Coercion** in `SessionConfig` (`src/remote.rs`,
  `start_session`) — sollte via Feld-Typ greifen.
- **`AVPictureType`-Zugriff** in den drei Force-IDR-Stellen:
  `encoder_hw.rs:~204`, `encoder_d3d12.rs:~278` (Glob `ffi::*`),
  `encoder.rs:~370` (voll qualifiziert `ffmpeg::ffi::AVPictureType::AV_PICTURE_TYPE_I`).
- **tokio-Features**: `Cargo.toml` listet `rt-multi-thread, macros, sync, time`
  explizit — falls die Runtime doch was vermisst, hier ergänzen.

Compile-Fehler sind normal (blind geschrieben). Fixen und weitermelden.

### 3. Verhaltens-Test (echter Stream, 2 Geräte)
Wenn es baut: HQ-Stream starten, mit einem Controller (Browser) verbinden.
- **Kommt überhaupt Bild?** → `packet.data()` ist Annex-B (Annahme). Kein Bild ⇒
  evtl. AVCC nötig (Bitstream-Filter vor dem RTP-Feed).
- **Kommt es sofort (statt nach ~2 s)?** → Force-IDR auf PLI greift. Auf NVENC
  (RTX 50) zuverlässig; auf **AMD/d3d12va** honoriert `pict_type=I` evtl. NICHT
  → dort ggf. d3d12va-eigene Force-IDR-Option nötig (bekanntes Risiko).

## Architektur-Kurzfassung (damit der Kontext stimmt)

- **chat-gateway = nur Signaling-Relay + Consent-Gate** (M1), nie im Latenzpfad.
  Video+Input laufen P2P (webrtc-rs ↔ Browser). Ops: `remote_request` /
  `remote_respond` / `remote_signal{kind:offer|answer|ice}` / `remote_end`;
  Consent-Registry in `services/chat-gateway/.../remote_registry.py`, Handler in
  `routes/ws_remote_handlers.py`. Single-pod, kein Redis (wie watch_registry).
  **Sicherheit:** Session nur per Host-`accept` aktiv; Signal nur zwischen den
  zwei Peers; Disconnect beendet sofort (kein Grace).
- **`pulse-remote-webrtc`** (M2a, plattformunabhängig): `RemoteSession` mit
  H.264-`TrackLocalStaticSample` (Frames als Bytes rein via `feed_frame`),
  Input-DataChannel (Bytes über `on_input`-Callback raus), Trickle-ICE,
  ICE-Policy `All`. RTCP-PLI/FIR → `on_keyframe_request`.
- **Sidecar (M2b, Modus A = geteilter Encode):** `RemoteController`-Singleton
  (lazy tokio-Runtime). Tee in `drain_packets`/`drain_video` klont den
  encodeten H.264-Packet (billig, Refcount) und schiebt ihn non-blocking in
  eine bounded Queue → Feed-Task → `feed_frame`. **Null-Overhead bei inaktiver
  Session** (ein Atomic-Load), RTMPS-Pfad byte-identisch. `block_on` in der
  Control-Plane ist sicher (main.rs ist sync, kein `#[tokio::main]`).

## Danach (noch nicht gebaut)

- **M2c** — Input-Injektion: ✅ **erledigt** (Windows-Session 2026-07-22).
  `src/remote_input.rs` = Parser (`InputFrame::parse`, rein) + `SendInput`-
  Injektor (`InputInjector`); im `on_input`-Callback in `src/remote.rs` verdrahtet
  (kein `eprintln` mehr), `release_all()` bei jedem Session-Stop. Quelle fürs
  Koordinaten-Mapping kommt aus `stream_controller::active_capture_source()`
  (bei `start` gesetzt), Fenster-Rect via `DWMWA_EXTENDED_FRAME_BOUNDS`. DPI-
  Awareness wird in `main.rs` gesetzt. 15 Unit-Tests (Parser + Mapping). Wire-
  Spec: `docs/plans/2026-07-22-remote-control-input-wire-protokoll.md`. **Was
  NICHT ohne echten Stream/Controller getestet ist:** ob die injizierten Events
  im Ziel korrekt landen — das ist Teil von Aufgabe 3.
- **M2d** (zurückgestellt) — Modus B: steuern ohne aktiven Stream (Encoder/Mux
  entkoppeln, on-demand-Capture). Größter Umbau.
- **M3** — Frontend (Linux-verifizierbar): Client-`remote:*`-Ops, Controller-
  WebRTC, Consent-Dialog, Viewer-Fenster, `window.pulse.remote.*`, Electron-
  Signaling-Bridge (stdio↔WS). Mockup: Artifact vom 2026-07-21.

## Offene Entscheidungen / Notizen

- **Codec = H.264** für v1 (universeller/latenzärmster Decode). AV1 kann
  webrtc-rs, aber Viewer-Decode-Latenz/Kompatibilität → später.
- **TURN Pflicht** (Consumer↔Consumer-Test scheiterte direkt); regionale
  coturn-Server als Zielarchitektur, ICE-Policy `All`.
- **Neue Deps** (User ok): `bytes`, `rtcp`, `tokio` im Sidecar; `webrtc`,
  `rtcp`, `tokio`, `bytes`, `serde_json` in `pulse-remote-webrtc`.
- **Windows-Release braucht Version-Bump** (`desktop/package.json`) — gilt beim
  echten Ausliefern, nicht beim Entwickeln (CLAUDE.md).
- Standalone-Verifikations-Repos auf dem Linux-Rechner (nicht im Git): Spike
  `~/Dokumente/pulse-remote-spike`, M2a-Testharness
  `~/Dokumente/pulse-remote-webrtc-test`. Auf Windows nicht nötig.
