/**
 * Die Rechnung hinter dem serverseitigen Lesefortschritt (P0.2) —
 * importfrei, damit der eingebaute Testlauf sie ohne Svelte-Runes prüfen
 * kann (Repo-Muster: reine Kerne neben `$state`-Stores, s. CLAUDE.md
 * „Zwei Fallen“).
 *
 * IDs sind numerisch-opak (Snowflake bzw. lokale E2EE-ID) und vergleichen
 * sich über `compareSnowflakeId` — ein String-Vergleich bricht an der
 * Stellen-Grenze und bei den 20-stelligen lokalen IDs.
 *
 * Importfrei: relative Imports statt `$lib`, damit der Node-Testlauf das
 * Modul ohne SvelteKit-Auflöser laden kann.
 */
import { compareSnowflakeId } from '../utils/snowflake.ts';

/** Vorwärts-Merge: der größere Stand gilt. `prev` fehlt (undefined) → `next`. */
export function vorwaertsMerge(prev: string | undefined, next: string): string {
  if (prev && compareSnowflakeId(next, prev) <= 0) return prev;
  return next;
}

/**
 * Lesebestätigung für eine eigene Nachricht: `true` = die Gegenstelle hat
 * mindestens bis `messageId` gelesen, `false` = noch nicht, `null` = keine
 * Auskunft (kein Partner-Stand bekannt — Häkchen zeigt nur „zugestellt“).
 */
export function istGelesenBis(partnerStand: string | undefined, messageId: string): boolean | null {
  if (!partnerStand) return null;
  return compareSnowflakeId(partnerStand, messageId) >= 0;
}

/**
 * Die ID, an der Lesestand für eine Nachricht geankert wird. Auf dem
 * verschlüsselten Weg kennt der Empfänger die Nachricht unter seiner
 * Zustellungs-ID (`id`, Server-Snowflake) — der Absender aber unter seiner
 * lokalen ID. Anker auf SEITENVERSCHIEDENE IDs lässt das Lese-Häkchen nie
 * zustande kommen (Befund B3, Testrunde 2026-09-11): dieselbe Nachricht,
 * ~200 ms auseinander, Vergleich sagt „neuer als der Stand“. Die kanonische
 * Absender-ID fährt verschlüsselt im Umschlag mit (`krypto_id`) — dort
 * ankern, dann führen Sender und Empfänger dieselbe Kennung je Nachricht.
 * Der Klartext-Weg hat kein `krypto_id` und bleibt bei der eigenen ID.
 */
export function lesestandAnker(nachricht: { id: string; krypto_id?: string }): string {
  return nachricht.krypto_id ?? nachricht.id;
}
