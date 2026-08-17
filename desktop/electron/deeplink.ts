// ── Deep-Link / Invite-Handler ───────────────────────────────────────────────
// Validates and dispatches `pulse://invite?host=<fqdn>&code=<code>` URLs.
// Security: we parse strictly (URL class + FQDN regex + alphanumeric code) and
// NEVER execute any action derived from the URL without showing a user-visible
// disclaimer first (that's the frontend's job in /invite/[code]?host=…).
//
// Split out of main.ts to keep that file under the code-size cap; the IPC wiring
// (`open-url`, `second-instance`, `invite:getPending`) stays in main.ts and
// calls into the validated helpers here.
import type { BrowserWindow } from 'electron';

/** Valid invite code: 6-64 alphanumeric chars (same shape as the backend issues). */
const INVITE_CODE_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** Rough FQDN check — at least one dot, only label-safe chars, no port injection.
 *  Blocks bare IPv4 in all numeric notations (decimal 192.168.1.1, hex 0x7f.0.0.1,
 *  octal 0177.0.0.1) so a malicious link can't trick the renderer into hitting a
 *  private/loopback address. Self-Host muss FQDN haben (LE-Cert Pflicht für TLS)
 *  — IP-Direkt-Connect ist nie ein legitimer Pulse-Use-Case. */
function isValidFqdn(hostname: string): boolean {
  // Block decimal IPv4 (e.g. 192.168.1.1).
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) return false;
  // Block hex-encoded IPv4 (e.g. 0x7f.0.0.1 → 127.0.0.1).
  if (/(?:^|\.)0x[0-9a-f]+/i.test(hostname)) return false;
  // Block octal-encoded IPv4 segments (e.g. 0177.0.0.1 → 127.0.0.1).
  // Matches only purely-numeric labels with a leading zero (octal IP notation).
  // Labels that mix digits with letters (e.g. "01host") are not valid IP segments
  // and are excluded by the boundary \b(?!\.) / end-of-segment anchor below.
  if (/(?:^|\.)0\d+(?:\.|$)/.test(hostname)) return false;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
    hostname
  );
}

/** Extract a `pulse://` URL from a raw argv array (Windows/Linux cold-start). */
export function extractPulseUrl(argv: string[]): string | null {
  return argv.find((a) => a.startsWith('pulse://')) ?? null;
}

/**
 * Buffer for a validated invite payload that has not yet been consumed by the
 * renderer. Using a pull-based model (renderer calls `invite:getPending` on
 * mount) avoids the send-before-listen race: `ready-to-show` fires before the
 * SvelteKit `onMount` callback has registered its `ipcRenderer.on('pulse:invite')`
 * listener, so a direct `webContents.send` in that window would be silently
 * dropped. Storing the validated payload here and letting the renderer pull it
 * once on mount makes delivery reliable regardless of timing.
 */
let pendingInvitePayload: { hostname: string; code: string } | null = null;

(function seedPendingFromArgv(): void {
  const url = extractPulseUrl(process.argv);
  if (url) {
    // Parse and validate the argv deep-link at startup; store only the
    // sanitised payload so we never handle the raw URL twice.
    let parsed: URL;
    try { parsed = new URL(url); } catch { return; }
    if (parsed.protocol !== 'pulse:' || parsed.hostname !== 'invite') return;
    const host = parsed.searchParams.get('host') ?? '';
    const code = parsed.searchParams.get('code') ?? '';
    if (isValidFqdn(host) && INVITE_CODE_RE.test(code)) {
      pendingInvitePayload = { hostname: host, code };
    }
  }
})();

export function handleDeepLink(url: string, getWindow: () => BrowserWindow | null): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.warn('[deep-link] unparseable URL, ignoring:', url);
    return;
  }
  if (parsed.protocol !== 'pulse:') return;
  if (parsed.hostname !== 'invite') {
    console.warn('[deep-link] unknown host, ignoring:', parsed.hostname);
    return;
  }

  const host = parsed.searchParams.get('host') ?? '';
  const code = parsed.searchParams.get('code') ?? '';

  // Strict validation — do NOT send user to an attacker-controlled hostname.
  if (!isValidFqdn(host)) {
    console.warn('[deep-link] invalid host param, ignoring:', host);
    return;
  }
  if (!INVITE_CODE_RE.test(code)) {
    console.warn('[deep-link] invalid code param, ignoring:', code);
    return;
  }

  const payload = { hostname: host, code };
  // Always buffer the validated payload so the renderer can pull it on mount.
  // Also push it eagerly when the webContents is alive AND has actually
  // finished loading, in case the renderer is already fully loaded (e.g. a
  // second-instance deep-link while the app is running). After the eager
  // push, clear the buffer to prevent duplicate delivery on renderer reload
  // (which would re-pull via takePendingInvite).
  //
  // **`!isDestroyed()` alone is NOT enough** (Bughunt 2026-08-17): a freshly
  // created window exists and isn't destroyed long before its page has
  // loaded — same race the `ready-to-show` handler in main.ts already avoids
  // by deliberately NOT pushing there. Sending while still loading is a
  // guaranteed drop (SvelteKit's `onMount` hasn't registered the
  // `ipcRenderer.on('pulse:invite', …)` listener yet), and clearing the
  // buffer right after meant the later pull-based `invite:getPending` found
  // nothing either — the invite was gone for good. `isLoading() === false`
  // is not a hundred-percent proof `onMount` already ran, but it closes the
  // one case that was certain to lose the invite every time.
  pendingInvitePayload = payload;
  const win = getWindow();
  if (
    win &&
    !win.isDestroyed() &&
    !win.webContents.isDestroyed() &&
    !win.webContents.isLoading()
  ) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('pulse:invite', payload);
    pendingInvitePayload = null;
  }
}

/** One-shot read of the buffered invite payload (clears it). */
export function takePendingInvite(): { hostname: string; code: string } | null {
  const payload = pendingInvitePayload;
  pendingInvitePayload = null;
  return payload;
}
