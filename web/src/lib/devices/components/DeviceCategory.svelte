<!--
  DeviceCategory — die Geräte einer Community in der Kanalliste.

  **Eine eigene Kategorie, gleichrangig neben Text- und Sprachkanälen** — kein
  Anhängsel eines Kanals (Entwurf §5). Ein Gerät steht zwar IN einem
  Sprachkanal, aber es ist keiner: es hat keine Teilnehmer, keinen Verlauf und
  keine Sprecherliste.

  **Rund heisst Mensch, eckig heisst Maschine.** Menschen behalten den runden
  Avatar und ihre Namensfarbe; Geräte bekommen eine eckige Kachel, einen
  Monospace-Namen und einen entsättigten Stahlton. Der Unterschied muss vor dem
  Lesen wirken — ein Ding, das aussieht wie eine Person und nicht antwortet,
  ist genau die Verwirrung, die das Modell vermeiden soll.

  **Links steht „wohin kann ich".** Deshalb kompakt und mit einem einzigen
  Zustandspunkt; der ausgeschriebene Zustand samt Nutzer steht rechts in der
  Mitgliederliste und in der Geräteansicht. Dasselbe Verhältnis haben Menschen
  heute schon (eingerückt unter dem Sprachkanal UND in der Mitgliederliste).

  Gefiltert wird nicht hier: der Server schickt nur Geräte, deren Standplatz
  man sehen darf (`routes/devices.py`, und derselbe Riegel im Ereignisweg).
-->
<script lang="ts">
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import { deviceStore } from '$lib/devices/store.svelte';
  import type { Device } from '$lib/api/devices';
  import { m } from '$lib/paraglide/messages.js';

  let {
    guildId,
    activeDeviceId = null,
    onSelect,
  }: {
    guildId: string;
    activeDeviceId?: string | null;
    onSelect: (device: Device) => void;
  } = $props();

  // Beim Betreten der Community einmal laden; die Änderungen danach kommen als
  // `device_changed`/`device_state` über die WebSocket.
  $effect(() => {
    void deviceStore.ensureLoaded(guildId);
  });

  const geraete = $derived(deviceStore.forGuild(guildId));

  /** Farbe des Zustandspunkts. Bereit ist das einzige Grün — belegt ist kein
   *  Fehler, aber auch keine Einladung, und offline ist schlicht still. */
  function punkt(state: Device['state']): string {
    if (state === 'ready') return 'bg-emerald-500';
    if (state === 'busy') return 'bg-amber-500';
    return 'bg-text-muted/40';
  }

  function titel(d: Device): string {
    if (d.state === 'ready') return m.device_state_ready();
    if (d.state === 'busy') return m.device_state_busy();
    return m.device_state_offline();
  }
</script>

{#if geraete.length > 0}
  <div class="my-3 hairline bg-border" aria-hidden="true"></div>
  <div class="text-text-muted px-2.5 pb-1 text-sm font-bold md:text-xs">
    {m.device_category_title()}
  </div>
  {#each geraete as d (d.id)}
    <button
      class="group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left
        hover:bg-bg-hover data-[active=true]:bg-bg-hover"
      data-active={activeDeviceId === d.id}
      onclick={() => onSelect(d)}
      data-testid={`device-${d.id}`}
      title={titel(d)}
    >
      <!-- Eckig, nicht rund: das ist der Unterschied, der vor dem Lesen wirkt. -->
      <span class="text-text-muted grid size-[18px] shrink-0 place-items-center rounded-[4px]
        border border-current/40">
        <MonitorIcon class="size-3" />
      </span>
      <span class="text-text-base truncate font-mono text-sm md:text-xs">{d.name}</span>
      <span class="ml-auto size-2 shrink-0 rounded-full {punkt(d.state)}" aria-hidden="true"></span>
    </button>
  {/each}
{/if}
