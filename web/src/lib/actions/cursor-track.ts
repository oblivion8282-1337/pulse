import type { Action } from 'svelte/action';

/**
 * Verfolgt den Pointer relativ zur Bounding-Box des Knotens und meldet
 * Position (x/y in px) + Aktiv-Status an den Callback. Beim Verlassen wird die
 * letzte Position beibehalten (kein Sprung in die Ecke) und nur `active=false`
 * gemeldet, damit das Radar sanft an Ort und Stelle ausblenden kann.
 *
 * Als Action angehängt (statt als Handler-Attribut), damit die rein dekorative
 * Pointer-Verfolgung nicht den a11y-no-static-interactions-Lint auslöst — das
 * Element hat keine echte Funktion und keine Tastatur-Geste.
 */
export const cursorTrack: Action<
  HTMLElement,
  (x: number, y: number, active: boolean) => void
> = (node, onUpdate) => {
  let cb = onUpdate;
  let lastX = 0;
  let lastY = 0;

  function move(e: PointerEvent) {
    const rect = node.getBoundingClientRect();
    lastX = e.clientX - rect.left;
    lastY = e.clientY - rect.top;
    cb(lastX, lastY, true);
  }
  function leave() {
    cb(lastX, lastY, false);
  }

  node.addEventListener('pointermove', move);
  node.addEventListener('pointerleave', leave);

  return {
    update(next) {
      cb = next;
    },
    destroy() {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerleave', leave);
    },
  };
};
