<!--
  DeviceMemberSection — die Geräte einer Community in der Mitgliederliste.

  **Ein eigener Abschnitt, nicht unter die Menschen gemischt** (Entwurf §5). Ein
  Gerät ist keine Person: es spricht nicht, hat keinen Anwesenheitsstatus und
  gehört in keine Sprecherliste. Stünde es zwischen den Menschen, entstünde
  genau die Verwirrung, die das Modell vermeiden soll — ein Ding, das aussieht
  wie jemand und nicht antwortet.

  **Warum Geräte in BEIDEN Listen stehen** (links in der Kanalliste, hier
  rechts) und das keine Doppelung ist: die beiden beantworten verschiedene
  Fragen. Links *wohin kann ich* — kompakt, ein Zustandspunkt, Klick führt hin.
  Hier *was gehört zu dieser Community und wie steht es gerade* — der Zustand
  ausgeschrieben, samt dem, der gerade steuert. Dasselbe Verhältnis haben
  Menschen heute schon: eingerückt unter dem Sprachkanal UND in dieser Liste.

  Ausserhalb der virtuellen Liste, weil es wenige sind und weil sie damit
  garantiert nicht zwischen die Menschen rutschen können.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { geraetPfad, punktKlasse, zustandsText } from '$lib/devices/darstellung';
  import type { Device } from '$lib/api/devices';
  import { gegenstelle } from '$lib/remote/gegenstelle';
  import { userCache } from '$lib/stores/users.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { guildId, onClose }: { guildId: string; onClose?: () => void } = $props();

  const geraete = $derived(deviceStore.forGuild(guildId));

  $effect(() => {
    void deviceStore.ensureLoaded(guildId);
  });

  // Namen der Steuernden nachladen — sonst stünde hier „belegt" ohne die eine
  // Auskunft, die im Zweifel zählt: von wem.
  $effect(() => {
    for (const d of geraete) if (d.busy_with) userCache.queue(d.busy_with);
  });

  function oeffnen(d: Device): void {
    void goto(geraetPfad(d));
    onClose?.();
  }
</script>

{#if geraete.length > 0}
  <div class="px-2.5 pb-2" data-testid="device-member-section">
    <div class="text-text-muted px-3 pb-1 text-xs font-semibold uppercase tracking-wide">
      {m.device_category_title()}
    </div>
    {#each geraete as d (d.id)}
      <button
        class="hover:bg-bg-hover flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left"
        onclick={() => oeffnen(d)}
        data-testid={`device-member-${d.id}`}
      >
        <!-- Eckig statt rund: derselbe Unterschied wie in der Kanalliste, und
             er muss vor dem Lesen wirken. -->
        <span
          class="text-text-muted grid size-7 shrink-0 place-items-center rounded-md border border-current/40"
        >
          <MonitorIcon class="size-3.5" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="text-text-base block truncate font-mono text-sm">{d.name}</span>
          <span class="text-text-muted block truncate text-xs">{zustandsText(d.state, d.busy_with ? gegenstelle(d.busy_with).anzeige : null)}</span>
        </span>
        <span class="size-2 shrink-0 rounded-full {punktKlasse(d.state)}" aria-hidden="true"></span>
      </button>
    {/each}
  </div>
{/if}
