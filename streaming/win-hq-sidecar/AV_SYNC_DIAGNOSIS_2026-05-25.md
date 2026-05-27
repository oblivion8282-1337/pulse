# A/V-Sync-Diagnose Win-HQ-Sidecar — 2026-05-25

**Status:** Momentaufnahme, untracked. Dritter Teil der Analyse-Serie (`CODE_REVIEW_*`, `CODE_REDUCTION_*`, dieser).
**Methode:** 1 Sonnet-Agent + Vorab-Inspektion durch mich (git-Historie als Kontext).
**Symptom (vom User bestätigt):** Audio läuft hinterher, Offset ist **konstant** (kein Drift), Test auf **AMD-Pfad** (NVIDIA ungetestet).
**Code-Stand:** `origin/main` inkl. `8ca08d9` (A/V-Sync-Anker) und `81a02e4` (AMD D3D12VA Zero-Copy).

---

## Diagnose

Symptom-Profil passt **exakt** zu drei sich addierenden Bugs, die alle in dieselbe Richtung schieben (Audio hinterher). Erwarteter Gesamt-Offset: **~20-80ms**.

Genau dieser Restbug ist im Commit `8ca08d9` (21.05.2026) explizit als offen markiert:

> „Ein Capture-Latenz-Rest (WGC vs. WASAPI) bleibt — separat zu justieren."

---

## Bug-Quelle #1: WASAPI `captured_at` ist Emit-Zeitpunkt, nicht Capture-Zeitpunkt

**Datei:** `audio/wasapi.rs:192-196`

`Instant::now()` wird auf den Chunk geprägt, *nachdem* er aus der internen `VecDeque` rausgezogen wurde. Die Bytes darin stammen von einem früheren `IAudioCaptureClient::GetBuffer`-Read — bei `buffer_duration_hns: 0` (Default ~10ms auf Win11) können mehrere Buffers in der Queue stehen.

**Beitrag zum Offset:** ~10-30ms Audio-PTS zu spät → Audio hinterher.

**Was die Engine bereitstellt:** `IAudioCaptureClient::GetBuffer` gibt einen `pu64QPCPosition`-Parameter zurück — der QueryPerformanceCounter-Wert zum echten Capture-Zeitpunkt vom Audio-Engine. Wird im aktuellen Code nicht ausgelesen.

---

## Bug-Quelle #2: Video-PTS hat keinen captured_at-Stempel, nur Wall-Clock seit `started`

**Dateien:** `pipeline_hw.rs:244-245`, `pipeline_d3d12.rs:205-206`, `stream_controller.rs:417-418`

Video-PTS = `started.elapsed().as_secs_f64() * fps`. Das ist der **Pacing-Tick-Zeitpunkt**, nicht der echte WGC-Frame-Capture-Zeitpunkt. WGC hat Compositor-Latenz (1-3 VSYNC-Perioden = 8-50ms je nach Refresh-Rate).

Audio hat im Vergleich einen "echteren" Wall-Clock-Stempel (auch wenn der laut #1 ebenfalls leicht zu spät ist). Video wirkt damit "zu früh" gegenüber Audio.

**Beitrag zum Offset:** ~8-50ms Video-PTS zu früh → Audio wirkt relativ dazu hinterher.

**Was WGC bereitstellt:** `Direct3D11CaptureFrame::SystemRelativeTime` ist ein QPC-Stempel vom Compositor zum Zeitpunkt der Frame-Komposition. Wird im aktuellen Code nicht ausgelesen.

---

## Bug-Quelle #3: AMD-D3D12-Pfad — Audio vor Mux-Aktivierung verworfen, aber `origin` schon gesetzt

**Dateien:** `encode/encoder_d3d12.rs:295-299` + `pipeline_d3d12.rs:148`

`set_audio_origin(started)` wird sofort gerufen, aber `send_audio` ist gated auf `self.mux.is_some()` — der Mux aktiviert erst beim ersten Keyframe-Packet. WASAPI-Worker zählt verworfene Chunks trotzdem in `emitted_frames` mit.

Bei AMD-D3D12 ist die Aktivierungs-Latenz typisch 0-1 Frames, aber sie erzeugt einen kleinen initialen Sprung.

**Beitrag zum Offset:** kleiner Initial-Sprung beim Stream-Start, **AMD-spezifisch**. Im CPU- und NVIDIA-Pfad nicht vorhanden.

---

## Aufaddierter erwarteter Offset

| Bug | Beitrag | Wirkung |
|---|---|---|
| #1 WASAPI emit-time ≠ capture-time | ~10-30ms | konstant |
| #2 Video-PTS ohne WGC-Compositor-Latenz | ~8-50ms | konstant |
| #3 AMD-Mux-Aktivierungs-Latenz | initial 0-2 Frames | einmalig beim Start |
| **Summe konstant** | **~20-80ms** | **Audio hinterher** |

Wenn der gemessene Offset deutlich größer (200ms+) ist, käme zusätzlich der WHEP-Empfänger-Jitterbuffer in Betracht — das wäre dann nicht mehr Sidecar-Seite. Bei einem Offset im 20-80ms-Bereich ist die Diagnose praktisch sicher.

---

## Nicht-Ursachen (geprüft, ausgeschlossen)

- **FLV-Timebase-Rundung:** kein Drift (Integer-Skalierung 48000→1000 via `av_rescale_q`, kein akkumulierter Fehler)
- **Audio-Resample-Drift:** WASAPI ist mit `autoconvert: true` auf 48kHz konfiguriert, kein `swresample` im Pfad

---

## Sekundäre Ursachen (NICHT der aktuelle Bug, aber bei Last erwartbar)

- **Silence-Burst nach Encoder-Stall** (`audio/wasapi.rs:208-222`): bei vollem mpsc(8)-Channel akkumuliert Wall-Clock weiter, Silence-Chunks werden statt echter Samples eingeschoben → sporadische Sprünge.
- **MuxWriter-Queue blockiert Pacing-Loop** (`mux_writer.rs:83-88`): bei Netzwerk-Spikes → Loop blockiert → Audio-`try_recv` läuft nicht → A/V-Sprung nach Stall.

Beide würden Sprünge erzeugen, keinen konstanten Offset. Passt nicht zum aktuellen Symptom.

---

## Saubere Fix-Strategie (NICHT umsetzen — nur Analyse)

**Beide Capture-Seiten liefern Hardware-QPC-Zeitstempel, die aktuell ignoriert werden.**

1. WASAPI-Worker liest `pu64QPCPosition` aus `GetBuffer` → echter Capture-Zeitpunkt pro Chunk
2. WGC-Capture liest `SystemRelativeTime` aus `Direct3D11CaptureFrame` → echter Compositor-Frame-Zeitpunkt
3. Statt `started: Instant` als gemeinsamen Anker: `started_qpc: u64` als gemeinsame Zeitbasis
4. Beide Pfade berechnen ihre PTS als `(captured_qpc - started_qpc) / qpc_frequency`
5. AMD-Aktivierungs-Bug separat: entweder Audio-Capture erst nach Mux-Aktivierung starten, oder PTS-Offset im Encoder korrekt verrechnen

**Geschätzter Aufwand:** 4-6h Refactor. Mittleres Risiko (QPC-Frequenz-Handling, Timebase-Konversion, Plattform-Tests). Würde die Bugs #1+#2 in einem Rutsch fixen und den vom Commit `8ca08d9` als offen markierten Punkt schließen. #3 bleibt separater AMD-Spezial-Fix.

---

## Diagnose-Fragen die noch offen bleiben

Eine vollständige Verifikation würde brauchen:
- **Konkreter Offset in ms** auf einem Test-Stream (z.B. mit Klatsch-Test gegen Bildschirm-Timestamp-Anzeige)
- **Vergleich AMD vs NVIDIA-Pfad** — wenn NVIDIA deutlich kleineren Offset hat, isoliert das #3 als AMD-only-Beitrag
- **Browser `chrome://media-internals`** beim WHEP-Empfänger: zeigt Roh-Packet-Timestamps; bestätigt ob Versatz schon im Sender entsteht oder erst im Browser-Jitterbuffer

---

## Sub-Agent-ID

A/V-Sync-Analyse: `ade4add1ab19243d0` (via `SendMessage` für Vertiefungen erreichbar)
