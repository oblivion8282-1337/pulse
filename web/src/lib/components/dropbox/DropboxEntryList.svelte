<script lang="ts">
  /**
   * List-view counterpart to DropboxEntryCard — a row with the same
   * action set but a tabular layout (icon + name, size, uploaded
   * date, action menu). Both views surface the same actions, so the
   * parent passes a flat callback bundle instead of one per action.
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
    entries: DropboxEntry[];
    viewTrash: boolean;
    selectedIds: Set<string>;
    onOpen: (e: DropboxEntry) => void;
    onTogglePin: (e: DropboxEntry) => void;
    onRename: (e: DropboxEntry) => void;
    onMove: (e: DropboxEntry) => void;
    onTrash: (e: DropboxEntry) => void;
    onRestore: (e: DropboxEntry) => void;
    onDownload: (e: DropboxEntry) => void;
    onToggleSelect: (e: DropboxEntry) => void;
  };

  let {
    entries,
    viewTrash,
    selectedIds,
    onOpen,
    onTogglePin,
    onRename,
    onMove,
    onTrash,
    onRestore,
    onDownload,
    onToggleSelect
  }: Props = $props();

  function formatDate(s: string): string {
    try {
      const d = new Date(s);
      return new Intl.DateTimeFormat(undefined, {
        day: 'numeric',
        month: 'short'
      }).format(d);
    } catch {
      return '';
    }
  }
</script>

<table class="w-full text-sm">
  <thead class="text-text-faint text-xs uppercase tracking-wider">
    <tr class="border-b border-border/40">
      {#if !viewTrash}<th class="w-8 py-2"></th>{/if}
      <th class="py-2 text-left font-medium">{pm.dropbox_col_name()}</th>
      <th class="py-2 text-left font-medium">{pm.dropbox_col_size()}</th>
      <th class="py-2 text-left font-medium">
        {pm.dropbox_col_uploaded()}
      </th>
      <th class="py-2"></th>
    </tr>
  </thead>
  <tbody>
    {#each entries as e (e.id)}
      {@const Icon = fileIcon(e)}
      {@const selected = selectedIds.has(e.id)}
      <tr
        class="border-b border-border/40 {selected
          ? 'bg-primary/5'
          : 'hover:bg-bg-hover/60'}"
        data-testid="dropbox-row-{e.id}"
      >
        {#if !viewTrash}
          <td class="py-2">
            <button
              class="rounded p-1 hover:bg-bg-hover"
              title={pm.dropbox_select_entry()}
              onclick={() => onToggleSelect(e)}
              data-testid="dropbox-entry-select-{e.id}"
              aria-pressed={selected}
            >
              <span
                class="flex size-4 items-center justify-center rounded border {selected
                  ? 'border-primary bg-primary text-white'
                  : 'border-border/60 text-transparent'}"
              >
                <CheckIcon class="size-3" strokeWidth={3} />
              </span>
            </button>
          </td>
        {/if}
        <td class="py-2">
          <button
            class="flex items-center gap-2"
            onclick={() => onOpen(e)}
          >
            <Icon
              class="size-4 {isFolder(e)
                ? 'text-primary'
                : 'text-text-dim'}"
            />
            <span class="font-medium">{e.name}</span>
            {#if e.pinned}
              <PinIcon class="text-primary size-3" />
            {/if}
          </button>
        </td>
        <td class="text-text-dim">
          {isFile(e) && e.size_bytes != null
            ? formatBytes(e.size_bytes)
            : '—'}
        </td>
        <td class="text-text-dim text-xs">{formatDate(e.uploaded_at)}</td>
        <td class="text-right">
          <div class="flex justify-end gap-1">
            {#if viewTrash}
              <button
                class="rounded p-1 hover:bg-bg-hover"
                onclick={() => onRestore(e)}
                data-testid="dropbox-entry-restore-{e.id}"
              >
                <Undo2Icon class="size-4" />
              </button>
            {:else}
              <button
                class="rounded p-1 hover:bg-bg-hover"
                title={pm.dropbox_download_title()}
                onclick={() => onDownload(e)}
                data-testid="dropbox-entry-download-{e.id}"
              >
                <DownloadIcon class="size-4" />
              </button>
              <button
                class="rounded p-1 hover:bg-bg-hover"
                onclick={() => onTogglePin(e)}
              >
                {#if e.pinned}
                  <PinOffIcon class="size-4" />
                {:else}
                  <PinIcon class="size-4" />
                {/if}
              </button>
              <button
                class="rounded p-1 hover:bg-bg-hover"
                onclick={() => onRename(e)}
              >
                <PencilIcon class="size-4" />
              </button>
              <button
                class="rounded p-1 hover:bg-bg-hover"
                onclick={() => onMove(e)}
              >
                <FolderIcon class="size-4" />
              </button>
              <button
                class="rounded p-1 text-destructive hover:bg-destructive/20"
                onclick={() => onTrash(e)}
                data-testid="dropbox-entry-trash-{e.id}"
              >
                <TrashIcon class="size-4" />
              </button>
            {/if}
          </div>
        </td>
      </tr>
    {/each}
  </tbody>
</table>
