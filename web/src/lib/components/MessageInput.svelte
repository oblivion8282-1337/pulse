<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import SendHorizontalIcon from '@lucide/svelte/icons/send-horizontal';
  import SmilePlusIcon from '@lucide/svelte/icons/smile-plus';
  import XIcon from '@lucide/svelte/icons/x';
  import EmojiPicker from './EmojiPicker.svelte';
  import { expandShortcodes } from '$lib/emoji';

  let {
    placeholder = 'Nachricht senden',
    onSend,
    replyTo = null,
    onCancelReply
  }: {
    placeholder?: string;
    onSend: (text: string) => void;
    replyTo?: { id: string; author: string; snippet: string } | null;
    onCancelReply?: () => void;
  } = $props();

  let text = $state('');
  let pickerOpen = $state(false);
  let textarea: HTMLTextAreaElement | undefined = $state();

  function fire() {
    const value = expandShortcodes(text).trim();
    if (!value) return;
    onSend(value);
    text = '';
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    fire();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && replyTo) {
      e.preventDefault();
      onCancelReply?.();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      fire();
    }
  }

  function insertEmoji(emoji: string) {
    const ta = textarea;
    if (!ta) {
      text = text + emoji;
    } else {
      const start = ta.selectionStart ?? text.length;
      const end = ta.selectionEnd ?? text.length;
      text = text.slice(0, start) + emoji + text.slice(end);
      // Move caret behind the inserted emoji on the next tick.
      queueMicrotask(() => {
        ta.focus();
        const pos = start + emoji.length;
        ta.setSelectionRange(pos, pos);
      });
    }
    pickerOpen = false;
  }
</script>

<form
  class="px-4 pt-2 pb-[calc(1.25rem+env(safe-area-inset-bottom))] md:pb-5"
  onsubmit={submit}
>
  {#if replyTo}
    <div
      class="bg-bg-input mb-1 flex items-center gap-2 rounded-t-xl border border-b-0 border-border px-3 py-1.5 text-xs"
      data-testid="reply-banner"
    >
      <span class="text-text-muted">Antwort an</span>
      <span class="text-text-bright font-semibold">{replyTo.author}</span>
      <span class="text-text-muted truncate">— {replyTo.snippet}</span>
      <button
        type="button"
        class="text-text-muted hover:text-text-bright ml-auto rounded p-0.5"
        aria-label="Antwort abbrechen"
        onclick={() => onCancelReply?.()}
      >
        <XIcon class="size-3.5" />
      </button>
    </div>
  {/if}
  <div
    class="bg-bg-input flex items-end gap-2 border border-border px-4 py-3 backdrop-blur-sm
           {replyTo ? 'rounded-b-2xl rounded-t-none' : 'rounded-2xl'}"
  >
    <textarea
      bind:this={textarea}
      rows="1"
      bind:value={text}
      onkeydown={onKeydown}
      {placeholder}
      class="text-text-bright placeholder:text-text-muted max-h-40 min-h-[1.5rem] flex-1 resize-none border-0 bg-transparent text-[15px] outline-none"
      data-testid="message-input"
    ></textarea>
    <DropdownMenu.Root bind:open={pickerOpen}>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="text-text-muted hover:bg-bg-hover hover:text-text-bright rounded-md p-1.5"
            aria-label="Emoji einfügen"
            data-testid="emoji-button"
          >
            <SmilePlusIcon class="size-5" />
          </button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        side="top"
        align="end"
        sideOffset={6}
        class="w-auto max-w-[calc(100vw-1rem)] overflow-visible border-0 bg-transparent p-0 shadow-none"
      >
        <EmojiPicker onPick={insertEmoji} />
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    <Button
      type="submit"
      size="icon-sm"
      disabled={!text.trim()}
      data-testid="message-send"
      aria-label="Senden"
    >
      <SendHorizontalIcon />
    </Button>
  </div>
</form>
