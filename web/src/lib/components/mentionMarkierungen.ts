/**
 * Erwaehnungs-Marker (`<@id>`, `<@&id>`, `@everyone`/`@here`) roh aus dem
 * Nachrichtentext herausgeloest — importfrei bis auf einen Typ-Import
 * (`import type` wird von Nodes eingebautem Testlaeufer vollstaendig
 * entfernt, s. `pnpm test:unit`-Falle in `CLAUDE.md`), damit die Rechnung
 * selbst pruefbar ist.
 *
 * Herausgezogen aus `messageRender.ts` (das dort verbleibende
 * `parseMentionMarkers` re-exportiert nur noch diese Funktion) — zwei
 * Aufrufer brauchen sie:
 *  1. Die optimistische Echo-Nachricht des Klartext-Wegs (`+page.svelte`,
 *     schon vor dieser Auslagerung).
 *  2. Der verschluesselte Weg (`krypto/senden.ts`/`krypto/empfangen.ts`):
 *     dort gibt es KEINE serverseitige Mention-Erkennung (der Server sieht
 *     den Klartext nie), also ist diese lokale Rechnung dort die EINZIGE
 *     Quelle fuer `Message.mentions` — ohne sie zeigt `renderMessage` die
 *     rohe `<@id>`-Markierung samt interner Snowflake an.
 */
import type { Mention } from '$lib/api/types';

export function parseMentionMarkers(content: string): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  const add = (type: 0 | 1 | 2, id: string) => {
    const key = `${type}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ type, id });
  };
  for (const m of content.matchAll(/<@(\d{1,20})>/g)) add(0, m[1]);
  for (const m of content.matchAll(/<@&(\d{1,20})>/g)) add(1, m[1]);
  if (/@(everyone|here)\b/.test(content)) add(2, '0');
  return out;
}
