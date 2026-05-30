<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import SmilePlusIcon from '@lucide/svelte/icons/smile-plus';
  import EmojiPicker from './EmojiPicker.svelte';
  import type { ReactionAggregate } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let {
    reactions,
    onToggle
  }: {
    reactions: ReactionAggregate[];
    onToggle: (emoji: string, currentlyMine: boolean) => void;
  } = $props();

  let pickerOpen = $state(false);
  function pick(emoji: string) {
    onToggle(emoji, false);
    pickerOpen = false;
  }
</script>

{#if reactions.length > 0}
  <div class="mt-1 flex flex-wrap items-center gap-1" data-testid="message-reactions">
    {#each reactions as r (r.emoji)}
      <button
        type="button"
        class="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors
               {r.me ? 'border-primary bg-[var(--accent-soft)] text-primary' : 'border-border bg-bg-input text-text-muted hover:bg-bg-hover'}"
        data-testid="reaction-pill"
        data-emoji={r.emoji}
        data-mine={r.me}
        title={r.me ? m.message_reactions_remove_reaction() : m.message_reactions_react()}
        onclick={() => onToggle(r.emoji, r.me)}
      >
        <span class="text-base leading-none">{r.emoji}</span>
        <span class="font-mono">{r.count}</span>
      </button>
    {/each}
    <DropdownMenu.Root bind:open={pickerOpen}>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="text-text-muted hover:bg-bg-hover rounded-full border border-border bg-bg-input px-2 py-0.5"
            title={m.message_reactions_add_reaction()}
            aria-label={m.message_reactions_add_reaction()}
            data-testid="reaction-add"
          >
            <SmilePlusIcon class="size-3.5" />
          </button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        side="top"
        align="start"
        sideOffset={6}
        class="w-auto max-w-[calc(100vw-1rem)] overflow-visible border-0 bg-transparent p-0 shadow-none"
      >
        <EmojiPicker onPick={pick} />
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
{/if}
