# Code-Review Win-HQ-Sidecar — Runde 2 (2026-05-26)

**Status:** Momentaufnahme, untracked. Ergänzung zu `CODE_REVIEW_2026-05-25.md`.
**Methode:** 3 parallele Sonnet-Agents mit **orthogonalen Cuts** (Concurrency/Threading, FFmpeg-Glue, Windows-Spezifika) + Negativliste aller bekannten Findings aus Runde 1, damit keine Duplikate.
**Code-Stand:** unverändert seit Runde 1 (`origin/main`, kein neuer Commit im `win-hq-sidecar/`).

---

## NEU CRITICAL/HIGH

### N1. `receive_packet().is_err()` verschluckt echte Encoder-Errors als sauberes Drain-Ende
**Dateien:** `encode/encoder.rs:390`, `encode/encoder_hw.rs:229`, `encode/encoder_d3d12.rs:319`, `encode/audio.rs:217` — alle vier Drain-Loops betroffen.

`ffmpeg-next` mappt `AVERROR(EAGAIN)`, `AVERROR_EOF` UND echte Encoder-Fehler (NVENC-Ressourcen-Erschöpfung, AMF-Internal-Error, allgemeine Codec-Failures) alle auf `Err`-Varianten. Der einheitliche `is_err() → break`-Pattern kann sie nicht unterscheiden.

**Folge:** ein NVENC/AMF-Fehler mitten im Stream sieht für den Caller wie sauberes Stream-Ende aus — kein Log, kein Error-Event an Electron, kein Stop-Trigger. Klasse Bug, die User-Reports „der Stream ist plötzlich weg, kein Fehler" erzeugt. **Schmerzhafteste Bug-Klasse weil nicht debuggbar.**

**Fix-Hinweis:** auf `ffmpeg::Error::Other { errno }` matchen, nur `EAGAIN` und `EOF` (= `ffmpeg::Error::Eof`) als Break behandeln, alles andere als `Err` propagieren.

### N2. `stop()` lässt wedged Worker laufen, sofortiges `start()` spawnt zweiten Worker parallel
**Datei:** `stream_controller.rs:186-190`

Nach Stop-Timeout wird `inner.snapshot.running = false` + `state = "stopped"` gesetzt — unabhängig davon ob der Worker innerhalb des Timeouts beendet hat oder noch läuft. Ein unmittelbar folgendes `start()` sieht `running = false`, schlägt also nicht fehl und spawnt einen zweiten Worker-Thread neben dem noch laufenden ersten. Beide schreiben konkurrierend auf `StreamController::singleton()`.

In der aktuellen Electron-UI wird nach Stop immer der Prozess beendet — trifft also momentan nicht. Wenn jemals Stop+Start ohne Prozess-Reset auftritt (z.B. zukünftige Quality-Switch-UI), ist's ein Race.

### N3. `MuxWriter` hat kein `impl Drop` — JoinHandle wird detached, RTMP-Trailer kann fehlen
**Datei:** `encode/mux_writer.rs:43-46`

Wird `MuxWriter` ohne vorheriges `finish()` gedroppt (z.B. via `?`-Fehler im Encoder zwischen `send_eof` und `mux.finish()`), wird das `JoinHandle<Result<()>>` des Writer-Threads still verworfen → Thread wird detached. `write_trailer` läuft zwar noch in dem Thread, aber niemand wartet auf sein Ende.

**Folge:** wenn der Sidecar danach sofort exitiert, fehlt der FLV-Trailer am RTMP-Server. MediaMTX sieht keinen sauberen Stream-End, Last-Segment-State undefined.

### N4. `WaitForSingleObject(fence_event, INFINITE)` ohne Return-Value-Check
**Dateien:** `capture/wgc_d3d12.rs:366`, `encode/d3d12_convert.rs:252`

`WAIT_FAILED` (0xFFFFFFFF) tritt bei ungültigem Handle oder nach TDR (Treiber-Reset) auf. Der Code läuft danach weiter als ob die GPU fertig wäre. In `wgc_d3d12.rs` liest der D3D12-Converter danach eine BGRA-Textur, die möglicherweise noch beschrieben wird → klassische Race-Quelle bei Treiber-Reset.

---

## NEU MEDIUM

### N5. D3D12-Encoder `activate()` nimmt erstes Packet als Keyframe an
**Datei:** `encode/encoder_d3d12.rs:323-325 + 340-389`

`drain_and_mux` triggert `activate(&packet)` beim ersten Non-EAGAIN-Packet ohne `AV_PKT_FLAG_KEY`-Check. `param_set_extradata` sucht SPS/PPS und schlägt fehl wenn das erste Packet kein Keyframe ist. Bei `max_b_frames=0` (aktuelle Config) unwahrscheinlich, aber laut D3D12 Video Encode API nicht garantiert — fragiles Pattern.

**Fix-Hinweis:** `AV_PKT_FLAG_KEY`-Bit prüfen (`unsafe { (*packet.as_ptr()).flags & AV_PKT_FLAG_KEY != 0 }`), Non-Keyframes vor Aktivierung verwerfen oder puffern.

### N6. `open_with(dict)` verschluckt nicht-konsumierte Encoder-Optionen still
**Dateien:** alle vier `encode/encoder*.rs` + `encode/audio.rs`

`avcodec_open2` schreibt nicht erkannte Keys zurück in den Dict, `ffmpeg-next::open_with` droppt diesen Rest kommentarlos (siehe `codec/encoder/video.rs:49`). Ein Tippfehler in einer Encoder-Option (`"zerolatency"` statt korrekt benannter NVENC-Opt, `"look_ahead"` statt `"lookahead_depth"` bei QSV) wird silent ignoriert, Encoder öffnet mit Default-Latenz.

**Misconfiguration ohne Warnung** — passt zur N1-Klasse, nur weniger schmerzhaft.

### N7. Kein D3D-Feature-Level-Check vor Pipeline-Run
**Dateien:** `encode/hwctx.rs`, `encode/d3d11_scale.rs`, `capture/wgc_d3d12.rs`

WGC stellt das `ID3D11Device` bereit, dessen Feature-Level ist unbekannt. `ID3D11DeviceContext4` ist FL11_1+ (Win10 Anniversary), `ID3D11VideoDevice` FL9_1+. Auf älteren Treibern crasht der `cast::<ID3D11Device5>()` / `cast::<ID3D11DeviceContext4>()` mit `E_NOINTERFACE` — propagiert wird's, aber kryptisch. `health`-Op meldet trotzdem `available: true`.

### N8. COM-Apartment-Init fehlt im WGC-Capture-Thread (von beiden Cuts unabhängig gefunden)
**Dateien:** `capture/wgc.rs:94`, `capture/wgc_hw.rs:74`, `capture/wgc_d3d12.rs`

WASAPI macht's korrekt (`audio/wasapi.rs:127` via `initialize_mta()`), `system/audio_sessions.rs:44` macht's mit `ComGuard`-RAII + S_FALSE-Handling. **WGC-Module verlassen sich auf `windows-capture`-interne COM-Init**, ohne dokumentierte Garantie für das gewählte Apartment-Modell.

Wenn `windows-capture` intern STA initialisiert (typisch für WinRT) und der Code danach D3D11/D3D12-Calls auf demselben Thread macht (in MTA-Erwartung), gibt's Apartment-Mismatch. **Unsicher — müsste mit `windows-capture`-Internals verifiziert werden, beide Agents waren unsicher.**

---

## NEU LOW

- **Root-Signature `D3D_ROOT_SIGNATURE_VERSION_1`** in `encode/d3d12_convert.rs:411` statt 1.1 — Performance (volatile Descriptor-Behandlung), nicht Korrektheit
- **Per-Frame `Vec::new()` + `.to_vec()`** in `capture/wgc.rs:183-184` CPU-Pfad → bei 60fps@1080p 120 Allocs/s à ~8MB. Könnte gepoolt werden (persistentes `scratch`-Feld in `FrameSink`)
- **`software-resampling`-Feature** in `Cargo.toml:61` aktiviert obwohl `audio.rs:5-6` explizit „Kein Resampler nötig" sagt → `swresample.dll` ohne Laufzeit-Nutzen im Deployment
- **`health`-Op meldet kein Windows-Build-Minimum** (`ops/health.rs`) — Win10 1507-LTSC würde `available: true` kriegen aber beim ersten Frame-Callback crashen
- **Stream-Joiner-Thread-JoinHandle** in `stream_controller.rs:171` mit `let _ = ...` verworfen — Panic im Worker würde silent geschluckt
- **NT-Handle-Leak in `Bridge::handle_values`** (`wgc_d3d12.rs:317-329`) bei partial-failure: erste Slot-Creates gelingen, ein späterer schlägt fehl → die geöffneten Handles werden nicht via `CloseHandle` geschlossen. Variante des bekannten #3-Bugs, aber spezifisch für den partial-Path.

---

## Konfidenz-Einschätzung

**Solide neue Bugs mit klaren Repro-Pfaden:** N1, N2, N3, N4
**N1 ist der wichtigste** — silent Encoder Failures sind die am schlechtesten debuggbare Bug-Klasse, und sie passt zu generischen User-Berichten („Stream weg, kein Fehler im Log").
**N8 hat zwei unabhängige Reviewer aber beide unsicher** → braucht Windows-Verifikation gegen `windows-capture`-Internals, evtl. mit D3D12-Debug-Layer-Output.

---

## Empfehlungs-Priorisierung (in Verbindung mit Runde 1)

| Priorität | Finding | Quelle |
|---|---|---|
| 1 | **N1** receive_packet schluckt Encoder-Errors | Runde 2 |
| 2 | **#1** KeyedMutex auf D3D12 fehlt | Runde 1 |
| 3 | **N4** WaitForSingleObject Return ignoriert | Runde 2 |
| 4 | **#3** NT-Handle-Leak in wgc_d3d12 | Runde 1 |
| 5 | **#4** WASAPI Stop-Deadlock | Runde 1 |
| 6 | **N3** MuxWriter detached | Runde 2 |
| 7 | **#2** Stop-during-starting Race | Runde 1 |
| 8 | **#6** Encoder finish() verhindert mem::forget | Runde 1 |
| 9 | **N5** activate() Keyframe-Annahme | Runde 2 |
| 10 | **N6** open_with verschluckt Opts | Runde 2 |
| 11 | **N7** Feature-Level-Check fehlt | Runde 2 |
| 12 | **N8** COM-Apartment WGC (verifizieren!) | Runde 2 |
| Rest | Runde-1- und Runde-2-MEDIUM/LOW | beide |

---

## Sub-Agent-IDs

- Concurrency/Threading: `af4deddda2e91c423`
- FFmpeg-Glue: `a1be5524326e62612`
- Windows-Spezifika: `ab0cd410f21cbd456`

(via `SendMessage` für Vertiefungen erreichbar)
