/**
 * Die Weiche: Läuft eine Direktverbindung zum Ziel-Server, geht der Request
 * dort durch — sonst per `fetch` über den Hostname (VPS: die eigene Domain;
 * App-Host historisch: die Relay-Subdomain).
 *
 * Direct-only (origin='app_host', s. policy.ts): KEIN stiller Relay-Fallback
 * mehr — scheitert der Direktpfad, wirft die Weiche einen erklärten
 * `DirectUnavailableError` (offline / keine Direktverbindung / Identität
 * geändert) und meldet den Zustand an den directStatus-Store fürs UI.
 * VPS-Server verhalten sich wie bisher (Hostname IST deren Weg).
 */

import type { ServerEntry } from '$lib/api/servers.svelte';
import { m } from '$lib/paraglide/messages.js';
import { directStatus } from '$lib/stores/directStatus.svelte';
import { getDirectConnectionDetailed } from './registry';
import { isDirectOnly, directFailureMessageKey, type DirectFailureReason } from './policy';

/** Harter Fehlzustand eines Direct-only-Servers — trägt den Grund für UI-Logik
 *  und bereits die lokalisierte Meldung als `message`. */
export class DirectUnavailableError extends Error {
  constructor(public readonly reason: DirectFailureReason) {
    super(m[directFailureMessageKey(reason)]());
    this.name = 'DirectUnavailableError';
  }
}

/** Absolute Self-Host-URL → reiner Pfad (der Adapter hängt sein Backend davor). */
function toPath(url: string): string {
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.href : 'http://x');
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

export function directEligible(server: ServerEntry | undefined): boolean {
  return !!server && !server.isCloud && !!server.instance_id;
}

/** `fetch`-Ersatz mit Direktpfad-Vorrang. Signatur bleibt kompatibel. */
export async function transportFetch(
  server: ServerEntry | undefined,
  url: string,
  init: RequestInit,
): Promise<Response> {
  if (directEligible(server)) {
    const instanceId = server!.instance_id!;
    const result = await getDirectConnectionDetailed(instanceId);
    if (result.ok && result.conn.isOpen) {
      try {
        const resp = await result.conn.fetch(toPath(url), init);
        directStatus.clear(instanceId);
        return resp;
      } catch {
        // Verbindung starb mitten im Request.
        if (isDirectOnly(server)) {
          directStatus.report(instanceId, 'ice-failed');
          throw new DirectUnavailableError('ice-failed');
        }
        // VPS: Hostname-Versuch, nicht scheitern.
      }
    } else if (!result.ok && isDirectOnly(server)) {
      directStatus.report(instanceId, result.reason);
      throw new DirectUnavailableError(result.reason);
    }
  }
  return fetch(url, init);
}
