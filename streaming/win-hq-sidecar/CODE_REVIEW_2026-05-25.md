# Code-Review Win-HQ-Sidecar — 2026-05-25

**Status:** Momentaufnahme, untracked. Nicht committet (parallele Session auf anderem Branch).
**Methode:** 3 parallele Sonnet-Agents auf je ein Modul-Cluster (Encode / Capture+Audio / Control-Plane), ~6900 LoC Rust. Top-Findings stichprobenartig gegen den Code verifiziert. Restliche Findings sind statische Analyse — bevor Fixes gemacht werden, am Code + idealerweise mit D3D12-Debug-Layer-Run gegenprüfen.
**Branch zum Zeitpunkt:** `fix/dm-friend-cache-race` (parallele Session), HEAD `4cf3086`.
**Reviewter Code-Stand:** `origin/main` inkl. `0ffb725` (CLAUDE.md-Slim), `8ca08d9` (A/V-Sync-Anker), `81a02e4` (AMD D3D12VA Zero-Copy).

---

## CRITICAL

### 1. D3D11↔D3D12 Cross-API-Sync via KeyedMutex auf D3D12-Seite komplett bypassed
**Datei:** `encode/d3d12_convert.rs` (kein Acquire/Release) · `capture/wgc_d3d12.rs:339,353` (Capture macht's korrekt)

Ring-Buffer-Texturen sind mit `D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX` erstellt. Capture-Thread (D3D11) ruft `AcquireSync(0,…)/ReleaseSync(0)` korrekt — der **D3D12-Compute-Shader liest die BGRA-Texture ohne das Mutex je zu acquiren**. Laut DXGI-Spec ist das undefiniertes Verhalten, auch wenn die `convert()`-Fence im Timing aktuell rettet. Konsequenzen je nach Treiber: stille Frame-Korruption (Glitches), seltene TDRs, D3D12-Debug-Layer-Errors. **Beide Reviewer fanden das unabhängig.** Verifiziert per grep: KeyedMutex-Imports + AcquireSync nur in `wgc_d3d12.rs`, nicht in `d3d12_convert.rs`.

### 2. Stop während `starting`: doppelte/falsche Events, Race mit `events::shutdown()`
**Datei:** `stream_controller.rs:151-210` + `main.rs:93-106` + `dispatch.rs:50`

Wenn `stop` reinkommt während der Worker noch im `recv_timeout(5s)`-Capture-Setup hängt: Joiner setzt `state=stopped` nach Timeout, Worker erroret danach mit "never got first capture frame", `worker_finished` emittiert `error`+zweites `stopped`. Electron sieht `stopped→error→stopped` nach normalem Stop. Im EOF-Pfad (Stdin schließt) noch schlimmer: `events::shutdown()` läuft *vor* dem zweiten `stop()`, danach gehen alle Worker-Events ins Leere (kein `stopped`-Event → Electrons 15s-Timeout läuft nutzlos durch).

---

## HIGH

### 3. NT-Handle-Leak im Error-Path vor `mem::forget`
**Datei:** `capture/wgc_d3d12.rs:325` (CreateSharedHandle) — kein `CloseHandle` für Ring-Slot-Handles

Im normalen Stream-Betrieb egal (`mem::forget` und Prozess-Exit räumen das auf). Bei jedem **Encoder-Setup-Fehler vor `mem::forget`** leaken 4 NT-Handles dauerhaft im Prozess. Nach genug fehlgeschlagenen Starts: Handle-Erschöpfung. Verifiziert per grep: nur `fence_event` wird in Drop (`:382`) geschlossen, die Ring-Slot-Handles aus `:325` nirgends.

### 4. WASAPI-Worker-Deadlock bei vollem Channel
**Datei:** `audio/wasapi.rs:198` (`tx.send`) vs. `:182` (`stop_rx.try_recv` am Loop-Start)

`sync_channel(8)` voll + Encoder hängt (RTMP-Stall) → `tx.send` blockiert → `stop_rx`-Check wird nie wieder erreicht → `AudioCapture::stop().join()` hängt unbegrenzt. Konkret bedeutet das: Stop nach Netzwerkproblem friert den Sidecar ein bis externes Kill (passt zum behobenen Bug 9c0a693 — der Audio-Pfad hat denselben Race noch).

### 5. Nonce im redacted argv leakt
**Datei:** `stream_controller.rs:511-537` (`build_argv_redacted` / `redact_token`)

`redact_token` ersetzt nur `pass=`/`token=`/`streamid=publish:`-Präfixe. Eine RTMPS-URL `rtmps://host:1936/channel-123-456-deadbeef` (Nonce im Pfad-Segment) geht **un-redacted** an Electron zurück. Nonce ≠ Token, aber Pulse-Pattern erlaubt theoretisch Pfad-Rekonstruktion. Doku verspricht „Token nicht im Klartext" — wird nur halb eingehalten.

### 6. Encoder-`finish()`-Error verhindert `mem::forget` → Teardown-Crash-Pfad
**Datei:** `pipeline_hw.rs:300-321` (im Gegensatz zu `pipeline_d3d12.rs:254-264`, dort korrekt)

Wenn `encoder.finish()` mit `?` propagiert (Socket-Fehler beim Trailer-Schreiben), werden die nachfolgenden `mem::forget`-Calls *nicht* erreicht → GPU-Objekte normal gedroppt → reproduzierter Teardown-Crash. AMD-Pfad reicht den `finish_result` korrekt erst nach den `mem::forget` durch; NVIDIA-Pfad nicht.

### 7. WGC-Resize verliert einen Ring-Slot dauerhaft
**Datei:** `capture/wgc_d3d12.rs:224-226`

Bei Dimensions-Mismatch wird `Ok(())` zurückgegeben, der bereits via `free_rx.try_recv()` geholte Slot nie zurückgesendet. RING_SIZE=4 — nach 4 Resize-Events (Monitor-Scaling, Game-Fullscreen-Toggle) sind alle Slots weg, alle weiteren Frames werden verworfen.

---

## MEDIUM

- **`fps=0` Panic** in `stream_controller.rs:350` (`Duration::from_secs_f64(1.0/0.0)` = INFINITY → Panic). `TickMonitor` macht `.max(1)`, der Pacing-Loop nicht. Validation fehlt in `ops/start.rs`.
- **Silence-Burst nach Encoder-Stall** (`audio/wasapi.rs:210`): Wall-Clock läuft weiter während Queue blockiert; wenn Backpressure nachlässt, kommen alle aufgestauten Silence-Chunks in einem Burst → A/V-Desync nach jedem Stall.
- **State-Maschine-Inkonsistenz nach Error** (`stream_controller.rs:203-210`): emittiert immer `state:stopped`-Event, auch wenn Snapshot auf `"error"` steht → Electron-Event-Stream und `state`-Op-Poll widersprechen sich.
- **`build_argv` vs `start`** akzeptieren unterschiedliche Pflicht-Felder (`push_url` Pflicht in `start`, optional in `build_argv`) — irreführend.
- **HwContext-Cleanup im Init-Fehler-Pfad** (`encode/hwctx.rs:146-153`): wenn `av_hwdevice_ctx_init` fehlschlägt, ist unklar ob FFmpeg die per `into_raw()` an es abgegebenen COM-Refs wieder freigibt. Müsste gegen `libavutil/hwcontext_d3d11va.c:d3d11va_device_free` (FFmpeg 8.1) verifiziert werden.
- **Descriptor-Heap-Overwrite** (`encode/d3d12_convert.rs:161-196`): Single-Threaded-Modell rettet aktuell, aber das Muster (CPU schreibt Descriptor während GPU evtl. noch liest) ist fragil — wenn die Fence-Reihenfolge je geändert wird, kaputt.

---

## LOW

- `transmute_copy` auf `windows-rs`-COM-Wrapper in `encode/d3d12_convert.rs:432` — fragil, layoutabhängig. `as_raw()` wäre der saubere Weg.
- HEVC VPS-Trailing-Zero Off-by-one in `encode/extradata.rs:67-69` — sehr selten, weil RBSP-Trailing-Bits auf 0x00 enden selten ist; H.264 nicht betroffen.
- `amd_adapter_index()` in `encode/encoder_d3d12.rs:493-511` pickt erste AMD-GPU, nicht zwingend die Capture-GPU — nur relevant bei AMD-iGPU+AMD-dGPU (selten).
- `audio/wasapi.rs:202` `VecDeque::drain` ist O(n), nicht O(1) — Performance, nicht Korrektheit.
- Parse-Error → `id:null` Response, kein matching pending Request — protokoll-konform, aber stumm verworfen.
- `frames_ref` in `encode/encoder_d3d12.rs:139-141` bewusst geleakt (Wartbarkeitsfalle, kein Bug).
- `KeyedMutex::AcquireSync(0, INFINITE)` in `capture/wgc_d3d12.rs:339` ohne Timeout — fragil falls je ein `?` zwischen Acquire und Release eingeführt wird (würde ewig deadlocken). Aktuell kein direkter Bug.
- `TickMonitor` `BufWriter::drop` schluckt Flush-Error — letzter Trace-Teilpuffer kann bei ExitProcess verloren gehen. In der Praxis läuft normaler Rust-Teardown.

---

## Empfehlung-Priorisierung

1. **#1 (KeyedMutex auf D3D12-Seite)** — silent corruption + treiber-spezifische TDRs sind die schmerzhaftesten Bugs, weil nicht reproduzierbar. Ganz oben.
2. **#3+#4 (Handle-Leaks + WASAPI-Deadlock)** — klare Repro-Pfade.
3. **#2+#6 (State-Maschine + Teardown-Crash NVIDIA-Pfad)** — UX-Bug bei Stop + bekannte Crash-Klasse.
4. Rest in eigener Iteration.

## Sub-Agent-IDs (für Nachfragen)

- Encode-Pfade: `a9e83d3a012e05e67`
- Capture+Audio: `ad623faab98334025`
- Control-Plane: `a1581c58c1d302112`
