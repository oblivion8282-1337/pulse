/**
 * Spiegel der Anti-Eskalation fuer das Zuweisen einer Rolle.
 *
 * Der Server entscheidet (`assert_overwrite_within_editor_scope` und die
 * Hierarchie-Pruefung in `roles.py`); das hier haelt nur die Bedienung
 * ehrlich, damit niemand einen Schalter umlegt, den der Server gleich
 * wieder ablehnt. Steht als eigene Datei da, weil ZWEI Ansichten dieselbe
 * Frage stellen: die mitgliederzentrierte (`MemberRoleAssignment`, „welche
 * Rollen hat dieser Mensch") und die rollenzentrierte (`RolleTraeger`,
 * „wer traegt diese Rolle"). Zwei Kopien derselben Regel driften.
 */

import { Perm, has, toBitfield } from '$lib/permissions/bitfield';
import type { Role } from '$lib/api/roles';
import { m } from '$lib/paraglide/messages.js';

export type Sperre = { gesperrt: boolean; grund: string | null };

/** Darf der Bearbeiter diese Rolle vergeben bzw. entziehen? Er muss jedes
 * Bit selbst halten, das die Rolle gewaehrt. ADMINISTRATOR ist die
 * haeufigste Falle und bekommt deshalb einen eigenen Text. */
export function sperreFuer(role: Role, editorPermissions: string): Sperre {
  const rollenBits = toBitfield(role.permissions);
  const bearbeiterBits = toBitfield(editorPermissions);
  if ((rollenBits & ~bearbeiterBits) === 0n) return { gesperrt: false, grund: null };
  if (has(rollenBits, Perm.ADMINISTRATOR) && !has(bearbeiterBits, Perm.ADMINISTRATOR)) {
    return { gesperrt: true, grund: m.member_role_assignment_locked_admin() };
  }
  return { gesperrt: true, grund: m.member_role_assignment_locked_missing_bits() };
}
