/**
 * Schnappschüsse für den Resolver — der gemeinsame Baustein.
 *
 * **Warum getrennt.** Der Resolver (`bitfield.ts`) rechnet mit BigInts und
 * kennt weder Stores noch Wire-Formate. Jede Stelle, die ihn für einen
 * FREMDEN Nutzer füttert (bisher `remote/berechtigte.ts`, jetzt zusätzlich die
 * Kanalrechte-Ansicht), brauchte davor dieselben zwei Umwandlungen: Rollen des
 * Ziels aus dem Rollen-Store holen und die Überschreibungen des Kanals von
 * Strings auf BigInt bringen. Zweimal dieselbe Umwandlung ist genau die
 * Doppelung, vor der `CLAUDE.md` warnt — weicht eine Kopie ab, fällt es erst
 * auf, wenn sie jemandem zu viel erlaubt.
 *
 * **Namen fahren mit.** Die Ansicht muss nicht nur rechnen, sondern auch sagen
 * *woher* ein Ergebnis kommt („aus Moderation", „hier verboten über
 * @everyone"). Dafür brauchen Rolle und Überschreibung einen Namen, den der
 * reine Resolver nicht führt — deshalb die `benannt*`-Varianten daneben.
 */

import type { Overwrite, Role } from '$lib/api/roles';
import { roles as rollenStore } from '$lib/stores/roles.svelte';
import { toBitfield, type OverwriteSnapshot } from './bitfield';
import type { BenannteRolle, BenanntesOverwrite } from './herkunft';

/** Rollen-Schnappschüsse für EIN Ziel: `@everyone` plus die eigenen. Der
 *  Anzeigename fährt mit — der Resolver ignoriert ihn, die Herkunft braucht ihn. */
export function benannteRollen(guildId: string, rollenIds: Set<string>): BenannteRolle[] {
  return (rollenStore.byGuild[guildId] ?? [])
    .filter((r) => r.is_everyone || rollenIds.has(r.id))
    .map(alsBenannteRolle);
}

export function alsBenannteRolle(r: Role): BenannteRolle {
  return {
    id: r.id,
    position: r.position,
    permissions: toBitfield(r.permissions),
    is_everyone: r.is_everyone,
    name: r.name
  };
}

function alsOverwriteSchnappschuss(ow: Overwrite): OverwriteSnapshot {
  return {
    target_type: ow.target_type,
    target_id: ow.target_id,
    allow: toBitfield(ow.allow),
    deny: toBitfield(ow.deny)
  };
}

/** Wire-Überschreibungen (Strings) auf BigInt bringen. */
export function overwriteSchnappschuesse(roh: readonly Overwrite[]): OverwriteSnapshot[] {
  return roh.map(alsOverwriteSchnappschuss);
}

/** Dieselbe Umwandlung mit Anzeigenamen je Überschreibung. */
export function benannteOverwrites(
  roh: readonly Overwrite[],
  name: (ow: Overwrite) => string
): BenanntesOverwrite[] {
  return roh.map((ow) => ({ ...alsOverwriteSchnappschuss(ow), name: name(ow) }));
}

/** Schlüssel einer Überschreibung — `<art>:<id>`, überall derselbe. */
export function zielSchluessel(ow: { target_type: 0 | 1; target_id: string }): string {
  return `${ow.target_type}:${ow.target_id}`;
}

/** Und zurück: `<art>:<id>` auseinandernehmen. Stand fünfmal als
 *  `key.split(':')` + `Number(art) as 0|1` verstreut — eine Stelle, an der ein
 *  abweichendes Format still drei Zielarten verlieren würde. */
export function teileSchluessel(key: string): { art: 0 | 1; id: string } {
  const [rohart, id] = key.split(':');
  return { art: Number(rohart) as 0 | 1, id };
}
