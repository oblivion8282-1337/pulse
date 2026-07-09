/**
 * Die Weiche: Läuft eine Direktverbindung zum Ziel-Server, geht der Request
 * dort durch — sonst wie bisher per `fetch` über den Relay.
 *
 * Nur Self-Host-Server mit `instance_id` kommen in Frage; die Cloud selbst
 * wird nie gedirected (sie IST das Ziel). Ein Fehler im Direktpfad fällt
 * still auf den Relay zurück, damit ein Serverneustart keine Anfrage verliert.
 */

import type { ServerEntry } from '$lib/api/servers.svelte';
import { getDirectConnection } from './registry';

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
    const conn = await getDirectConnection(server!.instance_id);
    if (conn?.isOpen) {
      try {
        return await conn.fetch(toPath(url), init);
      } catch {
        // Verbindung starb mitten im Request → Relay-Versuch, nicht scheitern.
      }
    }
  }
  return fetch(url, init);
}
