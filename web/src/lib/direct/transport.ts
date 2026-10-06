/**
 * Die Weiche: Läuft eine Direktverbindung zum Ziel-Server, geht der Request
 * dort durch — sonst per `fetch` über den Hostname (VPS: die eigene Domain;
 * App-Host historisch: die Relay-Subdomain).
 *
 * Direct-only (origin='app_host', s. policy.ts): KEIN stiller Relay-Fallback
 * mehr — scheitert der Direktpfad, wirft die Weiche einen erklärten
 * `DirectUnavailableError` (offline / keine Direktverbindung / Identität
 * geändert) und meldet den Zustand an den directStatus-Store fürs UI.
 * VPS-Server: Der Direktpfad ist nur eine Optimierung und darf seit
 * 2026-10-03 den ERSTEN Request nicht mehr aufhalten — Abfrage läuft sofort
 * über den Hostnamen, ein Aufbau wird höchsten angestoßen und von den
 * nachfolgenden Requests genutzt, sobald er steht.
 */

import { m } from '$lib/paraglide/messages.js';
import { directStatus } from '$lib/stores/directStatus.svelte';
import { appHostAnwesenheit } from '$lib/stores/appHostAnwesenheit.svelte';
import { getDirectConnection, getDirectConnectionDetailed } from './registry';
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

/** Strukturelles Minimum fuer die Weche — das volle `ServerEntry` erfuellt es;
 *  duennere Fassungen (joinByInvite uebergibt das Einladungsziel) auch. */
export type DirectTransportServer = {
  hostname: string;
  instance_id?: string | null;
  isCloud?: boolean;
  origin?: 'vps' | 'app_host' | null;
};

function directEligible(server: DirectTransportServer | undefined): boolean {
  return !!server && !server.isCloud && !!server.instance_id;
}

/** `fetch`-Ersatz mit Direktpfad-Vorrang. Signatur bleibt kompatibel. */
export async function transportFetch(
  server: DirectTransportServer | undefined,
  url: string,
  init: RequestInit,
): Promise<Response> {
  if (directEligible(server)) {
    const instanceId = server!.instance_id!;
    if (isDirectOnly(server)) {
      // App-Host (Direct-only): Anwesenheit prüfen, dann dialen — der
      // Direktweg ist der einzige Weg, hier darf (und muss) gewartet werden.
      if (await appHostAnwesenheit.istOffline(instanceId)) {
        directStatus.report(instanceId, 'offline');
        throw new DirectUnavailableError('offline');
      }
      const result = await getDirectConnectionDetailed(instanceId, server);
      if (result.ok && result.conn.isOpen) {
        try {
          const resp = await result.conn.fetch(toPath(url), init);
          directStatus.clear(instanceId);
          return resp;
        } catch {
          // Verbindung starb mitten im Request.
          directStatus.report(instanceId, 'ice-failed');
          throw new DirectUnavailableError('ice-failed');
        }
      }
      const reason: DirectFailureReason = result.ok ? 'ice-failed' : result.reason;
      directStatus.report(instanceId, reason);
      throw new DirectUnavailableError(reason);
    }
    // VPS (2026-10-03): Steht die Direktverbindung, sie nutzen — sonst SOFORT
    // über den Hostname und den Aufbau nur noch anstoßen. Er darf die erste
    // Abfrage nicht mehr blockieren; steht er später, nehmen ihn die
    // nachfolgenden Requests und der Gateway mit.
    const offen = getDirectConnection(instanceId);
    if (offen) {
      try {
        const resp = await offen.fetch(toPath(url), init);
        directStatus.clear(instanceId);
        return resp;
      } catch {
        // Verbindung starb mitten im Request → Hostname, nicht scheitern.
      }
    } else {
      void getDirectConnectionDetailed(instanceId, server).catch(() => undefined);
    }
  }
  return fetch(url, init);
}
