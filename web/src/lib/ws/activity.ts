/**
 * Client → Server ``activity`` heartbeat.
 *
 * The gateway uses this hint to demote the user from ``idle`` back to
 * ``online`` (and to keep the per-user activity ZSET fresh so the idle
 * sweeper doesn't kick in). It's a fire-and-forget op: no reply, no ack.
 *
 * Throttle: at most one send per ``MIN_INTERVAL_MS`` (default 60 s) — even
 * if the user is wildly clicking. We register cheap passive listeners on
 * ``window`` for the canonical signals (mouse-move, key-press, visibility-
 * change → focus). On tab-hidden we suspend; on tab-visible we send one
 * immediately and reset the throttle.
 *
 * Designed to be a singleton (init/teardown wired from the /app layout).
 */

import { gateway } from './connection';

const MIN_INTERVAL_MS = 60_000;

let _installed = false;
let _lastSent = 0;
let _onUserSignal: (() => void) | null = null;
let _onVisibility: (() => void) | null = null;

function _send(): void {
  // Direct gateway send — no listener spam; the gateway no-ops the send
  // silently if the socket isn't open yet (fine — we'll re-fire on the
  // next user signal once the WS reconnects).
  gateway.sendActivity();
  _lastSent = Date.now();
}

function _maybeSend(): void {
  if (typeof document !== 'undefined' && document.hidden) return;
  if (Date.now() - _lastSent < MIN_INTERVAL_MS) return;
  _send();
}

/** Wire up the activity listeners. Idempotent — calling twice is a no-op. */
export function initActivityHeartbeat(): void {
  if (_installed) return;
  if (typeof window === 'undefined') return;
  _installed = true;

  _onUserSignal = () => _maybeSend();
  _onVisibility = () => {
    if (typeof document === 'undefined') return;
    if (document.hidden) return;
    // Visible again: send immediately AND reset the throttle so the next
    // movement keeps the throttle honest.
    _lastSent = 0;
    _send();
  };

  // Passive listeners — we never preventDefault, just observe.
  window.addEventListener('mousemove', _onUserSignal, { passive: true });
  window.addEventListener('keydown', _onUserSignal, { passive: true });
  window.addEventListener('touchstart', _onUserSignal, { passive: true });
  window.addEventListener('focus', _onUserSignal, { passive: true });
  document.addEventListener('visibilitychange', _onVisibility);

  // Initial fire — if we're visible at boot, the server should know we're
  // active right away (avoids a 60 s "idle" window after a fresh sign-in).
  if (typeof document === 'undefined' || !document.hidden) _send();
}

/** Tear down listeners. Used from the /app layout's onDestroy so a
 *  sign-out + re-login doesn't leak handlers. */
export function disposeActivityHeartbeat(): void {
  if (!_installed) return;
  _installed = false;
  if (typeof window === 'undefined') return;
  if (_onUserSignal) {
    window.removeEventListener('mousemove', _onUserSignal);
    window.removeEventListener('keydown', _onUserSignal);
    window.removeEventListener('touchstart', _onUserSignal);
    window.removeEventListener('focus', _onUserSignal);
  }
  if (_onVisibility) {
    document.removeEventListener('visibilitychange', _onVisibility);
  }
  _onUserSignal = null;
  _onVisibility = null;
  _lastSent = 0;
}
