# Code-Reduction-Analyse Win-HQ-Sidecar — 2026-05-25

**Status:** Momentaufnahme, untracked. Komplement zu `CODE_REVIEW_2026-05-25.md`.
**Methode:** 1 Sonnet-Agent + Vorab-Inspektion durch mich.
**Code-Stand:** `origin/main` inkl. `81a02e4` (AMD D3D12VA Zero-Copy).
**Gesamtumfang:** 6920 LoC Rust in `src/` (41 Files).

---

## Kernaussage

**6920 LoC sind für den Funktionsumfang angemessen.** Cross-Plattform-Video-Streaming mit 3 Hardware-Pfaden (CPU/NVIDIA/AMD), WGC-Capture, WASAPI-Audio (Loopback + Mic + App-spezifisch), libopus, FLV-Mux, RTMPS-Push und stdio-JSON-RPC-Protokoll ist intrinsisch viel Code. Vergleich: GSR selbst hat zigtausende C-LoC für vergleichbare Funktionalität; der Linux-`control.py`-Sidecar löst ein deutlich kleineres Problem (kein eigener Encoder — nur Wrapper um `gpu-screen-recorder`-Binary).

**Realistisches Einsparpotenzial: ~140-165 LoC (~2-2,4%).**

---

## Was sich lohnt (niedriges Risiko, ~3h Aufwand)

| Finding | Wo | LoC | Risiko | Aufwand |
|---|---|---|---|---|
| `ServerProfile::from_channel` + `parse_endpoint` toter Code | `profiles.rs:39-98` (mit `#[allow(dead_code)]` markiert) | 60 | null | 5 min |
| `run_capture`-Boilerplate dreifach → generischer Helper | `wgc.rs:220-270`, `wgc_hw.rs:238-285`, `wgc_d3d12.rs:388-434` | 45 | niedrig | 2h |
| Audio-Setup-Helper | `stream_controller.rs:301-312`, `pipeline_hw.rs:113-122`, `pipeline_d3d12.rs:93-103` | 20 | niedrig | 30 min |
| Codec-Decode-Helper (`VideoCodec::from_str`) | `stream_controller.rs:287`, `pipeline_hw.rs:42`, `pipeline_d3d12.rs:44` | 15 | niedrig | 20 min |

---

## Was sich nicht lohnt

### Pacing-Loop-Vereinheitlichung (~25 LoC, 3h, mittleres Risiko)
Die drei Loops unterscheiden sich im Frame-Handling fundamental: CPU-`CapturedFrame` vs `OwnedHwFrame` vs Ring-Slot-Tausch. Generische Abstraktion via Trait-Objects/Generics über Frame-Typen kostet mehr Code als sie spart. PTS-Logik ist subtil — Refactor-Risiko hoch.

### Encoder-Klassen vereinheitlichen
Keine echte Duplizierung. `create()` macht in jedem Pfad fundamental unterschiedlichen Setup (`hw_frames_ctx`-Attachment, D3D12-`activate()`-Mechanismus, Output-Context-Setup). Gemeinsamer Code ist bereits sauber als `pub(crate) fn url_format_hint` + `vendor_encoder_opts` in `encode/encoder.rs` faktoriert.

### Hand-gerollte FFI-Structs
`AVD3D11VA*` und `AVD3D12VA*`-Spiegel (~65 LoC) in `encode/hwctx.rs` + `encode/encoder_d3d12.rs` sind nicht eliminierbar — `ffmpeg-sys-next` bindet diese hwcontext-Header explizit nicht. Würde nur mit Dep-Wechsel verschwinden (Upgrade auf 8.2+ oder Fork mit D3D12VA-Bindings) — außerhalb Scope.

---

## Was den Code groß wirken lässt, aber sein muss

| Datei | LoC | Warum nicht reduzierbar |
|---|---|---|
| `encode/d3d12_convert.rs` | 442 | Compute-Shader BGRA→NV12 mit D3D12-Descriptors, Root-Signature, Pipeline-State, eingebettete HLSL-Shader-Bytes — intrinsisch dieser Länge |
| `encode/hwctx.rs` | 283 | CRITICAL_SECTION-Lock-Registrierung an FFmpegs D3D11VA-hwcontext; Vereinfachung riskiert Use-after-free |
| `encode/d3d11_scale.rs` | 276 | `ID3D11VideoProcessor` mit mehrfachem QueryInterface auf verschiedene COM-Interfaces — Win32-Video-API ist so verbose |
| `tick_monitor.rs` | 250 | Klar abgegrenzte Diagnose-Schicht, keine Duplizierung |
| `encoder_d3d12.rs` | 511 | Vendor-spezifische FFI + Pool-Setup + Extradata-Sonderfall — alles unvermeidbar |
| `stream_controller.rs` | 553 | State-Machine + Worker-Lifecycle + 3 Snapshot-Felder + Joiner-Hilfsthread + redacted-argv-Builder |

---

## Examples-Verzeichnis (zählt NICHT zu den 6920 src/-LoC)

Außerhalb von `src/`, aber 800+ LoC unbenutzter Diagnose-Probes:

| Datei | LoC | Status |
|---|---|---|
| `examples/probe_d3d11.rs` | 237 | Nicht in `Cargo.toml` deklariert — AMD-Schwarzbild-Fix-Groundtruth, längst im Produktivcode |
| `examples/probe_d3d12_amf.rs` | 402 | Nicht in `Cargo.toml` deklariert — D3D12-Pfad-Analyse, ist jetzt implementiert |
| `examples/probe_vulkan_sps.rs` | 451 | Einmal-Diagnose, Erkenntnisse in den D3D12VA-Encoder geflossen |
| `examples/probe_d3d12_zerocopy.rs` | 393 | Cross-API-Bridge-Validation, ist jetzt im Produktivpfad |

**Wenn alle vier weg: 1483 LoC im Repo gespart** (aber im `src/`-Count nichts).

---

## Gesamt-Schätzung

| Szenario | Einsparung (src/) | % | Aufwand |
|---|---|---|---|
| Nur toter Code löschen (`ServerProfile`) | 60 | 0,9% | 5 min |
| + Capture-Helper | 105 | 1,5% | 2h |
| + Audio/Codec-Helper | 140 | 2,0% | ~3h |
| + Pacing-Loop-Partials | 165 | 2,4% | ~6h |
| Theoretischer Floor (alle Findings) | 165 | 2,4% | ~6h |

---

## Empfehlungs-Priorisierung

1. **Quick-Win (10 min, 60 LoC + 1500 LoC im Examples-Verzeichnis):**
   - `ServerProfile` löschen
   - Vier obsolete Examples aus `examples/` löschen oder nach `tools/` verschieben

2. **Sauberer Refactor (2h, 45 LoC):**
   - `run_capture`-Boilerplate in einen generischen Helper in `capture/mod.rs` faktorieren (Generics über `GraphicsCaptureApiHandler::Flags`). Neue Capture-Pfade würden auch profitieren.

3. **Optional (50 min, 35 LoC):**
   - Audio-Setup-Helper + `VideoCodec::from_str` — kleine Verbesserung, aber dreifach-Duplizierung sticht im Diff klar ins Auge.

**Nicht angehen:** Pacing-Loop, Encoder-Klassen-Vereinheitlichung, FFI-Structs.

---

## Sub-Agent-ID

Reduction-Analyse: `add4afbf8159bd3f5` (via `SendMessage` für Vertiefungen erreichbar)
