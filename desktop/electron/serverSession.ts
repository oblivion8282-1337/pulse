/**
 * Pulse-Session-Cookie der Server-App — reine Helper (keine Electron-Imports,
 * Muster serverGiveUp/serverSupersede).
 *
 * Hintergrund (Bughunt 2026-10-03): der Boot-Renew der Web-App rotierte die
 * Browser-Session auf dem Server (A→B), während die Server-App per Login-Watch
 * auf server.html umschaltete — das Set-Cookie(B) der abgebrochenen Antwort
 * landete nie im Cookie-Jar. `ensureSessionCookie` (serverProvision) vertraut
 * aber blind jedem vorhandenen Cookie → ewiges HTTP 401 auf allen Cloud-Calls,
 * obwohl die dauerhaften Tokens (pulse.host.auth) gesund waren. Zwei Bausteine
 * dagegen (Verdrahtung in serverProvision.ts):
 *   - `pulseSessionAusSetCookie` liest das frisch gemintete Cookie aus den
 *     Response-Headern eines `net`-Renews. `net` läuft ohne `useSessionCookies`
 *     (Electron-Default), sendet also den alten Cookie NICHT mit (gut: der
 *     Renew darf die Browser-Session nie weg-rotieren) — speichert aber auch
 *     Set-Cookie NICHT selbst; das Jar-Setzen macht serverProvision daher
 *     explizit per session.cookies.set().
 *   - Die Provisionierung heilt bei 401: Cookie verwerfen, per Bearer neu
 *     prägen, einmal erneut versuchen.
 */

export interface PulseSessionCookie {
  value: string;
  /** Max-Age in Sekunden (Server-Default 1800) — wird zur Jar-Ablaufzeit. */
  maxAgeSek: number;
}

/** Liest aus Set-Cookie-Headern das pulse_session-Cookie (Wert + Max-Age).
 *  Andere Cookies (pulse_rt, …) und unparsbare Zeilen werden übersprungen;
 *  leerer Wert → null (ein leerer Cookie wäre nur ein Lösch-Hinweis). */
export function pulseSessionAusSetCookie(
  setCookie: readonly string[] | undefined,
): PulseSessionCookie | null {
  for (const zeile of setCookie ?? []) {
    const semikolon = zeile.indexOf(';');
    const nameWert = semikolon === -1 ? zeile : zeile.slice(0, semikolon);
    const gleich = nameWert.indexOf('=');
    if (gleich <= 0) continue;
    if (nameWert.slice(0, gleich).trim() !== 'pulse_session') continue;
    const value = nameWert.slice(gleich + 1).trim();
    if (!value) continue;

    let maxAgeSek = 1800; // Server-Default (browser_sessions._DEFAULT_TTL)
    for (const attr of (semikolon === -1 ? '' : zeile.slice(semikolon + 1)).split(';')) {
      const [k, v = ''] = attr.split('=', 2).map((s) => s.trim().toLowerCase());
      if (k === 'max-age') {
        const zahl = parseInt(v, 10);
        if (Number.isFinite(zahl)) maxAgeSek = zahl;
      }
    }
    return { value, maxAgeSek };
  }
  return null;
}
