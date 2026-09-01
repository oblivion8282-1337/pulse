<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import ReplyIcon from '@lucide/svelte/icons/reply';
  import SmilePlusIcon from '@lucide/svelte/icons/smile-plus';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import FlagIcon from '@lucide/svelte/icons/flag';
  import PinIcon from '@lucide/svelte/icons/pin';
  import PinOffIcon from '@lucide/svelte/icons/pin-off';
  import EmojiPicker from './EmojiPicker.svelte';

  let {
    canEdit,
    canDelete,
    canReport = false,
    canPin = false,
    pinned = false,
    onReply,
    onEdit,
    onDelete,
    onReact,
    onReport,
    onTogglePin
  }: {
    canEdit: boolean;
    canDelete: boolean;
    canReport?: boolean;
    canPin?: boolean;
    pinned?: boolean;
    onReply: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onReact: (emoji: string) => void;
    onReport?: () => void;
    onTogglePin?: () => void;
  } = $props();

  let pickerOpen = $state(false);

  function pick(emoji: string) {
    onReact(emoji);
    pickerOpen = false;
  }
</script>

<div
  class="bg-popover absolute -top-3 right-3 items-center gap-0.5 rounded-xl border border-border p-0.5 shadow-md backdrop-blur-xl
         {pickerOpen ? 'flex' : 'hidden group-hover:flex'}"
  data-testid="message-actions"
>
  <DropdownMenu.Root bind:open={pickerOpen}>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="icon-sm"
          title={m.message_actions_add_reaction()}
          aria-label={m.message_actions_add_reaction()}
          data-testid="message-action-react"
        >
          <SmilePlusIcon class="size-4" />
        </Button>
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

  <Button
    variant="ghost"
    size="icon-sm"
    title={m.message_actions_reply()}
    aria-label={m.message_actions_reply()}
    data-testid="message-action-reply"
    onclick={onReply}
  >
    <ReplyIcon class="size-4" />
  </Button>

  {#if canEdit}
    <Button
      variant="ghost"
      size="icon-sm"
      title={m.message_actions_edit()}
      aria-label={m.message_actions_edit()}
      data-testid="message-action-edit"
      onclick={onEdit}
    >
      <PencilIcon class="size-4" />
    </Button>
  {/if}

  {#if canPin && onTogglePin}
    <Button
      variant="ghost"
      size="icon-sm"
      title={pinned ? m.message_actions_unpin() : m.message_actions_pin()}
      aria-label={pinned ? m.message_actions_unpin() : m.message_actions_pin()}
      data-testid={pinned ? 'message-action-unpin' : 'message-action-pin'}
      onclick={onTogglePin}
    >
      {#if pinned}
        <PinOffIcon class="size-4" />
      {:else}
        <PinIcon class="size-4" />
      {/if}
    </Button>
  {/if}

  {#if canDelete}
    <Button
      variant="ghost"
      size="icon-sm"
      class="hover:text-destructive"
      title={m.message_actions_delete()}
      aria-label={m.message_actions_delete()}
      data-testid="message-action-delete"
      onclick={onDelete}
    >
      <Trash2Icon class="size-4" />
    </Button>
  {/if}

  {#if canReport}
    <Button
      variant="ghost"
      size="icon-sm"
      class="hover:text-warning"
      title={m.message_actions_report()}
      aria-label={m.message_actions_report()}
      data-testid="message-action-report"
      onclick={onReport}
    >
      <FlagIcon class="size-4" />
    </Button>
  {/if}
</div>
