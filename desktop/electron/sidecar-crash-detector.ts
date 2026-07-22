/**
 * Stream-lifecycle tracker for ONE sidecar child process.
 *
 * The Windows HQ pipeline (WGC + D3D11 + NVENC) can crash inside native FFI
 * past Rust's `catch_unwind` — the process just exits (e.g. code 0xFFFFFFFF)
 * without ever emitting a `stopped`/`error`/`state:running=false`. When that
 * happens mid-stream the renderer would sit forever on "live" (rocket lit, no
 * way to stop), because its whole stream state is driven by sidecar events.
 *
 * This pure tracker watches the event stream so the manager's `exit` handler
 * can tell that silent crash apart from a normal end and synthesise a terminal
 * event only when needed. One instance per spawned child (state is per-child).
 */
export type SidecarLifecycleEvent = { ev?: string; running?: boolean };

export interface StreamLifecycleTracker {
  /** Feed every `{ev:..}` event the child emits. */
  note(obj: SidecarLifecycleEvent): void;
  /**
   * Called from the child's `exit` handler. `true` iff we must synthesise a
   * terminal `stopped`: the child actually streamed, never reported the stream
   * ending, and we did not ask it to quit (`deliberateShutdown` false — i.e.
   * this was neither a `stop` op's shutdown, an EOF, nor an app quit).
   */
  shouldSynthesiseStopOnExit(deliberateShutdown: boolean): boolean;
}

export function createStreamLifecycleTracker(): StreamLifecycleTracker {
  // Child reported a RUNNING stream (`fps`, or `state` with running:true).
  let sawActivity = false;
  // Child reported the stream ENDING (`stopped`/`error`, or `state` running:false).
  let sawTerminal = false;

  return {
    note(obj: SidecarLifecycleEvent): void {
      if (obj.ev === 'fps') {
        sawActivity = true;
      } else if (obj.ev === 'state') {
        // `state` carries `running`: starting/live are true, stopped/error false.
        if (obj.running === true) sawActivity = true;
        else sawTerminal = true;
      } else if (obj.ev === 'stopped' || obj.ev === 'error') {
        sawTerminal = true;
      }
    },
    shouldSynthesiseStopOnExit(deliberateShutdown: boolean): boolean {
      return !deliberateShutdown && sawActivity && !sawTerminal;
    },
  };
}
