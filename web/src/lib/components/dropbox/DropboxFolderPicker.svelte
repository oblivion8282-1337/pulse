<script lang="ts">
  /**
   * Tree-style folder picker for the move dialog. Lazy-loads children
   * per path via the existing ``listEntries`` API — no new backend
   * endpoint needed. Excludes the source entry (and, transitively, all
   * its descendants: they only appear inside an expanded source, and
   * the source itself is hidden so the user can't descend into it).
   *
   * Selection model: clicking a row sets the destination. There is no
   * separate "commit" inside the picker — the parent dialog owns the
   * Move button. Keeps the UI to one click-target per row.
   */
  import FolderIcon from '@lucide/svelte/icons/folder';
  import HomeIcon from '@lucide/svelte/icons/house';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import { dropboxApi, isFolder, type DropboxEntry } from '$lib/api/dropbox';
  import { m as pm } from '$lib/paraglide/messages.js';

  type Props = {
    guildId: string;
    value: string;
    /** Source entry id — hidden from the tree so a folder can't be
     *  moved into itself or any of its descendants. */
    excludeEntryId: string | null;
    onSelect: (path: string) => void;
  };

  let { guildId, value, excludeEntryId, onSelect }: Props = $props();

  // path → folder children. Cached so re-collapsing a branch doesn't
  // re-hit the API. Values are kept stable across re-renders.
  let children = $state<Record<string, DropboxEntry[]>>({});
  let loading = $state<Set<string>>(new Set());
  let expanded = $state<Set<string>>(new Set());

  /** Fetch + cache the folder children of ``path``. ``""`` = root. */
  async function loadChildren(path: string): Promise<void> {
    if (children[path] !== undefined || loading.has(path)) return;
    const next = new Set(loading);
    next.add(path);
    loading = next;
    try {
      const r = await dropboxApi.listEntries(guildId, { path });
      children = {
        ...children,
        // Files don't belong in a folder picker — drop them client-side.
        [path]: r.entries.filter(
          (e) => isFolder(e) && e.id !== excludeEntryId
        )
      };
    } catch {
      children = { ...children, [path]: [] };
    } finally {
      const done = new Set(loading);
      done.delete(path);
      loading = done;
    }
  }

  /** Toggle expansion + lazy-load on first open. */
  async function toggle(path: string): Promise<void> {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      await loadChildren(path);
    }
    expanded = next;
  }

  // Pre-expand the currently-selected path so the user lands on a
  // sensible view. Walk the segments, loading each level as we go.
  // ponytail: commit `expanded` once at the end instead of after each
  // segment — the loop body never observes the intermediate sets, and
  // N→1 writes avoids N redundant re-renders.
  $effect(() => {
    if (!value) return;
    const segs = value.split('/');
    const toExpand = new Set<string>(expanded);
    let added = false;
    (async () => {
      let cursor = '';
      for (const seg of segs) {
        cursor = cursor ? `${cursor}/${seg}` : seg;
        if (!toExpand.has(cursor)) {
          toExpand.add(cursor);
          added = true;
          await loadChildren(cursor);
        }
      }
      if (added) expanded = toExpand;
    })();
  });

  // Load root on mount so the tree isn't empty.
  $effect(() => {
    void loadChildren('');
  });

  /** Rows to render, flattened depth-first. Keeps the DOM linear so
   *  the picker scrolls as one block. */
  type Row = {
    path: string;
    name: string;
    depth: number;
    isExpanded: boolean;
    isLoading: boolean;
    isSelected: boolean;
  };

  function flatten(): Row[] {
    const out: Row[] = [];
    const walk = (parentPath: string, depth: number) => {
      for (const k of children[parentPath] ?? []) {
        const path = parentPath ? `${parentPath}/${k.name}` : k.name;
        const isExp = expanded.has(path);
        out.push({
          path,
          name: k.name,
          depth,
          isExpanded: isExp,
          isLoading: loading.has(path),
          isSelected: path === value
        });
        if (isExp) walk(path, depth + 1);
      }
    };
    walk('', 0);
    return out;
  }

  const rows = $derived(flatten());
</script>

<div
  class="max-h-72 overflow-y-auto rounded-md border border-border/40 bg-bg-input"
  data-testid="dropbox-folder-picker"
>
  <!-- Root row — always visible, represents the empty parent_path. -->
  <button
    type="button"
    class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-bg-hover {value ===
    ''
      ? 'bg-primary/10 text-primary'
      : ''}"
    onclick={() => onSelect('')}
    data-testid="dropbox-folder-picker-root"
  >
    <span class="w-4"></span>
    <HomeIcon class="h-4 w-4 shrink-0" />
    <span class="truncate">{pm.dropbox_move_root_label()}</span>
  </button>

  {#each rows as r (r.path)}
    <div
      class="flex items-center gap-1 text-sm hover:bg-bg-hover {r.isSelected
        ? 'bg-primary/10 text-primary'
        : ''}"
      style="padding-left: {r.depth * 16 + 4}px"
      data-testid="dropbox-folder-picker-row"
      data-path={r.path}
    >
      <button
        type="button"
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-bg-hover/80"
        onclick={() => toggle(r.path)}
        aria-label={r.isExpanded ? pm.dropbox_move_collapse() : pm.dropbox_move_expand()}
      >
        {#if r.isLoading}
          <span class="text-text-faint text-xs">…</span>
        {:else if r.isExpanded}
          <ChevronDownIcon class="h-3.5 w-3.5" />
        {:else}
          <ChevronRightIcon class="h-3.5 w-3.5" />
        {/if}
      </button>
      <button
        type="button"
        class="flex flex-1 items-center gap-2 truncate py-1.5 text-left"
        onclick={() => onSelect(r.path)}
      >
        <FolderIcon class="h-4 w-4 shrink-0" />
        <span class="truncate">{r.name}</span>
      </button>
    </div>
  {/each}

  {#if rows.length === 0 && !loading.has('')}
    <p class="text-text-faint px-3 py-2 text-xs">
      {pm.dropbox_move_empty()}
    </p>
  {/if}
</div>
