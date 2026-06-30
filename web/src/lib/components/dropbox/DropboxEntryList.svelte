<script lang="ts">
  /**
   * List-view counterpart to DropboxEntryCard — a row with the same
   * action set but a tabular layout (icon + name, size, uploaded
   * date, action menu). Both views surface the same actions, so the
   * parent passes a flat callback bundle instead of one per action.
   */
  import type { Component } from 'svelte';
  import ArchiveIcon from '@lucide/svelte/icons/archive';
  import FileIcon from '@lucide/svelte/icons/file';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import ImageIcon from '@lucide/svelte/icons/image';
  import MusicIcon from '@lucide/svelte/icons/music';
  import VideoIcon from '@lucide/svelte/icons/video';
  import PinIcon from '@lucide/svelte/icons/pin';
  import PinOffIcon from '@lucide/svelte/icons/pin-off';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import TrashIcon from '@lucide/svelte/icons/trash-2';
  import Undo2Icon from '@lucide/svelte/icons/undo-2';
  import { formatBytes } from '$lib/utils/formatBytes';
  import { isFile, isFolder, type DropboxEntry } from '$lib/api/dropbox';
  import { m as pm } from '$lib/paraglide/messages.js';

  type Props = {
    entries: DropboxEntry[];
    viewTrash: boolean;
    onOpen: (e: DropboxEntry) => void;
    onTogglePin: (e: DropboxEntry) => void;
    onRename: (e: DropboxEntry) => void;
    onMove: (e: DropboxEntry) => void;
    onTrash: (e: DropboxEntry) => void;
    onRestore: (e: DropboxEntry) => void;
  };

  let {
    entries,
    viewTrash,
    onOpen,
    onTogglePin,
    onRename,
    onMove,
    onTrash,
    onRestore
  }: Props = $props();

  function fileIcon(e: DropboxEntry): Component {
    if (isFolder(e)) return FolderIcon;
    const t = (e.content_type || '').toLowerCase();
    if (t.startsWith('image/')) return ImageIcon;
    if (t.startsWith('video/')) return VideoIcon;
    if (t.startsWith('audio/')) return MusicIcon;
    if (t.includes('zip') || t.includes('archive')) return ArchiveIcon;
    return FileIcon;
  }

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
      <tr
        class="hover:bg-bg-hover/40 border-b border-border/20"
        data-testid="dropbox-row-{e.id}"
      >
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
