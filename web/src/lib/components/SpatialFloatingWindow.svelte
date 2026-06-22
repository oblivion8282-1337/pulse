<!--
  SpatialFloatingWindow — the spatial drag circle popped out into a free-floating
  panel that hovers over the app. Pure DOM (position: fixed, portaled to <body>),
  identical in the browser and Electron — no OS window, no Document-PiP.

  Dragged by its header bar; resizable from BOTH bottom corners (custom handles,
  the circle grows with the panel). Position AND size are kept in state and
  applied together, so dragging never resets a manual resize. "X" docks it back.
  Same JS context throughout, so the SpatialPositioner inside keeps reading the
  live participants and driving the audio engine.
-->
<script lang="ts">
  import SpatialPositioner from './SpatialPositioner.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import XIcon from '@lucide/svelte/icons/x';
  import MoveIcon from '@lucide/svelte/icons/move';

  let { onClose }: { onClose: () => void } = $props();

  const MIN_W = 300;
  const MIN_H = 360;
  const HEADER = 40; // header bar height (px)

  let w = $state(380);
  let h = $state(460);
  let x = $state(Math.max(16, window.innerWidth - 380 - 32));
  let y = $state(96);

  // Circle scales with the panel; reserve room for header + sliders + hint.
  const circleSize = $derived(Math.max(220, Math.min(w - 32, h - HEADER - 150)));

  // --- Drag (header) ---
  let dragging = false;
  let dsx = 0, dsy = 0, dox = 0, doy = 0;

  function onDragDown(e: PointerEvent): void {
    if ((e.target as HTMLElement).closest('button')) return; // let the X click through
    dragging = true;
    dsx = e.clientX; dsy = e.clientY; dox = x; doy = y;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onDragMove(e: PointerEvent): void {
    if (!dragging) return;
    // Gegen das gesamte Fenster clampen (nicht eine feste 80px-Kante): sonst
    // ließe sich das ~380px breite Fenster so weit nach rechts ziehen, dass die
    // rechten ~300px (inkl. „X"-Knopf) aus dem Viewport verschwinden.
    x = Math.max(0, Math.min(window.innerWidth - w, dox + (e.clientX - dsx)));
    y = Math.max(0, Math.min(window.innerHeight - HEADER, doy + (e.clientY - dsy)));
  }

  // --- Resize (both bottom corners) ---
  let resizing: 'sw' | 'se' | null = null;
  let rsx = 0, rsy = 0, row = 0, roh = 0, rox = 0;

  function onResizeDown(corner: 'sw' | 'se', e: PointerEvent): void {
    resizing = corner;
    rsx = e.clientX; rsy = e.clientY; row = w; roh = h; rox = x;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResizeMove(e: PointerEvent): void {
    if (!resizing) return;
    h = Math.max(MIN_H, roh + (e.clientY - rsy));
    if (resizing === 'se') {
      w = Math.max(MIN_W, row + (e.clientX - rsx));
    } else {
      const nw = Math.max(MIN_W, row - (e.clientX - rsx));
      // Rechte Kante fix halten, aber die linke nicht aus dem Viewport schieben
      // (sonst geht x negativ, wenn man die SW-Ecke nahe dem linken Rand zieht).
      x = Math.max(0, rox + (row - nw));
      w = nw;
    }
  }

  // Move the panel to <body> so a transformed ancestor can't trap the fixed
  // positioning, and so it stacks above the app chrome.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy() { node.remove(); } };
  }
</script>

<div
  use:portal
  class="border-border bg-bg-panel fixed z-50 flex flex-col overflow-hidden rounded-xl border shadow-2xl"
  style="left:{x}px;top:{y}px;width:{w}px;height:{h}px"
  data-testid="spatial-floating-window"
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="border-border flex shrink-0 cursor-move items-center justify-between border-b px-3 py-2"
    style="height:{HEADER}px"
    onpointerdown={onDragDown}
    onpointermove={onDragMove}
    onpointerup={() => (dragging = false)}
  >
    <span class="text-text-muted flex items-center gap-1.5 text-xs">
      <MoveIcon class="size-3.5" />
      {m.spatial_window_title()}
    </span>
    <button
      type="button"
      onclick={onClose}
      class="text-text-muted hover:bg-bg-hover hover:text-text-base flex items-center justify-center rounded-md p-1"
      title={m.spatial_reattach()}
      aria-label={m.spatial_reattach()}
    >
      <XIcon class="size-4" />
    </button>
  </div>

  <div class="flex flex-1 items-center justify-center">
    <SpatialPositioner size={circleSize} />
  </div>

  <!-- Resize grips: both bottom corners. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="absolute bottom-0 left-0 h-4 w-4 cursor-sw-resize"
    onpointerdown={(e) => onResizeDown('sw', e)}
    onpointermove={onResizeMove}
    onpointerup={() => (resizing = null)}
  ></div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="absolute right-0 bottom-0 h-4 w-4 cursor-se-resize"
    onpointerdown={(e) => onResizeDown('se', e)}
    onpointermove={onResizeMove}
    onpointerup={() => (resizing = null)}
  ></div>
</div>
