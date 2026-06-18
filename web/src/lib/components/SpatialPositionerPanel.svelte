<!--
  SpatialPositionerPanel — wraps the spatial drag circle in the sidebar. The
  circle can be collapsed away (chevron header, state remembered) and popped out
  into a free-floating in-app window (SpatialFloatingWindow). Works the same in
  the browser and Electron (pure DOM, no OS window / Document-PiP).

  While popped out, the sidebar shows a slim placeholder with a "bring back"
  button; the member list above it stays untouched.
-->
<script lang="ts">
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import MaximizeIcon from '@lucide/svelte/icons/maximize-2';
  import SpatialPositioner from './SpatialPositioner.svelte';
  import SpatialFloatingWindow from './SpatialFloatingWindow.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { size = 200 }: { size?: number } = $props();

  const COLLAPSE_KEY = 'dcc.spatial.collapsed';
  let floating = $state(false);
  let collapsed = $state(
    typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSE_KEY) === '1'
  );

  function toggleCollapsed(): void {
    collapsed = !collapsed;
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* non-critical */
    }
  }
</script>

{#if floating}
  <div
    class="ml-4 flex flex-col items-center gap-2 py-3 text-center"
    data-testid="spatial-detached-placeholder"
  >
    <p class="text-text-muted text-xs">{m.spatial_detached()}</p>
    <button
      type="button"
      onclick={() => (floating = false)}
      class="bg-bg-input hover:bg-bg-hover text-text-base rounded-md px-3 py-1 text-xs"
    >
      {m.spatial_reattach()}
    </button>
  </div>
  <SpatialFloatingWindow onClose={() => (floating = false)} />
{:else}
  <div class="ml-4 flex flex-col">
    <div class="flex items-center justify-between">
      <button
        type="button"
        onclick={toggleCollapsed}
        class="text-text-muted hover:text-text-base flex items-center gap-1 text-xs"
        data-testid="spatial-collapse"
        aria-expanded={!collapsed}
      >
        {#if collapsed}
          <ChevronRightIcon class="size-3.5" />
        {:else}
          <ChevronDownIcon class="size-3.5" />
        {/if}
        {m.spatial_window_title()}
      </button>
      {#if !collapsed}
        <button
          type="button"
          onclick={() => (floating = true)}
          class="text-text-muted hover:bg-bg-hover hover:text-text-base flex items-center justify-center rounded-md p-1"
          title={m.spatial_detach()}
          aria-label={m.spatial_detach()}
          data-testid="spatial-detach"
        >
          <MaximizeIcon class="size-4" />
        </button>
      {/if}
    </div>
    {#if !collapsed}
      <SpatialPositioner {size} />
    {/if}
  </div>
{/if}
