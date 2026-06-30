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
  import type { DropboxEntry } from '$lib/api/dropbox';
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

  function isFileEntry(e: DropboxEntry) {
    return e.kind === 1;
  }
  function isFolderEntry(e: DropboxEntry) {
    return e.kind === 0;
  }
  function openOrEnter(e: DropboxEntry) {
    if (isFolderEntry(e)) v.enterFolder(e);
    else v.openFile(e);
  }
</script>

<section
  class="glass-panel flex h-full min-w-0 flex-1 flex-col rounded-none md:rounded-2xl"
  data-testid="dropbox-view"
>
  <DropboxBreadcrumb
    channelName={channel.name}
    currentPath={v.currentPath}
    navigate={v.navigateTo}
  />

  <DropboxQuotaGauge quota={v.quota} />

  <DropboxToolbar
    enabled={v.quota?.enabled ?? false}
    uploading={v.uploading}
    searchQuery={v.searchQuery}
    viewTrash={v.viewTrash}
    isGridView={v.isGridView}
    onSearchInput={(s) => (v.searchQuery = s)}
    onOpenPicker={v.openFilePicker}
    onToggleCreateFolder={() => (v.creatingFolder = !v.creatingFolder)}
    onToggleGridView={() => (v.isGridView = !v.isGridView)}
    onToggleTrash={() => (v.viewTrash = !v.viewTrash)}
  />

  {#if v.creatingFolder}
    <DropboxCreateFolderBanner
      name={v.newFolderName}
      onInput={(s) => (v.newFolderName = s)}
      onCommit={v.createFolder}
      onCancel={() => {
        v.creatingFolder = false;
        v.newFolderName = '';
      }}
    />
  {/if}

  <!-- File grid / list -->
  <div class="flex-1 overflow-y-auto px-5 py-4">
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
            onOpen={() => openOrEnter(e)}
            onTogglePin={() => v.togglePin(e)}
            onRename={() => v.startRename(e)}
            onMove={() => v.startMove(e)}
            onTrash={() => v.trashEntry(e)}
            onRestore={() => v.restore(e)}
          />
        {/each}
      </div>
    {:else}
      <DropboxEntryList
        entries={v.entries}
        viewTrash={v.viewTrash}
        onOpen={openOrEnter}
        onTogglePin={v.togglePin}
        onRename={v.startRename}
        onMove={v.startMove}
        onTrash={v.trashEntry}
        onRestore={v.restore}
      />
    {/if}
  </div>

  <input
    type="file"
    multiple
    bind:this={v.fileInput}
    onchange={v.onFileChange}
    class="hidden"
  />
</section>

{#if v.renameTarget}
  <DropboxRenameDialog
    value={v.renameValue}
    onInput={(s) => (v.renameValue = s)}
    onCancel={() => (v.renameTarget = null)}
    onCommit={v.commitRename}
  />
{/if}

{#if v.moveTarget}
  <DropboxMoveDialog
    name={v.moveTarget.name}
    value={v.moveValue}
    onInput={(s) => (v.moveValue = s)}
    onCancel={() => (v.moveTarget = null)}
    onCommit={v.commitMove}
  />
{/if}