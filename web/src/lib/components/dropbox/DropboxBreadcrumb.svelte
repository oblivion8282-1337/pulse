<script lang="ts">
  /**
   * Dropbox-channel header — channel name + path crumbs.
   *
   * Three ways back to the root, because relying on tiny grey text
   * with `hover:underline` was unusably subtle:
   *
   *  1. Channel-name chip on the left is itself a Root button.
   *  2. Each path segment is a pill-button.
   *  3. Toolbar back-arrow (`goUp`) one level at a time.
   *
   * ``navigate(i)`` is index-based (0 = root). Long paths middle-elide
   * to keep root + the last two segments visible.
   */
  import HashIcon from '@lucide/svelte/icons/hash';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import { m as pm } from '$lib/paraglide/messages.js';

  type Crumb = {
    /** Display label. */
    label: string;
    /** Ancestor index (0 = root). ``-1`` for the ellipsis placeholder. */
    idx: number;
  };

  type Props = {
    channelName: string;
    currentPath: string;
    /** Navigate to ancestor at this index (0 = root). */
    navigate: (idx: number) => void;
  };

  let { channelName, currentPath, navigate }: Props = $props();

  const segments = $derived(currentPath ? currentPath.split('/') : []);

  // Keep root + last two segments when the path is long enough to
  // overflow; middle segments collapse to a non-clickable ellipsis.
  const crumbs = $derived.by((): Crumb[] => {
    if (segments.length <= 3) {
      return segments.map((s, i) => ({ label: s, idx: i }));
    }
    return [
      { label: segments[0], idx: 0 },
      { label: '…', idx: -1 },
      {
        label: segments[segments.length - 2],
        idx: segments.length - 2
      },
      { label: segments[segments.length - 1], idx: segments.length - 1 }
    ];
  });
</script>

<header
  class="flex items-center gap-2 border-b border-border/40 px-5 py-3"
>
  <!--
    Channel-name "chip" doubles as the Root button. When the user is
    already at root it still looks active (no movement to deliver).
  -->
  <button
    type="button"
    class="flex items-center gap-1 rounded-md bg-bg-hover/60 px-2 py-1 text-sm font-medium text-text-base hover:bg-bg-hover"
    onclick={() => navigate(0)}
    data-testid="crumb-root"
    aria-label={pm.dropbox_back_root()}
  >
    <HashIcon class="size-3.5" />
    <span class="truncate">{channelName}</span>
  </button>

  {#each crumbs as c, i (c.idx)}
    <ChevronRightIcon class="size-3.5 shrink-0 text-text-faint" />
    {#if c.idx === -1}
      <span class="text-text-faint px-1 text-sm" aria-hidden="true">…</span>
    {:else}
      <button
        type="button"
        class="shrink-0 rounded-md bg-bg-hover/60 px-2 py-1 text-sm hover:bg-bg-hover"
        onclick={() => navigate(c.idx)}
        data-testid="crumb-{c.idx}"
      >
        {c.label}
      </button>
    {/if}
  {/each}
</header>
