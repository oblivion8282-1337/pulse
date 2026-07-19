<script lang="ts">
  /**
   * Top banner shown above the entry list when the user is in trash
   * mode. Doubles as:
   *   1. **Visible "you are in trash" indicator** (red-tinted, distinct
   *      from the normal view). The toggle button highlight alone was
   *      too easy to miss.
   *   2. **Quick-action shelf** — shows the trash count and consolidates
   *      the "Empty trash" button here, which is the only trash-mode
   *      action left after icons-only toolbar took the toggle out of the
   *      empty-trash location.
   *
   * Owns nothing: parent supplies the count + the empty-trash callback.
   * Pulsing dot ("X Elemente") is the live counter; the Empty-button
   * disables itself when there's nothing to flush.
   */
  import TrashIcon from '@lucide/svelte/icons/trash-2';
  import { m as pm } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';

  type Props = {
    /** Number of trashed entries. Empty-button auto-disables at 0. */
    trashCount: number;
    onEmptyTrash: () => void;
  };

  let { trashCount, onEmptyTrash }: Props = $props();
</script>

<div
  class="flex items-center gap-3 border-b border-destructive/40 bg-destructive/10 px-5 py-2 text-sm text-destructive"
  data-testid="dropbox-trash-banner"
>
  <TrashIcon class="size-4 shrink-0" />
  <span class="font-medium" data-testid="dropbox-trash-banner-count">
    {pm.dropbox_trash_count_label({ count: trashCount })}
  </span>
  <Button
    variant="destructive"
    size="sm"
    class="ml-auto"
    onclick={onEmptyTrash}
    disabled={trashCount === 0}
    title={pm.dropbox_empty_trash_title()}
    data-testid="dropbox-empty-trash-btn"
  >
    {pm.dropbox_empty_trash()}
  </Button>
</div>
