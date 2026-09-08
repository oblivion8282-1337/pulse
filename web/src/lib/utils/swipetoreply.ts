/**
 * `use:swipetoreply` — horizontale Zuggeste auf einer DM-Bubble, die die
 * Antwort vorbereitet (WhatsApp-Prinzip, P1.6). Touch-only wie
 * `utils/longpress.ts`; Maus bleibt Desktop-Affordance vorbehalten.
 *
 * Die Blase folgt dem Finger (gekappt), ab `ANTWORT_SCHWELLE` löst das
 * Loslassen `onReply` aus (mit Haptic-Tick). Vertikal dominierter Zug =
 * Scrollen und wird ignoriert — deshalb engagiert sich die Geste erst,
 * wenn der horizontale Anteil führt; danach wird vertikal ЭИНSEITIG
 * gekapselt (der Zug gehört der Antwort).
 *
 * Koexistenz mit `longpress`: Longpress bricht bei Bewegung >10 px ab,
 * die Antwort-Geste braucht Bewegung — beide gehen sich nie in den Weg.
 * Koexistenz mit dem Scrollen: die Blase trägt `touch-action: pan-y`
 * (in der Komponente) — vertikal scrollt der Browser nativ, horizontale
 * pointermove-Ereignisse kommen als Events hier an.
 */
import type { Action } from 'svelte/action';
import { ANTWORT_SCHWELLE, fuehrtZuAntwort, klemmeOffset } from './swipeKern';

export interface SwipeReplyOpts {
  onReply: () => void;
  /** Live-Versatz für die Pfeil-Optik in der Komponente. */
  onMove?: (offset: number) => void;
}

export const swipetoreply: Action<HTMLElement, SwipeReplyOpts> = (node, opts) => {
  let current = opts;
  let startX = 0;
  let startY = 0;
  let aktiv = false;

  const zuruecksetzen = () => {
    aktiv = false;
    node.style.transform = '';
    current.onMove?.(0);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    startX = e.clientX;
    startY = e.clientY;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!aktiv) {
      if (!fuehrtZuAntwort(dx, dy)) return;
      aktiv = true;
      node.setPointerCapture(e.pointerId);
    }
    const offset = klemmeOffset(dx);
    node.style.transform = `translateX(${offset}px)`;
    current.onMove?.(offset);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!aktiv) return;
    const dx = e.clientX - startX;
    const ausgelöst = Math.abs(dx) >= ANTWORT_SCHWELLE;
    zuruecksetzen();
    if (ausgelöst) {
      try {
        navigator.vibrate?.(8);
      } catch {
        /* vibration unavailable */
      }
      current.onReply();
    }
  };

  const onPointerCancel = () => zuruecksetzen();

  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', onPointerUp);
  node.addEventListener('pointercancel', onPointerCancel);
  node.addEventListener('pointerleave', onPointerCancel);

  return {
    update(next: SwipeReplyOpts) {
      current = next;
    },
    destroy() {
      zuruecksetzen();
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerUp);
      node.removeEventListener('pointercancel', onPointerCancel);
      node.removeEventListener('pointerleave', onPointerCancel);
    }
  };
};
