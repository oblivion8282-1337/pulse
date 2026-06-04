/**
 * Server-clock calibration for watch-party sync.
 *
 * Watch-party position is extrapolated as `host_position + elapsed`, where
 * `elapsed` MUST be measured against the server clock — the single time base
 * shared by every participant. Measuring it against the local `Date.now()`
 * (as the code used to) lets each client's clock skew — often 1–5 s on
 * machines without tight NTP — show up 1:1 as a playback offset: "always ~2 s
 * ahead/behind", and differently per user. The drift corrector can't fix it
 * because it corrects *towards* that same skewed target, so the offset is
 * baked in and never decays.
 *
 * The server stamps `server_now` on the `ready` frame and on every
 * `watch_state` push. We compare it to local arrival time and keep a smoothed
 * estimate of `offset = serverClock − localClock`; {@link ClockSync.now} then
 * returns a server-clock estimate for any local instant. Residual error is the
 * one-way push latency (tens of ms) — two to three orders of magnitude below
 * the clock skew it removes, and far under the corrector's 100 ms dead band.
 *
 * Pure + injectable (`clientRecvMs` / `clientNowMs` params) so the math is
 * unit-testable without mocking `Date.now()`.
 */

/** EMA weight for each new sample. Low enough to absorb per-push latency
 * jitter, high enough to re-converge within a handful of heartbeats if the
 * clock is ever stepped. */
const SMOOTHING = 0.2;

export class ClockSync {
  #offsetMs = 0;
  #calibrated = false;

  /** Fold one observed server timestamp into the estimate. `clientRecvMs` is
   * the local clock reading when the frame arrived (injectable for tests). */
  record(serverNowMs: number, clientRecvMs: number = Date.now()): void {
    if (!Number.isFinite(serverNowMs)) return;
    const sample = serverNowMs - clientRecvMs;
    this.#offsetMs = this.#calibrated
      ? this.#offsetMs + SMOOTHING * (sample - this.#offsetMs)
      : sample; // first sample seeds directly — no warm-up lag
    this.#calibrated = true;
  }

  /** Estimated server-clock time for a given local instant (default: now).
   * Before the first {@link record} this is just the local clock (offset 0),
   * i.e. no worse than the old behaviour. */
  now(clientNowMs: number = Date.now()): number {
    return clientNowMs + this.#offsetMs;
  }

  get offsetMs(): number {
    return this.#offsetMs;
  }

  get calibrated(): boolean {
    return this.#calibrated;
  }

  /** Test/teardown helper — drop the calibration. */
  reset(): void {
    this.#offsetMs = 0;
    this.#calibrated = false;
  }
}

export const clockSync = new ClockSync();
