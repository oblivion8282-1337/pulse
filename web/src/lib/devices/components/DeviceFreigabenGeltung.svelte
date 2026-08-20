<!--
  DeviceFreigabenGeltung — Geltungsauswahl für eine NEUE Zeile in
  `DeviceFreigaben` (befristet mit Spanne, oder dauerhaft). Ausgelagert, damit
  die Elternkomponente unter der 250-Zeilen-Grenze bleibt; reine
  Formularsteuerung ohne eigenen Netzzugriff.
-->
<script lang="ts">
  import { Input } from '$lib/components/ui/input/index.js';
  import Select from '$lib/components/form/Select.svelte';
  import type { Einheit, Geltung } from '$lib/remote/standplatz.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    geltung = $bindable(),
    menge = $bindable(),
    einheit = $bindable(),
  }: { geltung: Geltung; menge: number; einheit: Einheit } = $props();

  const geltungen: { id: Geltung; label: () => string }[] = [
    { id: 'befristet', label: m.standplatz_settings_duration_limited },
    { id: 'dauerhaft', label: m.standplatz_settings_duration_permanent },
  ];
  const einheiten: { id: Einheit; label: () => string }[] = [
    { id: 'stunden', label: m.standplatz_settings_unit_hours },
    { id: 'tage', label: m.standplatz_settings_unit_days },
    { id: 'wochen', label: m.standplatz_settings_unit_weeks },
  ];

  const einheitenOptionen = $derived(einheiten.map((e) => ({ value: e.id, label: e.label() })));
</script>

<div class="flex flex-wrap items-center gap-2">
  {#each geltungen as g (g.id)}
    <label class="text-text-muted flex items-center gap-1 text-xs">
      <input type="radio" name="freigabe-geltung" value={g.id} bind:group={geltung} />
      {g.label()}
    </label>
  {/each}
  {#if geltung === 'befristet'}
    <Input type="number" min="1" class="h-7 w-16 text-xs" bind:value={menge} />
    <!-- h-7/text-xs wie das Zahlenfeld daneben — die beiden bilden ein Paar. -->
    <Select
      class="h-7 px-2 text-xs md:text-xs"
      value={einheit}
      options={einheitenOptionen}
      onchange={(v) => (einheit = v as Einheit)}
    />
  {/if}
</div>
