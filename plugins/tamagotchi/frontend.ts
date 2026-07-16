/**
 * Tamagotchi-Plugin frontend entry — Pulse Plugin-System PR3
 * "Server-shared Pet".
 *
 * Bindet drei Plugin-Punkte zusammen:
 *
 * 1. **Pro-Guild Pet-Store** — kein localStorage mehr, kein
 *    Settings-Section. Der State ist server-authoritativ und wird
 *    pro Guild gehalten. Das Widget triggert beim Mount einen
 *    HTTP-Fetch (``GET /guilds/{id}/plugins/tamagotchi/state``);
 *    danach kommen Live-Updates per WS.
 *
 * 2. **WS-Handler** für ``tamagotchi:state_update`` — Server-Broadcast
 *    nach jeder Mutation (feed/play/sleep/reset). Ersetzt den
 *    lokalen Snapshot 1:1.
 *
 * 3. **WS-Outbound** über ``gateway.sendPluginOp`` — Action-Funktionen
 *    schicken ``{guild_id}`` (kein State-Snapshot mehr — Server ist
 *    Source-of-Truth). Optimistic-UI: das Widget zeigt sofort den
 *    erwarteten neuen State; der ``state_update``-Broadcast überschreibt
 *    ihn mit dem authoritativen Wert.
 *
 * Lazy-loaded vom Plugin-Loader. Reaktiver State liegt in
 * ``pet-store.svelte.ts`` — diese ``.ts``-Datei darf keine Runes
 * benutzen (Svelte 5 Limit).
 */
import {
  registerWsHandler,
  unregisterWsHandler
} from '../../web/src/lib/ws/handler-registry';
import { gateway } from '../../web/src/lib/ws/connection';
import { request } from '../../web/src/lib/api/client';

import { DEFAULT_PET, parsePet, levelForXp, XP_PER_ACTION, type PetState } from './store';
import {
  clearAll,
  getPet,
  isLoading,
  markLoading,
  setPet
} from './pet-store.svelte';

interface TamagotchiStateUpdate {
  op: 'tamagotchi:state_update';
  guild_id: string;
  state: unknown;
  updated_by_user_id: string | null;
  updated_at: string;
}

/** Reaktiver Read-Only-Resolver fürs Widget. ``null`` = noch nicht
 *  geladen (Widget rendert Loading-Block). */
export function getPetForGuild(guildId: string): PetState | null {
  return getPet(guildId);
}

/** Lade den Pet-State einer Guild vom Backend. Idempotent — wenn schon
 *  geladen oder gerade am Laden, kein Re-Fetch. Das Widget ruft das
 *  beim Mount auf. */
export async function ensurePetLoaded(guildId: string): Promise<void> {
  if (!guildId) return;
  if (getPet(guildId)) return;
  if (isLoading(guildId)) return;
  markLoading(guildId, true);
  try {
    const raw = await request<unknown>(
      `/guilds/${guildId}/plugins/tamagotchi/state`,
      { endpoint: 'chat' }
    );
    setPet(guildId, parsePet(raw));
  } catch (err) {
    // Best-effort: Failure → Default-Pet anzeigen (besser als leere UI).
    // Ein späteres state_update korrigiert.
    console.error(`[tamagotchi] load failed for guild ${guildId}`, err);
    setPet(guildId, { ...DEFAULT_PET });
  } finally {
    markLoading(guildId, false);
  }
}

/** Lokaler Optimistic-Patch (nach Klick auf einen Action-Button). Das
 *  Widget zeigt den geschätzten neuen State sofort; der Server-Broadcast
 *  überschreibt ihn mit dem authoritativen Wert. */
function applyOptimistic(
  guildId: string,
  patch: (s: PetState) => PetState
): void {
  const cur = getPet(guildId);
  if (!cur) return;
  setPet(guildId, patch(cur));
}

function clamp(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/** XP-Gewinn einer Pflege-Aktion (optimistisch). */
function withXp(s: PetState): { xp: number; level: number } {
  const xp = s.xp + XP_PER_ACTION;
  return { xp, level: levelForXp(xp) };
}

export function feed(guildId: string): void {
  if (!guildId) return;
  applyOptimistic(guildId, (s) => ({ ...s, hunger: clamp(s.hunger + 20), ...withXp(s) }));
  gateway.sendPluginOp('tamagotchi:feed', { guild_id: guildId });
}

export function play(guildId: string): void {
  if (!guildId) return;
  applyOptimistic(guildId, (s) => ({
    ...s,
    happiness: clamp(s.happiness + 20),
    energy: clamp(s.energy - 10),
    ...withXp(s)
  }));
  gateway.sendPluginOp('tamagotchi:play', { guild_id: guildId });
}

export function sleep(guildId: string): void {
  if (!guildId) return;
  applyOptimistic(guildId, (s) => ({ ...s, energy: clamp(s.energy + 30), ...withXp(s) }));
  gateway.sendPluginOp('tamagotchi:sleep', { guild_id: guildId });
}

export function reset(guildId: string): void {
  if (!guildId) return;
  applyOptimistic(guildId, () => ({ ...DEFAULT_PET }));
  gateway.sendPluginOp('tamagotchi:reset', { guild_id: guildId });
}

/** Wiederbeleben — MANAGE_GUILD-gated im Backend. KEIN Optimistic-Update:
 *  fehlt die Permission, kommt ein Error-Frame zurück und der State bleibt
 *  unverändert; bei Erfolg überschreibt der ``state_update``-Broadcast. */
export function revive(guildId: string): void {
  if (!guildId) return;
  gateway.sendPluginOp('tamagotchi:revive', { guild_id: guildId });
}

/** Vergiss alle gecachten Pet-States (Sign-Out). */
export function resetAllPets(): void {
  clearAll();
}

/** Plugin-Entry. Idempotent — re-registriert denselben WS-Handler.
 *  Wird vom Frontend-Loader beim App-Boot aufgerufen. */
export default function register(): void {
  registerWsHandler('tamagotchi:state_update' as never, ((
    evt: TamagotchiStateUpdate
  ) => {
    if (!evt || typeof evt.guild_id !== 'string') return;
    setPet(evt.guild_id, parsePet(evt.state));
  }) as never);
}

/** Deactivate-Hook — räumt den WS-Handler + alle Pet-States ab. */
export function deactivate(): void {
  unregisterWsHandler('tamagotchi:state_update');
  resetAllPets();
}
