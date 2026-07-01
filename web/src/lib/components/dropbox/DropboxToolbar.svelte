<script lang="ts">
  /**
   * Dropbox toolbar — icon-only after the 2026-07-01 cleanup.
   *
   * Each control is an icon button with a `title=` tooltip (a proper
   * shadcn Tooltip would be nicer on touch, but desktop covers the
   * primary use case and matches the "icon-only file-manager" pattern
   * the user asked for). The Empty-Trash button used to live here; it
   * moved to DropboxTrashBanner so it can carry the live count and
   * double as the "you are in trash" indicator.
   *
   * Search input stays as-is — a magnifier icon that expands to a
   * full input on click is a possible follow-up but cuts discoverability.
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
    onGoBack: () => void;
    onSearchInput: (v: string) => void;
    onOpenPicker: () => void;
    onToggleCreateFolder: () => void;
    onToggleGridView: () => void;
    onToggleTrash: () => void;
  };

  let {
    enabled,
    uploading,
    searchQuery,
    viewTrash,
    isGridView,
    canGoBack,
    onGoBack,
    onSearchInput,
    onOpenPicker,
    onToggleCreateFolder,
    onToggleGridView,
    onToggleTrash
  }: Props = $props();

  /**
   * Single Tailwind class string for every icon button so future
   * sizing/padding tweaks land in one place. `data-testid` is the
   * only attribute that varies.
   */
  const ICON_BTN =
    'flex items-center justify-center rounded-md border border-border/40 bg-bg-hover/40 p-2 text-text-muted hover:bg-bg-hover hover:text-text-base disabled:opacity-40';
  const ICON_BTN_ACTIVE =
    'flex items-center justify-center rounded-md border border-primary/40 bg-primary/10 p-2 text-primary hover:bg-primary/15';
</script>

<div
  class="flex flex-wrap items-center gap-2 border-b border-border/40 px-5 py-2.5"
>
  {#if canGoBack}
    <button
      type="button"
      class={ICON_BTN}
      onclick={onGoBack}
      title={pm.dropbox_back()}
      aria-label={pm.dropbox_back()}
      data-testid="dropbox-back-btn"
    >
      <ArrowLeftIcon class="size-4" />
    </button>
  {/if}
  <button
    type="button"
    class={ICON_BTN}
    onclick={onOpenPicker}
    disabled={uploading || !enabled}
    title={pm.dropbox_upload()}
    aria-label={pm.dropbox_upload()}
    data-testid="dropbox-upload-btn"
  >
    <UploadIcon class="size-4" />
  </button>
  <button
    type="button"
    class={ICON_BTN}
    onclick={onToggleCreateFolder}
    disabled={!enabled}
    title={pm.dropbox_new_folder()}
    aria-label={pm.dropbox_new_folder()}
    data-testid="dropbox-new-folder-btn"
  >
    <FolderPlusIcon class="size-4" />
  </button>
  <input
    type="text"
    placeholder={pm.dropbox_search_placeholder()}
    aria-label={pm.dropbox_search_placeholder()}
    class="flex-1 rounded-md border border-border/40 bg-bg-hover/40 px-3 py-1.5 text-sm placeholder:text-text-faint focus:border-primary focus:outline-none"
    value={searchQuery}
    oninput={(e) => onSearchInput((e.currentTarget as HTMLInputElement).value)}
    data-testid="dropbox-search"
  />
  <button
    type="button"
    class={ICON_BTN}
    onclick={onToggleGridView}
    title={pm.dropbox_toggle_view()}
    aria-label={pm.dropbox_toggle_view()}
  >
    {#if isGridView}
      <Rows3Icon class="size-4" />
    {:else}
      <LayoutGridIcon class="size-4" />
    {/if}
  </button>
  <button
    type="button"
    class={viewTrash ? ICON_BTN_ACTIVE : ICON_BTN}
    onclick={onToggleTrash}
    title={viewTrash ? pm.dropbox_view_root() : pm.dropbox_view_trash()}
    aria-label={viewTrash ? pm.dropbox_view_root() : pm.dropbox_view_trash()}
    data-testid="dropbox-trash-toggle"
  >
    <TrashIcon class="size-4" />
  </button>
</div>