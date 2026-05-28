<script lang="ts">
  /**
   * Touch-only bottom sheet for message actions. The hover toolbar
   * (`MessageActions.svelte`) is invisible without a pointer hover — on
   * touch this sheet is the only path to react / reply / edit / delete.
   * Opened via `use:longpress` on the message row.
   */
  import ReplyIcon from '@lucide/svelte/icons/reply';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import SmilePlusIcon from '@lucide/svelte/icons/smile-plus';
  import FlagIcon from '@lucide/svelte/icons/flag';
  import EmojiPicker from './EmojiPicker.svelte';

  let {
    open = $bindable(false),
    canEdit,
    canDelete,
    canReport = false,
    onReply,
    onEdit,
    onDelete,
    onReact,
    onReport
  }: {
    open?: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canReport?: boolean;
    onReply: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onReact: (emoji: string) => void;
    onReport?: () => void;
  } = $props();

  // Hand-picked frequent reactions — the full grid is one tap away.
  const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
  let pickerView = $state(false);

  function close() {
    open = false;
    pickerView = false;
  }
  function react(emoji: string) {
    onReact(emoji);
    close();
  }
  function run(action: () => void) {
    action();
    close();
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex flex-col justify-end"
    data-testid="message-action-sheet"
  >
    <button
      type="button"
      class="absolute inset-0 bg-black/50"
      aria-label="Schließen"
      onclick={close}
    ></button>
    <div
      class="bg-popover text-popover-foreground relative max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t border-border pb-[env(safe-area-inset-bottom)] shadow-2xl"
    >
      <div class="mx-auto mt-2 mb-1 h-1 w-9 shrink-0 rounded-full bg-border"></div>

      {#if pickerView}
        <div class="flex justify-center p-3">
          <EmojiPicker onPick={react} />
        </div>
      {:else}
        <!-- Quick-reaction strip -->
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
            aria-label="Weitere Emojis"
            data-testid="sheet-action-react"
            onclick={() => (pickerView = true)}
          >
            <SmilePlusIcon class="size-5" />
          </button>
        </div>

        <div class="my-1 border-t border-border"></div>

        <button
          type="button"
          class="flex min-h-12 w-full items-center gap-3 px-4 text-left text-[15px] active:bg-bg-hover"
          data-testid="sheet-action-reply"
          onclick={() => run(onReply)}
        >
          <ReplyIcon class="text-text-muted size-5 shrink-0" />
          Antworten
        </button>

        {#if canEdit}
          <button
            type="button"
            class="flex min-h-12 w-full items-center gap-3 px-4 text-left text-[15px] active:bg-bg-hover"
            data-testid="sheet-action-edit"
            onclick={() => run(onEdit)}
          >
            <PencilIcon class="text-text-muted size-5 shrink-0" />
            Bearbeiten
          </button>
        {/if}

        {#if canDelete}
          <button
            type="button"
            class="flex min-h-12 w-full items-center gap-3 px-4 text-left text-[15px] text-red-400 active:bg-bg-hover"
            data-testid="sheet-action-delete"
            onclick={() => run(onDelete)}
          >
            <Trash2Icon class="size-5 shrink-0" />
            Löschen
          </button>
        {/if}

        {#if canReport}
          <button
            type="button"
            class="flex min-h-12 w-full items-center gap-3 px-4 text-left text-[15px] text-amber-400 active:bg-bg-hover"
            data-testid="sheet-action-report"
            onclick={() => { onReport?.(); close(); }}
          >
            <FlagIcon class="size-5 shrink-0" />
            Melden
          </button>
        {/if}
      {/if}
    </div>
  </div>
{/if}
