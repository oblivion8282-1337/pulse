/**
 * Reaktiver Pro-Guild Pet-State-Store (Svelte 5 Runes).
 *
 * Hier wohnen die ``$state``-Maps — der Plugin-Entry (``frontend.ts``)
 * darf keine Runes benutzen (Vite-Glob erwartet `.ts`, Runes brauchen
 * `.svelte.ts`). Die Action-Funktionen und der WS-Handler in
 * ``frontend.ts`` arbeiten auf diesem Store.
 *
 * Modell: ``Map<guildId, PetState>``. Object-Reassign statt Map-Mutation,
 * damit Svelte-5 das Re-Render zuverlässig triggert.
 */
import type { PetState } from './store';

interface PetStoreState {
  byGuild: Record<string, PetState>;
  loadingByGuild: Set<string>;
}

const state = $state<PetStoreState>({
  byGuild: {},
  loadingByGuild: new Set()
});

export function getPet(guildId: string): PetState | null {
  if (!guildId) return null;
  return state.byGuild[guildId] ?? null;
}

export function setPet(guildId: string, value: PetState): void {
  if (!guildId) return;
  state.byGuild = { ...state.byGuild, [guildId]: value };
}

export function deletePet(guildId: string): void {
  if (!guildId) return;
  const copy = { ...state.byGuild };
  delete copy[guildId];
  state.byGuild = copy;
}

export function isLoading(guildId: string): boolean {
  return state.loadingByGuild.has(guildId);
}

export function markLoading(guildId: string, loading: boolean): void {
  if (loading) state.loadingByGuild.add(guildId);
  else state.loadingByGuild.delete(guildId);
}

export function clearAll(): void {
  state.byGuild = {};
  state.loadingByGuild.clear();
}
