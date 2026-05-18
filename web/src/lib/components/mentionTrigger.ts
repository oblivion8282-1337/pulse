/**
 * Helpers extracted from `MessageInput.svelte` so the component stays
 * under the Svelte-size cap. Pure functions — no Svelte state here.
 */

/** Scan the textarea value up to the caret and return the active
 *  `@`-trigger range, or null when the cursor isn't in a mention region.
 *  A trigger qualifies when the `@` is at the start of the input or
 *  preceded by whitespace; any whitespace between the `@` and the caret
 *  ends the region (we don't autocomplete `@he llo`). */
export function detectMentionTrigger(
  value: string,
  caret: number
): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === '@') {
      if (i === 0 || /\s/.test(value[i - 1])) {
        return { start: i, query: value.slice(i + 1, caret) };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

/** Replace the `@…` slice between `start` and `caret` with the given
 *  insertion. Returns the new text + the resulting caret position so
 *  the caller can re-focus and place the cursor in lockstep. */
export function applyMentionInsertion(
  text: string,
  start: number,
  caret: number,
  insertion: string
): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(caret);
  return { text: before + insertion + after, caret: before.length + insertion.length };
}
