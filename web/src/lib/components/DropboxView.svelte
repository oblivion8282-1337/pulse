<script lang="ts">
  /**
   * Dropbox / Ablage — orchestrator for the per-guild file storage
   * channel (Channel.type === 2). Owns WS subscription, data state
   * and server-side actions (refresh / upload / create / trash / pin);
   * delegates the chrome to sub-components in ./dropbox/.
   *
   * Deferred (next iteration):
   *  - drag-and-drop file drop
   *  - inline progress queue with pause/cancel
   *  - multi-select bulk operations
   *  - inline preview (images, video, audio waveform)
   */
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import { toast } from 'svelte-sonner';
  import type { Channel } from '$lib/api/types';
  import {
    dropboxApi,
    type DropboxConfig,
    type DropboxEntry,
    isFile,
    isFolder
  } from '$lib/api/dropbox';
  import { m as pm } from '$lib/paraglide/messages.js';
  import DropboxBreadcrumb from './dropbox/DropboxBreadcrumb.svelte';
  import DropboxQuotaGauge from './dropbox/DropboxQuotaGauge.svelte';
  import DropboxToolbar from './dropbox/DropboxToolbar.svelte';
  import DropboxCreateFolderBanner from './dropbox/DropboxCreateFolderBanner.svelte';
  import DropboxEntryCard from './dropbox/DropboxEntryCard.svelte';
  import DropboxEntryList from './dropbox/DropboxEntryList.svelte';
  import DropboxRenameDialog from './dropbox/DropboxRenameDialog.svelte';
  import DropboxMoveDialog from './dropbox/DropboxMoveDialog.svelte';

  let { channel }: { channel: Channel } = $props();

  let quota = $state<DropboxConfig | null>(null);
  let entries = $state<DropboxEntry[]>([]);
  let currentPath = $state('');
  let searchQuery = $state('');
  let viewTrash = $state(false);
  let isGridView = $state(true);
  let uploading = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);

  const guildId = $derived(channel.guild_id);

  // Live subscription: refresh listing on every mutation op; quota
  // gauge updates on its dedicated event. See
  // shared/src/dcc_shared/events/guild.py — the quota event uses
  // flat fields directly on the event (no ``payload`` wrapper).
  let unsub: (() => void) | null = null;
  onMount(() => {
    void refreshAll();
    if (!browser) return;
    import('$lib/ws/connection').then(({ gateway }) => {
      unsub = gateway.on((evt) => {
        const e = evt as unknown as {
          op?: string;
          guild_id?: string;
        } & Partial<DropboxConfig>;
        if (e.guild_id !== guildId) return;
        if (!e.op) return;
        switch (e.op) {
          case 'dropbox_entry_created':
          case 'dropbox_entry_updated':
          case 'dropbox_entry_deleted':
          case 'dropbox_entry_restored':
          case 'dropbox_entry_purged':
            void refreshAll();
            break;
          case 'dropbox_quota_updated':
            quota = {
              guild_id: e.guild_id ?? guildId,
              enabled: Boolean(e.enabled),
              total_quota_bytes: Number(e.total_quota_bytes ?? 0),
              per_file_max_bytes: Number(e.per_file_max_bytes ?? 0),
              used_bytes: Number(e.used_bytes ?? 0),
              trash_retention_days: Number(e.trash_retention_days ?? 0),
              updated_at: new Date().toISOString()
            } as DropboxConfig;
            break;
        }
      });
    });
  });
  onDestroy(() => {
    unsub?.();
  });

  async function refreshAll() {
    await Promise.all([refreshQuota(), refreshEntries()]);
  }

  async function refreshQuota() {
    try {
      quota = await dropboxApi.getQuota(guildId);
    } catch {
      quota = null;
    }
  }

  // Stale-response guard — the gen token drops responses from a
  // now-superseded call. Mirrors the ``switchGen`` pattern on the
  // channel page.
  let entriesGen = 0;

  async function refreshEntries() {
    const myGen = ++entriesGen;
    loading = true;
    error = null;
    try {
      const r = await dropboxApi.listEntries(guildId, {
        path: currentPath,
        q: searchQuery,
        includeTrash: viewTrash
      });
      if (myGen !== entriesGen) return;
      entries = r.entries;
    } catch (e) {
      if (myGen !== entriesGen) return;
      error = (e as Error).message;
      entries = [];
    } finally {
      if (myGen === entriesGen) loading = false;
    }
  }

  $effect(() => {
    currentPath;
    searchQuery;
    viewTrash;
    void refreshEntries();
  });

  // ----- Folder navigation -----
  function enterFolder(entry: DropboxEntry) {
    if (!isFolder(entry)) return;
    currentPath = entry.parent_path ? `${entry.parent_path}/${entry.name}` : entry.name;
    searchQuery = '';
    viewTrash = false;
  }

  function navigateTo(seg: string) {
    if (!seg) {
      currentPath = '';
    } else {
      const parts = currentPath.split('/');
      const idx = parts.indexOf(seg);
      currentPath = parts.slice(0, idx).join('/');
    }
    searchQuery = '';
    viewTrash = false;
  }

  function openFile(e: DropboxEntry) {
    if (!isFile(e) || !e.url) return;
    window.open(e.url, '_blank', 'noopener,noreferrer');
  }

  // ----- Folder creation -----
  let creatingFolder = $state(false);
  let newFolderName = $state('');
  async function createFolder() {
    if (!newFolderName.trim()) return;
    try {
      await dropboxApi.createFolder(guildId, currentPath, newFolderName.trim());
      newFolderName = '';
      creatingFolder = false;
      await refreshEntries();
      toast.success(pm.dropbox_folder_created());
    } catch (e) {
      toast.error(pm.dropbox_error_generic(), {
        description: (e as Error).message
      });
    }
  }

  // ----- File upload -----
  let fileInput: HTMLInputElement | null = $state(null);
  function openFilePicker() {
    fileInput?.click();
  }
  async function onFileChange(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    if (!quota || !quota.enabled) {
      toast.error(pm.dropbox_disabled_error());
      return;
    }
    uploading = true;
    let okCount = 0;
    let failCount = 0;
    for (const f of files) {
      try {
        const mint = await dropboxApi.mintUploadUrl(guildId, {
          parent_path: currentPath,
          name: f.name,
          content_type: f.type || 'application/octet-stream',
          size_bytes: f.size
        });
        const putRes = await fetch(mint.upload_url, {
          method: 'PUT',
          body: f,
          headers: {
            'Content-Type': f.type || 'application/octet-stream'
          }
        });
        if (!putRes.ok) throw new Error(`upload failed: ${putRes.status}`);
        await dropboxApi.finishUpload(guildId, {
          id: mint.id,
          parent_path: currentPath,
          name: f.name,
          size_bytes: f.size,
          content_type: f.type || 'application/octet-stream'
        });
        okCount++;
      } catch (e) {
        failCount++;
        toast.error(pm.dropbox_upload_failed({ name: f.name }), {
          description: (e as Error).message
        });
      }
    }
    uploading = false;
    if (okCount > 0) {
      toast.success(pm.dropbox_upload_success({ count: okCount }));
      await refreshAll();
    }
  }

  // ----- Per-entry actions -----
  let renameTarget = $state<DropboxEntry | null>(null);
  let renameValue = $state('');
  function startRename(e: DropboxEntry) {
    renameTarget = e;
    renameValue = e.name;
  }
  async function commitRename() {
    if (!renameTarget) return;
    const v = renameValue.trim();
    if (!v || v === renameTarget.name) {
      renameTarget = null;
      return;
    }
    try {
      await dropboxApi.patchEntry(guildId, renameTarget.id, { name: v });
      renameTarget = null;
      await refreshEntries();
    } catch (e) {
      toast.error(pm.dropbox_rename_failed(), {
        description: (e as Error).message
      });
    }
  }

  let moveTarget = $state<DropboxEntry | null>(null);
  let moveValue = $state('');
  function startMove(e: DropboxEntry) {
    moveTarget = e;
    moveValue = e.parent_path;
  }
  async function commitMove() {
    if (!moveTarget) return;
    const v = moveValue.trim();
    if (v === moveTarget.parent_path) {
      moveTarget = null;
      return;
    }
    try {
      await dropboxApi.patchEntry(guildId, moveTarget.id, {
        parent_path: v
      });
      moveTarget = null;
      await refreshEntries();
    } catch (e) {
      toast.error(pm.dropbox_move_failed(), {
        description: (e as Error).message
      });
    }
  }

  async function togglePin(e: DropboxEntry) {
    try {
      await dropboxApi.patchEntry(guildId, e.id, { pinned: !e.pinned });
      await refreshEntries();
    } catch (err) {
      toast.error(pm.dropbox_pin_failed(), {
        description: (err as Error).message
      });
    }
  }

  async function trashEntry(e: DropboxEntry) {
    if (!confirm(pm.dropbox_confirm_delete({ name: e.name }))) return;
    try {
      await dropboxApi.deleteEntry(guildId, e.id);
      await refreshAll();
    } catch (err) {
      toast.error(pm.dropbox_delete_failed(), {
        description: (err as Error).message
      });
    }
  }

  async function restore(e: DropboxEntry) {
    try {
      await dropboxApi.restoreEntry(guildId, e.id);
      await refreshAll();
    } catch (err) {
      toast.error(pm.dropbox_restore_failed(), {
        description: (err as Error).message
      });
    }
  }
</script>

<section
  class="glass-panel flex h-full min-w-0 flex-1 flex-col rounded-none md:rounded-2xl"
  data-testid="dropbox-view"
>
  <DropboxBreadcrumb
    channelName={channel.name}
    currentPath={currentPath}
    navigate={navigateTo}
  />

  <DropboxQuotaGauge {quota} />

  <DropboxToolbar
    enabled={quota?.enabled ?? false}
    {uploading}
    {searchQuery}
    {viewTrash}
    {isGridView}
    onSearchInput={(v) => (searchQuery = v)}
    onOpenPicker={openFilePicker}
    onToggleCreateFolder={() => (creatingFolder = !creatingFolder)}
    onToggleGridView={() => (isGridView = !isGridView)}
    onToggleTrash={() => (viewTrash = !viewTrash)}
  />

  {#if creatingFolder}
    <DropboxCreateFolderBanner
      name={newFolderName}
      onInput={(v) => (newFolderName = v)}
      onCommit={createFolder}
      onCancel={() => {
        creatingFolder = false;
        newFolderName = '';
      }}
    />
  {/if}

  <!-- File grid / list -->
  <div class="flex-1 overflow-y-auto px-5 py-4">
    {#if loading && entries.length === 0}
      <p class="text-text-faint text-center text-sm">{pm.dropbox_loading()}</p>
    {:else if error}
      <p class="text-destructive text-center text-sm">{error}</p>
    {:else if entries.length === 0}
      <div class="text-text-faint py-12 text-center text-sm">
        {#if viewTrash}
          {pm.dropbox_trash_empty()}
        {:else if searchQuery}
          {pm.dropbox_no_search_results()}
        {:else if currentPath}
          {pm.dropbox_empty_folder()}
        {:else}
          {pm.dropbox_empty_root()}
        {/if}
      </div>
    {:else if isGridView}
      <div
        class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
      >
        {#each entries as e (e.id)}
          <DropboxEntryCard
            entry={e}
            {viewTrash}
            onOpen={() => (isFolder(e) ? enterFolder(e) : openFile(e))}
            onTogglePin={() => togglePin(e)}
            onRename={() => startRename(e)}
            onMove={() => startMove(e)}
            onTrash={() => trashEntry(e)}
            onRestore={() => restore(e)}
          />
        {/each}
      </div>
    {:else}
      <DropboxEntryList
        {entries}
        {viewTrash}
        onOpen={(e) => (isFolder(e) ? enterFolder(e) : openFile(e))}
        onTogglePin={togglePin}
        onRename={startRename}
        onMove={startMove}
        onTrash={trashEntry}
        onRestore={restore}
      />
    {/if}
  </div>

  <input
    type="file"
    multiple
    bind:this={fileInput}
    onchange={onFileChange}
    class="hidden"
  />
</section>

{#if renameTarget}
  <DropboxRenameDialog
    value={renameValue}
    onInput={(v) => (renameValue = v)}
    onCancel={() => (renameTarget = null)}
    onCommit={commitRename}
  />
{/if}

{#if moveTarget}
  <DropboxMoveDialog
    name={moveTarget.name}
    value={moveValue}
    onInput={(v) => (moveValue = v)}
    onCancel={() => (moveTarget = null)}
    onCommit={commitMove}
  />
{/if}