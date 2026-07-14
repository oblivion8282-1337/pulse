/**
 * Öffentliche Löschliste der Cloud — geteilter Fetch-Helper.
 *
 * Quelle: `https://howispulse.com/.well-known/pulse-suspended-instances`
 * (anonym, kein Membership-Leak — die Cloud erfährt nicht, welche Server
 * dieses Gerät kennt). Genutzt vom Sweep beim App-Start
 * (deleted-instance-sweep.ts) und von „Server entfernen"
 * (server-removal.ts), um tote von bloß offline-Servern zu unterscheiden.
 */

import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';

/** IDs endgültig gelöschter Instanzen. `null` = Liste nicht ladbar
 *  (offline/Cloud down) — Aufrufer behandeln das konservativ. */
export async function fetchDeletedInstanceIds(): Promise<Set<string> | null> {
  try {
    // ACHTUNG: keine Custom-Header (z.B. If-None-Match) ergänzen! Das machte
    // aus dem Simple-Request einen Preflight (OPTIONS), und die globale
    // CORSMiddleware der Cloud beantwortet Preflights fremder Origins mit 400,
    // BEVOR das route-eigene `Access-Control-Allow-Origin: *` greift — der
    // Abgleich wäre auf allen Self-Host-Origins still tot.
    const resp = await fetch(`${CLOUD_HOSTNAME}/.well-known/pulse-suspended-instances`);
    if (!resp.ok) return null;
    const body = (await resp.json()) as { deleted_instance_ids?: unknown };
    if (!Array.isArray(body.deleted_instance_ids)) return null;
    return new Set(
      body.deleted_instance_ids.filter((x): x is string => typeof x === 'string')
    );
  } catch {
    return null;
  }
}
