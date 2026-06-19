<!--
  WatchBackgroundFrame — one persistent fixed wrapper around a WatchPartyTile.

  CRITICAL: the content slot is rendered exactly once, never inside an {#if}.
  Docked <-> corner changes only the wrapper position/size, never reparents the
  tile (and thus its <video>/iframe) — so playback never resets.

  Corner mode is draggable, but ONLY by the top grab strip — never the whole
  tile (a full-tile drag overlay swallowed the player's control-bar clicks in
  the earlier attempt). While a drag is active a transient full-viewport overlay
  sits above the tile so the <iframe>/<video> can't capture the pointer mid-drag
  (cross-document events would otherwise abort the drag). Docked mode is fixed to
  the StreamGrid anchor and ignores any dragged position.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
  import GripHorizontalIcon from '@lucide/svelte/icons/grip-horizontal';
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

  let frameEl: HTMLDivElement;
  // User-dragged position (viewport px, top/left). Null = use the default
  // stacked corner placement. Kept while the frame stays mounted; docked mode
  // overrides it via `rect`, and re-undocking restores the dragged spot.
  let pos = $state<{ top: number; left: number } | null>(null);
  let dragging = $state(false);
  // Pointer + frame origin captured on grab; deltas from here drive the move.
  let dragStart = { x: 0, y: 0, top: 0, left: 0 };

  let frameStyle = $derived.by(() => {
    if (rect) {
      return `top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px;`;
    }
    if (pos) {
      return `top:${pos.top}px;left:${pos.left}px;width:${CORNER_W}px;height:${CORNER_H}px;`;
    }
    const top = TOP_MARGIN + index * STACK;
    const right = MARGIN + index * STACK;
    return `top:${top}px;right:${right}px;width:${CORNER_W}px;height:${CORNER_H}px;`;
  });

  // Keep the window fully on-screen.
  function clamp(top: number, left: number): { top: number; left: number } {
    const maxTop = Math.max(MARGIN, window.innerHeight - CORNER_H - MARGIN);
    const maxLeft = Math.max(MARGIN, window.innerWidth - CORNER_W - MARGIN);
    return {
      top: Math.min(Math.max(MARGIN, top), maxTop),
      left: Math.min(Math.max(MARGIN, left), maxLeft)
    };
  }

  function onGrabDown(e: PointerEvent): void {
    if (rect) return; // draggable only in corner mode
    const r = frameEl.getBoundingClientRect();
    dragStart = { x: e.clientX, y: e.clientY, top: r.top, left: r.left };
    dragging = true;
    e.preventDefault();
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    pos = clamp(
      dragStart.top + (e.clientY - dragStart.y),
      dragStart.left + (e.clientX - dragStart.x)
    );
  }

  function onPointerUp(): void {
    dragging = false;
  }

  function onResize(): void {
    if (pos) pos = clamp(pos.top, pos.left);
  }
</script>

<svelte:window onpointermove={onPointerMove} onpointerup={onPointerUp} onresize={onResize} />

<div
  bind:this={frameEl}
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
    <!-- corner grab strip: the ONLY draggable surface (keeps the player's own
         controls clickable). Holds the "back to voice" button on the left. -->
    <div
      class="absolute inset-x-0 top-0 z-10 flex h-7 touch-none select-none items-center justify-center bg-gradient-to-b from-black/55 to-transparent {dragging
        ? 'cursor-grabbing'
        : 'cursor-grab'}"
      onpointerdown={onGrabDown}
      role="presentation"
      data-testid="watch-bg-drag"
    >
      <GripHorizontalIcon class="size-4 text-white/70" />
    </div>
    <button
      type="button"
      class="absolute left-1 top-1 z-20 flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-1 text-xs text-white hover:bg-black/75"
      onpointerdown={(e) => e.stopPropagation()}
      onclick={onReturn}
      data-testid="watch-bg-return"
      aria-label={m.watch_pip_return()}
      title={m.watch_pip_return()}
    >
      <Maximize2Icon class="size-3.5" />
    </button>
  {/if}
</div>

{#if dragging}
  <!-- transient cover above the tile (z-40 > frame z-30): keeps pointer events
       in this document so an <iframe>/<video> can't swallow them mid-drag. -->
  <div class="fixed inset-0 z-40 cursor-grabbing select-none" data-testid="watch-bg-drag-cover"></div>
{/if}
