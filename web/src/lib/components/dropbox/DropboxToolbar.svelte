<script lang="ts">
  /**
   * Dropbox toolbar — Upload / New-Folder / Search / View-Toggle /
   * Trash-Toggle. Owns the visible chrome but no business logic:
   * each control surfaces its intent as a callback; the parent
   * decides what happens (and keeps the file-input + onFileChange
   * out of here so we don't have to thread FileList across the
   * boundary).
   */
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
  import LayoutGridIcon from '@lucide/svelte/icons/layout-grid';
  import Rows3Icon from '@lucide/svelte/icons/rows-3';
  import TrashIcon from '@lucide/svelte/icons/trash-2';
  import FolderPlusIcon from '@lucide/svelte/icons/folder-plus';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import { m as pm } from '$lib/paraglide/messages.js';

  type Props = {
    enabled: boolean;
    uploading: boolean;
    searchQuery: string;
    viewTrash: boolean;
    isGridView: boolean;
    /** Show a back arrow when the user has navigated into a folder. */
    canGoBack: boolean;
    /** Number of entries currently in trash (0 = button disabled). */
    trashCount: number;
    onGoBack: () => void;
    onSearchInput: (v: string) => void;
    onOpenPicker: () => void;
    onToggleCreateFolder: () => void;
    onToggleGridView: () => void;
    onToggleTrash: () => void;
    /** Manual empty-trash (admin only on the server). */
    onEmptyTrash: () => void;
  };

  let {
    enabled,
    uploading,
    searchQuery,
    viewTrash,
    isGridView,
    canGoBack,
    trashCount,
    onGoBack,
    onSearchInput,
    onOpenPicker,
    onToggleCreateFolder,
    onToggleGridView,
    onToggleTrash,
    onEmptyTrash
  }: Props = $props();
</script>

<div
  class="flex flex-wrap items-center gap-2 border-b border-border/40 px-5 py-2.5"
>
  <!--
    Back arrow goes one level up. Hidden at root (canGoBack=false)
    so the toolbar stays compact and the button never lies about
    being actionable.
  -->
  {#if canGoBack}
    <button
      type="button"
      class="flex items-center gap-1 rounded-md border border-border/40 bg-bg-hover/40 px-2 py-1.5 text-sm hover:bg-bg-hover"
      onclick={onGoBack}
      title={pm.dropbox_back()}
      data-testid="dropbox-back-btn"
    >
      <ArrowLeftIcon class="size-3.5" />
      {pm.dropbox_back()}
    </button>
  {/if}
  <button
    class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
    onclick={onOpenPicker}
    disabled={uploading || !enabled}
    data-testid="dropbox-upload-btn"
  >
    <UploadIcon class="mr-1 inline size-3.5" />
    {pm.dropbox_upload()}
  </button>
  <button
    class="rounded-md border border-border/40 bg-bg-hover/40 px-3 py-1.5 text-sm font-medium hover:bg-bg-hover disabled:opacity-50"
    onclick={onToggleCreateFolder}
    disabled={!enabled}
    data-testid="dropbox-new-folder-btn"
  >
    <FolderPlusIcon class="mr-1 inline size-3.5" />
    {pm.dropbox_new_folder()}
  </button>
  <input
    type="text"
    placeholder={pm.dropbox_search_placeholder()}
    class="flex-1 rounded-md border border-border/40 bg-bg-hover/40 px-3 py-1.5 text-sm placeholder:text-text-faint focus:border-primary focus:outline-none"
    value={searchQuery}
    oninput={(e) => onSearchInput((e.currentTarget as HTMLInputElement).value)}
    data-testid="dropbox-search"
  />
  <button
    class="rounded-md p-1.5 hover:bg-bg-hover"
    onclick={onToggleGridView}
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
    onclick={onToggleTrash}
    data-testid="dropbox-trash-toggle"
  >
    <TrashIcon class="mr-1 inline size-3.5" />
    {viewTrash ? pm.dropbox_view_root() : pm.dropbox_view_trash()}
  </button>
  {#if viewTrash}
    <button
      type="button"
      class="flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
      onclick={onEmptyTrash}
      disabled={trashCount === 0}
      title={pm.dropbox_empty_trash_title()}
      data-testid="dropbox-empty-trash-btn"
    >
      <TrashIcon class="size-3.5" />
      {pm.dropbox_empty_trash()}
    </button>
  {/if}
</div>
