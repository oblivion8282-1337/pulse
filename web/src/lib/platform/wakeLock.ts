/**
 * Screen wake-lock — keeps the monitor awake while video is actively playing
 * (watch-party / HQ stream viewer), so the OS power settings don't blank the
 * display while you're just watching and not touching the mouse.
 *
 * Refcounted: several tiles may hold a lease at once. The underlying lock
 * engages on the first lease and releases on the last. Two backends:
 *
 *  - Electron → `window.pulse.power.keepAwake()` → `powerSaveBlocker`. Reliable
 *    on Linux (honours the desktop's power settings via logind inhibit), which
 *    the browser Wake Lock API is not inside Electron. Preferred whenever the
 *    bridge is present.
 *  - Browser / older desktop builds → `navigator.wakeLock.request('screen')`.
 *    Used both in the browser and in a desktop app whose bundled preload predates
 *    the `power` bridge (the bridge ships with a native rebuild, the web bundle
 *    updates instantly), so the feature degrades to Chromium's own wake lock
 *    instead of silently doing nothing. The UA auto-releases it when the tab is
 *    hidden, so we re-acquire on `visibilitychange`.
 *
 * The lock is only held while the document is visible — a hidden tab / minimised
 * window means nobody's watching, so the screen is allowed to sleep.
 *
 * All state transitions go through a single serialized `reconcile()` chained on
 * `pending`, so an acquire/release pair fired in the same tick (Svelte $effect
 * teardown + re-run) can never overlap an in-flight engage/disengage — each
 * reconcile re-reads the *current* desired state, so a fast acquire→release
 * resolves to a no-op instead of leaking a never-released lock.
 */
let leases = 0;
let engaged = false;
let sentinel: WakeLockSentinel | null = null;
let pending: Promise<void> = Promise.resolve();

/** The Electron powerSaveBlocker bridge, if this build's preload exposes it.
 *  Absent in the browser and in desktop builds older than the bridge. */
function powerBridge(): { keepAwake(on: boolean): Promise<boolean> } | undefined {
  return (typeof window !== 'undefined' && window.pulse?.power) || undefined;
}

function desired(): boolean {
  const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
  return leases > 0 && visible;
}

async function reconcile(): Promise<void> {
  const want = desired();
  if (want === engaged) return; // already in the target state

  if (want) {
    const bridge = powerBridge();
    if (bridge) {
      try {
        await bridge.keepAwake(true);
        engaged = true;
      } catch {
        /* leave disengaged — best-effort */
      }
    } else if ('wakeLock' in navigator) {
      try {
        const s = await navigator.wakeLock.request('screen');
        // The UA can drop the lock on its own (e.g. tab hidden) — reflect that
        // so a later reconcile re-acquires when appropriate.
        s.addEventListener('release', () => {
          sentinel = null;
          engaged = false;
        });
        sentinel = s;
        engaged = true;
      } catch {
        /* request rejected (permissions, headless, …) — degrade silently */
      }
    }
    // else: no backend available — stay disengaged.
  } else {
    engaged = false;
    const bridge = powerBridge();
    if (bridge) {
      try {
        await bridge.keepAwake(false);
      } catch {
        /* best-effort */
      }
    } else {
      const s = sentinel;
      sentinel = null;
      try {
        await s?.release();
      } catch {
        /* already released */
      }
    }
  }
}

function sync(): void {
  // Chain so transitions run strictly one-at-a-time; each reads live state.
  pending = pending.then(reconcile);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', sync);
}

/**
 * Take a wake-lock lease. The screen stays awake (while the document is
 * visible) until the returned release function is called. Release is idempotent.
 */
export function acquireWakeLock(): () => void {
  leases += 1;
  sync();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    leases = Math.max(0, leases - 1);
    sync();
  };
}
