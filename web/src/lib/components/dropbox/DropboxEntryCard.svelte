<script lang="ts">
  /**
   * Single entry tile for the Grid view. Renders an icon, the
   * name, the size-or-folder-label and the hover-action row.
   * The List view duplicates the action row inline (different
   * layout); that path lives in DropboxView for now — splitting
   * would need its own Row component without much savings.
   */
  import FolderIcon from '@lucide/svelte/icons/folder';
  import PinIcon from '@lucide/svelte/icons/pin';
  import PinOffIcon from '@lucide/svelte/icons/pin-off';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import TrashIcon from '@lucide/svelte/icons/trash-2';
  import Undo2Icon from '@lucide/svelte/icons/undo-2';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import CheckIcon from '@lucide/svelte/icons/check';
  import { formatBytes } from '$lib/utils/formatBytes';
  import { isFile, isFolder, type DropboxEntry } from '$lib/api/dropbox';
  import { m as pm } from '$lib/paraglide/messages.js';
  import { fileIcon } from './fileIcon';

  type Props = {
    entry: DropboxEntry;
    viewTrash: boolean;
    selected: boolean;
    onOpen: () => void;
    onTogglePin: () => void;
    onRename: () => void;
    onMove: () => void;
    onTrash: () => void;
    onRestore: () => void;
    onDownload: () => void;
    onToggleSelect: () => void;
  };

  let {
    entry,
    viewTrash,
    selected,
    onOpen,
    onTogglePin,
    onRename,
    onMove,
    onTrash,
    onRestore,
    onDownload,
    onToggleSelect
  }: Props = $props();

  const Icon = $derived(fileIcon(entry));
</script>

<div
  class="glass-2 group relative flex flex-col gap-1.5 rounded-xl border p-3 hover:border-primary/40 {selected
    ? 'border-primary bg-primary/5'
    : 'border-border/40'}"
  data-testid="dropbox-entry-{entry.id}"
>
  <button
    class="flex aspect-square w-full items-center justify-center rounded-lg bg-bg-hover/40 text-text-dim group-hover:bg-primary/5"
    onclick={onOpen}
    data-testid="dropbox-entry-open-{entry.id}"
  >
    <Icon class="size-12 {isFolder(entry) ? 'text-primary' : ''}" />
  </button>
  <p class="truncate text-sm font-medium" title={entry.name}>{entry.name}</p>
  <p class="text-text-faint text-xs">
    {#if isFile(entry) && entry.size_bytes != null}
      {formatBytes(entry.size_bytes)}
    {:else if isFolder(entry)}
      {pm.dropbox_folder_label()}
    {/if}
  </p>
  {#if !viewTrash}
    <button
      class="absolute left-1 top-1 rounded p-0.5 transition {selected
        ? 'opacity-100'
        : 'opacity-0 group-hover:opacity-100'}"
      title={pm.dropbox_select_entry()}
      onclick={(e) => {
        e.stopPropagation();
        onToggleSelect();
      }}
      data-testid="dropbox-entry-select-{entry.id}"
      aria-pressed={selected}
    >
      <span
        class="flex size-4 items-center justify-center rounded border {selected
          ? 'border-primary bg-primary text-white'
          : 'border-border/60 bg-bg/60 text-transparent'}"
      >
        <CheckIcon class="size-3" strokeWidth={3} />
      </span>
    </button>
  {/if}
  <div
    class="absolute right-1 top-1 flex gap-0.5 opacity-0 transition group-hover:opacity-100"
  >
    {#if !viewTrash}
      <button
        class="rounded p-1 hover:bg-bg-hover"
        title={pm.dropbox_download_title()}
        onclick={onDownload}
        data-testid="dropbox-entry-download-{entry.id}"
      >
        <DownloadIcon class="size-3.5" />
      </button>
    {/if}
    {#if !viewTrash && isFile(entry)}
      <button
        class="rounded p-1 hover:bg-bg-hover"
        title={entry.pinned ? pm.dropbox_unpin() : pm.dropbox_pin()}
        onclick={onTogglePin}
      >
        {#if entry.pinned}
          <PinOffIcon class="size-3.5" />
        {:else}
          <PinIcon class="size-3.5" />
        {/if}
      </button>
    {/if}
    {#if viewTrash}
      <button
        class="rounded p-1 hover:bg-bg-hover"
        title={pm.dropbox_restore_title()}
        onclick={onRestore}
        data-testid="dropbox-entry-restore-{entry.id}"
      >
        <Undo2Icon class="size-3.5" />
      </button>
    {:else}
      <button
        class="rounded p-1 hover:bg-bg-hover"
        title={pm.dropbox_rename_title()}
        onclick={onRename}
      >
        <PencilIcon class="size-3.5" />
      </button>
      <button
        class="rounded p-1 hover:bg-bg-hover"
        title={pm.dropbox_move_title()}
        onclick={onMove}
      >
        <FolderIcon class="size-3.5" />
      </button>
      <button
        class="rounded p-1 text-destructive hover:bg-destructive/20"
        title={pm.dropbox_delete_title()}
        onclick={onTrash}
        data-testid="dropbox-entry-trash-{entry.id}"
      >
        <TrashIcon class="size-3.5" />
      </button>
    {/if}
  </div>
  {#if entry.pinned}
    <PinIcon class="text-primary absolute left-5 top-1 size-3" />
  {/if}
</div>
