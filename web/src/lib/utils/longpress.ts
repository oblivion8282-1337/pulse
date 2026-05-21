/**
 * `use:longpress` — fires `onLongPress` after the finger has rested on the
 * node for `duration` ms. Touch-only by design: a mouse `pointerdown` is
 * ignored so desktop hover-affordances stay the single source of truth and
 * this never double-fires alongside them.
 *
 * Cancels on move > 10 px (the gesture became a scroll/drag) and on
 * up/cancel/leave. After a successful fire it swallows the trailing
 * `click` (capture phase) so a long-press that happens to land on a child
 * button doesn't also trigger that button. The native touch context menu
 * is suppressed for the same gesture — our sheet is the only thing meant
 * to open.
 */
import type { Action } from 'svelte/action';

export interface LongpressOpts {
  /** Hold time before firing, ms. Default 450. */
  duration?: number;
  onLongPress: (e: PointerEvent) => void;
}

export const longpress: Action<HTMLElement, LongpressOpts> = (node, opts) => {
  let current = opts;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;
  let lastTouch = false;
  let suppressClick = false;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    lastTouch = e.pointerType === 'touch';
    if (!lastTouch) return;
    startX = e.clientX;
    startY = e.clientY;
    clear();
    timer = setTimeout(() => {
      timer = null;
      suppressClick = true;
      // Best-effort haptic tick — unsupported on iOS Safari, hence the guard.
      try {
        navigator.vibrate?.(8);
      } catch {
        /* vibration unavailable */
      }
      current.onLongPress(e);
    }, current.duration ?? 450);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (timer === null) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 10) clear();
  };

  const onContextMenu = (e: Event) => {
    if (lastTouch) e.preventDefault();
  };

  const onClickCapture = (e: MouseEvent) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  };

  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', clear);
  node.addEventListener('pointercancel', clear);
  node.addEventListener('pointerleave', clear);
  node.addEventListener('contextmenu', onContextMenu);
  node.addEventListener('click', onClickCapture, true);

  return {
    update(next: LongpressOpts) {
      current = next;
    },
    destroy() {
      clear();
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', clear);
      node.removeEventListener('pointercancel', clear);
      node.removeEventListener('pointerleave', clear);
      node.removeEventListener('contextmenu', onContextMenu);
      node.removeEventListener('click', onClickCapture, true);
    }
  };
};
