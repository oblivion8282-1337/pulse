<!--
  WatchBackgroundFrame — one persistent fixed wrapper around a WatchPartyTile.

  CRITICAL: the content slot is rendered exactly once, never inside an {#if}.
  Docked <-> corner changes only the wrapper position/size, never reparents the
  tile (and thus its <video>/iframe) — so playback never resets.

  No drag overlay over the tile (that swallowed the control-bar clicks in the
  earlier attempt). Returning to voice is an explicit small button in the corner
  view; closing stays on the tile's own controls.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
  import { m } from '$lib/paraglide/messages.js';

  let {
    rect,
    index,
    onReturn,
    children
  }: {
    rect: DOMRect | null;
    index: number;
    onReturn: () => void;
    children: Snippet;
  } = $props();

  const CORNER_W = 360;
  const CORNER_H = 248;
  const MARGIN = 16;
  // Top offset clears the channel header (h-14 = 56px) so the corner window sits
  // in free space below it — and, crucially, well away from the message
  // composer at the bottom, which it used to overlap.
  const TOP_MARGIN = 72;
  const STACK = 28; // offset per stacked corner window

  let frameStyle = $derived.by(() => {
    if (rect) {
      return `top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px;`;
    }
    const top = TOP_MARGIN + index * STACK;
    const right = MARGIN + index * STACK;
    return `top:${top}px;right:${right}px;width:${CORNER_W}px;height:${CORNER_H}px;`;
  });
</script>

<div
  class="fixed z-30 overflow-hidden {rect ? '' : 'rounded-xl shadow-2xl ring-1 ring-white/10'}"
  style={frameStyle}
  data-testid="watch-bg-frame"
  data-mode={rect ? 'docked' : 'corner'}
>
  <!-- content: rendered EXACTLY once, never branched -->
  <div class="h-full w-full">
    {@render children()}
  </div>

  {#if !rect}
    <!-- corner view: small explicit "back to the voice channel" button, top-left,
         above the tile but well clear of the bottom control bar. -->
    <button
      type="button"
      class="absolute left-1 top-1 z-10 flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-1 text-xs text-white hover:bg-black/75"
      onclick={onReturn}
      data-testid="watch-bg-return"
      aria-label={m.watch_pip_return()}
      title={m.watch_pip_return()}
    >
      <Maximize2Icon class="size-3.5" />
    </button>
  {/if}
</div>
