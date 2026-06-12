/**
 * Sweep gelöschter Self-Host-Instanzen — entfernt Server aus der lokalen
 * Liste, deren Registrierung der Betreiber in der Cloud endgültig gelöscht
 * hat (DELETE /me/instances, routes_instance_delete.py).
 *
 * Quelle ist die öffentliche, anonyme Liste
 * `https://howispulse.com/.well-known/pulse-suspended-instances` —
 * der Abgleich passiert rein clientseitig (kein Membership-Leak: die Cloud
 * erfährt nicht, welche Server dieses Gerät kennt). Nur
 * `deleted_instance_ids` führt zum Entfernen; bloß suspendierte Instanzen
 * sind reversibel und bleiben in der Liste.
 *
 * Aufruf: einmal beim App-Start (app/+layout.svelte, nach hydrate),
 * fire-and-forget. Fehler (offline, Cloud down) sind still — der nächste
 * Start versucht es wieder.
 */

import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import { CLOUD_HOSTNAME, serversStore } from '$lib/api/servers.svelte';
import { removeServerLocally } from '$lib/api/server-removal';

export async function sweepDeletedServers(): Promise<void> {
  // Ohne Self-Host-Einträge mit Instanz-ID gibt es nichts abzugleichen —
  // dann auch kein Request.
  const candidates = serversStore.servers.filter((s) => !s.isCloud && s.instance_id);
  if (candidates.length === 0) return;

  let deleted: Set<string>;
  try {
    // ACHTUNG: keine Custom-Header (z.B. If-None-Match) ergänzen! Das machte
    // aus dem Simple-Request einen Preflight (OPTIONS), und die globale
    // CORSMiddleware der Cloud beantwortet Preflights fremder Origins mit 400,
    // BEVOR das route-eigene `Access-Control-Allow-Origin: *` greift — der
    // Sweep wäre auf allen Self-Host-Origins still tot.
    const resp = await fetch(`${CLOUD_HOSTNAME}/.well-known/pulse-suspended-instances`);
    if (!resp.ok) return;
    const body = (await resp.json()) as { deleted_instance_ids?: unknown };
    if (!Array.isArray(body.deleted_instance_ids)) return;
    deleted = new Set(
      body.deleted_instance_ids.filter((x): x is string => typeof x === 'string')
    );
  } catch {
    return;
  }
  if (deleted.size === 0) return;

  for (const server of candidates) {
    if (!deleted.has(server.instance_id!)) continue;
    removeServerLocally(server.id);
    toast.info(m.server_deleted_by_operator({ label: server.label }));
  }
}
