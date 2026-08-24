<script lang="ts">
  /**
   * Der Layout-Reiter: persönliche Reihenfolge der vier Navigations-Bereiche.
   *
   * Drag & Drop über Pointer-Events statt HTML5-DnD: die Einstellungen werden
   * überwiegend am Handy benutzt, und das native Drag-Modell reagiert dort auf
   * nichts. Der Griff führt die Zeile — ein Griff ist ein eindeutiges „hier
   * anfassen", ein Ganze-Zeile-Griff kollidiert mit Scroll-Gesten.
   */
  import { settings } from '$lib/stores/settings.svelte';
  import type { Bereich, TabId } from '$lib/navigation/tabs';
  import { SYMBOLE, beschriftung, bereichsReihenfolge } from '$lib/navigation/darstellung.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';
  import { m } from '$lib/paraglide/messages.js';

  /** Die Zeilen in der aktuell geltenden Reihenfolge; während des Ziehens
   *  live umsortiert, beim Loslassen persistent gemacht. */
  let reihenfolge = $state<Bereich[]>([]);
  $effect(() => {
    reihenfolge = [...bereichsReihenfolge()];
  });

  let gezogen: TabId | null = $state(null);

  function anfassen(id: TabId, evt: PointerEvent) {
    (evt.currentTarget as HTMLElement).setPointerCapture(evt.pointerId);
    gezogen = id;
  }

  function bewegen(evt: PointerEvent) {
    if (!gezogen) return;
    const von = reihenfolge.findIndex((b) => b.id === gezogen);
    if (von < 0) return;
    // Über welche Zeile zeigt der Finger/die Maus? Mittelpunkte vergleichen,
    // nicht Ränder — so springt die gezogene Zeile erst, wenn die Mitte der
    // Nachbarzeile erreicht ist, und nicht schon beim Berühren. Die Zeilen
    // werden hier im DOM gesucht statt über Refs: `use:`-Actions mit Argument
    // erzeugen in dieser Svelte-Version ungültigen Code, `bind:this` kann
    // nichts in eine Map schreiben.
    let nach = von;
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid^="layout-row-"]')) {
      const id = (el.dataset.testid ?? '').replace('layout-row-', '') as TabId;
      if (id === gezogen) continue;
      const r = el.getBoundingClientRect();
      if (evt.clientY >= r.top && evt.clientY <= r.bottom) {
        nach = reihenfolge.findIndex((b) => b.id === id);
        break;
      }
    }
    if (nach === von || nach < 0) return;
    const next = [...reihenfolge];
    [next[von], next[nach]] = [next[nach], next[von]];
    reihenfolge = next;
  }

  function loslassen() {
    if (!gezogen) return;
    gezogen = null;
    settings.setNavOrder(reihenfolge.map((b) => b.id));
  }
</script>

<div class="flex flex-col gap-5" data-testid="settings-layout-panel">
  <div class="flex flex-col gap-1">
    <h2 class="text-text-bright text-base font-semibold">{m.settings_layout_title()}</h2>
    <p class="text-text-muted text-xs">{m.settings_layout_subtitle()}</p>
  </div>

  <ul class="flex flex-col gap-2" data-testid="layout-order-list">
    {#each reihenfolge as bereich (bereich.id)}
      {@const Symbol = SYMBOLE[bereich.id]}
      <li
        class="flex items-center gap-2 rounded-2xl border p-3 transition-colors {gezogen === bereich.id
          ? 'border-primary bg-bg-hover opacity-60'
          : 'border-border bg-bg-base'}"
        data-testid="layout-row-{bereich.id}"
      >
        <button
          type="button"
          onpointerdown={(evt) => anfassen(bereich.id, evt)}
          onpointermove={bewegen}
          onpointerup={loslassen}
          onpointercancel={loslassen}
          class="text-text-muted hover:text-text-bright cursor-grab touch-none self-stretch flex items-center rounded-lg px-1 active:cursor-grabbing"
          data-testid="layout-handle-{bereich.id}"
          aria-label={m.settings_layout_drag_label({ bereich: beschriftung(bereich.id) })}
        >
          <GripVerticalIcon class="size-5" />
        </button>
        <span class="flex items-center gap-2 text-text-bright text-sm font-medium">
          {#if bereich.id === 'me' && safeAvatarUrl(auth.user?.avatar_url)}
            <img
              src={safeAvatarUrl(auth.user?.avatar_url) ?? ''}
              alt={beschriftung(bereich.id)}
              class="size-5 rounded-full object-cover"
            />
          {:else}
            <Symbol class="size-5" />
          {/if}
          {beschriftung(bereich.id)}
        </span>
      </li>
    {/each}
  </ul>

  <div class="flex flex-col gap-2">
    <button
      type="button"
      onclick={() => settings.setNavOrder(null)}
      class="rounded-2xl border border-border p-3 text-center text-sm font-medium text-text-base transition-colors hover:bg-bg-hover hover:text-text-bright"
      data-testid="layout-reset-all"
    >
      {m.settings_layout_reset_all()}
    </button>
    <p class="text-text-muted text-xs">{m.settings_layout_reset_all_hint()}</p>
  </div>
</div>
