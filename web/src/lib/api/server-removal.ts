/**
 * Server-Eintrag entfernen.
 *
 * ``removeServerLocally`` = nur das gerätelokale Aufräumen (WS-Connection,
 * Stores, aktiver Server) — gemeinsamer Pfad für „Instanz löschen" (MyInstances)
 * und den Sweep gelöschter Instanzen beim App-Start (deleted-instance-sweep.ts).
 *
 * ``leaveAndRemoveServer`` = der volle „Server entfernen"-Pfad der beiden
 * Kontextmenüs (GuildRail + ServerSidebar): Instanz-Austritt + Cloud-Membership-
 * Cleanup + lokales Aufräumen.
 */

import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import { gatewayPool } from '$lib/ws/gateway-pool.svelte';
import { serversStore, type ServerEntry } from '$lib/api/servers.svelte';
import { serverGuilds } from '$lib/stores/serverGuilds.svelte';
import { serverCapabilities } from '$lib/stores/serverCapabilities.svelte';
import { activeServer } from '$lib/stores/active-server.svelte';
import { leaveInstanceOn } from '$lib/api/add-server-flow';
import { instancesApi } from '$lib/api/instances';
import { ApiError } from '$lib/api/client';

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

/** Ergebnis eines „Server entfernen" — bestimmt den Toast + ob lokal entfernt
 *  wurde. */
export type LeaveServerOutcome = 'left' | 'owner' | 'unreachable' | 'owns-communities';

/**
 * Aus einer Self-Host-Instanz austreten UND danach lokal aufräumen — der EINE
 * gemeinsame Pfad für beide „Server entfernen"-Einstiege (GuildRail-Kontextmenü
 * UND ServerSidebar-Kontextmenü). Beide MÜSSEN identisch handeln, sonst driftet
 * einer (so geschehen: ServerSidebar entfernte nur lokal und vergaß Austritt +
 * Cloud-Membership → Server kam beim nächsten Login zurück).
 *
 * Reihenfolge & Invarianten:
 *  - Cloud-Server: nur lokal entfernen (kein Austritt, keine Membership).
 *  - ``owns-communities`` (409): NICHTS entfernen — der User muss erst
 *    übertragen/löschen. Abbruch, der Server bleibt.
 *  - ``owner`` (403): Server bleibt sichtbar. Lokales Entfernen wäre sinnlos —
 *    die Cloud-Owner-Membership bleibt und ``hydrateFromBackend()`` holte den
 *    Server ohnehin zurück. Der Owner entfernt seinen Server, indem er die
 *    Instanz löscht (MyInstances).
 *  - ``left`` / ``unreachable``: Cloud-Membership löschen (auch wenn der
 *    Self-Host offline ist — die Cloud ist erreichbar; sonst Resurrection beim
 *    nächsten ``GET /me/instances``), dann lokal entfernen.
 */
export async function leaveAndRemoveServer(server: ServerEntry): Promise<LeaveServerOutcome> {
  if (server.isCloud) {
    removeServerLocally(server.id);
    return 'left';
  }

  let outcome: LeaveServerOutcome = 'left';
  try {
    await leaveInstanceOn({ serverId: server.id });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) return 'owns-communities';
    if (err instanceof ApiError && err.status === 403) return 'owner';
    outcome = 'unreachable';
  }

  if (server.instance_id) {
    void instancesApi.leaveInstanceMembership(server.instance_id).catch(() => undefined);
  }
  removeServerLocally(server.id);
  return outcome;
}

/** Gemeinsamer Outcome-Toast für beide Entfernen-Einstiege. */
export function notifyLeaveOutcome(outcome: LeaveServerOutcome, label: string): void {
  if (outcome === 'owns-communities') {
    toast.error(m.guild_rail_leave_owns_communities());
  } else if (outcome === 'owner') {
    toast.info(m.guild_rail_leave_owner_view_only({ label }));
  } else if (outcome === 'unreachable') {
    toast.warning(m.guild_rail_leave_unreachable({ label }));
  } else {
    toast.success(m.guild_rail_server_removed({ label }));
  }
}
