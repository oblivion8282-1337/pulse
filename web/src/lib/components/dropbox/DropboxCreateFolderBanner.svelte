<script lang="ts">
  /**
   * Inline row that appears in the toolbar area when the user
   * toggles "New Folder" — collects a name and emits ``commit`` /
   * ``cancel``. Sits in the parent (``DropboxView``) so the
   * ``creatingFolder`` boolean state stays local to the file that
   * already has the ``createFolder`` action.
   */
  import FolderPlusIcon from '@lucide/svelte/icons/folder-plus';
  import { m as pm } from '$lib/paraglide/messages.js';

  type Props = {
    name: string;
    onInput: (v: string) => void;
    onCommit: () => void;
    onCancel: () => void;
  };

  let { name, onInput, onCommit, onCancel }: Props = $props();
</script>

<div
  class="flex items-center gap-2 border-b border-border/40 bg-bg-hover/20 px-5 py-2.5"
>
  <FolderPlusIcon class="text-primary size-4" />
  <input
    type="text"
    placeholder={pm.dropbox_new_folder_placeholder()}
    {name}
    oninput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
    class="flex-1 rounded-md border border-border/40 bg-bg-input px-3 py-1 text-sm focus:border-primary focus:outline-none"
    data-testid="dropbox-folder-name-input"
  />
  <button
    class="rounded-md bg-primary px-3 py-1 text-sm font-medium text-white"
    onclick={onCommit}
  >
    {pm.dropbox_create()}
  </button>
  <button
    class="rounded-md px-3 py-1 text-sm hover:bg-bg-hover"
    onclick={onCancel}
  >
    {pm.dropbox_cancel()}
  </button>
</div>
