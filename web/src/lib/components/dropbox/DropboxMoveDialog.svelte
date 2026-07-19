<script lang="ts">
  /**
   * Move target picker for one or more dropbox entries. The destination
   * is chosen from a lazy folder tree (DropboxFolderPicker); the parent
   * view-model still owns the commit.
   */
  import { m as pm } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import DropboxFolderPicker from './DropboxFolderPicker.svelte';

  type Props = {
    guildId: string;
    /** Display name of the primary entry (for the hint line). */
    name: string;
    /** Number of entries being moved (1 for single, >1 for bulk). */
    count: number;
    value: string;
    excludeEntryId: string | null;
    onInput: (v: string) => void;
    onCancel: () => void;
    onCommit: () => void;
  };

  let {
    guildId,
    name,
    count,
    value,
    excludeEntryId,
    onInput,
    onCancel,
    onCommit
  }: Props = $props();

  const hint = $derived(
    count > 1
      ? pm.dropbox_move_hint_bulk({ count, name })
      : pm.dropbox_move_hint({ name })
  );

  /** Footer shows the chosen destination as plain text — empty = root. */
  const destLabel = $derived(value === '' ? pm.dropbox_move_root_label() : value);
</script>

<div
  class="fixed inset-0 z-50 grid place-items-center bg-bg/80 backdrop-blur-sm"
  data-testid="dropbox-move-dialog"
>
  <div class="glass-panel w-[28rem] rounded-2xl p-5">
    <h3 class="mb-2 text-sm font-semibold">{pm.dropbox_move_title()}</h3>
    <p class="text-text-faint mb-3 text-xs">{hint}</p>
    <DropboxFolderPicker
      {guildId}
      {value}
      {excludeEntryId}
      onSelect={onInput}
    />
    <div class="text-text-faint mt-2 truncate font-mono text-xs" data-testid="dropbox-move-destination">
      → {destLabel}
    </div>
    <div class="mt-3 flex justify-end gap-2">
      <Button variant="ghost" size="sm" onclick={onCancel} data-testid="dropbox-move-cancel">
        {pm.dropbox_cancel()}
      </Button>
      <Button size="sm" onclick={onCommit} data-testid="dropbox-move-commit">
        {pm.dropbox_save()}
      </Button>
    </div>
  </div>
</div>
