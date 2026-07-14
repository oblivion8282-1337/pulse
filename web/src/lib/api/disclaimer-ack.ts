/**
 * Self-Host-Disclaimer-Bestätigung — „einmal pro Server, geräteübergreifend".
 *
 * Der „Verstanden"-Klick wird als User-Preference-Section AUF DEM JEWEILIGEN
 * Server gespeichert (`PUT /preferences/self-host-disclaimer`, chat-gateway —
 * jede Instanz hat ihre eigene DB, also ist der Scope automatisch „pro
 * Server"). localStorage bleibt als geräte-lokaler Fast-Path-Cache, damit
 * bekannte Server keinen Roundtrip brauchen (Key ist derselbe, den
 * add-server-flow beim bewussten Erstkontakt-Confirm setzt).
 *
 * Genutzt von SelfHostDisclaimer.svelte (Banner) und add-server-flow.ts
 * (Server-Hinzufügen mit Bestätigungs-Dialog = ebenfalls Bestätigung).
 */

import { ApiError, request } from './client';

const SECTION = 'self-host-disclaimer';

function localKey(serverId: string): string {
  return `pulse.disclaimer_seen_${serverId}`;
}

/** Geräte-lokaler Cache: wurde der Hinweis für diesen Server schon bestätigt? */
export function disclaimerSeenLocally(serverId: string): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(localKey(serverId)) === '1';
  } catch {
    return false;
  }
}

/** Nur den geräte-lokalen Cache setzen (kein Server-PUT) — z.B. wenn der Server
 *  bereits „bestätigt" gemeldet hat. */
export function markDisclaimerSeenLocally(serverId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(localKey(serverId), '1');
  } catch {
    /* harmlos — nächster Mount fragt erneut den Server */
  }
}

/** Serverseitig nachschauen (geräteübergreifend). true/false = Antwort des
 *  Servers; null = nicht feststellbar (offline/Fehler) — Aufrufer entscheidet. */
export async function fetchDisclaimerAck(serverId: string): Promise<boolean | null> {
  try {
    const row = await request<{ value?: { seen?: boolean } }>(
      `/preferences/${SECTION}`,
      {},
      { serverId },
    );
    return row?.value?.seen === true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return false; // nie bestätigt
    return null;
  }
}

/** Bestätigung persistieren: sofort lokal (dieses Gerät), fire-and-forget auf
 *  dem Server (alle künftigen Geräte). Ein fehlgeschlagener PUT kostet nur die
 *  Geräteübergreifung — der nächste Dismiss auf einem anderen Gerät holt es nach. */
export function persistDisclaimerAck(serverId: string): void {
  markDisclaimerSeenLocally(serverId);
  void request(`/preferences/${SECTION}`, { method: 'PUT', body: { value: { seen: true } } }, {
    serverId,
  }).catch(() => undefined);
}
