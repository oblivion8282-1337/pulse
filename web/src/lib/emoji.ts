/** Curated emoji set — kept deliberately small (≈ 100 entries) to avoid
 *  shipping a full emoji-mart catalog. Covers the common reactions + the
 *  most-typed `:shortcode:` aliases. Adding more is a one-line entry below. */

export type EmojiCategory = 'smileys' | 'gestures' | 'hearts' | 'objects' | 'nature' | 'food';

export type EmojiEntry = {
  emoji: string;
  /** Primary shortcode (without colons). Lookup is exact-match. */
  name: string;
  category: EmojiCategory;
  /** Optional aliases — e.g. `:+1:` for thumbs-up. */
  aliases?: string[];
};

export const EMOJIS: EmojiEntry[] = [
  // smileys
  { emoji: '😀', name: 'grinning', category: 'smileys' },
  { emoji: '😄', name: 'smile', category: 'smileys' },
  { emoji: '😁', name: 'grin', category: 'smileys' },
  { emoji: '😂', name: 'joy', category: 'smileys' },
  { emoji: '🤣', name: 'rofl', category: 'smileys' },
  { emoji: '😊', name: 'blush', category: 'smileys' },
  { emoji: '😉', name: 'wink', category: 'smileys' },
  { emoji: '😍', name: 'heart_eyes', category: 'smileys' },
  { emoji: '🥰', name: 'smiling_face_with_hearts', category: 'smileys' },
  { emoji: '😘', name: 'kissing_heart', category: 'smileys' },
  { emoji: '😎', name: 'sunglasses', category: 'smileys' },
  { emoji: '🤔', name: 'thinking', category: 'smileys' },
  { emoji: '🙃', name: 'upside_down', category: 'smileys' },
  { emoji: '😴', name: 'sleeping', category: 'smileys' },
  { emoji: '😭', name: 'sob', category: 'smileys' },
  { emoji: '😱', name: 'scream', category: 'smileys' },
  { emoji: '😡', name: 'rage', category: 'smileys' },
  { emoji: '🤯', name: 'exploding_head', category: 'smileys' },
  { emoji: '🤡', name: 'clown', category: 'smileys' },
  { emoji: '🥳', name: 'partying', category: 'smileys' },
  { emoji: '🤓', name: 'nerd', category: 'smileys' },
  { emoji: '😅', name: 'sweat_smile', category: 'smileys' },
  { emoji: '🙄', name: 'eye_roll', category: 'smileys' },
  { emoji: '😬', name: 'grimace', category: 'smileys' },
  { emoji: '🥲', name: 'tear_smile', category: 'smileys' },

  // gestures / people
  { emoji: '👍', name: 'thumbsup', category: 'gestures', aliases: ['+1', 'plus1'] },
  { emoji: '👎', name: 'thumbsdown', category: 'gestures', aliases: ['-1'] },
  { emoji: '👌', name: 'ok_hand', category: 'gestures' },
  { emoji: '👏', name: 'clap', category: 'gestures' },
  { emoji: '🙏', name: 'pray', category: 'gestures' },
  { emoji: '🤝', name: 'handshake', category: 'gestures' },
  { emoji: '💪', name: 'muscle', category: 'gestures' },
  { emoji: '✌️', name: 'peace', category: 'gestures' },
  { emoji: '🤞', name: 'crossed_fingers', category: 'gestures' },
  { emoji: '🫡', name: 'salute', category: 'gestures' },
  { emoji: '🤘', name: 'metal', category: 'gestures' },
  { emoji: '👋', name: 'wave', category: 'gestures' },
  { emoji: '🫶', name: 'heart_hands', category: 'gestures' },
  { emoji: '🤷', name: 'shrug', category: 'gestures' },
  { emoji: '🙈', name: 'see_no_evil', category: 'gestures' },

  // hearts
  { emoji: '❤️', name: 'heart', category: 'hearts' },
  { emoji: '🧡', name: 'orange_heart', category: 'hearts' },
  { emoji: '💛', name: 'yellow_heart', category: 'hearts' },
  { emoji: '💚', name: 'green_heart', category: 'hearts' },
  { emoji: '💙', name: 'blue_heart', category: 'hearts' },
  { emoji: '💜', name: 'purple_heart', category: 'hearts' },
  { emoji: '🖤', name: 'black_heart', category: 'hearts' },
  { emoji: '🤍', name: 'white_heart', category: 'hearts' },
  { emoji: '💔', name: 'broken_heart', category: 'hearts' },
  { emoji: '❣️', name: 'heart_exclamation', category: 'hearts' },
  { emoji: '💖', name: 'sparkling_heart', category: 'hearts' },
  { emoji: '💕', name: 'two_hearts', category: 'hearts' },

  // nature
  { emoji: '🔥', name: 'fire', category: 'nature' },
  { emoji: '🌟', name: 'star', category: 'nature' },
  { emoji: '✨', name: 'sparkles', category: 'nature' },
  { emoji: '🌈', name: 'rainbow', category: 'nature' },
  { emoji: '☀️', name: 'sun', category: 'nature' },
  { emoji: '🌙', name: 'moon', category: 'nature' },
  { emoji: '⚡', name: 'zap', category: 'nature' },
  { emoji: '🌸', name: 'cherry_blossom', category: 'nature' },
  { emoji: '🐶', name: 'dog', category: 'nature' },
  { emoji: '🐱', name: 'cat', category: 'nature' },
  { emoji: '🦄', name: 'unicorn', category: 'nature' },
  { emoji: '🐸', name: 'frog', category: 'nature' },

  // food
  { emoji: '🍕', name: 'pizza', category: 'food' },
  { emoji: '🍔', name: 'burger', category: 'food' },
  { emoji: '🍟', name: 'fries', category: 'food' },
  { emoji: '🌮', name: 'taco', category: 'food' },
  { emoji: '🍣', name: 'sushi', category: 'food' },
  { emoji: '🍩', name: 'donut', category: 'food' },
  { emoji: '🍪', name: 'cookie', category: 'food' },
  { emoji: '🍰', name: 'cake', category: 'food' },
  { emoji: '☕', name: 'coffee', category: 'food' },
  { emoji: '🍺', name: 'beer', category: 'food' },
  { emoji: '🍷', name: 'wine', category: 'food' },
  { emoji: '🥤', name: 'cup', category: 'food' },

  // objects / symbols
  { emoji: '✅', name: 'check', category: 'objects', aliases: ['white_check_mark'] },
  { emoji: '❌', name: 'x', category: 'objects' },
  { emoji: '⭐', name: 'star_y', category: 'objects' },
  { emoji: '🎉', name: 'tada', category: 'objects' },
  { emoji: '🎂', name: 'birthday', category: 'objects' },
  { emoji: '🎁', name: 'gift', category: 'objects' },
  { emoji: '💯', name: '100', category: 'objects' },
  { emoji: '💀', name: 'skull', category: 'objects' },
  { emoji: '👀', name: 'eyes', category: 'objects' },
  { emoji: '🚀', name: 'rocket', category: 'objects' },
  { emoji: '🐛', name: 'bug', category: 'objects' },
  { emoji: '🎮', name: 'video_game', category: 'objects' },
  { emoji: '🎵', name: 'note', category: 'objects' },
  { emoji: '📌', name: 'pin', category: 'objects' },
  { emoji: '🔗', name: 'link', category: 'objects' },
  { emoji: '⚠️', name: 'warning', category: 'objects' },
  { emoji: '👁️', name: 'eye', category: 'objects' }
];

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
  objects: 'Sonstiges'
};

export const CATEGORY_ORDER: EmojiCategory[] = [
  'smileys',
  'gestures',
  'hearts',
  'nature',
  'food',
  'objects'
];
