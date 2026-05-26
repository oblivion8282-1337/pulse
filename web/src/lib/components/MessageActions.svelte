<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import ReplyIcon from '@lucide/svelte/icons/reply';
  import SmilePlusIcon from '@lucide/svelte/icons/smile-plus';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import FlagIcon from '@lucide/svelte/icons/flag';
  import EmojiPicker from './EmojiPicker.svelte';

  let {
    canEdit,
    canDelete,
    canReport = false,
    onReply,
    onEdit,
    onDelete,
    onReact,
    onReport
  }: {
    canEdit: boolean;
    canDelete: boolean;
    canReport?: boolean;
    onReply: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onReact: (emoji: string) => void;
    onReport?: () => void;
  } = $props();

  let pickerOpen = $state(false);

  function pick(emoji: string) {
    onReact(emoji);
    pickerOpen = false;
  }
</script>

<div
  class="bg-popover absolute -top-3 right-3 items-center gap-0.5 rounded-lg border border-border p-0.5 shadow-md backdrop-blur-xl
         {pickerOpen ? 'flex' : 'hidden group-hover:flex'}"
  data-testid="message-actions"
>
  <DropdownMenu.Root bind:open={pickerOpen}>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="text-text-muted hover:bg-bg-hover hover:text-text-bright rounded-md p-1.5"
          title="Reaktion hinzufügen"
          aria-label="Reaktion hinzufügen"
          data-testid="message-action-react"
        >
          <SmilePlusIcon class="size-4" />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content
      side="top"
      align="end"
      sideOffset={6}
      class="w-auto max-w-[calc(100vw-1rem)] overflow-visible border-0 bg-transparent p-0 shadow-none"
    >
      <EmojiPicker onPick={pick} />
    </DropdownMenu.Content>
  </DropdownMenu.Root>

  <button
    type="button"
    class="text-text-muted hover:bg-bg-hover hover:text-text-bright rounded-md p-1.5"
    title="Antworten"
    aria-label="Antworten"
    data-testid="message-action-reply"
    onclick={onReply}
  >
    <ReplyIcon class="size-4" />
  </button>

  {#if canEdit}
    <button
      type="button"
      class="text-text-muted hover:bg-bg-hover hover:text-text-bright rounded-md p-1.5"
      title="Bearbeiten"
      aria-label="Bearbeiten"
      data-testid="message-action-edit"
      onclick={onEdit}
    >
      <PencilIcon class="size-4" />
    </button>
  {/if}

  {#if canDelete}
    <button
      type="button"
      class="text-text-muted hover:bg-bg-hover hover:text-red-400 rounded-md p-1.5"
      title="Löschen"
      aria-label="Löschen"
      data-testid="message-action-delete"
      onclick={onDelete}
    >
      <Trash2Icon class="size-4" />
    </button>
  {/if}

  {#if canReport}
    <button
      type="button"
      class="text-text-muted hover:bg-bg-hover hover:text-amber-400 rounded-md p-1.5"
      title="Melden"
      aria-label="Melden"
      data-testid="message-action-report"
      onclick={onReport}
    >
      <FlagIcon class="size-4" />
    </button>
  {/if}
</div>
