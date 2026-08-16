<!--
  Die Rangleiter — links in der Rollenverwaltung.

  Reihenfolge ist bei Rollen keine Sortierung, sondern Macht: eine Rolle
  kann nur Rollen UNTER sich verwalten. Deshalb ist das hier eine Leiter
  und keine Liste: ein Ziehgriff je Zeile sagt „das hier ordnest du an",
  ein einziger Satz darueber sagt, was die Anordnung bedeutet.

  Die Pfeile bleiben daneben stehen. Sie sind nicht doppelt gemoppelt,
  sondern die einzige Bedienung, die ohne Maus funktioniert — HTML5-
  Ziehen ist weder mit der Tastatur noch auf einem Touchgeraet erreichbar.

  `@everyone` steht abgesetzt unter einer gestrichelten Linie: sie ist der
  Boden, auf dem alle stehen — nicht loeschbar, nicht umbenennbar, nicht
  verschiebbar.
-->
<script lang="ts">
  import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';
  import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import type { Role } from '$lib/api/roles';
  import { m } from '$lib/paraglide/messages.js';
  import { gezogen, verschoben } from './reihenfolge';

  let {
    rollen,
    everyone,
    selectedId,
    anzahl,
    onselect,
    onreorder
  }: {
    /** Alle Rollen ausser @everyone, hoechste zuerst. */
    rollen: Role[];
    everyone: Role | undefined;
    selectedId: string | undefined;
    /** Traegerzahl, oder `null` solange nichts Verlaessliches vorliegt. */
    anzahl: (role: Role) => number | null;
    onselect: (id: string) => void;
    /** Neue Reihenfolge (ohne @everyone). Der Aufrufer entscheidet, was
     * davon an den Server geht — siehe `reihenfolge.ts`. */
    onreorder: (neu: Role[]) => void;
  } = $props();

  // id → Platz in `rollen`, damit die Pruefungen je Zeile O(1) sind statt
  // eines findIndex pro Zeile (insgesamt O(N²) im {#each}).
  let platz = $derived(new Map(rollen.map((r, i) => [r.id, i])));

  // Ziehzustand. `ziehId` ist die bewegte Rolle, `ueberId` die Zeile, VOR
  // die eingefuegt wuerde.
  let ziehId = $state<string | null>(null);
  let ueberId = $state<string | null>(null);

  function ziehStart(e: DragEvent, id: string): void {
    if (!e.dataTransfer) return;
    ziehId = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }

  function ziehUeber(e: DragEvent, id: string): void {
    if (!ziehId || ziehId === id) return;
    e.preventDefault();
    ueberId = id;
  }

  /** Zuruecksetzen, wenn ein Zug ohne gueltiges Ablegen endet (ausserhalb
   * losgelassen, Escape mittendrin). Der Browser feuert dann `dragend` auf
   * der Quelle, aber kein `drop` — ohne das bliebe die Quellzeile blass
   * und der Ziel-Ring stehen. */
  function ziehEnde(): void {
    ziehId = null;
    ueberId = null;
  }

  function ablegen(e: DragEvent, zielId: string): void {
    e.preventDefault();
    const quelle = ziehId;
    ziehEnde();
    if (!quelle || quelle === zielId) return;
    const von = platz.get(quelle);
    const nach = platz.get(zielId);
    if (von === undefined || nach === undefined) return;
    const neu = gezogen(rollen, von, nach);
    if (neu) onreorder(neu);
  }

  function schieben(id: string, richtung: -1 | 1): void {
    const von = platz.get(id);
    if (von === undefined) return;
    const neu = verschoben(rollen, von, richtung);
    if (neu) onreorder(neu);
  }

  function farbe(r: Role): string {
    return r.color != null ? '#' + r.color.toString(16).padStart(6, '0') : 'var(--muted-foreground)';
  }
</script>

<!-- Der anklickbare Kern einer Zeile. Einmal beschrieben, weil ihn die
     verschiebbaren Rollen und @everyone gleich brauchen — nur der Rahmen
     drumherum unterscheidet sich (Griff und Pfeile gibt es nur oben). -->
{#snippet zeileninhalt(r: Role)}
  {@const n = anzahl(r)}
  <span
    class="size-2.5 shrink-0 rounded-full"
    style={`background-color: ${farbe(r)}`}
    aria-hidden="true"
  ></span>
  <span
    class="truncate font-medium"
    style={r.color != null ? `color: ${farbe(r)}` : ''}
    data-testid={`role-name-${r.id}`}
  >
    {r.name}
  </span>
  {#if n !== null}
    <span
      class="text-text-muted ml-auto shrink-0 text-xs tabular-nums"
      title={m.rollen_leiter_traeger_titel({ count: n })}
    >
      {n}
    </span>
  {/if}
{/snippet}

<p class="text-text-muted mb-2 text-xs">{m.rollen_leiter_macht_hinweis()}</p>

<ul class="space-y-1" data-testid="rollen-leiter">
  {#each rollen as r, i (r.id)}
    <li
      draggable="true"
      ondragstart={(e) => ziehStart(e, r.id)}
      ondragover={(e) => ziehUeber(e, r.id)}
      ondragleave={() => (ueberId = null)}
      ondragend={ziehEnde}
      ondrop={(e) => ablegen(e, r.id)}
      class="flex items-center gap-1 rounded-xl pr-1 transition-shadow"
      class:ring-2={ueberId === r.id}
      class:ring-primary={ueberId === r.id}
      class:opacity-50={ziehId === r.id}
      data-testid={`role-row-${r.id}`}
    >
      <!-- Der Griff zeigt an, dass die ZEILE gezogen wird; `draggable`
           sitzt am <li>, damit die Ablegeflaeche so gross ist wie die
           Zeile selbst. Ein Griff, der allein zieht, laesst schmale
           Zeilen schwer treffen. -->
      <span class="text-text-muted shrink-0 cursor-grab px-0.5" aria-hidden="true">
        <GripVerticalIcon class="size-4" />
      </span>
      <button
        type="button"
        class="hover:bg-bg-hover flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors"
        class:bg-bg-hover={selectedId === r.id}
        onclick={() => onselect(r.id)}
      >
        {@render zeileninhalt(r)}
      </button>
      <div class="flex flex-col">
        <button
          type="button"
          class="hover:bg-bg-hover text-text-muted rounded p-0.5 opacity-70 hover:opacity-100 disabled:opacity-30"
          disabled={i === 0}
          onclick={() => schieben(r.id, -1)}
          aria-label={m.roles_editor_move_up()}
          data-testid={`role-move-up-${r.id}`}
        >
          <ChevronUpIcon class="size-3" />
        </button>
        <button
          type="button"
          class="hover:bg-bg-hover text-text-muted rounded p-0.5 opacity-70 hover:opacity-100 disabled:opacity-30"
          disabled={i === rollen.length - 1}
          onclick={() => schieben(r.id, 1)}
          aria-label={m.roles_editor_move_down()}
          data-testid={`role-move-down-${r.id}`}
        >
          <ChevronDownIcon class="size-3" />
        </button>
      </div>
    </li>
  {/each}
</ul>

{#if everyone}
  <!-- Abgesetzt hinter einer gestrichelten Linie: @everyone ist kein
       weiterer Rang, sondern der Boden, auf dem alle stehen. -->
  <div class="border-border mt-3 border-t border-dashed pt-3">
    <button
      type="button"
      class="hover:bg-bg-hover flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors"
      class:bg-bg-hover={selectedId === everyone.id}
      onclick={() => onselect(everyone.id)}
      data-testid={`role-row-${everyone.id}`}
    >
      {@render zeileninhalt(everyone)}
    </button>
    <p class="text-text-muted mt-1 px-2 text-xs">{m.rollen_leiter_everyone_hinweis()}</p>
  </div>
{/if}
