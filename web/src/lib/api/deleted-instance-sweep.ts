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
import { serversStore } from '$lib/api/servers.svelte';
import { fetchDeletedInstanceIds } from '$lib/api/deleted-instances';
import { removeServerLocally } from '$lib/api/server-removal';
import { preCheckServer } from '$lib/api/server-info';

export async function sweepDeletedServers(): Promise<void> {
  // Ohne Self-Host-Einträge gibt es nichts abzugleichen — dann auch kein Request.
  const candidates = serversStore.servers.filter((s) => !s.isCloud);
  if (candidates.length === 0) return;

  const deleted = await fetchDeletedInstanceIds();
  if (!deleted || deleted.size === 0) return;

  for (const server of candidates) {
    let instanceId = server.instance_id;
    if (!instanceId) {
      // Backfill: ältere Einträge (Invite-/Public-Join vor dem Fix in
      // add-server-flow.ts) tragen keine instance_id. Von der CORS-offenen
      // Server-Info des Hosts nachladen und persistieren — klappt nur,
      // solange der Server noch antwortet; sonst beim nächsten Start wieder.
      const pre = await preCheckServer(server.hostname, { timeoutMs: 5000 });
      if (!pre.ok || !pre.info.instance_id) continue;
      instanceId = pre.info.instance_id;
      serversStore.update(server.id, { instance_id: instanceId });
    }
    if (!deleted.has(instanceId)) continue;
    removeServerLocally(server.id);
    toast.info(m.server_deleted_by_operator({ label: server.label }));
  }
}
