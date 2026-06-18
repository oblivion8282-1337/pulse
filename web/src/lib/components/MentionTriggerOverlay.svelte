<!--
  MentionTriggerOverlay — wires the `@`-trigger detection + insertion to
  the host textarea. Owns the popup state (`mentionOpen`, `mentionQuery`,
  `mentionStart`) and the `MentionAutocomplete` mount; the host keeps the
  textarea value, calls `update()` on caret-moving events, and forwards
  key events through `handleKey()`. Pure plumbing — no behaviour change
  vs. the inline version that previously lived in `MessageInput.svelte`.
-->
<script lang="ts">
  import MentionAutocomplete from './MentionAutocomplete.svelte';
  import { detectMentionTrigger, applyMentionInsertion } from './mentionTrigger';

  let {
    value,
    textareaEl,
    guildId,
    onChange
  }: {
    value: string;
    textareaEl: HTMLTextAreaElement | undefined;
    guildId: string | null;
    /** Reserved: Snowflake of the signed-in user; will be used to filter
     *  self out of the suggestion list. Accepted but ignored today. */
    currentUserId?: string | null;
    onChange: (text: string) => void;
  } = $props();

  let mentionOpen = $state(false);
  let mentionQuery = $state('');
  let mentionStart = $state<number>(-1);
  let autocomplete: MentionAutocomplete | undefined = $state();
  // Tracks display→markup replacements for mentions inserted via autocomplete.
  // `toMarkup` converts the human-readable textarea text back to wire format.
  let _replacements: { display: string; markup: string }[] = [];

  /** Recompute the trigger range from the current caret position. Called
   *  from the host on `oninput`/`onkeyup`/`onclick`. */
  export function update(): void {
    if (!textareaEl) return;
    // Composition reset: once the textarea is empty, drop tracked replacements
    // so a later manually-typed `@Name` is not silently rewritten into a real
    // mention by a stale entry from an abandoned autocomplete.
    if (value === '') _replacements = [];
    const caret = textareaEl.selectionStart ?? value.length;
    const trig = detectMentionTrigger(value, caret);
    if (trig) {
      mentionOpen = true;
      mentionStart = trig.start;
      mentionQuery = trig.query;
    } else if (mentionOpen) {
      mentionOpen = false;
      mentionStart = -1;
    }
  }

  /** Close the popup — host calls this on textarea `onblur`. */
  export function close(): void {
    mentionOpen = false;
  }

  /** First-dibs key handling for ↑/↓/Enter/Tab/Esc. Returns true when the
   *  event was consumed so the host can short-circuit its own keydown. */
  export function handleKey(e: KeyboardEvent): boolean {
    if (!mentionOpen) return false;
    return autocomplete?.handleKey(e) ?? false;
  }

  function applyMention(display: string, markup: string) {
    if (!textareaEl || mentionStart < 0) return;
    const caret = textareaEl.selectionStart ?? value.length;
    const next = applyMentionInsertion(value, mentionStart, caret, display);
    _replacements.push({ display, markup });
    onChange(next.text);
    mentionOpen = false;
    mentionStart = -1;
    queueMicrotask(() => {
      textareaEl?.focus();
      textareaEl?.setSelectionRange(next.caret, next.caret);
    });
  }

  /**
   * Convert the human-readable display text (with `@Username`) back to wire
   * markup (with `<@id>`). Call this on the trimmed textarea value just
   * before sending.
   *
   * Each replacement is matched to a concrete occurrence in `text` by
   * scanning left-to-right and consuming occurrences sequentially per display
   * string. This keys replacements to text **position**, not insertion order —
   * so two same-name mentions inserted out of left-to-right order (cursor moved
   * back) still resolve to the user actually chosen at each spot. Matches are
   * then applied right-to-left so earlier slice indices stay valid.
   *
   * Also handles the trim edge-case: if the message ends with a mention and
   * the trailing space was removed by `.trim()`, the trimmless form is tried.
   */
  export function toMarkup(text: string): string {
    // Per display string, track where the next search should resume so that
    // repeated identical displays consume successive occurrences left-to-right.
    const searchFrom = new Map<string, number>();
    const matches: { idx: number; len: number; markup: string }[] = [];
    for (const { display, markup } of _replacements) {
      let needle = display;
      let repl = markup;
      let from = searchFrom.get(needle) ?? 0;
      let idx = text.indexOf(needle, from);
      if (idx < 0) {
        // Trailing-space was stripped by .trim() — try without it.
        needle = display.trimEnd();
        repl = markup.trimEnd();
        from = searchFrom.get(needle) ?? 0;
        idx = text.indexOf(needle, from);
      }
      if (idx < 0) continue;
      searchFrom.set(needle, idx + needle.length);
      matches.push({ idx, len: needle.length, markup: repl });
    }
    matches.sort((a, b) => b.idx - a.idx);
    let result = text;
    for (const { idx, len, markup } of matches) {
      result = result.slice(0, idx) + markup + result.slice(idx + len);
    }
    return result;
  }

  /** Clear tracked replacements after a message is sent. */
  export function clear(): void {
    _replacements = [];
  }
</script>

<MentionAutocomplete
  bind:this={autocomplete}
  open={mentionOpen}
  query={mentionQuery}
  {guildId}
  onPick={(display, markup) => applyMention(display, markup)}
  onClose={() => { mentionOpen = false; }}
/>
