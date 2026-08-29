/**
 * Das aktuell angemeldete Konto fuer den lokalen Verlauf — reine Verdrahtung
 * (nicht importfrei, haengt an `$lib/stores/auth.svelte`), s.
 * `kontoFilter.ts` fuer die eigentliche Entscheidung.
 *
 * Dieselbe ID, die `stores/auth.svelte.ts::_enforceDeviceOwner` als
 * Geraete-Besitzer traegt (`pulse.identity_owner`): die Cloud-User-ID
 * `auth.user.id`. DMs/Postfach sind eine Cloud-Funktion (`kopplung/*.ts`
 * routet ausdruecklich ueber `serversStore.cloudId()`); ein Self-Host-
 * Session-Token spielt hier keine Rolle.
 *
 * `null`, solange niemand angemeldet ist — jeder Aufrufer behandelt das als
 * „kein Konto, kein Zugriff", nicht als Sonderfall.
 */
import { auth } from '$lib/stores/auth.svelte';

export function aktuellesKonto(): string | null {
  return auth.user?.id ?? null;
}
