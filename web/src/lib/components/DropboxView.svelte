<script lang="ts">
  /**
   * Dropbox / Ablage — orchestrator for the per-guild file storage
   * channel (Channel.type === 2). Holds no data-state of its own;
   * the controller (``DropboxViewModel``) owns the WS subscription +
   * server actions, and the chrome is composed from sub-components.
   *
   * Deferred (next iteration):
   *  - drag-and-drop file drop
   *  - inline progress queue with pause/cancel
   *  - multi-select bulk operations
   *  - inline preview (images, video, audio waveform)
   */
  import type { Channel } from '$lib/api/types';
  import { isFile, isFolder, type DropboxEntry } from '$lib/api/dropbox';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import FolderInputIcon from '@lucide/svelte/icons/folder-input';
  import XIcon from '@lucide/svelte/icons/x';
  import { m as pm } from '$lib/paraglide/messages.js';
  import DropboxBreadcrumb from './dropbox/DropboxBreadcrumb.svelte';
  import DropboxQuotaGauge from './dropbox/DropboxQuotaGauge.svelte';
  import DropboxToolbar from './dropbox/DropboxToolbar.svelte';
  import DropboxCreateFolderBanner from './dropbox/DropboxCreateFolderBanner.svelte';
  import DropboxEntryCard from './dropbox/DropboxEntryCard.svelte';
  import DropboxEntryList from './dropbox/DropboxEntryList.svelte';
  import DropboxRenameDialog from './dropbox/DropboxRenameDialog.svelte';
  import DropboxMoveDialog from './dropbox/DropboxMoveDialog.svelte';
  import { useDropboxView } from './dropbox/DropboxViewModel.svelte';

  let { channel }: { channel: Channel } = $props();

  // Controller — see DropboxViewModel.svelte.ts for the WS subscription,
  // data-state and server-side actions this thin shell binds to.
  // ``channel`` is intentionally captured by value: the parent mounts
  // a fresh DropboxView per channel, so a single init-snap is right.
  // svelte-ignore state_referenced_locally
  const v = useDropboxView(channel);

  function openOrEnter(e: DropboxEntry) {
    if (isFolder(e)) v.enterFolder(e);
    else v.openFile(e);
  }
  function downloadEntry(e: DropboxEntry) {
    if (isFolder(e)) void v.downloadFolder(e);
    else void v.downloadFile(e);
  }
</script>

<section
  class="glass-panel flex h-full min-w-0 flex-1 flex-col rounded-none md:rounded-2xl"
  data-testid="dropbox-view"
>
  <DropboxBreadcrumb
    channelName={channel.name}
    currentPath={v.currentPath}
    navigate={(i) => v.navigateToIndex(i)}
  />

  <DropboxQuotaGauge quota={v.quota} />

  <DropboxToolbar
    enabled={v.quota?.enabled ?? false}
    uploading={v.uploading}
    searchQuery={v.searchQuery}
    viewTrash={v.viewTrash}
    isGridView={v.isGridView}
    canGoBack={v.currentPath !== ''}
    onGoBack={() => v.goUp()}
    onSearchInput={(s) => (v.searchQuery = s)}
    onOpenPicker={() => v.openFilePicker()}
    onToggleCreateFolder={() => (v.creatingFolder = !v.creatingFolder)}
    onToggleGridView={() => (v.isGridView = !v.isGridView)}
    onToggleTrash={() => (v.viewTrash = !v.viewTrash)}
  />

  {#if v.creatingFolder}
    <DropboxCreateFolderBanner
      name={v.newFolderName}
      onInput={(s) => (v.newFolderName = s)}
      onCommit={() => v.createFolder()}
      onCancel={() => {
        v.creatingFolder = false;
        v.newFolderName = '';
      }}
    />
  {/if}

  <!-- File grid / list -->
  <div class="flex-1 overflow-y-auto px-5 py-4">
    {#if v.hasSelection && !v.viewTrash}
      <div
        class="mb-3 flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm"
        data-testid="dropbox-selection-bar"
      >
        <span class="font-medium">
          {pm.dropbox_selection_count({ count: v.selectionCount })}
        </span>
        <button
          class="ml-auto flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          onclick={() => v.downloadSelection()}
          data-testid="dropbox-download-selection"
        >
          <DownloadIcon class="size-3.5" />
          {pm.dropbox_download_selection()}
        </button>
        <button
          class="flex items-center gap-1 rounded-md border border-border/40 px-2 py-1.5 text-xs hover:bg-bg-hover"
          onclick={() => v.startBulkMove()}
          title={pm.dropbox_move_title()}
          data-testid="dropbox-move-selection"
        >
          <FolderInputIcon class="size-3.5" />
          {pm.dropbox_move_title()}
        </button>
        <button
          class="flex items-center gap-1 rounded-md border border-border/40 px-2 py-1.5 text-xs hover:bg-bg-hover"
          onclick={() => v.clearSelection()}
          title={pm.dropbox_clear_selection()}
        >
          <XIcon class="size-3.5" />
        </button>
      </div>
    {/if}
    {#if v.loading && v.entries.length === 0}
      <p class="text-text-faint text-center text-sm">{pm.dropbox_loading()}</p>
    {:else if v.error}
      <p class="text-destructive text-center text-sm">{v.error}</p>
    {:else if v.entries.length === 0}
      <div class="text-text-faint py-12 text-center text-sm">
        {#if v.viewTrash}
          {pm.dropbox_trash_empty()}
        {:else if v.searchQuery}
          {pm.dropbox_no_search_results()}
        {:else if v.currentPath}
          {pm.dropbox_empty_folder()}
        {:else}
          {pm.dropbox_empty_root()}
        {/if}
      </div>
    {:else if v.isGridView}
      <div
        class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
      >
        {#each v.entries as e (e.id)}
          <DropboxEntryCard
            entry={e}
            viewTrash={v.viewTrash}
            selected={v.isSelected(e.id)}
            onOpen={() => openOrEnter(e)}
            onTogglePin={() => v.togglePin(e)}
            onRename={() => v.startRename(e)}
            onMove={() => v.startMove(e)}
            onTrash={() => v.trashEntry(e)}
            onRestore={() => v.restore(e)}
            onDownload={() => downloadEntry(e)}
            onToggleSelect={() => v.toggleSelect(e.id)}
          />
        {/each}
      </div>
    {:else}
      <DropboxEntryList
        entries={v.entries}
        viewTrash={v.viewTrash}
        selectedIds={v.selectedIds}
        onOpen={openOrEnter}
        onTogglePin={(e) => v.togglePin(e)}
        onRename={(e) => v.startRename(e)}
        onMove={(e) => v.startMove(e)}
        onTrash={(e) => v.trashEntry(e)}
        onRestore={(e) => v.restore(e)}
        onDownload={(e) => downloadEntry(e)}
        onToggleSelect={(e) => v.toggleSelect(e.id)}
      />
    {/if}
  </div>

  <input
    type="file"
    multiple
    bind:this={v.fileInput}
    onchange={(e) => v.onFileChange(e)}
    class="hidden"
  />
</section>

{#if v.renameTarget}
  <DropboxRenameDialog
    value={v.renameValue}
    onInput={(s) => (v.renameValue = s)}
    onCancel={() => (v.renameTarget = null)}
    onCommit={() => v.commitRename()}
  />
{/if}

{#if v.moveTarget}
  <DropboxMoveDialog
    guildId={channel.guild_id}
    name={v.moveTarget.name}
    count={v.moveCount}
    value={v.moveValue}
    excludeEntryId={v.moveTarget.id}
    onInput={(s) => (v.moveValue = s)}
    onCancel={() => v.cancelMove()}
    onCommit={() => v.commitMove()}
  />
{/if}