/**
 * Gemeinsame Such-Norm für die Personen-/Kanalsuchen (Chats, Freunde).
 *
 * Drei Abgleich-Pfade für Namen MIT Zahlen, damit „TestoTobi69" auch über
 * „testotobi" und „Br3xX" auch über „brex" gefunden wird:
 *   1. voller normalisierter Name   — „br3"  → br3xx
 *   2. zifferngestrippter Name      — „brx"  → brxx
 *   3. Leet-übersetzter Name        — „brex" → brexx (3→e, 0→o, 1→i, 4→a, 5→s, 7→t)
 * Pfad 3 übersetzt die EINGABE mit derselben Tabelle — sonst bliebe die
 * Regel asymmetrisch („13" getippt sollte „ie" im Namen erreichen können).
 */

/** Klein, Akzente abgezogen, alles außer Buchstaben/Zahlen raus. */
export function suchnorm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Verbreitete Ziffern-Ersätze zurückübersetzen. `1` wird zu `i` — in Namen
 * häufiger als `l`; wer beides will, tippt den vollen Namen (Pfad 1). */
function leet(s: string): string {
  return s.replace(/3/g, 'e').replace(/0/g, 'o').replace(/1/g, 'i')
    .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't');
}

/** Passt die (bereits normalisierte, ≥3-Zeichen-)Eingabe auf den Namen?
 *  `name` wird hier roh hereingereicht und selbst normalisiert. */
export function namePasst(name: string, begriff: string): boolean {
  const n = suchnorm(name);
  if (n.includes(begriff)) return true;
  const ohnez = n.replace(/\p{N}/gu, '');
  if (ohnez && ohnez.includes(begriff)) return true;
  return leet(n).includes(leet(begriff));
}
