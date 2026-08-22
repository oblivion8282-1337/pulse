/**
 * Typed bridge to the GSR sidecar.
 *
 * Since E1b the sidecar is a Python child process owned by the Electron main
 * process (`desktop/electron/sidecar.ts`); the renderer talks to it through the
 * `window.pulse.gsr.*` API the preload exposes (each method is an
 * `ipcRenderer.invoke('gsr:call', op, params)` under the hood, events arrive on
 * `gsr:event`). Before E1b this wrapped the Tauri `gsr_*` commands +
 * `gsr://event` — the exported API here is unchanged; only the transport moved.
 *
 * In a plain browser (`!gsr.available()`) every method returns `null`/`false`
 * and never throws — the streaming UI is hidden in that case anyway, but it's
 * useful that the module is import-safe everywhere.
 *
 * Wire protocol: see `streaming/README.md`. We surface the raw JSON the
 * sidecar returns; the only typing we do here is on the *shape* of the
 * response, not on every nested field — that lets the sidecar evolve without
 * forcing a frontend update for every new health field.
 */

import { isElectron } from '$lib/platform/runtime';

// ── Response types ──────────────────────────────────────────────────────────

/** `{"ok":true, gsr: {...}}` from `gsr_health`. */
export interface GsrHealth {
  ok: boolean;
  gsr: {
    available: boolean;
    source: string;
    is_flatpak: boolean;
    path?: string;
    version?: string;
    vendor?: string;
    display_server?: string;
    video_codecs?: string[];
    capture_options?: string[];
    has_flv_patch?: boolean;
    /** Kann diese Karte 10 bit je Farbkanal encodieren? Der Linux-Sidecar
     *  meldet das Feld (NVENC/VAAPI + AV1), seit 2026-08-04 auch der
     *  Windows-Sidecar (AMF + AV1); Python und macOS lassen es weg →
     *  `undefined` heißt "nein", nie "unbekannt, probier's mal". */
    ten_bit?: boolean;
    /** Kann dieser Rechner HDR senden — also die Bildschirmaufnahme im vollen
     *  Helligkeitsumfang holen und als PQ/BT.2020 encodieren?
     *
     *  Belegt ist das heute für AV1 über AMF (AMD, Windows, 2026-08-06) und
     *  AV1 über NVENC (NVIDIA, Windows, 2026-08-11) — Tabelle je Encoder in
     *  `encode/hdr.rs` im Windows-Sidecar. *(Hier stand bis zum 2026-08-11
     *  „allein AV1 über AMF; NVIDIA ist ungemessen" — eingelöst.)*
     *
     *  **Nicht** die Frage, ob HDR in Windows gerade eingeschaltet ist — das
     *  entscheidet erst der Start, und zwar mit einer Meldung, die auf den
     *  Windows-Schalter zeigt. Fehlt das Feld, heißt das "nein". */
    hdr?: boolean;
    /** Kann dieser Sidecar Eingaben einspielen, ist dieser Rechner also
     *  fernsteuerbar? Heute meldet das **nur der Windows-Sidecar** — er ist der
     *  einzige mit einem `remote_input`-Modul.
     *
     *  Der Wert reist von hier über den Stream-Token bis in die WHEP-Antwort
     *  beim Zuschauer und entscheidet dort, ob der Knopf „Fernsteuerung
     *  anfragen" überhaupt erscheint. Fehlt das Feld, heißt das „nein" —
     *  fail-closed, denn ein angebotener Knopf, der beim Gegenüber nichts
     *  bewirken kann, holt sich erst eine Zustimmung und scheitert dann. */
    remote_input?: boolean;
  };
}

export interface GsrGpuInfo {
  ok: boolean;
  vendor?: string;
  card_path?: string;
  display_server?: string;
  video_codecs?: string[];
  error?: string;
}

export interface GsrListApplicationAudio {
  ok: boolean;
  applications?: string[];
  error?: string;
}

/** One display monitor, as reported by the Windows sidecar's `list_monitors`.
 *  `index` is 1-based and round-trips as the `"Monitor: <index>"` capture
 *  source the sidecar resolves via `Monitor::from_index`. */
export interface GsrMonitor {
  index: number;
  name: string;
  primary: boolean;
  width: number;
  height: number;
  refresh_hz: number;
}
export interface GsrListMonitors {
  ok: boolean;
  monitors?: GsrMonitor[];
  error?: string;
}

export interface GsrWindow {
  /** Opaque per-window id — macOS CoreGraphics window id, Windows HWND. Both
   *  round-trip as the `capture: "window:<id>"` token (resolved by the
   *  platform sidecar). */
  id: number;
  title: string;
  app: string;
  /** Human-readable application name from the executable's version resource
   *  (Windows `FileDescription` — what Task Manager shows). Absent when the
   *  binary has no version block (common for games) or on other platforms;
   *  `windowName.ts` falls back to a prettified `app`. */
  app_display?: string;
  width: number;
  height: number;
}
export interface GsrListWindows {
  ok: boolean;
  windows?: GsrWindow[];
  error?: string;
}

export interface GsrBuildArgv {
  ok: boolean;
  binary?: string;
  argv?: string[];
  error?: string;
}

export interface GsrStartArgs {
  profile: string;
  /** Pulse-channel pathway: server profile built via `ServerProfile.from_channel`.
   *  This is the only pathway — Pulse always streams into a voice channel. */
  channel: {
    id: string;
    token: string;
    /** Full push URL from media-svc — handed to GSR's `-o` verbatim. */
    push_url?: string;
  };
  capture: string;
  audio: { mode: string; excluded_apps?: string[] };
  /** Spiegelt `OverrideSet` aus `stream/settings.svelte.ts` — `bit_depth` fehlte
   *  hier, waehrend die Start-Parameter es laengst fuellten. Der Typ log also,
   *  ohne dass der Compiler es merkte (`cleaned` ist eine Variable, kein
   *  Objektliteral → keine Excess-Property-Pruefung). */
  overrides?: {
    codec?: string;
    bit_depth?: number;
    bitrate_kbps?: number;
    fps?: number;
    resolution?: string;
    /** HDR senden. Setzt `bit_depth: 10` und AV1 voraus; der Sidecar
     *  VERWEIGERT den Start, wenn er es nicht liefern kann — anders als bei
     *  `bit_depth`, das still zurückgenommen wird. */
    hdr?: boolean;
  };
  /** Show the mouse cursor in the captured stream. Default true (GSR's
   *  built-in default); set to false to pass `-cursor no`. */
  show_cursor?: boolean;
  /** Windows-only constant A/V trim in ms (>0 = audio later). Tunes the
   *  residual lip-sync offset the QPC anchor can't catch. Ignored by the Linux
   *  sidecar (gpu-screen-recorder syncs internally). Omit/0 = neutral. */
  av_offset_ms?: number;
}

export interface GsrStartResult {
  ok: boolean;
  argv?: string[];
  error?: string;
}
export interface GsrStopResult {
  ok: boolean;
  running?: boolean;
  note?: string;
  error?: string;
}

// ── Event types (forwarded from the sidecar) ────────────────────────────────

export type GsrEventBody =
  | { ev: 'state'; state: 'idle' | 'starting' | 'live' | 'error' | 'stopped'; running: boolean; uptime_s: number }
  | { ev: 'fps'; fps: number; uptime_s: number }
  | { ev: 'log'; line: string }
  // Bedeutsame, aber nicht-fehlerhafte Mitteilung des Sidecars — sie gehört
  // VOR den Nutzer (Toast), nicht nur ins Log-Fenster. `code` wählt die Art
  // (bisher nur 'fps_begrenzt': 10-bit-Bildrate am Start begrenzt, weil die
  // Quelle größer ausfiel als im Panel annehmbar — Linux-Portal). Nur der
  // Linux-Sidecar sendet sie heute; Verbraucher müssen sie tolerieren.
  | { ev: 'notice'; line: string; code: string }
  // `code` is an optional machine-readable tag (Windows sidecar; e.g.
  // 'capture_size_changed' → the client auto-restarts the stream). The Linux
  // sidecar doesn't send it yet — consumers must tolerate its absence.
  | { ev: 'error'; message: string; code?: string }
  // `reason` is an optional machine-readable tag (Windows sidecar; e.g.
  // 'source_closed' → the shared window was closed, the sidecar ended the
  // stream on its own). Absent on plain user stops and on Linux.
  | { ev: 'stopped'; code?: number; reason?: string };

/** A sidecar event, tagged by the Electron main process with the stream `slot`
 *  it came from (0 = primary stream, 1 = a second concurrent stream). `slot` is
 *  absent only when an older shell that predates multi-stream sends the event,
 *  in which case consumers treat it as slot 0. */
export type GsrEvent = GsrEventBody & { slot?: number };

// ── Bridge helpers ──────────────────────────────────────────────────────────

type Unlisten = () => void;

/** The `window.pulse.gsr` bridge, or `null` when not running inside Electron. */
function bridge(): NonNullable<Window['pulse']>['gsr'] | null {
  if (typeof window === 'undefined') return null;
  return window.pulse?.gsr ?? null;
}

export const gsr = {
  /** True iff we're inside the Electron shell and the sidecar bridge is present.
   *  (Cheap — does not actually call the sidecar; use `health()` for that.) */
  available(): boolean {
    return isElectron() && bridge() !== null;
  },

  async health(): Promise<GsrHealth | null> {
    const b = bridge();
    return b ? ((await b.health()) as GsrHealth) : null;
  },
  async gpuInfo(): Promise<GsrGpuInfo | null> {
    const b = bridge();
    return b ? ((await b.gpuInfo()) as GsrGpuInfo) : null;
  },
  /** Enumerate display monitors. Windows-only in practice — on Linux the
   *  portal dialog handles source selection, so callers gate on `isWindows()`. */
  async listMonitors(): Promise<GsrListMonitors | null> {
    const b = bridge();
    return b ? ((await b.listMonitors()) as GsrListMonitors) : null;
  },
  /** Enumerate capturable windows (macOS source picker). */
  async listWindows(): Promise<GsrListWindows | null> {
    const b = bridge();
    return b ? ((await b.listWindows()) as GsrListWindows) : null;
  },
  async listApplicationAudio(): Promise<GsrListApplicationAudio | null> {
    const b = bridge();
    return b ? ((await b.listApplicationAudio()) as GsrListApplicationAudio) : null;
  },
  async buildArgv(args: GsrStartArgs): Promise<GsrBuildArgv | null> {
    const b = bridge();
    return b ? ((await b.buildArgv(args)) as GsrBuildArgv) : null;
  },
  /** Start a stream in `slot` (0 = primary, 1 = a second concurrent stream). */
  async start(args: GsrStartArgs, slot = 0): Promise<GsrStartResult | null> {
    const b = bridge();
    return b ? ((await b.start(args, slot)) as GsrStartResult) : null;
  },
  /** Stop the stream in `slot` (default 0). `grund` ist reine Diagnose und
   *  landet in der Protokollzeile des Befehls (s. `preload.ts`). */
  async stop(slot = 0, grund?: string): Promise<GsrStopResult | null> {
    const b = bridge();
    return b ? ((await b.stop(slot, grund)) as GsrStopResult) : null;
  },

  /**
   * Subscribe to sidecar events (the `gsr:event` IPC channel). Returns a
   * disposer. No-op (returns immediately) in a plain browser.
   *
   * Stays `async` for signature compatibility with the previous Tauri-based
   * implementation (callers `await` it) — the underlying preload `onEvent` is
   * synchronous and returns the unsubscribe function directly.
   */
  async onEvent(cb: (ev: GsrEvent) => void): Promise<Unlisten> {
    const b = bridge();
    if (!b) return () => {};
    return b.onEvent((ev) => cb(ev as GsrEvent));
  },
};
