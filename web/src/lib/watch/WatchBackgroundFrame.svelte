<!--
  WatchBackgroundFrame — one persistent fixed wrapper around a WatchPartyTile.

  CRITICAL: the content slot is rendered exactly once, never inside an {#if}.
  Docked <-> corner changes only the wrapper position/size, never reparents the
  tile (and thus its <video>/iframe) — so playback never resets.

  Corner mode behaves like Android's picture-in-picture — ABER NUR AM FINGER
  (`viewport.zeigerGrob`):
  * grab the window anywhere and drag → moves it,
  * hold BOTH ends of a diagonal (top-left + bottom-right OR top-right +
    bottom-left) and pinch → resizes it (smaller and bigger, any corner pair),
  * a single tap toggles the floating controls — close (X) top-left, back to
    channel (fullscreen) bottom-right — which auto-hide after HUD_HIDE_MS.
  The tile's own floating buttons are hidden via `[data-pip-hide]` (app.css)
  so exactly ONE set of controls exists.

  **Am Rechner bleibt es beim Greifstreifen oben** — dort rendert `TileShell`
  weiterhin seine Leiste `TileDock` unter dem Bild, und die trägt kein
  `data-pip-hide`. Eine ganzflächige Zieh-Ebene läge darüber und schluckte
  jeden Klick auf Stummschaltung, Lautstärke, Chat, Warteschlange, Statistik
  und Vollbild; genau daran ist ein früherer Versuch schon einmal gescheitert
  (der Hinweis stand hier und ging beim Umbau auf PiP verloren). Am Finger
  gibt es diese Leiste nicht — dort ist die volle Fläche richtig.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
  import XIcon from '@lucide/svelte/icons/x';
  import { m } from '$lib/paraglide/messages.js';
  import { viewport } from '$lib/stores/viewport.svelte';
  import {
    abstand,
    einpassen,
    eckeVon,
    istDiagonale,
    skalieren,
    MARGIN,
    TAP_TOLERANZ
  } from './eckfensterGesten';

  let {
    rect,
    index,
    onReturn,
    onClose,
    children
  }: {
    rect: DOMRect | null;
    index: number;
    onReturn: () => void;
    /** Schließen-Kreuz des Eckfensters — Host schließt damit die Kachel. */
    onClose?: () => void;
    children: Snippet;
  } = $props();

  const CORNER_W = 360;
  const CORNER_H = 248;
  // Top offset clears the channel header (h-14 = 56px) so the corner window sits
  // in free space below it — and, crucially, well away from the message
  // composer at the bottom, which it used to overlap.
  const TOP_MARGIN = 72;
  const STACK = 28; // offset per stacked corner window
  const HUD_HIDE_MS = 3000;

  let frameEl: HTMLDivElement;
  // User-dragged position (viewport px, top/left). Null = use the default
  // stacked corner placement. Kept while the frame stays mounted; docked mode
  // overrides it via `rect`, and re-undocking restores the dragged spot.
  let pos = $state<{ top: number; left: number } | null>(null);
  // Nutzer-Skalierung des Eckfensters (Breite/Höhe in px). Null = Standardgröße.
  let groesse = $state<{ w: number; h: number } | null>(null);
  let dragging = $state(false);
  // PiP-Steuerung: sichtbar nach Tap, verschwindet nach HUD_HIDE_MS.
  let hud = $state(false);
  let hudTimer: ReturnType<typeof setTimeout> | null = null;
  // Pointer + frame origin captured on grab; deltas from here drive the move.
  let dragStart = { x: 0, y: 0, top: 0, left: 0 };
  /**
   * Hat sich der Finger seit dem Aufsetzen weiter als `TAP_TOLERANZ` bewegt?
   *
   * **`$state`, nicht bloss `let`** — der Wert steht im Markup: an ihm hängt
   * die durchsichtige Decke, die während des Ziehens über der Kachel liegt und
   * verhindert, dass ein `<iframe>`/`<video>` den Zeiger mitten in der
   * Bewegung schluckt (dokumentübergreifende Ereignisse brächen den Zug ab).
   * Als lose Variable wurde der Wechsel false→true nicht gemeldet: er passiert
   * mitten in `onPointerMove`, wo sich `dragging` gerade nicht ändert — die
   * Decke erschien deshalb gar nicht. svelte-check hatte das gemeldet.
   */
  let zeigteBewegung = $state(false);

  // Aktive Pointer auf der PiP-Fläche (Pointer-Id → Position).
  const pointer = new Map<number, { x: number; y: number }>();
  // Pinch-Start: Abstand der beiden Finger + Fenstergröße + Mittelpunkt.
  let pinch: { dist: number; w: number; h: number; cx: number; cy: number } | null = null;

  function hudZeigen(): void {
    hud = true;
    if (hudTimer) clearTimeout(hudTimer);
    hudTimer = setTimeout(() => (hud = false), HUD_HIDE_MS);
  }

  let breite = $derived(groesse?.w ?? CORNER_W);
  let hoehe = $derived(groesse?.h ?? CORNER_H);

  let frameStyle = $derived.by(() => {
    if (rect) {
      return `top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px;`;
    }
    if (pos) {
      return `top:${pos.top}px;left:${pos.left}px;width:${breite}px;height:${hoehe}px;`;
    }
    const top = TOP_MARGIN + index * STACK;
    const right = MARGIN + index * STACK;
    return `top:${top}px;right:${right}px;width:${breite}px;height:${hoehe}px;`;
  });

  /** Kurzform: die Rechnung selbst steht in `eckfensterGesten.ts`. */
  function clamp(top: number, left: number): { top: number; left: number } {
    return einpassen({ top, left }, { w: breite, h: hoehe }, window);
  }

  function onFensterDown(e: PointerEvent): void {
    if (rect) return; // drag/resize only in corner mode
    pointer.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointer.size === 2) {
      // Zwei Finger: Pinch, wenn sie gegenüberliegende Ecken halten
      // (ol+ur oder or+ul) — dann Skalieren statt Verschieben.
      const [r1, r2] = [...pointer.values()];
      const box = frameEl.getBoundingClientRect();
      if (istDiagonale(eckeVon(box, r1.x, r1.y), eckeVon(box, r2.x, r2.y))) {
        pinch = {
          dist: abstand(r1, r2),
          w: breite,
          h: hoehe,
          cx: (r1.x + r2.x) / 2,
          cy: (r1.y + r2.y) / 2
        };
        dragging = false; // ein evtl. laufender Einzelzug wird abgebrochen
        zeigteBewegung = true;
        return;
      }
    }
    if (pinch) return; // Pinch läuft — keine neuen Einzelgriffe zulassen
    const r = frameEl.getBoundingClientRect();
    dragStart = { x: e.clientX, y: e.clientY, top: r.top, left: r.left };
    zeigteBewegung = false;
    dragging = true; // „potentiell" — entschieden wird in der ersten Bewegung
    e.preventDefault();
  }

  function onPointerMove(e: PointerEvent): void {
    if (pointer.has(e.pointerId)) pointer.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Pinch: Größe proportional zum Fingerabstand, Mittelpunkt bleibt fix.
    if (pinch && pointer.size >= 2) {
      const [r1, r2] = [...pointer.values()];
      const { w, h } = skalieren(pinch, pinch.dist, abstand(r1, r2), window);
      groesse = { w, h };
      pos = einpassen(
        { top: pinch.cy - h / 2, left: pinch.cx - w / 2 },
        { w, h },
        window
      );
      return;
    }
    if (!dragging) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    // Unter der Toleranz bleibt der Finger ein TAP-Kandidat — kein Ruckeln
    // des Fensters bei jedem kleinen Zittern.
    if (!zeigteBewegung && Math.hypot(dx, dy) <= TAP_TOLERANZ) return;
    zeigteBewegung = true;
    pos = clamp(dragStart.top + dy, dragStart.left + dx);
  }

  function onPointerUp(e: PointerEvent): void {
    pointer.delete(e.pointerId);
    if (pointer.size < 2) pinch = null;
    if (pointer.size === 0) {
      if (dragging && !zeigteBewegung) hudZeigen(); // Tap → Steuerung togglen
      else if (dragging && hud) hudZeigen(); // Timer nach dem Ziehen nachstellen
      dragging = false;
    }
  }

  function onResize(): void {
    if (pos) pos = clamp(pos.top, pos.left);
  }

  $effect(() => {
    return () => {
      if (hudTimer) clearTimeout(hudTimer);
    };
  });
</script>

<svelte:window onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp} onresize={onResize} />

<div
  bind:this={frameEl}
  class="fixed z-30 overflow-hidden {rect ? '' : 'pip-eckfenster rounded-xl shadow-2xl ring-1 ring-white/10'}"
  style={frameStyle}
  data-testid="watch-bg-frame"
  data-mode={rect ? 'docked' : 'corner'}
>
  <!-- content: rendered EXACTLY once, never branched -->
  <div class="h-full w-full">
    {@render children()}
  </div>

  {#if !rect}
    <!-- PiP-Fläche: fängt die Pointer-Events des Eckfensters — Ziehen verschiebt
         das Fenster, zwei Finger auf gegenüberliegenden Ecken skalieren es
         (Pinch), ein Tap (unter der Toleranz) zeigt/versteckt die Steuerung.
         Die Steuerungs-Knöpfe stoppen ihr pointerdown, damit sie nicht als
         Ziehen/Tap durchschlagen.

         Ganzflächig NUR am Finger; mit Maus bleibt es der Streifen oben, unter
         dem die Bedienleiste der Kachel klickbar bleibt (s. Kopfkommentar). -->
    <div
      class="absolute z-10 touch-none select-none {viewport.zeigerGrob
        ? 'inset-0'
        : 'inset-x-0 top-0 h-7'} {dragging ? 'cursor-grabbing' : 'cursor-grab'}"
      onpointerdown={onFensterDown}
      role="presentation"
      data-testid="pip-touch"
    ></div>

    <!-- Die Steuerung liegt NEBEN der Greiffläche, nicht darin: mit Maus ist
         die Fläche nur der Streifen oben, die Knöpfe gehören aber an die Ecken
         des ganzen Fensters. `pointer-events-none` auf der Ebene, `auto` auf
         den Knöpfen — so bleibt der abgedunkelte Grund durchlässig: bei Touch
         zählt ein Tipp darauf weiter als Tipp auf die Greiffläche, mit Maus
         bleibt die Bedienleiste der Kachel darunter klickbar. -->
    {#if hud}
      <div class="pointer-events-none absolute inset-0 z-20 bg-black/40">
        <!-- Schließen oben links -->
        {#if onClose}
          <button
            type="button"
            class="pointer-events-auto absolute top-1 left-1 z-20 flex size-9 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-black/80"
            onpointerdown={(e) => e.stopPropagation()}
            onclick={() => {
              hud = false;
              onClose?.();
            }}
            data-testid="pip-close"
            aria-label={m.tile_shell_hide_tile()}
            title={m.tile_shell_hide_tile()}
          >
            <XIcon class="size-4" />
          </button>
        {/if}
        <!-- Vollbild (zurück zum Kanal) unten rechts -->
        <button
          type="button"
          class="pointer-events-auto absolute right-1 bottom-1 z-20 flex size-9 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-black/80"
          onpointerdown={(e) => e.stopPropagation()}
          onclick={() => {
            hud = false;
            onReturn();
          }}
          data-testid="pip-return"
          aria-label={m.watch_pip_return()}
          title={m.watch_pip_return()}
        >
        <Maximize2Icon class="size-4" />
      </button>
      </div>
    {/if}
  {/if}
</div>

{#if dragging && zeigteBewegung}
  <!-- transient cover above the tile (z-40 > frame z-30): keeps pointer events
       in this document so an <iframe>/<video> can't swallow them mid-drag. -->
  <div class="fixed inset-0 z-40 cursor-grabbing select-none" data-testid="watch-bg-drag-cover"></div>
{/if}
