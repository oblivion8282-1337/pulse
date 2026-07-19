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
  import { Button } from '$lib/components/ui/button';

  type Crumb = {
    /** Display label. */
    label: string;
    /** Ancestor index: ``1`` = first segment, ``2`` = second, etc.
     *  The channel-name button passes ``0`` directly to ``navigate``
     *  for the root, so it stays out of the ``crumbs`` array. ``-1``
     *  marks the ellipsis placeholder. */
    idx: number;
  };

  type Props = {
    channelName: string;
    currentPath: string;
    /** Navigate to ancestor at this index (0 = root, 1 = first
     *  segment, 2 = second, …). */
    navigate: (idx: number) => void;
  };

  let { channelName, currentPath, navigate }: Props = $props();

  const segments = $derived(currentPath ? currentPath.split('/') : []);

  // Keep root + last two segments when the path is long enough to
  // overflow; middle segments collapse to a non-clickable ellipsis.
  // Crumb idx is 1-based so it lines up with ``navigateToIndex(i)``,
  // which means "go to ancestor at position i" (0 = root, 1 = first
  // segment, …). 0-based idx would clash with the channel-name
  // button's root-jump and route the user to the wrong folder.
  const crumbs = $derived.by((): Crumb[] => {
    if (segments.length <= 3) {
      return segments.map((s, i) => ({ label: s, idx: i + 1 }));
    }
    return [
      { label: segments[0], idx: 1 },
      { label: '…', idx: -1 },
      { label: segments[segments.length - 2], idx: segments.length - 1 },
      { label: segments[segments.length - 1], idx: segments.length }
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
  <Button
    variant="secondary"
    size="sm"
    onclick={() => navigate(0)}
    data-testid="crumb-root"
    aria-label={pm.dropbox_back_root()}
  >
    <HashIcon class="size-3.5" />
    <span class="truncate">{channelName}</span>
  </Button>

  {#each crumbs as c, i (c.idx)}
    <ChevronRightIcon class="size-3.5 shrink-0 text-text-faint" />
    {#if c.idx === -1}
      <span class="text-text-faint px-1 text-sm" aria-hidden="true">…</span>
    {:else}
      <Button
        variant="secondary"
        size="sm"
        class="shrink-0"
        onclick={() => navigate(c.idx)}
        data-testid="crumb-{c.idx}"
      >
        {c.label}
      </Button>
    {/if}
  {/each}
</header>
