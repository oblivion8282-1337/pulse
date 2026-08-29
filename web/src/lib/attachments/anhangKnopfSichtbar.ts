/**
 * Ob die Büroklammer im Eingabefeld erscheint — importfrei, damit sie ohne
 * Svelte/Runes-Kompilierung prüfbar ist (s. CLAUDE.md „Zwei Fallen").
 *
 * Für DMs gilt seit 2026-08-29 die umgekehrte Reihenfolge: der Knopf ist
 * zuerst NICHT da und erscheint erst, sobald bekannt ist, dass das Gespräch
 * verschlüsselt läuft oder der Server den Klartext-Weg ausdrücklich erlaubt.
 * Ein permissiver Vorgabewert für „Auskunft noch unterwegs" wäre in der
 * Cloud (`cloud_dm_attachments_enabled = false`) fast immer falsch — die
 * Antwort lautet dort fast immer „nein", und ein kurz aufblitzender Knopf,
 * der gleich wieder verschwindet, ist schlechter als ein etwas später
 * erscheinender.
 */
export function anhangKnopfSichtbar(
  headerKind: 'channel' | 'dm' | 'gruppe',
  verschluesselt: boolean,
  serverErlaubtKlartext: boolean | undefined
): boolean {
  if (headerKind === 'gruppe') return verschluesselt;
  if (headerKind !== 'dm') return true;
  // Drei Zustände statt zwei: `undefined` (Auskunft noch unterwegs) und
  // `false` (ausdrücklich verboten) führen beide zu keinem Knopf — nur ein
  // strenges `true` schaltet ihn frei.
  return verschluesselt || serverErlaubtKlartext === true;
}
