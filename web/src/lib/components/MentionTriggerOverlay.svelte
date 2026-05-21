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
   * before sending — the order of replacements mirrors insertion order so
   * two mentions of same-name users resolve correctly.
   *
   * Also handles the trim edge-case: if the message ends with a mention and
   * the trailing space was removed by `.trim()`, the trimmless form is tried.
   */
  export function toMarkup(text: string): string {
    let result = text;
    for (const { display, markup } of _replacements) {
      const idx = result.indexOf(display);
      if (idx >= 0) {
        result = result.slice(0, idx) + markup + result.slice(idx + display.length);
      } else {
        // Trailing-space was stripped by .trim() — try without it.
        const d = display.trimEnd();
        const m = markup.trimEnd();
        const i2 = result.indexOf(d);
        if (i2 >= 0) {
          result = result.slice(0, i2) + m + result.slice(i2 + d.length);
        }
      }
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
