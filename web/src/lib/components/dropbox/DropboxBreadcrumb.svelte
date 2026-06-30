<script lang="ts">
  /**
   * Dropbox-channel header — channel name + path crumbs.
   * Clicking a crumb collapses the path back to that segment.
   * Emits `navigate` with the segment name; the parent decides how
   * to fold it (root segment → empty path).
   */
  import HashIcon from '@lucide/svelte/icons/hash';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';

  type Props = {
    channelName: string;
    currentPath: string;
    navigate: (seg: string) => void;
  };

  let { channelName, currentPath, navigate }: Props = $props();

  const segments = $derived(currentPath ? currentPath.split('/') : []);
</script>

<header
  class="flex items-center gap-2 border-b border-border/40 px-5 py-3 text-text-muted"
>
  <HashIcon class="size-4" />
  <span class="text-sm font-medium text-text-base">{channelName}</span>
  {#if segments.length}
    <ChevronRightIcon class="size-3.5 text-text-faint" />
    {#each segments as seg, i (i)}
      <button
        class="text-sm hover:underline"
        onclick={() => navigate(seg)}
        data-testid="crumb-{i}"
      >
        {seg}
      </button>
      {#if i < segments.length - 1}
        <ChevronRightIcon class="size-3.5 text-text-faint" />
      {/if}
    {/each}
  {/if}
</header>
