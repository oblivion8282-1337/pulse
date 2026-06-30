<script lang="ts">
  /**
   * Dropbox / Ablage — main view for a per-guild file storage channel
   * (Channel.type === 2). Renders breadcrumb, quota gauge, folder tree,
   * toolbar with upload + search, and a file grid.
   *
   * MVP scope (2026-06-30 release):
   *  - list folders / files
   *  - create folder
   *  - upload single files (folder upload = nested multi-file)
   *  - delete to trash + restore from trash
   *  - rename + move + pin
   *  - quota gauge + WS live updates
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
  import HashIcon from '@lucide/svelte/icons/hash';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import FolderPlusIcon from '@lucide/svelte/icons/folder-plus';
  import FileIcon from '@lucide/svelte/icons/file';
  import ImageIcon from '@lucide/svelte/icons/image';
  import MusicIcon from '@lucide/svelte/icons/music';
  import VideoIcon from '@lucide/svelte/icons/video';
  import ArchiveIcon from '@lucide/svelte/icons/archive';
  import PinIcon from '@lucide/svelte/icons/pin';
  import PinOffIcon from '@lucide/svelte/icons/pin-off';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import TrashIcon from '@lucide/svelte/icons/trash-2';
  import Undo2Icon from '@lucide/svelte/icons/undo-2';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import SearchIcon from '@lucide/svelte/icons/search';
  import LayoutGridIcon from '@lucide/svelte/icons/layout-grid';
  import Rows3Icon from '@lucide/svelte/icons/rows-3';
  import type { Channel } from '$lib/api/types';
  import {
    dropboxApi,
    type DropboxConfig,
    type DropboxEntry,
    isFolder,
    isFile,
  } from '$lib/api/dropbox';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { formatBytes } from '$lib/utils/formatBytes';
  import { m as pm } from '$lib/paraglide/messages.js';

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

  // Live subscription to dropbox events. We refresh the listing on every
  // relevant op; the quota gauge updates on its dedicated event.
  let unsub: (() => void) | null = null;
  onMount(() => {
    void refreshAll();
    if (!browser) return;
    import('$lib/ws/connection').then(({ gateway }) => {
      unsub = gateway.on((evt) => {
        const e = evt as unknown as {
          op?: string;
          guild_id?: string;
          // Dropbox quota event uses the flat fields directly on the
          // event (see DropboxQuotaUpdatedEvent in
          // shared/src/dcc_shared/events/guild.py) — no ``payload``
          // wrapper. Earlier we read ``evt.payload`` and got ``undefined``,
          // which collapsed the gauge to ``{#if quota}`` and made it
          // disappear on every quota update.
        } & Partial<DropboxConfig>;
        // Filter for this guild's dropbox events; the backend publishes
        // the same op-codes with a guild_id discriminator. Anything
        // outside this guild is filtered server-side; the check here
        // is the cheap belt-and-braces.
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
    } catch (e) {
      quota = null;
    }
  }

  // Stale-response guard: a fast-typing user (or a WS-driven refreshAll)
// can fire multiple ``listEntries`` calls whose responses arrive out of
// order. We track the last-request's token and drop any response whose
// ``AbortError`` fired before its body landed. Mirrors the
// ``switchGen`` pattern in the channel page.
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
      if (myGen !== entriesGen) return; // stale — a newer call won
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

  // ----- Quota formatting -----
  // (formatBytes lives in $lib/utils/formatBytes — imported above)

  function pct(b: number, t: number): number {
    if (t <= 0) return 0;
    return Math.min(100, Math.round((b / t) * 100));
  }

  const quotaPct = $derived(
    quota ? pct(quota.used_bytes, quota.total_quota_bytes) : 0
  );

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
      const parts = pathSegments(currentPath);
      const idx = parts.indexOf(seg);
      currentPath = parts.slice(0, idx).join('/');
    }
    searchQuery = '';
    viewTrash = false;
  }

  function navigateUp() {
    if (!currentPath) return;
    currentPath = pathSegments(currentPath).slice(0, -1).join('/');
  }

  function pathSegments(p: string): string[] {
    return p ? p.split('/') : [];
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
        // Folder upload = relative paths on the File object. webkit
        // exposes them via ``webkitRelativePath`` (only on directory-pick);
        // a multi-file selection via ``<input multiple>`` returns the
        // flat list with ``name`` set, no directory info — caller picks
        // ``webkitdirectory`` to opt in. We accept both: parent_path
        // for individual files is the current folder. Folder structure
        // is therefore not preserved through this entry point; that
        // requires a directory-pick picker (deferred).
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
        if (!putRes.ok) {
          throw new Error(`upload failed: ${putRes.status}`);
        }
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

  function openFile(e: DropboxEntry) {
    if (!isFile(e) || !e.url) return;
    window.open(e.url, '_blank', 'noopener,noreferrer');
  }

  function fileIcon(e: DropboxEntry) {
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

<section
  class="glass-panel flex h-full min-w-0 flex-1 flex-col rounded-none md:rounded-2xl"
  data-testid="dropbox-view"
>
  <!-- Breadcrumb -->
  <header
    class="flex items-center gap-2 px-5 py-3 text-text-muted border-b border-border/40"
  >
    <HashIcon class="size-4" />
    <span class="text-sm font-medium text-text-base">{channel.name}</span>
    {#if currentPath}
      <ChevronRightIcon class="size-3.5 text-text-faint" />
      {#each pathSegments(currentPath) as seg, i (i)}
        <button
          class="text-sm hover:underline"
          onclick={() => navigateTo(seg)}
          data-testid="crumb-{i}"
        >
          {seg}
        </button>
        {#if i < pathSegments(currentPath).length - 1}
          <ChevronRightIcon class="size-3.5 text-text-faint" />
        {/if}
      {/each}
    {/if}
  </header>

  <!-- Quota gauge -->
  {#if quota}
    <div class="border-b border-border/40 bg-bg-hover/30 px-5 py-3">
      <div class="flex items-center justify-between text-xs">
        <span class="text-text-dim">
          {pm.dropbox_used_of_total({
            used: formatBytes(quota.used_bytes),
            total: formatBytes(quota.total_quota_bytes)
          })}
        </span>
        <span class="font-mono tabular-nums text-text-bright">
          {quotaPct} %
        </span>
      </div>
      <div
        class="mt-2 h-2 overflow-hidden rounded-full bg-bg-hover"
        role="progressbar"
        aria-valuenow={quotaPct}
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div
          class="h-full rounded-full transition-all"
          style="width: {quotaPct}%; background: {quotaPct >= 95
            ? 'var(--destructive)'
            : quotaPct >= 80
              ? 'var(--chart-3, #f59e0b)'
              : 'var(--brand)'}"
          data-testid="dropbox-quota-fill"
        ></div>
      </div>
    </div>
  {/if}

  <!-- Toolbar -->
  <div
    class="flex flex-wrap items-center gap-2 border-b border-border/40 px-5 py-2.5"
  >
    <button
      class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      onclick={openFilePicker}
      disabled={uploading || !quota?.enabled}
      data-testid="dropbox-upload-btn"
    >
      <UploadIcon class="mr-1 inline size-3.5" />
      {pm.dropbox_upload()}
    </button>
    <button
      class="rounded-md border border-border/40 bg-bg-hover/40 px-3 py-1.5 text-sm font-medium hover:bg-bg-hover disabled:opacity-50"
      onclick={() => (creatingFolder = !creatingFolder)}
      disabled={!quota?.enabled}
      data-testid="dropbox-new-folder-btn"
    >
      <FolderPlusIcon class="mr-1 inline size-3.5" />
      {pm.dropbox_new_folder()}
    </button>
    <input
      type="text"
      placeholder={pm.dropbox_search_placeholder()}
      class="flex-1 rounded-md border border-border/40 bg-bg-hover/40 px-3 py-1.5 text-sm placeholder:text-text-faint focus:border-primary focus:outline-none"
      bind:value={searchQuery}
      data-testid="dropbox-search"
    />
    <button
      class="rounded-md p-1.5 hover:bg-bg-hover"
      onclick={() => (isGridView = !isGridView)}
      title={pm.dropbox_toggle_view()}
    >
      {#if isGridView}
        <Rows3Icon class="size-4" />
      {:else}
        <LayoutGridIcon class="size-4" />
      {/if}
    </button>
    <button
      class="rounded-md border px-3 py-1.5 text-sm font-medium transition {viewTrash
        ? 'border-primary bg-primary/10 text-primary'
        : 'border-border/40 bg-bg-hover/40 hover:bg-bg-hover'}"
      onclick={() => (viewTrash = !viewTrash)}
      data-testid="dropbox-trash-toggle"
    >
      <TrashIcon class="mr-1 inline size-3.5" />
      {viewTrash ? pm.dropbox_view_root() : pm.dropbox_view_trash()}
    </button>
    <input
      type="file"
      multiple
      bind:this={fileInput}
      onchange={onFileChange}
      class="hidden"
    />
  </div>

  {#if creatingFolder}
    <div class="flex items-center gap-2 border-b border-border/40 bg-bg-hover/20 px-5 py-2.5">
      <FolderPlusIcon class="size-4 text-primary" />
      <input
        type="text"
        placeholder={pm.dropbox_new_folder_placeholder()}
        bind:value={newFolderName}
        class="flex-1 rounded-md border border-border/40 bg-bg-input px-3 py-1 text-sm focus:border-primary focus:outline-none"
        data-testid="dropbox-folder-name-input"
      />
      <button
        class="rounded-md bg-primary px-3 py-1 text-sm font-medium text-white"
        onclick={createFolder}
      >
        {pm.dropbox_create()}
      </button>
      <button
        class="rounded-md px-3 py-1 text-sm hover:bg-bg-hover"
        onclick={() => {
          creatingFolder = false;
          newFolderName = '';
        }}
      >
        {pm.dropbox_cancel()}
      </button>
    </div>
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
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {#each entries as e (e.id)}
          {@const Icon = fileIcon(e)}
          <div
            class="glass-2 group relative flex flex-col gap-1.5 rounded-xl border border-border/40 p-3 hover:border-primary/40"
            data-testid="dropbox-entry-{e.id}"
          >
            <button
              class="flex aspect-square w-full items-center justify-center rounded-lg bg-bg-hover/40 text-text-dim group-hover:bg-primary/5"
              onclick={() =>
                isFolder(e) ? enterFolder(e) : openFile(e)}
              data-testid="dropbox-entry-open-{e.id}"
            >
              <Icon class="size-12 {isFolder(e) ? 'text-primary' : ''}" />
            </button>
            <p class="truncate text-sm font-medium" title={e.name}>{e.name}</p>
            <p class="text-text-faint text-xs">
              {#if isFile(e) && e.size_bytes != null}
                {formatBytes(e.size_bytes)}
              {:else if isFolder(e)}
                {pm.dropbox_folder_label()}
              {/if}
            </p>
            <div class="absolute right-1 top-1 flex gap-0.5 opacity-0 transition group-hover:opacity-100">
              {#if !viewTrash && isFile(e)}
                <button
                  class="rounded p-1 hover:bg-bg-hover"
                  title={e.pinned ? pm.dropbox_unpin() : pm.dropbox_pin()}
                  onclick={() => togglePin(e)}
                >
                  {#if e.pinned}
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
                  onclick={() => restore(e)}
                >
                  <Undo2Icon class="size-3.5" />
                </button>
              {:else}
                <button
                  class="rounded p-1 hover:bg-bg-hover"
                  title={pm.dropbox_rename_title()}
                  onclick={() => startRename(e)}
                >
                  <PencilIcon class="size-3.5" />
                </button>
                <button
                  class="rounded p-1 hover:bg-bg-hover"
                  title={pm.dropbox_move_title()}
                  onclick={() => startMove(e)}
                >
                  <FolderIcon class="size-3.5" />
                </button>
                <button
                  class="rounded p-1 text-destructive hover:bg-destructive/20"
                  title={pm.dropbox_delete_title()}
                  onclick={() => trashEntry(e)}
                >
                  <TrashIcon class="size-3.5" />
                </button>
              {/if}
            </div>
            {#if e.pinned}
              <PinIcon class="text-primary absolute left-1 top-1 size-3" />
            {/if}
          </div>
        {/each}
      </div>
    {:else}
      <!-- List view -->
      <table class="w-full text-sm">
        <thead class="text-text-faint text-xs uppercase tracking-wider">
          <tr class="border-b border-border/40">
            <th class="py-2 text-left font-medium">{pm.dropbox_col_name()}</th>
            <th class="py-2 text-left font-medium">{pm.dropbox_col_size()}</th>
            <th class="py-2 text-left font-medium">{pm.dropbox_col_uploaded()}</th>
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
                  onclick={() =>
                    isFolder(e) ? enterFolder(e) : openFile(e)}
                >
                  <Icon class="size-4 {isFolder(e) ? 'text-primary' : 'text-text-dim'}" />
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
                    <button class="rounded p-1 hover:bg-bg-hover" onclick={() => restore(e)}>
                      <Undo2Icon class="size-4" />
                    </button>
                  {:else}
                    <button class="rounded p-1 hover:bg-bg-hover" onclick={() => togglePin(e)}>
                      {#if e.pinned}
                        <PinOffIcon class="size-4" />
                      {:else}
                        <PinIcon class="size-4" />
                      {/if}
                    </button>
                    <button class="rounded p-1 hover:bg-bg-hover" onclick={() => startRename(e)}>
                      <PencilIcon class="size-4" />
                    </button>
                    <button class="rounded p-1 hover:bg-bg-hover" onclick={() => startMove(e)}>
                      <FolderIcon class="size-4" />
                    </button>
                    <button class="rounded p-1 text-destructive hover:bg-destructive/20" onclick={() => trashEntry(e)}>
                      <TrashIcon class="size-4" />
                    </button>
                  {/if}
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</section>

<!-- Rename dialog (very small, inline) -->
{#if renameTarget}
  <div
    class="fixed inset-0 z-50 grid place-items-center bg-bg/80 backdrop-blur-sm"
    data-testid="dropbox-rename-dialog"
  >
    <div class="glass-panel w-80 rounded-2xl p-5">
      <h3 class="mb-3 text-sm font-semibold">{pm.dropbox_rename_title()}</h3>
      <input
        type="text"
        bind:value={renameValue}
        class="w-full rounded-md border border-border/40 bg-bg-input px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
        data-testid="dropbox-rename-input"
      />
      <div class="mt-4 flex justify-end gap-2">
        <button
          class="rounded-md px-3 py-1 text-sm hover:bg-bg-hover"
          onclick={() => (renameTarget = null)}
        >
          {pm.dropbox_cancel()}
        </button>
        <button
          class="rounded-md bg-primary px-3 py-1 text-sm font-medium text-white"
          onclick={commitRename}
        >
          {pm.dropbox_save()}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Move dialog -->
{#if moveTarget}
  <div
    class="fixed inset-0 z-50 grid place-items-center bg-bg/80 backdrop-blur-sm"
    data-testid="dropbox-move-dialog"
  >
    <div class="glass-panel w-96 rounded-2xl p-5">
      <h3 class="mb-3 text-sm font-semibold">{pm.dropbox_move_title()}</h3>
      <p class="text-text-faint mb-2 text-xs">
        {pm.dropbox_move_hint({ name: moveTarget.name })}
      </p>
      <input
        type="text"
        bind:value={moveValue}
        placeholder="screenshots/2026"
        class="w-full rounded-md border border-border/40 bg-bg-input px-3 py-1.5 font-mono text-sm focus:border-primary focus:outline-none"
        data-testid="dropbox-move-input"
      />
      <div class="mt-4 flex justify-end gap-2">
        <button
          class="rounded-md px-3 py-1 text-sm hover:bg-bg-hover"
          onclick={() => (moveTarget = null)}
        >
          {pm.dropbox_cancel()}
        </button>
        <button
          class="rounded-md bg-primary px-3 py-1 text-sm font-medium text-white"
          onclick={commitMove}
        >
          {pm.dropbox_save()}
        </button>
      </div>
    </div>
  </div>
{/if}
