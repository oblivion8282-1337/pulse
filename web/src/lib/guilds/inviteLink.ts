/**
 * Invite-Link-Helfer (Multi-Backend).
 *
 * Invite-Links werden über die Web-Domain geteilt (z.B. howispulse.com), aber
 * der Invite-Code lebt auf dem Backend, das die Community hostet. Bei einem
 * Self-Host muss der Link daher den Ziel-Host als ``?host=<fqdn>`` mitführen,
 * sonst fragt der Empfänger-Client seinen Default-/Cloud-Server ab und
 * bekommt „ungültig oder abgelaufen" (404). Die ``/invite/[code]``-Route
 * wertet ``?host=`` aus (ensureDeepLinkServer → activeServer.set → Preview).
 *
 * Cloud-Invites bleiben link-pur (kein ``?host=``).
 */

import { activeServer } from '$lib/stores/active-server.svelte';

/** Bare FQDN ohne Schema (``https://pulse.firma.de`` → ``pulse.firma.de``). */
function bareHost(hostname: string): string {
  return hostname.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * Teilbarer Invite-Link für einen Code. Hängt ``?host=`` an, wenn der aktive
 * Server ein Self-Host ist (die Community, für die der Invite erzeugt wurde,
 * liegt immer auf dem aktiven Server). Server-seitige Origin → ``''``.
 */
export function buildInviteLink(code: string): string {
  if (typeof window === 'undefined') return '';
  const base = `${window.location.origin}/invite/${code}`;
  const srv = activeServer.current;
  if (srv && !srv.isCloud) {
    return `${base}?host=${encodeURIComponent(bareHost(srv.hostname))}`;
  }
  return base;
}

/**
 * Zerlegt einen gepasteten Link ODER bare Code in ``{ code, host }``.
 * ``host`` ist der bare FQDN aus ``?host=`` (oder null bei Cloud/bare Code).
 */
export function parseInviteLink(input: string): { code: string; host: string | null } {
  const trimmed = input.trim();
  const codeMatch = trimmed.match(/\/invite\/([^/?#\s]+)/i);
  const code = (codeMatch ? codeMatch[1] : trimmed).trim();
  const hostMatch = trimmed.match(/[?&]host=([^\s&#]+)/i);
  const host = hostMatch ? decodeURIComponent(hostMatch[1]) : null;
  return { code, host };
}
