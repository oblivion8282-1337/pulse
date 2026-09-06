<script lang="ts">
  /**
   * Touch-only bottom sheet for message actions. The hover toolbar
   * (`MessageActions.svelte`) is invisible without a pointer hover — on
   * touch this sheet is the only path to react / reply / edit / delete.
   * Opened via `use:longpress` on the message row.
   */
  import BottomSheet from '$lib/components/mobile/BottomSheet.svelte';
  import ReplyIcon from '@lucide/svelte/icons/reply';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import SmilePlusIcon from '@lucide/svelte/icons/smile-plus';
  import FlagIcon from '@lucide/svelte/icons/flag';
  import PinIcon from '@lucide/svelte/icons/pin';
  import PinOffIcon from '@lucide/svelte/icons/pin-off';
  import EmojiPicker from './EmojiPicker.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import MenuRow from '$lib/components/menu/MenuRow.svelte';

  let {
    open = $bindable(false),
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
    open?: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canReport?: boolean;
    canPin?: boolean;
    pinned?: boolean;
    onReply: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onReact?: (emoji: string) => void;
    onReport?: () => void;
    onTogglePin?: () => void;
  } = $props();

  // Hand-picked frequent reactions — the full grid is one tap away.
  const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
  let pickerView = $state(false);

  function close() {
    open = false;
    pickerView = false;
  }
  function react(emoji: string) {
    onReact?.(emoji);
    close();
  }
  function run(action: () => void) {
    action();
    close();
  }
</script>

<BottomSheet
  {open}
  testid="message-action-sheet"
  closeLabel={m.message_action_sheet_close()}
  panelClass="bg-popover text-popover-foreground relative max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t border-border pb-[var(--safe-bottom)] shadow-2xl"
  onClose={close}
>
  <div class="mx-auto mt-2 mb-1 h-1 w-9 shrink-0 rounded-full bg-border"></div>

  {#if pickerView}
    <div class="flex justify-center p-3">
      <EmojiPicker onPick={react} />
    </div>
  {:else}
    {#if onReact}
    <!-- Quick-reaction strip (nur Klartext — verschlüsselte Nachrichten können (noch) keine Reaktionen) -->
    <div class="flex items-center justify-between gap-1 px-3 py-2">
      {#each QUICK as e (e)}
        <button
          type="button"
          class="flex size-11 items-center justify-center rounded-full text-2xl active:bg-bg-hover"
          data-testid="sheet-quick-react"
          data-emoji={e}
          onclick={() => react(e)}
        >{e}</button>
      {/each}
      <button
        type="button"
        class="text-text-muted flex size-11 items-center justify-center rounded-full active:bg-bg-hover"
        aria-label={m.message_action_sheet_more_emojis()}
        data-testid="sheet-action-react"
        onclick={() => (pickerView = true)}
      >
        <SmilePlusIcon class="size-5" />
      </button>
    </div>

    <div class="my-1 border-t border-border"></div>
    {/if}

    <div class="my-1 border-t border-border"></div>

    <MenuRow
      density="comfortable"
      data-testid="sheet-action-reply"
      onclick={() => run(onReply)}
    >
      <ReplyIcon class="text-text-muted size-5 shrink-0" />
      {m.message_action_sheet_reply()}
    </MenuRow>

    {#if canEdit}
      <MenuRow
        density="comfortable"
        data-testid="sheet-action-edit"
        onclick={() => run(onEdit)}
      >
        <PencilIcon class="text-text-muted size-5 shrink-0" />
        {m.message_action_sheet_edit()}
      </MenuRow>
    {/if}

    {#if canPin && onTogglePin}
      <MenuRow
        density="comfortable"
        data-testid={pinned ? 'sheet-action-unpin' : 'sheet-action-pin'}
        onclick={() => onTogglePin && run(onTogglePin)}
      >
        {#if pinned}
          <PinOffIcon class="text-text-muted size-5 shrink-0" />
          {m.message_action_sheet_unpin()}
        {:else}
          <PinIcon class="text-text-muted size-5 shrink-0" />
          {m.message_action_sheet_pin()}
        {/if}
      </MenuRow>
    {/if}

    {#if canDelete}
      <MenuRow
        variant="danger"
        density="comfortable"
        data-testid="sheet-action-delete"
        onclick={() => run(onDelete)}
      >
        <Trash2Icon class="size-5 shrink-0" />
        {m.message_action_sheet_delete()}
      </MenuRow>
    {/if}

    {#if canReport}
      <MenuRow
        variant="warning"
        density="comfortable"
        data-testid="sheet-action-report"
        onclick={() => onReport?.()}
      >
        <FlagIcon class="size-5 shrink-0" />
        {m.message_action_sheet_report()}
      </MenuRow>
    {/if}
  {/if}
</BottomSheet>
