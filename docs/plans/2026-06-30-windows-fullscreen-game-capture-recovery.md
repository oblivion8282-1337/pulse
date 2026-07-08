# Windows: Stream bricht ab, wenn ein Spiel in den exklusiven Vollbild geht — Umsetzungsplan

**Status: GEBAUT** (Commit `c5339c12`, 2026-07-07) — `resolve_window_or_monitor()` in
`streaming/win-hq-sidecar/src/capture/source.rs:75-103` macht den **präventiven**
window→monitor-Fallback bei Resolve-Zeit (FSE-Fenster erkannt an der Off-Screen-Position
`(-21333,-21333)`; `rects_overlap`-Helper). Aktiv in allen drei Encoder-Pfaden
(`wgc.rs`, `wgc_hw.rs`, `wgc_d3d12.rs`). **Abweichend vom untenstehenden Plan**, der auf
Runtime-Recovery setzt — gebaut wurde die einfachere, sicherere Präventiv-Variante, bei der
die `Closed`/`Disconnected`-Kaskade für FSE nie erst feuert (Runtime-`Disconnected` bleibt
bewusst tödlich). Dieser Doc steht als historische Plan-Notiz.

## Bug-Report (Auslöser)

Windows-User: „Wenn ich streamen möchte und eine .exe wie z. B. CS2 auswähle, dann bricht der
Stream ab, sobald ich in das Spiel reintabbe. Wenn ich per Fenster/Monitor streame, funktioniert
es ohne Probleme."

## Root Cause

Im Quellen-Picker (`web/src/lib/stream/components/MonitorPicker.svelte`) gibt es nur **zwei**
Quellarten: **Monitor** (`Monitor: <index>`) und **Fenster** (`window:<hwnd>`). Eine „.exe"
auszuwählen ist technisch eine **Fenster-Aufnahme** — die Kachel ist nur prominent mit dem
.exe-Namen (`w.app`) beschriftet. Es gibt keinen separaten Anwendungs-/Spiel-Capture-Modus.

Wir capturen über **Windows Graphics Capture (WGC)** (`windows-capture` v2). WGC-Fenster-Aufnahme
funktioniert nur, solange das Spiel ein vom Desktop-Compositor (DWM) **zusammengesetztes Fenster**
ist — also Fenstermodus oder **randloser** Vollbild. Geht das Spiel in **echten exklusiven
Vollbild** (CS2 „Fullscreen", passiert beim Reintabben), malt es am Fenstersystem vorbei direkt
auf den Monitor. Es gibt dann **kein zusammengesetztes Fenster mehr zum Abgreifen** → Windows
feuert das `Closed`-Event auf dem `GraphicsCaptureItem`.

Folge in unserem Code: Der Capture-Worker-Thread endet (das blockierende `*::start(settings)`
kehrt nach `Closed` zurück, `on_closed` ist ein No-op), der `SyncSender` droppt, und der
Frame-Kanal meldet `Disconnected`. **Alle drei Pipelines behandeln das als tödlichen Fehler**
und reißen den ganzen Stream ab:

- `src/pipeline_hw.rs:260-262` → `Err("hw capture channel disconnected")` (NVIDIA, D3D11-Zero-Copy)
- `src/stream_controller.rs:426-428` → `Err("capture channel disconnected")` (CPU-Pfad, Intel + ZC-Kill-Switch)
- `src/pipeline_d3d12.rs` → analoge `Disconnected`-Behandlung (AMD, D3D12VA)

`worker_finished(Some(err))` emittiert dann `state:error` → der Renderer reißt die Kachel ab.

**Monitor-Aufnahme** kennt kein `Closed` (der Bildschirm verschwindet nie) und sieht exklusiven
Vollbild → läuft sauber durch. Ein **normales Fenster** (Browser etc.) geht nie in exklusiven
Vollbild → läuft auch. Daher das beobachtete Muster. Es ist kein punktueller Bug, sondern eine
**grundsätzliche WGC-Grenze**, die wir bisher nicht abfedern. (Auf Linux gibt es das Problem
nicht: dort komponiert der Compositor immer, kein DXGI-exklusiv-Bypass.)

## Lösungsraum

Es gibt nur zwei eingriffsfreie Reaktionen auf ein Spiel im exklusiven Vollbild:

1. **Per-Prozess-Capture via Injection (OBS „Game Capture"):** DLL in den Spielprozess
   injizieren, `Present()` hooken, Backbuffer per Shared-Texture abgreifen. Nimmt ein einzelnes
   Spiel auch im exklusiven Vollbild auf. **Verworfen:** großes eigenes Projekt + **Anti-Cheat-
   Risiko** (CS2/VAC/FACEIT) — Sperrgefahr für unsere User. Nicht vertretbar.

2. **Monitor abgreifen**, auf dem das Spiel läuft — die einzige injection-freie Art, die Pixel
   eines exklusiv-vollbild Spiels zu sehen. Kein „die exe aufgeben", sondern „das ausgewählte
   Spiel weiter zeigen, nur über seinen Bildschirm, solange exklusiver Vollbild läuft".

Dazu der **einfachste** Hebel, ganz ohne Code: **randloser Vollbild** im Spiel → es bleibt ein
Fenster → Einzel-Aufnahme überlebt das Reintabben, Leistungsverlust auf modernen GPUs ~0.

## Gewählter Ansatz (kombiniert)

Der User wählt weiter **das Spiel** als Quelle. Verhalten:

- Fenster-/randloser Vollbild → wie bisher **nur das Spiel** (WGC-Fenster-Aufnahme).
- Exklusiver Vollbild → Stream **stirbt nicht mehr**: bei `Closed`/`Disconnected` den
  Encoder + die RTMP-Verbindung **am Leben halten** (das Letzte-Bild-Duplizieren pro Tick läuft
  ohnehin) und automatisch über den **Monitor des Spielfensters** weitercapturen; zurück auf
  Fenster-Aufnahme schalten, sobald das Fenster wieder greifbar ist.

So sieht der Zuschauer durchgehend das Spiel — egal welcher Modus — ganz ohne Injection.

### Sofort-Workaround (gilt heute schon, ohne Code)

Dem Tester direkt sagen:
1. CS2 auf **„Fullscreen Windowed" / randloser Vollbild** stellen (statt „Fullscreen"), **oder**
2. den **Bildschirm** statt das Spielfenster als Quelle wählen.

## Implementierungs-Skizze (morgen)

Der Knackpunkt ist die **Wiederbeschaffung** des Capture-Targets, ohne den Encoder neu aufzusetzen
und ohne den dokumentierten Teardown-UAF (siehe die langen `mem::forget`-Kommentare in
`pipeline_hw.rs` / `pipeline_d3d12.rs`) zu triggern.

1. **HWND → Monitor auflösen:** beim Start einer `WindowByHwnd`/`WindowByTitle`-Aufnahme den
   zugehörigen Monitor merken (`MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)` → Index für
   `Monitor::from_*`), damit das Auffangnetz weiß, welchen Bildschirm es nehmen soll.
2. **`Disconnected` ist nicht mehr fatal:** In allen drei Capture-Drain-Loops bei `Disconnected`
   **nicht** `return Err(...)`, sondern in einen „Recovery"-Zustand gehen — letzten Frame
   weiter duplizieren, Stream bleibt `live`. (Sauber vom echten Stop-Pfad trennen: ein
   stop-signal-getriebenes Ende bleibt normal.)
3. **Re-Acquire mit Backoff:** Hintergrund/periodisch versuchen, (a) das Fenster neu zu greifen
   (`is_valid()`), sonst (b) die Monitor-Aufnahme dieses Bildschirms starten. Auflösungswechsel
   Fenster↔Monitor behandeln — der einfachste robuste Weg ist, den **GPU-Scaler/Encoder-Pfad auf
   eine feste Ziel-Auflösung** zu fixieren (Encoder läuft auf konstanter dst-Größe; die Quelle
   wird darauf skaliert), damit ein Quellwechsel den Encoder **nicht** neu aufsetzen muss.
   - NVIDIA: `D3D11Scaler` existiert bereits (`pipeline_hw.rs`) — er kann den Größenunterschied
     auffangen, wenn der Encoder fix auf dst-Größe steht.
   - CPU/AMD-Pfade analog (swscale bzw. D3D12-Compute-Convert auf feste dst-Größe).
   - Achtung: der HW-`HwContext`/Pool hängt am D3D11-Device + den Dimensionen des **ersten**
     Capture-Frames. Ein Quellwechsel mit neuer Auflösung erzwingt sonst Pool-Neuaufbau — genau
     hier liegt das Risiko. Optionen: (i) Encoder fix auf dst, Quelle immer in den Pool skalieren;
     (ii) bei zu großem Umbau den Stream im exklusiv-Vollbild bewusst auf reine Monitor-Aufnahme
     halten und erst nach dem Stream-Neustart wieder Fenster bevorzugen.
4. **Resize-Robustheit** (verwandt mit dem „Game-Fullscreen-Toggle"-Punkt aus der alten Win-HQ-Sidecar-Code-Review):
   Frames mit abweichenden Dimensionen nicht still verwerfen (CPU-Pfad `if (f.width,f.height)==expected`)
   bzw. nicht in einen falsch dimensionierten Pool kopieren (HW-Pfad) — das gehört zum selben
   Fullscreen-Übergang und sollte mit abgedeckt werden.
5. **UI-Hinweis** (kleiner, risikoarmer Teilschritt, auch einzeln sinnvoll): in der Fenster-Gruppe
   des `MonitorPicker.svelte` ein dezenter Hinweis „Für Vollbild-Spiele randlosen Vollbild wählen
   oder den Bildschirm aufnehmen" + die generische Abbruch-Fehlermeldung
   („capture channel disconnected") durch eine verständliche ersetzen.

## Betroffene Dateien

- `streaming/win-hq-sidecar/src/capture/source.rs` (HWND→Monitor-Auflösung)
- `streaming/win-hq-sidecar/src/capture/{wgc.rs,wgc_hw.rs,wgc_d3d12.rs}` (Recovery-/Re-Acquire-Hooks)
- `streaming/win-hq-sidecar/src/{stream_controller.rs,pipeline_hw.rs,pipeline_d3d12.rs}` (Disconnected nicht fatal)
- `web/src/lib/stream/components/MonitorPicker.svelte` (UI-Hinweis — user-facing → Changelog-Eintrag!)

## Test (zwingend auf Windows)

- CS2 in „Fullscreen" (exklusiv): Stream starten, raus- und **reintabben** → Stream darf nicht
  abbrechen, Zuschauer sieht durchgehend das Spiel.
- CS2 in „Fullscreen Windowed": Reintabben → weiter reine Einzel-Aufnahme (kein Monitor-Fallback nötig).
- Normales Fenster + Monitor: unverändert grün.
- Pro Vendor-Pfad einmal (NVIDIA / AMD / Intel), da alle drei Pipelines angefasst werden.
