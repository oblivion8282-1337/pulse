/**
 * Lokales Entfernen eines Server-Eintrags — gemeinsamer Pfad für:
 *  - GuildRail „Server entfernen" (User-Aktion, nach Instanz-Austritt)
 *  - MyInstances „Instanz löschen" (Owner löscht die Registrierung)
 *  - Sweep gelöschter Instanzen beim App-Start (deleted-instance-sweep.ts)
 *
 * Kein Server-Call hier — nur das lokale Aufräumen (WS, Stores, aktiver
 * Server). Der Vault-Push läuft über den Change-Listener des serversStore.
 */

import { gatewayPool } from '$lib/ws/gateway-pool.svelte';
import { serversStore } from '$lib/api/servers.svelte';
import { serverGuilds } from '$lib/stores/serverGuilds.svelte';
import { serverCapabilities } from '$lib/stores/serverCapabilities.svelte';
import { activeServer } from '$lib/stores/active-server.svelte';

export function removeServerLocally(serverId: string): void {
  // Connection schließen BEVOR der Entry weg ist (Pool dereferenced
  // serversStore.find sonst zu undefined → spätere reconnects crashen).
  gatewayPool.close(serverId);
  serversStore.remove(serverId);
  serverGuilds.forget(serverId);
  serverCapabilities.forget(serverId);
  if (activeServer.serverId === serverId) {
    const fallback = serversStore.servers.find((s) => s.isCloud);
    if (fallback) activeServer.set(fallback.id);
  }
}
