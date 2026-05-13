/** Emoji utilities — types, shortcode expansion, and category metadata.
 *  The catalog itself lives in `emoji-data.ts` (one source of truth, kept
 *  separate so this file stays under the 350-line policy as it grows). */

export type EmojiCategory =
  | 'smileys'
  | 'gestures'
  | 'hearts'
  | 'nature'
  | 'food'
  | 'travel'
  | 'objects'
  | 'flags';

export type EmojiEntry = {
  emoji: string;
  /** Primary shortcode (without colons). Lookup is exact-match. */
  name: string;
  category: EmojiCategory;
  /** Optional aliases — e.g. `:+1:` for thumbs-up. */
  aliases?: string[];
};

export { EMOJIS } from './emoji-data';
import { EMOJIS } from './emoji-data';

/** Map of every name+alias → emoji. Built once at module load. */
export const SHORTCODE_MAP: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const e of EMOJIS) {
    m[e.name] = e.emoji;
    for (const a of e.aliases ?? []) m[a] = e.emoji;
  }
  return m;
})();

/** Replace `:name:` runs with the matching emoji. Unknown shortcodes are
 *  left untouched so a real `:colon-word:` in code or jargon survives.
 *  Conservative pattern: [a-z0-9_+\-] only, max 32 chars. */
export function expandShortcodes(text: string): string {
  return text.replace(/:([a-z0-9_+-]{1,32}):/gi, (match, name: string) => {
    const e = SHORTCODE_MAP[name.toLowerCase()];
    return e ?? match;
  });
}

export const CATEGORY_LABELS: Record<EmojiCategory, string> = {
  smileys: 'Smileys',
  gestures: 'Gesten',
  hearts: 'Herzen',
  nature: 'Natur',
  food: 'Essen',
  travel: 'Reisen',
  objects: 'Sonstiges',
  flags: 'Flaggen'
};

export const CATEGORY_ORDER: EmojiCategory[] = [
  'smileys',
  'gestures',
  'hearts',
  'nature',
  'food',
  'travel',
  'objects',
  'flags'
];
