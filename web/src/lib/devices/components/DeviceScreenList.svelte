<!--
  DeviceScreenList — die Bildschirmliste eines Geräts, in zwei Auftritten.

  Ausgelagert aus `DeviceView.svelte` allein wegen der Grössen-Regel (die
  Verwaltung brauchte darin Platz); Verhalten und `data-testid`s sind wortgleich
  zu vorher übernommen.

  `modus="watch"`: nur die LAUFENDEN Schirme, Klick öffnet Zusehen
  (`device-view-watch`/`device-view-watch-{index}`).
  `modus="manage"`: ALLE Schirme, laufende führen zur Kachel, ruhende werden
  erst beim Klick angefordert (`device-view-screens`/`device-view-screen-{index}`).
-->
<script lang="ts">
  import PlusIcon from '@lucide/svelte/icons/plus';
  import EyeIcon from '@lucide/svelte/icons/eye';
  import { Button } from '$lib/components/ui/button/index.js';
  import type { Device } from '$lib/api/devices';
  import { schirmWarten, zusehen, type SchirmStand } from '$lib/devices/schirme.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    device,
    schirme,
    modus,
  }: {
    device: Device;
    schirme: SchirmStand[];
    modus: 'watch' | 'manage';
  } = $props();

  const liste = $derived(modus === 'watch' ? schirme.filter((s) => s.open) : schirme);
</script>

<div
  class="flex flex-col items-center gap-2"
  data-testid={modus === 'watch' ? 'device-view-watch' : 'device-view-screens'}
>
  <span class="text-text-muted text-xs">{m.device_view_screens()}</span>
  <div class="flex flex-wrap justify-center gap-2">
    {#each liste as mon (mon.index)}
      {#if modus === 'watch'}
        <Button
          size="sm"
          variant="outline"
          onclick={() => zusehen(device, mon)}
          data-testid={`device-view-watch-${mon.index}`}
        >
          <EyeIcon class="size-4" />
          {mon.name}
        </Button>
      {:else}
        <Button
          size="sm"
          variant={mon.open ? 'default' : 'outline'}
          onclick={() => schirmWarten.holen(device, mon)}
          disabled={schirmWarten.wartetAufSchirm(device.id, mon.index)}
          data-testid={`device-view-screen-${mon.index}`}
        >
          {#if !mon.open}
            <PlusIcon class="size-4" />
          {/if}
          {mon.name}
        </Button>
      {/if}
    {/each}
  </div>
  {#if modus === 'manage'}
    <span class="text-text-muted max-w-sm text-center text-xs">
      {m.device_view_screens_hint()}
    </span>
  {/if}
</div>
